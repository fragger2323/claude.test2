/**
 * Maintenance CLI: `node dist/server/cli.js <command>` (or `npx tsx src/cli.ts <command>`).
 *   maintenance        – run retention purge + cache cleanup now
 *   train [reply|won]  – train the outcome model from recorded outcomes
 *   requalify          – re-score all leads
 */
import { disconnectDb } from './db/client.js';
import { ensureDefaults } from './engine/defaults.js';
import { trainOutcomeModel } from './engine/learning/trainer.js';
import { runMaintenance } from './jobs/handlers.js';
import { enqueueJob } from './jobs/queue.js';
import { logger } from './lib/logger.js';

const [cmd, arg] = process.argv.slice(2);
const log = logger('cli');
await ensureDefaults();
switch (cmd) {
  case 'maintenance':
    console.log(await runMaintenance({ log }));
    break;
  case 'train':
    console.log(await trainOutcomeModel(arg === 'won' ? 'won' : 'reply'));
    break;
  case 'requalify':
    console.log(await enqueueJob('qualify_all', {}));
    break;
  default:
    console.log('usage: cli <maintenance | train [reply|won] | requalify>');
}
await disconnectDb();
