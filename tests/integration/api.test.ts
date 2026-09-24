import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { db } from '../../src/db/client.js';
import { ensureDefaults } from '../../src/engine/defaults.js';
import { loadConfig } from '../../src/config/env.js';
import { invalidateSecretCache } from '../../src/config/secrets.js';
import { resetDb } from '../support/db.js';
import { seedLead } from '../support/seed.js';

let app: FastifyInstance;
let cookie = '';
const EMAIL = 'owner@studio.test';
const PASSWORD = 'correct horse battery staple';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
function call(method: Method, url: string, payload?: unknown, opts: { csrf?: boolean; auth?: boolean; origin?: string } = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {};
  if (opts.csrf !== false && method !== 'GET') headers['x-aios-csrf'] = '1';
  if (opts.auth !== false && cookie) headers.cookie = cookie;
  if (opts.origin) headers.origin = opts.origin;
  return app.inject({ method, url, payload: payload as never, headers });
}

beforeAll(async () => {
  await resetDb();
  await ensureDefaults();
  app = await buildApp({ webDir: null });
});
afterAll(async () => {
  await app.close();
});

describe('auth', () => {
  it('first run: needs setup; protected routes return 401', async () => {
    const s = (await call('GET', '/api/auth/status')).json();
    expect(s).toMatchObject({ needsSetup: true, authenticated: false });
    expect((await call('GET', '/api/leads')).statusCode).toBe(401);
  });

  it('state-changing requests without the CSRF header or from another origin are rejected', async () => {
    expect((await call('POST', '/api/auth/setup', { email: EMAIL, password: PASSWORD }, { csrf: false })).statusCode).toBe(403);
    expect((await call('POST', '/api/auth/setup', { email: EMAIL, password: PASSWORD }, { origin: 'https://evil.example' })).statusCode).toBe(403);
  });

  it('validates input', async () => {
    const r = await call('POST', '/api/auth/setup', { email: 'not-an-email', password: 'short' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('validation_error');
  });

  it('setup creates the owner, sets an httpOnly SameSite=Strict cookie, and cannot run twice', async () => {
    const r = await call('POST', '/api/auth/setup', { email: EMAIL, password: PASSWORD, name: 'Owner' });
    expect(r.statusCode).toBe(200);
    const setCookie = String(r.headers['set-cookie']);
    expect(setCookie).toMatch(/aios_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    cookie = setCookie.split(';')[0]!;
    expect((await call('POST', '/api/auth/setup', { email: 'x@y.test', password: PASSWORD })).statusCode).toBe(409);
    const user = await db().user.findFirst();
    expect(user!.passwordHash).not.toContain(PASSWORD);
    const session = await db().session.findFirst();
    expect(session!.tokenHash).not.toBe(cookie.split('=')[1]);
  });

  it('login rejects wrong passwords and accepts the right one', async () => {
    expect((await call('POST', '/api/auth/login', { email: EMAIL, password: 'wrong password!!' }, { auth: false })).statusCode).toBe(401);
    const ok = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD }, { auth: false });
    expect(ok.statusCode).toBe(200);
    expect((await call('GET', '/api/auth/status')).json().authenticated).toBe(true);
  });
});

describe('search API', () => {
  it('parses commands', async () => {
    const r = await call('POST', '/api/command/parse', { text: 'Find 100 dental clinics in Warsaw for premium website redesign' });
    expect(r.json()).toMatchObject({ quantity: 100, location: 'Warsaw', country: 'Poland' });
  });

  it('rejects invalid search params and enqueues valid searches', async () => {
    expect((await call('POST', '/api/search', { params: { niche: '', location: 'Warsaw', country: 'Poland', quantity: 5000 } })).statusCode).toBe(400);
    const r = await call('POST', '/api/search', { params: { niche: 'dentists', location: 'Warszawa', country: 'Poland', quantity: 20, service: 'website redesign' }, campaignName: 'Warsaw dentists' });
    expect(r.statusCode).toBe(200);
    const { searchJobId, campaignId } = r.json();
    expect(campaignId).toBeTruthy();
    const job = await db().job.findFirst({ where: { searchJobId } });
    expect(job?.status).toBe('queued');
    // pause → cancel → retry state machine
    expect((await call('POST', `/api/search-jobs/${searchJobId}/pause`)).statusCode).toBe(200);
    expect((await db().searchJob.findUnique({ where: { id: searchJobId } }))!.status).toBe('paused');
    expect((await call('POST', `/api/search-jobs/${searchJobId}/cancel`)).statusCode).toBe(200);
    expect((await db().searchJob.findUnique({ where: { id: searchJobId } }))!.status).toBe('cancelled');
    expect((await call('POST', `/api/search-jobs/${searchJobId}/cancel`)).statusCode).toBe(409);
    expect((await call('POST', `/api/search-jobs/${searchJobId}/retry`)).statusCode).toBe(200);
    const detail = (await call('GET', `/api/search-jobs/${searchJobId}`)).json();
    expect(detail.status).toBe('queued');
    await db().job.deleteMany({});
  });

  it('rejects malformed ids', async () => {
    expect((await call('GET', '/api/search-jobs/..%2F..%2Fetc')).statusCode).toBe(400);
  });
});

describe('CRM flow', () => {
  it('stage changes, follow-ups, activities and outcomes are recorded', async () => {
    const { lead } = await seedLead({ name: 'Crm Dental' });
    expect((await call('PATCH', `/api/leads/${lead.id}`, { stage: 'not-a-stage' })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/leads/${lead.id}`, { stage: 'contact_ready' })).json().stage).toBe('contact_ready');
    const due = new Date(Date.now() + 86_400_000).toISOString();
    const fu = (await call('POST', `/api/leads/${lead.id}/followups`, { dueAt: due, note: 'Call back' })).json();
    expect(fu.status).toBe('pending');
    expect((await db().lead.findUnique({ where: { id: lead.id } }))!.nextFollowUpAt).not.toBeNull();
    expect((await call('PATCH', `/api/followups/${fu.id}`, { status: 'done' })).json().status).toBe('done');
    expect((await call('POST', `/api/leads/${lead.id}/activities`, { type: 'note', summary: 'Spoke to reception' })).statusCode).toBe(200);
    const outcome = (await call('POST', `/api/leads/${lead.id}/outcomes`, { type: 'replied' })).json();
    expect(outcome.type).toBe('replied');
    const after = await db().lead.findUnique({ where: { id: lead.id } });
    expect(after!.stage).toBe('replied');
    expect(after!.contactedAt).not.toBeNull();
    expect(after!.contactedFeatures).not.toBeNull();
    const board = (await call('GET', '/api/crm/board')).json();
    expect(JSON.stringify(board)).toContain('Crm Dental');
    const activities = await db().activity.findMany({ where: { leadId: lead.id } });
    expect(activities.map((a) => a.type)).toEqual(expect.arrayContaining(['stage_change', 'followup_scheduled', 'followup_done', 'note', 'outcome']));
  });

  it('manual contacts are validated; invented e-mails are not accepted as verified', async () => {
    const { lead } = await seedLead();
    expect((await call('POST', `/api/leads/${lead.id}/contacts`, { type: 'email', value: 'not an email' })).statusCode).toBe(400);
    expect((await call('POST', `/api/leads/${lead.id}/contacts`, { type: 'phone', value: '123' })).statusCode).toBe(400);
    const c = (await call('POST', `/api/leads/${lead.id}/contacts`, { type: 'email', value: 'Recepcja@Clinic.pl' })).json();
    expect(c).toMatchObject({ status: 'probable', source: 'manual', normalizedValue: 'recepcja@clinic.pl' });
  });

  it('lead list filters and sorts', async () => {
    await seedLead({ name: 'Zeta Low', priority: 'low' });
    const r = (await call('GET', '/api/leads?priority=low&sort=leadFit&dir=desc')).json();
    expect(r.rows.every((row: { priority: string }) => row.priority === 'low')).toBe(true);
    expect(r.total).toBeGreaterThan(0);
    expect((await call('GET', '/api/leads?pageSize=100000')).statusCode).toBe(400);
  });
});

describe('exports', () => {
  it('CSV export neutralises formula injection', async () => {
    await seedLead({ name: '=HYPERLINK("http://evil.example","x")' });
    const r = await call('GET', '/api/export/leads?format=csv');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.body).toContain(`"'=HYPERLINK(`);
    expect(r.body).not.toMatch(/(^|,|\n)=HYPERLINK/);
  });
});

describe('settings & secrets', () => {
  it('stores API keys encrypted and never returns them', async () => {
    const secret = 'AIzaSyTESTSECRET1234567890abcdef';
    expect((await call('PUT', '/api/settings/secrets/NOT_A_KEY', { value: 'x' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/settings/secrets/GOOGLE_PLACES_API_KEY', { value: secret })).statusCode).toBe(200);
    const row = await db().secretSetting.findFirst({ where: { name: 'GOOGLE_PLACES_API_KEY' } });
    expect(JSON.stringify(row)).not.toContain(secret);
    const settings = await call('GET', '/api/settings/providers');
    expect(settings.statusCode).toBe(200);
    expect(settings.body).not.toContain(secret);
    expect(settings.body).toContain('cdef'); // last 4 only
    await call('PUT', '/api/settings/secrets/GOOGLE_PLACES_API_KEY', { value: null });
    invalidateSecretCache();
  });

  it('business profile and services are editable', async () => {
    const p = await call('PUT', '/api/business/profile', { studioName: 'Pixel Studio', senderName: 'Anna', languages: ['pl', 'en'] });
    expect(p.statusCode).toBe(200);
    const services = (await call('GET', '/api/services')).json();
    expect(services.length).toBeGreaterThanOrEqual(10);
  });
});

describe('media', () => {
  it('serves screenshots only for safe paths and only when signed in', async () => {
    const dir = join(loadConfig().DATA_DIR, 'screenshots', 'clx0000000000000000000000');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'desktop-viewport.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    expect((await call('GET', '/media/screenshots/clx0000000000000000000000/desktop-viewport.jpg')).statusCode).toBe(200);
    expect((await call('GET', '/media/screenshots/clx0000000000000000000000/desktop-viewport.jpg', undefined, { auth: false })).statusCode).toBe(401);
    expect((await call('GET', '/media/screenshots/clx0000000000000000000000/..%2F..%2F..%2Fetc%2Fpasswd')).statusCode).toBe(400);
    expect((await call('GET', '/media/screenshots/..%2F..%2F/x.jpg')).statusCode).toBe(400);
  });
});

describe('dashboard, today and learning use real data only', () => {
  it('learning reports insufficient data instead of inventing a model', async () => {
    const r = (await call('POST', '/api/learning/train', { target: 'reply' })).json();
    expect(r.status).toBe('insufficient_data');
    expect(r.active).toBe(false);
    expect(r.note).toMatch(/Not enough labelled outcomes/);
  });

  it('today and dashboard respond', async () => {
    const t = await call('GET', '/api/today');
    expect(t.statusCode).toBe(200);
    expect(t.json().learning.needed).toBe(40);
    const d = await call('GET', '/api/dashboard');
    expect(d.statusCode).toBe(200);
  });

  it('logout invalidates the session', async () => {
    await call('POST', '/api/auth/logout');
    expect((await call('GET', '/api/leads')).statusCode).toBe(401);
  });
});
