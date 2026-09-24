import { describe, expect, it } from 'vitest';
import type { ProblemTag } from '../../src/domain/types.js';
import { DEFAULT_SERVICES } from '../../src/engine/fit/service-catalog.js';
import { matchServices, resolveRequestedService, tagEvidence, type FindingForScoring } from '../../src/engine/fit/service-matching.js';
import { computeLeadFit, type LeadFitInput } from '../../src/engine/fit/lead-fit.js';
import { heuristicPotential, salesPotential } from '../../src/engine/fit/sales-potential.js';
import { computeFreshness } from '../../src/engine/freshness/freshness.js';

let n = 0;
function f(tags: ProblemTag[], severity = 'high', extra: Partial<FindingForScoring> = {}): FindingForScoring {
  n += 1;
  return { id: `f${n}`, code: `code_${n}`, title: `Finding ${n}`, category: 'ux', polarity: 'negative', severity, confidence: 'high', kind: 'observed', problemTags: tags, ...extra };
}

const outdated = (): FindingForScoring[] => [
  f(['mobile_experience', 'responsive_bugs'], 'critical', { category: 'responsive' }),
  f(['outdated_design'], 'high', { category: 'visual' }),
  f(['outdated_design', 'maintenance'], 'medium', { category: 'technical' }),
  f(['weak_cta', 'conversion_path'], 'high', { category: 'ux' }),
  f(['broken_links'], 'medium', { category: 'technical' }),
  f(['seo_foundation'], 'medium', { category: 'seo' }),
  f(['trust_signals'], 'medium', { category: 'ux' }),
  f(['performance', 'heavy_assets'], 'medium', { category: 'performance' }),
];

const baseCompany: LeadFitInput['company'] = {
  name: 'Smile Dental', industry: 'dentist', categories: ['dentist'], city: 'Warsaw', country: 'PL', businessStatus: 'operational',
  rating: 4.7, ratingCount: 140, priceLevel: 3, locations: 1, isExistingClient: false, doNotContact: false,
};

function fitInput(over: Partial<LeadFitInput> = {}): LeadFitInput {
  return {
    company: baseCompany,
    website: { status: 'found', analyzed: true, analysisStatus: 'completed' },
    findings: outdated(),
    serviceFit: { score: 80, serviceName: 'Website redesign' },
    contacts: [{ type: 'email', status: 'verified', isRoleBased: true }, { type: 'phone', status: 'verified' }],
    freshness: { score: 90, factors: [] },
    nicheKey: 'dentist',
    params: { excludeExistingClients: true, excludePreviouslyContacted: true },
    previouslyContacted: false,
    ...over,
  };
}

describe('service matching', () => {
  it('AI observations weigh less than objective findings', () => {
    const obj = tagEvidence([f(['outdated_design'], 'high')]).get('outdated_design')!.strength;
    const ai = tagEvidence([f(['outdated_design'], 'high', { kind: 'ai_observation' })]).get('outdated_design')!.strength;
    expect(ai).toBeLessThan(obj);
    expect(tagEvidence([f(['outdated_design'], 'high', { polarity: 'positive' })]).size).toBe(0);
  });

  it('resolves free-text services to the catalogue', () => {
    expect(resolveRequestedService('premium website redesign', DEFAULT_SERVICES)?.slug).toMatch(/redesign|premium/);
    expect(resolveRequestedService('landing-page', DEFAULT_SERVICES)?.slug).toBe('landing-page');
    expect(resolveRequestedService('dog grooming', DEFAULT_SERVICES)).toBeNull();
  });

  it('an outdated site gets a redesign-type primary with evidence and a different secondary', () => {
    const r = matchServices(DEFAULT_SERVICES, outdated(), { hasWebsite: true, commercialRelevance: 70 }, 'website redesign');
    expect(r.primary?.serviceSlug).toBe('website-redesign');
    expect(r.primary!.reasons.length).toBeGreaterThan(0);
    expect(r.primary!.reasons[0]!.findingIds.length).toBeGreaterThan(0);
    expect(r.secondary).not.toBeNull();
    expect(r.secondary!.serviceSlug).not.toBe(r.primary!.serviceSlug);
    const newSite = r.all.find((m) => m.serviceSlug === 'new-business-website')!;
    expect(newSite.exclusionReasons.join(' ')).toMatch(/already has a website/);
    expect([r.primary?.serviceSlug, r.secondary?.serviceSlug]).not.toContain('new-business-website');
  });

  it('a company without a website gets a new website, never a redesign', () => {
    const r = matchServices(DEFAULT_SERVICES, [], { hasWebsite: false, commercialRelevance: 60 });
    expect(r.primary?.serviceSlug).toBe('new-business-website');
    const redesign = r.all.find((m) => m.serviceSlug === 'website-redesign')!;
    expect(redesign.exclusionReasons.join(' ')).toMatch(/No official website/);
    expect(r.secondary?.serviceSlug).not.toBe('website-redesign');
    // big-ticket services without evidence are explicitly called out
    expect(r.doNotRecommend.some((m) => m.serviceSlug === 'premium-website-design')).toBe(true);
  });

  it('a clean modern site yields no strong recommendation', () => {
    const r = matchServices(DEFAULT_SERVICES, [f(['seo_foundation'], 'low')], { hasWebsite: true, commercialRelevance: 50 });
    expect(r.primary === null || r.primary.fitScore < 60).toBe(true);
  });

  it('respects disallowed services from My Business', () => {
    const r = matchServices(DEFAULT_SERVICES, outdated(), { hasWebsite: true, commercialRelevance: 70, disallowed: ['website-redesign'] });
    expect(r.primary?.serviceSlug).not.toBe('website-redesign');
    expect(r.doNotRecommend.find((m) => m.serviceSlug === 'website-redesign')?.exclusionReasons.join(' ')).toMatch(/disallowed/);
  });
});

describe('lead fit & priority', () => {
  it('outdated site + strong service fit + contacts → high/very high with transparent components', () => {
    const r = computeLeadFit(fitInput());
    expect(['very_high', 'high']).toContain(r.priority);
    expect(r.leadFit).toBeGreaterThanOrEqual(60);
    expect(r.components.map((c) => c.key).sort()).toEqual(['businessFit', 'commercialRelevance', 'contactability', 'freshness', 'serviceFit', 'technicalOpportunity', 'websiteNeed']);
    const weights = r.components.reduce((s, c) => s + c.weight, 0);
    expect(weights).toBeCloseTo(1, 5);
    expect(r.priorityReasons.length).toBeGreaterThan(0);
  });

  it('modern site without problems → low priority', () => {
    const r = computeLeadFit(fitInput({ findings: [], serviceFit: { score: 10, serviceName: null } }));
    expect(['low', 'medium']).toContain(r.priority);
    expect(r.leadFit!).toBeLessThan(computeLeadFit(fitInput()).leadFit!);
  });

  it('website found but not analysed → insufficient data, not a guess', () => {
    const r = computeLeadFit(fitInput({ website: { status: 'found', analyzed: false } }));
    expect(r.priority).toBe('insufficient_data');
  });

  it('exclusions are explicit', () => {
    expect(computeLeadFit(fitInput({ company: { ...baseCompany, isExistingClient: true } })).priority).toBe('excluded');
    expect(computeLeadFit(fitInput({ company: { ...baseCompany, doNotContact: true } })).priorityReasons[0]).toMatch(/do not contact/);
    expect(computeLeadFit(fitInput({ previouslyContacted: true })).priority).toBe('excluded');
    expect(computeLeadFit(fitInput({ previouslyContacted: true, params: { excludePreviouslyContacted: false } })).priority).not.toBe('excluded');
    expect(computeLeadFit(fitInput({ company: { ...baseCompany, businessStatus: 'closed_permanently' } })).priority).toBe('excluded');
  });

  it('minimum website need caps priority with a reason', () => {
    const r = computeLeadFit(fitInput({ params: { minWebsiteNeed: 99 } }));
    expect(r.priority).toBe('low');
    expect(r.priorityReasons.join(' ')).toMatch(/below your minimum/);
  });
});

describe('sales potential', () => {
  it('Mode A is a level with factors, never a probability', () => {
    const fit = computeLeadFit(fitInput());
    const sp = salesPotential(fit, null, null);
    expect(sp.mode).toBe('A');
    expect(sp).not.toHaveProperty('probability');
    expect(['high', 'medium', 'low']).toContain(heuristicPotential(fit).level);
  });

  it('excluded leads are always low', () => {
    const fit = computeLeadFit(fitInput({ company: { ...baseCompany, doNotContact: true } }));
    expect(heuristicPotential(fit).level).toBe('low');
  });
});

describe('freshness', () => {
  const now = new Date('2026-09-24T00:00:00Z');
  it('recent corroborated data is fresh', () => {
    const r = computeFreshness({ sourceFetches: [new Date('2026-09-23'), new Date('2026-09-20')], lastVerifiedAt: null, analysisAt: null, businessStatus: 'operational', discrepancyCount: 0, providerCount: 2, now });
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.label).toBe('fresh');
  });

  it('old data ages, conflicts reduce, permanently closed zeroes', () => {
    const old = computeFreshness({ sourceFetches: [new Date('2026-01-01')], lastVerifiedAt: null, analysisAt: null, businessStatus: 'operational', discrepancyCount: 0, providerCount: 1, now });
    expect(old.score).toBeLessThan(40);
    const conflict = computeFreshness({ sourceFetches: [new Date('2026-09-23')], lastVerifiedAt: null, analysisAt: null, businessStatus: 'operational', discrepancyCount: 2, providerCount: 1, now });
    expect(conflict.score).toBe(90);
    const closed = computeFreshness({ sourceFetches: [new Date('2026-09-23')], lastVerifiedAt: null, analysisAt: null, businessStatus: 'closed_permanently', discrepancyCount: 0, providerCount: 1, now });
    expect(closed.score).toBe(0);
  });

  it('an unreachable website is not treated as closed', () => {
    const r = computeFreshness({ sourceFetches: [new Date('2026-09-23')], lastVerifiedAt: null, analysisAt: null, businessStatus: 'operational', discrepancyCount: 0, providerCount: 1, websiteStatus: 'unreachable', now });
    expect(r.score).toBe(100);
    expect(r.factors.some((x) => /not treated as closed/.test(x.label))).toBe(true);
  });

  it('no dated information → unknown', () => {
    expect(computeFreshness({ sourceFetches: [], lastVerifiedAt: null, analysisAt: null, businessStatus: 'unknown', discrepancyCount: 0, providerCount: 0, now }).label).toBe('unknown');
  });
});
