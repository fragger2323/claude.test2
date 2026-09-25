import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { loadConfig } from '../../config/env.js';
import { VIEWPORTS, type Viewport } from '../../domain/types.js';
import { logger } from '../../lib/logger.js';
import { errorMessage, sha256 } from '../../lib/misc.js';
import { assertPublicUrl } from '../../lib/ssrf.js';
import { isSameSite, registrableDomain } from '../../lib/url.js';
import { browserPool, BrowserDeadlineError } from './browser-pool.js';
import { checkLinks, runHttpChecks } from './http-checks.js';
import { looksLikeChallenge } from './challenge.js';
import { COLLECT_SCRIPT, FOCUS_PROBE_SCRIPT, OBSERVER_INIT_SCRIPT, VISIBLE_NAV_LINKS_SCRIPT } from './page-scripts.js';
import type { AnalyzerRaw, FocusStop, NetworkEntry, PageSnapshot, PageVisit, ScreenshotFile, ViewportRun } from './types.js';
import { parseRobots } from '../../lib/robots.js';
import { fetchPage } from './fetcher.js';

export const ANALYZER_VERSION = 4;

/** page.evaluate has no timeout; a page that freezes its main thread would block forever. */
async function evaluateWithin<T>(page: Page, expression: string, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return (await Promise.race([
      page.evaluate(expression) as Promise<T>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PageUnresponsiveError(`page did not respond within ${Math.round(ms / 1000)}s while ${what} (main thread busy)`)), ms);
      }),
    ])) as T;
  } finally {
    clearTimeout(timer);
  }
}

class PageUnresponsiveError extends Error {
  override name = 'PageUnresponsiveError';
}

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
    const scrollHeight = await evaluateWithin<number>(page, 'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)', 5_000, 'measuring the page').catch(() => vp.height);
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
  // route() does not see WebSockets: never let an analysed page open one (it could probe internal services).
  await ctx.routeWebSocket(/.*/, (ws) => {
    if (blocked.length < 50) blocked.push(`websocket ${ws.url().slice(0, 190)}`);
    void ws.close({ code: 1008, reason: 'blocked by analyzer' });
  });
}

/** Console noise caused by our own sandbox (blocked private-network requests, refused WebSockets) is not the site's fault. */
function isSelfInflicted(text: string): boolean {
  return /ERR_BLOCKED_BY_CLIENT|blocked by analyzer|WebSocket connection to .* failed/i.test(text);
}

function attachCollectors(page: Page, run: ViewportRun, siteDomain: string | null): void {
  page.on('console', (msg) => {
    if (msg.type() === 'error' && run.consoleErrors.length < 40 && !isSelfInflicted(msg.text())) run.consoleErrors.push(msg.text().slice(0, 300));
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
  try {
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
          const probe = await evaluateWithin<{ title: string; html: string }>(page, '({ title: document.title || "", html: document.documentElement ? document.documentElement.outerHTML.slice(0, 60000) : "" })', 10_000, 'reading the page');
          if (looksLikeChallenge(probe.title, probe.html, nav.status)) {
            run.blocked = true;
            run.error = `bot-protection / challenge page ("${probe.title.slice(0, 60)}") — not analysed, not bypassed`;
            run.screenshots.push(await saveScreenshot(page, dir, `${viewport}-viewport`, viewport, 'viewport', vp.height).catch(() => null as never));
            run.screenshots = run.screenshots.filter(Boolean);
            return;
          }
          run.snapshot = await evaluateWithin<PageSnapshot>(page, `(${COLLECT_SCRIPT})(${JSON.stringify({ mobile: viewport !== 'desktop', contrast: viewport === 'desktop', light: false })})`, 30_000, 'collecting page data');
          run.screenshots.push(await saveScreenshot(page, dir, `${viewport}-viewport`, viewport, 'viewport', vp.height));
          if (viewport !== 'tablet') {
            run.screenshots.push(await saveScreenshot(page, dir, `${viewport}-fullpage`, viewport, 'fullpage', vp.height * (viewport === 'mobile' ? 6 : 4)));
          }
          if (viewport === 'desktop') run.focusStops = await probeFocus(page);
          if (viewport === 'mobile') run.mobileMenu = await probeMobileMenu(page, run.snapshot);
          run.ok = true;
        } catch (e) {
          run.error = errorMessage(e).slice(0, 300);
          if (e instanceof PageUnresponsiveError) run.unresponsive = true;
        }
      },
      opts.signal,
      cfg.ANALYSIS_TIMEOUT_MS * 2 + 60_000,
    );
  } catch (e) {
    // deadline, abort, or browser failure: the context has been closed by the pool
    run.error = errorMessage(e).slice(0, 300);
    if (e instanceof BrowserDeadlineError && e.message !== 'aborted') run.unresponsive = true;
  }
  run.durationMs = Date.now() - started;
  return run;
}

async function probeFocus(page: Page): Promise<FocusStop[]> {
  const stops: FocusStop[] = [];
  try {
    await evaluateWithin(page, 'window.scrollTo(0, 0); document.activeElement && document.activeElement.blur && document.activeElement.blur();', 5_000, 'resetting focus');
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab', { delay: 0 });
      const s = await evaluateWithin<FocusStop | null>(page, FOCUS_PROBE_SCRIPT, 5_000, 'probing keyboard focus');
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
    const beforeCount = Number(await evaluateWithin(page, VISIBLE_NAV_LINKS_SCRIPT, 5_000, 'counting menu links'));
    await page.click(`[data-aios-toggle="${toggle.id}"]`, { timeout: 3000, trial: false, noWaitAfter: true });
    await page.waitForTimeout(700);
    const after = Number(await evaluateWithin(page, VISIBLE_NAV_LINKS_SCRIPT, 5_000, 'counting menu links'));
    return { toggleFound: true, linksBefore: beforeCount, linksAfter: after };
  } catch (e) {
    return { toggleFound: true, linksBefore: before, linksAfter: null, error: errorMessage(e).slice(0, 200) };
  }
}

async function visitPage(url: string, kind: PageVisit['kind'], opts: AnalyzeOptions): Promise<PageVisit> {
  const cfg = loadConfig();
  const visit: PageVisit = { url, kind, ok: false, consoleErrors: [], jsErrors: [] };
  const blocked: string[] = [];
  try {
    await browserPool().withContext(
      { viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', acceptDownloads: false },
      async (ctx) => {
        await guardContext(ctx, blocked);
        const page = await ctx.newPage();
        page.on('console', (m) => {
          if (m.type() === 'error' && visit.consoleErrors.length < 20 && !isSelfInflicted(m.text())) visit.consoleErrors.push(m.text().slice(0, 300));
        });
        page.on('pageerror', (e) => {
          if (visit.jsErrors.length < 20) visit.jsErrors.push(errorMessage(e).slice(0, 300));
        });
        try {
          const nav = await navigate(page, url, Math.min(cfg.ANALYSIS_TIMEOUT_MS, 30_000));
          visit.status = nav.status;
          const probe = await evaluateWithin<{ title: string; html: string }>(page, '({ title: document.title || "", html: document.documentElement ? document.documentElement.outerHTML.slice(0, 60000) : "" })', 10_000, 'reading the page');
          if (looksLikeChallenge(probe.title, probe.html, nav.status)) {
            visit.error = 'bot-protection / challenge page — not analysed';
            return;
          }
          visit.snapshot = await evaluateWithin<PageSnapshot>(page, `(${COLLECT_SCRIPT})(${JSON.stringify({ mobile: false, contrast: false, light: true })})`, 30_000, 'collecting page data');
          visit.ok = (nav.status ?? 200) < 400;
        } catch (e) {
          visit.error = errorMessage(e).slice(0, 300);
        }
      },
      opts.signal,
      Math.min(cfg.ANALYSIS_TIMEOUT_MS, 30_000) * 2 + 45_000,
    );
  } catch (e) {
    visit.error = errorMessage(e).slice(0, 300);
  }
  return visit;
}

/**
 * Live website analysis: HTTP checks, then desktop / tablet / mobile browser runs with
 * screenshots, then a few key internal pages (contact, services, about) and a link check.
 * Returns raw, evidence-bearing data; findings are derived separately (checks.ts).
 *
 * Bounded: every browser step has a timeout, each browser run has a hard deadline, and the
 * whole site has a time budget (ANALYSIS_SITE_BUDGET_MS). Bot-protection pages are reported as
 * "blocked" (never bypassed) and produce no findings.
 */
export async function analyzeWebsite(url: string, opts: AnalyzeOptions): Promise<AnalyzerRaw> {
  const cfg = loadConfig();
  const log = logger('analyzer');
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const dir = join(opts.screenshotDir ?? join(cfg.DATA_DIR, 'screenshots'), opts.analysisId);
  await mkdir(dir, { recursive: true });
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(), cfg.ANALYSIS_SITE_BUDGET_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, budget.signal]) : budget.signal;
  const o: AnalyzeOptions = { ...opts, signal };
  try {
    const http = await runHttpChecks(url, signal);
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
    const done = (status: AnalyzerRaw['status'], error?: string) => {
      base.status = status;
      if (error) errors.push(error);
      base.finishedAt = new Date().toISOString();
      return base;
    };
    if (http.challenge || (http.homepageStatus != null && [401, 403, 429].includes(http.homepageStatus))) {
      return done('blocked', `the site answered HTTP ${http.homepageStatus ?? '?'}${http.challenge ? ' with a bot-protection page' : ''} to an automated visit; it was not analysed (protection is never bypassed)`);
    }
    if (!http.finalUrl || http.homepageStatus == null || http.homepageStatus >= 400) {
      return done('unreachable', `homepage unreachable: ${http.httpsError && !http.finalUrl ? http.httpsError : `HTTP ${http.homepageStatus ?? '—'}`}`);
    }
    if (cfg.RESPECT_ROBOTS_TXT && http.robots.disallowAll) {
      return done('robots_disallowed', 'robots.txt disallows automated access to "/"; browser analysis skipped out of respect for the site owner');
    }

    const target = http.finalUrl;
    const siteDomain = registrableDomain(target);
    const viewports = opts.viewports ?? (['desktop', 'mobile', 'tablet'] as Viewport[]);
    for (const vp of viewports) {
      if (signal.aborted) break;
      const run = await runViewport(target, vp, dir, siteDomain, o);
      base.runs[vp] = run;
      if (!run.ok) errors.push(`${vp}: ${run.error}`);
      log.debug({ url: target, viewport: vp, ok: run.ok, ms: run.durationMs }, 'viewport analysed');
      if (run.blocked) return done('blocked');
      // A frozen page will freeze the next viewport too — stop instead of waiting again.
      if (run.unresponsive) {
        errors.push('the page stopped responding (main thread busy); remaining viewports skipped');
        break;
      }
    }

    // Internal pages: contact / services / about / pricing from navigation links (robots-aware).
    const desktop = base.runs.desktop?.snapshot;
    if (desktop && !signal.aborted) {
      let robotsTxt: string | null = null;
      if (cfg.RESPECT_ROBOTS_TXT && http.robots.found) {
        const r = await fetchPage(`${new URL(target).origin}/robots.txt`, { signal, maxBytes: 256 * 1024 });
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
        if (signal.aborted) break;
        base.pages.push(await visitPage(pageUrl, kind, o));
      }

      const allLinks = [desktop, ...base.pages.map((p) => p.snapshot).filter((s): s is PageSnapshot => !!s)].flatMap((s) =>
        s.links.filter((l) => /^https?:/.test(l.href)).map((l) => ({ url: l.href, internal: isSameSite(l.href, target), foundOn: s.url })),
      );
      if (!signal.aborted) base.links = await checkLinks(allLinks, { signal });
    }
    if (budget.signal.aborted && !opts.signal?.aborted) errors.push(`site analysis time budget (${Math.round(cfg.ANALYSIS_SITE_BUDGET_MS / 1000)}s) reached; results are partial`);

    const okRuns = Object.values(base.runs).filter((r) => r?.ok).length;
    return done(okRuns === 0 ? 'failed' : okRuns < viewports.length || budget.signal.aborted ? 'partial' : 'completed');
  } finally {
    clearTimeout(budgetTimer);
  }
}
