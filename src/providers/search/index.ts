import { callProviderJson } from '../base.js';
import { classifyNonOfficialDomain, normalizeUrl, registrableDomain } from '../../lib/url.js';
import { mapLimit } from '../../lib/concurrency.js';
import type {
  BusinessLookup,
  BusinessQuery,
  ContactCandidate,
  LeadSourceAdapter,
  NormalizedBusiness,
  ProviderContext,
  SearchResultPage,
  WebResult,
  WebSearchProvider,
  WebsiteCandidate,
} from '../types.js';

/** Brave Search API — https://api.search.brave.com/app/documentation/web-search */
export class BraveSearchProvider implements WebSearchProvider {
  readonly id = 'brave_search';
  readonly name = 'Brave Search';
  readonly rateLimitPerSec = 1;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl: string,
  ) {}

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  configurationHint(): string {
    return 'Set BRAVE_SEARCH_API_KEY (Brave Search API subscription token).';
  }

  async search(query: string, opts: { count: number; language?: string; countryCode?: string }, ctx: ProviderContext): Promise<WebResult[]> {
    const params = new URLSearchParams({ q: query, count: String(Math.min(20, opts.count)), safesearch: 'moderate' });
    if (opts.countryCode) params.set('country', opts.countryCode.toLowerCase());
    if (opts.language) params.set('search_lang', opts.language);
    const data = await callProviderJson<{ web?: { results?: Array<{ url: string; title: string; description?: string }> } }>(
      this.id,
      this.rateLimitPerSec,
      `${this.baseUrl}/res/v1/web/search?${params}`,
      {
        headers: { 'X-Subscription-Token': this.apiKey ?? '', accept: 'application/json' },
        cache: { namespace: 'brave:web', parts: params.toString(), ttlHours: 24 * 3 },
      },
      ctx,
    );
    return (data.web?.results ?? []).map((r, i) => ({ url: r.url, title: stripTags(r.title), snippet: stripTags(r.description ?? ''), rank: i + 1 }));
  }
}

/** Google Programmable Search (Custom Search JSON API). */
export class GoogleCseProvider implements WebSearchProvider {
  readonly id = 'google_cse';
  readonly name = 'Google Programmable Search';
  readonly rateLimitPerSec = 1;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly cx: string | undefined,
    private readonly baseUrl: string,
  ) {}

  isConfigured(): boolean {
    return !!this.apiKey && !!this.cx;
  }

  configurationHint(): string {
    return 'Set GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX (Programmable Search Engine ID).';
  }

  async search(query: string, opts: { count: number; language?: string; countryCode?: string }, ctx: ProviderContext): Promise<WebResult[]> {
    const params = new URLSearchParams({ key: this.apiKey ?? '', cx: this.cx ?? '', q: query, num: String(Math.min(10, opts.count)) });
    if (opts.countryCode) params.set('gl', opts.countryCode.toLowerCase());
    if (opts.language) params.set('lr', `lang_${opts.language}`);
    const cacheParts = { q: query, n: opts.count, gl: opts.countryCode, lr: opts.language };
    const data = await callProviderJson<{ items?: Array<{ link: string; title: string; snippet?: string }> }>(
      this.id,
      this.rateLimitPerSec,
      `${this.baseUrl}/customsearch/v1?${params}`,
      { cache: { namespace: 'google_cse:web', parts: cacheParts, ttlHours: 24 * 3 } },
      ctx,
    );
    return (data.items ?? []).map((r, i) => ({ url: r.link, title: r.title, snippet: r.snippet ?? '', rank: i + 1 }));
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

/** Titles of listings, rankings and articles — never the name of one business. */
const LISTING_TITLE = /(\btop\s?\d+|\b\d+\s+(najlepsz|best|top|polecan|gabinet|firm|klinik|dentyst|salon)|ranking|zestawienie|katalog|baza firm|lista\b|list of|\bbest\b.*\bin\b|najlepsi|najlepsze|polecani|polecane|opinie o|ceny i opinie|near me|w pobliżu|artyku|blog|news|poradnik|jak wybrać|how to choose|directory|find a |szukaj|wyszukiwarka|ogłoszeni|praca\b|oferty pracy)/i;
const GENERIC_SEGMENT = /^(home|strona główna|startseite|accueil|inicio|главная|головна|welcome|witamy|kontakt|contact|o nas|about us|oferta|offer|services|usługi)$/i;

/**
 * "Smile Dental – Dentysta Warszawa | Implanty" → "Smile Dental".
 * Returns null when the title looks like a listing, ranking or article rather than one business.
 */
export function businessNameFromTitle(title: string): string | null {
  if (LISTING_TITLE.test(title)) return null;
  const parts = title
    .split(/\s[|–—\-:·•]\s|\s\|\s?|\|/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2 && p.length <= 80);
  if (parts.length === 0) return title.trim().slice(0, 80) || null;
  const candidates = parts.filter((p) => !GENERIC_SEGMENT.test(p));
  const name = (candidates.sort((a, b) => a.length - b.length)[0] ?? parts[0]!).slice(0, 80);
  return /^\d+$/.test(name) ? null : name;
}

/** A business's own homepage ranks at "/" or one level down ("/kontakt"); deep URLs are articles/listings. */
function looksLikeHomepage(url: string): boolean {
  const u = new URL(url);
  const depth = u.pathname.split('/').filter(Boolean).length;
  return depth <= 1 && !/(blog|news|artykul|article|ranking|katalog|lista|oferty|ogloszenia|search|szukaj)/i.test(u.pathname);
}

/**
 * Web discovery adapter: turns web-search results into (low-confidence) business records
 * and official-website candidates. Directory/social/review domains are filtered out.
 */
export class WebDiscoveryAdapter implements LeadSourceAdapter {
  readonly id = 'web_search';
  readonly name = 'Web Search';
  readonly category = 'search' as const;
  readonly capabilities = { search: true, details: false, website: true, contacts: false };
  readonly rateLimitPerSec = 1;
  readonly queryMode = 'text' as const;
  readonly dataPolicy = { retentionHours: 24 * 30, notes: 'Search result snippets are used only to locate official websites.' };

  constructor(private readonly engines: WebSearchProvider[]) {}

  isConfigured(): boolean {
    return this.engines.some((e) => e.isConfigured());
  }

  configurationHint(): string {
    return 'Configure a web search API: BRAVE_SEARCH_API_KEY or GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX.';
  }

  private get engine(): WebSearchProvider | undefined {
    return this.engines.find((e) => e.isConfigured());
  }

  async searchBusinesses(q: BusinessQuery, ctx: ProviderContext): Promise<SearchResultPage> {
    const engine = this.engine;
    if (!engine) return { items: [], calls: 0 };
    const results = await engine.search(q.text, { count: 20, language: q.language, countryCode: q.countryCode }, ctx);
    const items: NormalizedBusiness[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      const url = normalizeUrl(r.url);
      const domain = registrableDomain(url);
      if (!url || !domain || seen.has(domain)) continue;
      if (classifyNonOfficialDomain(url) || !looksLikeHomepage(url)) continue;
      const name = businessNameFromTitle(r.title);
      if (!name) continue;
      seen.add(domain);
      const origin = new URL(url).origin;
      items.push({
        provider: this.id,
        providerRecordId: domain,
        name,
        categories: [q.term],
        city: q.city,
        country: q.countryCode ?? q.country,
        website: origin,
        raw: { title: r.title, snippet: r.snippet, url: r.url, engine: engine.id, rank: r.rank, nameConfidence: 'low' },
        fetchedAt: new Date(),
      });
    }
    return { items, calls: 1, note: engine.name };
  }

  async getBusinessDetails(): Promise<NormalizedBusiness | null> {
    return null;
  }

  async findWebsite(b: BusinessLookup, ctx: ProviderContext): Promise<WebsiteCandidate[]> {
    const engine = this.engine;
    if (!engine) return [];
    const query = `"${b.name.replace(/"/g, '')}" ${b.city ?? ''}`.trim();
    const results = await engine.search(query, { count: 8 }, ctx);
    return results
      .filter((r) => normalizeUrl(r.url) && !classifyNonOfficialDomain(r.url) && !LISTING_TITLE.test(r.title))
      .slice(0, 5)
      .map((r) => ({
        url: new URL(normalizeUrl(r.url)!).origin,
        source: this.id,
        sourceUrl: r.url,
        evidence: `web search (${engine.name}) result #${r.rank} for ${query}`,
        rank: r.rank,
        title: r.title,
        snippet: r.snippet,
      }));
  }

  async findPublicContacts(): Promise<ContactCandidate[]> {
    return [];
  }

  /** Batch website lookup with bounded concurrency. */
  async findWebsites(lookups: BusinessLookup[], ctx: ProviderContext, concurrency = 2): Promise<Map<number, WebsiteCandidate[]>> {
    const res = await mapLimit(lookups, concurrency, (l) => this.findWebsite(l, ctx), ctx.signal);
    const out = new Map<number, WebsiteCandidate[]>();
    res.forEach((r, i) => out.set(i, r.ok ? r.value : []));
    return out;
  }
}

