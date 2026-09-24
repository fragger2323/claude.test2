import { beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { db } from '../../src/db/client.js';
import { claimNextJob, completeJob, enqueueJob, failJob, heartbeat, requeueStaleJobs } from '../../src/jobs/queue.js';
import { runHandler } from '../../src/jobs/handlers.js';
import { trainOutcomeModel, loadActiveModel, MIN_SAMPLES } from '../../src/engine/learning/trainer.js';
import { mulberry32 } from '../../src/engine/learning/logistic.js';
import { parseImport } from '../../src/providers/import/index.js';
import { ensureDefaults } from '../../src/engine/defaults.js';
import { buildApp } from '../../src/server/app.js';
import { resetDb } from '../support/db.js';
import { seedLead } from '../support/seed.js';

const log = pino({ level: 'silent' });

describe('job queue', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('claims by priority, never twice, and completes', async () => {
    const low = await enqueueJob('maintenance', {}, { priority: 0 });
    const high = await enqueueJob('maintenance', {}, { priority: 5 });
    const a = await claimNextJob();
    const b = await claimNextJob();
    const c = await claimNextJob();
    expect(a!.id).toBe(high.id);
    expect(b!.id).toBe(low.id);
    expect(c).toBeNull();
    expect(a!.attempts).toBe(1);
    await completeJob(a!.id, { ok: true });
    expect((await db().job.findUnique({ where: { id: a!.id } }))!.status).toBe('completed');
  });

  it('concurrent claimers get distinct jobs', async () => {
    for (let i = 0; i < 5; i++) await enqueueJob('maintenance', { i });
    const claimed = await Promise.all(Array.from({ length: 8 }, () => claimNextJob()));
    const ids = claimed.filter(Boolean).map((j) => j!.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(5);
  });

  it('retries with backoff, then fails permanently', async () => {
    const j = await enqueueJob('maintenance', {}, { maxAttempts: 2 });
    await claimNextJob();
    expect(await failJob(j.id, 'boom')).toBe('retrying');
    const retry = await db().job.findUnique({ where: { id: j.id } });
    expect(retry!.status).toBe('queued');
    expect(retry!.runAfter.getTime()).toBeGreaterThan(Date.now());
    expect(await claimNextJob()).toBeNull(); // not before runAfter
    await db().job.update({ where: { id: j.id }, data: { runAfter: new Date(0) } });
    await claimNextJob();
    expect(await failJob(j.id, 'boom again')).toBe('failed');
    expect((await db().job.findUnique({ where: { id: j.id } }))!.lastError).toBe('boom again');
  });

  it('re-queues jobs whose lease expired (crashed worker) and extends leases on heartbeat', async () => {
    const j = await enqueueJob('maintenance', {});
    await claimNextJob();
    await heartbeat(j.id);
    expect(await requeueStaleJobs()).toBe(0);
    await db().job.update({ where: { id: j.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect(await requeueStaleJobs()).toBe(1);
    expect((await db().job.findUnique({ where: { id: j.id } }))!.status).toBe('queued');
  });
});

describe('learning from outcomes', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('trains only with enough data, and activates only if it beats the base rate', async () => {
    const rand = mulberry32(11);
    for (let i = 0; i < MIN_SAMPLES + 30; i++) {
      const { lead } = await seedLead({ name: `Learn ${i}` });
      const need = rand();
      const replied = rand() < 0.1 + 0.8 * need;
      const snapshot = { websiteNeed: need, serviceFit: rand(), businessFit: 0.5, contactability: 0.6, freshness: 0.8, technicalOpportunity: need, commercialRelevance: 0.5, leadFit: 0.5 + need / 3, priorityRank: 0.6, hasEmail: 1, hasFormOnly: 0, phoneOnly: 0, noWebsite: 0, cat_industry: 'dentist', cat_service: 'website-redesign', cat_sources: ['osm'], cat_problems: [] };
      await db().lead.update({ where: { id: lead.id }, data: { contactedAt: new Date(), contactedFeatures: snapshot, stage: replied ? 'replied' : 'no_reply' } });
      await db().outcome.create({ data: { leadId: lead.id, type: replied ? 'replied' : 'no_reply', features: snapshot } });
    }
    const report = await trainOutcomeModel('reply');
    expect(report.status).toBe('trained');
    expect(report.sampleSize).toBe(MIN_SAMPLES + 30);
    expect(report.metrics).toHaveProperty('brier');
    expect(report.metrics).toHaveProperty('baselineBrier');
    if (report.active) {
      const m = await loadActiveModel('reply');
      expect(m).not.toBeNull();
      expect(report.insights!.some((x) => x.feature === 'websiteNeed' && x.effect === 'positive')).toBe(true);
    } else {
      expect(report.note).toMatch(/NOT used/);
    }
  });

  it('with too few outcomes the heuristic stays in charge', async () => {
    const { lead } = await seedLead();
    await db().lead.update({ where: { id: lead.id }, data: { contactedAt: new Date(), contactedFeatures: { websiteNeed: 0.5 } } });
    await db().outcome.create({ data: { leadId: lead.id, type: 'won' } });
    const r = await trainOutcomeModel('won');
    expect(r.status).toBe('insufficient_data');
    expect(await loadActiveModel('won')).toBeNull();
  });
});

describe('CSV / JSON import', () => {
  beforeEach(async () => {
    await resetDb();
    await ensureDefaults();
  });

  it('maps columns, sanitises values and rejects unusable rows', () => {
    const csv = 'Company Name,Website,Phone,City,E-mail\n"Smile\u0007 Dental",smile-dental.pl,22 123 45 67,Warszawa,info@smile-dental.pl\n,missing-name.pl,,,\nBella,javascript:alert(1),,Kraków,not-an-email\n';
    const r = parseImport(csv, 'csv', { country: 'Poland', category: 'dentist' });
    expect(r.records).toHaveLength(2);
    expect(r.skipped).toBe(1);
    expect(r.records[0]).toMatchObject({ name: 'Smile Dental', city: 'Warszawa', provider: 'import' });
    expect(r.records[0]!.website).toMatch(/smile-dental\.pl/);
    expect(r.records[1]!.website).toBeFalsy();
    expect(r.records[1]!.email).toBeFalsy();
    expect(parseImport('{"not":"an array"', 'json', { country: 'PL' }).errors).toEqual(['invalid JSON']);
    expect(parseImport('{"a":1}', 'json').records).toEqual([]);
    expect(parseImport('[{"name":"Json Clinic","website":"https://json.pl"}]', 'json').records[0]!.name).toBe('Json Clinic');
  });

  it('import API + job merges rows into companies and leads without website analysis', async () => {
    const app = await buildApp({ webDir: null });
    try {
      const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { 'x-aios-csrf': '1' }, payload: { email: 'import@studio.test', password: 'long enough password' } });
      const cookie = String(setup.headers['set-cookie']).split(';')[0]!;
      const csv = 'name,phone,city,address\nKowalski Dent,601 111 222,Warszawa,Grójecka 50\nKowalski Dent,+48 601 111 222,Warszawa,Grójecka 50\nNowak Ortho,22 777 88 99,Warszawa,Puławska 1\n';
      const r = await app.inject({
        method: 'POST',
        url: '/api/import',
        headers: { 'x-aios-csrf': '1', cookie },
        payload: { format: 'csv', content: csv, defaults: { niche: 'dentist', location: 'Warszawa', country: 'Poland' }, analyzeWebsites: false },
      });
      expect(r.statusCode).toBe(200);
      const { searchJobId, imported } = r.json();
      expect(imported).toBe(3);
      const job = await claimNextJob(['import']);
      expect(job?.searchJobId).toBe(searchJobId);
      const res = await runHandler('import', job!.payload, { jobId: job!.id, log, heartbeat: async () => {} });
      expect(res.status).toBe('completed');
      expect(await db().company.count()).toBe(2); // duplicate rows merged (same phone + name)
      expect(await db().lead.count()).toBe(2);
      const sj = await db().searchJob.findUnique({ where: { id: searchJobId } });
      expect(sj!.status).toBe('completed');
      expect(await db().analysis.count()).toBe(0);
    } finally {
      await app.close();
    }
  });
});
