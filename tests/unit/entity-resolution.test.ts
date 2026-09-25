import { describe, expect, it } from 'vitest';
import { clusterRecords, domainKey, isGenericName, matchRecords, MERGE_THRESHOLD, mergeRecords, toResolvable } from '../../src/engine/resolution/entity-resolution.js';
import type { NormalizedBusiness } from '../../src/providers/types.js';

const at = new Date('2026-09-01T10:00:00Z');
function biz(p: Partial<NormalizedBusiness> & { provider: string; providerRecordId: string; name: string }): NormalizedBusiness {
  return { categories: [], country: 'PL', city: 'Warszawa', fetchedAt: at, ...p };
}

describe('entity resolution', () => {
  it('generic names are recognised', () => {
    expect(isGenericName('Dental Clinic')).toBe(true);
    expect(isGenericName('Gabinet Stomatologiczny')).toBe(true);
    expect(isGenericName('Smile Dental')).toBe(false);
  });

  it('domainKey ignores directory profiles and keeps free-hosting hosts', () => {
    expect(domainKey('https://www.facebook.com/smile')).toBeNull();
    expect(domainKey('https://www.smile-dental.pl/kontakt')).toBe('smile-dental.pl');
    expect(domainKey('https://smile.wixsite.com/home')).toBe('smile.wixsite.com');
  });

  it('merges the same clinic seen by two providers (same domain)', () => {
    const a = toResolvable(biz({ provider: 'google_places', providerRecordId: 'g1', name: 'Smile Dental Clinic', website: 'https://smile-dental.pl', phone: '+48 22 123 45 67', lat: 52.2, lng: 21.0 }));
    const b = toResolvable(biz({ provider: 'osm', providerRecordId: 'n1', name: 'Smile Dental', website: 'http://www.smile-dental.pl/', lat: 52.2001, lng: 21.0001 }));
    const m = matchRecords(a, b);
    expect(m.score).toBeGreaterThanOrEqual(MERGE_THRESHOLD);
    expect(m.reasons.join(' ')).toContain('smile-dental.pl');
  });

  it('never merges records with different official domains', () => {
    const a = toResolvable(biz({ provider: 'google_places', providerRecordId: 'g1', name: 'Smile Dental', website: 'https://smile-dental.pl', phone: '+48 22 123 45 67' }));
    const b = toResolvable(biz({ provider: 'osm', providerRecordId: 'n1', name: 'Smile Dental', website: 'https://smile-dental-krakow.pl', phone: '+48 22 123 45 67' }));
    const m = matchRecords(a, b);
    expect(m.score).toBe(0);
    expect(m.blocked).toMatch(/different websites/);
  });

  it('does not merge on a similar generic name alone', () => {
    const a = toResolvable(biz({ provider: 'google_places', providerRecordId: 'g1', name: 'Gabinet Stomatologiczny', lat: 52.2, lng: 21.0 }));
    const b = toResolvable(biz({ provider: 'osm', providerRecordId: 'n1', name: 'Gabinet Stomatologiczny', lat: 52.25, lng: 21.05 }));
    expect(matchRecords(a, b).score).toBeLessThan(MERGE_THRESHOLD);
  });

  it('does not merge different businesses sharing a phone (e.g. shared reception)', () => {
    const recs = [
      toResolvable(biz({ provider: 'osm', providerRecordId: '1', name: 'Alpha Dent', phone: '+48 22 111 22 33', lat: 52.2, lng: 21.0 })),
      toResolvable(biz({ provider: 'osm', providerRecordId: '2', name: 'Beta Ortho', phone: '+48 22 111 22 33', lat: 52.3, lng: 21.1 })),
      toResolvable(biz({ provider: 'osm', providerRecordId: '3', name: 'Gamma Implant', phone: '+48 22 111 22 33', lat: 52.1, lng: 20.9 })),
    ];
    const clusters = clusterRecords(recs);
    expect(clusters).toHaveLength(3);
  });

  it('clusters duplicates and keeps provenance; conflicting phones are surfaced as discrepancies', () => {
    const raw = [
      biz({ provider: 'google_places', providerRecordId: 'g1', name: 'Nova Dental', website: 'https://novadental.pl', phone: '+48 22 555 00 11', address: 'ul. Puławska 10, Warszawa', businessStatus: 'operational', rating: 4.8, ratingCount: 120 }),
      biz({ provider: 'osm', providerRecordId: 'n7', name: 'Nova Dental Sp. z o.o.', website: 'https://www.novadental.pl', phone: '+48 22 555 99 99', address: 'Puławska 10' }),
      biz({ provider: 'osm', providerRecordId: 'n8', name: 'Bella Beauty', website: 'https://bella.pl' }),
    ];
    const clusters = clusterRecords(raw.map((r) => toResolvable(r)));
    expect(clusters).toHaveLength(2);
    const nova = clusters.find((c) => c.members.length === 2)!;
    const merged = mergeRecords(nova.members.map((r) => raw.find((x) => `${x.provider}:${x.providerRecordId}` === r.key)!), 'PL');
    expect(merged.name).toBe('Nova Dental');
    expect(merged.primaryDomain).toBe('novadental.pl');
    expect(merged.sources.sort()).toEqual(['google_places', 'osm']);
    expect(merged.phoneE164).toBe('+48225550011'); // most trusted provider wins
    const phoneConflict = merged.discrepancies.find((d) => d.field === 'phone');
    expect(phoneConflict?.values).toHaveLength(2);
    expect(merged.discrepancies.find((d) => d.field === 'address')).toBeUndefined();
    expect(merged.rating).toBe(4.8);
  });
});

describe('entity resolution — realistic cases', () => {
  const at2 = new Date('2026-09-01T10:00:00Z');
  const b = (p: Partial<NormalizedBusiness> & { provider: string; providerRecordId: string; name: string }): NormalizedBusiness => ({ categories: [], country: 'PL', city: 'Warszawa', fetchedAt: at2, ...p });
  const cases: Array<[string, NormalizedBusiness[], number]> = [
    ['Google long name vs OSM short name, same phone in another format, 40 m', [b({ provider: 'google_places', providerRecordId: 'g', name: 'Centrum Stomatologiczne Dentim', phone: '+48 22 111 22 33', lat: 52.2, lng: 21 }), b({ provider: 'osm', providerRecordId: 'o', name: 'Dentim', phone: '22 111-22-33', lat: 52.2003, lng: 21 })], 1],
    ['legal form and word order, same street, no phone', [b({ provider: 'google_places', providerRecordId: 'g', name: 'Uśmiech Stomatologia Sp. z o.o.', lat: 52.2, lng: 21, street: 'Puławska 10' }), b({ provider: 'osm', providerRecordId: 'o', name: 'Stomatologia Uśmiech', lat: 52.2005, lng: 21, street: 'Puławska 10' })], 1],
    ['two clinics in one medical building', [b({ provider: 'google_places', providerRecordId: 'g', name: 'Dental Art Kowalski', phone: '+48 22 100 00 01', lat: 52.2, lng: 21, street: 'Marszałkowska 1' }), b({ provider: 'osm', providerRecordId: 'o', name: 'Ortodoncja Nowak', phone: '+48 22 100 00 02', lat: 52.2, lng: 21, street: 'Marszałkowska 1' })], 2],
    ['generic names on different streets', [b({ provider: 'osm', providerRecordId: '1', name: 'Gabinet Stomatologiczny', lat: 52.2, lng: 21, street: 'Grójecka 5' }), b({ provider: 'osm', providerRecordId: '2', name: 'Gabinet Stomatologiczny', lat: 52.21, lng: 21.01, street: 'Wolska 7' })], 2],
    ['doctor listings inside one clinic (shared phone + website)', [b({ provider: 'google_places', providerRecordId: 'a', name: 'lek. dent. Anna Nowak', phone: '+48 22 333 44 55', website: 'https://dentim.pl', lat: 52.2, lng: 21 }), b({ provider: 'google_places', providerRecordId: 'b', name: 'lek. dent. Piotr Zając', phone: '+48 22 333 44 55', website: 'https://dentim.pl/zespol', lat: 52.2, lng: 21 }), b({ provider: 'osm', providerRecordId: 'c', name: 'Dentim', phone: '+48 22 333 44 55', website: 'https://www.dentim.pl', lat: 52.2, lng: 21 })], 1],
    ['same name, different cities', [b({ provider: 'osm', providerRecordId: 'a', name: 'Dentim', city: 'Warszawa', lat: 52.2, lng: 21 }), b({ provider: 'osm', providerRecordId: 'b', name: 'Dentim', city: 'Kraków', lat: 50.06, lng: 19.94 })], 2],
    ['facebook listed as website in one source', [b({ provider: 'osm', providerRecordId: 'a', name: 'Smile Clinic', website: 'https://facebook.com/smileclinic', phone: '+48 600 100 200', lat: 52.2, lng: 21 }), b({ provider: 'google_places', providerRecordId: 'b', name: 'Smile Clinic Warszawa', website: 'https://smileclinic.pl', phone: '600100200', lat: 52.2001, lng: 21 })], 1],
    ['diacritics vs ASCII', [b({ provider: 'osm', providerRecordId: 'a', name: 'Gabinet Łuczak Źródło Uśmiechu', lat: 52.2, lng: 21 }), b({ provider: 'google_places', providerRecordId: 'b', name: 'Gabinet Luczak Zrodlo Usmiechu', lat: 52.2004, lng: 21 })], 1],
    // found by the 100-lead scale run: a shared phone merged two clinics 9.5 km apart
    ['same phone, same industry words, different owners, 9.5 km apart', [b({ provider: 'osm', providerRecordId: 'a', name: 'Centrum Implantologii Wiśniewska', phone: '+48 22 600 19 73', lat: 52.2894, lng: 21.0819 }), b({ provider: 'osm', providerRecordId: 'b', name: 'Centrum Implantologii Nowakowski', phone: '+48 22 600 19 73', lat: 52.2796, lng: 20.9419 })], 2],
    ['same phone, same industry words, different owners, next door', [b({ provider: 'osm', providerRecordId: 'a', name: 'Centrum Implantologii Wiśniewska', phone: '+48 22 600 19 73', lat: 52.2894, lng: 21.0819, street: 'Testowa 1' }), b({ provider: 'osm', providerRecordId: 'b', name: 'Centrum Implantologii Nowakowski', phone: '+48 22 600 19 73', lat: 52.2896, lng: 21.0819, street: 'Testowa 3' })], 1],
  ];
  for (const [label, recs, expected] of cases) {
    it(label, () => {
      expect(clusterRecords(recs.map((r) => toResolvable(r)))).toHaveLength(expected);
    });
  }
});
