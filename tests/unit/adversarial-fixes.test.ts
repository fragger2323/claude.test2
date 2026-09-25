import { describe, expect, it } from 'vitest';
import { discoverWebsite } from '../../src/engine/discovery/website-discovery.js';
import { computeLeadFit, type LeadFitInput } from '../../src/engine/fit/lead-fit.js';
import { matchServices } from '../../src/engine/fit/service-matching.js';
import { DEFAULT_SERVICES } from '../../src/engine/fit/service-catalog.js';
import { resolveContacts, type ContactObservation } from '../../src/engine/contacts/contact-discovery.js';
import { classifyNonOfficialDomain } from '../../src/lib/url.js';
import { businessNameFromTitle } from '../../src/providers/search/index.js';
import { looksLikeChallenge } from '../../src/providers/website/challenge.js';
import { buildOverpassQuery, normalizeOsmElement } from '../../src/providers/osm/index.js';
import type { FetchedPage } from '../../src/providers/website/fetcher.js';

const company = { name: 'Gabinet Kowalski', city: 'Warszawa', country: 'PL', phones: ['+48 601 111 222'], address: 'Grójecka 50' };
const page = (url: string): FetchedPage => ({ ok: true, status: 200, url, finalUrl: url, redirects: [], html: '', title: '', text: '' });

describe('website existence is never assumed', () => {
  it('no listed website and no web search → "unverified", not "no website"', async () => {
    const d = await discoverWebsite(company, [], { fetchHomepage: async (u) => page(u), searchAvailable: false });
    expect(d.status).toBe('unverified');
    expect(d.notFoundReason).toMatch(/not verified.*web search is not configured/);
  });

  it('a source listing only a social profile as the website is evidence of no own site', async () => {
    const d = await discoverWebsite(company, [{ url: 'https://facebook.com/gabinet', source: 'google_places', evidence: 'websiteUri' }], { fetchHomepage: async (u) => page(u), searchAvailable: false });
    expect(d.status).toBe('not_found');
  });

  it('an unverified website gives no website need score, no pitch and insufficient-data priority', () => {
    const input: LeadFitInput = {
      company: { name: 'Gabinet Kowalski', industry: 'dentist', categories: [], city: 'Warszawa', country: 'PL', businessStatus: 'operational', rating: 4.7, ratingCount: 23, priceLevel: null, locations: 1, isExistingClient: false, doNotContact: false },
      website: { status: 'unverified', analyzed: false },
      findings: [],
      serviceFit: { score: null, serviceName: null },
      contacts: [{ type: 'phone', status: 'probable' }],
      freshness: { score: 85, factors: [] },
      previouslyContacted: false,
    };
    const fit = computeLeadFit(input);
    expect(fit.priority).toBe('insufficient_data');
    expect(fit.components.find((c) => c.key === 'websiteNeed')!.score).toBeNull();
    const m = matchServices(DEFAULT_SERVICES, [], { hasWebsite: false, websiteUnknown: true, commercialRelevance: 50 });
    expect(m.primary).toBeNull();
    expect(m.all.find((x) => x.serviceSlug === 'new-business-website')!.fitScore).toBe(0);
  });

  it('a failed or blocked analysis says so instead of "not analysed yet", and concludes nothing', () => {
    const base: LeadFitInput = {
      company: { name: 'Gabinet Kowalski', industry: 'dentist', categories: [], city: 'Warszawa', country: 'PL', businessStatus: 'operational', rating: 4.7, ratingCount: 23, priceLevel: null, locations: 1, isExistingClient: false, doNotContact: false },
      website: { status: 'found', analyzed: false, analysisStatus: 'failed' },
      findings: [],
      serviceFit: { score: null, serviceName: null },
      contacts: [{ type: 'phone', status: 'probable' }],
      freshness: { score: 85, factors: [] },
      previouslyContacted: false,
    };
    const failed = computeLeadFit(base);
    expect(failed.priority).toBe('insufficient_data');
    expect(failed.priorityReasons[0]).toMatch(/analysis failed/);
    expect(failed.components.find((c) => c.key === 'websiteNeed')!.score).toBeNull();
    const blocked = computeLeadFit({ ...base, website: { status: 'found', analyzed: false, analysisStatus: 'blocked' } });
    expect(blocked.priorityReasons[0]).toMatch(/bot protection/);
  });
});

describe('contacts are attributed carefully', () => {
  const at = new Date('2026-09-20');
  const o = (value: string): ContactObservation => ({ type: 'email', value, normalizedValue: value, source: 'website', onOfficialSite: true, observedAt: at, sourceUrl: 'https://gabinet.pl' });
  it('an on-site address on someone else’s domain is only "probable"; free mail stays verified', () => {
    const r = resolveContacts([o('biuro@gabinet.pl'), o('iod@medical-partner-group.pl'), o('gabinet.kowalski@gmail.com')], { officialDomain: 'gabinet.pl' });
    const by = (v: string) => r.find((c) => c.normalizedValue === v)!;
    expect(by('biuro@gabinet.pl').status).toBe('verified');
    expect(by('gabinet.kowalski@gmail.com').status).toBe('verified');
    expect(by('iod@medical-partner-group.pl')).toMatchObject({ status: 'probable' });
    expect(by('iod@medical-partner-group.pl').note).toMatch(/belongs to medical-partner-group\.pl/);
  });
});

describe('directory pages are not businesses', () => {
  it('classifies aggregators, classifieds, media, jobs and government portals', () => {
    for (const [u, kind] of [
      ['https://warszawa.naszemiasto.pl/top-10', 'media'],
      ['https://www.gumtree.pl/s-uslugi', 'marketplace'],
      ['https://www.cylex-polska.pl/warszawa', 'directory'],
      ['https://baza-firm.com.pl/dentysta', 'directory'],
      ['https://kliniki.pl/warszawa', 'directory'],
      ['https://www.pracuj.pl/praca/x', 'jobs'],
      ['https://pacjent.gov.pl/placowki', 'government'],
      ['https://www.moment.pl/dentysta', 'booking'],
    ] as const) {
      expect(classifyNonOfficialDomain(u), u).toBe(kind);
    }
    for (const u of ['https://dentim.pl', 'https://szkola-jezykowa.edu.pl', 'https://lokalny-fryzjer.pl']) expect(classifyNonOfficialDomain(u), u).toBeNull();
  });

  it('listing and article titles do not become company names', () => {
    expect(businessNameFromTitle('Top 10 dentystów w Warszawie - ranking 2025')).toBeNull();
    expect(businessNameFromTitle('Stomatolog Warszawa - 238 gabinetów, opinie, ceny | ZnanyLekarz')).toBeNull();
    expect(businessNameFromTitle('Best dentists in Warsaw (2025)')).toBeNull();
    expect(businessNameFromTitle('Dentim – Stomatologia Warszawa | Implanty')).toBe('Dentim');
  });
});

describe('bot protection is recognised (and never bypassed)', () => {
  it('detects common challenge pages', () => {
    expect(looksLikeChallenge('Just a moment...', '<html></html>', 403)).toBe(true);
    expect(looksLikeChallenge('Attention Required! | Cloudflare', '', 403)).toBe(true);
    expect(looksLikeChallenge('', '<div class="cf-turnstile"></div>', 403)).toBe(true);
    expect(looksLikeChallenge('Gabinet Kowalski', '<form><div class="g-recaptcha"></div></form>' + 'x'.repeat(70_000), 200)).toBe(false);
    expect(looksLikeChallenge('Gabinet Kowalski – stomatologia', '<h1>Witamy</h1>', 200)).toBe(false);
  });
});

describe('OpenStreetMap freshness', () => {
  it('requests element metadata and keeps only the last-edit date', () => {
    const q = buildOverpassQuery({ nicheKey: 'dentist', term: 'dentysta', area: { displayName: 'W', city: 'W', lat: 52, lng: 21, bbox: [52, 20, 53, 21], source: 'test' }, limit: 100 });
    expect(q).toMatch(/out center meta 100;$/);
    const b = normalizeOsmElement({ type: 'node', id: 1, lat: 52, lon: 21, timestamp: '2016-05-01T10:00:00Z', tags: { amenity: 'dentist', name: 'Dentim' } } as never)!;
    expect(b.sourceUpdatedAt?.toISOString()).toBe('2016-05-01T10:00:00.000Z');
    expect(JSON.stringify(b)).not.toMatch(/"user"|"uid"/);
  });
});
