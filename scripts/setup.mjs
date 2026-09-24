#!/usr/bin/env node
// First-time local setup: creates .env with generated secrets, the data dir and the database.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

if (!existsSync('.env')) {
  let env = readFileSync('.env.example', 'utf8');
  env = env.replace(/^APP_ENCRYPTION_KEY=.*$/m, `APP_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`);
  writeFileSync('.env', env, { mode: 0o600 });
  console.log('Created .env with a generated APP_ENCRYPTION_KEY (keep it secret, back it up).');
} else {
  console.log('.env already exists — leaving it untouched.');
}
mkdirSync('data', { recursive: true });
execSync('npx prisma migrate deploy', { stdio: 'inherit' });
execSync('npx prisma generate', { stdio: 'inherit' });
console.log('\nDone. Start with:  npm run dev   → http://localhost:5173');
