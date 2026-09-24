#!/usr/bin/env node
// Runs the Vitest suite against PostgreSQL:
//   TEST_DATABASE_URL=postgresql://user:pw@localhost:5432/aios_test npm run test:pg
// Use a dedicated, disposable database whose name contains "test": migrations are applied with
// `prisma migrate deploy` and the tests delete all rows between cases. Generates the PostgreSQL
// Prisma client first and always restores the SQLite client afterwards.
import { spawnSync } from 'node:child_process';

const url = process.env.TEST_DATABASE_URL;
if (!url?.startsWith('postgres')) {
  console.error('Set TEST_DATABASE_URL to a disposable PostgreSQL test database (all rows are deleted).');
  process.exit(2);
}
const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit', env: process.env }).status ?? 1;
let status = run('npx', ['prisma', 'generate', '--schema', 'prisma/postgres/schema.prisma']);
if (status === 0) status = run('npx', ['vitest', 'run', ...process.argv.slice(2)]);
const restore = run('npx', ['prisma', 'generate']);
process.exit(status || restore);
