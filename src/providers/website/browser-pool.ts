import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from 'playwright';
import { loadConfig } from '../../config/env.js';
import { Semaphore } from '../../lib/concurrency.js';
import { logger } from '../../lib/logger.js';

/**
 * Controlled browser pool: ONE Chromium process per worker with a bounded number of
 * concurrent contexts (BROWSER_POOL_SIZE). Contexts are isolated (no shared cookies/cache)
 * and always closed. The browser is relaunched if it crashes.
 */
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
        args: ['--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run', '--mute-audio'],
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

  async withContext<T>(options: BrowserContextOptions, fn: (ctx: BrowserContext) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.sem.acquire(signal);
    try {
      const browser = await this.getBrowser();
      const ctx = await browser.newContext(options);
      this.contextsOpened++;
      try {
        return await fn(ctx);
      } finally {
        await ctx.close().catch(() => undefined);
      }
    } finally {
      release();
    }
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
