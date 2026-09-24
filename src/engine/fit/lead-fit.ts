import type { SearchParams } from '../../domain/search-params.js';
import { NICHES } from '../../domain/taxonomy.js';
import {
  COMPONENT_LABELS,
  type ComponentKey,
  type LeadFitResult,
  type Priority,
  type ScoreComponent,
  type ScoreFactor,
} from '../../domain/types.js';
import { clamp } from '../../lib/misc.js';
import { stripDiacritics } from '../../lib/text.js';
import type { FindingForScoring } from './service-matching.js';

/**
 * Lead Fit: a transparent, weighted combination of explainable components.
 * No component is a black box; each lists the factors (with points) that produced it,
 * and unknowns are reported as gaps instead of being guessed.
 */

export const DEFAULT_WEIGHTS: Record<ComponentKey, number> = {
  websiteNeed: 0.25,
  serviceFit: 0.2,
  businessFit: 0.15,
  contactability: 0.15,
  freshness: 0.05,
  technicalOpportunity: 0.1,
  commercialRelevance: 0.1,
};

export interface LeadFitInput {
  company: {
    name: string;
    industry: string | null;
    categories: string[];
    city: string | null;
    country: string | null;
    businessStatus: string;
    rating: number | null;
    ratingCount: number | null;
    priceLevel: number | null;
    locations: number;
    isExistingClient: boolean;
    doNotContact: boolean;
  };
  website: { status: 'found' | 'not_found' | 'unreachable' | 'none'; analyzed: boolean; analysisStatus?: string | null };
  findings: FindingForScoring[];
  serviceFit: { score: number | null; serviceName: string | null };
  contacts: Array<{ type: string; status: string; isRoleBased?: boolean }>;
  freshness: { score: number; factors: ScoreFactor[] };
  nicheKey?: string | null;
  params?: Partial<SearchParams>;
  profile?: { preferredIndustries: string[]; excludedIndustries: string[]; preferredCountries: string[]; preferredCities: string[] };
  previouslyContacted: boolean;
  websiteAgeYears?: number | null;
  weights?: Partial<Record<ComponentKey, number>>;
}

const SEV_POINTS: Record<string, number> = { critical: 25, high: 15, medium: 8, low: 3, info: 0 };
const CONF_MULT: Record<string, number> = { high: 1, medium: 0.8, low: 0.5 };
const norm = (s: string) => stripDiacritics(s.toLowerCase()).trim();

function websiteNeed(i: LeadFitInput): ScoreComponent {
  const factors: ScoreFactor[] = [];
  if (i.website.status === 'not_found') {
    return { key: 'websiteNeed', label: COMPONENT_LABELS.websiteNeed, score: 90, weight: 0, factors: [{ label: 'No official website found', points: 90, kind: 'fact' }] };
  }
  if (i.website.status === 'unreachable' && !i.website.analyzed) {
    return { key: 'websiteNeed', label: COMPONENT_LABELS.websiteNeed, score: 55, weight: 0, factors: [{ label: 'Listed website could not be reached (cause unknown)', points: 55, kind: 'observation' }] };
  }
  if (!i.website.analyzed) {
    return { key: 'websiteNeed', label: COMPONENT_LABELS.websiteNeed, score: null, weight: 0, factors: [{ label: 'Website not analysed yet', points: 0, kind: 'gap' }] };
  }
  const negative = i.findings.filter((f) => f.polarity === 'negative');
  let points = 0;
  const byCategory = new Map<string, { pts: number; n: number; top: string; topPts: number }>();
  for (const f of negative) {
    const p = (SEV_POINTS[f.severity] ?? 3) * (CONF_MULT[f.confidence] ?? 0.8) * (f.kind === 'ai_observation' ? 0.6 : 1);
    points += p;
    const c = byCategory.get(f.category) ?? { pts: 0, n: 0, top: f.title, topPts: 0 };
    c.pts += p;
    c.n++;
    if (p > c.topPts) {
      c.top = f.title;
      c.topPts = p;
    }
    byCategory.set(f.category, c);
  }
  const score = Math.round(100 * (1 - Math.exp(-points / 60)));
  for (const [cat, c] of [...byCategory.entries()].sort((a, b) => b[1].pts - a[1].pts).slice(0, 5)) {
    factors.push({ label: `${c.n} ${cat} issue(s), e.g. “${c.top}”`, points: Math.round(c.pts), kind: cat === 'visual' && negative.every((f) => f.category !== 'visual' || f.kind === 'ai_observation') ? 'inference' : 'observation' });
  }
  if (negative.length === 0) factors.push({ label: 'No problems detected by the checks', points: 0, kind: 'observation' });
  if (i.website.analysisStatus === 'partial') factors.push({ label: 'Analysis was partial (some viewports failed)', points: 0, kind: 'gap' });
  return { key: 'websiteNeed', label: COMPONENT_LABELS.websiteNeed, score, weight: 0, factors };
}

function serviceFit(i: LeadFitInput): ScoreComponent {
  if (i.serviceFit.score == null) {
    return { key: 'serviceFit', label: COMPONENT_LABELS.serviceFit, score: null, weight: 0, factors: [{ label: 'No service could be evaluated', points: 0, kind: 'gap' }] };
  }
  return {
    key: 'serviceFit',
    label: COMPONENT_LABELS.serviceFit,
    score: i.serviceFit.score,
    weight: 0,
    factors: [{ label: `Evidence match for “${i.serviceFit.serviceName}”`, points: i.serviceFit.score, kind: 'inference' }],
  };
}

function sizeProxy(ratingCount: number | null, locations: number): 'small' | 'medium' | 'large' | null {
  if (locations >= 3) return 'large';
  if (ratingCount == null) return locations >= 2 ? 'medium' : null;
  if (ratingCount > 250 || locations >= 2) return ratingCount > 250 ? 'large' : 'medium';
  if (ratingCount >= 40) return 'medium';
  return 'small';
}

function businessFit(i: LeadFitInput): { component: ScoreComponent; disqualify: string | null } {
  const factors: ScoreFactor[] = [];
  let score = 50;
  let disqualify: string | null = null;
  const industryText = norm([i.company.industry, ...i.company.categories].filter(Boolean).join(' '));
  const matchesAny = (list: string[]) => list.find((x) => x && industryText.includes(norm(x)));
  const excluded = matchesAny([...(i.params?.excludedIndustries ?? []), ...(i.profile?.excludedIndustries ?? [])]);
  if (excluded) {
    disqualify = `Industry matches your excluded list (“${excluded}”)`;
    factors.push({ label: disqualify, points: -50, kind: 'fact' });
    score = 0;
  }
  const preferred = matchesAny([...(i.params?.preferredIndustries ?? []), ...(i.profile?.preferredIndustries ?? [])]);
  if (preferred) {
    score += 20;
    factors.push({ label: `Preferred industry (“${preferred}”)`, points: 20, kind: 'fact' });
  }
  const niche = NICHES.find((n) => n.key === i.nicheKey);
  if (i.params?.businessModel && i.params.businessModel !== 'any' && niche) {
    if (niche.businessModel === i.params.businessModel) {
      score += 10;
      factors.push({ label: `Business model matches (${niche.businessModel})`, points: 10, kind: 'inference' });
    } else {
      score -= 10;
      factors.push({ label: `Business model differs (${niche.businessModel} vs ${i.params.businessModel})`, points: -10, kind: 'inference' });
    }
  }
  if (i.company.city && i.profile?.preferredCities.some((c) => norm(c) === norm(i.company.city!))) {
    score += 5;
    factors.push({ label: 'Preferred city', points: 5, kind: 'fact' });
  }
  if (i.company.country && i.profile?.preferredCountries.some((c) => norm(c) === norm(i.company.country!))) {
    score += 5;
    factors.push({ label: 'Preferred country', points: 5, kind: 'fact' });
  }
  if (i.company.businessStatus === 'operational') {
    score += 10;
    factors.push({ label: 'Reported as operational by a source', points: 10, kind: 'fact' });
  } else if (i.company.businessStatus === 'closed_temporarily') {
    score -= 30;
    factors.push({ label: 'Reported as temporarily closed', points: -30, kind: 'fact' });
  } else if (i.company.businessStatus === 'closed_permanently') {
    disqualify = 'Reported as permanently closed by a source';
    score = 0;
    factors.push({ label: disqualify, points: -100, kind: 'fact' });
  } else {
    factors.push({ label: 'Operating status not reported by sources', points: 0, kind: 'gap' });
  }
  const size = sizeProxy(i.company.ratingCount, i.company.locations);
  const min = i.params?.minCompanySize ?? 'any';
  if (min !== 'any') {
    const order = { small: 1, medium: 2, large: 3 } as const;
    if (!size) factors.push({ label: 'Company size unknown (no review count / locations data)', points: 0, kind: 'gap' });
    else if (order[size] < order[min]) {
      score -= 25;
      factors.push({ label: `Size proxy “${size}” is below your minimum “${min}” (proxy: review count/locations)`, points: -25, kind: 'inference' });
    } else {
      score += 5;
      factors.push({ label: `Size proxy “${size}” meets minimum “${min}”`, points: 5, kind: 'inference' });
    }
  }
  if (i.params?.minWebsiteAgeYears && i.websiteAgeYears != null) {
    if (i.websiteAgeYears >= i.params.minWebsiteAgeYears) {
      score += 5;
      factors.push({ label: `Website age signal ≥ ${i.params.minWebsiteAgeYears} years (copyright year)`, points: 5, kind: 'observation' });
    } else {
      score -= 10;
      factors.push({ label: `Website age signal below ${i.params.minWebsiteAgeYears} years`, points: -10, kind: 'observation' });
    }
  }
  return { component: { key: 'businessFit', label: COMPONENT_LABELS.businessFit, score: clamp(Math.round(score), 0, 100), weight: 0, factors }, disqualify };
}

function contactability(i: LeadFitInput): ScoreComponent {
  const factors: ScoreFactor[] = [];
  let score = 0;
  const has = (type: string, status: string) => i.contacts.some((c) => c.type === type && c.status === status);
  if (has('email', 'verified')) {
    score += 45;
    factors.push({ label: 'E-mail published on the official website', points: 45, kind: 'fact' });
  } else if (has('email', 'probable')) {
    score += 30;
    factors.push({ label: 'E-mail from a business listing (not seen on the website)', points: 30, kind: 'fact' });
  }
  if (has('contact_form', 'verified')) {
    score += 30;
    factors.push({ label: 'Contact form on the website', points: 30, kind: 'fact' });
  }
  if (has('phone', 'verified')) {
    score += 25;
    factors.push({ label: 'Phone verified (website or 2+ sources)', points: 25, kind: 'fact' });
  } else if (has('phone', 'probable')) {
    score += 15;
    factors.push({ label: 'Phone from one business listing', points: 15, kind: 'fact' });
  }
  if (i.contacts.some((c) => c.type === 'social' && c.status !== 'unverified')) {
    score += 10;
    factors.push({ label: 'Public social profile', points: 10, kind: 'fact' });
  }
  if (factors.length === 0) factors.push({ label: 'No public business contact found', points: 0, kind: 'gap' });
  return { key: 'contactability', label: COMPONENT_LABELS.contactability, score: Math.min(100, score), weight: 0, factors };
}

function technicalOpportunity(i: LeadFitInput): ScoreComponent {
  if (!i.website.analyzed) return { key: 'technicalOpportunity', label: COMPONENT_LABELS.technicalOpportunity, score: null, weight: 0, factors: [{ label: 'No technical analysis available', points: 0, kind: 'gap' }] };
  const codes = new Set(i.findings.filter((f) => f.polarity === 'negative' && f.kind !== 'ai_observation' && ['technical', 'performance', 'seo', 'accessibility', 'security'].includes(f.category)).map((f) => f.code));
  const score = Math.min(100, codes.size * 12);
  return { key: 'technicalOpportunity', label: COMPONENT_LABELS.technicalOpportunity, score, weight: 0, factors: [{ label: `${codes.size} distinct technical/performance/SEO/accessibility issue types measured`, points: score, kind: 'observation' }] };
}

function commercialRelevance(i: LeadFitInput): ScoreComponent {
  const factors: ScoreFactor[] = [];
  let score = 30;
  let known = 0;
  const c = i.company;
  if (c.priceLevel != null) {
    known++;
    const p = c.priceLevel >= 3 ? 25 : c.priceLevel === 2 ? 10 : -5;
    score += p;
    factors.push({ label: `Price level ${'$'.repeat(Math.max(1, c.priceLevel))} (source data)`, points: p, kind: 'fact' });
  }
  if (c.ratingCount != null) {
    known++;
    const p = c.ratingCount > 200 ? 25 : c.ratingCount > 50 ? 15 : c.ratingCount > 10 ? 5 : 0;
    score += p;
    factors.push({ label: `${c.ratingCount} public reviews (activity proxy)`, points: p, kind: 'fact' });
  }
  if (c.locations >= 2) {
    known++;
    score += 15;
    factors.push({ label: `${c.locations} locations`, points: 15, kind: 'fact' });
  }
  const niche = NICHES.find((n) => n.key === i.nicheKey);
  const text = norm(`${c.name} ${c.categories.join(' ')}`);
  const hint = niche?.premiumHints?.find((h) => text.includes(norm(h)));
  if (hint) {
    score += 10;
    factors.push({ label: `Premium-positioning keyword in name/category (“${hint}”)`, points: 10, kind: 'inference' });
  }
  if (niche && ['healthcare', 'professional_services'].includes(niche.businessModel)) {
    score += 5;
    factors.push({ label: `High-value service industry (${niche.businessModel.replace('_', ' ')})`, points: 5, kind: 'inference' });
  }
  const seg = i.params?.priceSegment;
  if (seg && seg !== 'any' && c.priceLevel != null) {
    const match = (seg === 'premium' && c.priceLevel >= 3) || (seg === 'mid' && c.priceLevel === 2) || (seg === 'budget' && c.priceLevel <= 1);
    score += match ? 10 : -10;
    factors.push({ label: `Target price segment “${seg}” ${match ? 'matches' : 'does not match'}`, points: match ? 10 : -10, kind: 'fact' });
  }
  if (known === 0) factors.push({ label: 'No price level / review volume / locations data — commercial signals unknown', points: 0, kind: 'gap' });
  return { key: 'commercialRelevance', label: COMPONENT_LABELS.commercialRelevance, score: clamp(Math.round(score), 0, 100), weight: 0, factors };
}

export function computeLeadFit(i: LeadFitInput): LeadFitResult {
  const weights = { ...DEFAULT_WEIGHTS, ...(i.weights ?? {}) };
  const bf = businessFit(i);
  const base: ScoreComponent[] = [
    websiteNeed(i),
    serviceFit(i),
    bf.component,
    contactability(i),
    { key: 'freshness' as const, label: COMPONENT_LABELS.freshness, score: i.freshness.score, weight: 0, factors: i.freshness.factors },
    technicalOpportunity(i),
    commercialRelevance(i),
  ];
  const components: ScoreComponent[] = base.map((c) => ({ ...c, weight: weights[c.key] }));

  const totalW = components.reduce((s, c) => s + c.weight, 0);
  const withData = components.filter((c) => c.score != null);
  const dataW = withData.reduce((s, c) => s + c.weight, 0);
  const leadFit = dataW > 0 ? Math.round(withData.reduce((s, c) => s + c.weight * (c.score ?? 0), 0) / dataW) : null;
  const dataCompleteness = totalW > 0 ? Math.round((dataW / totalW) * 100) / 100 : 0;
  const get = (k: ComponentKey) => components.find((c) => c.key === k)?.score ?? null;

  const reasons: string[] = [];
  let priority: Priority;
  const exclusion =
    bf.disqualify ??
    (i.company.doNotContact ? 'Marked “do not contact”' : null) ??
    (i.params?.excludeExistingClients !== false && i.company.isExistingClient ? 'Existing client (excluded by your filter)' : null) ??
    (i.params?.excludePreviouslyContacted !== false && i.previouslyContacted ? 'Previously contacted (excluded by your filter)' : null) ??
    (i.params?.onlyWithWebsite && i.website.status === 'not_found' ? 'No website (you asked for businesses with websites only)' : null) ??
    (i.params?.onlyWithPublicContact && (get('contactability') ?? 0) === 0 ? 'No public contact (you asked for contactable businesses only)' : null);

  const wn = get('websiteNeed');
  const sf = get('serviceFit');
  const ct = get('contactability') ?? 0;
  if (exclusion) {
    priority = 'excluded';
    reasons.push(exclusion);
  } else if (leadFit == null || dataCompleteness < 0.6 || (i.website.status === 'found' && !i.website.analyzed)) {
    priority = 'insufficient_data';
    reasons.push(i.website.status === 'found' && !i.website.analyzed ? 'Website found but not analysed yet' : `Only ${Math.round(dataCompleteness * 100)}% of scoring inputs are available`);
  } else if (leadFit >= 72 && (wn ?? 0) >= 60 && (sf ?? 0) >= 55 && ct >= 40) priority = 'very_high';
  else if (leadFit >= 60 && (wn ?? 0) >= 45 && ct >= 25) priority = 'high';
  else if (leadFit >= 45) priority = 'medium';
  else priority = 'low';

  if (priority !== 'excluded' && priority !== 'insufficient_data' && i.params?.minWebsiteNeed != null && (wn ?? 0) < i.params.minWebsiteNeed) {
    priority = 'low';
    reasons.push(`Website Need ${wn ?? '—'} is below your minimum of ${i.params.minWebsiteNeed}`);
  }

  if (priority !== 'excluded') {
    const top = [...components].filter((c) => c.score != null).sort((a, b) => b.weight * (b.score ?? 0) - a.weight * (a.score ?? 0));
    for (const c of top.slice(0, 3)) {
      const f = c.factors.filter((x) => x.kind !== 'gap').sort((a, b) => Math.abs(b.points) - Math.abs(a.points))[0];
      reasons.push(`${c.label} ${c.score}${f ? ` — ${f.label}` : ''}`);
    }
    const weak = components.filter((c) => c.score != null && c.score < 30 && c.weight >= 0.1);
    for (const c of weak.slice(0, 2)) reasons.push(`Weak: ${c.label} ${c.score}`);
    const gaps = components.filter((c) => c.score == null);
    if (gaps.length) reasons.push(`Unknown: ${gaps.map((g) => g.label).join(', ')}`);
  }
  return { leadFit, components, priority, priorityReasons: reasons, dataCompleteness };
}
