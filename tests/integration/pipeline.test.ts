import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfigForTests, loadConfig } from '../../src/config/env.js';
import { invalidateSecretCache } from '../../src/config/secrets.js';
import { db } from '../../src/db/client.js';
import { ensureDefaults } from '../../src/engine/defaults.js';
import { syncSourceRows } from '../../src/providers/registry.js';
import { enqueueJob } from '../../src/jobs/queue.js';
import { Worker } from '../../src/jobs/worker.js';
import { generateAuditForLead, generateOutreachForLead, renderAuditHtml } from '../../src/engine/reports/generate.js';
import { logger } from '../../src/lib/logger.js';
import { jsonArray } from '../../src/lib/misc.js';
import type { SearchParams } from '../../src/domain/search-params.js';
import { startFixtureSites, type FixtureSites } from '../support/fixture-sites.js';
import { mockProviderEnv, startMockProviders, type MockProviders } from '../support/mock-providers.js';
import { resetDb } from '../support/db.js';

let sites: FixtureSites;
let mock: MockProviders;
let worker: Worker;
const saved: Record<string, string | undefined> = {};
const log = logger('test');

const params = (over: Partial<SearchParams> = {}): SearchParams => ({
  niche: 'стоматологии',
  location: 'Warszawa',
  country: 'Poland',
  service: 'website redesign',
  quantity: 20,
  language: 'auto',
  excludeExistingClients: true,
  excludePreviouslyContacted: true,
  onlyWithWebsite: false,
  onlyWithPublicContact: false,
  minCompanySize: 'any',
  businessModel: 'any',
  priceSegment: 'any',
  preferredIndustries: [],
  excludedIndustries: [],
  providers: [],
  analyzeWebsites: true,
  visualAi: false,
  generateAudits: 'none',
  ...over,
} as SearchParams);

async function startSearch(p: SearchParams) {
  const campaign = await db().campaign.create({ data: { name: `Test ${Date.now()}`, industry: 'dentist', location: p.location, country: p.country } });
  const sj = await db().searchJob.create({ data: { campaignId: campaign.id, params: p as never, progress: {}, counts: {}, sourcesUsed: {}, strategyLog: [] } });
  await enqueueJob('search', { searchJobId: sj.id }, { searchJobId: sj.id, priority: 1 });
  return sj.id;
}

async function waitFor(searchJobId: string, statuses: string[], timeoutMs = 150_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const j = await db().searchJob.findUnique({ where: { id: searchJobId } });
    if (j && statuses.includes(j.status)) return j;
    if (Date.now() > end) throw new Error(`timeout waiting for ${statuses.join('/')} (status ${j?.status}, stage ${j?.stage})`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  sites = await startFixtureSites();
  mock = await startMockProviders(sites.urls);
  const env = mockProviderEnv(mock.url);
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  Object.assign(process.env, env);
  resetConfigForTests();
  invalidateSecretCache();
  await resetDb();
  await ensureDefaults();
  await syncSourceRows();
  worker = new Worker(1, 100);
  await worker.start();
});

afterAll(async () => {
  await worker?.stop();
  await mock?.close();
  await sites?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigForTests();
});

describe('full search pipeline (mock providers + live fixture websites)', () => {
  let searchJobId = '';

  it('discovers, merges, verifies, analyses and qualifies leads', async () => {
    searchJobId = await startSearch(params());
    const job = await waitFor(searchJobId, ['completed', 'failed']);
    expect(job.status).toBe('completed');
    expect(job.stage).toBe('completed');
    const counts = job.counts as Record<string, number>;
    expect(counts.found).toBeGreaterThanOrEqual(8);
    expect(counts.duplicatesMerged).toBeGreaterThanOrEqual(2);
    expect(counts.valid).toBe(5); // 6 unique companies, 1 permanently closed
    expect(counts.excluded).toBeGreaterThanOrEqual(1);
    expect(await db().campaignLead.count({ where: { searchJobId } })).toBe(6);
    expect(counts.analyzed).toBeGreaterThanOrEqual(3);

    // strategy log and per-query stats were recorded
    expect(jsonArray(job.strategyLog).length).toBeGreaterThan(3);
    const queries = await db().searchQuery.findMany({ where: { searchJobId } });
    expect(queries.length).toBeGreaterThan(1);
    expect(queries.some((q) => q.language === 'pl' && /Warszawa/.test(q.text))).toBe(true);
  });

  it('merges duplicates with provenance and surfaces conflicting data', async () => {
    const companies = await db().company.findMany({ include: { sourceRecords: true, website: true, lead: true } });
    expect(companies).toHaveLength(6);
    const smile = companies.find((c) => c.name.startsWith('Smile Dental'))!;
    expect(new Set(smile.sourceRecords.map((r) => r.provider))).toEqual(new Set(['google_places', 'osm']));
    const nova = companies.find((c) => c.name.startsWith('Nova'))!;
    expect(jsonArray<{ field: string }>(nova.discrepancies).some((d) => d.field === 'phone')).toBe(true);
    const closed = companies.find((c) => c.name === 'Old Dental Office')!;
    expect(closed.lead?.priority).toBe('excluded');
  });

  it('only official websites are accepted; profile links are rejected with a reason', async () => {
    const biale = await db().company.findFirst({ where: { name: 'Białe Zęby Centrum' }, include: { website: true, lead: true } });
    expect(biale!.website?.status).toBe('not_found');
    expect(JSON.stringify(biale!.website?.discoveryLog)).toMatch(/booking profile/);
    expect(biale!.lead?.primaryServiceSlug).toBe('new-business-website');
    // OSM-only clinic's website was verified through the phone number printed on the page
    const usmiech = await db().company.findFirst({ where: { name: 'Uśmiech Mokotów' }, include: { website: true } });
    expect(usmiech!.website?.status).toBe('found');
  });

  it('live analysis produces evidence-backed findings, screenshots and no invented Lighthouse data', async () => {
    const smile = await db().company.findFirst({ where: { name: { startsWith: 'Smile Dental' } }, include: { website: true } });
    const analysis = await db().analysis.findFirst({ where: { companyId: smile!.id }, orderBy: { startedAt: 'desc' }, include: { findings: true, screenshots: true } });
    expect(analysis).not.toBeNull();
    expect(analysis!.status).toMatch(/completed|partial/);
    expect(analysis!.lighthouse).toBeNull();
    const codes = analysis!.findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['mobile.no_viewport_meta']));
    expect(codes.some((c) => c.startsWith('tech.broken') || c === 'tech.js_errors')).toBe(true);
    for (const f of analysis!.findings) {
      expect(f.kind).not.toBe('ai_observation'); // AI disabled in tests
      if (f.polarity === 'negative') expect(jsonArray(f.evidence).length, f.code).toBeGreaterThan(0);
      expect(f.source).not.toBe('lighthouse');
    }
    const viewports = new Set(analysis!.screenshots.map((s) => s.viewport));
    expect(viewports).toEqual(new Set(['desktop', 'tablet', 'mobile']));
    for (const s of analysis!.screenshots) expect(existsSync(join(loadConfig().DATA_DIR, 'screenshots', s.path)), s.path).toBe(true);
  });

  it('contacts come only from public sources and are never invented', async () => {
    const fixtureText = ['smile-dental/index.html', 'smile-dental/kontakt.html', 'modern-clinic/index.html', 'modern-clinic/kontakt.html', 'bella-beauty/index.html']
      .map((f) => readFileSync(join('tests/fixtures/sites', f), 'utf8'))
      .join('\n')
      .toLowerCase();
    const emails = await db().contact.findMany({ where: { type: 'email' } });
    expect(emails.length).toBeGreaterThan(0);
    for (const e of emails) expect(fixtureText, e.value).toContain(e.normalizedValue);
    const smileEmail = emails.find((e) => e.normalizedValue === 'info@smile-dental-waw.pl');
    expect(smileEmail?.status).toBe('verified');
  });

  it('prioritises the outdated site above the modern one, with transparent reasons', async () => {
    const leads = await db().lead.findMany({ include: { company: true } });
    const smile = leads.find((l) => l.company.name.startsWith('Smile Dental'))!;
    const nova = leads.find((l) => l.company.name.startsWith('Nova'))!;
    expect(['very_high', 'high']).toContain(smile.priority);
    expect(smile.priorityRank).toBeGreaterThan(nova.priorityRank);
    expect(smile.primaryServiceSlug).toBe('website-redesign');
    expect(jsonArray(smile.priorityReasons).length).toBeGreaterThan(0);
    const sp = smile.salesPotential as { mode: string; level?: string };
    expect(sp.mode).toBe('A');
    const decision = smile.decision as Record<string, unknown>;
    expect(decision).toHaveProperty('whyThisLead');
    expect(decision).toHaveProperty('whatNotToClaim');
    expect((decision.whatToMention as Array<{ findingId: string }>).every((m) => !!m.findingId)).toBe(true);
  });

  it('generates an audit and outreach from the recorded evidence', async () => {
    const smile = await db().lead.findFirst({ where: { company: { name: { startsWith: 'Smile Dental' } } } });
    const audit = await generateAuditForLead(smile!.id, { log });
    expect(audit.content.problems.length).toBeGreaterThan(3);
    expect(audit.content.limitations.join(' ')).toMatch(/Lighthouse was not run/);
    const html = await renderAuditHtml(audit.id);
    expect(html).toContain('data:image/jpeg;base64');
    const out = await generateOutreachForLead(smile!.id, { tone: 'professional', language: 'pl', log });
    expect(out.draft.lint.filter((l) => l.level === 'error')).toEqual([]);
    expect(out.draft.usedFindingIds.length).toBeGreaterThan(0);
    const used = await db().finding.findMany({ where: { id: { in: out.draft.usedFindingIds } } });
    expect(used).toHaveLength(out.draft.usedFindingIds.length);
  });

  it('a second run over the same area creates no duplicate companies (incremental)', async () => {
    const before = await db().company.count();
    const id = await startSearch(params({ analyzeWebsites: false }));
    const job = await waitFor(id, ['completed', 'failed']);
    expect(job.status).toBe('completed');
    expect(await db().company.count()).toBe(before);
  });

  it('keeps working when Google Places fails (failover to other sources)', async () => {
    mock.failGoogle = true;
    await db().cacheEntry.deleteMany({}); // otherwise cached Places responses are (correctly) reused
    try {
      const id = await startSearch(params({ analyzeWebsites: false }));
      const job = await waitFor(id, ['completed', 'failed']);
      expect(job.status).toBe('completed');
      const used = job.sourcesUsed as Record<string, { status: string; records: number }>;
      expect(used.google_places?.status).toMatch(/failed|circuit_open|partial/);
      expect(used.osm?.records).toBeGreaterThan(0);
      const cls = await db().campaignLead.count({ where: { searchJobId: id } });
      expect(cls).toBeGreaterThan(0);
    } finally {
      mock.failGoogle = false;
    }
  });

  it('pipeline checkpoints honour pause, resume and cancel', async () => {
    const id = await startSearch(params({ analyzeWebsites: false, quantity: 10 }));
    // flag set while queued: the worker claims the job and the first checkpoint must park it
    await db().searchJob.update({ where: { id }, data: { control: 'pause' } });
    const paused = await waitFor(id, ['paused', 'completed', 'failed']);
    expect(paused.status).toBe('paused');
    expect((await db().job.findFirst({ where: { searchJobId: id }, orderBy: { createdAt: 'desc' } }))!.status).toBe('paused');

    await db().searchJob.update({ where: { id }, data: { control: 'run', status: 'queued' } });
    await enqueueJob('search', { searchJobId: id }, { searchJobId: id, priority: 1 });
    expect((await waitFor(id, ['completed', 'failed'])).status).toBe('completed');

    const id2 = await startSearch(params({ analyzeWebsites: false, quantity: 10 }));
    await db().searchJob.update({ where: { id: id2 }, data: { control: 'cancel' } });
    const cancelled = await waitFor(id2, ['cancelled', 'completed', 'failed']);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finishedAt).not.toBeNull();
  });
});
