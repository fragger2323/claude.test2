import 'dotenv/config';
import { z } from 'zod';

/**
 * Centralised, validated configuration. Every env var the app reads is declared here.
 * Secrets are validated for shape but never logged.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int().min(min).max(max));

const optStr = z
  .string()
  .optional()
  .transform((v) => (v == null || v.trim() === '' ? undefined : v.trim()));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().default('file:../data/dev.db'),
  HOST: z.string().default('127.0.0.1'),
  PORT: int(4000, 1, 65535),
  APP_URL: optStr,
  APP_ENCRYPTION_KEY: optStr,
  SETUP_TOKEN: optStr,
  SESSION_TTL_HOURS: int(24 * 14, 1, 24 * 90),
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool(false),

  RUN_WORKER_IN_PROCESS: bool(false),
  WORKER_CONCURRENCY: int(2, 1, 16),
  WORKER_POLL_MS: int(1000, 100, 60_000),
  SCHEDULER_ENABLED: bool(true),

  BROWSER_POOL_SIZE: int(2, 1, 8),
  BROWSER_EXECUTABLE_PATH: optStr,
  ANALYSIS_MAX_PAGES: int(4, 1, 15),
  ANALYSIS_TIMEOUT_MS: int(45_000, 5_000, 180_000),
  ANALYSIS_CONCURRENCY: int(2, 1, 8),
  REANALYZE_AFTER_DAYS: int(14, 0, 365),
  ALLOW_PRIVATE_NETWORK_TARGETS: bool(false),
  RESPECT_ROBOTS_TXT: bool(true),
  HTTP_USER_AGENT: z
    .string()
    .default('AgencyIntelligenceOS/0.1 (+business website review; contact via configured studio site)'),
  LIGHTHOUSE_ENABLED: bool(false),

  MAX_PROVIDER_CALLS_PER_JOB: int(300, 1, 100_000),
  JOB_MAX_LEADS: int(1000, 1, 5000),

  GOOGLE_PLACES_API_KEY: optStr,
  GOOGLE_PLACES_BASE_URL: z.string().default('https://places.googleapis.com'),
  FOURSQUARE_API_KEY: optStr,
  FOURSQUARE_BASE_URL: z.string().default('https://places-api.foursquare.com'),
  FOURSQUARE_API_VERSION: z.string().default('2025-06-17'),
  YELP_API_KEY: optStr,
  YELP_BASE_URL: z.string().default('https://api.yelp.com'),
  OSM_ENABLED: bool(true),
  NOMINATIM_BASE_URL: z.string().default('https://nominatim.openstreetmap.org'),
  OVERPASS_BASE_URL: z.string().default('https://overpass-api.de/api'),
  OSM_CONTACT_EMAIL: optStr,
  BRAVE_SEARCH_API_KEY: optStr,
  BRAVE_SEARCH_BASE_URL: z.string().default('https://api.search.brave.com'),
  GOOGLE_CSE_API_KEY: optStr,
  GOOGLE_CSE_CX: optStr,
  GOOGLE_CSE_BASE_URL: z.string().default('https://www.googleapis.com'),

  AI_PROVIDER: z.enum(['anthropic', 'none', 'auto']).default('auto'),
  ANTHROPIC_API_KEY: optStr,
  ANTHROPIC_BASE_URL: optStr,
  AI_MODEL: z.string().default('claude-opus-5'),
  AI_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  AI_MONTHLY_TOKEN_BUDGET: int(3_000_000, 0),
  AI_VISUAL_ANALYSIS: bool(true),
  AI_SERVER_FALLBACKS: bool(true),
});

export type AppConfig = z.infer<typeof schema> & {
  isProd: boolean;
  isTest: boolean;
};

const PLACEHOLDER = /^(your[-_ ]|changeme|xxx+|todo|replace[-_ ]?me|<.*>$|\.\.\.)/i;

/** Names of env vars holding third-party credentials. Never logged, never returned to clients. */
export const SECRET_ENV_NAMES = [
  'GOOGLE_PLACES_API_KEY',
  'FOURSQUARE_API_KEY',
  'YELP_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'GOOGLE_CSE_API_KEY',
  'GOOGLE_CSE_CX',
  'ANTHROPIC_API_KEY',
] as const;
export type SecretName = (typeof SECRET_ENV_NAMES)[number];

export interface ConfigWarning {
  key: string;
  message: string;
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): { config: AppConfig; warnings: ConfigWarning[] } {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  const warnings: ConfigWarning[] = [];

  // Placeholder secrets are treated as missing rather than sent to providers.
  for (const name of SECRET_ENV_NAMES) {
    const v = c[name];
    if (v && PLACEHOLDER.test(v)) {
      warnings.push({ key: name, message: 'looks like a placeholder value and is ignored' });
      (c as Record<string, unknown>)[name] = undefined;
    }
  }

  const isProd = c.NODE_ENV === 'production';
  if (c.APP_ENCRYPTION_KEY) {
    const bytes = decodeKey(c.APP_ENCRYPTION_KEY);
    if (!bytes || bytes.length !== 32) {
      throw new Error('APP_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex chars or base64. Run `npm run setup`.');
    }
  } else if (isProd) {
    throw new Error('APP_ENCRYPTION_KEY is required in production. Run `npm run setup` to generate one.');
  } else {
    warnings.push({ key: 'APP_ENCRYPTION_KEY', message: 'not set — API keys cannot be stored from the UI (env vars still work)' });
  }
  if (isProd && c.ALLOW_PRIVATE_NETWORK_TARGETS) {
    throw new Error('ALLOW_PRIVATE_NETWORK_TARGETS must not be enabled in production (SSRF risk).');
  }
  if (isProd && !c.APP_URL) {
    warnings.push({ key: 'APP_URL', message: 'not set — origin checks fall back to the Host header' });
  }
  if (c.GOOGLE_CSE_API_KEY && !c.GOOGLE_CSE_CX) {
    warnings.push({ key: 'GOOGLE_CSE_CX', message: 'GOOGLE_CSE_API_KEY is set but GOOGLE_CSE_CX is missing' });
  }

  return { config: { ...c, isProd, isTest: c.NODE_ENV === 'test' }, warnings };
}

export function decodeKey(value: string): Buffer | null {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  try {
    const b = Buffer.from(value, 'base64');
    return b.length > 0 ? b : null;
  } catch {
    return null;
  }
}

let cached: { config: AppConfig; warnings: ConfigWarning[] } | null = null;

export function loadConfig(): AppConfig {
  if (!cached) cached = parseConfig();
  return cached.config;
}

export function configWarnings(): ConfigWarning[] {
  if (!cached) cached = parseConfig();
  return cached.warnings;
}

/** Test helper: re-read process.env. */
export function resetConfigForTests(): void {
  cached = null;
}
