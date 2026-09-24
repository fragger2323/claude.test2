import { describe, expect, it } from 'vitest';
import { classifyNonOfficialDomain, hostOf, isFreeHostingSubdomain, isSameSite, normalizeUrl, registrableDomain, resolveHref } from '../../src/lib/url.js';

describe('normalizeUrl', () => {
  it('adds scheme, lowercases host, strips tracking params, fragments and default ports', () => {
    expect(normalizeUrl('WWW.Smile-Dental.PL')).toBe('https://www.smile-dental.pl');
    expect(normalizeUrl('https://clinic.pl:443/?utm_source=x&fbclid=1#top')).toBe('https://clinic.pl');
    expect(normalizeUrl('http://clinic.pl:80/oferta?id=3&gclid=zz')).toBe('http://clinic.pl/oferta?id=3');
    expect(normalizeUrl('//clinic.pl/kontakt')).toBe('https://clinic.pl/kontakt');
  });

  it('rejects non-web schemes, garbage and credentials-only hosts', () => {
    expect(normalizeUrl('mailto:info@clinic.pl')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('tel:+48123')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl(null)).toBeNull();
    expect(normalizeUrl(`https://a.pl/${'x'.repeat(3000)}`)).toBeNull();
  });

  it('removes embedded credentials', () => {
    expect(normalizeUrl('https://user:pass@clinic.pl/a')).toBe('https://clinic.pl/a');
  });
});

describe('domains', () => {
  it('hostOf strips www', () => {
    expect(hostOf('https://www.clinic.pl/x')).toBe('clinic.pl');
    expect(hostOf('clinic.pl')).toBe('clinic.pl');
    expect(hostOf(null)).toBeNull();
  });

  it('registrableDomain uses the public suffix list', () => {
    expect(registrableDomain('https://shop.clinic.waw.pl')).toBe('clinic.waw.pl');
    expect(registrableDomain('www.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('https://sub.smile.pl/path')).toBe('smile.pl');
    expect(isSameSite('https://a.smile.pl', 'http://www.smile.pl/x')).toBe(true);
    expect(isSameSite('https://smile.pl', 'https://smile.com')).toBe(false);
  });

  it('classifies directory/social/booking domains as non-official', () => {
    expect(classifyNonOfficialDomain('https://www.facebook.com/smile')).toBe('social');
    expect(classifyNonOfficialDomain('https://www.znanylekarz.pl/x')).toBe('booking');
    expect(classifyNonOfficialDomain('https://maps.google.com/?cid=1')).toBe('map');
    expect(classifyNonOfficialDomain('https://www.yelp.com/biz/x')).toBe('review');
    expect(classifyNonOfficialDomain('https://panoramafirm.pl/x')).toBe('directory');
    expect(classifyNonOfficialDomain('https://linktr.ee/x')).toBe('link_hub');
    expect(classifyNonOfficialDomain('https://smile-dental.pl')).toBeNull();
  });

  it('detects free hosting subdomains', () => {
    expect(isFreeHostingSubdomain('https://smile.wixsite.com/home')).toBe(true);
    expect(isFreeHostingSubdomain('https://smile.pl')).toBe(false);
  });

  it('resolveHref resolves relative links and rejects non-http', () => {
    expect(resolveHref('/kontakt#x', 'https://clinic.pl/o-nas/')).toBe('https://clinic.pl/kontakt');
    expect(resolveHref('cennik', 'https://clinic.pl/o-nas/')).toBe('https://clinic.pl/o-nas/cennik');
    expect(resolveHref('mailto:a@b.pl', 'https://clinic.pl')).toBeNull();
  });
});
