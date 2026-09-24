import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { loadConfig } from '../../config/env.js';
import { VIEWPORTS, type Viewport } from '../../domain/types.js';
import { logger } from '../../lib/logger.js';
import { errorMessage, sha256 } from '../../lib/misc.js';
import { assertPublicUrl } from '../../lib/ssrf.js';
import { isSameSite, registrableDomain } from '../../lib/url.js';
import { browserPool } from './browser-pool.js';
import { checkLinks, runHttpChecks } from './http-checks.js';
import { COLLECT_SCRIPT, FOCUS_PROBE_SCRIPT, OBSERVER_INIT_SCRIPT, VISIBLE_NAV_LINKS_SCRIPT } from './page-scripts.js';
import type { AnalyzerRaw, FocusStop, NetworkEntry, PageSnapshot, PageVisit, ScreenshotFile, ViewportRun } from './types.js';
import { parseRobots } from '../../lib/robots.js';
import { fetchPage } from './fetcher.js';

export const ANALYZER_VERSION = 3;

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 AgencyIntelligenceOS/0.1';
const TABLET_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 AgencyIntelligenceOS/0.1';

export interface AnalyzeOptions {
  analysisId: string;
  signal?: AbortSignal;
  maxPages?: number;
  screenshotDir?: string;
  /** Viewports to run (default all three). */
  viewports?: Viewport[];
}

function classifyPage(url: string, text: string): PageVisit['kind'] | null {
  const s = `${url} ${text}`.toLowerCase();
  if (/(contact|kontakt|контакт|kontakty|contacto|contatti|impressum)/.test(s)) return 'contact';
  if (/(pricing|price|cennik|ceny|preise|prices|цены|ціни|tarif|precios|prezzi)/.test(s)) return 'pricing';
  if (/(services|service|usług|uslug|oferta|offer|leistungen|услуги|послуги|služby|servicios|servizi|zabieg|treatments?|behandlung)/.test(s)) return 'services';
  if (/(about|o-nas|o nas|über|uber-uns|о нас|про нас|o-nás|chi-siamo|quienes|a-propos)/.test(s)) return 'about';
  return null;
}

async function saveScreenshot(page: Page, dir: string, key: string, viewport: Viewport, kind: 'viewport' | 'fullpage', maxHeight: number): Promise<ScreenshotFile> {
  const vp = VIEWPORTS[viewport];
  const file = `${key.replace(/[^a-z0-9-]/gi, '_')}.jpg`;
  let buf: Buffer;
  let height = vp.height;
  if (kind === 'fullpage') {
    const scrollHeight = await page.evaluate('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)').catch(() => vp.height);
    height = Math.min(Number(scrollHeight) || vp.height, maxHeight);
    buf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: true, clip: { x: 0, y: 0, width: vp.width, height }, timeout: 20_000 });
  } else {
    buf = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 15_000 });
  }
  await writeFile(join(dir, file), buf);
  return { key, viewport, kind, pageUrl: page.url(), path: file, width: vp.width, height, bytes: buf.length, sha256: sha256(buf) };
}

async function guardContext(ctx: BrowserContext, blocked: string[]): Promise<void> {
  const allowPrivate = loadConfig().ALLOW_PRIVATE_NETWORK_TARGETS;
  await ctx.route('**/*', async (route) => {
    const url = route.request().url();
    if (!/^https?:/i.test(url)) return route.continue();
    try {
      await assertPublicUrl(url, allowPrivate);
      return route.continue();
    } catch {
      if (blocked.length < 50) blocked.push(url.slice(0, 200));
      return route.abort('blockedbyclient');
    }
  });
}

function attachCollectors(page: Page, run: ViewportRun, siteDomain: string | null): void {
  page.on('console', (msg) => {
    if (msg.type() === 'error' && run.consoleErrors.length < 40) run.consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => {
    if (run.jsErrors.length < 30) run.jsErrors.push(errorMessage(err).slice(0, 300));
  });
  page.on('requestfailed', (req) => {
    const err = req.failure()?.errorText ?? 'failed';
    if (/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(err)) return;
    if (run.failedRequests.length < 60) run.failedRequests.push({ url: req.url().slice(0, 300), error: err, type: req.resourceType() });
  });
  page.on('requestfinished', (req) => {
    void (async () => {
      const res = await req.response().catch(() => null);
      if (!res) return;
      const sizes = await req.sizes().catch(() => null);
      const url = req.url();
      const entry: NetworkEntry = {
        url: url.slice(0, 300),
        type: req.resourceType(),
        status: res.status(),
        bytes: sizes ? sizes.responseBodySize + sizes.responseHeadersSize : 0,
        contentType: (res.headers()['content-type'] ?? '').slice(0, 80),
        thirdParty: !!siteDomain && /^https?:/.test(url) && registrableDomain(url) !== siteDomain,
      };
      if (run.network.length < 800) run.network.push(entry);
      if (res.status() >= 400 && req.resourceType() !== 'document' && run.badResponses.length < 60) {
        run.badResponses.push({ url: url.slice(0, 300), status: res.status(), type: req.resourceType() });
      }
    })();
  });
}

async function navigate(page: Page, url: string, timeoutMs: number): Promise<{ status?: number; finalUrl: string }> {
  const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs }).catch(async (e: unknown) => {
    if (/Timeout/i.test(errorMessage(e))) {
      // Heavy pages: accept DOM ready if full load exceeded the budget.
      return page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.round(timeoutMs / 2) });
    }
    throw e;
  });
  await page.waitForTimeout(1200);
  return { status: response?.status(), finalUrl: page.url() };
}

async function runViewport(url: string, viewport: Viewport, dir: string, siteDomain: string | null, opts: AnalyzeOptions): Promise<ViewportRun> {
  const cfg = loadConfig();
  const vp = VIEWPORTS[viewport];
  const run: ViewportRun = { viewport, ok: false, screenshots: [], consoleErrors: [], jsErrors: [], failedRequests: [], badResponses: [], network: [], blockedRequests: [], durationMs: 0 };
  const started = Date.now();
  await browserPool().withContext(
    {
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.deviceScaleFactor,
      isMobile: vp.isMobile,
      hasTouch: vp.isMobile,
      userAgent: viewport === 'mobile' ? MOBILE_UA : viewport === 'tablet' ? TABLET_UA : undefined,
      serviceWorkers: 'block',
      acceptDownloads: false,
      javaScriptEnabled: true,
      locale: 'en-US',
    },
    async (ctx) => {
      await guardContext(ctx, run.blockedRequests);
      await ctx.addInitScript({ content: OBSERVER_INIT_SCRIPT });
      const page = await ctx.newPage();
      attachCollectors(page, run, siteDomain);
      try {
        const nav = await navigate(page, url, cfg.ANALYSIS_TIMEOUT_MS);
        run.mainStatus = nav.status;
        run.finalUrl = nav.finalUrl;
        run.snapshot = (await page.evaluate(`(${COLLECT_SCRIPT})(${JSON.stringify({ mobile: viewport !== 'desktop', contrast: viewport === 'desktop', light: false })})`)) as PageSnapshot;
        run.screenshots.push(await saveScreenshot(page, dir, `${viewport}-viewport`, viewport, 'viewport', vp.height));
        if (viewport !== 'tablet') {
          run.screenshots.push(await saveScreenshot(page, dir, `${viewport}-fullpage`, viewport, 'fullpage', vp.height * (viewport === 'mobile' ? 6 : 4)));
        }
        if (viewport === 'desktop') run.focusStops = await probeFocus(page);
        if (viewport === 'mobile') run.mobileMenu = await probeMobileMenu(page, run.snapshot);
        run.ok = true;
      } catch (e) {
        run.error = errorMessage(e).slice(0, 300);
      }
    },
    opts.signal,
  );
  run.durationMs = Date.now() - started;
  return run;
}

async function probeFocus(page: Page): Promise<FocusStop[]> {
  const stops: FocusStop[] = [];
  try {
    await page.evaluate('window.scrollTo(0, 0); document.activeElement && document.activeElement.blur && document.activeElement.blur();');
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const s = (await page.evaluate(FOCUS_PROBE_SCRIPT)) as FocusStop | null;
      if (s) stops.push(s);
    }
  } catch {
    // keyboard probing is best-effort
  }
  return stops;
}

async function probeMobileMenu(page: Page, snap: PageSnapshot): Promise<ViewportRun['mobileMenu']> {
  const toggle = snap.nav.toggles[0];
  const before = snap.nav.visibleNavLinks;
  if (!toggle) return { toggleFound: false, linksBefore: before, linksAfter: null };
  try {
    const beforeCount = Number(await page.evaluate(VISIBLE_NAV_LINKS_SCRIPT));
    await page.click(`[data-aios-toggle="${toggle.id}"]`, { timeout: 3000, trial: false, noWaitAfter: true });
    await page.waitForTimeout(700);
    const after = Number(await page.evaluate(VISIBLE_NAV_LINKS_SCRIPT));
    return { toggleFound: true, linksBefore: beforeCount, linksAfter: after };
  } catch (e) {
    return { toggleFound: true, linksBefore: before, linksAfter: null, error: errorMessage(e).slice(0, 200) };
  }
}

async function visitPage(url: string, kind: PageVisit['kind'], opts: AnalyzeOptions): Promise<PageVisit> {
  const cfg = loadConfig();
  const visit: PageVisit = { url, kind, ok: false, consoleErrors: [], jsErrors: [] };
  const blocked: string[] = [];
  await browserPool().withContext(
    { viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', acceptDownloads: false },
    async (ctx) => {
      await guardContext(ctx, blocked);
      const page = await ctx.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error' && visit.consoleErrors.length < 20) visit.consoleErrors.push(m.text().slice(0, 300));
      });
      page.on('pageerror', (e) => {
        if (visit.jsErrors.length < 20) visit.jsErrors.push(errorMessage(e).slice(0, 300));
      });
      try {
        const nav = await navigate(page, url, Math.min(cfg.ANALYSIS_TIMEOUT_MS, 30_000));
        visit.status = nav.status;
        visit.snapshot = (await page.evaluate(`(${COLLECT_SCRIPT})(${JSON.stringify({ mobile: false, contrast: false, light: true })})`)) as PageSnapshot;
        visit.ok = (nav.status ?? 200) < 400;
      } catch (e) {
        visit.error = errorMessage(e).slice(0, 300);
      }
    },
    opts.signal,
  );
  return visit;
}

/**
 * Live website analysis: HTTP checks, then desktop / tablet / mobile browser runs with
 * screenshots, then a few key internal pages (contact, services, about) and a link check.
 * Returns raw, evidence-bearing data; findings are derived separately (checks.ts).
 */
export async function analyzeWebsite(url: string, opts: AnalyzeOptions): Promise<AnalyzerRaw> {
  const cfg = loadConfig();
  const log = logger('analyzer');
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const dir = join(opts.screenshotDir ?? join(cfg.DATA_DIR, 'screenshots'), opts.analysisId);
  await mkdir(dir, { recursive: true });

  const http = await runHttpChecks(url, opts.signal);
  const base: AnalyzerRaw = {
    url,
    finalUrl: http.finalUrl,
    status: 'completed',
    runs: {},
    pages: [],
    http,
    links: [],
    errors,
    startedAt,
    finishedAt: startedAt,
    analyzerVersion: ANALYZER_VERSION,
  };
  if (!http.finalUrl || (http.homepageStatus != null && http.homepageStatus >= 500) || http.homepageStatus == null) {
    base.status = 'unreachable';
    errors.push(`homepage unreachable: ${http.httpsError ?? `HTTP ${http.homepageStatus}`}`);
    base.finishedAt = new Date().toISOString();
    return base;
  }
  if (cfg.RESPECT_ROBOTS_TXT && http.robots.disallowAll) {
    base.status = 'robots_disallowed';
    errors.push('robots.txt disallows automated access to "/"; browser analysis skipped out of respect for the site owner');
    base.finishedAt = new Date().toISOString();
    return base;
  }

  const target = http.finalUrl;
  const siteDomain = registrableDomain(target);
  const viewports = opts.viewports ?? (['desktop', 'mobile', 'tablet'] as Viewport[]);
  for (const vp of viewports) {
    if (opts.signal?.aborted) break;
    const run = await runViewport(target, vp, dir, siteDomain, opts);
    base.runs[vp] = run;
    if (!run.ok) errors.push(`${vp}: ${run.error}`);
    log.debug({ url: target, viewport: vp, ok: run.ok, ms: run.durationMs }, 'viewport analysed');
  }

  // Internal pages: contact / services / about / pricing from navigation links (robots-aware).
  const desktop = base.runs.desktop?.snapshot;
  if (desktop) {
    let robotsTxt: string | null = null;
    if (cfg.RESPECT_ROBOTS_TXT && http.robots.found) {
      const r = await fetchPage(`${new URL(target).origin}/robots.txt`, { signal: opts.signal, maxBytes: 256 * 1024 });
      robotsTxt = r.ok ? r.html : null;
    }
    const robots = parseRobots(robotsTxt, 'AgencyIntelligenceOS');
    const chosen = new Map<PageVisit['kind'], string>();
    const homePath = new URL(target).pathname;
    for (const l of desktop.links) {
      if (!l.internal || !/^https?:/.test(l.href)) continue;
      const u = new URL(l.href);
      if (u.pathname === homePath || /\.(pdf|jpe?g|png|zip)$/i.test(u.pathname)) continue;
      if (!robots.isAllowed(u.pathname)) continue;
      const kind = classifyPage(u.pathname, l.text);
      if (kind && !chosen.has(kind)) chosen.set(kind, `${u.origin}${u.pathname}`);
    }
    const maxPages = Math.max(0, (opts.maxPages ?? cfg.ANALYSIS_MAX_PAGES) - 1);
    for (const [kind, pageUrl] of [...chosen.entries()].slice(0, maxPages)) {
      if (opts.signal?.aborted) break;
      base.pages.push(await visitPage(pageUrl, kind, opts));
    }

    const allLinks = [desktop, ...base.pages.map((p) => p.snapshot).filter((s): s is PageSnapshot => !!s)].flatMap((s) =>
      s.links.filter((l) => /^https?:/.test(l.href)).map((l) => ({ url: l.href, internal: isSameSite(l.href, target), foundOn: s.url })),
    );
    base.links = await checkLinks(allLinks, { signal: opts.signal });
  }

  const okRuns = Object.values(base.runs).filter((r) => r?.ok).length;
  base.status = okRuns === 0 ? 'failed' : okRuns < viewports.length ? 'partial' : 'completed';
  base.finishedAt = new Date().toISOString();
  return base;
}
