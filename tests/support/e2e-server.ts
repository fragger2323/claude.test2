/**
 * Self-contained test server for E2E / manual UI review:
 * fixture websites + mock provider APIs + fresh SQLite DB + API (with in-process worker) + built SPA.
 * Usage: npx tsx tests/support/e2e-server.ts   (PORT defaults to 4411)
 */
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { startFixtureSites } from './fixture-sites.js';
import { mockProviderEnv, startMockProviders } from './mock-providers.js';

const port = Number(process.env.E2E_PORT ?? 4411);
const dir = `tests/.tmp/e2e-${port}`;
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const sites = await startFixtureSites();
const mock = await startMockProviders(sites.urls);
Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: `file:../${dir}/e2e.db`,
  DATA_DIR: `${dir}/data`,
  PORT: String(port),
  HOST: '127.0.0.1',
  ALLOW_PRIVATE_NETWORK_TARGETS: 'true',
  APP_ENCRYPTION_KEY: '0'.repeat(64),
  RUN_WORKER_IN_PROCESS: 'true',
  WORKER_POLL_MS: '300',
  SCHEDULER_ENABLED: 'false',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  ...mockProviderEnv(mock.url),
});
execSync('npx prisma db push --skip-generate --accept-data-loss', { stdio: 'ignore', env: process.env });
const { buildApp } = await import('../../src/server/app.js');
const { Worker } = await import('../../src/jobs/worker.js');
const { ensureDefaults } = await import('../../src/engine/defaults.js');
const { syncSourceRows } = await import('../../src/providers/registry.js');
const { tuneDatabase } = await import('../../src/db/client.js');
await tuneDatabase();
await ensureDefaults();
await syncSourceRows();
const app = await buildApp();
const worker = new Worker(2, 300);
await worker.start();
await app.listen({ host: '127.0.0.1', port });
console.log(`E2E server ready on http://127.0.0.1:${port} (mock providers ${mock.url})`);
const stop = async () => {
  await app.close();
  await worker.stop();
  await mock.close();
  await sites.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
