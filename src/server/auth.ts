import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadConfig } from '../config/env.js';
import { db } from '../db/client.js';
import { constantTimeEqual, hashPassword, randomToken, tokenHash, verifyPassword } from '../lib/crypto.js';
import { parseBody } from './validation.js';

/**
 * Session auth for a single-studio deployment:
 *  - first-run setup creates the owner account (in production it requires SETUP_TOKEN),
 *  - scrypt password hashes, random session tokens stored hashed, httpOnly SameSite=Strict cookie,
 *  - CSRF defence: state-changing requests must carry the `x-aios-csrf` header (cannot be sent
 *    cross-site without CORS, which is not enabled) and a same-origin Origin header when present.
 */
export const SESSION_COOKIE = 'aios_session';
export const CSRF_HEADER = 'x-aios-csrf';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string; name: string | null };
  }
}

const PUBLIC_API = new Set(['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/setup']);

function cookieOptions() {
  const cfg = loadConfig();
  const secure = cfg.isProd || (cfg.APP_URL?.startsWith('https://') ?? false);
  return { httpOnly: true, sameSite: 'strict' as const, secure, path: '/', maxAge: cfg.SESSION_TTL_HOURS * 3600 };
}

async function createSession(reply: FastifyReply, userId: string, userAgent?: string): Promise<void> {
  const cfg = loadConfig();
  const token = randomToken(32);
  await db().session.create({ data: { tokenHash: tokenHash(token), userId, expiresAt: new Date(Date.now() + cfg.SESSION_TTL_HOURS * 3_600_000), userAgent: userAgent?.slice(0, 200) } });
  reply.setCookie(SESSION_COOKIE, token, cookieOptions());
}

function originAllowed(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const cfg = loadConfig();
  try {
    const o = new URL(origin);
    if (cfg.APP_URL && o.origin === new URL(cfg.APP_URL).origin) return true;
    return o.host === req.headers.host;
  } catch {
    return false;
  }
}

export async function authenticate(req: FastifyRequest): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return;
  const session = await db().session.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: true } });
  if (!session || session.expiresAt < new Date()) return;
  req.user = { id: session.user.id, email: session.user.email, name: session.user.name };
  if (Date.now() - session.lastUsedAt.getTime() > 10 * 60_000) {
    await db().session.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
}

export function registerAuthHooks(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    const isApi = path.startsWith('/api/');
    const isMedia = path.startsWith('/media/');
    if (!isApi && !isMedia) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers[CSRF_HEADER] !== '1' || !originAllowed(req)) {
        return reply.code(403).send({ error: 'csrf_check_failed', message: 'Missing CSRF header or cross-origin request.' });
      }
    }
    if (isApi && PUBLIC_API.has(path)) return;
    await authenticate(req);
    if (!req.user) return reply.code(401).send({ error: 'unauthorized', message: 'Sign in required.' });
  });
}

const credentials = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(10).max(200) });

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get('/api/auth/status', async (req) => {
    const users = await db().user.count();
    await authenticate(req);
    return { needsSetup: users === 0, authenticated: !!req.user, user: req.user ?? null, setupTokenRequired: users === 0 && loadConfig().isProd };
  });

  app.post('/api/auth/setup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parseBody(credentials.extend({ name: z.string().trim().max(100).optional(), setupToken: z.string().max(200).optional() }), req.body);
    const cfg = loadConfig();
    if ((await db().user.count()) > 0) return reply.code(409).send({ error: 'already_set_up', message: 'An account already exists. Sign in instead.' });
    if (cfg.isProd && (!cfg.SETUP_TOKEN || !body.setupToken || !constantTimeEqual(body.setupToken, cfg.SETUP_TOKEN))) {
      return reply.code(403).send({ error: 'setup_token_required', message: 'Set SETUP_TOKEN in the server environment and enter it here to create the first account.' });
    }
    const user = await db().user.create({ data: { email: body.email, name: body.name, passwordHash: await hashPassword(body.password) } });
    await createSession(reply, user.id, req.headers['user-agent']);
    return { user: { id: user.id, email: user.email, name: user.name } };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parseBody(z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) }), req.body);
    const user = await db().user.findUnique({ where: { email: body.email } });
    // constant-ish time: always run a hash verification
    const ok = user ? await verifyPassword(body.password, user.passwordHash) : await verifyPassword(body.password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    if (!user || !ok) {
      req.log.warn({ email: body.email.replace(/(.{2}).*@/, '$1***@') }, 'failed login');
      return reply.code(401).send({ error: 'invalid_credentials', message: 'Invalid email or password.' });
    }
    await createSession(reply, user.id, req.headers['user-agent']);
    return { user: { id: user.id, email: user.email, name: user.name } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await db().session.deleteMany({ where: { tokenHash: tokenHash(token) } });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', async (req, reply) => {
    const body = parseBody(z.object({ currentPassword: z.string().max(200), newPassword: z.string().min(10).max(200) }), req.body);
    const user = await db().user.findUnique({ where: { id: req.user!.id } });
    if (!user || !(await verifyPassword(body.currentPassword, user.passwordHash))) return reply.code(400).send({ error: 'invalid_password', message: 'Current password is wrong.' });
    await db().user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } });
    await db().session.deleteMany({ where: { userId: user.id } });
    await createSession(reply, user.id, req.headers['user-agent']);
    return { ok: true };
  });
}
