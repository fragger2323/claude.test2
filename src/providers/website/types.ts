import type { Viewport } from '../../domain/types.js';

/** Shape returned by COLLECT_SCRIPT (see page-scripts.ts). */
export interface PageSnapshot {
  url: string;
  viewport: { width: number; height: number };
  meta: {
    title: string;
    description: string | null;
    canonical: string | null;
    robots: string | null;
    viewport: string | null;
    lang: string | null;
    generator: string | null;
    ogTitle: string | null;
    ogDescription: string | null;
    ogImage: string | null;
    twitterCard: string | null;
    favicon: boolean;
    hreflangs: number;
    charset: string;
    doctype: string | null;
  };
  headings: Array<{ level: number; text: string; visible: boolean; top: number }>;
  ld: { types: string[]; invalid: number; phones: string[]; emails: string[]; microdata: number };
  links: Array<{ href: string; text: string; inNav: boolean; inFooter: boolean; visible: boolean; top: number; internal: boolean }>;
  images: Array<{
    src: string;
    alt: string | null;
    hasAlt: boolean;
    decorative: boolean;
    naturalWidth: number;
    naturalHeight: number;
    width: number;
    height: number;
    loading: string | null;
    visible: boolean;
    aboveFold: boolean;
  }>;
  forms: Array<{
    action: string | null;
    method: string;
    visible: boolean;
    fieldCount: number;
    unlabeled: number;
    placeholderOnly: number;
    hasEmail: boolean;
    hasTextarea: boolean;
    hasPhone: boolean;
    isSearch: boolean;
    hasSubmit: boolean;
    captcha: boolean;
  }>;
  unlabeledInputs: number;
  clickableCount: number;
  unnamed: number;
  unnamedExamples: string[];
  ctas: Array<{ text: string; top: number; left: number; width: number; height: number; buttonLike: boolean; inFirstViewport: boolean; tel: boolean; fontSize: number; inNav: boolean }>;
  tapSmall: Array<{ path: string; w: number; h: number; text: string }>;
  tapChecked: number;
  telLinks: Array<{ href: string; visible: boolean; inHeader: boolean }>;
  mailtoLinks: string[];
  nav: { hasNav: boolean; hasHeader: boolean; navLinks: number; visibleNavLinks: number; toggles: Array<{ id: number; path: string; expanded: string | null }> };
  landmarks: { header: number; nav: number; main: number; footer: number };
  legacy: { font: number; center: number; marquee: number; frames: number; flash: number; layoutTables: number; inlineStyles: number };
  ariaHiddenFocusable: number;
  brokenAriaRefs: number;
  bodyText: string;
  wordCount: number;
  footerText: string;
  copyrightYears: number[];
  trustSignals: string[];
  trustWidgets: number;
  firstScreen: { h1InFirstScreen: boolean; headingInFirstScreen: boolean; text: string };
  h1Count: number;
  scroll: { scrollWidth: number; clientWidth: number; overflowHidden: boolean; overflowEls: Array<{ path: string; right: number; width: number }> };
  text: { textEls: number; smallText: number };
  contrast: { sampled: number; failing: number; unknown: number; examples: Array<{ text: string; ratio: number; required: number; fg: string; bg: string; path: string }> };
  overlaps: Array<{ a: string; b: string; pathA: string; pathB: string; ratio: number }>;
  fixedHeader: { height: number; path: string } | null;
  overlays: Array<{ path: string; cover: number; cookie: boolean; text: string }>;
  scripts: Array<{ src: string | null; async: boolean; defer: boolean; module: boolean; inHead: boolean; inlineSize: number }>;
  stylesheets: Array<{ href: string; media: string; inHead: boolean }>;
  fonts: string[];
  animations: { total: number; infinite: number };
  tech: {
    wordpress: boolean;
    wpVersion: string | null;
    tilda: boolean;
    webflow: boolean;
    wix: boolean;
    squarespace: boolean;
    shopify: boolean;
    bitrix: boolean;
    joomla: boolean;
    drupal: boolean;
    jquery: string | null;
    nextjs: boolean;
    vue: boolean;
    angular: boolean;
    elementor: boolean;
    divi: boolean;
    bootstrap: boolean;
    gtm: boolean;
    ga: boolean;
    fbPixel: boolean;
  };
  socialLinks: string[];
  perf: {
    ttfb: number | null;
    domContentLoaded: number | null;
    load: number | null;
    documentTransfer: number | null;
    lcp: number | null;
    lcpElement: string | null;
    cls: number | null;
    clsSources: Array<{ value: number; sources: Array<string | null> }>;
    longTasks: number | null;
    longTaskTime: number | null;
    scrollHeight: number;
  };
  resources: Array<{ name: string; type: string; transfer: number; encoded: number; decoded: number; duration: number; blocking: string | null }>;
}

export interface NetworkEntry {
  url: string;
  type: string;
  status: number;
  bytes: number;
  contentType: string;
  thirdParty: boolean;
}

export interface ScreenshotFile {
  key: string;
  viewport: Viewport;
  kind: 'viewport' | 'fullpage';
  pageUrl: string;
  path: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export interface FocusStop {
  tag: string;
  text: string;
  indicator: boolean;
  onScreen: boolean;
  href: string;
}

export interface ViewportRun {
  viewport: Viewport;
  ok: boolean;
  error?: string;
  mainStatus?: number;
  finalUrl?: string;
  snapshot?: PageSnapshot;
  screenshots: ScreenshotFile[];
  consoleErrors: string[];
  jsErrors: string[];
  failedRequests: Array<{ url: string; error: string; type: string }>;
  badResponses: Array<{ url: string; status: number; type: string }>;
  network: NetworkEntry[];
  blockedRequests: string[];
  /** Bot-protection / challenge page instead of the site. */
  blocked?: boolean;
  /** The page stopped responding (main thread busy) or hit the hard deadline. */
  unresponsive?: boolean;
  mobileMenu?: { toggleFound: boolean; linksBefore: number; linksAfter: number | null; error?: string };
  focusStops?: FocusStop[];
  durationMs: number;
}

export interface PageVisit {
  url: string;
  kind: 'contact' | 'services' | 'about' | 'pricing' | 'other';
  ok: boolean;
  status?: number;
  error?: string;
  snapshot?: PageSnapshot;
  consoleErrors: string[];
  jsErrors: string[];
}

export interface HttpChecks {
  inputUrl: string;
  httpsOk: boolean;
  httpsError?: string;
  /** timeout/aborted = unknown, not proof that HTTPS is missing */
  httpsErrorCode?: string;
  httpRedirectsToHttps: boolean | null;
  redirectChain: Array<{ url: string; status: number }>;
  homepageStatus: number | null;
  finalUrl: string | null;
  headers: Record<string, string>;
  hsts: boolean;
  compressed: boolean | null;
  htmlBytes: number | null;
  robots: { found: boolean; disallowAll: boolean; sitemaps: string[] };
  sitemap: { found: boolean; url: string | null; urlCount: number | null };
  soft404: boolean | null;
  /** The homepage response looks like a bot-protection / challenge page. */
  challenge: boolean;
  lastModified: string | null;
}

export interface LinkCheck {
  url: string;
  internal: boolean;
  status?: number;
  error?: string;
  broken: boolean;
  unverifiable: boolean;
  foundOn: string;
}

export interface AnalyzerRaw {
  url: string;
  finalUrl: string | null;
  status: 'completed' | 'partial' | 'unreachable' | 'robots_disallowed' | 'blocked' | 'failed';
  runs: Partial<Record<Viewport, ViewportRun>>;
  pages: PageVisit[];
  http: HttpChecks;
  links: LinkCheck[];
  errors: string[];
  startedAt: string;
  finishedAt: string;
  analyzerVersion: number;
}
