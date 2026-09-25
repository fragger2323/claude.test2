import type { Confidence, ContactStatus } from '../../domain/types.js';
import { findPhonesInText, normalizePhone } from '../../lib/phone.js';
import { registrableDomain } from '../../lib/url.js';
import type { NormalizedBusiness } from '../../providers/types.js';
import type { AnalyzerRaw, PageSnapshot } from '../../providers/website/types.js';
import { emailFromMailto, extractEmails, isRoleBasedEmail, isValidEmailSyntax, looksPersonalEmail } from './email.js';

/**
 * Public contact discovery. Only publicly published business contacts are collected:
 * the official website (mailto/tel links, visible text, JSON-LD, contact forms) and
 * business listings. Nothing is guessed or generated.
 */
export interface ContactObservation {
  type: 'email' | 'phone' | 'contact_form' | 'social';
  subtype?: string;
  value: string;
  normalizedValue: string;
  source: string;
  sourceUrl?: string;
  label?: string;
  onOfficialSite: boolean;
  observedAt: Date;
}

export interface ResolvedContact {
  type: ContactObservation['type'];
  subtype?: string;
  value: string;
  normalizedValue: string;
  source: string;
  sourceUrl?: string;
  label?: string;
  status: ContactStatus;
  confidence: Confidence;
  isRoleBased: boolean;
  isPersonal: boolean;
  sightings: Array<{ source: string; sourceUrl?: string; observedAt: string; onOfficialSite: boolean }>;
  note?: string;
}

const SOCIAL_NETWORKS: Array<[RegExp, string]> = [
  [/facebook\.com/i, 'facebook'],
  [/instagram\.com/i, 'instagram'],
  [/linkedin\.com/i, 'linkedin'],
  [/youtube\.com/i, 'youtube'],
  [/tiktok\.com/i, 'tiktok'],
  [/(twitter|x)\.com/i, 'x'],
  [/pinterest\./i, 'pinterest'],
];

function socialNetwork(url: string): string | null {
  for (const [re, n] of SOCIAL_NETWORKS) if (re.test(url)) return n;
  return null;
}

function normalizeSocial(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^(www|m|mobile|pl-pl|pl)\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Web-agency / hosting credit lines: an address right after these words is not the business's contact. */
const CREDIT_RE = /(realizacja|wykonanie|projekt(owanie)?\s+(i\s+wykonanie|strony)|strona\s+wykonana|design(ed)?\s+by|created\s+by|developed\s+by|made\s+by|powered\s+by|site\s+by|web\s*design|webdesign|agencja\s+interaktywna|hosting|umsetzung|gestaltung|разработка|розробка|сайт\s+разработан)[^@]{0,80}$/i;

function inCreditLine(text: string, email: string): boolean {
  const lower = text.toLowerCase();
  let from = 0;
  for (;;) {
    const i = lower.indexOf(email, from);
    if (i < 0) return false;
    if (CREDIT_RE.test(lower.slice(Math.max(0, i - 120), i))) return true;
    from = i + email.length;
  }
}

function fromSnapshot(s: PageSnapshot, country: string | null | undefined, observedAt: Date, isContactPage: boolean): ContactObservation[] {
  const out: ContactObservation[] = [];
  const src = 'website';
  const credit = (e: string) => inCreditLine(`${s.bodyText}\n${s.footerText}`, e);
  for (const href of s.mailtoLinks) {
    const e = emailFromMailto(href);
    if (e && !credit(e)) out.push({ type: 'email', value: e, normalizedValue: e, source: src, sourceUrl: s.url, label: 'mailto link', onOfficialSite: true, observedAt });
  }
  for (const e of extractEmails(s.bodyText)) if (!credit(e)) out.push({ type: 'email', value: e, normalizedValue: e, source: src, sourceUrl: s.url, label: 'visible text', onOfficialSite: true, observedAt });
  for (const e of s.ld.emails) if (isValidEmailSyntax(e.toLowerCase())) out.push({ type: 'email', value: e.toLowerCase(), normalizedValue: e.toLowerCase(), source: src, sourceUrl: s.url, label: 'structured data', onOfficialSite: true, observedAt });
  for (const t of s.telLinks) {
    const p = normalizePhone(t.href.replace(/^tel:/i, ''), country);
    if (p?.valid) out.push({ type: 'phone', value: p.international, normalizedValue: p.e164, source: src, sourceUrl: s.url, label: 'tel link', onOfficialSite: true, observedAt });
  }
  for (const raw of s.ld.phones) {
    const p = normalizePhone(raw, country);
    if (p?.valid) out.push({ type: 'phone', value: p.international, normalizedValue: p.e164, source: src, sourceUrl: s.url, label: 'structured data', onOfficialSite: true, observedAt });
  }
  // visible text: limit to header/footer-ish text and contact pages to avoid picking up random numbers
  const textForPhones = isContactPage ? s.bodyText.slice(0, 40_000) : `${s.firstScreen.text} ${s.footerText}`;
  for (const p of findPhonesInText(textForPhones, country)) {
    out.push({ type: 'phone', value: p.international, normalizedValue: p.e164, source: src, sourceUrl: s.url, label: 'visible text', onOfficialSite: true, observedAt });
  }
  const form = s.forms.find((f) => !f.isSearch && (f.hasEmail || f.hasTextarea || f.hasPhone) && f.fieldCount > 0);
  if (form) out.push({ type: 'contact_form', value: s.url, normalizedValue: s.url.split('#')[0]!.replace(/\/$/, ''), source: src, sourceUrl: s.url, label: `${form.fieldCount}-field form`, onOfficialSite: true, observedAt });
  for (const url of s.socialLinks) {
    const n = socialNetwork(url);
    if (n && !/sharer|share\?|intent\/tweet|\/plugins\//i.test(url)) out.push({ type: 'social', subtype: n, value: url, normalizedValue: normalizeSocial(url), source: src, sourceUrl: s.url, label: 'linked from website', onOfficialSite: true, observedAt });
  }
  return out;
}

export function contactsFromAnalysis(raw: AnalyzerRaw, country: string | null | undefined): ContactObservation[] {
  const at = new Date(raw.finishedAt);
  const out: ContactObservation[] = [];
  const desktop = raw.runs.desktop?.snapshot;
  if (desktop) out.push(...fromSnapshot(desktop, country, at, false));
  const mobile = raw.runs.mobile?.snapshot;
  if (mobile) out.push(...fromSnapshot(mobile, country, at, false).filter((c) => c.type === 'phone' || c.type === 'email'));
  for (const p of raw.pages) if (p.snapshot) out.push(...fromSnapshot(p.snapshot, country, at, p.kind === 'contact'));
  return out;
}

export function contactsFromSources(records: NormalizedBusiness[], country: string | null | undefined): ContactObservation[] {
  const out: ContactObservation[] = [];
  for (const r of records) {
    const p = normalizePhone(r.phone, r.country ?? country);
    if (p?.valid) out.push({ type: 'phone', value: p.international, normalizedValue: p.e164, source: r.provider, sourceUrl: r.profileUrl, label: 'business listing', onOfficialSite: false, observedAt: r.fetchedAt });
    const e = r.email?.toLowerCase();
    if (e && isValidEmailSyntax(e)) out.push({ type: 'email', value: e, normalizedValue: e, source: r.provider, sourceUrl: r.profileUrl, label: 'business listing', onOfficialSite: false, observedAt: r.fetchedAt });
    for (const s of r.socials ?? []) out.push({ type: 'social', subtype: s.network, value: s.url, normalizedValue: normalizeSocial(s.url), source: r.provider, sourceUrl: r.profileUrl, label: 'business listing', onOfficialSite: false, observedAt: r.fetchedAt });
  }
  return out;
}

/**
 * Status rules (documented in docs/lead-scoring.md):
 *  verified   – published on the official website (seen by our analyser), or a phone reported
 *               identically by 2+ independent sources.
 *  probable   – reported by one business listing but not seen on the official site.
 *  unverified – weak/conflicting evidence (e.g. e-mail domain has no mail server).
 */
/** Free mailbox providers: small businesses often use them, so they are not "someone else's" domain. */
const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com', 'zoho.com', 'wp.pl', 'o2.pl', 'onet.pl', 'op.pl', 'onet.eu', 'interia.pl', 'interia.eu', 'poczta.fm', 'gazeta.pl', 'tlen.pl', 'vp.pl', 'autograf.pl', 'buziaczek.pl', 'poczta.onet.pl', 'gmx.de', 'gmx.net', 'gmx.at', 'web.de', 't-online.de', 'freenet.de', 'seznam.cz', 'centrum.cz', 'email.cz', 'ukr.net', 'i.ua', 'meta.ua', 'bigmir.net', 'yandex.ru', 'mail.ru', 'libero.it', 'orange.fr', 'free.fr', 'laposte.net']);

export function resolveContacts(obs: ContactObservation[], opts: { officialDomain?: string | null; mx?: Map<string, boolean | null> } = {}): ResolvedContact[] {
  const groups = new Map<string, ContactObservation[]>();
  for (const o of obs) {
    const k = `${o.type}|${o.normalizedValue}`;
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  const out: ResolvedContact[] = [];
  for (const list of groups.values()) {
    const first = list.find((o) => o.onOfficialSite) ?? list[0]!;
    const onSite = list.some((o) => o.onOfficialSite);
    const independentSources = new Set(list.map((o) => o.source)).size;
    let status: ContactStatus;
    let confidence: Confidence;
    let note: string | undefined;
    const emailDomain = first.type === 'email' ? registrableDomain(first.normalizedValue.split('@')[1] ?? '') : null;
    // (a site served from a bare IP address has no domain to compare with)
    const comparable = !!opts.officialDomain && !/^\d{1,3}(\.\d{1,3}){3}$/.test(opts.officialDomain);
    const foreignDomain = !!emailDomain && comparable && emailDomain !== opts.officialDomain && !FREEMAIL.has(emailDomain);
    if (onSite && foreignDomain) {
      // e.g. a partner, a franchisor, the agency or a data-protection officer — not necessarily this business
      status = 'probable';
      confidence = 'medium';
      note = `Shown on the official website, but the address belongs to ${emailDomain}, not ${opts.officialDomain} — confirm it is this business's inbox.`;
    } else if (onSite) {
      status = 'verified';
      confidence = 'high';
      note = `Published on the official website (${first.sourceUrl ?? 'site'}).`;
    } else if (first.type === 'phone' && independentSources >= 2) {
      status = 'verified';
      confidence = 'medium';
      note = `Reported identically by ${independentSources} independent sources.`;
    } else if (first.source === 'web_search') {
      status = 'unverified';
      confidence = 'low';
    } else {
      status = 'probable';
      confidence = 'medium';
      note = `Reported by ${first.source}; not seen on the official website.`;
    }
    let isRoleBased = false;
    let isPersonal = false;
    if (first.type === 'email') {
      isRoleBased = isRoleBasedEmail(first.normalizedValue);
      isPersonal = looksPersonalEmail(first.normalizedValue);
      const domain = first.normalizedValue.split('@')[1] ?? '';
      const mx = opts.mx?.get(domain);
      if (mx === false) {
        status = 'unverified';
        confidence = 'low';
        note = `${note ?? ''} The domain ${domain} has no mail server (MX) records.`.trim();
      }
      if (status === 'probable' && opts.officialDomain && registrableDomain(domain) === opts.officialDomain) confidence = 'high';
    }
    out.push({
      type: first.type,
      subtype: first.subtype,
      value: first.value,
      normalizedValue: first.normalizedValue,
      source: first.source,
      sourceUrl: first.sourceUrl,
      label: first.label,
      status,
      confidence,
      isRoleBased,
      isPersonal,
      sightings: list.map((o) => ({ source: o.source, sourceUrl: o.sourceUrl, observedAt: o.observedAt.toISOString(), onOfficialSite: o.onOfficialSite })),
      note,
    });
  }
  return out;
}

/** Best available public channel, in order of preference. */
export function contactAvailability(contacts: Array<{ type: string; status: string }>): 'email' | 'form' | 'phone' | 'social' | 'none' {
  const usable = contacts.filter((c) => c.status !== 'unverified');
  if (usable.some((c) => c.type === 'email')) return 'email';
  if (usable.some((c) => c.type === 'contact_form')) return 'form';
  if (usable.some((c) => c.type === 'phone')) return 'phone';
  if (usable.some((c) => c.type === 'social')) return 'social';
  return 'none';
}
