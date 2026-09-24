import { lookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * SSRF protection for fetching untrusted URLs (company websites come from third-party data).
 * Blocks loopback, private, link-local, CGNAT, multicast, reserved and cloud-metadata ranges.
 */
const blockList = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockList.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['64:ff9b::', 96],
] as const) {
  blockList.addSubnet(addr, prefix, 'ipv6');
}

export class SsrfError extends Error {
  override name = 'SsrfError';
}

export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return blockList.check(ip, 'ipv4');
  if (family === 6) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blockList.check(mapped[1]!, 'ipv4');
    return blockList.check(ip, 'ipv6');
  }
  return true;
}

const cache = new Map<string, { ok: boolean; at: number; reason?: string }>();
const CACHE_MS = 60_000;

export async function assertPublicUrl(rawUrl: string, allowPrivate: boolean): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfError(`invalid URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError(`blocked protocol ${u.protocol}`);
  if (u.username || u.password) throw new SsrfError('credentials in URL are not allowed');
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port) && !allowPrivate) throw new SsrfError(`blocked port ${u.port}`);
  if (allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new SsrfError(`blocked host ${host}`);
  }
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError(`blocked address ${host}`);
    return;
  }
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    if (!hit.ok) throw new SsrfError(hit.reason ?? `blocked host ${host}`);
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch (e) {
    // DNS failure is not an SSRF issue — let the caller's request fail naturally.
    const err = new Error(`DNS lookup failed for ${host}: ${(e as Error).message}`);
    err.name = 'DnsError';
    throw err;
  }
  const bad = addrs.find((a) => isBlockedIp(a.address));
  if (bad) {
    const reason = `host ${host} resolves to a non-public address`;
    cache.set(host, { ok: false, at: Date.now(), reason });
    throw new SsrfError(reason);
  }
  cache.set(host, { ok: true, at: Date.now() });
}

/** dns.lookup-compatible function that rejects private targets at connect time (anti DNS-rebinding). */
export function guardedLookup(allowPrivate: boolean) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number } | number,
    callback: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
  ): void => {
    const opts = typeof options === 'number' ? { family: options } : options ?? {};
    lookup(hostname, { all: true, verbatim: true, family: (opts.family as 0 | 4 | 6 | undefined) ?? 0 })
      .then((addrs) => {
        const usable = allowPrivate ? addrs : addrs.filter((a) => !isBlockedIp(a.address));
        if (usable.length === 0) {
          const err = new SsrfError(`host ${hostname} resolves to a non-public address`) as NodeJS.ErrnoException;
          err.code = 'ESSRF';
          callback(err, '', 0);
          return;
        }
        if (opts.all) callback(null, usable);
        else callback(null, usable[0]!.address, usable[0]!.family);
      })
      .catch((e: NodeJS.ErrnoException) => callback(e, '', 0));
  };
}
