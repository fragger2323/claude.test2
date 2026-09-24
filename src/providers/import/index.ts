import { parseCsv } from '../../lib/csv.js';
import { sanitizeText } from '../../lib/text.js';
import { normalizeUrl } from '../../lib/url.js';
import { sha256 } from '../../lib/misc.js';
import { isValidEmailSyntax } from '../../engine/contacts/email.js';
import type {
  BusinessQuery,
  ContactCandidate,
  LeadSourceAdapter,
  NormalizedBusiness,
  SearchResultPage,
  WebsiteCandidate,
} from '../types.js';

/**
 * User imports (CSV / JSON). Imported rows are sanitised, validated and normalised into the
 * same NormalizedBusiness shape as API sources, so they flow through the same pipeline.
 */
const COLUMN_ALIASES: Record<keyof ImportRow, string[]> = {
  externalId: ['id', 'external id', 'external_id', 'ref'],
  name: ['name', 'company', 'company name', 'company_name', 'business', 'business name', 'nazwa', 'firma', 'название', 'компания'],
  website: ['website', 'url', 'site', 'www', 'web', 'strona', 'strona www', 'сайт'],
  phone: ['phone', 'telephone', 'tel', 'phone number', 'telefon', 'телефон'],
  email: ['email', 'e-mail', 'mail', 'адрес почты'],
  address: ['address', 'street', 'adres', 'ulica', 'адрес'],
  city: ['city', 'town', 'locality', 'miasto', 'город'],
  postalCode: ['postal code', 'postal_code', 'zip', 'postcode', 'kod pocztowy'],
  country: ['country', 'kraj', 'страна'],
  category: ['category', 'industry', 'niche', 'branża', 'branza', 'отрасль'],
  lat: ['lat', 'latitude'],
  lng: ['lng', 'lon', 'long', 'longitude'],
};

export interface ImportRow {
  externalId?: string;
  name?: string;
  website?: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  category?: string;
  lat?: string;
  lng?: string;
}

export interface ImportResult {
  records: NormalizedBusiness[];
  errors: string[];
  skipped: number;
}

function pick(row: Record<string, unknown>, key: keyof ImportRow): string | null {
  for (const alias of COLUMN_ALIASES[key]) {
    const v = row[alias];
    if (v != null && String(v).trim() !== '') return sanitizeText(v, key === 'name' ? 200 : 500);
  }
  return null;
}

export function rowsToBusinesses(rows: Array<Record<string, unknown>>, defaults: { country?: string; category?: string } = {}): ImportResult {
  const records: NormalizedBusiness[] = [];
  const errors: string[] = [];
  let skipped = 0;
  const now = new Date();
  rows.forEach((raw, i) => {
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) row[k.trim().toLowerCase()] = v;
    const name = pick(row, 'name');
    if (!name) {
      skipped++;
      if (errors.length < 50) errors.push(`row ${i + 1}: missing company name`);
      return;
    }
    const websiteRaw = pick(row, 'website');
    const website = websiteRaw ? normalizeUrl(websiteRaw) : null;
    if (websiteRaw && !website && errors.length < 50) errors.push(`row ${i + 1}: ignored invalid website "${websiteRaw.slice(0, 60)}"`);
    const emailRaw = pick(row, 'email');
    const email = emailRaw && isValidEmailSyntax(emailRaw) ? emailRaw.toLowerCase() : undefined;
    if (emailRaw && !email && errors.length < 50) errors.push(`row ${i + 1}: ignored invalid email`);
    const lat = Number(pick(row, 'lat'));
    const lng = Number(pick(row, 'lng'));
    const address = pick(row, 'address') ?? undefined;
    const city = pick(row, 'city') ?? undefined;
    const externalId = pick(row, 'externalId');
    const id = externalId ?? sha256([name, address, city, website].join('|').toLowerCase()).slice(0, 24);
    const category = pick(row, 'category') ?? defaults.category;
    records.push({
      provider: 'import',
      providerRecordId: id,
      name,
      categories: category ? [category] : [],
      address,
      street: address,
      city,
      postalCode: pick(row, 'postalCode') ?? undefined,
      country: pick(row, 'country') ?? defaults.country,
      lat: Number.isFinite(lat) && Math.abs(lat) <= 90 && lat !== 0 ? lat : undefined,
      lng: Number.isFinite(lng) && Math.abs(lng) <= 180 && lng !== 0 ? lng : undefined,
      phone: pick(row, 'phone') ?? undefined,
      website: website ?? undefined,
      email,
      fetchedAt: now,
    });
  });
  return { records, errors, skipped };
}

export function parseImport(content: string, format: 'csv' | 'json', defaults: { country?: string; category?: string } = {}): ImportResult {
  if (format === 'csv') {
    const parsed = parseCsv(content);
    const res = rowsToBusinesses(parsed.rows, defaults);
    return { ...res, errors: [...parsed.errors, ...res.errors] };
  }
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return { records: [], errors: ['invalid JSON'], skipped: 0 };
  }
  const arr = Array.isArray(data) ? data : Array.isArray((data as { companies?: unknown[] })?.companies) ? (data as { companies: unknown[] }).companies : null;
  if (!arr) return { records: [], errors: ['JSON must be an array of objects or {"companies": [...]}'], skipped: 0 };
  const rows = arr.slice(0, 20_000).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
  return rowsToBusinesses(rows, defaults);
}

export class ImportAdapter implements LeadSourceAdapter {
  readonly id = 'import';
  readonly name = 'CSV / JSON import';
  readonly category = 'import' as const;
  readonly capabilities = { search: false, details: false, website: false, contacts: false };
  readonly rateLimitPerSec = 1000;
  readonly queryMode = 'structured' as const;
  readonly dataPolicy = { retentionHours: null, notes: 'Your own data. Imported values are sanitised and kept with provenance "import".' };

  isConfigured(): boolean {
    return true;
  }
  configurationHint(): string {
    return 'Always available. Use Leads → Import to upload CSV or JSON.';
  }
  async searchBusinesses(_q: BusinessQuery): Promise<SearchResultPage> {
    return { items: [], calls: 0 };
  }
  async getBusinessDetails(): Promise<NormalizedBusiness | null> {
    return null;
  }
  async findWebsite(): Promise<WebsiteCandidate[]> {
    return [];
  }
  async findPublicContacts(): Promise<ContactCandidate[]> {
    return [];
  }
}
