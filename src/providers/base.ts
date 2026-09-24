import { httpRequest, HttpError, type HttpOptions } from '../lib/http.js';
import { limiterFor } from '../lib/rate-limiter.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { circuitStatus, recordProviderCall, recordUsage } from './health.js';
import type { ProviderContext } from './types.js';

export class ProviderUnavailableError extends Error {
  override name = 'ProviderUnavailableError';
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ProviderCallOptions extends Omit<HttpOptions, 'provider' | 'limiter' | 'signal' | 'onAttempt'> {
  cache?: { namespace: string; parts: unknown; ttlHours: number };
}

/**
 * All provider HTTP traffic goes through here: circuit breaker → cache → budget →
 * rate limiter → resilient HTTP (timeouts/retries/backoff) → health + usage accounting.
 */
export async function callProviderJson<T>(
  providerId: string,
  ratePerSec: number,
  url: string,
  opts: ProviderCallOptions,
  ctx: ProviderContext,
): Promise<T> {
  const circuit = circuitStatus(providerId);
  if (circuit.open) {
    throw new ProviderUnavailableError(providerId, `circuit open until ${circuit.until?.toISOString()} (${circuit.reason ?? 'repeated failures'})`);
  }
  if (opts.cache) {
    const hit = await cacheGet<T>(opts.cache.namespace, opts.cache.parts);
    if (hit !== undefined) {
      await recordUsage(providerId, { cacheHits: 1 }).catch(() => undefined);
      ctx.log.debug({ provider: providerId, cache: 'hit' }, 'provider cache hit');
      return hit;
    }
  }
  ctx.budget.consume(1);
  const { cache, ...httpOpts } = opts;
  const res = await httpRequest(url, {
    ...httpOpts,
    provider: providerId,
    signal: ctx.signal,
    limiter: limiterFor(providerId, ratePerSec),
    onAttempt: (a) => {
      void recordProviderCall(providerId, { ok: a.ok, latencyMs: a.latencyMs, status: a.status, error: a.error ?? (a.ok ? undefined : `HTTP ${a.status}`) });
    },
  }).catch((e: unknown) => {
    if (e instanceof HttpError) {
      ctx.log.warn({ provider: providerId, status: e.status, code: e.code, error: e.message, jobId: ctx.jobId }, 'provider request failed');
    }
    throw e;
  });
  let data: T;
  try {
    data = res.json<T>();
  } catch {
    throw new HttpError(`invalid JSON from ${providerId}`, 'http', providerId, res.status, false);
  }
  if (cache) await cacheSet(cache.namespace, cache.parts, data, cache.ttlHours).catch(() => undefined);
  return data;
}
