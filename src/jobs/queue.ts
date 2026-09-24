import type { Prisma } from '@prisma/client';
import { hostname } from 'node:os';
import { db } from '../db/client.js';
import { backoffDelay } from '../lib/retry.js';

/**
 * DB-backed job queue with leases. Works identically on SQLite and PostgreSQL:
 * claiming uses a conditional UPDATE (status = 'queued') so two workers never run the same job.
 * Stale leases (crashed worker) are re-queued. Retries use exponential backoff.
 */
export type JobType = 'search' | 'import' | 'analyze_lead' | 'qualify_all' | 'scheduled_search' | 'maintenance';

export const WORKER_ID = `${hostname()}:${process.pid}`;
const LEASE_MS = 60_000;

export async function enqueueJob(type: JobType, payload: Record<string, unknown>, opts: { searchJobId?: string; priority?: number; maxAttempts?: number; runAfter?: Date } = {}) {
  return db().job.create({
    data: {
      type,
      payload: payload as Prisma.InputJsonValue,
      searchJobId: opts.searchJobId,
      priority: opts.priority ?? 0,
      maxAttempts: opts.maxAttempts ?? 3,
      runAfter: opts.runAfter ?? new Date(),
    },
  });
}

export async function claimNextJob(types?: JobType[]) {
  const now = new Date();
  for (let i = 0; i < 5; i++) {
    const candidate = await db().job.findFirst({
      where: { status: 'queued', runAfter: { lte: now }, ...(types ? { type: { in: types } } : {}) },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    if (!candidate) return null;
    const res = await db().job.updateMany({
      where: { id: candidate.id, status: 'queued' },
      data: { status: 'running', lockedBy: WORKER_ID, lockedUntil: new Date(Date.now() + LEASE_MS), attempts: { increment: 1 }, startedAt: now },
    });
    if (res.count === 1) return db().job.findUnique({ where: { id: candidate.id } });
  }
  return null;
}

export async function heartbeat(jobId: string): Promise<void> {
  await db().job.updateMany({ where: { id: jobId, lockedBy: WORKER_ID }, data: { lockedUntil: new Date(Date.now() + LEASE_MS) } });
}

export async function completeJob(jobId: string, result?: Record<string, unknown>): Promise<void> {
  await db().job.update({ where: { id: jobId }, data: { status: 'completed', finishedAt: new Date(), lockedBy: null, lockedUntil: null, result: (result ?? {}) as Prisma.InputJsonValue } });
}

export async function failJob(jobId: string, error: string, retryable = true): Promise<'retrying' | 'failed'> {
  const job = await db().job.findUnique({ where: { id: jobId } });
  if (!job) return 'failed';
  if (retryable && job.attempts < job.maxAttempts) {
    await db().job.update({
      where: { id: jobId },
      data: { status: 'queued', lastError: error.slice(0, 2000), lockedBy: null, lockedUntil: null, runAfter: new Date(Date.now() + backoffDelay(job.attempts, 5_000, 120_000)) },
    });
    return 'retrying';
  }
  await db().job.update({ where: { id: jobId }, data: { status: 'failed', lastError: error.slice(0, 2000), finishedAt: new Date(), lockedBy: null, lockedUntil: null } });
  return 'failed';
}

/** Job ended because the user paused/cancelled — not an error, not retried automatically. */
export async function parkJob(jobId: string, status: 'paused' | 'cancelled'): Promise<void> {
  await db().job.update({ where: { id: jobId }, data: { status, finishedAt: new Date(), lockedBy: null, lockedUntil: null } });
}

export async function requeueStaleJobs(): Promise<number> {
  const res = await db().job.updateMany({
    where: { status: 'running', lockedUntil: { lt: new Date() } },
    data: { status: 'queued', lockedBy: null, lockedUntil: null, lastError: 'lease expired (worker stopped?) — re-queued' },
  });
  return res.count;
}
