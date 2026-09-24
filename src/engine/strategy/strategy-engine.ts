import { CITY_ALIASES, COUNTRY_LANGUAGES, NICHES, type Lang, type NicheDef } from '../../domain/taxonomy.js';
import type { SearchParams } from '../../domain/search-params.js';
import { toCountryCode } from '../../lib/phone.js';
import { jaroWinkler, stripDiacritics } from '../../lib/text.js';

/**
 * Search Strategy Engine: expands one request (niche × location) into many query variations
 * (synonyms, specialties, local languages, city segments) to maximise recall; quality is
 * enforced later by resolution, verification and qualification.
 */

export type QueryStrategy = 'primary' | 'synonym' | 'specialty' | 'segment' | 'secondary_language' | 'raw';

export interface PlannedQuery {
  text: string;
  term: string;
  language: Lang | string;
  segment?: string;
  strategy: QueryStrategy;
  /** Stable key used by the search-quality loop to learn which variations yield good leads. */
  template: string;
  priority: number;
}

export interface StrategyPlan {
  niche: NicheDef | null;
  nicheKey?: string;
  matchedBy?: string;
  countryCode?: string;
  languages: Array<Lang | string>;
  cityName: string;
  localizedCity: Partial<Record<Lang, string>>;
  segments: string[];
  queries: PlannedQuery[];
  notes: string[];
}

const norm = (s: string) => stripDiacritics(s.toLowerCase()).replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** Crude plural/inflection stripping so "dentists", "стоматологии", "kliniki" still match. */
function stem(s: string): string {
  const n = norm(s);
  return n
    .split(' ')
    .map((w) => (w.length > 5 ? w.slice(0, Math.max(5, w.length - 2)) : w))
    .join(' ');
}

export function resolveNiche(input: string): { def: NicheDef | null; matchedBy?: string; lang?: string } {
  const n = norm(input);
  const s = stem(input);
  let best: { def: NicheDef; score: number; term: string; lang: string } | null = null;
  for (const def of NICHES) {
    const candidates: Array<[string, string]> = [[def.key.replace(/_/g, ' '), 'en'], [def.label, 'en']];
    for (const [lang, terms] of Object.entries(def.terms)) for (const t of terms ?? []) candidates.push([t, lang]);
    for (const [lang, terms] of Object.entries(def.specialties ?? {})) for (const t of terms ?? []) candidates.push([t, lang]);
    for (const [term, lang] of candidates) {
      const tn = norm(term);
      let score = 0;
      if (tn === n) score = 1;
      else if (stem(term) === s) score = 0.97;
      else if (n.length >= 4 && (tn.includes(n) || n.includes(tn)) && Math.min(tn.length, n.length) >= 4) score = 0.9;
      else score = jaroWinkler(stem(term), s) >= 0.93 ? 0.88 : 0;
      if (score > (best?.score ?? 0)) best = { def, score, term, lang };
    }
  }
  if (best && best.score >= 0.88) return { def: best.def, matchedBy: best.term, lang: best.lang };
  return { def: null };
}

export function resolveCity(location: string): (typeof CITY_ALIASES)[number] | null {
  const n = norm(location);
  return CITY_ALIASES.find((c) => c.aliases.some((a) => norm(a) === n)) ?? null;
}

export function queryBudget(quantity: number): number {
  if (quantity <= 20) return 6;
  if (quantity <= 50) return 10;
  if (quantity <= 100) return 16;
  if (quantity <= 300) return 28;
  return 40;
}

export interface PlanOptions {
  /** City subdivisions (e.g. districts) from a geo provider; falls back to built-in list. */
  segments?: string[];
  /** Historical yield per template (qualified leads per query) from the search-quality loop. */
  templateYield?: Map<string, number>;
  maxQueries?: number;
}

export function planSearch(params: SearchParams, opts: PlanOptions = {}): StrategyPlan {
  const notes: string[] = [];
  const { def, matchedBy, lang: matchedLang } = resolveNiche(params.niche);
  const countryCode = toCountryCode(params.country);
  const city = resolveCity(params.location);
  const cc = countryCode ?? city?.country;

  let languages: Array<Lang | string> = [...(cc && COUNTRY_LANGUAGES[cc] ? COUNTRY_LANGUAGES[cc] : ['en'])];
  if (params.language && params.language !== 'auto') languages = [params.language, ...languages.filter((l) => l !== params.language)];
  languages = [...new Set(languages)].slice(0, 3);

  if (def) notes.push(`Niche recognised as "${def.label}" (matched "${matchedBy}"${matchedLang ? `, ${matchedLang}` : ''}).`);
  else notes.push(`Niche "${params.niche}" is not in the taxonomy; using the raw term only (add it to src/domain/taxonomy.ts for better recall).`);
  notes.push(`Search languages: ${languages.join(', ')}${cc ? ` (country ${cc})` : ''}.`);

  const cityFor = (lang: string): string => city?.names[lang as Lang] ?? city?.names.en ?? params.location;
  const segments = (opts.segments && opts.segments.length > 0 ? opts.segments : city?.districts ?? []).slice(0, 30);
  if (segments.length > 0) notes.push(`City split into ${segments.length} segments (${opts.segments?.length ? 'from geo provider' : 'built-in list'}).`);

  const queries: PlannedQuery[] = [];
  const push = (q: Omit<PlannedQuery, 'priority'> & { priority: number }) => {
    const yieldBoost = opts.templateYield?.get(q.template);
    const priority = q.priority + (yieldBoost != null ? Math.round(Math.min(30, yieldBoost * 30)) : 0);
    queries.push({ ...q, priority });
  };

  if (def) {
    languages.forEach((lang, li) => {
      const terms = def.terms[lang as Lang] ?? [];
      const specs = def.specialties?.[lang as Lang] ?? [];
      const c = cityFor(lang);
      terms.forEach((t, ti) => {
        push({
          text: `${t} ${c}`,
          term: t,
          language: lang,
          strategy: li === 0 && ti === 0 ? 'primary' : li === 0 ? 'synonym' : 'secondary_language',
          template: `${def.key}|${lang}|${norm(t)}`,
          priority: (li === 0 ? 100 : 70) - ti * 5,
        });
      });
      specs.forEach((t, si) => {
        push({ text: `${t} ${c}`, term: t, language: lang, strategy: 'specialty', template: `${def.key}|${lang}|spec:${norm(t)}`, priority: (li === 0 ? 60 : 45) - si * 3 });
      });
    });
    // segment queries: primary terms of the primary language × segments
    const primaryLang = languages[0]!;
    const segTerms = (def.terms[primaryLang as Lang] ?? []).slice(0, params.quantity > 150 ? 2 : 1);
    for (const seg of segments) {
      for (const t of segTerms) {
        push({ text: `${t} ${seg} ${cityFor(primaryLang)}`, term: t, language: primaryLang, segment: seg, strategy: 'segment', template: `${def.key}|${primaryLang}|seg:${norm(t)}`, priority: 50 });
      }
    }
  } else {
    const lang = languages[0]!;
    push({ text: `${params.niche} ${params.location}`, term: params.niche, language: lang, strategy: 'raw', template: `raw|${norm(params.niche)}`, priority: 100 });
    for (const seg of segments) {
      push({ text: `${params.niche} ${seg} ${params.location}`, term: params.niche, language: lang, segment: seg, strategy: 'segment', template: `raw|seg:${norm(params.niche)}`, priority: 50 });
    }
  }

  // de-duplicate by text, keep highest priority
  const byText = new Map<string, PlannedQuery>();
  for (const q of queries) {
    const k = norm(q.text);
    const prev = byText.get(k);
    if (!prev || prev.priority < q.priority) byText.set(k, q);
  }
  const max = opts.maxQueries ?? queryBudget(params.quantity);
  const all = [...byText.values()].sort((a, b) => b.priority - a.priority);
  // ensure segment coverage is not starved entirely for big requests
  let selected = all.slice(0, max);
  if (params.quantity > 60 && segments.length > 0 && !selected.some((q) => q.strategy === 'segment')) {
    const segQs = all.filter((q) => q.strategy === 'segment').slice(0, Math.ceil(max / 3));
    selected = [...all.filter((q) => q.strategy !== 'segment').slice(0, max - segQs.length), ...segQs];
  }
  if (all.length > selected.length) notes.push(`${all.length} variations generated; ${selected.length} scheduled within the query budget for ${params.quantity} leads.`);

  return {
    niche: def,
    nicheKey: def?.key,
    matchedBy,
    countryCode: cc,
    languages,
    cityName: params.location,
    localizedCity: city?.names ?? {},
    segments,
    queries: selected,
    notes,
  };
}
