import { db } from '../db/client.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { decodeKey, loadConfig, SECRET_ENV_NAMES, type SecretName } from './env.js';

/**
 * Secret resolution: environment variables win; otherwise keys saved from the UI are
 * decrypted from the DB (AES-256-GCM with APP_ENCRYPTION_KEY). Plaintext never leaves the server.
 */
let memo: { at: number; values: Map<string, string> } | null = null;
const MEMO_MS = 30_000;

function encryptionKey(): Buffer | null {
  const k = loadConfig().APP_ENCRYPTION_KEY;
  return k ? decodeKey(k) : null;
}

async function dbSecrets(): Promise<Map<string, string>> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.values;
  const key = encryptionKey();
  const values = new Map<string, string>();
  if (key) {
    const rows = await db().secretSetting.findMany();
    for (const r of rows) {
      try {
        values.set(r.name, decryptSecret(r.ciphertext, key));
      } catch {
        // wrong key / corrupted — treated as missing
      }
    }
  }
  memo = { at: Date.now(), values };
  return values;
}

export async function getSecret(name: SecretName): Promise<string | undefined> {
  const env = loadConfig()[name];
  if (env) return env;
  return (await dbSecrets()).get(name);
}

export async function resolveSecrets(): Promise<Partial<Record<SecretName, string>>> {
  const out: Partial<Record<SecretName, string>> = {};
  for (const n of SECRET_ENV_NAMES) {
    const v = await getSecret(n);
    if (v) out[n] = v;
  }
  return out;
}

export async function setSecret(name: SecretName, value: string | null): Promise<void> {
  if (value == null || value.trim() === '') {
    await db().secretSetting.delete({ where: { name } }).catch(() => undefined);
    memo = null;
    return;
  }
  const key = encryptionKey();
  if (!key) throw new Error('APP_ENCRYPTION_KEY is not configured; set the key in the environment instead.');
  const trimmed = value.trim();
  if (trimmed.length > 500 || /\s/.test(trimmed)) throw new Error('invalid key format');
  await db().secretSetting.upsert({
    where: { name },
    create: { name, ciphertext: encryptSecret(trimmed, key), last4: trimmed.slice(-4) },
    update: { ciphertext: encryptSecret(trimmed, key), last4: trimmed.slice(-4) },
  });
  memo = null;
}

export interface SecretStatus {
  name: SecretName;
  configured: boolean;
  source: 'env' | 'ui' | null;
  last4: string | null;
}

export async function secretStatuses(): Promise<SecretStatus[]> {
  const rows = await db().secretSetting.findMany();
  const byName = new Map(rows.map((r) => [r.name, r]));
  const cfg = loadConfig();
  return SECRET_ENV_NAMES.map((name) => {
    if (cfg[name]) return { name, configured: true, source: 'env' as const, last4: cfg[name]!.slice(-4) };
    const r = byName.get(name);
    return { name, configured: !!r, source: r ? ('ui' as const) : null, last4: r?.last4 ?? null };
  });
}

export function invalidateSecretCache(): void {
  memo = null;
}
