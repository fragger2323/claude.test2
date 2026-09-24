import { db } from '../db/client.js';
import { sha256, stableStringify } from './misc.js';
import type { Prisma } from '@prisma/client';

/**
 * DB-backed response cache (provider responses, AI results). Survives restarts and is
 * shared by API and worker. TTLs are chosen per provider to respect terms of service.
 */
export function cacheKey(namespace: string, parts: unknown): string {
  return `${namespace}:${sha256(stableStringify(parts))}`;
}

export async function cacheGet<T>(namespace: string, parts: unknown): Promise<T | undefined> {
  const key = cacheKey(namespace, parts);
  const row = await db().cacheEntry.findUnique({ where: { key } });
  if (!row) return undefined;
  if (row.expiresAt.getTime() < Date.now()) {
    await db().cacheEntry.delete({ where: { key } }).catch(() => undefined);
    return undefined;
  }
  return row.value as T;
}

export async function cacheSet(namespace: string, parts: unknown, value: unknown, ttlHours: number): Promise<void> {
  if (ttlHours <= 0) return;
  const key = cacheKey(namespace, parts);
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  const json = value as Prisma.InputJsonValue;
  await db().cacheEntry.upsert({
    where: { key },
    create: { key, namespace, value: json, expiresAt },
    update: { value: json, expiresAt, createdAt: new Date() },
  });
}

export async function purgeExpiredCache(): Promise<number> {
  const res = await db().cacheEntry.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return res.count;
}
