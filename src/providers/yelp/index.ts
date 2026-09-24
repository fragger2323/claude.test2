import { callProviderJson } from '../base.js';
import type {
  BusinessLookup,
  BusinessQuery,
  ContactCandidate,
  LeadSourceAdapter,
  NormalizedBusiness,
  ProviderContext,
  SearchResultPage,
  WebsiteCandidate,
} from '../types.js';

/**
 * Yelp Fusion API (Places). Note: Yelp's `url` is the Yelp listing, NOT the company website,
 * so this adapter never provides website candidates.
 */
interface YelpBusiness {
  id: string;
  name: string;
  url?: string;
  phone?: string;
  display_phone?: string;
  is_closed?: boolean;
  rating?: number;
  review_count?: number;
  price?: string;
  categories?: Array<{ alias: string; title: string }>;
  coordinates?: { latitude?: number; longitude?: number };
  location?: { address1?: string; city?: string; zip_code?: string; country?: string; state?: string; display_address?: string[] };
}

export function normalizeYelpBusiness(b: YelpBusiness, fetchedAt = new Date()): NormalizedBusiness {
  return {
    provider: 'yelp',
    providerRecordId: b.id,
    name: b.name,
    categories: (b.categories ?? []).map((c) => c.title),
    address: b.location?.display_address?.join(', '),
    street: b.location?.address1 ?? undefined,
    city: b.location?.city,
    postalCode: b.location?.zip_code,
    region: b.location?.state,
    country: b.location?.country,
    lat: b.coordinates?.latitude ?? undefined,
    lng: b.coordinates?.longitude ?? undefined,
    phone: b.phone || undefined,
    profileUrl: b.url?.split('?')[0],
    businessStatus: b.is_closed ? 'closed_permanently' : 'unknown',
    rating: b.rating,
    ratingCount: b.review_count,
    priceLevel: b.price ? b.price.length : undefined,
    fetchedAt,
  };
}

export class YelpAdapter implements LeadSourceAdapter {
  readonly id = 'yelp';
  readonly name = 'Yelp Places';
  readonly category = 'places' as const;
  readonly capabilities = { search: true, details: true, website: false, contacts: true };
  readonly rateLimitPerSec = 5;
  readonly queryMode = 'text' as const;
  readonly dataPolicy = {
    retentionHours: 24,
    attribution: 'Yelp',
    notes: 'Yelp API terms allow storing business IDs; other content must not be cached longer than 24 hours.',
  };

  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl: string,
  ) {}

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  configurationHint(): string {
    return 'Set YELP_API_KEY (Yelp Fusion / Places API key). Coverage varies by country.';
  }

  async searchBusinesses(q: BusinessQuery, ctx: ProviderContext): Promise<SearchResultPage> {
    const items: NormalizedBusiness[] = [];
    let calls = 0;
    const pageSize = 50;
    const pages = Math.min(2, Math.ceil(q.limit / pageSize));
    for (let page = 0; page < pages; page++) {
      const params = new URLSearchParams({ term: q.segment ? `${q.term} ${q.segment}` : q.term, limit: String(pageSize), offset: String(page * pageSize) });
      if (q.area) {
        params.set('latitude', String(q.area.lat));
        params.set('longitude', String(q.area.lng));
        params.set('radius', String(Math.min(40_000, (q.radiusKm ?? 15) * 1000)));
      } else {
        params.set('location', [q.city, q.country].filter(Boolean).join(', '));
      }
      const data = await callProviderJson<{ businesses?: YelpBusiness[]; total?: number }>(
        this.id,
        this.rateLimitPerSec,
        `${this.baseUrl}/v3/businesses/search?${params}`,
        {
          headers: { Authorization: `Bearer ${this.apiKey ?? ''}`, accept: 'application/json' },
          // Yelp content may not be cached > 24h
          cache: { namespace: 'yelp:search', parts: params.toString(), ttlHours: 12 },
          retryStatuses: [429, 500, 502, 503, 504],
        },
        ctx,
      );
      calls++;
      for (const b of data.businesses ?? []) items.push(normalizeYelpBusiness(b));
      if ((data.businesses?.length ?? 0) < pageSize) break;
    }
    return { items, calls };
  }

  async getBusinessDetails(id: string, ctx: ProviderContext): Promise<NormalizedBusiness | null> {
    if (!/^[\w-]+$/.test(id)) return null;
    const b = await callProviderJson<YelpBusiness>(
      this.id,
      this.rateLimitPerSec,
      `${this.baseUrl}/v3/businesses/${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${this.apiKey ?? ''}` }, cache: { namespace: 'yelp:details', parts: { id }, ttlHours: 12 } },
      ctx,
    );
    return b?.id ? normalizeYelpBusiness(b) : null;
  }

  async findWebsite(): Promise<WebsiteCandidate[]> {
    return [];
  }

  async findPublicContacts(b: BusinessLookup, ctx: ProviderContext): Promise<ContactCandidate[]> {
    const ref = b.providerRefs.find((r) => r.provider === this.id);
    if (!ref) return [];
    const d = await this.getBusinessDetails(ref.id, ctx);
    return d?.phone ? [{ type: 'phone', value: d.phone, source: this.id, sourceUrl: d.profileUrl }] : [];
  }
}
