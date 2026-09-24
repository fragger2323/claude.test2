import { parsePhoneNumberFromString, findPhoneNumbersInText, type CountryCode } from 'libphonenumber-js';

export interface NormalizedPhone {
  e164: string;
  international: string;
  national: string;
  valid: boolean;
  country?: string;
}

/** ISO-3166 alpha-2 from a free-form country name/code (best effort for common inputs). */
export function toCountryCode(country: string | null | undefined): CountryCode | undefined {
  if (!country) return undefined;
  const c = country.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(c)) return c.toUpperCase() as CountryCode;
  return COUNTRY_NAMES[c];
}

const COUNTRY_NAMES: Record<string, CountryCode> = {
  poland: 'PL', polska: 'PL', польша: 'PL',
  germany: 'DE', deutschland: 'DE', германия: 'DE',
  'czech republic': 'CZ', czechia: 'CZ', česko: 'CZ', чехия: 'CZ',
  slovakia: 'SK', austria: 'AT', switzerland: 'CH', schweiz: 'CH',
  france: 'FR', spain: 'ES', españa: 'ES', italy: 'IT', italia: 'IT', portugal: 'PT',
  netherlands: 'NL', belgium: 'BE', luxembourg: 'LU', ireland: 'IE',
  'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', england: 'GB',
  'united states': 'US', usa: 'US', us: 'US', america: 'US', canada: 'CA',
  ukraine: 'UA', україна: 'UA', украина: 'UA', lithuania: 'LT', latvia: 'LV', estonia: 'EE',
  sweden: 'SE', norway: 'NO', denmark: 'DK', finland: 'FI', hungary: 'HU', romania: 'RO',
  bulgaria: 'BG', croatia: 'HR', slovenia: 'SI', serbia: 'RS', greece: 'GR', cyprus: 'CY',
  turkey: 'TR', türkiye: 'TR', israel: 'IL', 'united arab emirates': 'AE', uae: 'AE',
  australia: 'AU', 'new zealand': 'NZ', georgia: 'GE', kazakhstan: 'KZ', moldova: 'MD',
  россия: 'RU', russia: 'RU', belarus: 'BY', беларусь: 'BY',
};

export function normalizePhone(raw: string | null | undefined, defaultCountry?: string | null): NormalizedPhone | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+()\-.\s/]/g, ' ').trim();
  if (cleaned.replace(/\D/g, '').length < 6) return null;
  const pn = parsePhoneNumberFromString(cleaned, toCountryCode(defaultCountry ?? undefined));
  if (!pn) return null;
  return {
    e164: pn.number,
    international: pn.formatInternational(),
    national: pn.formatNational(),
    valid: pn.isValid(),
    country: pn.country,
  };
}

/** Phone numbers found in visible page text (validated only). */
export function findPhonesInText(text: string, defaultCountry?: string | null): NormalizedPhone[] {
  const out = new Map<string, NormalizedPhone>();
  const found = findPhoneNumbersInText(text.slice(0, 200_000), toCountryCode(defaultCountry ?? undefined));
  for (const f of found) {
    const pn = f.number;
    if (!pn.isValid()) continue;
    out.set(pn.number, {
      e164: pn.number,
      international: pn.formatInternational(),
      national: pn.formatNational(),
      valid: true,
      country: pn.country,
    });
  }
  return [...out.values()];
}
