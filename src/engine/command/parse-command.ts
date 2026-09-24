import { CITY_ALIASES } from '../../domain/taxonomy.js';
import { stripDiacritics } from '../../lib/text.js';

/**
 * Command Center parser: "Find 100 dental clinics in Warsaw for premium website redesign"
 * → { quantity, niche, location, country, service }. Supports common EN / RU / UK / PL phrasing.
 * Anything it cannot extract is returned in `missing` so the UI can show a minimal form.
 */
export interface ParsedCommand {
  niche?: string;
  location?: string;
  country?: string;
  service?: string;
  quantity?: number;
  missing: Array<'niche' | 'location' | 'country' | 'service' | 'quantity'>;
  confidence: 'high' | 'medium' | 'low';
}

const COUNTRY_NAMES: Record<string, string> = {
  PL: 'Poland', DE: 'Germany', CZ: 'Czechia', SK: 'Slovakia', AT: 'Austria', UA: 'Ukraine', GB: 'United Kingdom', ES: 'Spain', FR: 'France', IT: 'Italy', PT: 'Portugal', NL: 'Netherlands',
};

const KNOWN_COUNTRIES: Array<[RegExp, string]> = [
  [/\b(poland|polska|польша|польщі|польща|polsce)\b/i, 'Poland'],
  [/\b(germany|deutschland|германия|німеччина|niemcy|niemczech)\b/i, 'Germany'],
  [/\b(czechia|czech republic|česko|чехия|чехія|czechy|czechach)\b/i, 'Czechia'],
  [/\b(ukraine|україна|украина|ukraina|ukrainie)\b/i, 'Ukraine'],
  [/\b(austria|österreich|австрия|австрія)\b/i, 'Austria'],
  [/\b(united kingdom|uk|england|великобритания)\b/i, 'United Kingdom'],
  [/\b(spain|españa|испания|hiszpania)\b/i, 'Spain'],
  [/\b(france|франция|francja)\b/i, 'France'],
  [/\b(italy|italia|италия|włochy)\b/i, 'Italy'],
  [/\b(netherlands|nederland|нидерланды|holandia)\b/i, 'Netherlands'],
  [/\b(slovakia|slovensko|словакия|słowacja)\b/i, 'Slovakia'],
  [/\b(portugal|португалия|portugalia)\b/i, 'Portugal'],
];

const norm = (s: string) => stripDiacritics(s.toLowerCase()).trim();

function findCity(text: string): { name: string; country: string } | null {
  const n = norm(text);
  for (const c of CITY_ALIASES) {
    for (const a of c.aliases) {
      const an = norm(a);
      // exact or inflected (Russian/Polish locative: "варшаве", "warszawie")
      const stem = an.length > 5 ? an.slice(0, an.length - 1) : an;
      if (new RegExp(`(^|[^\\p{L}])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\p{L}{0,3}($|[^\\p{L}])`, 'u').test(n)) {
        return { name: c.names.en ?? a, country: COUNTRY_NAMES[c.country] ?? c.country };
      }
    }
  }
  return null;
}

export function parseCommand(input: string): ParsedCommand {
  let text = input.trim().replace(/\s+/g, ' ');
  const out: ParsedCommand = { missing: [], confidence: 'low' };

  const qty = text.match(/\b(\d{1,4})\b/);
  if (qty) {
    const n = Number(qty[1]);
    if (n >= 1 && n <= 1000) out.quantity = n;
  }
  // service: "for X" / "для X" / "pod X" / "dla X" / "für X" (take to end)
  const svc = text.match(/\s(?:for|для|під|pod kątem|pod|dla|für)\s+(.+)$/i);
  if (svc) {
    out.service = svc[1]!.replace(/[.!?]+$/, '').trim();
    text = text.slice(0, svc.index).trim();
  }
  for (const [re, name] of KNOWN_COUNTRIES) {
    if (re.test(text)) {
      out.country = name;
      text = text.replace(re, '').replace(/[,\s]+$/, '').trim();
      break;
    }
  }
  // location: "in X" / "в X" / "у X" / "w X" / "in X, Country"
  const loc = text.match(/\s(?:in|в|во|у|w|we|im)\s+([^,]+?)(?:,|$)/i);
  if (loc) {
    const raw = loc[1]!.trim();
    const city = findCity(raw);
    out.location = city?.name ?? raw;
    if (!out.country && city) out.country = city.country;
    text = text.slice(0, loc.index).trim();
  } else {
    const city = findCity(text);
    if (city) {
      out.location = city.name;
      out.country ??= city.country;
      text = text
        .split(' ')
        .filter((w) => !findCity(w))
        .join(' ');
    }
  }
  // niche: whatever remains after removing the verb and quantity
  const niche = text
    .replace(/^(please\s+)?(find|search|get|look for|show|найди|найти|ищи|знайди|знайти|znajdź|znajdz|wyszukaj|szukaj|finde|suche)\s+/i, '')
    .replace(/\b\d{1,4}\b/, '')
    .replace(/\b(leads?|companies|businesses|компаний|компаній|firm|firmy|лидов|лідів)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (niche.length >= 3) out.niche = niche;

  for (const k of ['niche', 'location', 'country', 'quantity'] as const) if (out[k] == null) out.missing.push(k);
  if (!out.service) out.missing.push('service');
  out.confidence = out.missing.filter((m) => m !== 'service').length === 0 ? 'high' : out.missing.length <= 2 ? 'medium' : 'low';
  return out;
}
