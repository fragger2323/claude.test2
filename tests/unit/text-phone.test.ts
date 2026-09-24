import { describe, expect, it } from 'vitest';
import { addressKey, domainMatchesName, jaroWinkler, nameSimilarity, normalizeAddress, normalizeName, sanitizeText, slugify, stripDiacritics } from '../../src/lib/text.js';
import { findPhonesInText, normalizePhone, toCountryCode } from '../../src/lib/phone.js';

describe('text normalisation', () => {
  it('strips diacritics including Polish ł', () => {
    expect(stripDiacritics('Łódź Gdańsk Kraków')).toBe('Lodz Gdansk Krakow');
    expect(stripDiacritics('Straße')).toBe('Strasse');
  });

  it('normalizeName removes legal forms and punctuation', () => {
    expect(normalizeName('Smile Dental Sp. z o.o.')).toBe('smile dental');
    expect(normalizeName('Müller & Söhne GmbH')).toBe('muller and sohne');
    expect(normalizeName('ACME Ltd.')).toBe('acme');
    expect(normalizeName(null)).toBe('');
  });

  it('similarity is symmetric-ish and high for variants', () => {
    expect(jaroWinkler('abc', 'abc')).toBe(1);
    expect(jaroWinkler('', 'abc')).toBe(0);
    expect(nameSimilarity('Smile Dental Clinic', 'Smile Dental')).toBeGreaterThan(0.8);
    expect(nameSimilarity('Smile Dental', 'Bella Beauty')).toBeLessThan(0.5);
  });

  it('domainMatchesName', () => {
    expect(domainMatchesName('smiledental.pl', 'Smile Dental')).toBe(1);
    expect(domainMatchesName('smile-dental.pl', 'Smile Dental Sp. z o.o.')).toBeGreaterThanOrEqual(0.6);
    expect(domainMatchesName('pizzahut.pl', 'Smile Dental')).toBe(0);
  });

  it('address keys ignore street prefixes and case', () => {
    expect(normalizeAddress('ul. Puławska 12, Warszawa')).toBe('pulawska 12 warszawa');
    expect(addressKey('ul. Puławska 12, 02-515 Warszawa')).toBe(addressKey('Pulawska 12 Warszawa'));
    expect(addressKey('')).toBeNull();
  });

  it('sanitizeText strips control characters and limits length', () => {
    expect(sanitizeText('  a\u0000b\u0007c  ')).toBe('abc');
    expect(sanitizeText('x'.repeat(20), 5)).toBe('xxxxx');
    expect(sanitizeText('   ')).toBeNull();
    expect(sanitizeText(null)).toBeNull();
  });

  it('slugify', () => {
    expect(slugify('Premium Website Redesign!')).toBe('premium-website-redesign');
    expect(slugify('Łódź — stomatologia')).toBe('lodz-stomatologia');
  });
});

describe('phones', () => {
  it('maps country names to ISO codes', () => {
    expect(toCountryCode('Poland')).toBe('PL');
    expect(toCountryCode('Польша')).toBe('PL');
    expect(toCountryCode('de')).toBe('DE');
    expect(toCountryCode('Atlantis')).toBeUndefined();
  });

  it('normalizes national numbers using the default country', () => {
    const p = normalizePhone('22 123 45 67', 'Poland');
    expect(p?.e164).toBe('+48221234567');
    expect(p?.valid).toBe(true);
    expect(normalizePhone('+48 22 123 45 67')?.e164).toBe('+48221234567');
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });

  it('finds only valid phones in text', () => {
    const found = findPhonesInText('Zadzwoń: +48 22 123 45 67 lub 600 700 800. NIP 1234567890', 'PL');
    const e164 = found.map((f) => f.e164);
    expect(e164).toContain('+48221234567');
    expect(e164).toContain('+48600700800');
  });
});
