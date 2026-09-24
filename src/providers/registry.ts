import { loadConfig } from '../config/env.js';
import { resolveSecrets } from '../config/secrets.js';
import { db } from '../db/client.js';
import { GooglePlacesAdapter } from './google-places/index.js';
import { FoursquareAdapter } from './foursquare/index.js';
import { YelpAdapter } from './yelp/index.js';
import { OsmAdapter } from './osm/index.js';
import { BraveSearchProvider, GoogleCseProvider, WebDiscoveryAdapter } from './search/index.js';
import { ImportAdapter } from './import/index.js';
import { AnthropicProvider, DisabledAiProvider } from './ai/anthropic.js';
import { circuitStatus } from './health.js';
import type { AiProvider, GeoProvider, LeadSourceAdapter, WebSearchProvider } from './types.js';

export interface ProviderRegistry {
  /** All known lead sources (configured or not). */
  sources: LeadSourceAdapter[];
  webSearch: WebSearchProvider[];
  webDiscovery: WebDiscoveryAdapter;
  geo: GeoProvider | null;
  ai: AiProvider;
  /** Source ids the user disabled in Settings. */
  disabled: Set<string>;
}

/**
 * Builds the provider set from config + secrets. Rebuilt per job so newly added keys apply
 * without restarts. Business logic only sees the interfaces.
 */
export async function buildProviderRegistry(): Promise<ProviderRegistry> {
  const cfg = loadConfig();
  const s = await resolveSecrets();
  const osm = new OsmAdapter(cfg.OSM_ENABLED, cfg.NOMINATIM_BASE_URL, cfg.OVERPASS_BASE_URL, cfg.OSM_CONTACT_EMAIL);
  const webSearch: WebSearchProvider[] = [
    new BraveSearchProvider(s.BRAVE_SEARCH_API_KEY, cfg.BRAVE_SEARCH_BASE_URL),
    new GoogleCseProvider(s.GOOGLE_CSE_API_KEY, s.GOOGLE_CSE_CX, cfg.GOOGLE_CSE_BASE_URL),
  ];
  const webDiscovery = new WebDiscoveryAdapter(webSearch);
  const sources: LeadSourceAdapter[] = [
    new GooglePlacesAdapter(s.GOOGLE_PLACES_API_KEY, cfg.GOOGLE_PLACES_BASE_URL),
    new FoursquareAdapter(s.FOURSQUARE_API_KEY, cfg.FOURSQUARE_BASE_URL, cfg.FOURSQUARE_API_VERSION),
    new YelpAdapter(s.YELP_API_KEY, cfg.YELP_BASE_URL),
    osm,
    webDiscovery,
    new ImportAdapter(),
  ];
  const aiKey = s.ANTHROPIC_API_KEY;
  const ai: AiProvider =
    cfg.AI_PROVIDER === 'none' || (cfg.AI_PROVIDER === 'auto' && !aiKey)
      ? new DisabledAiProvider()
      : new AnthropicProvider({
          apiKey: aiKey,
          baseUrl: cfg.ANTHROPIC_BASE_URL,
          model: cfg.AI_MODEL,
          effort: cfg.AI_EFFORT,
          monthlyTokenBudget: cfg.AI_MONTHLY_TOKEN_BUDGET,
          serverFallbacks: cfg.AI_SERVER_FALLBACKS,
        });
  const rows = await db().source.findMany({ where: { enabled: false } });
  return { sources, webSearch, webDiscovery, geo: cfg.OSM_ENABLED ? osm : null, ai, disabled: new Set(rows.map((r) => r.id)) };
}

/** Sources that will be queried for a job (configured, enabled, searchable, optional subset). */
export function activeSearchSources(reg: ProviderRegistry, subset: string[] = []): LeadSourceAdapter[] {
  return reg.sources.filter(
    (a) => a.capabilities.search && a.isConfigured() && !reg.disabled.has(a.id) && (subset.length === 0 || subset.includes(a.id)),
  );
}

export interface ProviderDescription {
  id: string;
  name: string;
  category: string;
  configured: boolean;
  enabled: boolean;
  hint: string;
  capabilities: Record<string, boolean>;
  dataPolicy: { retentionHours: number | null; attribution?: string; notes: string };
  circuitOpen: boolean;
  health: {
    totalCalls: number;
    totalFailures: number;
    consecutiveFailures: number;
    avgLatencyMs: number;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    lastError: string | null;
  } | null;
}

export async function describeProviders(): Promise<{ sources: ProviderDescription[]; ai: { id: string; model: string; configured: boolean }; webSearchEngines: Array<{ id: string; name: string; configured: boolean; hint: string }> }> {
  const reg = await buildProviderRegistry();
  const rows = await db().source.findMany();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const sources = reg.sources.map((a) => {
    const h = byId.get(a.id);
    return {
      id: a.id,
      name: a.name,
      category: a.category,
      configured: a.isConfigured(),
      enabled: !reg.disabled.has(a.id),
      hint: a.configurationHint(),
      capabilities: a.capabilities,
      dataPolicy: a.dataPolicy,
      circuitOpen: circuitStatus(a.id).open,
      health: h
        ? {
            totalCalls: h.totalCalls,
            totalFailures: h.totalFailures,
            consecutiveFailures: h.consecutiveFailures,
            avgLatencyMs: h.avgLatencyMs,
            lastSuccessAt: h.lastSuccessAt,
            lastFailureAt: h.lastFailureAt,
            lastError: h.lastError,
          }
        : null,
    };
  });
  return {
    sources,
    ai: { id: reg.ai.id, model: reg.ai.model, configured: reg.ai.isConfigured() },
    webSearchEngines: reg.webSearch.map((w) => ({ id: w.id, name: w.name, configured: w.isConfigured(), hint: w.configurationHint() })),
  };
}

/** Ensure a Source row exists for every adapter (idempotent). */
export async function syncSourceRows(): Promise<void> {
  const reg = await buildProviderRegistry();
  for (const a of reg.sources) {
    await db().source.upsert({
      where: { id: a.id },
      create: { id: a.id, name: a.name, category: a.category, config: {} },
      update: { name: a.name, category: a.category },
    });
  }
}
