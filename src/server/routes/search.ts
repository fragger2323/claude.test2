import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { searchParamsSchema } from '../../domain/search-params.js';
import { parseCommand } from '../../engine/command/parse-command.js';
import { computeJobCounts } from '../../engine/pipeline/search-pipeline.js';
import { resolveNiche } from '../../engine/strategy/strategy-engine.js';
import { enqueueJob } from '../../jobs/queue.js';
import { parseImport } from '../../providers/import/index.js';
import { normalizePhone } from '../../lib/phone.js';
import { normalizeName } from '../../lib/text.js';
import { domainKey } from '../../engine/resolution/entity-resolution.js';
import { assertId, notFound, parseBody } from '../validation.js';

const createSearch = z.object({
  params: searchParamsSchema,
  campaignId: z.string().max(40).optional(),
  campaignName: z.string().trim().max(120).optional(),
  saveAs: z.string().trim().max(120).optional(),
  trigger: z.enum(['manual', 'command']).default('manual'),
});

async function ensureCampaign(params: z.infer<typeof searchParamsSchema>, campaignId?: string, name?: string): Promise<string> {
  if (campaignId) {
    const c = await db().campaign.findUnique({ where: { id: assertId(campaignId) } });
    if (!c) notFound('Campaign');
    return c.id;
  }
  const label = resolveNiche(params.niche).def?.label ?? params.niche;
  const c = await db().campaign.create({
    data: {
      name: name || `${label} · ${params.location} · ${new Date().toISOString().slice(0, 10)}`,
      industry: params.niche,
      location: params.location,
      country: params.country,
      serviceSlug: params.service,
      targetLeads: params.quantity,
    },
  });
  return c.id;
}

export function jobView(j: {
  id: string;
  campaignId: string | null;
  savedSearchId: string | null;
  params: unknown;
  status: string;
  stage: string;
  control: string;
  trigger: string;
  progress: unknown;
  counts: unknown;
  sourcesUsed: unknown;
  strategyLog: unknown;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}) {
  return j;
}

export function registerSearchRoutes(app: FastifyInstance): void {
  app.post('/api/command/parse', async (req) => {
    const { text } = parseBody(z.object({ text: z.string().trim().min(3).max(300) }), req.body);
    return parseCommand(text);
  });

  app.post('/api/search', async (req) => {
    const body = parseBody(createSearch, req.body);
    const campaignId = await ensureCampaign(body.params, body.campaignId, body.campaignName);
    let savedSearchId: string | undefined;
    if (body.saveAs) {
      const s = await db().savedSearch.create({ data: { name: body.saveAs, params: body.params as unknown as Prisma.InputJsonValue, sourceConfig: body.params.providers, campaignId } });
      savedSearchId = s.id;
    }
    const sj = await db().searchJob.create({
      data: { campaignId, savedSearchId, params: body.params as unknown as Prisma.InputJsonValue, trigger: body.trigger, progress: {}, counts: {}, sourcesUsed: {}, strategyLog: [] },
    });
    await enqueueJob('search', { searchJobId: sj.id }, { searchJobId: sj.id, priority: 1 });
    return { searchJobId: sj.id, campaignId };
  });

  app.get('/api/search-jobs', async (req) => {
    const q = parseBody(z.object({ campaignId: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
    const jobs = await db().searchJob.findMany({ where: q.campaignId ? { campaignId: q.campaignId } : {}, orderBy: { createdAt: 'desc' }, take: q.limit, include: { campaign: { select: { name: true } } } });
    return jobs.map((j) => ({ id: j.id, campaign: j.campaign?.name ?? null, campaignId: j.campaignId, params: j.params, status: j.status, stage: j.stage, trigger: j.trigger, counts: j.counts, createdAt: j.createdAt, finishedAt: j.finishedAt, error: j.error }));
  });

  app.get('/api/search-jobs/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const j = await db().searchJob.findUnique({ where: { id }, include: { campaign: { select: { id: true, name: true } } } });
    if (!j) notFound('Search job');
    const queries = await db().searchQuery.findMany({ where: { searchJobId: id }, orderBy: { createdAt: 'asc' }, select: { id: true, text: true, language: true, segment: true, strategy: true, status: true, resultsCount: true, newRecordsCount: true, error: true } });
    const queueJob = await db().job.findFirst({ where: { searchJobId: id }, orderBy: { createdAt: 'desc' }, select: { status: true, attempts: true, maxAttempts: true, lastError: true, runAfter: true } });
    return { ...jobView(j), campaign: j.campaign, queries, queue: queueJob };
  });

  app.get('/api/search-jobs/:id/results', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const q = parseBody(z.object({ includeExcluded: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(1000).default(200) }), req.query);
    const cls = await db().campaignLead.findMany({
      where: { searchJobId: id, ...(q.includeExcluded ? {} : { excludedReason: null }) },
      include: {
        lead: {
          include: {
            company: { select: { id: true, name: true, city: true, country: true, industry: true, sources: true, lastVerifiedAt: true, website: { select: { url: true, status: true, platform: true, lastAnalyzedAt: true } }, contacts: { where: { expiredAt: null }, select: { type: true, status: true } } } },
          },
        },
      },
    });
    const rows = cls
      .map((cl) => ({ ...leadRow(cl.lead), excludedReason: cl.excludedReason }))
      .sort((a, b) => b.priorityRank - a.priorityRank || (b.leadFit ?? -1) - (a.leadFit ?? -1))
      .slice(0, q.limit);
    const counts = await computeJobCounts(id);
    return { counts, rows };
  });

  for (const action of ['pause', 'resume', 'cancel', 'retry'] as const) {
    app.post(`/api/search-jobs/:id/${action}`, async (req, reply) => {
      const id = assertId((req.params as { id: string }).id);
      const j = await db().searchJob.findUnique({ where: { id } });
      if (!j) notFound('Search job');
      if (action === 'pause') {
        if (!['running', 'queued'].includes(j.status)) return reply.code(409).send({ error: 'invalid_state', message: `Cannot pause a ${j.status} job.` });
        await db().searchJob.update({ where: { id }, data: { control: 'pause' } });
        // a queued job that hasn't started can be paused immediately
        const pending = await db().job.updateMany({ where: { searchJobId: id, status: 'queued' }, data: { status: 'paused' } });
        if (pending.count) await db().searchJob.update({ where: { id }, data: { status: 'paused' } });
      } else if (action === 'cancel') {
        if (['completed', 'cancelled'].includes(j.status)) return reply.code(409).send({ error: 'invalid_state', message: `Job is already ${j.status}.` });
        await db().searchJob.update({ where: { id }, data: { control: 'cancel' } });
        const pending = await db().job.updateMany({ where: { searchJobId: id, status: { in: ['queued', 'paused'] } }, data: { status: 'cancelled', finishedAt: new Date() } });
        if (pending.count || j.status === 'paused' || j.status === 'failed') await db().searchJob.update({ where: { id }, data: { status: 'cancelled', finishedAt: new Date() } });
      } else {
        if (!['paused', 'failed', 'cancelled'].includes(j.status)) return reply.code(409).send({ error: 'invalid_state', message: `Cannot ${action} a ${j.status} job.` });
        await db().searchJob.update({ where: { id }, data: { control: 'run', status: 'queued', error: null, finishedAt: null } });
        await enqueueJob('search', { searchJobId: id }, { searchJobId: id, priority: 1 });
      }
      return { ok: true };
    });
  }

  // Import (CSV / JSON) → a search job that starts at the merging stage.
  app.post('/api/import', { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const body = parseBody(
      z.object({
        format: z.enum(['csv', 'json']),
        content: z.string().min(1).max(7_000_000),
        campaignId: z.string().max(40).optional(),
        campaignName: z.string().trim().max(120).optional(),
        defaults: z.object({ niche: z.string().trim().min(1).max(120), location: z.string().trim().min(1).max(120), country: z.string().trim().min(2).max(60), service: z.string().max(120).optional() }),
        analyzeWebsites: z.boolean().default(true),
      }),
      req.body,
    );
    const parsed = parseImport(body.content, body.format, { country: body.defaults.country, category: body.defaults.niche });
    const params = searchParamsSchema.parse({ ...body.defaults, quantity: Math.max(1, Math.min(1000, parsed.records.length)), analyzeWebsites: body.analyzeWebsites, providers: [], excludePreviouslyContacted: false });
    const campaignId = await ensureCampaign(params, body.campaignId, body.campaignName ?? `Import · ${new Date().toISOString().slice(0, 10)}`);
    const sj = await db().searchJob.create({
      data: { campaignId, params: params as unknown as Prisma.InputJsonValue, trigger: 'import', stage: 'merging', progress: {}, counts: {}, sourcesUsed: { import: { provider: 'import', name: 'CSV / JSON import', status: 'ok', calls: 0, records: parsed.records.length, errors: parsed.errors.length } }, strategyLog: [{ at: new Date().toISOString(), message: `Imported ${parsed.records.length} row(s); ${parsed.skipped} skipped.` }] },
    });
    for (const r of parsed.records) {
      const phone = normalizePhone(r.phone, r.country);
      const data = {
        name: r.name,
        normalizedName: normalizeName(r.name),
        categories: r.categories,
        address: r.address,
        street: r.street,
        city: r.city,
        postalCode: r.postalCode,
        country: r.country,
        lat: r.lat,
        lng: r.lng,
        phone: r.phone,
        phoneE164: phone?.valid ? phone.e164 : null,
        website: r.website,
        websiteDomain: domainKey(r.website),
        email: r.email,
        fetchedAt: r.fetchedAt,
        lastSeenAt: new Date(),
        searchJobId: sj.id,
        companyId: null,
      };
      await db().sourceRecord.upsert({ where: { provider_providerRecordId: { provider: 'import', providerRecordId: r.providerRecordId } }, create: { provider: 'import', providerRecordId: r.providerRecordId, ...data }, update: { ...data, companyId: undefined } });
    }
    await enqueueJob('import', { searchJobId: sj.id }, { searchJobId: sj.id, priority: 1 });
    return { searchJobId: sj.id, campaignId, imported: parsed.records.length, skipped: parsed.skipped, errors: parsed.errors.slice(0, 50) };
  });
}

type LeadForRow = {
  id: string;
  stage: string;
  priority: string | null;
  priorityRank: number;
  leadFit: number | null;
  websiteNeed: number | null;
  serviceFit: number | null;
  contactability: number | null;
  freshness: number | null;
  primaryServiceSlug: string | null;
  mainOpportunity: string | null;
  contactAvailability: string | null;
  nextFollowUpAt: Date | null;
  lastScoredAt: Date | null;
  createdAt: Date;
  company: {
    id: string;
    name: string;
    city: string | null;
    country: string | null;
    industry: string | null;
    sources: unknown;
    lastVerifiedAt: Date | null;
    website: { url: string | null; status: string; platform: string | null; lastAnalyzedAt: Date | null } | null;
    contacts: Array<{ type: string; status: string }>;
  };
};

export function leadRow(l: LeadForRow) {
  return {
    id: l.id,
    companyId: l.company.id,
    company: l.company.name,
    industry: l.company.industry,
    city: l.company.city,
    country: l.company.country,
    website: l.company.website?.url ?? null,
    websiteStatus: l.company.website?.status ?? 'unknown',
    platform: l.company.website?.platform ?? null,
    analyzedAt: l.company.website?.lastAnalyzedAt ?? null,
    stage: l.stage,
    priority: l.priority,
    priorityRank: l.priorityRank,
    leadFit: l.leadFit,
    websiteNeed: l.websiteNeed,
    serviceFit: l.serviceFit,
    contactability: l.contactability,
    freshness: l.freshness,
    recommendedService: l.primaryServiceSlug,
    mainOpportunity: l.mainOpportunity,
    contactAvailability: l.contactAvailability,
    verifiedContacts: l.company.contacts.filter((c) => c.status === 'verified').map((c) => c.type),
    sources: (l.company.sources as string[] | null) ?? [],
    lastVerifiedAt: l.company.lastVerifiedAt,
    nextFollowUpAt: l.nextFollowUpAt,
    lastScoredAt: l.lastScoredAt,
    createdAt: l.createdAt,
  };
}
