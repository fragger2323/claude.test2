import { httpRequest, HttpError } from '../../lib/http.js';

/**
 * Lightweight HTML fetch (no browser) used for website verification and HTTP-level checks.
 * All targets are untrusted → SSRF guard on every hop.
 */
export interface FetchedPage {
  ok: boolean;
  status?: number;
  url: string;
  finalUrl?: string;
  redirects: Array<{ url: string; status: number }>;
  headers?: Record<string, string>;
  html: string;
  title: string;
  text: string;
  latencyMs?: number;
  error?: string;
  errorCode?: string;
}

export function htmlTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeEntities((m?.[1] ?? '').replace(/\s+/g, ' ').trim()).slice(0, 300);
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

export async function fetchPage(url: string, opts: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; method?: 'GET' | 'HEAD' } = {}): Promise<FetchedPage> {
  try {
    const res = await httpRequest(url, {
      provider: 'website',
      method: opts.method ?? 'GET',
      ssrfGuard: true,
      acceptAnyStatus: true,
      timeoutMs: opts.timeoutMs ?? 15_000,
      retries: 1,
      maxBytes: opts.maxBytes ?? 2 * 1024 * 1024,
      signal: opts.signal,
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': 'en;q=0.8,*;q=0.5' },
    });
    const html = opts.method === 'HEAD' ? '' : res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      url,
      finalUrl: res.url,
      redirects: res.redirects,
      headers,
      html,
      title: htmlTitle(html),
      text: htmlToText(html).slice(0, 100_000),
      latencyMs: res.latencyMs,
    };
  } catch (e) {
    const he = e instanceof HttpError ? e : null;
    return { ok: false, url, redirects: [], html: '', title: '', text: '', error: (e as Error).message, errorCode: he?.code ?? 'network' };
  }
}
