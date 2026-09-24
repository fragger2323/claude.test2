import { sleep } from './concurrency.js';

/**
 * Token bucket. `ratePerSec` tokens are added per second up to `burst`.
 * `take()` waits until a token is available (or the signal aborts).
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number = Math.max(1, Math.ceil(ratePerSec)),
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = (t - this.last) / 1000;
    this.last = t;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
  }

  /** Returns ms to wait before a token is available (0 = available now, token consumed). */
  tryTake(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
  }

  async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const wait = this.tryTake();
      if (wait === 0) return;
      await sleep(wait, signal);
    }
  }
}

const buckets = new Map<string, TokenBucket>();

/** Shared per-key limiter (e.g. per provider) inside one process. */
export function limiterFor(key: string, ratePerSec: number, burst?: number): TokenBucket {
  let b = buckets.get(key);
  if (!b) {
    b = new TokenBucket(ratePerSec, burst);
    buckets.set(key, b);
  }
  return b;
}
