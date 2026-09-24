import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

/** Fresh SQLite database for the whole Vitest run (schema pushed from prisma/schema.prisma). */
export default function setup(): void {
  rmSync('tests/.tmp/vitest.db', { force: true });
  rmSync('tests/.tmp/vitest.db-journal', { force: true });
  rmSync('tests/.tmp/vitest-data', { recursive: true, force: true });
  mkdirSync('tests/.tmp', { recursive: true });
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: 'file:../tests/.tmp/vitest.db' },
  });
}
