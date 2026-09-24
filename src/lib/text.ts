/** Text normalisation and similarity used by entity resolution. */

const SPECIAL: Record<string, string> = {
  ł: 'l', Ł: 'l', ø: 'o', Ø: 'o', ß: 'ss', đ: 'd', Đ: 'd', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe', ı: 'i', þ: 'th',
};

export function stripDiacritics(s: string): string {
  return s
    .replace(/[łŁøØßđĐæÆœŒıþ]/g, (c) => SPECIAL[c] ?? c)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

/** Legal-form suffixes (multi-country). Order matters: longer first. */
const LEGAL_FORMS = [
  'spolka z ograniczona odpowiedzialnoscia', 'sp z o o', 'sp zoo', 'spolka komandytowa', 'sp k', 'sp j', 's c', 'spolka cywilna', 'spolka jawna', 's a', 'sa',
  'gmbh co kg', 'gmbh', 'ug haftungsbeschrankt', 'ag', 'kg', 'ohg', 'e k', 'ek', 'e v',
  'limited', 'ltd', 'llc', 'l l c', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'plc', 'llp', 'lp',
  's r o', 'sro', 'a s', 'k s', 'v o s',
  'sarl', 's a r l', 'sas', 'sasu', 'eurl', 'sci',
  'srl', 's r l', 'spa', 's p a', 'snc',
  's l', 'sl', 'slu',
  'bv', 'b v', 'nv', 'n v', 'vof',
  'oy', 'oyj', 'ab', 'as', 'asa', 'aps', 'a s',
  'kft', 'zrt', 'nyrt', 'd o o', 'doo', 'd d',
  'ooo', 'oao', 'zao', 'tov', 'ip', 'fop',
];
const LEGAL_RE = new RegExp(`(?:^|\\s)(?:${LEGAL_FORMS.map((f) => f.replace(/ /g, '\\s')).join('|')})(?=\\s|$)`, 'g');

/** Lower-cased, diacritic-free, punctuation-free company name with legal forms removed. */
export function normalizeName(name: string | null | undefined): string {
  if (!name) return '';
  let s = stripDiacritics(name.toLowerCase());
  s = s.replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ');
  s = ` ${s.trim()} `;
  // strip legal forms (repeat: "sp. z o.o. sp.k.")
  for (let i = 0; i < 3; i++) s = s.replace(LEGAL_RE, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

const NAME_STOPWORDS = new Set(['the', 'and', 'of', 'i', 'w', 'na', 'der', 'die', 'das', 'und', 'la', 'le', 'de', 'du', 'des', 'el', 'y']);

export function nameTokens(name: string): string[] {
  return normalizeName(name)
    .split(' ')
    .filter((t) => t.length > 0 && !NAME_STOPWORDS.has(t));
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const matchDist = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Dice coefficient over token sets (order-insensitive). */
export function tokenSetSimilarity(a: string, b: string): number {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

/** Combined name similarity in [0,1]. */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const compactA = na.replace(/ /g, '');
  const compactB = nb.replace(/ /g, '');
  if (compactA === compactB) return 0.98;
  const jw = jaroWinkler(na, nb);
  const ts = tokenSetSimilarity(na, nb);
  // containment: "smile dental" vs "smile dental clinic warsaw"
  const containment = compactA.length >= 5 && compactB.length >= 5 && (compactA.includes(compactB) || compactB.includes(compactA)) ? 0.9 : 0;
  return Math.max(jw * 0.9, ts, containment);
}

/** Tokens of a domain label useful for matching the company name ("smile-dental.pl" → ["smile","dental"]). */
export function domainTokens(domain: string): string[] {
  const label = domain.split('.')[0] ?? '';
  return label.split(/[-_]+/).filter((t) => t.length >= 2);
}

/** Does a domain plausibly belong to a company name? */
export function domainMatchesName(domain: string | null | undefined, name: string | null | undefined): number {
  if (!domain || !name) return 0;
  const label = stripDiacritics((domain.split('.')[0] ?? '').toLowerCase()).replace(/[^a-z0-9]/g, '');
  const compact = normalizeName(name).replace(/ /g, '');
  if (!label || !compact) return 0;
  if (label === compact) return 1;
  if (label.length >= 4 && (compact.includes(label) || label.includes(compact))) return 0.85;
  const toks = nameTokens(name).filter((t) => t.length >= 3);
  const hit = toks.filter((t) => label.includes(t));
  if (toks.length > 0 && hit.length > 0) return Math.min(0.8, 0.35 + (hit.length / toks.length) * 0.45);
  return jaroWinkler(label, compact) > 0.9 ? 0.6 : 0;
}

export function normalizeAddress(addr: string | null | undefined): string {
  if (!addr) return '';
  return stripDiacritics(addr.toLowerCase())
    .replace(/\b(ul|ulica|al|aleja|aleje|pl|plac|os|osiedle|str|strasse|straße|street|st|avenue|ave|road|rd|rue|via|calle)\b\.?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extracts "streetname number" core for address comparison. */
export function addressKey(addr: string | null | undefined): string | null {
  const n = normalizeAddress(addr);
  const m = n.match(/([\p{L}][\p{L}\s]{2,}?)\s(\d+[a-z]?)(?:\s|$)/u);
  if (!m) return null;
  return `${m[1]!.trim()} ${m[2]}`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Remove control characters and trim; used for imported/untrusted text. */
export function sanitizeText(value: unknown, maxLen = 1000): string | null {
  if (value == null) return null;
  // eslint-disable-next-line no-control-regex
  const s = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

export function slugify(s: string): string {
  return stripDiacritics(s.toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
