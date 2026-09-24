import { mapLimit } from '../../lib/concurrency.js';
import { parseRobots } from '../../lib/robots.js';
import { fetchPage } from './fetcher.js';
import type { HttpChecks, LinkCheck } from './types.js';

/** HTTP-level checks that need no browser: HTTPS, redirects, headers, robots, sitemap, soft-404. */
export async function runHttpChecks(url: string, signal?: AbortSignal): Promise<HttpChecks> {
  const u = new URL(url);
  const httpsUrl = `https://${u.host}${u.pathname}${u.search}`;
  const httpUrl = `http://${u.host}${u.pathname}${u.search}`;

  const httpsRes = await fetchPage(httpsUrl, { signal, timeoutMs: 20_000 });
  const httpRes = await fetchPage(httpUrl, { signal, timeoutMs: 15_000, method: 'GET', maxBytes: 64 * 1024 });
  const main = httpsRes.ok ? httpsRes : httpRes;
  const finalUrl = main.finalUrl ?? null;
  const origin = finalUrl ? new URL(finalUrl).origin : new URL(httpsRes.ok ? httpsUrl : httpUrl).origin;

  let httpRedirectsToHttps: boolean | null = null;
  if (httpRes.ok || httpRes.redirects.length > 0) {
    httpRedirectsToHttps = !!httpRes.finalUrl?.startsWith('https://');
  }

  const robotsRes = await fetchPage(`${origin}/robots.txt`, { signal, timeoutMs: 10_000, maxBytes: 256 * 1024 });
  const robotsText = robotsRes.ok && robotsRes.status === 200 && !/<html/i.test(robotsRes.html.slice(0, 500)) ? robotsRes.html : null;
  const robots = parseRobots(robotsText, 'AgencyIntelligenceOS');

  const sitemapCandidates = [...robots.sitemaps.slice(0, 2), `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`];
  let sitemap: HttpChecks['sitemap'] = { found: false, url: null, urlCount: null };
  for (const sm of [...new Set(sitemapCandidates)]) {
    const r = await fetchPage(sm, { signal, timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024 });
    if (r.ok && r.status === 200 && /<(urlset|sitemapindex)[\s>]/i.test(r.html.slice(0, 5000))) {
      sitemap = { found: true, url: r.finalUrl ?? sm, urlCount: (r.html.match(/<loc>/gi) ?? []).length };
      break;
    }
  }

  let soft404: boolean | null = null;
  if (main.ok) {
    const probe = await fetchPage(`${origin}/aios-check-${Math.random().toString(36).slice(2, 10)}-not-found`, { signal, timeoutMs: 10_000, maxBytes: 64 * 1024 });
    if (probe.status) soft404 = probe.status === 200;
  }

  const headers = main.headers ?? {};
  return {
    inputUrl: url,
    httpsOk: httpsRes.ok,
    httpsError: httpsRes.ok ? undefined : httpsRes.error ?? (httpsRes.status ? `HTTP ${httpsRes.status}` : 'unreachable'),
    httpRedirectsToHttps,
    redirectChain: main.redirects,
    homepageStatus: main.status ?? null,
    finalUrl,
    headers: Object.fromEntries(Object.entries(headers).filter(([k]) => ['server', 'content-type', 'content-encoding', 'strict-transport-security', 'cache-control', 'last-modified', 'x-powered-by', 'content-security-policy'].includes(k)).map(([k, v]) => [k, v.slice(0, 200)])),
    hsts: !!headers['strict-transport-security'],
    compressed: main.ok ? !!headers['content-encoding'] : null,
    htmlBytes: main.ok ? Buffer.byteLength(main.html) : null,
    robots: { found: robots.found, disallowAll: robots.found && !robots.isAllowed('/'), sitemaps: robots.sitemaps.slice(0, 5) },
    sitemap,
    soft404,
    lastModified: headers['last-modified'] ?? null,
  };
}

/**
 * Checks links found on analysed pages. Internal links: up to `maxInternal`; external: up to `maxExternal`.
 * 401/403/405/429 from external hosts are "unverifiable" (bot protection), not broken.
 */
export async function checkLinks(
  links: Array<{ url: string; internal: boolean; foundOn: string }>,
  opts: { maxInternal?: number; maxExternal?: number; signal?: AbortSignal } = {},
): Promise<LinkCheck[]> {
  const seen = new Set<string>();
  const internal: typeof links = [];
  const external: typeof links = [];
  for (const l of links) {
    const key = l.url.split('#')[0]!;
    if (seen.has(key) || !/^https?:/.test(key)) continue;
    seen.add(key);
    if (/\.(pdf|jpe?g|png|gif|webp|zip|docx?|xlsx?|mp4|mp3)(\?|$)/i.test(key) && !l.internal) continue;
    (l.internal ? internal : external).push({ ...l, url: key });
  }
  const targets = [...internal.slice(0, opts.maxInternal ?? 40), ...external.slice(0, opts.maxExternal ?? 15)];
  const results = await mapLimit(
    targets,
    4,
    async (l): Promise<LinkCheck> => {
      let r = await fetchPage(l.url, { signal: opts.signal, timeoutMs: 12_000, method: 'HEAD' });
      if (r.status === 405 || r.status === 501 || (!r.ok && !r.status)) {
        r = await fetchPage(l.url, { signal: opts.signal, timeoutMs: 12_000, maxBytes: 32 * 1024 });
      }
      const status = r.status;
      const unverifiable = !l.internal && (status === 401 || status === 403 || status === 405 || status === 429 || status === 999);
      const broken = !unverifiable && (status == null ? r.errorCode !== 'ssrf' : status >= 400);
      return { url: l.url, internal: l.internal, status, error: r.error, broken, unverifiable: unverifiable || r.errorCode === 'ssrf', foundOn: l.foundOn };
    },
    opts.signal,
  );
  return results.filter((r): r is { ok: true; value: LinkCheck } => r.ok).map((r) => r.value);
}
