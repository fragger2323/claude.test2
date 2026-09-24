import { sleep } from './concurrency.js';

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to stop retrying for this error. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Optional explicit delay (e.g. from Retry-After). */
  delayFor?: (error: unknown, attempt: number) => number | undefined;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
  random?: () => number;
}

/** Exponential backoff with full jitter. attempt is 1-based. */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 30_000, random: () => number = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn(attempt);
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      const canRetry = attempt <= opts.retries && (opts.shouldRetry ? opts.shouldRetry(error, attempt) : true);
      if (!canRetry) throw error;
      const explicit = opts.delayFor?.(error, attempt);
      const delay = explicit ?? backoffDelay(attempt, opts.baseDelayMs, opts.maxDelayMs, opts.random);
      opts.onRetry?.(error, attempt, delay);
      await sleep(delay, opts.signal);
    }
  }
}
