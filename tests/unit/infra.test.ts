import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpRequest, HttpError } from '../../src/lib/http.js';
import { mapLimit, Semaphore } from '../../src/lib/concurrency.js';
import { TokenBucket } from '../../src/lib/rate-limiter.js';
import { backoffDelay, withRetry } from '../../src/lib/retry.js';
import { fanOut } from '../../src/engine/orchestrator/source-orchestrator.js';
import { ProviderUnavailableError } from '../../src/providers/base.js';
import { CallBudget, type BusinessQuery, type LeadSourceAdapter, type NormalizedBusiness, type SearchResultPage } from '../../src/providers/types.js';
import type { PlannedQuery } from '../../src/engine/strategy/strategy-engine.js';

const log = pino({ level: 'silent' });

describe('concurrency primitives', () => {
  it('Semaphore bounds parallelism', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        sem.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it('mapLimit keeps order', async () => {
    const out = await mapLimit([3, 1, 2], 2, async (x) => {
      await new Promise((r) => setTimeout(r, x));
      return x * 10;
    });
    expect(out.map((r) => (r.ok ? r.value : null))).toEqual([30, 10, 20]);
  });

  it('TokenBucket refills at the configured rate', () => {
    let t = 0;
    const b = new TokenBucket(2, 2, () => t);
    expect(b.tryTake()).toBe(0);
    expect(b.tryTake()).toBe(0);
    expect(b.tryTake()).toBe(500);
    t = 500;
    expect(b.tryTake()).toBe(0);
  });

  it('backoff has full jitter within bounds and withRetry stops when told', async () => {
    expect(backoffDelay(1, 100, 10_000, () => 0)).toBe(50);
    expect(backoffDelay(3, 100, 10_000, () => 1)).toBe(400);
    expect(backoffDelay(20, 100, 1000, () => 1)).toBe(1000);
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('fatal');
        },
        { retries: 5, baseDelayMs: 1, shouldRetry: () => false },
      ),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
    let n = 0;
    expect(await withRetry(async () => (++n < 3 ? Promise.reject(new Error('x')) : 'ok'), { retries: 3, baseDelayMs: 1 })).toBe('ok');
  });
});

describe('httpRequest', () => {
  let server: http.Server;
  let base = '';
  const hits: Record<string, number> = {};
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = req.url ?? '/';
      hits[path] = (hits[path] ?? 0) + 1;
      if (path === '/flaky') {
        if (hits[path]! < 3) {
          res.writeHead(503, { 'retry-after': '0' });
          return res.end('busy');
        }
        return res.end('{"ok":true}');
      }
      if (path === '/slow') return void setTimeout(() => res.end('late'), 2000);
      if (path === '/big') return res.end('x'.repeat(50_000));
      if (path === '/redirect') {
        res.writeHead(302, { location: '/final' });
        return res.end();
      }
      if (path === '/final') return res.end('final');
      if (path === '/to-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
        return res.end();
      }
      if (path === '/404') {
        res.writeHead(404);
        return res.end('nope');
      }
      if (path === '/latin2') {
        res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-2' });
        return res.end(Buffer.from([0x5a, 0xb3, 0xf3, 0x6b]));
      }
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('retries 503 and succeeds', async () => {
    const attempts: number[] = [];
    const r = await httpRequest(`${base}/flaky`, { provider: 'test', retries: 3, onAttempt: (a) => attempts.push(a.status ?? 0) });
    expect(r.json()).toEqual({ ok: true });
    expect(r.attempts).toBe(3);
    expect(attempts).toEqual([503, 503, 200]);
  });

  it('times out', async () => {
    const err = await httpRequest(`${base}/slow`, { provider: 'test', timeoutMs: 200, retries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('timeout');
  });

  it('truncates at maxBytes', async () => {
    const r = await httpRequest(`${base}/big`, { provider: 'test', maxBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBeLessThanOrEqual(1000 + 65_536);
  });

  it('follows redirects and records the chain', async () => {
    const r = await httpRequest(`${base}/redirect`, { provider: 'test' });
    expect(r.text()).toBe('final');
    expect(r.redirects[0]!.status).toBe(302);
    expect(r.url).toBe(`${base}/final`);
  });

  it('non-2xx throws unless acceptAnyStatus', async () => {
    await expect(httpRequest(`${base}/404`, { provider: 'test', retries: 0 })).rejects.toMatchObject({ code: 'http', status: 404 });
    expect((await httpRequest(`${base}/404`, { provider: 'test', acceptAnyStatus: true })).status).toBe(404);
  });

  it('decodes legacy charsets', async () => {
    expect((await httpRequest(`${base}/latin2`, { provider: 'test' })).text()).toBe('Złók');
  });

  it('aborts when the signal fires', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(httpRequest(`${base}/slow`, { provider: 'test', signal: ac.signal, retries: 0 })).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('source orchestrator', () => {
  const q = (text: string): PlannedQuery => ({ text, term: text.split(' ')[0]!, language: 'pl', strategy: 'primary', template: text, priority: 100 });
  const rec = (provider: string, id: string): NormalizedBusiness => ({ provider, providerRecordId: id, name: `Biz ${id}`, categories: [], fetchedAt: new Date() });

  function adapter(id: string, impl: (query: BusinessQuery) => Promise<SearchResultPage>, mode: 'text' | 'structured' = 'text'): LeadSourceAdapter & { calls: string[] } {
    const calls: string[] = [];
    return {
      id,
      name: id,
      category: 'places',
      dataPolicy: { retentionHours: null, notes: '' },
      capabilities: { search: true, details: false, website: false, contacts: false },
      rateLimitPerSec: 100,
      queryMode: mode,
      calls,
      isConfigured: () => true,
      configurationHint: () => '',
      searchBusinesses: async (query, ctx) => {
        calls.push(query.text);
        ctx.budget.consume();
        return impl(query);
      },
      getBusinessDetails: async () => null,
      findWebsite: async () => [],
      findPublicContacts: async () => [],
    };
  }

  it('fans out, dedupes structured sources and tolerates a failing provider', async () => {
    const good = adapter('good', async (query) => ({ items: [rec('good', `${query.text}-1`), rec('good', 'shared')], calls: 1 }));
    const osm = adapter('osm', async () => ({ items: [rec('osm', 'o1')], calls: 1 }), 'structured');
    const down = adapter('down', async () => {
      throw new ProviderUnavailableError('down', 'circuit open');
    });
    const r = await fanOut({ queries: [q('dentysta Warszawa'), q('stomatolog Warszawa')], sources: [good, osm, down], city: 'Warszawa', country: 'Poland', nicheKey: 'dentist', targetUniqueRecords: 100, perQueryLimit: 20, budget: new CallBudget(50), log });
    expect(good.calls).toHaveLength(2);
    expect(osm.calls).toHaveLength(1);
    expect(down.calls.length).toBeLessThanOrEqual(2);
    expect(r.providerStats.down!.status).toBe('circuit_open');
    expect(r.providerStats.good!.status).toBe('ok');
    expect(new Set(r.hits.map((h) => `${h.record.provider}:${h.record.providerRecordId}`)).size).toBe(4);
    expect(r.queryResults[1]!.newRecords).toBe(1); // "shared" already seen by query 1
  });

  it('stops scheduling when the target is reached and respects the call budget', async () => {
    const many = adapter('many', async (query) => ({ items: Array.from({ length: 10 }, (_, i) => rec('many', `${query.text}-${i}`)), calls: 1 }));
    const r = await fanOut({ queries: Array.from({ length: 10 }, (_, i) => q(`term${i} city`)), sources: [many], city: 'c', country: 'PL', targetUniqueRecords: 15, perQueryLimit: 10, budget: new CallBudget(100), log, globalConcurrency: 1, perProviderConcurrency: 1 });
    expect(r.stoppedEarly).toBe(true);
    expect(many.calls.length).toBe(2);

    const limited = adapter('limited', async (query) => ({ items: [rec('limited', query.text)], calls: 1 }));
    const r2 = await fanOut({ queries: Array.from({ length: 10 }, (_, i) => q(`t${i} c`)), sources: [limited], city: 'c', country: 'PL', targetUniqueRecords: 100, perQueryLimit: 10, budget: new CallBudget(3), log, globalConcurrency: 1 });
    expect(r2.budgetExhausted).toBe(true);
    expect(r2.hits).toHaveLength(3);
  });

  it('auth errors disable the provider for the rest of the job', async () => {
    const bad = adapter('bad', async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 });
    });
    const r = await fanOut({ queries: [q('a x'), q('b x'), q('c x')], sources: [bad], city: 'x', country: 'PL', targetUniqueRecords: 10, perQueryLimit: 5, budget: new CallBudget(10), log, globalConcurrency: 1 });
    expect(bad.calls).toHaveLength(1);
    expect(r.providerStats.bad!.status).toBe('failed');
  });

  it('honours cancellation', async () => {
    const ac = new AbortController();
    const slow = adapter('slow', async (query) => {
      if (query.text.startsWith('q0')) ac.abort();
      return { items: [rec('slow', query.text)], calls: 1 };
    });
    await fanOut({ queries: Array.from({ length: 5 }, (_, i) => q(`q${i} x`)), sources: [slow], city: 'x', country: 'PL', targetUniqueRecords: 100, perQueryLimit: 5, budget: new CallBudget(10), log, signal: ac.signal, globalConcurrency: 1 });
    expect(slow.calls).toHaveLength(1);
  });
});
