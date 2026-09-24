import { describe, expect, it } from 'vitest';
import { constantTimeEqual, decryptSecret, encryptSecret, hashPassword, randomToken, tokenHash, verifyPassword } from '../../src/lib/crypto.js';
import { assertPublicUrl, isBlockedIp, SsrfError } from '../../src/lib/ssrf.js';
import { parseConfig } from '../../src/config/env.js';

describe('crypto', () => {
  const key = Buffer.alloc(32, 7);
  it('AES-GCM round trip; tampering and wrong keys fail', () => {
    const enc = encryptSecret('sk-live-123', key);
    expect(enc).not.toContain('sk-live-123');
    expect(decryptSecret(enc, key)).toBe('sk-live-123');
    expect(() => decryptSecret(enc, Buffer.alloc(32, 8))).toThrow();
    const tampered = enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => decryptSecret(tampered, key)).toThrow();
    expect(encryptSecret('x', key)).not.toBe(encryptSecret('x', key));
  });

  it('password hashing', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).not.toContain('correct');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('tokens', () => {
    const t = randomToken();
    expect(t.length).toBeGreaterThanOrEqual(40);
    expect(tokenHash(t)).not.toBe(t);
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('ssrf guard', () => {
  it('blocks private, loopback, link-local, metadata and mapped addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', 'not-an-ip']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isBlockedIp(ip), ip).toBe(false);
  });

  it('rejects private targets and non-http schemes unless explicitly allowed (tests only)', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:8080/', false)).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data', false)).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('file:///etc/passwd', false)).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('http://localhost/', false)).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('http://127.0.0.1:8080/', true)).resolves.toBeUndefined();
  });
});

describe('env validation', () => {
  it('ignores placeholder secrets and applies defaults', () => {
    const { config, warnings } = parseConfig({ NODE_ENV: 'development', GOOGLE_PLACES_API_KEY: 'your-google-key-here' });
    expect(config.GOOGLE_PLACES_API_KEY).toBeUndefined();
    expect(warnings.map((w) => w.key)).toContain('GOOGLE_PLACES_API_KEY');
  });

  it('production requires an encryption key and forbids private network targets', () => {
    expect(() => parseConfig({ NODE_ENV: 'production' })).toThrow(/APP_ENCRYPTION_KEY/);
    expect(() => parseConfig({ NODE_ENV: 'production', APP_ENCRYPTION_KEY: 'a'.repeat(64), ALLOW_PRIVATE_NETWORK_TARGETS: 'true' })).toThrow(/ALLOW_PRIVATE_NETWORK_TARGETS/);
    expect(() => parseConfig({ NODE_ENV: 'production', APP_ENCRYPTION_KEY: 'a'.repeat(64), SETUP_TOKEN: 'x'.repeat(24) })).not.toThrow();
  });
});
