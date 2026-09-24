import pino, { type Logger } from 'pino';
import { loadConfig } from '../config/env.js';

/**
 * Structured JSON logging. Secret-bearing fields are redacted at the serializer level,
 * and URLs are passed through `sanitizeUrlForLog` before logging by the HTTP client.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers["x-goog-api-key"]',
  'headers["x-subscription-token"]',
  'headers["x-api-key"]',
  'apiKey',
  'key',
  'token',
  'password',
  'passwordHash',
  '*.apiKey',
  '*.password',
  '*.token',
  '*.secret',
];

let root: Logger | null = null;

export function getLogger(): Logger {
  if (root) return root;
  const cfg = loadConfig();
  root = pino({
    level: cfg.isTest ? (process.env.LOG_LEVEL ?? 'silent') : cfg.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { app: 'aios' },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: cfg.LOG_PRETTY ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  });
  return root;
}

export function logger(component: string): Logger {
  return getLogger().child({ component });
}

const SECRET_QUERY_PARAMS = /^(key|api_key|apikey|token|access_token|client_secret|cx|sig|signature)$/i;

/** Removes credentials from URLs before they are logged or stored. */
export function sanitizeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_QUERY_PARAMS.test(k)) u.searchParams.set(k, '[redacted]');
    }
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return '[unparseable-url]';
  }
}
