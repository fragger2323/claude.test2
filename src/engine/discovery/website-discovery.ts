import type { Confidence } from '../../domain/types.js';
import { normalizePhone } from '../../lib/phone.js';
import { domainMatchesName, nameTokens, normalizeAddress, stripDiacritics } from '../../lib/text.js';
import { classifyNonOfficialDomain, isFreeHostingSubdomain, normalizeUrl, registrableDomain } from '../../lib/url.js';
import type { FetchedPage } from '../../providers/website/fetcher.js';
import type { WebsiteCandidate } from '../../providers/types.js';

/**
 * Official-website discovery. Collects candidates from sources and web search, rejects
 * directory/social/booking profiles, verifies the best candidates by fetching the homepage
 * and matching the company's name/phone/address, and explains every verdict.
 */

export interface CandidateVerdict {
  url: string;
  source: string;
  evidence: string;
  verdict: 'accepted' | 'rejected' | 'unverified' | 'unreachable';
  score: number;
  reasons: string[];
}

export interface WebsiteDecision {
  status: 'found' | 'not_found' | 'unreachable';
  url: string | null;
  domain: string | null;
  finalUrl: string | null;
  confidence: Confidence;
  source: string | null;
  httpStatus: number | null;
  log: CandidateVerdict[];
  notFoundReason: string | null;
  checkedSources: string[];
}

export interface DiscoveryCompany {
  name: string;
  city?: string | null;
  country?: string | null;
  phones: string[];
  address?: string | null;
}

const SOURCE_WEIGHT: Record<string, number> = { import: 0.6, google_places: 0.6, foursquare: 0.55, osm: 0.55, yelp: 0.3, web_search: 0.25, manual: 1 };
const PARKED = /(domain (is|may be) for sale|this domain is parked|buy this domain|domena (jest )?na sprzeda|domain kaufen|sedo(parking)?\.com|parkingcrew|dan\.com|afternic|hugedomains|this site can.t be reached|website coming soon|under construction|strona w budowie|account suspended|default web site page|welcome to nginx|apache2 (ubuntu|debian) default page|it works!)/i;

export interface VerifyResult {
  score: number;
  reasons: string[];
  reachable: boolean;
  parked: boolean;
  finalUrl?: string;
  status?: number;
}

/** Evidence that a fetched homepage belongs to the company. */
export function verifyHomepage(page: FetchedPage, company: DiscoveryCompany): VerifyResult {
  const reasons: string[] = [];
  if (!page.ok) {
    return { score: 0, reasons: [page.error ? `unreachable: ${page.error}` : `HTTP ${page.status}`], reachable: false, parked: false, status: page.status };
  }
  const hay = stripDiacritics(`${page.title} ${page.text}`.toLowerCase());
  if (PARKED.test(hay.slice(0, 5000)) && page.text.length < 3000) {
    return { score: 0, reasons: ['looks like a parked/placeholder page'], reachable: true, parked: true, finalUrl: page.finalUrl, status: page.status };
  }
  let score = 0;
  const toks = nameTokens(company.name).filter((t) => t.length >= 3);
  const hits = toks.filter((t) => hay.includes(t));
  if (toks.length > 0 && hits.length / toks.length >= 0.6) {
    score += 0.45;
    reasons.push(`company name found on page (${hits.join(', ')})`);
  } else if (hits.length > 0) {
    score += 0.2;
    reasons.push(`partial name match (${hits.join(', ')})`);
  }
  const digits = hay.replace(/[^\d]/g, ' ');
  for (const p of company.phones) {
    const n = normalizePhone(p, company.country);
    const national = n?.national.replace(/\D/g, '');
    if (national && national.length >= 6 && (digits.replace(/\s/g, '').includes(national) || page.html.replace(/\D/g, '').includes(national))) {
      score += 0.4;
      reasons.push(`phone ${n!.international} found on page`);
      break;
    }
  }
  if (company.address) {
    const street = normalizeAddress(company.address).split(' ').filter((t) => t.length >= 4)[0];
    if (street && hay.includes(street)) {
      score += 0.15;
      reasons.push(`address fragment "${street}" found`);
    }
  }
  if (company.city && hay.includes(stripDiacritics(company.city.toLowerCase()))) {
    score += 0.05;
    reasons.push('city mentioned');
  }
  return { score: Math.min(1, score), reasons, reachable: true, parked: false, finalUrl: page.finalUrl, status: page.status };
}

export interface DiscoveryDeps {
  fetchHomepage: (url: string) => Promise<FetchedPage>;
  /** Only called when source candidates are missing or all rejected (cost control). */
  searchCandidates?: () => Promise<WebsiteCandidate[]>;
  searchAvailable: boolean;
}

export async function discoverWebsite(company: DiscoveryCompany, sourceCandidates: WebsiteCandidate[], deps: DiscoveryDeps): Promise<WebsiteDecision> {
  const log: CandidateVerdict[] = [];
  const checkedSources = new Set<string>(sourceCandidates.map((c) => c.source));

  const consider = (cands: WebsiteCandidate[]) => {
    const byDomain = new Map<string, { url: string; sources: WebsiteCandidate[] }>();
    for (const c of cands) {
      const url = normalizeUrl(c.url);
      if (!url) {
        log.push({ url: c.url, source: c.source, evidence: c.evidence, verdict: 'rejected', score: 0, reasons: ['not a valid website URL'] });
        continue;
      }
      const kind = classifyNonOfficialDomain(url);
      if (kind) {
        log.push({ url, source: c.source, evidence: c.evidence, verdict: 'rejected', score: 0, reasons: [`${kind} profile, not an official website`] });
        continue;
      }
      const key = isFreeHostingSubdomain(url) ? new URL(url).hostname : registrableDomain(url) ?? url;
      const e = byDomain.get(key) ?? { url: new URL(url).origin, sources: [] };
      e.sources.push(c);
      byDomain.set(key, e);
    }
    return byDomain;
  };

  let pool = consider(sourceCandidates);
  if (pool.size === 0 && deps.searchAvailable && deps.searchCandidates) {
    checkedSources.add('web_search');
    const found = await deps.searchCandidates().catch(() => [] as WebsiteCandidate[]);
    if (found.length === 0) log.push({ url: '-', source: 'web_search', evidence: `search for "${company.name}" ${company.city ?? ''}`, verdict: 'rejected', score: 0, reasons: ['no usable results'] });
    pool = consider(found);
  }

  const scored = [...pool.entries()].map(([domain, e]) => {
    const srcScore = Math.max(...e.sources.map((s) => (SOURCE_WEIGHT[s.source] ?? 0.3) + (s.rank && s.rank <= 3 ? 0.05 : 0)));
    const agreement = new Set(e.sources.map((s) => s.source)).size >= 2 ? 0.2 : 0;
    const nameMatch = domainMatchesName(domain, company.name) * 0.3;
    return { domain, url: e.url, sources: e.sources, prior: Math.min(1, srcScore + agreement + nameMatch) };
  });
  scored.sort((a, b) => b.prior - a.prior);

  let best: { domain: string; url: string; source: string; score: number; verify: VerifyResult } | null = null;
  let unreachableFallback: { domain: string; url: string; source: string; prior: number; verify: VerifyResult } | null = null;
  for (const cand of scored.slice(0, 3)) {
    const page = await deps.fetchHomepage(cand.url);
    const v = verifyHomepage(page, company);
    const primarySource = cand.sources[0]!;
    const evidence = cand.sources.map((s) => `${s.source}: ${s.evidence}`).join('; ');
    if (!v.reachable) {
      log.push({ url: cand.url, source: primarySource.source, evidence, verdict: 'unreachable', score: cand.prior, reasons: v.reasons });
      const fromPlaces = cand.sources.some((s) => s.source !== 'web_search');
      if (fromPlaces && (!unreachableFallback || cand.prior > unreachableFallback.prior)) unreachableFallback = { ...cand, source: primarySource.source, verify: v };
      continue;
    }
    if (v.parked) {
      log.push({ url: cand.url, source: primarySource.source, evidence, verdict: 'rejected', score: 0, reasons: v.reasons });
      continue;
    }
    const combined = cand.prior * 0.5 + v.score * 0.5;
    const onlySearch = cand.sources.every((s) => s.source === 'web_search');
    const threshold = onlySearch ? 0.45 : 0.3;
    if (combined >= threshold && (!onlySearch || v.score >= 0.4)) {
      log.push({ url: cand.url, source: primarySource.source, evidence, verdict: 'accepted', score: Number(combined.toFixed(2)), reasons: v.reasons.length ? v.reasons : ['listed by a business data source'] });
      if (!best || combined > best.score) best = { domain: cand.domain, url: v.finalUrl ?? cand.url, source: primarySource.source, score: combined, verify: v };
    } else {
      log.push({ url: cand.url, source: primarySource.source, evidence, verdict: 'unverified', score: Number(combined.toFixed(2)), reasons: [...v.reasons, 'insufficient evidence that this site belongs to the company'] });
    }
  }

  if (best) {
    const confidence: Confidence = best.score >= 0.7 || best.verify.score >= 0.8 ? 'high' : best.score >= 0.45 ? 'medium' : 'low';
    return {
      status: 'found',
      url: normalizeUrl(best.url) ?? best.url,
      domain: best.domain,
      finalUrl: best.verify.finalUrl ?? null,
      confidence,
      source: best.source,
      httpStatus: best.verify.status ?? null,
      log,
      notFoundReason: null,
      checkedSources: [...checkedSources],
    };
  }
  if (unreachableFallback) {
    return {
      status: 'unreachable',
      url: unreachableFallback.url,
      domain: unreachableFallback.domain,
      finalUrl: null,
      confidence: 'low',
      source: unreachableFallback.source,
      httpStatus: unreachableFallback.verify.status ?? null,
      log,
      notFoundReason: 'A website is listed by a business data source but could not be reached. The company is NOT assumed closed.',
      checkedSources: [...checkedSources],
    };
  }
  const checked = [...checkedSources];
  const rejected = log.filter((l) => l.verdict === 'rejected').length;
  const reason = [
    `No official website found.`,
    checked.length ? `Checked: ${checked.join(', ')}.` : 'No source listed a website.',
    rejected ? `${rejected} candidate(s) rejected (directories/social profiles/parked pages).` : '',
    !deps.searchAvailable ? 'Web search is not configured, so no independent website search was performed.' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { status: 'not_found', url: null, domain: null, finalUrl: null, confidence: 'medium', source: null, httpStatus: null, log, notFoundReason: reason, checkedSources: checked };
}
