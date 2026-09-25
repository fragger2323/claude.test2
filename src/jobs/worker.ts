import { loadConfig, configWarnings } from '../config/env.js';
import { db, disconnectDb, tuneDatabase } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { errorMessage } from '../lib/misc.js';
import { sleep } from '../lib/concurrency.js';
import { closeBrowserPool } from '../providers/website/browser-pool.js';
import { ensureDefaults } from '../engine/defaults.js';
import { syncSourceRows } from '../providers/registry.js';
import { claimNextJob, completeJob, failJob, heartbeat, parkJob, requeueStaleJobs, WORKER_ID, type JobType } from './queue.js';
import { runHandler } from './handlers.js';
import { schedulerTick } from './scheduler.js';

/**
 * Worker process: claims jobs from the DB queue with bounded concurrency, heartbeats leases,
 * retries failures with backoff, runs the scheduler, and shuts down gracefully.
 */
export const WORKER_HEARTBEAT_MS = 15_000;

/** Workers seen within this window count as alive. */
export async function liveWorkers(): Promise<number> {
  const since = new Date(Date.now() - WORKER_HEARTBEAT_MS * 4);
  return db().setting.count({ where: { key: { startsWith: 'worker:' }, updatedAt: { gte: since } } });
}

export class Worker {
  private running = false;
  private active = 0;
  private readonly log = logger('worker');
  private stopRequested = false;
  private beatTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly concurrency = loadConfig().WORKER_CONCURRENCY,
    private readonly pollMs = loadConfig().WORKER_POLL_MS,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const cfg = loadConfig();
    this.log.info({ workerId: WORKER_ID, concurrency: this.concurrency }, 'worker started');
    const requeued = await requeueStaleJobs();
    if (requeued) this.log.warn({ requeued }, 'requeued stale jobs from a previous run');
    await this.beat();
    this.beatTimer = setInterval(() => void this.beat(), WORKER_HEARTBEAT_MS);
    void this.loop();
    if (cfg.SCHEDULER_ENABLED) void this.schedulerLoop();
  }

  /** Liveness record so the API/UI can tell "queued" from "no worker is running". */
  private async beat(): Promise<void> {
    const value = { at: new Date().toISOString(), active: this.active, concurrency: this.concurrency, pid: process.pid };
    await db()
      .setting.upsert({ where: { key: `worker:${WORKER_ID}` }, create: { key: `worker:${WORKER_ID}`, value }, update: { value } })
      .catch((e) => this.log.warn({ error: errorMessage(e) }, 'worker heartbeat failed'));
  }

  private async schedulerLoop(): Promise<void> {
    while (!this.stopRequested) {
      try {
        await schedulerTick(this.log);
        await requeueStaleJobs();
      } catch (e) {
        this.log.error({ error: errorMessage(e) }, 'scheduler tick failed');
      }
      await sleep(60_000).catch(() => undefined);
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopRequested) {
      if (this.active >= this.concurrency) {
        await sleep(this.pollMs);
        continue;
      }
      let job;
      try {
        job = await claimNextJob();
      } catch (e) {
        this.log.error({ error: errorMessage(e) }, 'failed to claim job');
        await sleep(this.pollMs * 3);
        continue;
      }
      if (!job) {
        await sleep(this.pollMs);
        continue;
      }
      this.active++;
      void this.execute(job.id, job.type as JobType, job.payload).finally(() => {
        this.active--;
      });
    }
    this.running = false;
  }

  private async execute(jobId: string, type: JobType, payload: unknown): Promise<void> {
    const log = this.log.child({ jobId, type });
    const started = Date.now();
    const hb = setInterval(() => void heartbeat(jobId).catch(() => undefined), 20_000);
    log.info('job started');
    try {
      const res = await runHandler(type, payload, { jobId, log, heartbeat: () => heartbeat(jobId) });
      if (res.status === 'completed') await completeJob(jobId, res.result);
      else await parkJob(jobId, res.status);
      log.info({ status: res.status, ms: Date.now() - started }, 'job finished');
    } catch (e) {
      const outcome = await failJob(jobId, errorMessage(e));
      log.error({ error: errorMessage(e), outcome, ms: Date.now() - started }, 'job failed');
      if (outcome === 'failed') {
        const j = await db().job.findUnique({ where: { id: jobId } });
        if (j?.searchJobId) await db().searchJob.update({ where: { id: j.searchJobId }, data: { status: 'failed', error: errorMessage(e).slice(0, 1000) } }).catch(() => undefined);
      } else {
        const j = await db().job.findUnique({ where: { id: jobId } });
        if (j?.searchJobId) await db().searchJob.update({ where: { id: j.searchJobId }, data: { status: 'queued', error: `retrying after error: ${errorMessage(e).slice(0, 500)}` } }).catch(() => undefined);
      }
    } finally {
      clearInterval(hb);
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    clearInterval(this.beatTimer);
    const deadline = Date.now() + 30_000;
    while (this.active > 0 && Date.now() < deadline) await sleep(200);
    await db().setting.delete({ where: { key: `worker:${WORKER_ID}` } }).catch(() => undefined);
    await closeBrowserPool();
  }

  get stats() {
    return { active: this.active, concurrency: this.concurrency, running: this.running };
  }
}

async function main(): Promise<void> {
  const log = logger('worker');
  for (const w of configWarnings()) log.warn({ key: w.key }, w.message);
  await tuneDatabase();
  await ensureDefaults();
  await syncSourceRows();
  const worker = new Worker();
  await worker.start();
  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down worker');
    await worker.stop();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const isEntry = process.argv[1] && /worker\.(ts|js)$/.test(process.argv[1]);
if (isEntry) {
  main().catch((e) => {
    logger('worker').fatal({ error: errorMessage(e) }, 'worker crashed');
    process.exit(1);
  });
}
