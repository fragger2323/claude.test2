import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { loadConfig } from '../config/env.js';
import { logger, sanitizeUrlForLog } from './logger.js';
import { withRetry } from './retry.js';
import { abortError } from './concurrency.js';
import { assertPublicUrl, guardedLookup, SsrfError } from './ssrf.js';
import type { TokenBucket } from './rate-limiter.js';

export type HttpErrorCode = 'timeout' | 'network' | 'http' | 'ssrf' | 'aborted' | 'too_large' | 'redirects' | 'budget';

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    message: string,
    public readonly code: HttpErrorCode,
    public readonly provider: string,
    public readonly status?: number,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
    public readonly bodySnippet?: string,
  ) {
    super(message);
  }
}

export interface AttemptInfo {
  provider: string;
  url: string;
  method: string;
  status?: number;
  latencyMs: number;
  attempt: number;
  ok: boolean;
  error?: string;
  bytes?: number;
}

export interface HttpOptions {
  provider: string;
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  limiter?: TokenBucket;
  /** Validate target and every redirect hop against private networks (for untrusted URLs). */
  ssrfGuard?: boolean;
  maxRedirects?: number;
  maxBytes?: number;
  /** Statuses that should be retried. Default: 408, 425, 429, 500, 502, 503, 504. */
  retryStatuses?: number[];
  /** Resolve (not throw) for non-2xx statuses; used by website checks that inspect 404s etc. */
  acceptAnyStatus?: boolean;
  onAttempt?: (info: AttemptInfo) => void;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  url: string;
  headers: Headers;
  redirects: Array<{ url: string; status: number }>;
  body: Buffer;
  truncated: boolean;
  latencyMs: number;
  attempts: number;
  text(): string;
  json<T = unknown>(): T;
}

const DEFAULT_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504];

let directAgent: Dispatcher | null = null;
let guardedAgent: Dispatcher | null = null;
let proxyAgent: Dispatcher | null = null;

function hasProxyEnv(): boolean {
  return !!(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
}

function dispatcherFor(ssrfGuard: boolean): Dispatcher {
  const cfg = loadConfig();
  if (hasProxyEnv()) {
    // Proxy resolves DNS remotely; SSRF is then enforced by the pre-flight check per hop.
    proxyAgent ??= new EnvHttpProxyAgent({ connectTimeout: 15_000 });
    return proxyAgent;
  }
  if (ssrfGuard) {
    guardedAgent ??= new Agent({
      connect: { lookup: guardedLookup(cfg.ALLOW_PRIVATE_NETWORK_TARGETS) as never, timeout: 15_000 },
      keepAliveTimeout: 10_000,
      connections: 64,
    });
    return guardedAgent;
  }
  directAgent ??= new Agent({ connect: { timeout: 15_000 }, keepAliveTimeout: 10_000, connections: 64 });
  return directAgent;
}

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(60_000, Math.max(0, secs * 1000));
  const date = Date.parse(h);
  if (Number.isFinite(date)) return Math.min(60_000, Math.max(0, date - Date.now()));
  return undefined;
}

function decodeBody(buf: Buffer, contentType: string | null): string {
  const m = contentType?.match(/charset=["']?([\w-]+)/i);
  let charset = m?.[1]?.toLowerCase() ?? 'utf-8';
  if (!m && buf.length > 0) {
    const head = buf.subarray(0, 2048).toString('latin1');
    const meta = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
    if (meta?.[1]) charset = meta[1].toLowerCase();
  }
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

async function readLimited(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
  if (!body) return { buf: Buffer.alloc(0), truncated: false };
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(Buffer.from(value.subarray(0, value.byteLength - (total - maxBytes))));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return { buf: Buffer.concat(chunks), truncated };
}

/**
 * Resilient HTTP request: per-attempt timeout, retries with exponential backoff + jitter,
 * Retry-After support, optional token-bucket rate limiting, manual redirects with SSRF
 * validation on every hop, bounded body size, structured logging without secrets.
 */
export async function httpRequest(url: string, opts: HttpOptions): Promise<HttpResponse> {
  const cfg = loadConfig();
  const log = logger('http');
  const method = opts.method ?? (opts.json !== undefined || opts.body !== undefined ? 'POST' : 'GET');
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;
  const retryStatuses = opts.retryStatuses ?? DEFAULT_RETRY_STATUSES;
  const headers: Record<string, string> = {
    'user-agent': cfg.HTTP_USER_AGENT,
    accept: 'application/json, text/html;q=0.9, */*;q=0.8',
    ...opts.headers,
  };
  let body = opts.body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['content-type'] ??= 'application/json';
  }
  const safeUrl = sanitizeUrlForLog(url);
  let attempts = 0;

  return withRetry(
    async (attempt) => {
      attempts = attempt;
      if (opts.signal?.aborted) throw new HttpError('aborted', 'aborted', opts.provider);
      if (opts.limiter) await opts.limiter.take(opts.signal);
      const started = Date.now();
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const redirects: Array<{ url: string; status: number }> = [];
      let current = url;
      try {
        for (let hop = 0; ; hop++) {
          if (opts.ssrfGuard) await assertPublicUrl(current, cfg.ALLOW_PRIVATE_NETWORK_TARGETS);
          const res = await undiciFetch(current, {
            method: hop === 0 ? method : method === 'HEAD' ? 'HEAD' : 'GET',
            headers,
            body: hop === 0 && method === 'POST' ? body : undefined,
            redirect: 'manual',
            signal,
            dispatcher: dispatcherFor(!!opts.ssrfGuard),
          });
          if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            await res.body?.cancel().catch(() => undefined);
            redirects.push({ url: current, status: res.status });
            if (hop >= maxRedirects) throw new HttpError(`too many redirects (${maxRedirects})`, 'redirects', opts.provider, res.status);
            current = new URL(res.headers.get('location')!, current).toString();
            continue;
          }
          const { buf, truncated } = method === 'HEAD' ? { buf: Buffer.alloc(0), truncated: false } : await readLimited(res.body as ReadableStream<Uint8Array> | null, maxBytes);
          const latencyMs = Date.now() - started;
          const info: AttemptInfo = { provider: opts.provider, url: safeUrl, method, status: res.status, latencyMs, attempt, ok: res.ok, bytes: buf.length };
          opts.onAttempt?.(info);
          log.debug({ provider: opts.provider, request: `${method} ${safeUrl}`, status: res.status, latencyMs, attempt, bytes: buf.length }, 'http response');
          if (!res.ok && !opts.acceptAnyStatus) {
            const retryable = retryStatuses.includes(res.status);
            const snippet = buf.subarray(0, 300).toString('utf8');
            throw new HttpError(`HTTP ${res.status} from ${opts.provider}`, 'http', opts.provider, res.status, retryable, parseRetryAfter(res.headers.get('retry-after')), snippet);
          }
          const contentType = res.headers.get('content-type');
          const resp: HttpResponse = {
            status: res.status,
            ok: res.ok,
            url: current,
            headers: res.headers as unknown as Headers,
            redirects,
            body: buf,
            truncated,
            latencyMs,
            attempts: attempt,
            text: () => decodeBody(buf, contentType),
            json: <T>() => JSON.parse(buf.toString('utf8')) as T,
          };
          return resp;
        }
      } catch (e) {
        const latencyMs = Date.now() - started;
        let err: unknown = e;
        if (e instanceof HttpError) err = e;
        else if (e instanceof SsrfError) err = new HttpError(e.message, 'ssrf', opts.provider, undefined, false);
        else if (opts.signal?.aborted) err = new HttpError('aborted', 'aborted', opts.provider);
        else if (timeout.aborted) err = new HttpError(`timeout after ${timeoutMs}ms`, 'timeout', opts.provider, undefined, true);
        else {
          const cause = (e as { cause?: { code?: string; message?: string } }).cause;
          const code = cause?.code;
          const ssrf = code === 'ESSRF';
          err = new HttpError(
            `${ssrf ? 'blocked' : 'network error'}: ${cause?.message ?? (e as Error).message}`,
            ssrf ? 'ssrf' : 'network',
            opts.provider,
            undefined,
            !ssrf && code !== 'ENOTFOUND' && code !== 'ERR_INVALID_URL',
          );
        }
        const he = err as HttpError;
        if (he.code !== 'http') {
          opts.onAttempt?.({ provider: opts.provider, url: safeUrl, method, latencyMs, attempt, ok: false, error: he.message });
        }
        log.debug({ provider: opts.provider, request: `${method} ${safeUrl}`, status: he.status, latencyMs, attempt, error: he.message }, 'http failure');
        throw err;
      }
    },
    {
      retries: opts.retries ?? 2,
      baseDelayMs: 600,
      maxDelayMs: 15_000,
      signal: opts.signal,
      shouldRetry: (e) => e instanceof HttpError && e.retryable,
      delayFor: (e) => (e instanceof HttpError ? e.retryAfterMs : undefined),
      onRetry: (e, attempt, delayMs) =>
        log.info({ provider: opts.provider, request: `${method} ${safeUrl}`, retry: attempt, delayMs, error: (e as Error).message }, 'http retry'),
    },
  ).catch((e: unknown) => {
    if (opts.signal?.aborted && !(e instanceof HttpError)) throw abortError(opts.signal);
    if (e instanceof HttpError) Object.assign(e, { attempts });
    throw e;
  });
}
