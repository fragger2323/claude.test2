#!/usr/bin/env node
// Runs API (with in-process worker) + Vite dev server together.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npx', ['tsx', 'watch', '--clear-screen=false', 'src/server/index.ts'], { stdio: 'inherit', env: { ...process.env, RUN_WORKER_IN_PROCESS: process.env.RUN_WORKER_IN_PROCESS ?? 'true', LOG_PRETTY: process.env.LOG_PRETTY ?? 'true' } }),
  spawn('npx', ['vite'], { stdio: 'inherit' }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code) { stop(); process.exit(code); } });
