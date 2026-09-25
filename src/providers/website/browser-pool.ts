import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from 'playwright';
import { loadConfig } from '../../config/env.js';
import { Semaphore } from '../../lib/concurrency.js';
import { logger } from '../../lib/logger.js';

/**
 * Controlled browser pool: ONE Chromium process per worker with a bounded number of
 * concurrent contexts (BROWSER_POOL_SIZE). Contexts are isolated (no shared cookies/cache)
 * and always closed. The browser is relaunched if it crashes.
 */
export class BrowserDeadlineError extends Error {
  override name = 'BrowserDeadlineError';
}

export class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly sem: Semaphore;
  private contextsOpened = 0;
  private closing = false;

  constructor(size: number) {
    this.sem = new Semaphore(size);
  }

  get stats(): { inUse: number; pending: number; contextsOpened: number; running: boolean } {
    return { inUse: this.sem.inUse, pending: this.sem.pending, contextsOpened: this.contextsOpened, running: !!this.browser };
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    const cfg = loadConfig();
    const log = logger('browser-pool');
    this.launching = chromium
      .launch({
        headless: true,
        executablePath: cfg.BROWSER_EXECUTABLE_PATH,
        chromiumSandbox: cfg.BROWSER_SANDBOX,
        args: ['--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run', '--mute-audio', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'],
      })
      .then((b) => {
        this.browser = b;
        b.on('disconnected', () => {
          if (!this.closing) log.warn('browser disconnected; will relaunch on next use');
          this.browser = null;
        });
        log.info({ version: b.version() }, 'browser launched');
        return b;
      })
      .finally(() => {
        this.launching = null;
      });
    return this.launching;
  }

  /**
   * Runs `fn` in a fresh context. Hard limits: `deadlineMs` (a page that freezes its main thread
   * makes Playwright calls such as page.evaluate wait forever) and the abort signal. On either,
   * the context is closed, which rejects every pending call; if closing itself hangs, the
   * browser is killed and relaunched on next use.
   */
  async withContext<T>(options: BrowserContextOptions, fn: (ctx: BrowserContext) => Promise<T>, signal?: AbortSignal, deadlineMs = 120_000): Promise<T> {
    const release = await this.sem.acquire(signal);
    let ctx: BrowserContext | null = null;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const browser = await this.getBrowser();
      ctx = await browser.newContext(options);
      this.contextsOpened++;
      const work = fn(ctx);
      work.catch(() => undefined); // may reject after the deadline won the race
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BrowserDeadlineError(`browser work exceeded ${Math.round(deadlineMs / 1000)}s (page unresponsive?)`)), deadlineMs);
        onAbort = () => reject(new BrowserDeadlineError('aborted'));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([work, limit]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      if (ctx) await this.closeContext(ctx);
      release();
    }
  }

  private async closeContext(ctx: BrowserContext): Promise<void> {
    let closeTimer: NodeJS.Timeout | undefined;
    const closed = await Promise.race([
      ctx.close().then(() => true, () => true),
      new Promise<boolean>((r) => {
        closeTimer = setTimeout(() => r(false), 10_000);
      }),
    ]);
    clearTimeout(closeTimer);
    if (!closed) {
      logger('browser-pool').warn('context did not close within 10s; restarting the browser');
      await this.restart();
    }
  }

  /** Kill a wedged browser; the next withContext() launches a fresh one. */
  private async restart(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (!b) return;
    this.closing = true;
    await Promise.race([b.close().catch(() => undefined), new Promise((r) => setTimeout(r, 5_000))]);
    this.closing = false;
  }

  async close(): Promise<void> {
    this.closing = true;
    const b = this.browser;
    this.browser = null;
    if (b) await b.close().catch(() => undefined);
    this.closing = false;
  }
}

let shared: BrowserPool | null = null;

export function browserPool(): BrowserPool {
  shared ??= new BrowserPool(loadConfig().BROWSER_POOL_SIZE);
  return shared;
}

export async function closeBrowserPool(): Promise<void> {
  if (shared) await shared.close();
  shared = null;
}
