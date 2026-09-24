import { describe, expect, it } from 'vitest';
import { templateOutreach, TONES, type OutreachFacts } from '../../src/engine/reports/outreach.js';
import { lintOutreach } from '../../src/engine/reports/lint.js';
import { auditToHtml, auditToMarkdown, buildAudit, type AuditInput } from '../../src/engine/reports/audit.js';
import { langFor, renderPhrase } from '../../src/engine/reports/phrases.js';
import { matchPortfolio, type PortfolioProjectInput } from '../../src/engine/portfolio/portfolio-matching.js';

const facts = (over: Partial<OutreachFacts> = {}): OutreachFacts => ({
  company: 'Smile Dental',
  industry: 'dental clinic',
  city: 'Warsaw',
  website: 'https://smile-dental.pl',
  contactName: null,
  hasWebsite: true,
  observations: [
    { findingId: 'f1', code: 'mobile.no_viewport_meta', title: 'No viewport', detail: 'x' },
    { findingId: 'f2', code: 'ux.cta_below_fold_mobile', title: 'CTA below fold', detail: 'y' },
    { findingId: 'f3', code: 'tech.js_errors', title: 'JS errors', detail: 'z' },
  ],
  service: { name: 'Website redesign', slug: 'website-redesign' },
  portfolio: null,
  sender: { name: 'Anna', studio: 'Pixel Studio', website: 'https://pixel.studio', role: null },
  ...over,
});

describe('outreach templates', () => {
  it('every tone and language produces a lint-clean, personalised draft based on evidence', () => {
    for (const lang of ['en', 'pl', 'ru', 'uk', 'de']) {
      for (const tone of TONES) {
        const d = templateOutreach(facts(), tone, lang);
        expect(`${d.subject}\n${d.body}`).toContain('Smile Dental');
        expect(d.lint.filter((l) => l.level === 'error')).toEqual([]);
        expect(d.usedFindingIds.length).toBeGreaterThan(0);
        expect(d.usedFindingIds.every((id) => ['f1', 'f2', 'f3'].includes(id))).toBe(true);
        expect(d.generator).toBe('template');
        expect(d.body).not.toMatch(/\{[a-z]+\}/); // no unfilled placeholders
        expect(d.body).not.toMatch(/undefined|null/);
      }
    }
  });

  it('ultra short uses a single observation', () => {
    const d = templateOutreach(facts(), 'ultra_short', 'en');
    expect(d.usedFindingIds).toHaveLength(1);
    expect(d.body.length).toBeLessThan(450);
  });

  it('works without a sender name (no empty "My name is")', () => {
    const d = templateOutreach(facts({ sender: { name: null, studio: null, website: null, role: null } }), 'professional', 'en');
    expect(d.body).not.toMatch(/name is\s*[.,]/i);
  });

  it('companies without a website get the no-website observation', () => {
    const d = templateOutreach(facts({ hasWebsite: false, website: null, observations: [] }), 'friendly', 'pl');
    expect(d.body).toContain(renderPhrase('no_website', 'pl', { company: 'Smile Dental' })!);
  });

  it('without any phrase-able observation it says so instead of inventing one', () => {
    const d = templateOutreach(facts({ observations: [{ findingId: 'x', code: 'seo.hreflang_weird', title: 't', detail: 'd' }] }), 'professional', 'en');
    expect(d.usedFindingIds).toEqual([]);
    expect(d.note).toMatch(/add a specific observation/);
  });

  it('mentions a portfolio project only when provided', () => {
    const withP = templateOutreach(facts({ portfolio: { name: 'Nova Dental', url: 'https://nova.example', reason: 'same industry' } }), 'professional', 'en');
    expect(withP.portfolioUsed).toBe(true);
    expect(withP.body).toContain('Nova Dental');
    expect(templateOutreach(facts(), 'professional', 'en').portfolioUsed).toBe(false);
  });

  it('langFor falls back to English', () => {
    expect(langFor('pl-PL')).toBe('pl');
    expect(langFor('ja')).toBe('en');
    expect(langFor(null)).toBe('en');
  });
});

describe('outreach linter', () => {
  const ctx = { companyName: 'Smile Dental', tone: 'professional' };
  it('flags guarantees, fake urgency, outcome and loss claims, invented statistics', () => {
    const rules = lintOutreach('Last chance!', 'We guarantee to double your sales. You are losing patients. 73% of users leave. Smile Dental', ctx).map((i) => i.rule);
    expect(rules).toEqual(expect.arrayContaining(['guarantee', 'false_urgency', 'outcome_claim', 'loss_claim', 'unsupported_statistic']));
  });

  it('allows percentages that come from evidence', () => {
    const issues = lintOutreach('Hi', 'Smile Dental: 42% of images lack alt text.', { ...ctx, allowedNumbers: ['42'] });
    expect(issues.find((i) => i.rule === 'unsupported_statistic')).toBeUndefined();
  });

  it('flags drafts that do not mention the company', () => {
    expect(lintOutreach('Hi', 'Hello there.', ctx).map((i) => i.rule)).toContain('not_personalised');
  });

  it('flags Polish and Russian loss claims', () => {
    expect(lintOutreach('', 'Smile Dental tracicie klientów', ctx).some((i) => i.rule === 'loss_claim')).toBe(true);
    expect(lintOutreach('', 'Smile Dental, вы теряете клиентов', ctx).some((i) => i.rule === 'loss_claim')).toBe(true);
  });
});

describe('audit', () => {
  const input = (over: Partial<AuditInput> = {}): AuditInput => ({
    company: { name: 'Smile <Dental>', website: 'https://smile-dental.pl', city: 'Warsaw', industry: 'dentist' },
    analysis: { at: new Date('2026-09-20T10:00:00Z'), pages: 3, lighthouseRan: false, aiStatus: 'skipped', status: 'completed' },
    websiteStatus: 'found',
    findings: [
      { findingId: 'f1', title: 'No viewport <meta>', detail: 'Page renders at desktop width <script>alert(1)</script>', category: 'responsive', severity: 'critical', kind: 'observed', confidence: 'high', evidence: [{ type: 'html', label: 'head', value: '<meta charset="utf-8">' }], pageUrl: 'https://smile-dental.pl', viewport: 'mobile', problemTags: ['mobile_experience'], polarity: 'negative' },
      { findingId: 'f2', title: 'Hero looks dated', detail: 'Subjective', category: 'visual', severity: 'medium', kind: 'ai_observation', confidence: 'medium', evidence: [], pageUrl: null, viewport: 'desktop', problemTags: ['outdated_design'], polarity: 'negative' },
      { findingId: 'f3', title: 'HTTPS works', detail: 'Valid certificate', category: 'technical', severity: 'info', kind: 'observed', confidence: 'high', evidence: [], pageUrl: null, viewport: null, problemTags: [], polarity: 'positive' },
    ],
    services: { primary: { name: 'Website redesign', slug: 'website-redesign', reasons: ['Mobile experience issues'] }, secondary: null, doNot: [] },
    priority: { level: 'very_high', reasons: ['Website need 90'] },
    interpretations: [],
    screenshots: [{ id: 's1', viewport: 'desktop', kind: 'viewport' }, { id: 's2', viewport: 'desktop', kind: 'fullpage' }],
    ...over,
  });

  it('separates working/problem items, orders objective before AI, and states limitations honestly', () => {
    const a = buildAudit(input());
    expect(a.working.map((w) => w.title)).toEqual(['HTTPS works']);
    expect(a.problems.map((p) => p.findingId)).toEqual(['f1', 'f2']);
    expect(a.limitations.join(' ')).toMatch(/Lighthouse was not run/);
    expect(a.limitations.join(' ')).toMatch(/not measured and is not claimed/);
    expect(a.scope.length).toBeGreaterThan(0);
    expect(a.screenshots.map((s) => s.id)).toEqual(['s1']);
    expect(a.improvements[0]!.findingIds.length).toBeGreaterThan(0);
  });

  it('no-website audit does not pretend a site was analysed', () => {
    const a = buildAudit(input({ websiteStatus: 'not_found', analysis: null, findings: [], services: { primary: { name: 'New business website', slug: 'new-business-website', reasons: [] }, secondary: null, doNot: [] } }));
    expect(a.executiveSummary[0]).toMatch(/No official website was found/);
    expect(a.executiveSummary.join(' ')).not.toMatch(/analysed live/);
  });

  it('HTML export escapes untrusted text and hides internal priority from clients', () => {
    const a = buildAudit(input());
    const html = auditToHtml(a, { s1: 'data:image/png;base64,AAAA' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Smile &lt;Dental&gt;');
    expect(html).toContain('AI observation (subjective)');
    expect(html).toContain('data:image/png;base64,AAAA');
    expect(html).not.toContain('Very High');
    expect(auditToHtml(a, {}, { internal: true })).toContain('Very High');
  });

  it('markdown export contains all sections', () => {
    const md = auditToMarkdown(buildAudit(input({ language: 'pl' })));
    expect(md).toMatch(/Audyt strony internetowej/);
    expect(md).toMatch(/Metodologia/);
  });
});

describe('portfolio matching', () => {
  const projects: PortfolioProjectInput[] = [
    { id: 'p1', name: 'Nova Dental', url: 'https://nova.example', industry: 'dentist', technologies: ['WordPress'], styles: [], services: ['website-redesign'], active: true },
    { id: 'p2', name: 'Pizza Roma', url: null, industry: 'restaurant', technologies: ['Webflow'], styles: [], services: ['landing-page'], active: true },
    { id: 'p3', name: 'Old Dental', url: null, industry: 'dentist', technologies: [], styles: [], services: ['website-redesign'], active: false },
  ];

  it('suggests a genuinely similar project with reasons', () => {
    const r = matchPortfolio(projects, { industry: 'dental clinic', categories: ['dentist'], recommendedServices: ['website-redesign'], platform: 'WordPress' });
    expect(r.best?.projectId).toBe('p1');
    expect(r.best!.reasons.join(' ')).toMatch(/same industry/);
    expect(r.ranked.some((x) => x.projectId === 'p3')).toBe(false);
  });

  it('suggests nothing when no project is similar enough', () => {
    const r = matchPortfolio(projects, { industry: 'law firm', categories: ['lawyer'], recommendedServices: ['seo-basics'], platform: 'WordPress' });
    expect(r.best).toBeNull();
    expect(r.note).toBeTruthy();
  });
});
