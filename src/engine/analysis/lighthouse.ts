import type { Logger } from 'pino';
import { chromium } from 'playwright';
import { loadConfig } from '../../config/env.js';

/**
 * Optional Lighthouse integration. Only runs when LIGHTHOUSE_ENABLED=true AND the
 * `lighthouse` package is installed (`npm i lighthouse`). Real scores are stored as-is;
 * when Lighthouse does not run, the analysis says so — scores are never estimated.
 */
export interface LighthouseResult {
  ran: true;
  fetchedAt: string;
  version: string;
  scores: Record<string, number | null>;
  audits: Record<string, { score: number | null; displayValue?: string }>;
}

export async function runLighthouseIfEnabled(url: string, log: Logger): Promise<LighthouseResult | null> {
  if (!loadConfig().LIGHTHOUSE_ENABLED) return null;
  let lighthouse: ((url: string, flags: Record<string, unknown>) => Promise<{ lhr: LhrLike } | undefined>) | undefined;
  try {
    const mod = (await import(/* @vite-ignore */ 'lighthouse' as string)) as { default: typeof lighthouse };
    lighthouse = mod.default;
  } catch {
    log.warn('LIGHTHOUSE_ENABLED=true but the "lighthouse" package is not installed; skipping');
    return null;
  }
  const port = 9300 + Math.floor(Math.random() * 500);
  const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
  try {
    const res = await lighthouse!(url, { port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'accessibility', 'seo', 'best-practices'] });
    if (!res) return null;
    const lhr = res.lhr;
    const pick = ['largest-contentful-paint', 'cumulative-layout-shift', 'total-blocking-time', 'speed-index', 'first-contentful-paint'];
    return {
      ran: true,
      fetchedAt: lhr.fetchTime,
      version: lhr.lighthouseVersion,
      scores: Object.fromEntries(Object.entries(lhr.categories).map(([k, v]) => [k, v.score])),
      audits: Object.fromEntries(pick.filter((p) => lhr.audits[p]).map((p) => [p, { score: lhr.audits[p]!.score, displayValue: lhr.audits[p]!.displayValue }])),
    };
  } catch (e) {
    log.warn({ url, error: (e as Error).message }, 'lighthouse run failed');
    return null;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

interface LhrLike {
  fetchTime: string;
  lighthouseVersion: string;
  categories: Record<string, { score: number | null }>;
  audits: Record<string, { score: number | null; displayValue?: string }>;
}
