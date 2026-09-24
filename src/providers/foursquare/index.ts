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
 * Foursquare Places API. Supports the current endpoint (places-api.foursquare.com,
 * Bearer service key + X-Places-Api-Version) and the legacy v3 endpoint (api.foursquare.com/v3).
 */
interface FsqPlace {
  fsq_place_id?: string;
  fsq_id?: string;
  name: string;
  latitude?: number;
  longitude?: number;
  geocodes?: { main?: { latitude: number; longitude: number } };
  location?: {
    address?: string;
    locality?: string;
    postcode?: string;
    region?: string;
    country?: string;
    formatted_address?: string;
  };
  categories?: Array<{ name: string }>;
  tel?: string;
  website?: string;
  email?: string;
  social_media?: { facebook_id?: string; instagram?: string; twitter?: string };
  date_closed?: string;
  closed_bucket?: string;
  link?: string;
  rating?: number;
  stats?: { total_ratings?: number };
  price?: number;
}

const FIELDS = 'fsq_place_id,fsq_id,name,latitude,longitude,geocodes,location,categories,tel,website,email,social_media,date_closed,closed_bucket,link,rating,stats,price';

export function normalizeFoursquarePlace(p: FsqPlace, fetchedAt = new Date()): NormalizedBusiness | null {
  const id = p.fsq_place_id ?? p.fsq_id;
  if (!id || !p.name) return null;
  const socials: Array<{ network: string; url: string }> = [];
  if (p.social_media?.instagram) socials.push({ network: 'instagram', url: `https://www.instagram.com/${p.social_media.instagram.replace(/^@/, '')}` });
  if (p.social_media?.facebook_id) socials.push({ network: 'facebook', url: `https://www.facebook.com/${p.social_media.facebook_id}` });
  const closed = !!p.date_closed || p.closed_bucket === 'VeryLikelyClosed';
  return {
    provider: 'foursquare',
    providerRecordId: id,
    name: p.name,
    categories: (p.categories ?? []).map((c) => c.name),
    address: p.location?.formatted_address,
    street: p.location?.address,
    city: p.location?.locality,
    postalCode: p.location?.postcode,
    region: p.location?.region,
    country: p.location?.country,
    lat: p.latitude ?? p.geocodes?.main?.latitude,
    lng: p.longitude ?? p.geocodes?.main?.longitude,
    phone: p.tel,
    website: p.website,
    email: p.email,
    socials,
    businessStatus: closed ? 'closed_permanently' : 'unknown',
    rating: p.rating != null ? p.rating / 2 : undefined,
    ratingCount: p.stats?.total_ratings,
    priceLevel: p.price,
    fetchedAt,
  };
}

export class FoursquareAdapter implements LeadSourceAdapter {
  readonly id = 'foursquare';
  readonly name = 'Foursquare Places';
  readonly category = 'places' as const;
  readonly capabilities = { search: true, details: true, website: true, contacts: true };
  readonly rateLimitPerSec = 10;
  readonly queryMode = 'text' as const;
  readonly dataPolicy = {
    retentionHours: 24 * 30,
    attribution: 'Foursquare',
    notes: 'Review your Foursquare plan terms for storage limits; raw content is purged after the retention window.',
  };

  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl: string,
    private readonly apiVersion: string,
  ) {}

  private get legacy(): boolean {
    return /api\.foursquare\.com/.test(this.baseUrl);
  }

  private headers(): Record<string, string> {
    return this.legacy
      ? { Authorization: this.apiKey ?? '', accept: 'application/json' }
      : { Authorization: `Bearer ${this.apiKey ?? ''}`, 'X-Places-Api-Version': this.apiVersion, accept: 'application/json' };
  }

  private path(p: string): string {
    return this.legacy ? `${this.baseUrl}/v3/places${p}` : `${this.baseUrl}/places${p}`;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  configurationHint(): string {
    return 'Set FOURSQUARE_API_KEY (Foursquare developer console → Service API key).';
  }

  async searchBusinesses(q: BusinessQuery, ctx: ProviderContext): Promise<SearchResultPage> {
    const params = new URLSearchParams({ query: q.term, limit: String(Math.min(50, q.limit)), fields: FIELDS });
    if (q.area) {
      params.set('ll', `${q.area.lat},${q.area.lng}`);
      params.set('radius', String(Math.min(100_000, (q.radiusKm ?? 15) * 1000)));
    } else {
      params.set('near', [q.segment, q.city, q.country].filter(Boolean).join(', '));
    }
    if (q.segment && q.area) params.set('query', `${q.term} ${q.segment}`);
    const data = await callProviderJson<{ results?: FsqPlace[] }>(
      this.id,
      this.rateLimitPerSec,
      `${this.path('/search')}?${params}`,
      { headers: this.headers(), cache: { namespace: 'foursquare:search', parts: params.toString(), ttlHours: 24 } },
      ctx,
    );
    const items = (data.results ?? []).map((p) => normalizeFoursquarePlace(p)).filter((x): x is NormalizedBusiness => !!x);
    return { items, calls: 1 };
  }

  async getBusinessDetails(id: string, ctx: ProviderContext): Promise<NormalizedBusiness | null> {
    if (!/^[\w-]+$/.test(id)) return null;
    const p = await callProviderJson<FsqPlace>(
      this.id,
      this.rateLimitPerSec,
      `${this.path(`/${encodeURIComponent(id)}`)}?fields=${FIELDS}`,
      { headers: this.headers(), cache: { namespace: 'foursquare:details', parts: { id }, ttlHours: 24 } },
      ctx,
    );
    return normalizeFoursquarePlace(p);
  }

  async findWebsite(b: BusinessLookup, ctx: ProviderContext): Promise<WebsiteCandidate[]> {
    const ref = b.providerRefs.find((r) => r.provider === this.id);
    if (!ref) return [];
    const d = await this.getBusinessDetails(ref.id, ctx);
    return d?.website ? [{ url: d.website, source: this.id, evidence: 'website field on the Foursquare place' }] : [];
  }

  async findPublicContacts(b: BusinessLookup, ctx: ProviderContext): Promise<ContactCandidate[]> {
    const ref = b.providerRefs.find((r) => r.provider === this.id);
    if (!ref) return [];
    const d = await this.getBusinessDetails(ref.id, ctx);
    if (!d) return [];
    const out: ContactCandidate[] = [];
    if (d.phone) out.push({ type: 'phone', value: d.phone, source: this.id });
    if (d.email) out.push({ type: 'email', value: d.email, source: this.id });
    for (const s of d.socials ?? []) out.push({ type: 'social', subtype: s.network, value: s.url, source: this.id });
    return out;
  }
}
