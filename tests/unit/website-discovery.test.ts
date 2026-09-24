import { describe, expect, it } from 'vitest';
import { discoverWebsite, verifyHomepage, type DiscoveryCompany } from '../../src/engine/discovery/website-discovery.js';
import type { FetchedPage } from '../../src/providers/website/fetcher.js';

const company: DiscoveryCompany = { name: 'Smile Dental Clinic', city: 'Warszawa', country: 'PL', phones: ['+48 22 123 45 67'], address: 'ul. Puławska 12' };
const page = (url: string, text: string, ok = true): FetchedPage => ({ ok, status: ok ? 200 : 503, url, finalUrl: url, redirects: [], html: `<html><body>${text}</body></html>`, title: text.slice(0, 40), text, error: ok ? undefined : 'HTTP 503' });

describe('verifyHomepage', () => {
  it('scores name, phone and address evidence', () => {
    const v = verifyHomepage(page('https://smile.pl', 'Smile Dental Clinic — stomatologia. Tel. 22 123 45 67, ul. Puławska 12, Warszawa'), company);
    expect(v.score).toBeGreaterThanOrEqual(0.9);
    expect(v.reasons.join(' ')).toMatch(/phone/);
  });

  it('detects parked domains', () => {
    const v = verifyHomepage(page('https://smile.pl', 'This domain is for sale! Buy this domain today.'), company);
    expect(v.parked).toBe(true);
    expect(v.score).toBe(0);
  });
});

describe('discoverWebsite', () => {
  it('accepts a verified source candidate and rejects profile URLs with reasons', async () => {
    const d = await discoverWebsite(
      company,
      [
        { url: 'https://www.facebook.com/smiledental', source: 'osm', evidence: 'contact:facebook' },
        { url: 'https://smile-dental.pl', source: 'google_places', evidence: 'websiteUri' },
      ],
      { fetchHomepage: async (u) => page(u, 'Smile Dental Clinic Warszawa 22 123 45 67'), searchAvailable: false },
    );
    expect(d.status).toBe('found');
    expect(d.domain).toBe('smile-dental.pl');
    expect(d.log.find((l) => l.url.includes('facebook'))?.reasons[0]).toMatch(/social profile/);
    expect(d.log.find((l) => l.verdict === 'accepted')).toBeTruthy();
  });

  it('never accepts a search result that does not look like the company', async () => {
    const d = await discoverWebsite(company, [], {
      fetchHomepage: async (u) => page(u, 'Pizza Roma — best pizza in Kraków'),
      searchAvailable: true,
      searchCandidates: async () => [{ url: 'https://pizza-roma.pl', source: 'web_search', evidence: 'rank 1', rank: 1 }],
    });
    expect(d.status).toBe('not_found');
    expect(d.checkedSources).toContain('web_search');
    expect(d.notFoundReason).toBeTruthy();
    expect(d.log.find((l) => l.url.includes('pizza'))?.verdict).toBe('unverified');
  });

  it('an unreachable listed site is "unreachable", not "no website" and not "closed"', async () => {
    const d = await discoverWebsite(company, [{ url: 'https://smile-dental.pl', source: 'google_places', evidence: 'websiteUri' }], {
      fetchHomepage: async (u) => page(u, '', false),
      searchAvailable: false,
    });
    expect(d.status).toBe('unreachable');
    expect(d.url).toContain('smile-dental.pl');
  });

  it('with nothing to check it reports exactly what was checked', async () => {
    const d = await discoverWebsite(company, [], { fetchHomepage: async (u) => page(u, ''), searchAvailable: false });
    expect(d.status).toBe('not_found');
    expect(d.notFoundReason).toMatch(/.+/);
  });
});
