import { NICHES } from '../../domain/taxonomy.js';
import type { Discrepancy } from '../../domain/types.js';
import { haversineMeters } from '../../lib/misc.js';
import { normalizePhone } from '../../lib/phone.js';
import { addressKey, nameSimilarity, nameTokens, normalizeName, stripDiacritics } from '../../lib/text.js';
import { classifyNonOfficialDomain, hostOf, isFreeHostingSubdomain, normalizeUrl, registrableDomain } from '../../lib/url.js';
import type { NormalizedBusiness } from '../../providers/types.js';

/**
 * Entity resolution: decides which records describe the same company.
 * Principle: never merge without sufficient evidence. Name similarity alone is never enough;
 * it must be combined with location, address, phone or domain agreement, and conflicting
 * official domains always block a merge. Every merge keeps full source provenance.
 */

export interface ResolvableRecord {
  key: string;
  provider: string;
  providerRecordId: string;
  name: string;
  normalizedName: string;
  genericName: boolean;
  domain: string | null;
  phoneE164: string | null;
  addressKey: string | null;
  postalCode: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  emailDomain: string | null;
  /** Existing company id when this record represents a company already in the DB. */
  companyId?: string;
}

export interface MatchResult {
  score: number;
  reasons: string[];
  blocked?: string;
}

// Words that alone don't identify a business (industry words, generic nouns), in many languages.
const GENERIC_TOKENS = new Set<string>([
  'clinic', 'center', 'centre', 'studio', 'salon', 'office', 'group', 'center', 'company', 'services', 'service', 'shop', 'store', 'house',
  'gabinet', 'centrum', 'klinika', 'przychodnia', 'biuro', 'sklep', 'firma', 'uslugi', 'pracownia', 'dom',
  'praxis', 'zentrum', 'klinik', 'buro', 'haus',
  'ordinace', 'centrum', 'kancelar', 'klinika',
  'центр', 'клиника', 'клініка', 'студия', 'студія', 'салон', 'кабинет', 'кабінет',
  'medical', 'medyczne', 'medyczny', 'dental', 'dent', 'med', 'plus', 'pro', 'best', 'new', 'city', 'the',
]);
for (const n of NICHES) {
  for (const terms of Object.values(n.terms)) {
    for (const t of terms ?? []) for (const tok of nameTokens(t)) GENERIC_TOKENS.add(tok);
  }
}

export function isGenericName(name: string): boolean {
  const toks = nameTokens(name).filter((t) => t.length > 1);
  if (toks.length === 0) return true;
  return toks.every((t) => GENERIC_TOKENS.has(t) || /^\d+$/.test(t));
}

/** Domain key used for matching: registrable domain, or full host for free-hosting subdomains. */
export function domainKey(url: string | null | undefined): string | null {
  const n = normalizeUrl(url ?? null);
  if (!n) return null;
  if (classifyNonOfficialDomain(n)) return null;
  if (isFreeHostingSubdomain(n)) return hostOf(n);
  return registrableDomain(n);
}

export function toResolvable(r: NormalizedBusiness, defaultCountry?: string): ResolvableRecord {
  const phone = normalizePhone(r.phone, r.country ?? defaultCountry);
  const email = r.email?.toLowerCase();
  return {
    key: `${r.provider}:${r.providerRecordId}`,
    provider: r.provider,
    providerRecordId: r.providerRecordId,
    name: r.name,
    normalizedName: normalizeName(r.name),
    genericName: isGenericName(r.name),
    domain: domainKey(r.website),
    phoneE164: phone?.valid ? phone.e164 : null,
    addressKey: addressKey(r.street ?? r.address),
    postalCode: r.postalCode ? r.postalCode.replace(/\s+/g, '').toLowerCase() : null,
    city: r.city ? stripDiacritics(r.city.toLowerCase()).trim() : null,
    lat: r.lat ?? null,
    lng: r.lng ?? null,
    emailDomain: email?.includes('@') ? registrableDomain(email.split('@')[1]!) : null,
  };
}

/** Pairwise match evidence. score ≥ MERGE_THRESHOLD merges. */
export function matchRecords(a: ResolvableRecord, b: ResolvableRecord, sharedPhones: Set<string> = new Set()): MatchResult {
  const reasons: string[] = [];
  if (a.provider === b.provider && a.providerRecordId === b.providerRecordId) return { score: 1, reasons: ['same provider record'] };
  if (a.companyId && b.companyId && a.companyId === b.companyId) return { score: 1, reasons: ['same existing company'] };

  // Hard conflict: two different official domains are two different companies (or bad data).
  if (a.domain && b.domain && a.domain !== b.domain) return { score: 0, reasons: [], blocked: `different websites (${a.domain} vs ${b.domain})` };

  const sim = nameSimilarity(a.name, b.name);
  const dist = a.lat != null && a.lng != null && b.lat != null && b.lng != null ? haversineMeters({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }) : null;
  const sameAddress = !!a.addressKey && a.addressKey === b.addressKey;
  const samePostal = !!a.postalCode && a.postalCode === b.postalCode;
  const differentCity = !!a.city && !!b.city && a.city !== b.city && !a.city.includes(b.city) && !b.city.includes(a.city);

  let score = 0;
  if (a.domain && a.domain === b.domain) {
    score = Math.max(score, 0.9);
    reasons.push(`same website domain ${a.domain}`);
  }
  if (a.emailDomain && (a.emailDomain === b.domain || a.emailDomain === b.emailDomain) && sim >= 0.5) {
    score = Math.max(score, 0.8);
    reasons.push(`email domain ${a.emailDomain} matches`);
  }
  if (a.phoneE164 && a.phoneE164 === b.phoneE164 && !sharedPhones.has(a.phoneE164)) {
    const corroborated = sim >= 0.6 || (dist != null && dist < 250) || sameAddress;
    if (corroborated) {
      score = Math.max(score, 0.88);
      reasons.push(`same phone ${a.phoneE164}`);
    }
  }
  const genericPair = a.genericName || b.genericName;
  if (!genericPair) {
    if (sim >= 0.9 && dist != null && dist <= 150) {
      score = Math.max(score, 0.85);
      reasons.push(`name similarity ${sim.toFixed(2)} within ${Math.round(dist)} m`);
    } else if (sim >= 0.85 && sameAddress) {
      score = Math.max(score, 0.85);
      reasons.push(`name similarity ${sim.toFixed(2)} at the same address`);
    } else if (sim >= 0.93 && samePostal && (dist == null || dist < 600)) {
      score = Math.max(score, 0.8);
      reasons.push(`name similarity ${sim.toFixed(2)} with the same postal code`);
    }
  } else if (sim >= 0.95 && sameAddress && dist != null && dist < 60) {
    score = Math.max(score, 0.8);
    reasons.push('generic name but identical address and location');
  }
  if (differentCity && score < 0.9) return { score: 0, reasons: [], blocked: 'different cities' };
  // far apart with no website/phone evidence → do not merge
  if (dist != null && dist > 2000 && score < 0.88) return { score: 0, reasons: [], blocked: `${Math.round(dist)} m apart` };
  return { score, reasons };
}

export const MERGE_THRESHOLD = 0.8;

/** Phones reported for 3+ clearly different names are treated as shared (call centres, booking lines). */
export function findSharedPhones(records: ResolvableRecord[]): Set<string> {
  const names = new Map<string, Set<string>>();
  for (const r of records) {
    if (!r.phoneE164) continue;
    const set = names.get(r.phoneE164) ?? new Set<string>();
    set.add(r.normalizedName);
    names.set(r.phoneE164, set);
  }
  const shared = new Set<string>();
  for (const [phone, set] of names) {
    const list = [...set];
    let distinct = 0;
    for (let i = 0; i < list.length; i++) {
      if (list.slice(0, i).every((prev) => nameSimilarity(prev, list[i]!) < 0.6)) distinct++;
    }
    if (distinct >= 3) shared.add(phone);
  }
  return shared;
}

export interface Cluster {
  members: ResolvableRecord[];
  reasons: string[];
}

/**
 * Clusters records with union-find over blocked candidate pairs. A union is refused when it
 * would put two different official domains (or two different existing companies) together.
 */
export function clusterRecords(records: ResolvableRecord[]): Cluster[] {
  const parent = records.map((_, i) => i);
  const domains = records.map((r) => new Set(r.domain ? [r.domain] : []));
  const companies = records.map((r) => new Set(r.companyId ? [r.companyId] : []));
  const reasons = records.map(() => [] as string[]);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (i: number, j: number, why: string[]): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri === rj) return;
    const dom = new Set([...domains[ri]!, ...domains[rj]!]);
    if (dom.size > 1) return;
    const comp = new Set([...companies[ri]!, ...companies[rj]!]);
    if (comp.size > 1) return;
    parent[rj] = ri;
    domains[ri] = dom;
    companies[ri] = comp;
    reasons[ri]!.push(...why, ...reasons[rj]!);
  };

  const shared = findSharedPhones(records);
  // Blocking keys to avoid O(n²) comparisons.
  const blocks = new Map<string, number[]>();
  const add = (k: string | null, i: number) => {
    if (!k) return;
    const arr = blocks.get(k) ?? [];
    arr.push(i);
    blocks.set(k, arr);
  };
  records.forEach((r, i) => {
    add(r.domain ? `d:${r.domain}` : null, i);
    add(r.phoneE164 ? `p:${r.phoneE164}` : null, i);
    add(r.addressKey ? `a:${r.addressKey}` : null, i);
    add(r.companyId ? `c:${r.companyId}` : null, i);
    add(`s:${r.provider}:${r.providerRecordId}`, i);
    const tok = r.normalizedName.split(' ').filter((t) => t.length > 2 && !GENERIC_TOKENS.has(t))[0];
    if (tok) add(`n:${tok.slice(0, 5)}`, i);
    if (r.lat != null && r.lng != null) add(`g:${Math.round(r.lat * 300)}:${Math.round(r.lng * 200)}`, i);
  });
  const compared = new Set<string>();
  for (const idxs of blocks.values()) {
    if (idxs.length > 400) continue; // pathological block (e.g. very common token)
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const i = idxs[x]!;
        const j = idxs[y]!;
        const pk = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (compared.has(pk)) continue;
        compared.add(pk);
        const m = matchRecords(records[i]!, records[j]!, shared);
        if (m.score >= MERGE_THRESHOLD) union(i, j, m.reasons);
      }
    }
  }
  const groups = new Map<number, Cluster>();
  records.forEach((r, i) => {
    const root = find(i);
    const g = groups.get(root) ?? { members: [], reasons: [] };
    g.members.push(r);
    groups.set(root, g);
  });
  for (const [root, g] of groups) g.reasons = [...new Set(reasons[root])];
  return [...groups.values()];
}

// ───────────── merged view + discrepancy detection ─────────────

const PROVIDER_TRUST: Record<string, number> = { import: 5, google_places: 4, foursquare: 3, osm: 3, yelp: 2, web_search: 1 };

export interface MergedCompany {
  name: string;
  normalizedName: string;
  primaryDomain: string | null;
  website: string | null;
  phoneE164: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  categories: string[];
  businessStatus: string;
  rating: number | null;
  ratingCount: number | null;
  priceLevel: number | null;
  sources: string[];
  discrepancies: Discrepancy[];
  newestFetch: Date | null;
}

function pickBest<T>(records: NormalizedBusiness[], get: (r: NormalizedBusiness) => T | undefined | null): T | null {
  const sorted = [...records].sort((a, b) => (PROVIDER_TRUST[b.provider] ?? 0) - (PROVIDER_TRUST[a.provider] ?? 0));
  for (const r of sorted) {
    const v = get(r);
    if (v != null && v !== '') return v;
  }
  return null;
}

function collectDiscrepancy(
  field: Discrepancy['field'],
  records: NormalizedBusiness[],
  get: (r: NormalizedBusiness) => { display: string; key: string } | null,
): Discrepancy | null {
  const byKey = new Map<string, { value: string; sources: Discrepancy['values'][number]['sources'] }>();
  for (const r of records) {
    const v = get(r);
    if (!v) continue;
    const entry = byKey.get(v.key) ?? { value: v.display, sources: [] };
    entry.sources.push({ provider: r.provider, observedAt: r.fetchedAt.toISOString(), url: r.profileUrl });
    byKey.set(v.key, entry);
  }
  if (byKey.size < 2) return null;
  return { field, values: [...byKey.values()], detectedAt: new Date().toISOString() };
}

export function mergeRecords(records: NormalizedBusiness[], defaultCountry?: string): MergedCompany {
  const name = pickBest(records, (r) => (r.provider === 'web_search' ? null : r.name)) ?? records[0]!.name;
  const website = pickBest(records, (r) => (domainKey(r.website) ? normalizeUrl(r.website) : null));
  const phone = pickBest(records, (r) => {
    const p = normalizePhone(r.phone, r.country ?? defaultCountry);
    return p?.valid ? p.e164 : null;
  });
  const discrepancies: Discrepancy[] = [];
  const phoneD = collectDiscrepancy('phone', records, (r) => {
    const p = normalizePhone(r.phone, r.country ?? defaultCountry);
    return p?.valid ? { display: p.international, key: p.e164 } : null;
  });
  if (phoneD) discrepancies.push({ ...phoneD, note: 'Different phone numbers across sources — both are shown; verify before calling.' });
  const webD = collectDiscrepancy('website', records, (r) => {
    const k = domainKey(r.website);
    return k ? { display: k, key: k } : null;
  });
  if (webD) discrepancies.push({ ...webD, note: 'Sources disagree on the official website.' });
  const addrD = collectDiscrepancy('address', records, (r) => {
    const k = addressKey(r.street ?? r.address);
    return k ? { display: r.address ?? r.street ?? k, key: k } : null;
  });
  if (addrD) discrepancies.push({ ...addrD, note: 'Different addresses — may be multiple locations or outdated data.' });
  const statusD = collectDiscrepancy('businessStatus', records, (r) =>
    r.businessStatus && r.businessStatus !== 'unknown' ? { display: r.businessStatus, key: r.businessStatus } : null,
  );
  if (statusD) discrepancies.push({ ...statusD, note: 'Sources disagree on whether the business is open.' });

  const statuses = records.map((r) => r.businessStatus).filter((s): s is NonNullable<typeof s> => !!s && s !== 'unknown');
  // Most-trusted explicit status wins; operational if any trusted source says so recently.
  const businessStatus = pickBest(records, (r) => (r.businessStatus && r.businessStatus !== 'unknown' ? r.businessStatus : null)) ?? (statuses[0] ?? 'unknown');
  const ratingSrc = pickBest(records, (r) => (r.ratingCount != null ? r : null));
  const newest = records.reduce<Date | null>((m, r) => (!m || r.fetchedAt > m ? r.fetchedAt : m), null);
  const categories = [...new Set(records.flatMap((r) => r.categories))].slice(0, 12);
  return {
    name,
    normalizedName: normalizeName(name),
    primaryDomain: domainKey(website),
    website,
    phoneE164: phone,
    address: pickBest(records, (r) => r.address ?? null),
    city: pickBest(records, (r) => r.city ?? null),
    postalCode: pickBest(records, (r) => r.postalCode ?? null),
    country: pickBest(records, (r) => r.country ?? null) ?? defaultCountry ?? null,
    lat: pickBest(records, (r) => r.lat ?? null),
    lng: pickBest(records, (r) => r.lng ?? null),
    categories,
    businessStatus,
    rating: ratingSrc?.rating ?? null,
    ratingCount: ratingSrc?.ratingCount ?? null,
    priceLevel: pickBest(records, (r) => r.priceLevel ?? null),
    sources: [...new Set(records.map((r) => r.provider))],
    discrepancies,
    newestFetch: newest,
  };
}

/** Convert an existing company row into a resolvable record for DB matching. */
export function companyToResolvable(c: {
  id: string;
  name: string;
  primaryDomain: string | null;
  phoneE164: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
}): ResolvableRecord {
  return {
    key: `company:${c.id}`,
    provider: 'company',
    providerRecordId: c.id,
    name: c.name,
    normalizedName: normalizeName(c.name),
    genericName: isGenericName(c.name),
    domain: c.primaryDomain,
    phoneE164: c.phoneE164,
    addressKey: addressKey(c.address),
    postalCode: c.postalCode ? c.postalCode.replace(/\s+/g, '').toLowerCase() : null,
    city: c.city ? stripDiacritics(c.city.toLowerCase()).trim() : null,
    lat: c.lat,
    lng: c.lng,
    emailDomain: null,
    companyId: c.id,
  };
}
