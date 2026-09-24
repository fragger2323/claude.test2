import { callProviderJson } from '../base.js';
import type {
  BusinessLookup,
  BusinessQuery,
  BusinessStatus,
  ContactCandidate,
  LeadSourceAdapter,
  NormalizedBusiness,
  ProviderContext,
  SearchResultPage,
  WebsiteCandidate,
} from '../types.js';

/**
 * Google Places API (New) — Text Search + Place Details.
 * Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
 * Requesting phone/website fields bills the Enterprise SKU; see docs/providers.md.
 */
interface GPlace {
  id: string;
  displayName?: { text: string; languageCode?: string };
  formattedAddress?: string;
  addressComponents?: Array<{ longText: string; shortText: string; types: string[] }>;
  location?: { latitude: number; longitude: number };
  types?: string[];
  primaryType?: string;
  primaryTypeDisplayName?: { text: string };
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  businessStatus?: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  googleMapsUri?: string;
}

const FIELDS = [
  'id',
  'displayName',
  'formattedAddress',
  'addressComponents',
  'location',
  'types',
  'primaryType',
  'primaryTypeDisplayName',
  'nationalPhoneNumber',
  'internationalPhoneNumber',
  'websiteUri',
  'businessStatus',
  'rating',
  'userRatingCount',
  'priceLevel',
  'googleMapsUri',
];

const PRICE: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

const STATUS: Record<string, BusinessStatus> = {
  OPERATIONAL: 'operational',
  CLOSED_TEMPORARILY: 'closed_temporarily',
  CLOSED_PERMANENTLY: 'closed_permanently',
};

function component(p: GPlace, type: string): string | undefined {
  return p.addressComponents?.find((c) => c.types.includes(type))?.longText;
}

export function normalizeGooglePlace(p: GPlace, fetchedAt = new Date()): NormalizedBusiness {
  const street = [component(p, 'route'), component(p, 'street_number')].filter(Boolean).join(' ') || undefined;
  return {
    provider: 'google_places',
    providerRecordId: p.id,
    name: p.displayName?.text ?? '(unnamed)',
    categories: [p.primaryTypeDisplayName?.text, ...(p.types ?? [])].filter((x): x is string => !!x && x !== 'point_of_interest' && x !== 'establishment'),
    address: p.formattedAddress,
    street,
    city: component(p, 'locality') ?? component(p, 'postal_town'),
    postalCode: component(p, 'postal_code'),
    region: component(p, 'administrative_area_level_1'),
    country: p.addressComponents?.find((c) => c.types.includes('country'))?.shortText,
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber,
    website: p.websiteUri,
    profileUrl: p.googleMapsUri,
    businessStatus: p.businessStatus ? STATUS[p.businessStatus] ?? 'unknown' : 'unknown',
    rating: p.rating,
    ratingCount: p.userRatingCount,
    priceLevel: p.priceLevel ? PRICE[p.priceLevel] : undefined,
    raw: { primaryType: p.primaryType },
    fetchedAt,
  };
}

export class GooglePlacesAdapter implements LeadSourceAdapter {
  readonly id = 'google_places';
  readonly name = 'Google Places';
  readonly category = 'places' as const;
  readonly capabilities = { search: true, details: true, website: true, contacts: true };
  readonly rateLimitPerSec = 5;
  readonly queryMode = 'text' as const;
  readonly dataPolicy = {
    retentionHours: 24 * 30,
    attribution: 'Google Maps',
    notes:
      'Google Maps Platform terms restrict caching of Places content (place IDs may be stored indefinitely; lat/lng up to 30 days). Raw content is purged after the retention window; the official website is used as the durable source of truth.',
  };

  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl: string,
  ) {}

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  configurationHint(): string {
    return 'Set GOOGLE_PLACES_API_KEY (Google Cloud project with "Places API (New)" enabled and billing).';
  }

  async searchBusinesses(q: BusinessQuery, ctx: ProviderContext): Promise<SearchResultPage> {
    const items: NormalizedBusiness[] = [];
    let pageToken: string | undefined;
    let calls = 0;
    const maxPages = Math.min(3, Math.ceil(q.limit / 20));
    for (let page = 0; page < maxPages; page++) {
      const body: Record<string, unknown> = {
        textQuery: q.text,
        languageCode: q.language,
        pageSize: 20,
      };
      if (q.countryCode) body.regionCode = q.countryCode.toLowerCase();
      if (q.area) {
        body.locationBias = {
          circle: { center: { latitude: q.area.lat, longitude: q.area.lng }, radius: Math.min(50_000, (q.radiusKm ?? 15) * 1000) },
        };
      }
      if (pageToken) body.pageToken = pageToken;
      const data = await callProviderJson<{ places?: GPlace[]; nextPageToken?: string }>(
        this.id,
        this.rateLimitPerSec,
        `${this.baseUrl}/v1/places:searchText`,
        {
          method: 'POST',
          json: body,
          headers: {
            'X-Goog-Api-Key': this.apiKey ?? '',
            'X-Goog-FieldMask': [...FIELDS.map((f) => `places.${f}`), 'nextPageToken'].join(','),
          },
          timeoutMs: 20_000,
          cache: { namespace: 'google_places:search', parts: body, ttlHours: 12 },
        },
        ctx,
      );
      calls++;
      for (const p of data.places ?? []) items.push(normalizeGooglePlace(p));
      pageToken = data.nextPageToken;
      if (!pageToken || items.length >= q.limit) break;
    }
    return { items, calls };
  }

  async getBusinessDetails(id: string, ctx: ProviderContext): Promise<NormalizedBusiness | null> {
    if (!/^[\w-]+$/.test(id)) return null;
    const p = await callProviderJson<GPlace>(
      this.id,
      this.rateLimitPerSec,
      `${this.baseUrl}/v1/places/${encodeURIComponent(id)}`,
      {
        headers: { 'X-Goog-Api-Key': this.apiKey ?? '', 'X-Goog-FieldMask': FIELDS.join(',') },
        cache: { namespace: 'google_places:details', parts: { id }, ttlHours: 12 },
      },
      ctx,
    );
    return p?.id ? normalizeGooglePlace(p) : null;
  }

  async findWebsite(b: BusinessLookup, ctx: ProviderContext): Promise<WebsiteCandidate[]> {
    const ref = b.providerRefs.find((r) => r.provider === this.id);
    if (!ref) return [];
    const d = await this.getBusinessDetails(ref.id, ctx);
    return d?.website ? [{ url: d.website, source: this.id, sourceUrl: d.profileUrl, evidence: 'websiteUri on the Google Places listing' }] : [];
  }

  async findPublicContacts(b: BusinessLookup, ctx: ProviderContext): Promise<ContactCandidate[]> {
    const ref = b.providerRefs.find((r) => r.provider === this.id);
    if (!ref) return [];
    const d = await this.getBusinessDetails(ref.id, ctx);
    return d?.phone ? [{ type: 'phone', value: d.phone, source: this.id, sourceUrl: d.profileUrl }] : [];
  }
}
