import { configWarnings, loadConfig } from '../config/env.js';
import { disconnectDb, tuneDatabase } from '../db/client.js';
import { ensureDefaults } from '../engine/defaults.js';
import { Worker } from '../jobs/worker.js';
import { logger } from '../lib/logger.js';
import { errorMessage } from '../lib/misc.js';
import { syncSourceRows } from '../providers/registry.js';
import { closeBrowserPool } from '../providers/website/browser-pool.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = logger('server');
  for (const w of configWarnings()) log.warn({ key: w.key }, w.message);
  await tuneDatabase();
  await ensureDefaults();
  await syncSourceRows();
  const app = await buildApp();
  let worker: Worker | null = null;
  if (cfg.RUN_WORKER_IN_PROCESS) {
    worker = new Worker();
    await worker.start();
  }
  await app.listen({ host: cfg.HOST, port: cfg.PORT });
  log.info({ host: cfg.HOST, port: cfg.PORT, inProcessWorker: !!worker }, 'Agency Intelligence OS API listening');
  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down');
    await app.close();
    if (worker) await worker.stop();
    await closeBrowserPool();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  logger('server').fatal({ error: errorMessage(e) }, 'server failed to start');
  process.exit(1);
});
