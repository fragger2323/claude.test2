// Dev smoke test: run the full search pipeline against mock providers + fixture sites (no worker).
import { mkdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
const TMP = 'tests/.tmp/smoke';
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
process.env.DATABASE_URL = `file:../${TMP}/smoke.db`;
process.env.DATA_DIR = `${TMP}/data`;
process.env.ALLOW_PRIVATE_NETWORK_TARGETS = 'true';
process.env.NODE_ENV = 'development';
execSync('npx prisma db push --skip-generate --accept-data-loss', { stdio: 'ignore', env: process.env });

const { startFixtureSites } = await import('../tests/support/fixture-sites.js');
const { startMockProviders, mockProviderEnv } = await import('../tests/support/mock-providers.js');
const sites = await startFixtureSites();
const mock = await startMockProviders(sites.urls);
Object.assign(process.env, mockProviderEnv(mock.url));
const { db } = await import('../src/db/client.js');
const { ensureDefaults } = await import('../src/engine/defaults.js');
const { buildProviderRegistry, syncSourceRows } = await import('../src/providers/registry.js');
const { SearchPipeline } = await import('../src/engine/pipeline/search-pipeline.js');
const { logger } = await import('../src/lib/logger.js');
const { closeBrowserPool } = await import('../src/providers/website/browser-pool.js');
const { generateAuditForLead, generateOutreachForLead } = await import('../src/engine/reports/generate.js');
await ensureDefaults();
await syncSourceRows();
const params = { niche: 'стоматологии', location: 'Warszawa', country: 'Poland', service: 'website redesign', quantity: 20, excludeExistingClients: true, excludePreviouslyContacted: true, onlyWithWebsite: false, onlyWithPublicContact: false, minCompanySize: 'any', businessModel: 'any', priceSegment: 'any', preferredIndustries: [], excludedIndustries: [], providers: [], analyzeWebsites: true, visualAi: false, generateAudits: 'none' };
const campaign = await db().campaign.create({ data: { name: 'Smoke', industry: 'dentist', location: 'Warszawa', country: 'Poland' } });
const sj = await db().searchJob.create({ data: { campaignId: campaign.id, params, progress: {}, counts: {}, sourcesUsed: {}, strategyLog: [] } });
const ac = new AbortController();
const t = Date.now();
await new SearchPipeline(sj.id, { registry: await buildProviderRegistry(), log: logger('smoke'), heartbeat: async () => {}, signal: ac.signal, abort: () => ac.abort() }).run();
const job = await db().searchJob.findUnique({ where: { id: sj.id } });
console.log('took', Date.now() - t, 'ms');
console.log('counts', job?.counts);
console.log('log', (job?.strategyLog as Array<{ message: string }>).map((l) => l.message).join('\n'));
const leads = await db().lead.findMany({ include: { company: { include: { website: true, contacts: true } }, recommendations: true }, orderBy: { priorityRank: 'desc' } });
for (const l of leads) {
  console.log(`\n# ${l.company.name} | ${l.priority} fit=${l.leadFit} need=${l.websiteNeed} svcFit=${l.serviceFit} contact=${l.contactability} fresh=${l.freshness} stage=${l.stage}`);
  console.log('  website', l.company.website?.status, l.company.website?.url, l.company.website?.notFoundReason ?? '');
  console.log('  contacts', l.company.contacts.map((c) => `${c.type}:${c.value}[${c.status}]`).join(', '));
  console.log('  recs', l.recommendations.map((r) => `${r.kind}:${r.serviceSlug}(${r.fitScore})`).join(', '));
  console.log('  reasons', JSON.stringify(l.priorityReasons));
  console.log('  discrepancies', JSON.stringify(l.company.discrepancies));
}
const top = leads[0]!;
const audit = await generateAuditForLead(top.id, { log: logger('smoke') });
console.log('\nAUDIT summary', audit.content.executiveSummary, audit.content.improvements.map((i) => i.title));
for (const tone of ['professional', 'ultra_short'] as const) {
  const o = await generateOutreachForLead(top.id, { tone, language: 'pl', log: logger('smoke') });
  console.log(`\nOUTREACH ${tone}:\n${o.draft.subject}\n${o.draft.body}\nlint: ${JSON.stringify(o.draft.lint)}`);
}
const decision = (await db().lead.findUnique({ where: { id: top.id } }))?.decision;
console.log('\nDECISION', JSON.stringify(decision, null, 1).slice(0, 3000));
await closeBrowserPool();
await mock.close();
await sites.close();
await db().$disconnect();
