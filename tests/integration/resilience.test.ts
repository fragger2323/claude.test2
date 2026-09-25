import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { callProviderJson } from '../../src/providers/base.js';
import { circuitStatus, resetHealthState } from '../../src/providers/health.js';
import { CallBudget } from '../../src/providers/types.js';
import { cacheGet, cacheSet } from '../../src/lib/cache.js';
import { db } from '../../src/db/client.js';
import { Worker } from '../../src/jobs/worker.js';
import { buildApp } from '../../src/server/app.js';
import { resetDb } from '../support/db.js';
import { seedLead } from '../support/seed.js';

const log = pino({ level: 'silent' });
let server: http.Server;
let base = '';
let hits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits++;
    if (req.url?.startsWith('/down')) return void res.writeHead(503, { 'retry-after': '0' }).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ n: hits }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(async () => {
  await resetDb();
  resetHealthState();
});

const ctx = () => ({ budget: new CallBudget(100), log });

describe('provider resilience', () => {
  it('retried attempts of one request do not trip the circuit breaker; repeated failed requests do', async () => {
    for (let i = 0; i < 2; i++) await expect(callProviderJson('flaky', 1000, `${base}/down`, { retries: 2 }, ctx())).rejects.toThrow();
    expect(circuitStatus('flaky').open).toBe(false); // 6 failed attempts, but only 2 failed requests
    for (let i = 0; i < 3; i++) await expect(callProviderJson('flaky', 1000, `${base}/down`, { retries: 0 }, ctx())).rejects.toThrow();
    expect(circuitStatus('flaky').open).toBe(true);
    // every attempt is still counted as a billable call
    const usage = await db().providerUsage.findFirst({ where: { provider: 'flaky' } });
    expect(usage!.calls).toBe(9);
  }, 30_000);

  it('cache serves repeated requests until the entry expires', async () => {
    const opts = { cache: { namespace: 'test:ok', parts: { q: 1 }, ttlHours: 1 } };
    const a = await callProviderJson<{ n: number }>('cached', 1000, `${base}/ok`, opts, ctx());
    const b = await callProviderJson<{ n: number }>('cached', 1000, `${base}/ok`, opts, ctx());
    expect(b.n).toBe(a.n);
    await db().cacheEntry.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await cacheGet('test:ok', { q: 1 })).toBeUndefined();
    const c = await callProviderJson<{ n: number }>('cached', 1000, `${base}/ok`, opts, ctx());
    expect(c.n).not.toBe(a.n);
    await cacheSet('test:zero', {}, { x: 1 }, 0);
    expect(await cacheGet('test:zero', {})).toBeUndefined();
  });
});

describe('background worker visibility', () => {
  it('health reports live workers so the UI can say "no worker is running"', async () => {
    const app = await buildApp({ webDir: null });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json().workers).toBe(0);
      const w = new Worker(1, 200);
      await w.start();
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json().workers).toBe(1);
      await w.stop();
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json().workers).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe('manually added website', () => {
  it('validates the address, rejects profile pages and queues a live analysis', async () => {
    const app = await buildApp({ webDir: null });
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { 'x-aios-csrf': '1' }, payload: { email: 'w@studio.test', password: 'long enough password' } });
      const cookie = String(setup.headers['set-cookie']).split(';')[0]!;
      const { lead, company } = await seedLead({ name: 'Manual Site Dental' });
      const patch = (website: string) => app.inject({ method: 'PATCH', url: `/api/leads/${lead.id}`, headers: { 'x-aios-csrf': '1', cookie }, payload: { website } });
      expect((await patch('not a url at all')).statusCode).toBe(400);
      const fb = await patch('https://www.facebook.com/manualsite');
      expect(fb.statusCode).toBe(400);
      expect(fb.json().message).toMatch(/social/);
      expect((await patch('www.manual-site-dental.pl/kontakt')).statusCode).toBe(200);
      const w = await db().website.findUnique({ where: { companyId: company.id } });
      expect(w).toMatchObject({ url: 'https://www.manual-site-dental.pl', status: 'found', discoverySource: 'manual', domain: 'manual-site-dental.pl' });
      expect(await db().job.count({ where: { type: 'analyze_lead' } })).toBe(1);
    } finally {
      await app.close();
    }
  });
});
