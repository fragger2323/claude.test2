import { describe, expect, it } from 'vitest';
import { buildDecisionIntel, type DecisionInput } from '../../src/engine/fit/decision-intel.js';
import type { LeadFitResult, ServiceMatch } from '../../src/domain/types.js';

const fit: LeadFitResult = { leadFit: 80, components: [], priority: 'very_high', priorityReasons: ['Website Need 90'], dataCompleteness: 1 };
const svc = (slug: string, name: string, tags: string[]): ServiceMatch => ({ serviceSlug: slug, serviceName: name, fitScore: 70, kind: 'primary', reasons: tags.map((t) => ({ text: t, findingIds: [], tag: t as never })), exclusionReasons: [] });
const finding = (id: string, severity: string, category: string, tags: string[], extra: Partial<DecisionInput['findings'][number]> = {}) => ({ id, code: `c.${id}`, title: `Finding ${id}`, category, polarity: 'negative', severity, confidence: 'high', kind: 'observed', problemTags: tags as never[], detail: `detail ${id}`, ...extra });

function input(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    company: { name: 'Smile', city: 'Warsaw', country: 'PL', sources: ['google_places', 'osm'], ratingCount: 87, rating: 4.2, businessStatus: 'operational', firstSeenAt: new Date('2026-09-01'), discrepancies: 0 },
    website: { status: 'found', url: 'https://smile.pl', platform: null, notFoundReason: null },
    analysis: { at: new Date('2026-09-23'), lighthouseRan: false, aiObservations: 0, diff: null, status: 'completed' },
    findings: [
      finding('m1', 'critical', 'responsive', ['mobile_experience']),
      finding('s1', 'low', 'seo', ['seo_foundation']),
      finding('s2', 'low', 'seo', ['seo_foundation']),
      finding('s3', 'low', 'seo', ['seo_foundation']),
      finding('t1', 'medium', 'technical', ['maintenance']),
    ],
    fit,
    services: { primary: svc('website-redesign', 'Website redesign', ['mobile_experience', 'outdated_design']), secondary: svc('website-maintenance', 'Website maintenance', ['maintenance']), doNotRecommend: [] },
    contacts: [
      { type: 'email', value: 'info@smile.pl', status: 'verified', isRoleBased: true, isPersonal: false, sourceUrl: 'https://smile.pl' },
      { type: 'contact_form', value: 'https://smile.pl/kontakt', status: 'verified', isRoleBased: false, isPersonal: false, sourceUrl: 'https://smile.pl/kontakt' },
    ],
    freshness: { label: 'fresh', lastVerifiedAt: new Date('2026-09-23'), sources: [] },
    now: new Date('2026-09-24'),
    ...over,
  };
}

describe('decision intelligence', () => {
  it('one severe customer-visible problem outranks several minor SEO notes', () => {
    const d = buildDecisionIntel(input());
    expect(d.mainPainPoint?.title).toMatch(/Mobile/i);
    expect(d.mainPainPoint?.findingIds).toEqual(['m1']);
  });

  it('a pain point names only a service whose evidence addresses it', () => {
    const d = buildDecisionIntel(input());
    expect(d.mainPainPoint?.interpretation).toMatch(/website redesign/);
    for (const p of [d.mainPainPoint, d.secondaryPainPoint]) {
      if (p && !/maintenance|outdated components/i.test(p.title)) expect(p.interpretation).not.toMatch(/maintenance/);
    }
    const seo = buildDecisionIntel(input({ findings: [finding('s1', 'high', 'seo', ['seo_foundation'])] }));
    expect(seo.mainPainPoint?.interpretation).not.toMatch(/opportunity for/);
  });

  it('never claims what was not measured, and adapts the list to the data', () => {
    const d = buildDecisionIntel(input({ website: { status: 'unreachable', url: 'https://smile.pl', platform: null, notFoundReason: null }, company: { ...input().company, discrepancies: 2 } }));
    const claims = d.whatNotToClaim.join(' ');
    expect(claims).toMatch(/losing clients/);
    expect(claims).toMatch(/Lighthouse was not run/);
    expect(claims).toMatch(/business is closed/);
    expect(claims).toMatch(/Sources disagree/);
  });

  it('prefers a permission-first contact form in EU countries and always adds a compliance note', () => {
    const pl = buildDecisionIntel(input());
    expect(pl.bestContactChannel?.channel).toBe('contact_form');
    expect(pl.bestContactChannel?.complianceNote).toMatch(/consent/);
    const us = buildDecisionIntel(input({ company: { ...input().company, country: 'US' } }));
    expect(us.bestContactChannel?.channel).toBe('email');
  });

  it('why-now only uses real signals', () => {
    const neutral = buildDecisionIntel(input({ analysis: { at: new Date('2026-08-01'), lighthouseRan: false, aiObservations: 0, diff: null, status: 'completed' } }));
    expect(neutral.whyNow).toEqual(['No time-sensitive signal detected — timing is neutral.']);
    const fresh = buildDecisionIntel(input({ company: { ...input().company, firstSeenAt: new Date('2026-09-22') } }));
    expect(fresh.whyNow.join(' ')).toMatch(/Newly discovered/);
  });

  it('what to mention references real findings', () => {
    const d = buildDecisionIntel(input());
    expect(d.whatToMention.length).toBeGreaterThan(0);
    for (const m of d.whatToMention) expect(['m1', 's1', 's2', 's3', 't1']).toContain(m.findingId);
    expect(d.knowledge.unknown.join(' ')).toMatch(/Budget/);
  });
});
