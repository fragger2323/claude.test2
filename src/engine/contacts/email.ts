import { resolveMx } from 'node:dns/promises';

/**
 * E-mail helpers. We only use e-mails that are published in plain form (text or mailto:).
 * We never guess addresses (e.g. firstname@domain), never de-obfuscate addresses that site
 * owners deliberately hid, and never probe mailboxes via SMTP.
 */
const EMAIL_RE = /[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}/gi;

const JUNK_DOMAINS = /(^|\.)(example\.(com|org|net)|domain\.(com|pl)|email\.com|yourdomain|sentry\.io|wixpress\.com|sentry-next\.wixpress\.com|godaddy\.com|test\.com|localhost)$/i;
const FILE_LIKE = /\.(png|jpe?g|gif|webp|svg|avif|css|js|ico)$/i;

export function isValidEmailSyntax(email: string): boolean {
  if (email.length > 254) return false;
  const m = email.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!m) return false;
  const [, local, domain] = m;
  if (!local || !domain || local.length > 64) return false;
  if (FILE_LIKE.test(email) || JUNK_DOMAINS.test(domain)) return false;
  return new RegExp(`^${EMAIL_RE.source}$`, 'i').test(email);
}

export function extractEmails(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.slice(0, 300_000).matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase().replace(/^[._-]+|[._-]+$/g, '');
    if (isValidEmailSyntax(e)) out.add(e);
  }
  return [...out];
}

export function emailFromMailto(href: string): string | null {
  if (!/^mailto:/i.test(href)) return null;
  try {
    const addr = decodeURIComponent(href.slice(7).split('?')[0] ?? '').trim().toLowerCase();
    return isValidEmailSyntax(addr) ? addr : null;
  } catch {
    return null;
  }
}

const ROLE_LOCALS = /^(info|kontakt|contact|office|biuro|recepcja|reception|rejestracja|hello|hi|hallo|sales|sprzedaz|support|help|admin|mail|post|team|studio|klinika|clinic|booking|rezerwacje|reservations?|zapisy|enquiries|inquiries|service|serwis|praxis|kanzlei|sekretariat|secretariat|bok|office\d*)$/i;

export function isRoleBasedEmail(email: string): boolean {
  const local = email.split('@')[0] ?? '';
  return ROLE_LOCALS.test(local);
}

/** Looks like an individual's address (e.g. jan.kowalski@) — handle with extra care (GDPR). */
export function looksPersonalEmail(email: string): boolean {
  const local = email.split('@')[0] ?? '';
  if (isRoleBasedEmail(email)) return false;
  return /^[a-z]{2,}[._-][a-z]{2,}$/i.test(local) || /^[a-z]\.[a-z]{2,}$/i.test(local);
}

const mxCache = new Map<string, { ok: boolean; at: number }>();

/** Domain accepts mail (has MX records). This does NOT verify the mailbox exists. */
export async function domainHasMx(domain: string): Promise<boolean | null> {
  const hit = mxCache.get(domain);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.ok;
  try {
    const mx = await resolveMx(domain);
    const ok = mx.length > 0;
    mxCache.set(domain, { ok, at: Date.now() });
    return ok;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      mxCache.set(domain, { ok: false, at: Date.now() });
      return false;
    }
    return null;
  }
}
