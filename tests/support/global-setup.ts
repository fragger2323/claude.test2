import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

/**
 * Fresh database for the whole Vitest run.
 *  - default: SQLite file, schema pushed from prisma/schema.prisma
 *  - TEST_DATABASE_URL=postgresql://…: the PostgreSQL migrations are applied with `migrate deploy`
 *    (non-destructive) to a dedicated, empty test database; tests then delete rows between cases.
 *    As a guard, the database name must contain "test".
 */
export default function setup(): void {
  rmSync('tests/.tmp/vitest-data', { recursive: true, force: true });
  mkdirSync('tests/.tmp', { recursive: true });
  const pg = process.env.TEST_DATABASE_URL;
  if (pg?.startsWith('postgres')) {
    const name = new URL(pg).pathname.replace(/^\//, '');
    if (!/test/i.test(name)) throw new Error(`Refusing to run tests against database "${name}": its name must contain "test" (tests delete all rows).`);
    execSync('npx prisma migrate deploy --schema prisma/postgres/schema.prisma', { stdio: 'inherit', env: { ...process.env, DATABASE_URL: pg } });
    return;
  }
  rmSync('tests/.tmp/vitest.db', { force: true });
  rmSync('tests/.tmp/vitest.db-journal', { force: true });
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: 'file:../tests/.tmp/vitest.db' },
  });
}
