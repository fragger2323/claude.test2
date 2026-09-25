import { parse as parseDomain } from 'tldts';

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|gbraid|wbraid|msclkid|yclid|mc_cid|mc_eid|_ga|_gl|ref|ref_src|igshid|si)$/i;

/**
 * Normalises a user/provider-supplied website URL.
 * Returns null for anything that is not a plausible http(s) website URL.
 */
export function normalizeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let raw = input.trim();
  if (!raw || raw.length > 2048) return null;
  if (/^(mailto|tel|javascript|data|ftp|file):/i.test(raw)) return null;
  if (raw.startsWith('//')) raw = `https:${raw}`;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || (!host.includes('.') && host !== 'localhost')) return null;
  u.hostname = host;
  u.username = '';
  u.password = '';
  u.hash = '';
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  let out = u.toString();
  if (u.pathname === '/' && !u.search) out = out.replace(/\/$/, '');
  return out;
}

/** Hostname without a leading "www." (lowercased), or null. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\d?\./, '').replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/**
 * Registrable domain (eTLD+1) using the Public Suffix List, e.g.
 * "shop.clinic.waw.pl" → "clinic.waw.pl", "www.example.co.uk" → "example.co.uk".
 */
export function registrableDomain(urlOrHost: string | null | undefined): string | null {
  const host = hostOf(urlOrHost);
  if (!host) return null;
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const p = parseDomain(host, { allowPrivateDomains: true });
  return p.domain ?? host;
}

/** Same-site check used for "internal link" classification. */
export function isSameSite(a: string, b: string): boolean {
  const da = registrableDomain(a);
  const db = registrableDomain(b);
  return !!da && da === db;
}

export type NonOfficialKind =
  | 'social'
  | 'directory'
  | 'review'
  | 'map'
  | 'booking'
  | 'delivery'
  | 'marketplace'
  | 'link_hub'
  | 'search'
  | 'reference'
  | 'media'
  | 'jobs'
  | 'government';

/**
 * Domains that are never a company's *official* website (profiles, directories, platforms).
 * Matching is on the registrable domain, and for some brands on any TLD.
 */
const NON_OFFICIAL: Array<[RegExp, NonOfficialKind]> = [
  [/^(facebook|fb|instagram|linkedin|twitter|x|tiktok|youtube|youtu|pinterest|threads|vk|ok|telegram|t|whatsapp|wa|snapchat|tumblr|behance|dribbble)\.[a-z.]+$/, 'social'],
  [/^(yelp|foursquare|tripadvisor|trustpilot|opinie|zoover|clutch|goodfirms|sortlist|glassdoor|gowork|kununu)\.[a-z.]+$/, 'review'],
  [/^(google|goo|bing|apple|here|waze|mapy|openstreetmap|osm|2gis|yandex)\.[a-z.]+$/, 'map'],
  [/^(booksy|treatwell|fresha|doctolib|znanylekarz|docplanner|jameda|doktortakpan|medonet|zocdoc|mediately|booking|airbnb|hotels|expedia|agoda|thefork|opentable|resy|quandoo|calendly|setmore|simplybook|moment|versum|bookero)\.[a-z.]+$/, 'booking'],
  [/^(pyszne|ubereats|uber|glovo|glovoapp|wolt|deliveroo|justeat|just-eat|lieferando|foodpanda|bolt|takeaway|doordash|grubhub)\.[a-z.]+$/, 'delivery'],
  [/^(allegro|olx|amazon|ebay|etsy|aliexpress|otodom|morizon|gratka|domiporta|idealista|immobilienscout24|rightmove|zillow|sreality|bazos|gumtree|sprzedajemy|lento|groupon|oferia|zleca|useme|houzz|bark|thumbtack|angi|homeadvisor|checkatrade|trustatrader|ratedpeople|mybuilder|nextdoor|kleinanzeigen|willhaben|marktplaats|leboncoin|subito|wallapop|avito|prom|rozetka)\.[a-z.]+$/, 'marketplace'],
  [/^(pkt|panoramafirm|aleo|oferteo|fixly|zumi|firmy|zlatestranky|gelbeseiten|dasoertliche|yellowpages|yell|pagesjaunes|paginegialle|paginasamarillas|infobel|cylex|hotfrog|europages|kompass|dnb|bizapedia|opencorporates|rejestr|krs-online|biznes|ceidg|owg|firmania|mojepanstwo|imsig|northdata|companieshouse|biznesfinder|targeo|kliniki|medme|infoveriti|biznesradar|bizraport|krs-pobierz|e-krs|regon|nip24|aleo24|firmyzpolski|polskiefirmy|baza-firm|bazafirm|katalog-firm|katalogfirm|firmo|tupalo|brownbook|n49|11880|golocal|meinestadt|herold|local|search|firmy-cz|najisto|zivefirmy|123people|manta|chamberofcommerce|cybo|foursquare|justdial|sulekha|2gis)\.[a-z.]+$/, 'directory'],
  // Registrable labels that are clearly directories ("cylex-polska.pl", "katalog-firm-xyz.pl")
  [/(^|-)(cylex|yellowpages|katalog-firm|katalogfirm|baza-firm|bazafirm|branchenbuch|firmenverzeichnis|adresar-firem)(-|\.)/, 'directory'],
  [/^(naszemiasto|wyborcza|gazeta|onet|interia|wp|o2|tvn24|money|bankier|forbes|businessinsider|medium|substack|rp|polsatnews|se|fakt|natemat|spidersweb|bbc|cnn|nytimes|theguardian|spiegel|bild|focus|idnes|novinky|seznamzpravy|pravda|ukrinform|tsn|unian|lenta|rbc|elpais|lemonde|corriere|repubblica|telegraaf|nu)\.[a-z.]+$/, 'media'],
  [/^(pracuj|indeed|jooble|infopraca|praca|olxpraca|jobs|stepstone|monster|workable|nofluffjobs|justjoin|rocketjobs|jobsora|careerjet|work|robota|rabota|hh)\.[a-z.]+$/, 'jobs'],
  [/^(linktr|linktree|beacons|carrd|bio|taplink|lnk)\.[a-z.]+$/, 'link_hub'],
  [/^(wikipedia|wikidata|wikimedia)\.org$/, 'reference'],
  [/^(duckduckgo|yahoo|baidu|brave|startpage|ecosia|search)\.[a-z.]+$/, 'search'],
];

export function classifyNonOfficialDomain(urlOrHost: string | null | undefined): NonOfficialKind | null {
  const reg = registrableDomain(urlOrHost);
  const host = hostOf(urlOrHost);
  if (!reg || !host) return null;
  // government portals (private schools legitimately use .edu.xx, so .edu is not excluded)
  if (/(^|\.)(gov|gouv|gob|gv|mil)(\.[a-z]{2})?$/.test(host)) return 'government';
  if (/^(maps|goo)\.(google|gl)/.test(host) || host.endsWith('maps.app.goo.gl') || host === 'g.page') return 'map';
  if (host.endsWith('business.site')) return 'directory';
  for (const [re, kind] of NON_OFFICIAL) {
    if (re.test(reg)) return kind;
  }
  return null;
}

/** Free hosting subdomains: acceptable as an official site, but a useful signal. */
export function isFreeHostingSubdomain(urlOrHost: string | null | undefined): boolean {
  const host = hostOf(urlOrHost);
  if (!host) return false;
  return /\.(wixsite\.com|weebly\.com|wordpress\.com|blogspot\.[a-z.]+|squarespace\.com|webflow\.io|tilda\.ws|jimdosite\.com|jimdofree\.com|site123\.me|business\.site|netlify\.app|vercel\.app|github\.io|godaddysites\.com|mozello\.com|webnode\.[a-z.]+)$/.test(host);
}

/** Resolve a possibly relative href against a base; returns null for non-http(s) links. */
export function resolveHref(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}
