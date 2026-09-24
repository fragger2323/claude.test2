import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | null = null;

/** Shared Prisma client (one per process). */
export function db(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({ log: [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }] });
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
