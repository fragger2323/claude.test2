import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | null = null;

/** Shared Prisma client (one per process). */
/**
 * SQLite (local dev) allows one writer at a time; a single pooled connection per process plus
 * PRAGMA busy_timeout (see tuneDatabase) makes API + worker processes wait instead of failing.
 * PostgreSQL URLs are used unchanged.
 */
export function databaseUrl(raw = process.env.DATABASE_URL ?? ''): string {
  if (!raw.startsWith('file:') || /connection_limit=/.test(raw)) return raw;
  return `${raw}${raw.includes('?') ? '&' : '?'}connection_limit=1`;
}

export function db(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({ datasourceUrl: databaseUrl() || undefined, log: [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }] });
  }
  return prisma;
}

export async function disconnectDb(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

/** SQLite tuning for concurrent API + worker access (no-op on PostgreSQL). */
export async function tuneDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.startsWith('file:')) return;
  const client = db();
  await client.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  await client.$queryRawUnsafe('PRAGMA busy_timeout = 10000;');
  await client.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');
}

export type Db = PrismaClient;
