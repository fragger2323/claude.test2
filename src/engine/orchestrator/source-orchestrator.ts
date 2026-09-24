import type { Logger } from 'pino';
import { Semaphore } from '../../lib/concurrency.js';
import { errorMessage } from '../../lib/misc.js';
import { ProviderUnavailableError } from '../../providers/base.js';
import {
  BudgetExceededError,
  type BusinessQuery,
  type CallBudget,
  type GeoArea,
  type LeadSourceAdapter,
  type NormalizedBusiness,
} from '../../providers/types.js';
import type { ProviderRunStat } from '../../domain/types.js';
import type { PlannedQuery } from '../strategy/strategy-engine.js';

/**
 * Source Orchestrator: fans planned queries out to every active source with bounded
 * concurrency (global + per provider), per-provider rate limits and retries (in the HTTP
 * layer), circuit breakers, a call budget and cooperative cancellation. One failing
 * provider never fails the job.
 */

export interface FanOutHit {
  record: NormalizedBusiness;
  queryIndex: number;
  rank: number;
}

export interface FanOutResult {
  hits: FanOutHit[];
  providerStats: Record<string, ProviderRunStat>;
  queryResults: Array<{ resultsCount: number; newRecords: number; errors: string[]; providers: string[] }>;
  stoppedEarly: boolean;
  budgetExhausted: boolean;
}

export interface FanOutOptions {
  queries: PlannedQuery[];
  sources: LeadSourceAdapter[];
  nicheKey?: string;
  city: string;
  country: string;
  countryCode?: string;
  area?: GeoArea;
  radiusKm?: number;
  /** Stop scheduling new queries once this many unique records were found. */
  targetUniqueRecords: number;
  perQueryLimit: number;
  budget: CallBudget;
  signal?: AbortSignal;
  log: Logger;
  jobId?: string;
  globalConcurrency?: number;
  perProviderConcurrency?: number;
  onProgress?: (done: number, total: number, unique: number) => void | Promise<void>;
  /** Checked between tasks (pause/cancel). Return true to stop scheduling. */
  shouldStop?: () => Promise<boolean> | boolean;
}

interface Task {
  source: LeadSourceAdapter;
  queryIndex: number;
  query: BusinessQuery;
}

export async function fanOut(opts: FanOutOptions): Promise<FanOutResult> {
  const providerStats: Record<string, ProviderRunStat> = {};
  for (const s of opts.sources) {
    providerStats[s.id] = { provider: s.id, name: s.name, status: 'ok', calls: 0, records: 0, errors: 0 };
  }
  const queryResults = opts.queries.map(() => ({ resultsCount: 0, newRecords: 0, errors: [] as string[], providers: [] as string[] }));

  // Build tasks: text sources get every query; structured sources get one task per term/segment-free key.
  const tasks: Task[] = [];
  const structuredSeen = new Set<string>();
  opts.queries.forEach((q, queryIndex) => {
    for (const source of opts.sources) {
      if (source.queryMode === 'structured') {
        const key = `${source.id}|${opts.nicheKey ?? q.term.toLowerCase()}`;
        if (structuredSeen.has(key)) continue;
        structuredSeen.add(key);
      }
      tasks.push({
        source,
        queryIndex,
        query: {
          text: q.text,
          term: q.term,
          nicheKey: opts.nicheKey,
          language: String(q.language),
          city: opts.city,
          country: opts.country,
          countryCode: opts.countryCode,
          segment: q.segment,
          area: opts.area,
          radiusKm: opts.radiusKm,
          limit: opts.perQueryLimit,
        },
      });
    }
  });

  const global = new Semaphore(opts.globalConcurrency ?? 4);
  const perProvider = new Map(opts.sources.map((s) => [s.id, new Semaphore(opts.perProviderConcurrency ?? 2)]));
  const unavailable = new Set<string>();
  const seen = new Set<string>();
  const hits: FanOutHit[] = [];
  let done = 0;
  let stoppedEarly = false;
  let budgetExhausted = false;

  const runTask = async (t: Task): Promise<void> => {
    const stat = providerStats[t.source.id]!;
    if (unavailable.has(t.source.id) || budgetExhausted || opts.signal?.aborted) {
      if (stat.status === 'ok' && unavailable.has(t.source.id)) stat.status = 'partial';
      return;
    }
    if (seen.size >= opts.targetUniqueRecords || (opts.shouldStop && (await opts.shouldStop()))) {
      stoppedEarly = true;
      return;
    }
    const release = await perProvider.get(t.source.id)!.acquire(opts.signal);
    try {
      const started = Date.now();
      const page = await t.source.searchBusinesses(t.query, { signal: opts.signal, budget: opts.budget, log: opts.log, jobId: opts.jobId });
      stat.calls += page.calls;
      stat.records += page.items.length;
      const qr = queryResults[t.queryIndex]!;
      qr.resultsCount += page.items.length;
      qr.providers.push(t.source.id);
      page.items.forEach((record, rank) => {
        const key = `${record.provider}:${record.providerRecordId}`;
        if (!seen.has(key)) {
          seen.add(key);
          qr.newRecords++;
        }
        hits.push({ record, queryIndex: t.queryIndex, rank: rank + 1 });
      });
      opts.log.info({ provider: t.source.id, query: t.query.text, results: page.items.length, latencyMs: Date.now() - started, jobId: opts.jobId }, 'source query done');
    } catch (e) {
      stat.errors++;
      stat.lastError = errorMessage(e);
      queryResults[t.queryIndex]!.errors.push(`${t.source.id}: ${errorMessage(e)}`);
      if (e instanceof BudgetExceededError) {
        budgetExhausted = true;
      } else if (e instanceof ProviderUnavailableError) {
        unavailable.add(t.source.id);
        stat.status = 'circuit_open';
      } else if ((e as { status?: number }).status === 401 || (e as { status?: number }).status === 403) {
        unavailable.add(t.source.id);
        stat.status = 'failed';
      }
      opts.log.warn({ provider: t.source.id, query: t.query.text, error: errorMessage(e), jobId: opts.jobId }, 'source query failed');
    } finally {
      release();
      done++;
      await opts.onProgress?.(done, tasks.length, seen.size);
    }
  };

  // Schedule in priority order (queries are pre-sorted), bounded by the global semaphore.
  await Promise.all(tasks.map((t) => global.run(() => runTask(t), opts.signal).catch(() => undefined)));

  for (const stat of Object.values(providerStats)) {
    if (stat.status === 'ok' && stat.errors > 0) stat.status = stat.records > 0 ? 'partial' : 'failed';
  }
  return { hits, providerStats, queryResults, stoppedEarly, budgetExhausted };
}
