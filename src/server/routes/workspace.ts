import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { configWarnings, loadConfig, SECRET_ENV_NAMES } from '../../config/env.js';
import { secretStatuses, setSecret } from '../../config/secrets.js';
import { db } from '../../db/client.js';
import { searchParamsSchema } from '../../domain/search-params.js';
import { CRM_STAGES } from '../../domain/types.js';
import { MIN_CLASS, MIN_SAMPLES, trainOutcomeModel } from '../../engine/learning/trainer.js';
import { dashboard, outcomeInsights, queryTemplateStats } from '../../engine/quality/analytics.js';
import { todayOverview } from '../../engine/quality/today.js';
import { aiTokensThisMonth } from '../../providers/ai/anthropic.js';
import { describeProviders } from '../../providers/registry.js';
import { enqueueJob } from '../../jobs/queue.js';
import { assertId, notFound, parseBody } from '../validation.js';
import { leadRow } from './search.js';

export function registerWorkspaceRoutes(app: FastifyInstance): void {
  // ── Today / dashboard / learning ──
  app.get('/api/today', async () => todayOverview());

  app.get('/api/dashboard', async (req) => {
    const q = parseBody(z.object({ campaignId: z.string().max(40).optional() }), req.query);
    return dashboard(q.campaignId);
  });

  app.get('/api/learning', async () => {
    const [runs, insights, templates] = await Promise.all([
      db().modelRun.findMany({ orderBy: { trainedAt: 'desc' }, take: 20, select: { id: true, target: true, version: true, status: true, active: true, sampleSize: true, positives: true, metrics: true, notes: true, trainedAt: true } }),
      outcomeInsights(),
      queryTemplateStats(),
    ]);
    return { runs, insights, templates: templates.slice(0, 50), thresholds: { minSamples: MIN_SAMPLES, minPerClass: MIN_CLASS } };
  });

  app.post('/api/learning/train', async (req) => {
    const body = parseBody(z.object({ target: z.enum(['reply', 'won']).default('reply') }), req.body);
    const report = await trainOutcomeModel(body.target);
    if (report.active) await enqueueJob('qualify_all', {}, { priority: 0 });
    return report;
  });

  // ── CRM board ──
  app.get('/api/crm/board', async (req) => {
    const q = parseBody(z.object({ campaignId: z.string().max(40).optional(), perStage: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const stages = CRM_STAGES.filter((s) => s !== 'new');
    const columns = await Promise.all(
      stages.map(async (stage) => {
        const where: Prisma.LeadWhereInput = { stage, ...(q.campaignId ? { campaignLeads: { some: { campaignId: q.campaignId } } } : {}) };
        const [count, leads] = await Promise.all([
          db().lead.count({ where }),
          db().lead.findMany({
            where,
            orderBy: [{ priorityRank: 'desc' }, { stageChangedAt: 'desc' }],
            take: q.perStage,
            include: { company: { select: { id: true, name: true, city: true, country: true, industry: true, sources: true, lastVerifiedAt: true, website: { select: { url: true, status: true, platform: true, lastAnalyzedAt: true } }, contacts: { where: { expiredAt: null }, select: { type: true, status: true } } } } },
          }),
        ]);
        return { stage, count, leads: leads.map(leadRow) };
      }),
    );
    return { columns };
  });

  // ── Campaigns ──
  app.get('/api/campaigns', async () => {
    const campaigns = await db().campaign.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { campaignLeads: true, searchJobs: true } } } });
    const stats = await Promise.all(campaigns.map((c) => dashboard(c.id).then((d) => ({ id: c.id, funnel: d.funnel, rates: d.rates }))));
    return campaigns.map((c) => ({ ...c, stats: stats.find((s) => s.id === c.id) }));
  });
  app.post('/api/campaigns', async (req) => {
    const body = parseBody(z.object({ name: z.string().trim().min(2).max(120), industry: z.string().trim().min(1).max(120), location: z.string().trim().min(1).max(120), country: z.string().trim().min(2).max(60), serviceSlug: z.string().max(120).optional(), targetLeads: z.number().int().min(1).max(5000).default(100), notes: z.string().max(4000).optional() }), req.body);
    return db().campaign.create({ data: body });
  });
  app.get('/api/campaigns/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const c = await db().campaign.findUnique({ where: { id }, include: { searchJobs: { orderBy: { createdAt: 'desc' }, take: 20 }, savedSearches: true } });
    if (!c) notFound('Campaign');
    return { campaign: c, stats: await dashboard(id) };
  });
  app.patch('/api/campaigns/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const body = parseBody(z.object({ name: z.string().trim().min(2).max(120).optional(), status: z.enum(['active', 'archived']).optional(), notes: z.string().max(4000).nullable().optional(), targetLeads: z.number().int().min(1).max(5000).optional() }), req.body);
    return db().campaign.update({ where: { id }, data: body });
  });

  // ── Saved searches ──
  app.get('/api/saved-searches', async () => {
    const saved = await db().savedSearch.findMany({ orderBy: { createdAt: 'desc' }, include: { searchJobs: { orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, status: true, counts: true, createdAt: true } } } });
    return saved;
  });
  app.post('/api/saved-searches', async (req) => {
    const body = parseBody(z.object({ name: z.string().trim().min(2).max(120), params: searchParamsSchema, schedule: z.enum(['daily']).nullable().optional(), scheduleHour: z.number().int().min(0).max(23).optional(), campaignId: z.string().max(40).optional() }), req.body);
    return db().savedSearch.create({ data: { name: body.name, params: body.params as unknown as Prisma.InputJsonValue, sourceConfig: body.params.providers, schedule: body.schedule ?? null, scheduleHour: body.scheduleHour, campaignId: body.campaignId } });
  });
  app.patch('/api/saved-searches/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const body = parseBody(z.object({ name: z.string().trim().min(2).max(120).optional(), schedule: z.enum(['daily']).nullable().optional(), scheduleHour: z.number().int().min(0).max(23).optional(), params: searchParamsSchema.optional() }), req.body);
    return db().savedSearch.update({ where: { id }, data: { ...body, params: body.params as unknown as Prisma.InputJsonValue | undefined, nextRunAt: body.schedule !== undefined || body.scheduleHour !== undefined ? null : undefined } });
  });
  app.delete('/api/saved-searches/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    await db().savedSearch.delete({ where: { id } });
    return { ok: true };
  });
  app.post('/api/saved-searches/:id/run', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const s = await db().savedSearch.findUnique({ where: { id } });
    if (!s) notFound('Saved search');
    const params = searchParamsSchema.parse(s.params);
    let campaignId = s.campaignId;
    if (!campaignId) {
      const c = await db().campaign.create({ data: { name: s.name, industry: params.niche, location: params.location, country: params.country, serviceSlug: params.service, targetLeads: params.quantity } });
      campaignId = c.id;
      await db().savedSearch.update({ where: { id }, data: { campaignId } });
    }
    const sj = await db().searchJob.create({ data: { campaignId, savedSearchId: id, params: params as unknown as Prisma.InputJsonValue, trigger: 'manual', progress: {}, counts: {}, sourcesUsed: {}, strategyLog: [] } });
    await enqueueJob('search', { searchJobId: sj.id }, { searchJobId: sj.id, priority: 1 });
    return { searchJobId: sj.id };
  });

  // ── Settings: sources, secrets, usage, onboarding ──
  app.get('/api/settings/providers', async () => {
    const [providers, secrets, usage, aiTokens] = await Promise.all([describeProviders(), secretStatuses(), db().providerUsage.findMany({ where: { day: { gte: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10) } }, orderBy: { day: 'desc' } }), aiTokensThisMonth().catch(() => 0)]);
    const cfg = loadConfig();
    return {
      ...providers,
      secrets,
      usage,
      ai: { ...providers.ai, tokensThisMonth: aiTokens, monthlyBudget: cfg.AI_MONTHLY_TOKEN_BUDGET, visualAnalysis: cfg.AI_VISUAL_ANALYSIS, effort: cfg.AI_EFFORT ?? 'default' },
      limits: { maxProviderCallsPerJob: cfg.MAX_PROVIDER_CALLS_PER_JOB, analysisMaxPages: cfg.ANALYSIS_MAX_PAGES, browserPoolSize: cfg.BROWSER_POOL_SIZE, reanalyzeAfterDays: cfg.REANALYZE_AFTER_DAYS, respectRobotsTxt: cfg.RESPECT_ROBOTS_TXT },
      canStoreSecrets: !!cfg.APP_ENCRYPTION_KEY,
      warnings: configWarnings(),
    };
  });

  app.put('/api/settings/secrets/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!(SECRET_ENV_NAMES as readonly string[]).includes(name)) return reply.code(400).send({ error: 'unknown_secret', message: 'Unknown key name' });
    const body = parseBody(z.object({ value: z.string().max(500).nullable() }), req.body);
    await setSecret(name as (typeof SECRET_ENV_NAMES)[number], body.value);
    req.log.info({ secret: name, action: body.value ? 'set' : 'cleared' }, 'secret updated');
    return { ok: true };
  });

  app.put('/api/settings/sources/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const body = parseBody(z.object({ enabled: z.boolean() }), req.body);
    const s = await db().source.findUnique({ where: { id } });
    if (!s) notFound('Source');
    return db().source.update({ where: { id }, data: { enabled: body.enabled } });
  });

  app.get('/api/onboarding', async () => {
    const [profile, providers, services, campaigns, jobs, leads] = await Promise.all([
      db().businessProfile.findUnique({ where: { id: 'default' } }),
      describeProviders(),
      db().service.count({ where: { active: true } }),
      db().campaign.count(),
      db().searchJob.count(),
      db().lead.count(),
    ]);
    const configuredSources = providers.sources.filter((s) => s.configured && s.enabled && s.capabilities.search && s.id !== 'import');
    return {
      steps: {
        sources: { done: configuredSources.length > 0, configured: configuredSources.map((s) => s.name) },
        keys: { done: providers.sources.some((s) => s.configured && !['osm', 'import'].includes(s.id)) || providers.ai.configured, ai: providers.ai.configured },
        services: { done: services > 0 && !!profile?.studioName, count: services },
        campaign: { done: campaigns > 0 },
        leads: { done: jobs > 0 && leads > 0 },
      },
      completed: !!profile?.onboardingCompletedAt,
    };
  });

  // ── Screenshots (authenticated, path-traversal safe) ──
  app.get('/media/screenshots/:analysisId/:file', async (req, reply) => {
    const { analysisId, file } = req.params as { analysisId: string; file: string };
    assertId(analysisId);
    if (!/^[a-z0-9_-]+\.jpg$/i.test(file)) return reply.code(400).send({ error: 'invalid_file' });
    const root = resolve(loadConfig().DATA_DIR, 'screenshots');
    const path = resolve(join(root, analysisId, file));
    if (!path.startsWith(root + sep)) return reply.code(400).send({ error: 'invalid_path' });
    try {
      const st = await stat(path);
      return reply.type('image/jpeg').header('cache-control', 'private, max-age=86400').header('content-length', st.size).send(createReadStream(path));
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
  });
}
