import { Prisma } from '@prisma/client';
import type { Logger } from 'pino';
import { db } from '../db/client.js';
import { searchParamsSchema } from '../domain/search-params.js';
import { purgeExpiredCache } from '../lib/cache.js';
import { errorMessage, jsonObject } from '../lib/misc.js';
import { buildProviderRegistry } from '../providers/registry.js';
import { fetchPage } from '../providers/website/fetcher.js';
import { analyzeCompanyWebsite } from '../engine/analysis/analysis-service.js';
import { contactsFromSources } from '../engine/contacts/contact-discovery.js';
import { storeContacts } from '../engine/contacts/contact-store.js';
import { discoverWebsite } from '../engine/discovery/website-discovery.js';
import { mergeRecords } from '../engine/resolution/entity-resolution.js';
import { loadActiveModel } from '../engine/learning/trainer.js';
import { JobControlSignal, recordFromRow, SearchPipeline } from '../engine/pipeline/search-pipeline.js';
import { qualifyLead } from '../engine/qualify/qualify-lead.js';
import { CallBudget } from '../providers/types.js';
import { enqueueJob, type JobType } from './queue.js';

export interface HandlerContext {
  jobId: string;
  log: Logger;
  heartbeat: () => Promise<void>;
}

export type HandlerResult = { status: 'completed'; result?: Record<string, unknown> } | { status: 'paused' | 'cancelled' };

async function runSearch(payload: { searchJobId: string }, ctx: HandlerContext): Promise<HandlerResult> {
  const registry = await buildProviderRegistry();
  const ac = new AbortController();
  const pipeline = new SearchPipeline(payload.searchJobId, {
    registry,
    log: ctx.log.child({ searchJobId: payload.searchJobId }),
    heartbeat: ctx.heartbeat,
    signal: ac.signal,
    abort: (r) => ac.abort(r),
  });
  try {
    await pipeline.run();
    return { status: 'completed' };
  } catch (e) {
    if (e instanceof JobControlSignal) {
      await db().searchJob.update({ where: { id: payload.searchJobId }, data: { status: e.kind === 'pause' ? 'paused' : 'cancelled', finishedAt: e.kind === 'cancel' ? new Date() : null } });
      await pipeline.updateCounts().catch(() => undefined);
      return { status: e.kind === 'pause' ? 'paused' : 'cancelled' };
    }
    throw e;
  }
}

/** One-click "Analyze" on a lead: website discovery (if needed) → live analysis → contacts → re-qualify. */
async function runAnalyzeLead(payload: { leadId: string; visualAi?: boolean }, ctx: HandlerContext): Promise<HandlerResult> {
  const lead = await db().lead.findUnique({ where: { id: payload.leadId }, include: { company: { include: { website: true, sourceRecords: true } } } });
  if (!lead) return { status: 'completed', result: { skipped: 'lead not found' } };
  const registry = await buildProviderRegistry();
  const c = lead.company;
  if (!c.website || c.website.status !== 'found') {
    const decision = await discoverWebsite(
      { name: c.name, city: c.city, country: c.country, phones: [c.phoneE164].filter((x): x is string => !!x), address: c.address },
      c.sourceRecords.filter((r) => r.website).map((r) => ({ url: r.website!, source: r.provider, evidence: `website field on ${r.provider} record` })),
      {
        fetchHomepage: (url) => fetchPage(url),
        searchAvailable: registry.webDiscovery.isConfigured(),
        searchCandidates: () => registry.webDiscovery.findWebsite({ name: c.name, city: c.city, country: c.country, providerRefs: [] }, { budget: new CallBudget(3), log: ctx.log }),
      },
    );
    const data = { url: decision.url, domain: decision.domain, finalUrl: decision.finalUrl, status: decision.status, confidence: decision.confidence, discoverySource: decision.source, discoveryLog: decision.log as unknown as Prisma.InputJsonValue, notFoundReason: decision.notFoundReason, httpStatus: decision.httpStatus, lastCheckedAt: new Date() };
    await db().website.upsert({ where: { companyId: c.id }, create: { companyId: c.id, ...data }, update: data });
  }
  await ctx.heartbeat();
  const res = await analyzeCompanyWebsite(c.id, { ai: registry.ai, visualAi: payload.visualAi ?? true, log: ctx.log });
  await storeContacts(c.id, contactsFromSources(c.sourceRecords.filter((r) => !r.purgedAt).map(recordFromRow), c.country), c.primaryDomain);
  await qualifyLead(lead.id, { log: ctx.log });
  await db().activity.create({ data: { leadId: lead.id, type: 'analysis_run', summary: `Website analysed (${res.status}, ${res.findings} findings)`, actor: 'system', data: { analysisId: res.analysisId } } });
  return { status: 'completed', result: { ...res } };
}

async function runQualifyAll(payload: { leadIds?: string[] }, ctx: HandlerContext): Promise<HandlerResult> {
  const leads = await db().lead.findMany({ where: payload.leadIds ? { id: { in: payload.leadIds } } : {}, select: { id: true } });
  const model = await loadActiveModel('reply');
  let n = 0;
  for (const l of leads) {
    await qualifyLead(l.id, { log: ctx.log, model }).catch((e) => ctx.log.warn({ leadId: l.id, error: errorMessage(e) }, 'requalify failed'));
    if (++n % 20 === 0) await ctx.heartbeat();
  }
  return { status: 'completed', result: { requalified: n } };
}

/** Scheduled saved search: creates a new SearchJob (never sends messages). */
async function runScheduledSearch(payload: { savedSearchId: string }, ctx: HandlerContext): Promise<HandlerResult> {
  const s = await db().savedSearch.findUnique({ where: { id: payload.savedSearchId } });
  if (!s) return { status: 'completed', result: { skipped: 'saved search not found' } };
  const params = searchParamsSchema.parse({ ...jsonObject<Record<string, unknown>>(s.params, {}), excludePreviouslyContacted: true });
  let campaignId = s.campaignId;
  if (!campaignId) {
    const c = await db().campaign.create({ data: { name: `${s.name} (scheduled)`, industry: params.niche, location: params.location, country: params.country, serviceSlug: params.service, targetLeads: params.quantity } });
    campaignId = c.id;
    await db().savedSearch.update({ where: { id: s.id }, data: { campaignId } });
  }
  const sj = await db().searchJob.create({
    data: { campaignId, savedSearchId: s.id, params: params as unknown as Prisma.InputJsonValue, trigger: 'scheduled', progress: {}, counts: {}, sourcesUsed: {}, strategyLog: [] },
  });
  await enqueueJob('search', { searchJobId: sj.id }, { searchJobId: sj.id });
  ctx.log.info({ savedSearchId: s.id, searchJobId: sj.id }, 'scheduled search enqueued');
  return { status: 'completed', result: { searchJobId: sj.id } };
}

/**
 * Maintenance: expire provider content per data-retention policy (IDs are kept), purge the
 * response cache, and drop old finished queue rows.
 */
export async function runMaintenance(ctx: { log: Logger }): Promise<Record<string, number>> {
  const now = new Date();
  const expired = await db().sourceRecord.findMany({ where: { retentionExpiresAt: { lt: now }, purgedAt: null }, select: { id: true, companyId: true, provider: true } });
  if (expired.length) {
    await db().sourceRecord.updateMany({
      where: { id: { in: expired.map((e) => e.id) } },
      data: { name: null, address: null, street: null, phone: null, email: null, website: null, payload: Prisma.DbNull, rating: null, ratingCount: null, priceLevel: null, lat: null, lng: null, purgedAt: now },
    });
    // Provider-only attributes copied onto the merged company are rebuilt from the records that are
    // still within retention (or cleared when none remain). Name/address/phone stay as CRM identity.
    const companyIds = [...new Set(expired.map((e) => e.companyId).filter((id): id is string => !!id))];
    for (const companyId of companyIds) {
      const remaining = await db().sourceRecord.findMany({ where: { companyId, purgedAt: null } });
      const merged = remaining.length ? mergeRecords(remaining.map(recordFromRow)) : null;
      await db().company.update({
        where: { id: companyId },
        data: { rating: merged?.rating ?? null, ratingCount: merged?.ratingCount ?? null, priceLevel: merged?.priceLevel ?? null, lat: merged?.lat ?? null, lng: merged?.lng ?? null },
      });
    }
    // Contacts known ONLY from purged provider records are marked expired (not deleted: provenance stays visible).
    const byCompany = new Map<string, Set<string>>();
    for (const e of expired) if (e.companyId) byCompany.set(e.companyId, new Set([...(byCompany.get(e.companyId) ?? []), e.provider]));
    for (const [companyId, providers] of byCompany) {
      const contacts = await db().contact.findMany({ where: { companyId, expiredAt: null } });
      for (const ct of contacts) {
        const sightings = (ct.sightings as Array<{ source: string; onOfficialSite: boolean }>) ?? [];
        if (sightings.length > 0 && sightings.every((s) => providers.has(s.source) && !s.onOfficialSite)) {
          await db().contact.update({ where: { id: ct.id }, data: { expiredAt: now } });
        }
      }
    }
  }
  const cache = await purgeExpiredCache();
  const oldJobs = await db().job.deleteMany({ where: { status: { in: ['completed', 'cancelled'] }, finishedAt: { lt: new Date(now.getTime() - 30 * 86_400_000) } } });
  const sessions = await db().session.deleteMany({ where: { expiresAt: { lt: now } } });
  const result = { purgedSourceRecords: expired.length, cacheEntries: cache, oldJobs: oldJobs.count, expiredSessions: sessions.count };
  ctx.log.info(result, 'maintenance completed');
  return result;
}

export async function runHandler(type: JobType, payload: unknown, ctx: HandlerContext): Promise<HandlerResult> {
  const p = jsonObject<Record<string, unknown>>(payload, {});
  switch (type) {
    case 'search':
    case 'import':
      return runSearch(p as { searchJobId: string }, ctx);
    case 'analyze_lead':
      return runAnalyzeLead(p as { leadId: string; visualAi?: boolean }, ctx);
    case 'qualify_all':
      return runQualifyAll(p as { leadIds?: string[] }, ctx);
    case 'scheduled_search':
      return runScheduledSearch(p as { savedSearchId: string }, ctx);
    case 'maintenance':
      return { status: 'completed', result: await runMaintenance(ctx) };
    default:
      throw new Error(`unknown job type ${type as string}`);
  }
}
