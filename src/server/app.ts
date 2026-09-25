import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, trustProxySetting } from '../config/env.js';
import { getLogger } from '../lib/logger.js';
import { db } from '../db/client.js';
import { registerAuthHooks, registerAuthRoutes } from './auth.js';
import { HttpProblem } from './validation.js';
import { liveWorkers } from '../jobs/worker.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerLeadRoutes } from './routes/leads.js';
import { registerBusinessRoutes } from './routes/business.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';

export interface BuildAppOptions {
  /** Serve the built SPA from this directory (production). */
  webDir?: string | null;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const cfg = loadConfig();
  const app: FastifyInstance = Fastify({
    loggerInstance: getLogger().child({ component: 'api' }) as unknown as FastifyBaseLogger,
    trustProxy: trustProxySetting(cfg.TRUST_PROXY),
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: cfg.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: cfg.isProd,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute', allowList: cfg.isTest ? () => false : undefined });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof HttpProblem) return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err: { message: err.message, stack: err.stack } }, 'request failed');
    if (status === 429) return reply.code(429).send({ error: 'rate_limited', message: 'Too many requests — slow down.' });
    const code = (err as { code?: string }).code;
    if (code === 'P2025') return reply.code(404).send({ error: 'not_found', message: 'Resource not found' });
    return reply.code(status).send({ error: status >= 500 ? 'internal_error' : 'bad_request', message: status >= 500 ? 'Something went wrong. Check the server logs.' : err.message });
  });

  registerAuthHooks(app);
  registerAuthRoutes(app);
  app.get('/api/health', async () => {
    await db().$queryRawUnsafe('SELECT 1');
    const queued = await db().job.count({ where: { status: 'queued' } });
    const running = await db().job.count({ where: { status: 'running' } });
    const workers = await liveWorkers();
    return { ok: true, time: new Date().toISOString(), jobs: { queued, running }, workers };
  });
  registerSearchRoutes(app);
  registerLeadRoutes(app);
  registerBusinessRoutes(app);
  registerWorkspaceRoutes(app);

  const webDir = opts.webDir === undefined ? resolve(process.cwd(), 'dist/web') : opts.webDir;
  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/media/')) return reply.code(404).send({ error: 'not_found', message: 'Route not found' });
      return reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found', message: 'Route not found' }));
  }
  return app;
}
