import { callProviderJson } from '../base.js';
import { NICHES } from '../../domain/taxonomy.js';
import type {
  BusinessLookup,
  BusinessQuery,
  ContactCandidate,
  GeoArea,
  GeoProvider,
  LeadSourceAdapter,
  NormalizedBusiness,
  ProviderContext,
  SearchResultPage,
  WebsiteCandidate,
} from '../types.js';

/**
 * OpenStreetMap via Nominatim (geocoding) and Overpass (POI queries).
 * Free and keyless, ODbL-licensed (attribution "© OpenStreetMap contributors").
 * Usage policies: identify the app (User-Agent / email) and keep request rates low.
 */
interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  /** last edit (from `out meta`); the contributor fields that come with it are ignored */
  timestamp?: string;
}

const CATEGORY_KEYS = ['amenity', 'shop', 'office', 'craft', 'healthcare', 'tourism', 'leisure'];

function first(v: string | undefined): string | undefined {
  return v?.split(';')[0]?.trim() || undefined;
}

export function normalizeOsmElement(el: OverpassElement, fetchedAt = new Date()): NormalizedBusiness | null {
  const t = el.tags ?? {};
  const name = t.name ?? t['name:en'] ?? t.brand;
  if (!name) return null;
  const street = [t['addr:street'] ?? t['addr:place'], t['addr:housenumber']].filter(Boolean).join(' ') || undefined;
  const cityLine = [t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ');
  const socials: Array<{ network: string; url: string }> = [];
  for (const [k, net] of [
    ['contact:facebook', 'facebook'],
    ['facebook', 'facebook'],
    ['contact:instagram', 'instagram'],
    ['instagram', 'instagram'],
    ['contact:linkedin', 'linkedin'],
  ] as const) {
    const v = first(t[k]);
    if (v && /^https?:\/\//.test(v)) socials.push({ network: net, url: v });
  }
  const disused = Object.keys(t).some((k) => /^(disused|was|abandoned):/.test(k));
  return {
    provider: 'osm',
    providerRecordId: `${el.type}/${el.id}`,
    name,
    categories: CATEGORY_KEYS.filter((k) => t[k]).map((k) => `${k}=${t[k]}`),
    address: [street, cityLine].filter(Boolean).join(', ') || undefined,
    street,
    city: t['addr:city'],
    postalCode: t['addr:postcode'],
    country: t['addr:country'],
    lat: el.lat ?? el.center?.lat,
    lng: el.lon ?? el.center?.lon,
    phone: first(t.phone ?? t['contact:phone'] ?? t['contact:mobile']),
    website: first(t.website ?? t['contact:website'] ?? t.url),
    email: first(t.email ?? t['contact:email']),
    profileUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    socials,
    businessStatus: disused ? 'closed_permanently' : 'unknown',
    raw: { opening_hours: t.opening_hours, operator: t.operator, brand: t.brand },
    fetchedAt,
    sourceUpdatedAt: el.timestamp && Number.isFinite(Date.parse(el.timestamp)) ? new Date(el.timestamp) : undefined,
  };
}

function areaFilter(area: GeoArea, radiusKm?: number): { header: string; filter: string } {
  if (area.osmType === 'relation' && area.osmId) return { header: `area(id:${3_600_000_000 + area.osmId})->.a;`, filter: '(area.a)' };
  if (area.osmType === 'way' && area.osmId) return { header: `area(id:${2_400_000_000 + area.osmId})->.a;`, filter: '(area.a)' };
  if (area.bbox) {
    const [s, w, n, e] = area.bbox;
    return { header: '', filter: `(${s},${w},${n},${e})` };
  }
  return { header: '', filter: `(around:${Math.round((radiusKm ?? 10) * 1000)},${area.lat},${area.lng})` };
}

function escapeOverpassRegex(s: string): string {
  return s.replace(/[\\"]/g, '').replace(/[.*+?^${}()|[\]]/g, '\\$&');
}

export function buildOverpassQuery(q: { nicheKey?: string; term: string; area: GeoArea; radiusKm?: number; limit: number }): string {
  const niche = NICHES.find((n) => n.key === q.nicheKey);
  const { header, filter } = areaFilter(q.area, q.radiusKm);
  const clauses: string[] = [];
  if (niche?.osm?.length) {
    for (const [k, v] of niche.osm) clauses.push(`nwr["${k}"="${v}"]${filter};`);
  } else {
    const rx = escapeOverpassRegex(q.term).slice(0, 60);
    for (const k of ['shop', 'office', 'amenity', 'craft', 'healthcare']) clauses.push(`nwr["name"~"${rx}",i]["${k}"]${filter};`);
  }
  // `meta` adds the last-edit timestamp (freshness); contributor names in it are never stored.
  return `[out:json][timeout:60];${header}(${clauses.join('')});out center meta ${Math.max(1, Math.min(2000, q.limit))};`;
}

export class OsmAdapter implements LeadSourceAdapter, GeoProvider {
  readonly id = 'osm';
  readonly name = 'OpenStreetMap';
  readonly category = 'places' as const;
  readonly capabilities = { search: true, details: false, website: true, contacts: true };
  readonly rateLimitPerSec = 0.5;
  readonly queryMode = 'structured' as const;
  readonly dataPolicy = {
    retentionHours: null,
    attribution: '© OpenStreetMap contributors (ODbL)',
    notes: 'Open data (ODbL). Attribution required; share-alike applies only if you publish a derived database.',
  };

  constructor(
    private readonly enabled: boolean,
    private readonly nominatimUrl: string,
    private readonly overpassUrl: string,
    private readonly contactEmail?: string,
  ) {}

  isConfigured(): boolean {
    return this.enabled;
  }

  configurationHint(): string {
    return 'Enabled by default (no key). Set OSM_CONTACT_EMAIL to identify yourself per the Nominatim usage policy.';
  }

  async geocode(location: string, country: string, ctx: ProviderContext): Promise<GeoArea | null> {
    const params = new URLSearchParams({ format: 'jsonv2', limit: '1', addressdetails: '1', q: `${location}, ${country}` });
    if (this.contactEmail) params.set('email', this.contactEmail);
    const rows = await callProviderJson<Array<{ osm_type: string; osm_id: number; lat: string; lon: string; boundingbox?: string[]; display_name: string; address?: Record<string, string> }>>(
      'nominatim',
      1,
      `${this.nominatimUrl}/search?${params}`,
      { cache: { namespace: 'nominatim:search', parts: params.toString(), ttlHours: 24 * 30 }, timeoutMs: 15_000 },
      ctx,
    );
    const r = rows[0];
    if (!r) return null;
    const bb = r.boundingbox?.map(Number);
    return {
      displayName: r.display_name,
      city: r.address?.city ?? r.address?.town ?? r.address?.village ?? location,
      countryCode: r.address?.country_code?.toUpperCase(),
      lat: Number(r.lat),
      lng: Number(r.lon),
      bbox: bb && bb.length === 4 ? [bb[0]!, bb[2]!, bb[1]!, bb[3]!] : undefined,
      osmType: (['relation', 'way', 'node'].includes(r.osm_type) ? r.osm_type : undefined) as GeoArea['osmType'],
      osmId: r.osm_id,
      source: 'nominatim',
    };
  }

  async subdivisions(area: GeoArea, ctx: ProviderContext): Promise<string[]> {
    if (area.osmType !== 'relation' || !area.osmId) return [];
    const q = `[out:json][timeout:30];area(id:${3_600_000_000 + area.osmId})->.a;rel(area.a)["boundary"="administrative"]["admin_level"~"^(9|10)$"];out tags;`;
    const data = await callProviderJson<{ elements?: OverpassElement[] }>(
      this.id,
      this.rateLimitPerSec,
      `${this.overpassUrl}/interpreter`,
      {
        method: 'POST',
        body: new URLSearchParams({ data: q }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        timeoutMs: 45_000,
        cache: { namespace: 'overpass:subdivisions', parts: q, ttlHours: 24 * 30 },
      },
      ctx,
    );
    const byLevel = new Map<string, string[]>();
    for (const el of data.elements ?? []) {
      const lvl = el.tags?.admin_level ?? '';
      const name = el.tags?.name;
      if (!name) continue;
      byLevel.set(lvl, [...(byLevel.get(lvl) ?? []), name]);
    }
    // choose the level with a practical number of segments
    for (const lvl of ['9', '10']) {
      const names = byLevel.get(lvl) ?? [];
      if (names.length >= 3 && names.length <= 40) return [...new Set(names)];
    }
    return [];
  }

  async searchBusinesses(q: BusinessQuery, ctx: ProviderContext): Promise<SearchResultPage> {
    if (!q.area) return { items: [], calls: 0, note: 'no geocoded area' };
    const query = buildOverpassQuery({ nicheKey: q.nicheKey, term: q.term, area: q.area, radiusKm: q.radiusKm, limit: Math.max(q.limit * 3, 200) });
    const data = await callProviderJson<{ elements?: OverpassElement[] }>(
      this.id,
      this.rateLimitPerSec,
      `${this.overpassUrl}/interpreter`,
      {
        method: 'POST',
        body: new URLSearchParams({ data: query }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        timeoutMs: 90_000,
        retries: 2,
        cache: { namespace: 'overpass:pois', parts: query, ttlHours: 24 * 3 },
      },
      ctx,
    );
    const items = (data.elements ?? []).map((e) => normalizeOsmElement(e)).filter((x): x is NormalizedBusiness => !!x);
    return { items, calls: 1, note: 'OSM tag query' };
  }

  async getBusinessDetails(): Promise<NormalizedBusiness | null> {
    return null;
  }

  async findWebsite(): Promise<WebsiteCandidate[]> {
    return [];
  }

  async findPublicContacts(_b: BusinessLookup): Promise<ContactCandidate[]> {
    return [];
  }
}
