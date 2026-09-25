import type { Logger } from 'pino';
import type { z } from 'zod';

/**
 * Provider abstraction. Business logic depends only on these interfaces;
 * concrete APIs live in providers/<name>/ and are registered in providers/registry.ts.
 */

export type BusinessStatus = 'operational' | 'closed_temporarily' | 'closed_permanently' | 'unknown';

export interface NormalizedBusiness {
  provider: string;
  providerRecordId: string;
  name: string;
  categories: string[];
  address?: string;
  street?: string;
  city?: string;
  postalCode?: string;
  region?: string;
  country?: string;
  lat?: number;
  lng?: number;
  phone?: string;
  /** Only when the provider asserts this is the business's own website. */
  website?: string;
  email?: string;
  /** Listing page on the provider (never treated as the official website). */
  profileUrl?: string;
  businessStatus?: BusinessStatus;
  rating?: number;
  ratingCount?: number;
  priceLevel?: number;
  socials?: Array<{ network: string; url: string }>;
  /** Selected raw attributes (subject to the provider's retention policy). */
  raw?: Record<string, unknown>;
  fetchedAt: Date;
  /** When the source itself last changed this record (e.g. OpenStreetMap last edit), if known. */
  sourceUpdatedAt?: Date;
}

export interface GeoArea {
  displayName: string;
  city: string;
  countryCode?: string;
  lat: number;
  lng: number;
  /** [south, west, north, east] */
  bbox?: [number, number, number, number];
  osmType?: 'relation' | 'way' | 'node';
  osmId?: number;
  source: string;
}

export interface BusinessQuery {
  /** Full query text, e.g. "dentysta Mokotów Warszawa". */
  text: string;
  /** The niche term used in this query ("dentysta"). */
  term: string;
  nicheKey?: string;
  language: string;
  city: string;
  country: string;
  countryCode?: string;
  segment?: string;
  area?: GeoArea;
  radiusKm?: number;
  limit: number;
}

export interface SearchResultPage {
  items: NormalizedBusiness[];
  calls: number;
  /** Provider-specific note (e.g. "OSM tag query"). */
  note?: string;
}

export interface BusinessLookup {
  name: string;
  city?: string | null;
  country?: string | null;
  phone?: string | null;
  address?: string | null;
  domain?: string | null;
  providerRefs: Array<{ provider: string; id: string }>;
}

export interface WebsiteCandidate {
  url: string;
  source: string;
  sourceUrl?: string;
  evidence: string;
  rank?: number;
  title?: string;
  snippet?: string;
}

export interface ContactCandidate {
  type: 'email' | 'phone' | 'contact_form' | 'social' | 'address' | 'website';
  subtype?: string;
  value: string;
  source: string;
  sourceUrl?: string;
  label?: string;
  personName?: string;
  role?: string;
}

export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
}

/** Per-job cap on external calls (cost control). */
export class CallBudget {
  private used = 0;
  constructor(public readonly max: number) {}
  consume(n = 1): void {
    if (this.used + n > this.max) throw new BudgetExceededError(`provider call budget of ${this.max} reached for this job`);
    this.used += n;
  }
  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }
  get spent(): number {
    return this.used;
  }
}

export interface ProviderContext {
  signal?: AbortSignal;
  budget: CallBudget;
  log: Logger;
  jobId?: string;
}

export interface DataPolicy {
  /** Hours raw provider content may be retained; null = no restriction known to us. */
  retentionHours: number | null;
  attribution?: string;
  notes: string;
}

export interface LeadSourceAdapter {
  readonly id: string;
  readonly name: string;
  readonly category: 'places' | 'search' | 'import' | 'directory';
  readonly dataPolicy: DataPolicy;
  readonly capabilities: { search: boolean; details: boolean; website: boolean; contacts: boolean };
  /** Requests per second this adapter may issue (token bucket). */
  readonly rateLimitPerSec: number;
  /**
   * text: free-text query per SearchQuery (Places APIs, web search).
   * structured: one call per niche × area (e.g. OSM tag queries) — the orchestrator dedupes.
   */
  readonly queryMode: 'text' | 'structured';
  isConfigured(): boolean;
  configurationHint(): string;
  searchBusinesses(query: BusinessQuery, ctx: ProviderContext): Promise<SearchResultPage>;
  getBusinessDetails(providerRecordId: string, ctx: ProviderContext): Promise<NormalizedBusiness | null>;
  findWebsite(business: BusinessLookup, ctx: ProviderContext): Promise<WebsiteCandidate[]>;
  findPublicContacts(business: BusinessLookup, ctx: ProviderContext): Promise<ContactCandidate[]>;
}

export interface WebResult {
  url: string;
  title: string;
  snippet: string;
  rank: number;
}

export interface WebSearchProvider {
  readonly id: string;
  readonly name: string;
  readonly rateLimitPerSec: number;
  isConfigured(): boolean;
  configurationHint(): string;
  search(query: string, opts: { count: number; language?: string; countryCode?: string }, ctx: ProviderContext): Promise<WebResult[]>;
}

export interface GeoProvider {
  readonly id: string;
  geocode(location: string, country: string, ctx: ProviderContext): Promise<GeoArea | null>;
  subdivisions(area: GeoArea, ctx: ProviderContext): Promise<string[]>;
}

export interface AiImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  dataBase64: string;
}

export interface AiJsonRequest<T> {
  /** Logical task name, for logs, usage and caching (e.g. "visual_analysis"). */
  task: string;
  system: string;
  prompt: string;
  images?: AiImage[];
  schema: z.ZodType<T>;
  maxTokens?: number;
  /** Extra material that makes the cache key unique (e.g. screenshot hash). */
  cacheSalt?: string;
  cacheTtlHours?: number;
}

export interface AiResult<T> {
  data: T;
  model: string;
  cached: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

export interface AiProvider {
  readonly id: string;
  readonly model: string;
  isConfigured(): boolean;
  generateJson<T>(req: AiJsonRequest<T>, ctx: { signal?: AbortSignal; log: Logger }): Promise<AiResult<T>>;
}

export class AiUnavailableError extends Error {
  override name = 'AiUnavailableError';
}
