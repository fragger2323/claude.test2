import { findPhonesInText } from '../../lib/phone.js';
import type { EvidenceItem, FindingDraft, ProblemTag, Viewport } from '../../domain/types.js';
import type { AnalyzerRaw, PageSnapshot, ViewportRun } from '../../providers/website/types.js';

/**
 * Deterministic website checks. Every finding carries evidence and neutral wording:
 * we describe what was observed or measured, never business outcomes.
 * Screenshot evidence uses keys ("desktop-viewport") that are mapped to Screenshot ids on save.
 */

type Draft = Omit<FindingDraft, 'source' | 'kind'> & { kind?: FindingDraft['kind'] };

const KB = 1024;
const fmtKb = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / KB)} KB`);
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const shot = (viewport: Viewport, kind: 'viewport' | 'fullpage' = 'viewport', label?: string): EvidenceItem => ({ type: 'screenshot', ref: `${viewport}-${kind}`, label: label ?? `${viewport} screenshot` });

function finalize(d: Draft): FindingDraft {
  return { ...d, kind: d.kind ?? 'observed', source: 'code' };
}

function run(raw: AnalyzerRaw, vp: Viewport): ViewportRun | undefined {
  const r = raw.runs[vp];
  return r?.ok ? r : undefined;
}

export interface CheckContext {
  now?: Date;
  /** Country of the business (phone-number parsing). */
  country?: string | null;
}

// ───────────────────────── technical ─────────────────────────

export function technicalFindings(raw: AnalyzerRaw): FindingDraft[] {
  const out: Draft[] = [];
  const h = raw.http;
  const home = raw.finalUrl ?? raw.url;

  // Only a real transport failure proves HTTPS is missing; a timeout proves nothing.
  const httpsProvenMissing = !h.httpsOk && h.httpsErrorCode !== 'timeout' && h.httpsErrorCode !== 'aborted' && !!h.finalUrl?.startsWith('http://') && h.homepageStatus != null;
  if (httpsProvenMissing) {
    out.push({
      code: 'tech.https_missing',
      category: 'security',
      polarity: 'negative',
      severity: 'high',
      title: 'Site is not available over HTTPS',
      detail: `Requesting the site over HTTPS failed (${h.httpsError ?? 'error'}), while HTTP responded. Browsers mark HTTP pages as "Not secure".`,
      evidence: [{ type: 'url', ref: raw.url, excerpt: h.httpsError }],
      pageUrl: home,
      confidence: 'high',
      problemTags: ['security_https'],
    });
  } else if (h.httpsOk) {
    out.push({ code: 'tech.https_ok', category: 'security', polarity: 'positive', severity: 'info', title: 'Served over HTTPS', detail: 'The homepage loads over HTTPS.', evidence: [{ type: 'url', ref: home }], pageUrl: home, confidence: 'high', problemTags: [] });
  }
  if (h.httpsOk && h.httpRedirectsToHttps === false) {
    out.push({
      code: 'tech.http_no_redirect',
      category: 'security',
      polarity: 'negative',
      severity: 'medium',
      title: 'HTTP version does not redirect to HTTPS',
      detail: 'The http:// address serves content instead of redirecting to https://, so visitors can end up on the insecure version.',
      evidence: [{ type: 'url', ref: raw.url.replace(/^https:/, 'http:') }],
      confidence: 'high',
      problemTags: ['security_https'],
    });
  }
  if (h.redirectChain.length > 2) {
    out.push({
      code: 'tech.redirect_chain',
      category: 'technical',
      polarity: 'negative',
      severity: 'low',
      title: `${h.redirectChain.length} redirects before the homepage loads`,
      detail: 'Each redirect adds a network round-trip before any content is shown.',
      evidence: h.redirectChain.map((r) => ({ type: 'network' as const, ref: r.url, value: r.status })),
      confidence: 'high',
      problemTags: ['performance', 'technical_errors'],
    });
  }
  if (h.homepageStatus != null && h.homepageStatus >= 400) {
    out.push({
      code: 'tech.homepage_status',
      category: 'technical',
      polarity: 'negative',
      severity: 'critical',
      title: `Homepage returns HTTP ${h.homepageStatus}`,
      detail: `The homepage responded with status ${h.homepageStatus}.`,
      evidence: [{ type: 'network', ref: home, value: h.homepageStatus }],
      confidence: 'high',
      problemTags: ['technical_errors'],
    });
  }

  const desktop = run(raw, 'desktop');
  const allJs = uniq([...(desktop?.jsErrors ?? []), ...(run(raw, 'mobile')?.jsErrors ?? []), ...raw.pages.flatMap((p) => p.jsErrors)]);
  if (allJs.length > 0) {
    out.push({
      code: 'tech.js_errors',
      category: 'technical',
      polarity: 'negative',
      severity: allJs.length >= 3 ? 'high' : 'medium',
      title: `${allJs.length} uncaught JavaScript error(s)`,
      detail: 'Scripts threw uncaught exceptions while the pages loaded. Depending on the script, features such as sliders, menus or forms may not work.',
      evidence: allJs.slice(0, 5).map((e) => ({ type: 'console' as const, excerpt: e })),
      pageUrl: home,
      confidence: 'high',
      problemTags: ['technical_errors'],
    });
  }
  const consoleErrs = uniq([...(desktop?.consoleErrors ?? []), ...raw.pages.flatMap((p) => p.consoleErrors)]).filter((e) => !/Mixed Content/i.test(e));
  if (consoleErrs.length >= 2) {
    out.push({
      code: 'tech.console_errors',
      category: 'technical',
      polarity: 'negative',
      severity: consoleErrs.length >= 8 ? 'medium' : 'low',
      title: `${consoleErrs.length} console error(s) logged`,
      detail: 'The browser console logged errors during page load (failed resources, script errors, blocked requests).',
      evidence: consoleErrs.slice(0, 5).map((e) => ({ type: 'console' as const, excerpt: e })),
      pageUrl: home,
      confidence: 'high',
      problemTags: ['technical_errors'],
    });
  }
  const mixed = uniq([...(desktop?.consoleErrors ?? [])].filter((e) => /Mixed Content/i.test(e)));
  const httpRes = desktop?.network.filter((n) => home.startsWith('https:') && n.url.startsWith('http:')) ?? [];
  if (mixed.length > 0 || httpRes.length > 0) {
    out.push({
      code: 'tech.mixed_content',
      category: 'security',
      polarity: 'negative',
      severity: 'medium',
      title: 'Insecure (HTTP) resources on an HTTPS page',
      detail: 'The HTTPS page references resources over plain HTTP; browsers block or warn about these.',
      evidence: [...mixed.slice(0, 3).map((e) => ({ type: 'console' as const, excerpt: e })), ...httpRes.slice(0, 3).map((n) => ({ type: 'network' as const, ref: n.url }))],
      confidence: 'high',
      problemTags: ['security_https', 'technical_errors'],
    });
  }
  const bad = uniqBy([...(desktop?.badResponses ?? []), ...(run(raw, 'mobile')?.badResponses ?? [])], (b) => b.url);
  const failed = uniqBy([...(desktop?.failedRequests ?? [])], (f) => f.url);
  if (bad.length + failed.length > 0) {
    out.push({
      code: 'tech.failed_resources',
      category: 'technical',
      polarity: 'negative',
      severity: bad.length + failed.length >= 5 ? 'medium' : 'low',
      title: `${bad.length + failed.length} page resource(s) failed to load`,
      detail: 'Images, scripts, styles or fonts requested by the homepage returned errors or failed, which can leave gaps or broken styling.',
      evidence: [...bad.slice(0, 5).map((b) => ({ type: 'network' as const, ref: b.url, value: b.status, label: b.type })), ...failed.slice(0, 3).map((f) => ({ type: 'network' as const, ref: f.url, excerpt: f.error, label: f.type }))],
      pageUrl: home,
      confidence: 'high',
      problemTags: ['broken_links', 'technical_errors'],
    });
  }
  const brokenInternal = raw.links.filter((l) => l.internal && l.broken);
  const brokenExternal = raw.links.filter((l) => !l.internal && l.broken);
  const checkedInternal = raw.links.filter((l) => l.internal).length;
  if (brokenInternal.length > 0) {
    out.push({
      code: 'tech.broken_internal_links',
      category: 'technical',
      polarity: 'negative',
      severity: brokenInternal.length >= 3 ? 'high' : 'medium',
      title: `${brokenInternal.length} broken internal link(s)`,
      detail: `Of ${checkedInternal} internal links checked, ${brokenInternal.length} returned an error or did not respond.`,
      evidence: brokenInternal.slice(0, 6).map((l) => ({ type: 'network' as const, ref: l.url, value: l.status ?? l.error ?? 'no response', label: `linked from ${l.foundOn}` })),
      confidence: 'high',
      problemTags: ['broken_links'],
    });
  } else if (checkedInternal >= 5) {
    out.push({ code: 'tech.links_ok', category: 'technical', polarity: 'positive', severity: 'info', title: 'No broken internal links found', detail: `${checkedInternal} internal links checked; all responded.`, evidence: [{ type: 'metric', value: checkedInternal, label: 'internal links checked' }], confidence: 'high', problemTags: [] });
  }
  if (brokenExternal.length > 0) {
    out.push({
      code: 'tech.broken_external_links',
      category: 'technical',
      polarity: 'negative',
      severity: 'low',
      title: `${brokenExternal.length} broken outbound link(s)`,
      detail: 'Links to other websites returned errors (e.g. removed partner pages or old social profiles).',
      evidence: brokenExternal.slice(0, 5).map((l) => ({ type: 'network' as const, ref: l.url, value: l.status ?? l.error ?? 'no response' })),
      confidence: 'medium',
      problemTags: ['broken_links'],
    });
  }
  if (h.httpsOk && !h.hsts) {
    out.push({ code: 'tech.no_hsts', category: 'security', polarity: 'negative', severity: 'info', title: 'No HSTS header', detail: 'The Strict-Transport-Security header is not set.', evidence: [{ type: 'header', label: 'strict-transport-security', value: 'absent' }], confidence: 'high', problemTags: ['security_https'] });
  }
  if (h.soft404) {
    out.push({ code: 'tech.soft_404', category: 'seo', polarity: 'negative', severity: 'low', title: 'Missing pages return HTTP 200', detail: 'A non-existent URL returned status 200 instead of 404 ("soft 404"), which confuses search engines.', evidence: [{ type: 'network', value: 200, label: 'status for a random non-existent path' }], confidence: 'high', problemTags: ['seo_foundation'] });
  }
  if (desktop?.snapshot && !desktop.snapshot.meta.favicon) {
    out.push({ code: 'tech.missing_favicon', category: 'visual', polarity: 'negative', severity: 'low', title: 'No favicon declared', detail: 'No <link rel="icon"> was found; browser tabs and bookmarks show a generic icon.', evidence: [{ type: 'html', excerpt: 'link[rel~=icon] not present' }], confidence: 'medium', problemTags: ['branding'] });
  }
  return out.map(finalize);
}

// ───────────────────────── responsive / mobile ─────────────────────────

export function responsiveFindings(raw: AnalyzerRaw): FindingDraft[] {
  const out: Draft[] = [];
  const mobile = run(raw, 'mobile');
  const tablet = run(raw, 'tablet');
  const ms = mobile?.snapshot;
  if (!ms) return [];
  const vpMeta = ms.meta.viewport;
  if (!vpMeta || !/width\s*=\s*device-width/i.test(vpMeta)) {
    out.push({
      code: 'mobile.no_viewport_meta',
      category: 'ux',
      polarity: 'negative',
      severity: 'high',
      title: 'No responsive viewport meta tag',
      detail: vpMeta ? `The viewport meta tag is "${vpMeta}" (without width=device-width), so phones render a zoomed-out desktop layout.` : 'There is no <meta name="viewport">, so phones render a zoomed-out desktop layout.',
      evidence: [{ type: 'html', excerpt: vpMeta ?? 'meta viewport missing' }, shot('mobile')],
      viewport: 'mobile',
      confidence: 'high',
      problemTags: ['mobile_experience', 'responsive_bugs', 'outdated_design'],
    });
  }
  if (vpMeta && /(user-scalable\s*=\s*(no|0))|(maximum-scale\s*=\s*1(\.0)?\b)/i.test(vpMeta)) {
    out.push({ code: 'a11y.zoom_disabled', category: 'accessibility', polarity: 'negative', severity: 'medium', title: 'Pinch-zoom is disabled on mobile', detail: `The viewport meta tag ("${vpMeta}") prevents or limits zooming, which affects users who need larger text.`, evidence: [{ type: 'html', excerpt: vpMeta }], viewport: 'mobile', confidence: 'high', problemTags: ['accessibility', 'mobile_experience'] });
  }
  for (const [vp, r] of [['mobile', mobile], ['tablet', tablet]] as const) {
    const s = r?.snapshot;
    if (!s) continue;
    const overflow = s.scroll.scrollWidth - s.viewport.width;
    if (overflow > 8) {
      out.push({
        code: `mobile.horizontal_overflow_${vp}`,
        category: 'ux',
        polarity: 'negative',
        severity: vp === 'mobile' ? 'high' : 'medium',
        title: `Content is wider than the ${vp} screen (${overflow}px overflow)`,
        detail: `At ${s.viewport.width}px width the page is ${s.scroll.scrollWidth}px wide${s.scroll.overflowHidden ? ' (clipped by overflow:hidden, so content is cut off)' : ', so it scrolls sideways'}.${s.scroll.overflowEls.length ? ` Widest elements: ${s.scroll.overflowEls.slice(0, 3).map((e) => `${e.path} (${e.width}px)`).join(', ')}.` : ''}`,
        evidence: [shot(vp), { type: 'metric', label: 'page width', value: s.scroll.scrollWidth, unit: 'px' }, ...s.scroll.overflowEls.slice(0, 3).map((e) => ({ type: 'element' as const, selector: e.path, value: e.width, unit: 'px' }))],
        viewport: vp,
        confidence: 'high',
        problemTags: ['responsive_bugs', 'mobile_experience'],
      });
    }
  }
  if (ms.text.textEls >= 10 && ms.text.smallText / ms.text.textEls > 0.2) {
    const pct = Math.round((ms.text.smallText / ms.text.textEls) * 100);
    out.push({ code: 'mobile.small_text', category: 'ux', polarity: 'negative', severity: 'medium', title: `${pct}% of text blocks are smaller than 12px on mobile`, detail: `${ms.text.smallText} of ${ms.text.textEls} visible text elements use a font size below 12px at 390px width.`, evidence: [shot('mobile'), { type: 'metric', value: pct, unit: '%', label: 'text below 12px' }], viewport: 'mobile', confidence: 'high', problemTags: ['mobile_experience'] });
  }
  if (ms.tapSmall.length >= 5) {
    out.push({ code: 'mobile.small_tap_targets', category: 'ux', polarity: 'negative', severity: ms.tapSmall.length >= 15 ? 'medium' : 'low', title: `${ms.tapSmall.length} tap targets smaller than 24×24px`, detail: `Buttons/links smaller than the WCAG 2.2 minimum target size (24×24 CSS px) were found on mobile, e.g. ${ms.tapSmall.slice(0, 3).map((t) => `"${t.text || t.path}" (${t.w}×${t.h})`).join(', ')}.`, evidence: [shot('mobile'), ...ms.tapSmall.slice(0, 4).map((t) => ({ type: 'element' as const, selector: t.path, excerpt: `${t.w}×${t.h}px` }))], viewport: 'mobile', confidence: 'high', problemTags: ['mobile_experience', 'accessibility'] });
  }
  if (ms.overlaps.length > 0) {
    out.push({ code: 'mobile.text_overlap', category: 'ux', polarity: 'negative', severity: 'medium', title: 'Overlapping text on mobile', detail: `Text elements overlap each other near the top of the mobile page, e.g. "${ms.overlaps[0]!.a}" and "${ms.overlaps[0]!.b}".`, evidence: [shot('mobile'), ...ms.overlaps.slice(0, 3).map((o) => ({ type: 'element' as const, selector: `${o.pathA} ∩ ${o.pathB}`, value: o.ratio, label: 'overlap ratio' }))], viewport: 'mobile', confidence: 'medium', problemTags: ['responsive_bugs', 'mobile_experience'] });
  }
  if (ms.fixedHeader && ms.fixedHeader.height > ms.viewport.height * 0.25) {
    const pct = Math.round((ms.fixedHeader.height / ms.viewport.height) * 100);
    out.push({ code: 'mobile.fixed_header_large', category: 'ux', polarity: 'negative', severity: 'low', title: `Fixed header covers ${pct}% of the mobile screen`, detail: `A fixed/sticky header (${ms.fixedHeader.height}px) stays on screen while scrolling, leaving less room for content.`, evidence: [shot('mobile'), { type: 'element', selector: ms.fixedHeader.path, value: ms.fixedHeader.height, unit: 'px' }], viewport: 'mobile', confidence: 'high', problemTags: ['mobile_experience'] });
  }
  const menu = mobile?.mobileMenu;
  if (ms.nav.navLinks > 0 && ms.nav.visibleNavLinks === 0 && menu && !menu.toggleFound) {
    out.push({ code: 'mobile.no_menu_toggle', category: 'ux', polarity: 'negative', severity: 'medium', title: 'Navigation hidden on mobile with no menu button found', detail: 'Navigation links exist in the markup but none are visible at 390px width, and no menu toggle button was detected.', evidence: [shot('mobile')], viewport: 'mobile', confidence: 'medium', problemTags: ['navigation_ux', 'mobile_experience'] });
  }
  if (menu?.toggleFound && menu.linksAfter != null && menu.linksAfter <= menu.linksBefore && ms.nav.visibleNavLinks === 0) {
    out.push({ code: 'mobile.menu_toggle_no_effect', category: 'ux', polarity: 'negative', severity: 'medium', title: 'Mobile menu button did not reveal navigation', detail: `After tapping the menu button, the number of visible navigation links did not increase (${menu.linksBefore} → ${menu.linksAfter}).`, evidence: [shot('mobile'), { type: 'metric', label: 'visible nav links after tap', value: menu.linksAfter }], viewport: 'mobile', confidence: 'medium', problemTags: ['navigation_ux', 'mobile_experience'] });
  }
  if (out.every((f) => !['mobile.no_viewport_meta', 'mobile.horizontal_overflow_mobile'].includes(f.code))) {
    out.push({ code: 'mobile.responsive_ok', category: 'ux', polarity: 'positive', severity: 'info', title: 'Mobile layout fits the screen', detail: 'A responsive viewport is declared and no horizontal overflow was measured at 390px.', evidence: [shot('mobile')], viewport: 'mobile', confidence: 'high', problemTags: [] });
  }
  return out.map(finalize);
}

// ───────────────────────── performance ─────────────────────────

export function performanceFindings(raw: AnalyzerRaw): FindingDraft[] {
  const out: Draft[] = [];
  const d = run(raw, 'desktop');
  const m = run(raw, 'mobile');
  if (!d?.snapshot) return [];
  const net = d.network;
  const total = net.reduce((s, n) => s + n.bytes, 0);
  const byType = (t: string[]) => net.filter((n) => t.includes(n.type)).reduce((s, n) => s + n.bytes, 0);
  const js = byType(['script']);
  const img = byType(['image']);
  const fonts = net.filter((n) => n.type === 'font');
  const note = 'Lab measurement from one page load by our analyser (not Lighthouse, not real-user data).';

  if (total > 3 * 1024 * 1024) {
    out.push({ code: 'perf.page_weight', category: 'performance', kind: 'measured', polarity: 'negative', severity: total > 6 * 1024 * 1024 ? 'high' : 'medium', title: `Homepage transfers ${fmtKb(total)}`, detail: `${net.length} requests transferred ${fmtKb(total)} on desktop (images ${fmtKb(img)}, JavaScript ${fmtKb(js)}). ${note}`, evidence: [{ type: 'metric', label: 'total transfer', value: Math.round(total / KB), unit: 'KB' }, { type: 'metric', label: 'requests', value: net.length }], confidence: 'high', problemTags: ['performance', 'heavy_assets'] });
  }
  if (js > 1024 * 1024) {
    out.push({ code: 'perf.js_weight', category: 'performance', kind: 'measured', polarity: 'negative', severity: js > 2 * 1024 * 1024 ? 'high' : 'medium', title: `${fmtKb(js)} of JavaScript`, detail: `Scripts account for ${fmtKb(js)} of transfer; large bundles delay interactivity, especially on mid-range phones.`, evidence: [{ type: 'metric', label: 'JavaScript transfer', value: Math.round(js / KB), unit: 'KB' }, ...net.filter((n) => n.type === 'script').sort((a, b) => b.bytes - a.bytes).slice(0, 3).map((n) => ({ type: 'network' as const, ref: n.url, value: Math.round(n.bytes / KB), unit: 'KB' }))], confidence: 'high', problemTags: ['performance', 'heavy_assets'] });
  }
  const bigImages = net.filter((n) => n.type === 'image' && n.bytes > 400 * KB).sort((a, b) => b.bytes - a.bytes);
  if (bigImages.length > 0) {
    out.push({ code: 'perf.large_images', category: 'performance', kind: 'measured', polarity: 'negative', severity: bigImages.length >= 3 ? 'medium' : 'low', title: `${bigImages.length} image(s) larger than 400 KB`, detail: `Largest: ${bigImages.slice(0, 3).map((i) => `${i.url.split('/').pop()?.slice(0, 50)} (${fmtKb(i.bytes)})`).join(', ')}.`, evidence: bigImages.slice(0, 5).map((i) => ({ type: 'network' as const, ref: i.url, value: Math.round(i.bytes / KB), unit: 'KB' })), confidence: 'high', problemTags: ['heavy_assets', 'performance', 'imagery'] });
  }
  const oversized = d.snapshot.images.filter((i) => i.visible && i.width > 0 && i.naturalWidth > 800 && i.naturalWidth > i.width * 2.2);
  if (oversized.length >= 2) {
    out.push({ code: 'perf.oversized_images', category: 'performance', kind: 'measured', polarity: 'negative', severity: 'low', title: `${oversized.length} images are much larger than displayed`, detail: `Images are downloaded at far higher resolution than shown, e.g. ${oversized.slice(0, 2).map((i) => `${i.naturalWidth}px wide shown at ${i.width}px`).join('; ')}.`, evidence: oversized.slice(0, 4).map((i) => ({ type: 'element' as const, ref: i.src, excerpt: `natural ${i.naturalWidth}×${i.naturalHeight}, displayed ${i.width}×${i.height}` })), confidence: 'high', problemTags: ['heavy_assets', 'performance'] });
  }
  const rasterBig = net.filter((n) => n.type === 'image' && n.bytes > 100 * KB && /image\/(jpeg|png)/.test(n.contentType));
  const modern = net.some((n) => /image\/(webp|avif)/.test(n.contentType));
  if (rasterBig.length >= 3 && !modern) {
    out.push({ code: 'perf.legacy_image_formats', category: 'performance', polarity: 'negative', severity: 'low', title: 'No modern image formats in use', detail: `${rasterBig.length} JPEG/PNG images over 100 KB and no WebP/AVIF images were served.`, evidence: rasterBig.slice(0, 3).map((n) => ({ type: 'network' as const, ref: n.url, excerpt: n.contentType, value: Math.round(n.bytes / KB), unit: 'KB' })), confidence: 'medium', problemTags: ['heavy_assets'] });
  }
  const blocking = d.snapshot.resources.filter((r) => r.blocking === 'blocking');
  const syncHeadScripts = d.snapshot.scripts.filter((s) => s.src && s.inHead && !s.async && !s.defer && !s.module);
  const blockingCount = blocking.length || syncHeadScripts.length + d.snapshot.stylesheets.filter((s) => s.inHead && s.media !== 'print').length;
  if (blockingCount > 6) {
    out.push({ code: 'perf.render_blocking', category: 'performance', polarity: 'negative', severity: blockingCount > 12 ? 'medium' : 'low', title: `${blockingCount} render-blocking resources`, detail: `The browser must download ${blockingCount} scripts/stylesheets before first render${syncHeadScripts.length ? ` (${syncHeadScripts.length} synchronous scripts in <head>)` : ''}.`, evidence: (blocking.length ? blocking.map((b) => b.name) : syncHeadScripts.map((s) => s.src!)).slice(0, 5).map((u) => ({ type: 'network' as const, ref: u })), confidence: blocking.length ? 'high' : 'medium', problemTags: ['performance'] });
  }
  if (net.length > 120) {
    out.push({ code: 'perf.many_requests', category: 'performance', kind: 'measured', polarity: 'negative', severity: net.length > 180 ? 'medium' : 'low', title: `${net.length} network requests on the homepage`, detail: 'A high request count increases load time on mobile networks.', evidence: [{ type: 'metric', label: 'requests', value: net.length }], confidence: 'high', problemTags: ['performance'] });
  }
  const third = net.filter((n) => n.thirdParty);
  const thirdHosts = new Set(third.map((n) => safeHost(n.url)));
  const thirdBytes = third.reduce((s, n) => s + n.bytes, 0);
  if (thirdHosts.size > 15 || (total > 0 && thirdBytes / total > 0.45 && thirdBytes > 500 * KB)) {
    out.push({ code: 'perf.third_party', category: 'performance', kind: 'measured', polarity: 'negative', severity: 'low', title: `${thirdHosts.size} third-party domains (${fmtKb(thirdBytes)})`, detail: 'Third-party scripts (widgets, trackers, embeds) add weight and are outside the site owner’s control.', evidence: [...thirdHosts].slice(0, 8).map((hst) => ({ type: 'network' as const, ref: hst })), confidence: 'high', problemTags: ['performance'] });
  }
  const fontBytes = fonts.reduce((s, n) => s + n.bytes, 0);
  if (fonts.length > 6 || fontBytes > 400 * KB) {
    out.push({ code: 'perf.fonts', category: 'performance', kind: 'measured', polarity: 'negative', severity: 'low', title: `${fonts.length} web font files (${fmtKb(fontBytes)})`, detail: 'Many or heavy font files delay text rendering and can cause layout shifts.', evidence: fonts.slice(0, 5).map((f) => ({ type: 'network' as const, ref: f.url, value: Math.round(f.bytes / KB), unit: 'KB' })), confidence: 'high', problemTags: ['performance'] });
  }
  for (const [vp, r] of [['desktop', d], ['mobile', m]] as const) {
    const p = r?.snapshot?.perf;
    if (!p) continue;
    if (p.lcp != null) {
      if (p.lcp > 2500) {
        out.push({ code: `perf.lcp_${vp}`, category: 'performance', kind: 'measured', polarity: 'negative', severity: p.lcp > 4000 ? 'high' : 'medium', title: `Largest content appeared after ${fmtMs(p.lcp)} (${vp})`, detail: `Largest Contentful Paint measured at ${fmtMs(p.lcp)} on ${vp}${p.lcpElement ? ` (element: ${p.lcpElement})` : ''}. ${note}`, evidence: [{ type: 'metric', label: 'LCP (lab)', value: p.lcp, unit: 'ms' }, shot(vp)], viewport: vp, confidence: 'medium', problemTags: ['performance'] });
      } else if (vp === 'desktop') {
        out.push({ code: 'perf.lcp_ok', category: 'performance', kind: 'measured', polarity: 'positive', severity: 'info', title: `Main content rendered in ${fmtMs(p.lcp)}`, detail: `Largest Contentful Paint ${fmtMs(p.lcp)} on desktop. ${note}`, evidence: [{ type: 'metric', label: 'LCP (lab)', value: p.lcp, unit: 'ms' }], viewport: vp, confidence: 'medium', problemTags: [] });
      }
    }
    if (p.cls != null && p.cls > 0.1) {
      out.push({ code: `perf.cls_${vp}`, category: 'performance', kind: 'measured', polarity: 'negative', severity: p.cls > 0.25 ? 'high' : 'medium', title: `Layout shifts during load (CLS ${p.cls}, ${vp})`, detail: `Content moved while loading (cumulative layout shift ${p.cls}).${p.clsSources[0]?.sources.filter(Boolean).length ? ` Shifting elements include ${p.clsSources[0]!.sources.filter(Boolean).join(', ')}.` : ''} ${note}`, evidence: [{ type: 'metric', label: 'CLS (lab)', value: p.cls }, shot(vp)], viewport: vp, confidence: 'medium', problemTags: ['performance', 'mobile_experience'] });
    }
  }
  const ttfb = d.snapshot.perf.ttfb;
  if (ttfb != null && ttfb > 1800) {
    out.push({ code: 'perf.ttfb', category: 'performance', kind: 'measured', polarity: 'negative', severity: 'medium', title: `Server responded after ${fmtMs(ttfb)}`, detail: `Time to first byte was ${fmtMs(ttfb)}, which delays everything else. ${note}`, evidence: [{ type: 'metric', label: 'TTFB (lab)', value: ttfb, unit: 'ms' }], confidence: 'medium', problemTags: ['performance'] });
  }
  if (raw.http.compressed === false && (raw.http.htmlBytes ?? 0) > 50 * KB) {
    out.push({ code: 'perf.no_compression', category: 'performance', polarity: 'negative', severity: 'low', title: 'HTML is served without compression', detail: `The ${fmtKb(raw.http.htmlBytes ?? 0)} HTML document had no Content-Encoding (gzip/brotli).`, evidence: [{ type: 'header', label: 'content-encoding', value: 'absent' }], confidence: 'high', problemTags: ['performance'] });
  }
  const lazyMissing = d.snapshot.images.filter((i) => !i.aboveFold && i.visible && i.loading !== 'lazy' && i.naturalWidth > 300);
  if (lazyMissing.length >= 8) {
    out.push({ code: 'perf.no_lazy_loading', category: 'performance', polarity: 'negative', severity: 'low', title: `${lazyMissing.length} below-the-fold images load eagerly`, detail: 'Images far down the page are downloaded immediately instead of when scrolled into view (loading="lazy").', evidence: lazyMissing.slice(0, 3).map((i) => ({ type: 'element' as const, ref: i.src })), confidence: 'medium', problemTags: ['performance', 'heavy_assets'] });
  }
  if (d.snapshot.animations.infinite >= 10) {
    out.push({ code: 'perf.animations', category: 'performance', polarity: 'negative', severity: 'low', title: `${d.snapshot.animations.infinite} continuously running animations`, detail: 'Many infinite CSS/JS animations run on the page; on low-end devices this can cause jank and battery drain.', evidence: [{ type: 'metric', label: 'infinite animations', value: d.snapshot.animations.infinite }], confidence: 'medium', problemTags: ['performance'] });
  }
  return out.map(finalize);
}

// ───────────────────────── SEO ─────────────────────────

export function seoFindings(raw: AnalyzerRaw): FindingDraft[] {
  const out: Draft[] = [];
  const s = run(raw, 'desktop')?.snapshot;
  if (!s) return [];
  const url = s.url;
  const t = s.meta.title;
  if (!t) {
    out.push({ code: 'seo.title_missing', category: 'seo', polarity: 'negative', severity: 'high', title: 'Homepage has no <title>', detail: 'The page title is empty; search results and browser tabs have nothing descriptive to show.', evidence: [{ type: 'html', excerpt: '<title> empty or missing' }], pageUrl: url, confidence: 'high', problemTags: ['seo_foundation'] });
  } else if (t.length < 15 || t.length > 70 || /^(home|homepage|strona g[łl]ówna|startseite|accueil|inicio|главная|головна|untitled|index)$/i.test(t.trim())) {
    out.push({ code: 'seo.title_quality', category: 'seo', polarity: 'negative', severity: 'low', title: `Page title is ${t.length < 15 ? 'very short or generic' : 'long'} (${t.length} chars)`, detail: `Title: "${t}". Titles of ~30–65 characters that name the service and location tend to be displayed in full.`, evidence: [{ type: 'html', excerpt: `<title>${t}</title>` }], pageUrl: url, confidence: 'high', problemTags: ['seo_foundation'] });
  }
  const desc = s.meta.description;
  if (!desc) {
    out.push({ code: 'seo.meta_description_missing', category: 'seo', polarity: 'negative', severity: 'medium', title: 'No meta description', detail: 'Search engines will pick an arbitrary text snippet for the result.', evidence: [{ type: 'html', excerpt: 'meta[name=description] missing' }], pageUrl: url, confidence: 'high', problemTags: ['seo_foundation'] });
  } else if (desc.length < 50 || desc.length > 170) {
    out.push({ code: 'seo.meta_description_length', category: 'seo', polarity: 'negative', severity: 'low', title: `Meta description is ${desc.length < 50 ? 'short' : 'long'} (${desc.length} chars)`, detail: `"${desc.slice(0, 160)}"`, evidence: [{ type: 'html', excerpt: desc.slice(0, 200) }], pageUrl: url, confidence: 'high', problemTags: ['seo_foundation'] });
  }
  if (s.h1Count === 0) {
    out.push({ code: 'seo.h1_missing', category: 'seo', polarity: 'negative', severity: 'medium', title: 'No H1 heading', detail: 'The homepage has no <h1>, so the main topic is not marked up for search engines and assistive tech.', evidence: [{ type: 'html', excerpt: 'h1 count: 0' }], pageUrl: url, confidence: 'high', problemTags: ['seo_foundation', 'accessibility'] });
  } else if (s.h1Count > 1) {
    out.push({ code: 'seo.h1_multiple', category: 'seo', polarity: 'negative', severity: 'low', title: `${s.h1Count} H1 headings`, detail: `Multiple H1s: ${s.headings.filter((h) => h.level === 1).slice(0, 3).map((h) => `"${h.text}"`).join(', ')}.`, evidence: s.headings.filter((h) => h.level === 1).slice(0, 3).map((h) => ({ type: 'html' as const, excerpt: `<h1>${h.text}</h1>` })), pageUrl: url, confidence: 'high', problemTags: ['seo_foundation'] });
  }
  const skips: string[] = [];
  let prev = 0;
  for (const h of s.headings) {
    if (prev && h.level > prev + 1) skips.push(`h${prev}→h${h.level} ("${h.text.slice(0, 40)}")`);
    prev = h.level;
  }
  if (skips.length >= 2) {
    out.push({ code: 'seo.heading_hierarchy', category: 'seo', polarity: 'negative', severity: 'low', title: 'Heading levels are skipped', detail: `The heading outline jumps levels ${skips.length} times, e.g. ${skips.slice(0, 2).join(', ')}.`, evidence: skips.slice(0, 3).map((x) => ({ type: 'html' as const, excerpt: x })), pageUrl: url, confidence: 'high', problemTags: ['seo_foundation', 'accessibility'] });
  }
  if (!s.meta.canonical) {
    out.push({ code: 'seo.canonical_missing', category: 'seo', polarity: 'negative', severity: 'low', title: 'No canonical URL', detail: 'No <link rel="canonical"> is declared on the homepage.', evidence: [{ type: 'html', excerpt: 'link[rel=canonical] missing' }], pageUrl: url, confidence: 'high', problemTags: ['seo_foundation'] });
  } else if (safeHost(s.meta.canonical) && safeHost(s.meta.canonical) !== safeHost(url)) {
    out.push({ code: 'seo.canonical_other_host', category: 'seo', polarity: 'negative', severity: 'medium', title: 'Canonical points to another host', detail: `Canonical URL is ${s.meta.canonical} while the page is served from ${safeHost(url)}.`, evidence: [{ type: 'html', excerpt: s.meta.canonical }], pageUrl: url, confidence: 'high', problemTags: ['seo_foundation'] });
  }
  if (s.meta.robots && /noindex/i.test(s.meta.robots)) {
    out.push({ code: 'seo.noindex', category: 'seo', polarity: 'negative', severity: 'critical', title: 'Homepage is marked "noindex"', detail: `The robots meta tag is "${s.meta.robots}", asking search engines not to index the homepage.`, evidence: [{ type: 'html', excerpt: `<meta name="robots" content="${s.meta.robots}">` }], pageUrl: url, confidence: 'high', problemTags: ['seo_foundation'] });
  }
  if (!raw.http.robots.found) {
    out.push({ code: 'seo.robots_missing', category: 'seo', polarity: 'negative', severity: 'info', title: 'No robots.txt', detail: '/robots.txt was not found.', evidence: [{ type: 'url', ref: '/robots.txt' }], confidence: 'high', problemTags: ['seo_foundation'] });
  }
  if (!raw.http.sitemap.found) {
    out.push({ code: 'seo.sitemap_missing', category: 'seo', polarity: 'negative', severity: 'low', title: 'No XML sitemap found', detail: 'No sitemap was found in robots.txt or at /sitemap.xml, /sitemap_index.xml or /wp-sitemap.xml.', evidence: [{ type: 'url', ref: '/sitemap.xml' }], confidence: 'medium', problemTags: ['seo_foundation'] });
  } else {
    out.push({ code: 'seo.sitemap_ok', category: 'seo', polarity: 'positive', severity: 'info', title: `XML sitemap found (${raw.http.sitemap.urlCount ?? '?'} entries)`, detail: `Sitemap at ${raw.http.sitemap.url}.`, evidence: [{ type: 'url', ref: raw.http.sitemap.url ?? undefined }], confidence: 'high', problemTags: [] });
  }
  if (!s.meta.ogTitle || !s.meta.ogImage) {
    out.push({ code: 'seo.og_missing', category: 'seo', polarity: 'negative', severity: 'low', title: 'Incomplete social sharing tags', detail: `Open Graph ${[!s.meta.ogTitle && 'og:title', !s.meta.ogImage && 'og:image'].filter(Boolean).join(' and ')} missing; shared links show without a proper preview.`, evidence: [{ type: 'html', excerpt: `og:title=${s.meta.ogTitle ?? '—'}, og:image=${s.meta.ogImage ?? '—'}` }], pageUrl: url, confidence: 'high', problemTags: ['seo_foundation', 'branding'] });
  }
  const localTypes = s.ld.types.filter((t2) => /(LocalBusiness|Organization|Dentist|MedicalBusiness|Restaurant|LegalService|Attorney|RealEstateAgent|Store|HealthAndBeautyBusiness|ProfessionalService|Hotel|AutoRepair|MedicalClinic|Physician)/i.test(t2));
  if (localTypes.length === 0) {
    out.push({ code: 'seo.structured_data_missing', category: 'seo', polarity: 'negative', severity: 'low', title: 'No business structured data', detail: s.ld.types.length ? `JSON-LD found (${s.ld.types.slice(0, 4).join(', ')}) but no LocalBusiness/Organization entity.` : 'No JSON-LD structured data describing the business (name, address, opening hours) was detected.', evidence: [{ type: 'html', excerpt: s.ld.types.length ? s.ld.types.join(', ') : 'no application/ld+json' }], pageUrl: url, confidence: s.ld.microdata > 0 ? 'medium' : 'high', problemTags: ['local_seo', 'seo_foundation'] });
  } else {
    out.push({ code: 'seo.structured_data_ok', category: 'seo', polarity: 'positive', severity: 'info', title: 'Business structured data present', detail: `JSON-LD types: ${localTypes.slice(0, 4).join(', ')}.`, evidence: [{ type: 'html', excerpt: localTypes.join(', ') }], pageUrl: url, confidence: 'high', problemTags: [] });
  }
  if (s.ld.invalid > 0) {
    out.push({ code: 'seo.structured_data_invalid', category: 'seo', polarity: 'negative', severity: 'low', title: `${s.ld.invalid} invalid JSON-LD block(s)`, detail: 'Structured data blocks could not be parsed as JSON and are ignored by search engines.', evidence: [{ type: 'metric', value: s.ld.invalid }], pageUrl: url, confidence: 'high', problemTags: ['seo_foundation'] });
  }
  if (s.wordCount < 150) {
    out.push({ code: 'seo.thin_content', category: 'content', polarity: 'negative', severity: 'low', title: `Very little text on the homepage (${s.wordCount} words)`, detail: 'The homepage contains little readable text describing services, which limits what search engines and visitors can learn.', evidence: [{ type: 'metric', label: 'words', value: s.wordCount }, shot('desktop', 'fullpage')], pageUrl: url, confidence: 'medium', problemTags: ['seo_foundation', 'service_presentation'] });
  }
  return out.map(finalize);
}

// ───────────────────────── accessibility ─────────────────────────

export function accessibilityFindings(raw: AnalyzerRaw): FindingDraft[] {
  const out: Draft[] = [];
  const d = run(raw, 'desktop');
  const s = d?.snapshot;
  if (!s) return [];
  const url = s.url;
  const noAlt = s.images.filter((i) => i.visible && !i.hasAlt && !i.decorative && i.width >= 24);
  if (noAlt.length > 0) {
    out.push({ code: 'a11y.img_alt_missing', category: 'accessibility', polarity: 'negative', severity: noAlt.length >= 5 ? 'medium' : 'low', title: `${noAlt.length} image(s) without alt text`, detail: 'Screen-reader users get no description of these images, and search engines cannot read them.', evidence: noAlt.slice(0, 4).map((i) => ({ type: 'element' as const, ref: i.src })), pageUrl: url, confidence: 'high', problemTags: ['accessibility', 'seo_foundation'] });
  }
  const unlabeled = s.forms.filter((f) => !f.isSearch).reduce((n, f) => n + f.unlabeled, 0) + 0;
  const placeholderOnly = s.forms.filter((f) => !f.isSearch).reduce((n, f) => n + f.placeholderOnly, 0);
  if (unlabeled > 0) {
    out.push({ code: 'a11y.form_labels_missing', category: 'accessibility', polarity: 'negative', severity: 'medium', title: `${unlabeled} form field(s) have no label`, detail: 'Fields have neither a <label>, aria-label nor placeholder, so assistive technology cannot announce what to enter.', evidence: [{ type: 'metric', value: unlabeled, label: 'unlabelled fields' }], pageUrl: url, confidence: 'high', problemTags: ['accessibility', 'forms'] });
  } else if (placeholderOnly >= 2) {
    out.push({ code: 'a11y.placeholder_only_labels', category: 'accessibility', polarity: 'negative', severity: 'low', title: `${placeholderOnly} form fields rely on placeholder text only`, detail: 'Placeholder text disappears while typing and is not a substitute for a visible label (WCAG 3.3.2).', evidence: [{ type: 'metric', value: placeholderOnly }], pageUrl: url, confidence: 'high', problemTags: ['accessibility', 'forms'] });
  }
  if (s.unnamed > 0) {
    out.push({ code: 'a11y.unnamed_controls', category: 'accessibility', polarity: 'negative', severity: s.unnamed >= 5 ? 'medium' : 'low', title: `${s.unnamed} button(s)/link(s) without an accessible name`, detail: 'Icon-only controls without text or aria-label are announced as "button"/"link" with no purpose.', evidence: s.unnamedExamples.slice(0, 4).map((p) => ({ type: 'element' as const, selector: p })), pageUrl: url, confidence: 'high', problemTags: ['accessibility'] });
  }
  if (s.contrast.sampled >= 10 && s.contrast.failing >= 3) {
    out.push({ code: 'a11y.contrast', category: 'accessibility', kind: 'measured', polarity: 'negative', severity: s.contrast.failing / s.contrast.sampled > 0.2 ? 'medium' : 'low', title: `${s.contrast.failing} of ${s.contrast.sampled} sampled text elements below WCAG AA contrast`, detail: `Measured on solid backgrounds only (${s.contrast.unknown} elements on images/gradients not assessed). Example: "${s.contrast.examples[0]?.text}" has ratio ${s.contrast.examples[0]?.ratio}:1 (needs ${s.contrast.examples[0]?.required}:1).`, evidence: s.contrast.examples.slice(0, 4).map((e) => ({ type: 'element' as const, selector: e.path, excerpt: `${e.fg} on ${e.bg}`, value: e.ratio, unit: ':1' })), pageUrl: url, confidence: 'high', problemTags: ['accessibility'] });
  }
  if (!s.meta.lang) {
    out.push({ code: 'a11y.lang_missing', category: 'accessibility', polarity: 'negative', severity: 'low', title: 'Page language not declared', detail: 'The <html> element has no lang attribute, so screen readers may use the wrong pronunciation.', evidence: [{ type: 'html', excerpt: '<html> without lang' }], pageUrl: url, confidence: 'high', problemTags: ['accessibility'] });
  }
  const stops = d?.focusStops ?? [];
  const onScreen = stops.filter((f) => f.onScreen);
  const noIndicator = onScreen.filter((f) => !f.indicator);
  if (onScreen.length >= 4 && noIndicator.length / onScreen.length >= 0.5) {
    out.push({ code: 'a11y.focus_not_visible', category: 'accessibility', polarity: 'negative', severity: 'medium', title: 'Keyboard focus is not visible', detail: `Pressing Tab moved focus through ${onScreen.length} elements; ${noIndicator.length} showed no visible focus indicator (no outline, shadow or colour change).`, evidence: noIndicator.slice(0, 4).map((f) => ({ type: 'element' as const, excerpt: `${f.tag} "${f.text}"` })), pageUrl: url, confidence: 'medium', problemTags: ['accessibility'] });
  }
  if (stops.length === 0 && s.clickableCount > 5) {
    out.push({ code: 'a11y.keyboard_unreachable', category: 'accessibility', polarity: 'negative', severity: 'medium', title: 'No elements received keyboard focus', detail: 'Pressing Tab 12 times did not focus any element, although the page has links/buttons.', evidence: [{ type: 'metric', label: 'focus stops', value: 0 }], pageUrl: url, confidence: 'medium', problemTags: ['accessibility'] });
  }
  if (s.landmarks.main === 0 && s.landmarks.nav === 0) {
    out.push({ code: 'a11y.landmarks_missing', category: 'accessibility', polarity: 'negative', severity: 'low', title: 'No semantic landmarks (main/nav)', detail: 'The page has no <main> or <nav> landmarks, which screen-reader users rely on to jump between sections.', evidence: [{ type: 'html', excerpt: JSON.stringify(s.landmarks) }], pageUrl: url, confidence: 'high', problemTags: ['accessibility'] });
  }
  if (s.ariaHiddenFocusable > 0 || s.brokenAriaRefs > 0) {
    out.push({ code: 'a11y.aria_issues', category: 'accessibility', polarity: 'negative', severity: 'low', title: 'ARIA attribute problems', detail: `${s.ariaHiddenFocusable} focusable element(s) inside aria-hidden containers; ${s.brokenAriaRefs} aria-labelledby/-describedby reference(s) to missing ids.`, evidence: [{ type: 'metric', label: 'aria-hidden focusable', value: s.ariaHiddenFocusable }, { type: 'metric', label: 'broken ARIA references', value: s.brokenAriaRefs }], pageUrl: url, confidence: 'high', problemTags: ['accessibility'] });
  }
  return out.map(finalize);
}

// ───────────────────────── UX / conversion ─────────────────────────

const CONTACT_LINK_RE = /(contact|kontakt|контакт|kontakty|contacto|contatti|nous-contacter)/i;
const SERVICE_LINK_RE = /(services|service|usług|uslug|oferta|offer|leistungen|услуги|послуги|služby|servicios|servizi|zabieg|treatments?|cennik|pricing)/i;

export function uxFindings(raw: AnalyzerRaw, ctx: CheckContext = {}): FindingDraft[] {
  const out: Draft[] = [];
  const d = run(raw, 'desktop')?.snapshot;
  const m = run(raw, 'mobile')?.snapshot;
  if (!d) return [];
  const url = d.url;

  const firstCta = (s: PageSnapshot | undefined) => s?.ctas.filter((c) => !c.inNav || c.buttonLike).sort((a, b) => a.top - b.top)[0];
  const dc = firstCta(d);
  const mc = firstCta(m);
  if (d.ctas.length === 0) {
    out.push({ code: 'ux.no_cta', category: 'ux', polarity: 'negative', severity: 'high', title: 'No clear call-to-action found', detail: 'No button or link inviting the visitor to book, call, request a quote or get in touch was detected on the homepage.', evidence: [shot('desktop'), shot('desktop', 'fullpage')], pageUrl: url, confidence: 'medium', problemTags: ['weak_cta', 'conversion_path'] });
  } else {
    if (dc && !dc.inFirstViewport) {
      out.push({ code: 'ux.cta_below_fold_desktop', category: 'ux', polarity: 'negative', severity: 'medium', title: 'Primary CTA is below the first screen (desktop)', detail: `The first call-to-action ("${dc.text}") starts ${dc.top}px from the top, below the first ${d.viewport.height}px screen, so visitors must scroll before seeing a next step.`, evidence: [shot('desktop'), { type: 'element', excerpt: dc.text, value: dc.top, unit: 'px from top' }], pageUrl: url, viewport: 'desktop', confidence: 'high', problemTags: ['weak_cta', 'conversion_path', 'landing_structure'] });
    }
    if (m && mc && !mc.inFirstViewport) {
      out.push({ code: 'ux.cta_below_fold_mobile', category: 'ux', polarity: 'negative', severity: 'medium', title: 'Primary CTA is below the first screen (mobile)', detail: `On a 390px phone screen the first call-to-action ("${mc.text}") appears ${mc.top}px down, beyond the first ${m.viewport.height}px.`, evidence: [shot('mobile'), { type: 'element', excerpt: mc.text, value: mc.top, unit: 'px from top' }], pageUrl: url, viewport: 'mobile', confidence: 'high', problemTags: ['weak_cta', 'conversion_path', 'mobile_experience'] });
    }
    if (dc?.inFirstViewport && !dc.buttonLike && d.ctas.filter((c) => c.inFirstViewport).every((c) => !c.buttonLike)) {
      out.push({ code: 'ux.cta_not_prominent', category: 'ux', polarity: 'negative', severity: 'low', title: 'First-screen CTA is a plain text link', detail: `The call-to-action in the first screen ("${dc.text}") has no button styling (no background or border), so it may not stand out.`, evidence: [shot('desktop'), { type: 'element', excerpt: dc.text }], pageUrl: url, viewport: 'desktop', confidence: 'medium', problemTags: ['weak_cta'] });
    }
    if (dc?.inFirstViewport && (!m || mc?.inFirstViewport)) {
      out.push({ code: 'ux.cta_visible', category: 'ux', polarity: 'positive', severity: 'info', title: 'Call-to-action visible on the first screen', detail: `"${dc.text}" is visible without scrolling${m ? ' on desktop and mobile' : ''}.`, evidence: [shot('desktop')], pageUrl: url, confidence: 'high', problemTags: [] });
    }
  }

  const navContact = d.links.some((l) => l.inNav && CONTACT_LINK_RE.test(`${l.href} ${l.text}`));
  const headerPhone = d.telLinks.some((t) => t.inHeader);
  const anyContactLink = d.links.some((l) => CONTACT_LINK_RE.test(`${l.href} ${l.text}`));
  if (!navContact && !headerPhone) {
    out.push({ code: 'ux.contact_not_in_nav', category: 'ux', polarity: 'negative', severity: anyContactLink ? 'low' : 'medium', title: 'Contact is not reachable from the main navigation', detail: anyContactLink ? 'A contact link exists (e.g. in the footer) but neither the header nor the navigation contains a contact link or phone number.' : 'No contact page link and no phone number were found in the header or navigation.', evidence: [shot('desktop')], pageUrl: url, confidence: 'high', problemTags: ['contact_path', 'conversion_path'] });
  }
  if (m) {
    // Validated phone numbers only — years ("2016 - 2024"), tax IDs and bank accounts are not phones.
    const phoneInText = findPhonesInText(m.bodyText.slice(0, 20000), ctx.country ?? undefined)[0];
    if (phoneInText && m.telLinks.length === 0) {
      out.push({ code: 'ux.no_click_to_call', category: 'ux', polarity: 'negative', severity: 'medium', title: 'Phone number is not tappable on mobile', detail: `The phone number ${phoneInText.international} appears as text, but there is no tel: link, so mobile visitors cannot call with one tap.`, evidence: [shot('mobile'), { type: 'text', excerpt: phoneInText.international }], pageUrl: url, viewport: 'mobile', confidence: 'high', problemTags: ['contact_path', 'mobile_experience'] });
    } else if (m.telLinks.length > 0) {
      out.push({ code: 'ux.click_to_call_ok', category: 'contact', polarity: 'positive', severity: 'info', title: 'Click-to-call available on mobile', detail: `${m.telLinks.length} tel: link(s) found.`, evidence: [{ type: 'html', excerpt: m.telLinks[0]!.href }], pageUrl: url, confidence: 'high', problemTags: [] });
    }
  }
  const allForms = [...d.forms, ...raw.pages.flatMap((p) => p.snapshot?.forms ?? [])].filter((f) => !f.isSearch && f.fieldCount > 0);
  const contactForm = allForms.find((f) => f.hasEmail || f.hasTextarea || f.hasPhone);
  if (!contactForm) {
    const bookingLinks = d.links.filter((l) => /(booksy|calendly|znanylekarz|docplanner|doctolib|treatwell|fresha|setmore|simplybook|booking)/i.test(l.href)).length;
    out.push({ code: 'ux.no_contact_form', category: 'ux', polarity: 'negative', severity: bookingLinks ? 'info' : 'low', title: 'No contact or enquiry form found', detail: `No enquiry form was found on the ${1 + raw.pages.length} page(s) analysed${bookingLinks ? ' (an external booking platform link is used instead)' : ''}.`, evidence: [{ type: 'metric', label: 'pages analysed', value: 1 + raw.pages.length }], confidence: 'medium', problemTags: bookingLinks ? [] : ['conversion_path', 'forms'] });
  } else if (contactForm.fieldCount > 8) {
    out.push({ code: 'ux.long_form', category: 'ux', polarity: 'negative', severity: 'low', title: `Contact form has ${contactForm.fieldCount} fields`, detail: 'Long forms add friction; only fields needed for a first reply are typically required.', evidence: [{ type: 'metric', value: contactForm.fieldCount, label: 'fields' }], confidence: 'high', problemTags: ['forms', 'conversion_path'] });
  } else {
    out.push({ code: 'ux.contact_form_ok', category: 'contact', polarity: 'positive', severity: 'info', title: 'Contact form available', detail: `A ${contactForm.fieldCount}-field enquiry form was found.`, evidence: [{ type: 'metric', value: contactForm.fieldCount, label: 'fields' }], confidence: 'high', problemTags: [] });
  }
  if (!d.nav.hasNav && d.nav.navLinks === 0) {
    out.push({ code: 'ux.no_navigation', category: 'ux', polarity: 'negative', severity: 'medium', title: 'No navigation menu detected', detail: 'No <nav> element or header links were found; visitors must scroll to discover content.', evidence: [shot('desktop')], pageUrl: url, confidence: 'medium', problemTags: ['navigation_ux'] });
  } else {
    const topNav = d.links.filter((l) => l.inNav && l.visible && l.top < 200).length;
    if (topNav > 14) {
      out.push({ code: 'ux.nav_overloaded', category: 'ux', polarity: 'negative', severity: 'low', title: `${topNav} links in the top navigation`, detail: 'A long top-level menu makes it harder to find key pages quickly.', evidence: [shot('desktop'), { type: 'metric', value: topNav, label: 'visible top nav links' }], pageUrl: url, confidence: 'medium', problemTags: ['navigation_ux'] });
    }
  }
  if (!d.firstScreen.headingInFirstScreen) {
    out.push({ code: 'ux.no_heading_first_screen', category: 'ux', polarity: 'negative', severity: 'low', title: 'No heading visible on the first screen', detail: 'No H1–H6 heading is visible without scrolling on desktop, so the page does not state its topic immediately.', evidence: [shot('desktop')], pageUrl: url, viewport: 'desktop', confidence: 'high', problemTags: ['landing_structure', 'service_presentation'] });
  }
  const hasTrust = d.trustSignals.length > 0 || d.trustWidgets > 0 || raw.pages.some((p) => (p.snapshot?.trustSignals.length ?? 0) > 0);
  if (!hasTrust) {
    out.push({ code: 'ux.trust_signals_not_found', category: 'ux', polarity: 'negative', severity: 'low', title: 'No testimonials, reviews or credentials detected', detail: `No review, testimonial, certificate or client-logo section was detected on the ${1 + raw.pages.length} page(s) analysed (text and common widget patterns).`, evidence: [shot('desktop', 'fullpage')], confidence: 'medium', problemTags: ['trust_signals'] });
  }
  const servicesLink = d.links.some((l) => (l.inNav || l.top < d.viewport.height * 2) && SERVICE_LINK_RE.test(`${l.href} ${l.text}`));
  const servicesPage = raw.pages.some((p) => p.kind === 'services' || p.kind === 'pricing');
  if (!servicesLink && !servicesPage) {
    out.push({ code: 'ux.services_not_discoverable', category: 'ux', polarity: 'negative', severity: 'low', title: 'Services/offer not linked prominently', detail: 'No services, offer or pricing link was found in the navigation or near the top of the homepage.', evidence: [shot('desktop')], pageUrl: url, confidence: 'medium', problemTags: ['service_presentation', 'navigation_ux'] });
  }
  for (const [vp, s] of [['desktop', d], ['mobile', m]] as const) {
    const blocking = s?.overlays.find((o) => o.cover > 0.5);
    if (blocking) {
      out.push({ code: `ux.overlay_${vp}`, category: 'ux', polarity: 'negative', severity: blocking.cookie ? 'low' : 'medium', title: `${blocking.cookie ? 'Cookie banner' : 'Pop-up'} covers ${Math.round(blocking.cover * 100)}% of the ${vp} screen on load`, detail: `An overlay ("${blocking.text.slice(0, 60)}") covers most of the first screen when the page opens.`, evidence: [shot(vp), { type: 'element', selector: blocking.path }], pageUrl: url, viewport: vp, confidence: 'high', problemTags: ['conversion_path', vp === 'mobile' ? 'mobile_experience' : 'navigation_ux'] });
    }
  }
  return out.map(finalize);
}

// ───────────────────────── visual / modernity signals (code) ─────────────────────────

export function visualSignalFindings(raw: AnalyzerRaw, ctx: CheckContext = {}): FindingDraft[] {
  const out: Draft[] = [];
  const s = run(raw, 'desktop')?.snapshot;
  if (!s) return [];
  const year = (ctx.now ?? new Date()).getFullYear();
  const latest = s.copyrightYears.length ? Math.max(...s.copyrightYears.filter((y) => y <= year)) : null;
  if (latest && latest <= year - 3) {
    out.push({ code: 'visual.copyright_old', category: 'content', polarity: 'negative', severity: 'low', title: `Footer copyright year is ${latest}`, detail: `The most recent year in the footer copyright notice is ${latest}. This can indicate the site has not been updated recently (it is only a signal, not proof).`, evidence: [{ type: 'text', excerpt: s.footerText.match(/(©|copyright|\(c\))[^\n]{0,60}/i)?.[0] ?? String(latest) }], confidence: 'medium', problemTags: ['outdated_design', 'maintenance'] });
  }
  const leg = s.legacy;
  const legacyBits = [leg.font && `${leg.font} <font>`, leg.center && `${leg.center} <center>`, leg.marquee && `${leg.marquee} <marquee>`, leg.frames && 'frames', leg.flash && 'Flash objects', leg.layoutTables && `${leg.layoutTables} nested layout tables`].filter(Boolean) as string[];
  if (legacyBits.length > 0) {
    out.push({ code: 'visual.legacy_markup', category: 'technical', polarity: 'negative', severity: leg.flash || leg.frames ? 'high' : 'medium', title: 'Legacy HTML techniques in use', detail: `Deprecated markup found: ${legacyBits.join(', ')}. These techniques predate responsive design.`, evidence: [{ type: 'html', excerpt: legacyBits.join(', ') }, shot('desktop')], confidence: 'high', problemTags: ['outdated_design', 'maintenance'] });
  }
  const jq = s.tech.jquery;
  if (jq && /^1\.|^2\./.test(jq)) {
    out.push({ code: 'tech.old_jquery', category: 'technical', polarity: 'negative', severity: 'low', title: `Outdated jQuery ${jq}`, detail: `jQuery ${jq} is loaded; versions before 3.x are no longer maintained and have known security advisories.`, evidence: [{ type: 'text', excerpt: `jQuery.fn.jquery = ${jq}` }], confidence: 'high', problemTags: ['maintenance'] });
  }
  const wpv = s.tech.wpVersion;
  if (wpv && Number(wpv.split('.')[0]) < 6) {
    out.push({ code: 'tech.old_wordpress', category: 'technical', polarity: 'negative', severity: 'medium', title: `WordPress ${wpv} (per generator tag)`, detail: `The generator meta tag reports WordPress ${wpv}; current major versions are 6.x. Outdated cores miss security fixes.`, evidence: [{ type: 'html', excerpt: s.meta.generator ?? '' }], confidence: 'medium', problemTags: ['maintenance', 'platform_wordpress'] });
  }
  if (s.meta.doctype && !/^html$/i.test(s.meta.doctype.trim())) {
    out.push({ code: 'visual.old_doctype', category: 'technical', polarity: 'negative', severity: 'low', title: 'Legacy document type', detail: `The page declares "${s.meta.doctype}" instead of the HTML5 doctype.`, evidence: [{ type: 'html', excerpt: `<!DOCTYPE ${s.meta.doctype}>` }], confidence: 'high', problemTags: ['outdated_design', 'maintenance'] });
  }
  return out.map(finalize);
}

// ───────────────────────── tech stack ─────────────────────────

export interface TechSummary {
  platform: string | null;
  platformTag: ProblemTag | null;
  libraries: string[];
  analytics: string[];
  websiteAgeSignal: { copyrightYear: number | null; lastModified: string | null };
}

export function techSummary(raw: AnalyzerRaw): TechSummary {
  const s = run(raw, 'desktop')?.snapshot;
  const t = s?.tech;
  const platforms: Array<[boolean | undefined, string, ProblemTag]> = [
    [t?.tilda, 'Tilda', 'platform_tilda'],
    [t?.webflow, 'Webflow', 'platform_webflow'],
    [t?.wix, 'Wix', 'platform_wix'],
    [t?.squarespace, 'Squarespace', 'platform_squarespace'],
    [t?.shopify, 'Shopify', 'platform_shopify'],
    [t?.bitrix, '1C-Bitrix', 'platform_bitrix'],
    [t?.joomla, 'Joomla', 'platform_joomla'],
    [t?.wordpress, 'WordPress', 'platform_wordpress'],
  ];
  const hit = platforms.find(([on]) => !!on);
  const libraries = [t?.jquery && `jQuery ${t.jquery}`, t?.nextjs && 'Next.js', t?.vue && 'Vue', t?.angular && 'Angular', t?.elementor && 'Elementor', t?.divi && 'Divi', t?.bootstrap && 'Bootstrap', t?.drupal && 'Drupal'].filter(Boolean) as string[];
  const analytics = [t?.gtm && 'Google Tag Manager', t?.ga && 'Google Analytics', t?.fbPixel && 'Meta Pixel'].filter(Boolean) as string[];
  const year = s?.copyrightYears.length ? Math.max(...s.copyrightYears) : null;
  return {
    platform: hit?.[1] ?? (s ? (t?.drupal ? 'Drupal' : 'Custom / unknown') : null),
    platformTag: hit?.[2] ?? (s ? 'platform_custom' : null),
    libraries,
    analytics,
    websiteAgeSignal: { copyrightYear: year, lastModified: raw.http.lastModified },
  };
}

export function platformFinding(raw: AnalyzerRaw): FindingDraft[] {
  const ts = techSummary(raw);
  if (!ts.platform || !ts.platformTag) return [];
  return [
    finalize({
      code: 'tech.platform',
      category: 'technical',
      polarity: 'neutral',
      severity: 'info',
      title: `Platform: ${ts.platform}`,
      detail: `Detected from page markup${ts.libraries.length ? `; libraries: ${ts.libraries.join(', ')}` : ''}${ts.analytics.length ? `; analytics: ${ts.analytics.join(', ')}` : ''}.`,
      evidence: [{ type: 'html', excerpt: [ts.platform, ...ts.libraries].join(', ') }],
      confidence: ts.platform === 'Custom / unknown' ? 'low' : 'high',
      problemTags: [ts.platformTag],
    }),
  ];
}

/** All deterministic findings for one analysis. */
export function buildFindings(raw: AnalyzerRaw, ctx: CheckContext = {}): FindingDraft[] {
  // We did not see the real site (bot protection / nothing loaded): conclude nothing about it.
  if (raw.status === 'blocked' || raw.status === 'failed') return [];
  if (raw.status === 'unreachable' || raw.status === 'robots_disallowed') return technicalFindings(raw);
  return [
    ...technicalFindings(raw),
    ...responsiveFindings(raw),
    ...performanceFindings(raw),
    ...seoFindings(raw),
    ...accessibilityFindings(raw),
    ...uxFindings(raw, ctx),
    ...visualSignalFindings(raw, ctx),
    ...platformFinding(raw),
  ];
}

function uniq<T>(a: T[]): T[] {
  return [...new Set(a)];
}
function uniqBy<T>(a: T[], k: (x: T) => string): T[] {
  const seen = new Set<string>();
  return a.filter((x) => {
    const key = k(x);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function safeHost(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
