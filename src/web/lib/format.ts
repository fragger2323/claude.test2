import { CRM_STAGE_LABELS, PRIORITY_LABELS, type CrmStage, type Priority } from '../../domain/types';

export function relTime(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const t = typeof d === 'string' ? new Date(d) : d;
  const diff = Date.now() - t.getTime();
  const abs = Math.abs(diff);
  const fut = diff < 0;
  const m = Math.round(abs / 60_000);
  let s: string;
  if (m < 1) s = 'just now';
  else if (m < 60) s = `${m}m`;
  else if (m < 60 * 24) s = `${Math.round(m / 60)}h`;
  else if (m < 60 * 24 * 30) s = `${Math.round(m / 1440)}d`;
  else if (m < 60 * 24 * 365) s = `${Math.round(m / 43200)}mo`;
  else s = `${Math.round(m / 525600)}y`;
  if (s === 'just now') return s;
  return fut ? `in ${s}` : `${s} ago`;
}

export function fmtDate(d: string | Date | null | undefined, withTime = false): string {
  if (!d) return '—';
  const t = typeof d === 'string' ? new Date(d) : d;
  return withTime ? t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : t.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function pct(v: number | null | undefined, digits = 0): string {
  return v == null ? '—' : `${(v * 100).toFixed(digits)}%`;
}

export function priorityLabel(p: string | null | undefined): string {
  return p ? PRIORITY_LABELS[p as Priority] ?? p : 'Not scored';
}

export function stageLabel(s: string): string {
  return CRM_STAGE_LABELS[s as CrmStage] ?? s;
}

export function hostname(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function money(min: number | null | undefined, max: number | null | undefined, currency = 'EUR'): string {
  const f = (n: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  if (min == null && max == null) return '—';
  if (min != null && max != null) return `${f(min)} – ${f(max)}`;
  return f((min ?? max)!);
}

export const PROVIDER_NAMES: Record<string, string> = {
  google_places: 'Google Places',
  foursquare: 'Foursquare',
  yelp: 'Yelp',
  osm: 'OpenStreetMap',
  web_search: 'Web Search',
  import: 'Import',
  website: 'Website',
  manual: 'Manual',
  nominatim: 'Nominatim',
  anthropic: 'Claude (AI)',
  brave_search: 'Brave Search',
  google_cse: 'Google Programmable Search',
};

export function providerName(id: string): string {
  return PROVIDER_NAMES[id] ?? titleCase(id);
}
