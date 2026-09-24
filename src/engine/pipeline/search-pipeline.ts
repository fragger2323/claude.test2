import type { Prisma } from '@prisma/client';
import type { Logger } from 'pino';
import { loadConfig } from '../../config/env.js';
import { db } from '../../db/client.js';
import { searchParamsSchema, type SearchParams } from '../../domain/search-params.js';
import { emptyCounts, SEARCH_STAGES, type Discrepancy, type ProviderRunStat, type SearchCounts, type SearchStage } from '../../domain/types.js';
import { mapLimit } from '../../lib/concurrency.js';
import { errorMessage, jsonArray, jsonObject } from '../../lib/misc.js';
import { normalizePhone, toCountryCode } from '../../lib/phone.js';
import { addressKey, normalizeName } from '../../lib/text.js';
import { activeSearchSources, type ProviderRegistry } from '../../providers/registry.js';
import { CallBudget, type GeoArea, type NormalizedBusiness, type WebsiteCandidate } from '../../providers/types.js';
import { fetchPage } from '../../providers/website/fetcher.js';
import { analyzeCompanyWebsite } from '../analysis/analysis-service.js';
import { contactsFromSources } from '../contacts/contact-discovery.js';
import { storeContacts } from '../contacts/contact-store.js';
import { discoverWebsite } from '../discovery/website-discovery.js';
import { loadActiveModel } from '../learning/trainer.js';
import { fanOut } from '../orchestrator/source-orchestrator.js';
import { templateYieldMap } from '../quality/analytics.js';
import { advanceStage, qualifyLead } from '../qualify/qualify-lead.js';
import { generateAuditForLead } from '../reports/generate.js';
import { clusterRecords, companyToResolvable, domainKey, mergeRecords, toResolvable, type ResolvableRecord } from '../resolution/entity-resolution.js';
import { planSearch, resolveNiche, type PlannedQuery } from '../strategy/strategy-engine.js';

/**
 * The search job pipeline:
 * planning → discovering → merging → verifying → website_discovery → analyzing → contacts → qualifying → reporting
 * Every stage is idempotent and checkpointed, so pause/resume/retry continue where they stopped.
 */

export class JobControlSignal extends Error {
  constructor(public readonly kind: 'pause' | 'cancel') {
    super(`job ${kind}d by user`);
    this.name = 'JobControlSignal';
  }
}

export interface PipelineDeps {
  registry: ProviderRegistry;
  log: Logger;
  heartbeat: () => Promise<void>;
  signal: AbortSignal;
  abort: (reason: string) => void;
}

const ORDER: SearchStage[] = SEARCH_STAGES.filter((s) => s !== 'queued' && s !== 'completed');

type Job = NonNullable<Awaited<ReturnType<typeof loadJob>>>;

async function loadJob(id: string) {
  return db().searchJob.findUnique({ where: { id } });
}

export function recordFromRow(r: {
  provider: string;
  providerRecordId: string;
  name: string | null;
  categories: unknown;
  address: string | null;
  street: string | null;
  city: string | null;
  postalCode: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  website: string | null;
  email: string | null;
  profileUrl: string | null;
  businessStatus: string | null;
  rating: number | null;
  ratingCount: number | null;
  priceLevel: number | null;
  payload: unknown;
  fetchedAt: Date;
}): NormalizedBusiness {
  const socials = jsonArray<{ network: string; url: string }>(jsonObject<{ socials?: unknown }>(r.payload, {}).socials);
  return {
    provider: r.provider,
    providerRecordId: r.providerRecordId,
    name: r.name ?? '',
    categories: jsonArray<string>(r.categories),
    address: r.address ?? undefined,
    street: r.street ?? undefined,
    city: r.city ?? undefined,
    postalCode: r.postalCode ?? undefined,
    region: r.region ?? undefined,
    country: r.country ?? undefined,
    lat: r.lat ?? undefined,
    lng: r.lng ?? undefined,
    phone: r.phone ?? undefined,
    website: r.website ?? undefined,
    email: r.email ?? undefined,
    profileUrl: r.profileUrl ?? undefined,
    businessStatus: (r.businessStatus as NormalizedBusiness['businessStatus']) ?? undefined,
    rating: r.rating ?? undefined,
    ratingCount: r.ratingCount ?? undefined,
    priceLevel: r.priceLevel ?? undefined,
    socials,
    fetchedAt: r.fetchedAt,
  };
}

export class SearchPipeline {
  private params!: SearchParams;
  private job!: Job;
  private lastControlCheck = 0;
  private readonly cfg = loadConfig();

  constructor(
    private readonly searchJobId: string,
    private readonly deps: PipelineDeps,
  ) {}

  private get log(): Logger {
    return this.deps.log;
  }

  /** Throws JobControlSignal if the user paused or cancelled. Cheap: at most one DB read per second. */
  async checkControl(force = false): Promise<void> {
    if (!force && Date.now() - this.lastControlCheck < 1000) return;
    this.lastControlCheck = Date.now();
    const row = await db().searchJob.findUnique({ where: { id: this.searchJobId }, select: { control: true } });
    if (row?.control === 'pause') throw new JobControlSignal('pause');
    if (row?.control === 'cancel') {
      this.deps.abort('cancelled');
      throw new JobControlSignal('cancel');
    }
    await this.deps.heartbeat();
  }

  private async shouldStop(): Promise<boolean> {
    try {
      await this.checkControl();
      return false;
    } catch {
      return true;
    }
  }

  private async setProgress(stage: SearchStage, done: number, total: number, extra: Record<string, unknown> = {}): Promise<void> {
    const progress = jsonObject<Record<string, unknown>>(this.job.progress, {});
    progress[stage] = { done, total, ...extra };
    this.job.progress = progress as Prisma.JsonValue;
    await db().searchJob.update({ where: { id: this.searchJobId }, data: { progress: progress as Prisma.InputJsonValue } });
  }

  private async appendLog(lines: string[]): Promise<void> {
    const log = [...jsonArray<{ at: string; message: string }>(this.job.strategyLog), ...lines.map((message) => ({ at: new Date().toISOString(), message }))].slice(-200);
    this.job.strategyLog = log as unknown as Prisma.JsonValue;
    await db().searchJob.update({ where: { id: this.searchJobId }, data: { strategyLog: log as unknown as Prisma.InputJsonValue } });
  }

  async run(): Promise<'completed'> {
    const job = await loadJob(this.searchJobId);
    if (!job) throw new Error(`search job ${this.searchJobId} not found`);
    this.job = job;
    this.params = searchParamsSchema.parse(job.params);
    await db().searchJob.update({ where: { id: job.id }, data: { status: 'running', startedAt: job.startedAt ?? new Date(), error: null } });
    const startIdx = Math.max(0, ORDER.indexOf(job.stage as SearchStage));
    for (const stage of ORDER.slice(startIdx)) {
      await this.checkControl(true);
      await db().searchJob.update({ where: { id: job.id }, data: { stage } });
      this.job.stage = stage;
      this.log.info({ searchJobId: job.id, stage }, 'stage started');
      await this.runStage(stage);
      await this.updateCounts();
    }
    const counts = await this.updateCounts();
    await db().searchJob.update({ where: { id: job.id }, data: { status: 'completed', stage: 'completed', finishedAt: new Date() } });
    await this.appendLog([`Completed: ${counts.found} found, ${counts.valid} valid, ${counts.websites} websites, ${counts.analyzed} analysed, ${counts.veryHigh + counts.high} high priority.`]);
    if (job.savedSearchId) await db().savedSearch.update({ where: { id: job.savedSearchId }, data: { lastRunAt: new Date() } }).catch(() => undefined);
    return 'completed';
  }

  private async runStage(stage: SearchStage): Promise<void> {
    switch (stage) {
      case 'planning':
        return this.planning();
      case 'discovering':
        return this.discovering();
      case 'merging':
        return this.merging();
      case 'verifying':
        return this.verifying();
      case 'website_discovery':
        return this.websiteDiscovery();
      case 'analyzing':
        return this.analyzing();
      case 'contacts':
        return this.contacts();
      case 'qualifying':
        return this.qualifying();
      case 'reporting':
        return this.reporting();
      default:
        return;
    }
  }

  // ───────────── planning ─────────────
  private async planning(): Promise<void> {
    if (this.job.trigger === 'import') return;
    const existing = await db().searchQuery.count({ where: { searchJobId: this.searchJobId } });
    if (existing > 0) return;
    const budget = new CallBudget(20);
    const ctx = { budget, log: this.log, signal: this.deps.signal, jobId: this.searchJobId };
    let area: GeoArea | null = null;
    let segments: string[] = [];
    const notes: string[] = [];
    if (this.deps.registry.geo) {
      try {
        area = await this.deps.registry.geo.geocode(this.params.location, this.params.country, ctx);
        if (area) notes.push(`Location resolved to “${area.displayName}” (${area.source}).`);
        if (area && this.params.quantity > 40) segments = await this.deps.registry.geo.subdivisions(area, ctx).catch(() => []);
      } catch (e) {
        notes.push(`Geocoding unavailable (${errorMessage(e)}); continuing with text queries only.`);
      }
    }
    const nicheKey = resolveNiche(this.params.niche).def?.key;
    const yields = await templateYieldMap(nicheKey).catch(() => new Map<string, number>());
    if (yields.size) notes.push(`Query order adjusted using historical yield of ${yields.size} query template(s).`);
    const plan = planSearch(this.params, { segments, templateYield: yields });
    const sources = activeSearchSources(this.deps.registry, this.params.providers).filter((s) => s.id !== 'import');
    const missing = this.deps.registry.sources.filter((s) => s.capabilities.search && s.id !== 'import' && !s.isConfigured());
    notes.push(...plan.notes);
    notes.push(`Sources used: ${sources.map((s) => s.name).join(', ') || 'none'}.`);
    if (missing.length) notes.push(`Not configured (optional): ${missing.map((s) => s.name).join(', ')}.`);
    if (sources.length === 0) notes.push('No search source is configured/enabled — add an API key or enable OpenStreetMap in Settings → Sources.');
    await db().searchQuery.createMany({
      data: plan.queries.map((q) => ({
        searchJobId: this.searchJobId,
        text: q.text,
        term: q.term,
        language: String(q.language),
        segment: q.segment,
        strategy: q.strategy,
        template: q.template,
        intent: 'places',
        providerIds: sources.map((s) => s.id),
      })),
    });
    const progress = jsonObject<Record<string, unknown>>(this.job.progress, {});
    progress.area = area as unknown;
    progress.nicheKey = plan.nicheKey ?? null;
    progress.countryCode = plan.countryCode ?? null;
    this.job.progress = progress as Prisma.JsonValue;
    await db().searchJob.update({ where: { id: this.searchJobId }, data: { progress: progress as Prisma.InputJsonValue } });
    await this.appendLog(notes);
  }

  // ───────────── discovering ─────────────
  private async discovering(): Promise<void> {
    if (this.job.trigger === 'import') return;
    const pending = await db().searchQuery.findMany({ where: { searchJobId: this.searchJobId, status: 'pending' }, orderBy: { createdAt: 'asc' } });
    if (pending.length === 0) return;
    const sources = activeSearchSources(this.deps.registry, this.params.providers).filter((s) => s.id !== 'import');
    if (sources.length === 0) {
      await db().searchQuery.updateMany({ where: { id: { in: pending.map((q) => q.id) } }, data: { status: 'skipped', error: 'no sources configured' } });
      return;
    }
    const progress = jsonObject<{ area?: GeoArea | null; nicheKey?: string | null; countryCode?: string | null }>(this.job.progress, {});
    const planned: PlannedQuery[] = pending.map((q) => ({ text: q.text, term: q.term || this.params.niche, language: q.language, segment: q.segment ?? undefined, strategy: q.strategy as PlannedQuery['strategy'], template: q.template, priority: 0 }));
    const budget = new CallBudget(this.cfg.MAX_PROVIDER_CALLS_PER_JOB);
    let lastProgress = 0;
    const result = await fanOut({
      queries: planned,
      sources,
      nicheKey: progress.nicheKey ?? undefined,
      city: this.params.location,
      country: this.params.country,
      countryCode: progress.countryCode ?? toCountryCode(this.params.country),
      area: progress.area ?? undefined,
      radiusKm: this.params.radiusKm,
      targetUniqueRecords: Math.min(3000, this.params.quantity * 3),
      perQueryLimit: Math.min(60, Math.max(20, this.params.quantity)),
      budget,
      signal: this.deps.signal,
      log: this.log,
      jobId: this.searchJobId,
      shouldStop: () => this.shouldStop(),
      onProgress: async (done, total, unique) => {
        if (Date.now() - lastProgress < 1500 && done < total) return;
        lastProgress = Date.now();
        await this.setProgress('discovering', done, total, { unique });
      },
    });
    await this.checkControl(true);

    // Persist records + provenance hits (idempotent on resume).
    const now = new Date();
    const policy = new Map(sources.map((s) => [s.id, s.dataPolicy.retentionHours]));
    const recordIds = new Map<string, string>();
    for (const hit of result.hits) {
      const r = hit.record;
      const key = `${r.provider}:${r.providerRecordId}`;
      if (recordIds.has(key)) continue;
      const phone = normalizePhone(r.phone, r.country ?? this.params.country);
      const retentionHours = policy.get(r.provider);
      const data = {
        name: r.name,
        normalizedName: normalizeName(r.name),
        categories: r.categories,
        address: r.address,
        street: r.street,
        city: r.city,
        postalCode: r.postalCode,
        region: r.region,
        country: r.country,
        lat: r.lat,
        lng: r.lng,
        phone: r.phone,
        phoneE164: phone?.valid ? phone.e164 : null,
        website: r.website,
        websiteDomain: domainKey(r.website),
        email: r.email,
        profileUrl: r.profileUrl,
        businessStatus: r.businessStatus,
        rating: r.rating,
        ratingCount: r.ratingCount,
        priceLevel: r.priceLevel,
        payload: { ...(r.raw ?? {}), socials: r.socials ?? [] } as Prisma.InputJsonValue,
        fetchedAt: r.fetchedAt,
        lastSeenAt: now,
        retentionExpiresAt: retentionHours ? new Date(now.getTime() + retentionHours * 3_600_000) : null,
        purgedAt: null,
      };
      const row = await db().sourceRecord.upsert({
        where: { provider_providerRecordId: { provider: r.provider, providerRecordId: r.providerRecordId } },
        create: { provider: r.provider, providerRecordId: r.providerRecordId, searchJobId: this.searchJobId, ...data },
        update: data,
      });
      recordIds.set(key, row.id);
    }
    const queryIds = pending.map((q) => q.id);
    await db().queryHit.deleteMany({ where: { searchQueryId: { in: queryIds } } });
    const hitRows = new Map<string, { searchQueryId: string; sourceRecordId: string; provider: string; rank: number }>();
    for (const hit of result.hits) {
      const q = pending[hit.queryIndex]!;
      const sid = recordIds.get(`${hit.record.provider}:${hit.record.providerRecordId}`)!;
      const k = `${q.id}|${sid}|${hit.record.provider}`;
      if (!hitRows.has(k)) hitRows.set(k, { searchQueryId: q.id, sourceRecordId: sid, provider: hit.record.provider, rank: hit.rank });
    }
    if (hitRows.size) await db().queryHit.createMany({ data: [...hitRows.values()] });
    for (const [i, q] of pending.entries()) {
      const qr = result.queryResults[i]!;
      const attempted = qr.providers.length > 0 || qr.errors.length > 0;
      await db().searchQuery.update({
        where: { id: q.id },
        data: { status: attempted ? (qr.errors.length && !qr.providers.length ? 'failed' : 'done') : 'skipped', resultsCount: qr.resultsCount, newRecordsCount: qr.newRecords, error: qr.errors.join('; ').slice(0, 1000) || null, executedAt: attempted ? now : null },
      });
    }
    const prevStats = jsonObject<Record<string, ProviderRunStat>>(this.job.sourcesUsed, {});
    for (const [id, st] of Object.entries(result.providerStats)) {
      const p = prevStats[id];
      prevStats[id] = p ? { ...st, calls: p.calls + st.calls, records: p.records + st.records, errors: p.errors + st.errors } : st;
    }
    this.job.sourcesUsed = prevStats as unknown as Prisma.JsonValue;
    await db().searchJob.update({ where: { id: this.searchJobId }, data: { sourcesUsed: prevStats as unknown as Prisma.InputJsonValue } });
    const notes = [`Discovery: ${recordIds.size} unique source records from ${Object.values(result.providerStats).filter((s) => s.records > 0).length} source(s); ${budget.spent} API calls.`];
    if (result.stoppedEarly) notes.push('Stopped scheduling further queries: enough candidates collected for the requested quantity.');
    if (result.budgetExhausted) notes.push(`Per-job API call budget (${this.cfg.MAX_PROVIDER_CALLS_PER_JOB}) reached; remaining queries were skipped.`);
    for (const s of Object.values(result.providerStats)) if (s.status !== 'ok') notes.push(`${s.name}: ${s.status}${s.lastError ? ` — ${s.lastError}` : ''}`);
    await this.appendLog(notes);
  }

  // ───────────── merging (entity resolution) ─────────────
  private async jobRecordIds(): Promise<string[]> {
    const hits = await db().queryHit.findMany({ where: { searchQuery: { searchJobId: this.searchJobId } }, select: { sourceRecordId: true }, distinct: ['sourceRecordId'] });
    const own = await db().sourceRecord.findMany({ where: { searchJobId: this.searchJobId }, select: { id: true } });
    return [...new Set([...hits.map((h) => h.sourceRecordId), ...own.map((o) => o.id)])];
  }

  private async merging(): Promise<void> {
    const ids = await this.jobRecordIds();
    if (ids.length === 0) return;
    const rows = await db().sourceRecord.findMany({ where: { id: { in: ids } } });
    const unlinked = rows.filter((r) => !r.companyId);
    const linkedCompanyIds = new Set(rows.map((r) => r.companyId).filter((x): x is string => !!x));
    const cc = toCountryCode(this.params.country);
    let created = 0;
    let mergedIntoExisting = 0;

    if (unlinked.length > 0) {
      const res: ResolvableRecord[] = unlinked.map((r) => ({ ...toResolvable(recordFromRow(r), cc), key: r.id }));
      const domains = [...new Set(res.map((r) => r.domain).filter((x): x is string => !!x))];
      const phones = [...new Set(res.map((r) => r.phoneE164).filter((x): x is string => !!x))];
      const names = [...new Set(res.map((r) => r.normalizedName).filter(Boolean))];
      const candidates = await db().company.findMany({
        where: { OR: [{ primaryDomain: { in: domains } }, { phoneE164: { in: phones } }, { normalizedName: { in: names } }, { id: { in: [...linkedCompanyIds] } }] },
        select: { id: true, name: true, primaryDomain: true, phoneE164: true, address: true, postalCode: true, city: true, lat: true, lng: true },
      });
      const clusters = clusterRecords([...res, ...candidates.map(companyToResolvable)]);
      let i = 0;
      for (const cl of clusters) {
        if (++i % 25 === 0) {
          await this.checkControl();
          await this.setProgress('merging', i, clusters.length);
        }
        const recKeys = cl.members.filter((m) => m.provider !== 'company').map((m) => m.key);
        if (recKeys.length === 0) continue; // cluster of only existing companies
        const existing = cl.members.find((m) => m.companyId)?.companyId ?? null;
        const recRows = unlinked.filter((u) => recKeys.includes(u.id));
        const allForCompany = existing ? [...recRows, ...(await db().sourceRecord.findMany({ where: { companyId: existing } }))] : recRows;
        const merged = mergeRecords(allForCompany.map(recordFromRow), cc);
        let companyId = existing;
        const industryLabel = resolveNiche(this.params.niche).def?.label ?? this.params.niche;
        if (!companyId) {
          const c = await db().company.create({
            data: {
              name: merged.name,
              normalizedName: merged.normalizedName,
              industry: industryLabel,
              categories: merged.categories,
              primaryDomain: merged.primaryDomain,
              phoneE164: merged.phoneE164,
              address: merged.address,
              city: merged.city ?? this.params.location,
              postalCode: merged.postalCode,
              country: merged.country ?? this.params.country,
              lat: merged.lat,
              lng: merged.lng,
              businessStatus: merged.businessStatus,
              rating: merged.rating,
              ratingCount: merged.ratingCount,
              priceLevel: merged.priceLevel,
              sources: merged.sources,
              discrepancies: merged.discrepancies as unknown as Prisma.InputJsonValue,
              sourceTimestamp: merged.newestFetch,
            },
          });
          companyId = c.id;
          created++;
        } else {
          mergedIntoExisting++;
          await db().company.update({
            where: { id: companyId },
            data: {
              categories: merged.categories,
              primaryDomain: merged.primaryDomain ?? undefined,
              phoneE164: merged.phoneE164 ?? undefined,
              address: merged.address ?? undefined,
              postalCode: merged.postalCode ?? undefined,
              lat: merged.lat ?? undefined,
              lng: merged.lng ?? undefined,
              businessStatus: merged.businessStatus,
              rating: merged.rating ?? undefined,
              ratingCount: merged.ratingCount ?? undefined,
              priceLevel: merged.priceLevel ?? undefined,
              sources: merged.sources,
              discrepancies: merged.discrepancies as unknown as Prisma.InputJsonValue,
              lastSeenAt: new Date(),
              sourceTimestamp: merged.newestFetch,
            },
          });
        }
        await db().sourceRecord.updateMany({ where: { id: { in: recKeys } }, data: { companyId } });
        await this.syncLocations(companyId, allForCompany.map(recordFromRow));
        linkedCompanyIds.add(companyId);
      }
    }

    // Refresh "last seen" for companies found again, and ensure Lead + campaign membership.
    const companyIds = [...new Set((await db().sourceRecord.findMany({ where: { id: { in: ids } }, select: { companyId: true } })).map((r) => r.companyId).filter((x): x is string => !!x))];
    await db().company.updateMany({ where: { id: { in: companyIds } }, data: { lastSeenAt: new Date() } });
    for (const companyId of companyIds) {
      const lead = await db().lead.upsert({
        where: { companyId },
        create: { companyId, campaignId: this.job.campaignId, stage: 'discovered', priorityReasons: [] },
        update: {},
      });
      if (lead.stage === 'new') await db().lead.update({ where: { id: lead.id }, data: { stage: 'discovered', stageChangedAt: new Date() } });
      if (this.job.campaignId) {
        await db().campaignLead.upsert({
          where: { campaignId_leadId: { campaignId: this.job.campaignId, leadId: lead.id } },
          create: { campaignId: this.job.campaignId, leadId: lead.id, searchJobId: this.searchJobId },
          update: {},
        });
      }
    }
    await this.appendLog([`Merging: ${ids.length} records → ${companyIds.length} companies (${created} new, ${mergedIntoExisting} matched existing, ${Math.max(0, ids.length - companyIds.length)} duplicates merged).`]);
  }

  private async syncLocations(companyId: string, records: NormalizedBusiness[]): Promise<void> {
    const existing = await db().location.findMany({ where: { companyId } });
    const known = new Set(existing.map((l) => addressKey(l.address ?? l.street)));
    for (const r of records) {
      const k = addressKey(r.street ?? r.address);
      if (!k || known.has(k)) continue;
      known.add(k);
      const phone = normalizePhone(r.phone, r.country);
      await db().location.create({
        data: { companyId, address: r.address, street: r.street, city: r.city, postalCode: r.postalCode, region: r.region, country: r.country, lat: r.lat, lng: r.lng, phoneE164: phone?.valid ? phone.e164 : null, sources: [r.provider] },
      });
    }
  }

  private async jobLeads() {
    return db().campaignLead.findMany({
      where: { searchJobId: this.searchJobId },
      include: { lead: { include: { company: { include: { website: true, sourceRecords: true } }, outcomes: { select: { id: true } } } } },
    });
  }

  // ───────────── verifying ─────────────
  private async verifying(): Promise<void> {
    const cls = await this.jobLeads();
    let i = 0;
    for (const cl of cls) {
      if (++i % 25 === 0) await this.checkControl();
      const { lead } = cl;
      const c = lead.company;
      let reason: string | null = null;
      if (c.businessStatus === 'closed_permanently') reason = 'Reported permanently closed by a source';
      else if (c.doNotContact) reason = 'Marked do-not-contact';
      else if (this.params.excludeExistingClients && c.isExistingClient) reason = 'Existing client';
      else if (this.params.excludePreviouslyContacted && (lead.contactedAt || lead.outcomes.length > 0 || ['contacted', 'replied', 'meeting', 'proposal', 'won', 'lost', 'follow_up'].includes(lead.stage))) reason = 'Previously contacted';
      else {
        const cats = `${jsonArray<string>(c.categories).join(' ')} ${c.name}`.toLowerCase();
        const ex = this.params.excludedIndustries.find((x) => x && cats.includes(x.toLowerCase()));
        if (ex) reason = `Excluded industry (“${ex}”)`;
      }
      const newest = c.sourceRecords.reduce<Date | null>((m, r) => (!m || r.fetchedAt > m ? r.fetchedAt : m), null);
      await db().campaignLead.update({ where: { id: cl.id }, data: { excludedReason: reason } });
      await db().company.update({ where: { id: c.id }, data: { lastVerifiedAt: c.lastVerifiedAt && newest && c.lastVerifiedAt > newest ? c.lastVerifiedAt : newest } });
      if (!reason) {
        const stage = advanceStage(lead.stage, 'verified');
        if (stage !== lead.stage) await db().lead.update({ where: { id: lead.id }, data: { stage, stageChangedAt: new Date() } });
      }
    }
  }

  // ───────────── website discovery ─────────────
  private async websiteDiscovery(): Promise<void> {
    const cls = (await this.jobLeads()).filter((cl) => !cl.excludedReason);
    const staleMs = 30 * 86_400_000;
    const todo = cls.filter((cl) => {
      const w = cl.lead.company.website;
      if (!w) return true;
      if (w.status === 'found') return false;
      return !w.lastCheckedAt || Date.now() - w.lastCheckedAt.getTime() > staleMs || w.status === 'unreachable';
    });
    const webSearchBudget = Math.ceil(this.params.quantity * 1.5);
    let webSearches = 0;
    const budget = new CallBudget(Math.max(10, webSearchBudget));
    const searchAvailable = this.deps.registry.webDiscovery.isConfigured() && !this.deps.registry.disabled.has('web_search');
    let done = 0;
    await mapLimit(
      todo,
      4,
      async (cl) => {
        await this.checkControl();
        const c = cl.lead.company;
        const candidates: WebsiteCandidate[] = c.sourceRecords
          .filter((r) => !!r.website)
          .map((r) => ({ url: r.website!, source: r.provider, sourceUrl: r.profileUrl ?? undefined, evidence: `website field on ${r.provider} record`, rank: r.provider === 'web_search' ? jsonObject<{ rank?: number }>(r.payload, {}).rank : undefined }));
        const decision = await discoverWebsite(
          { name: c.name, city: c.city, country: c.country, phones: [c.phoneE164, ...c.sourceRecords.map((r) => r.phone)].filter((x): x is string => !!x), address: c.address },
          candidates,
          {
            fetchHomepage: (url) => fetchPage(url, { signal: this.deps.signal, timeoutMs: 15_000 }),
            searchAvailable: searchAvailable && webSearches < webSearchBudget,
            searchCandidates: async () => {
              webSearches++;
              return this.deps.registry.webDiscovery.findWebsite(
                { name: c.name, city: c.city, country: c.country, providerRefs: c.sourceRecords.map((r) => ({ provider: r.provider, id: r.providerRecordId })) },
                { budget, log: this.log, signal: this.deps.signal, jobId: this.searchJobId },
              );
            },
          },
        );
        // Another company already uses this domain → possible duplicate; keep both, flag it.
        let domainConflict: string | null = null;
        if (decision.domain && decision.domain !== c.primaryDomain) {
          const other = await db().company.findFirst({ where: { primaryDomain: decision.domain, id: { not: c.id } }, select: { id: true, name: true } });
          if (other) domainConflict = other.name;
        }
        const data = {
          url: decision.url,
          domain: decision.domain,
          finalUrl: decision.finalUrl,
          status: decision.status,
          confidence: decision.confidence,
          discoverySource: decision.source,
          discoveryLog: decision.log as unknown as Prisma.InputJsonValue,
          notFoundReason: decision.notFoundReason,
          httpStatus: decision.httpStatus,
          lastCheckedAt: new Date(),
        };
        await db().website.upsert({ where: { companyId: c.id }, create: { companyId: c.id, ...data }, update: data });
        if (decision.domain && !domainConflict) await db().company.update({ where: { id: c.id }, data: { primaryDomain: decision.domain } });
        if (domainConflict) {
          const d: Discrepancy = { field: 'website', values: [{ value: decision.domain!, sources: [{ provider: 'website_discovery', observedAt: new Date().toISOString() }] }], detectedAt: new Date().toISOString(), note: `The same website is used by “${domainConflict}” — possible duplicate or shared/chain website. Review manually.` };
          await db().company.update({ where: { id: c.id }, data: { discrepancies: [...jsonArray<Discrepancy>(c.discrepancies), d] as unknown as Prisma.InputJsonValue } });
        }
        done++;
        if (done % 5 === 0) await this.setProgress('website_discovery', done, todo.length);
      },
      this.deps.signal,
    );
    await this.setProgress('website_discovery', done, todo.length);
    if (webSearches > 0) await this.appendLog([`Website discovery used ${webSearches} web search lookup(s).`]);
  }

  // ───────────── analyzing ─────────────
  private async analyzing(): Promise<void> {
    if (!this.params.analyzeWebsites) {
      await this.appendLog(['Website analysis disabled for this search.']);
      return;
    }
    const cls = (await this.jobLeads()).filter((cl) => !cl.excludedReason && cl.lead.company.website && ['found', 'unreachable'].includes(cl.lead.company.website.status));
    const freshMs = this.cfg.REANALYZE_AFTER_DAYS * 86_400_000;
    const fresh = cls.filter((cl) => cl.lead.company.website!.lastAnalyzedAt && Date.now() - cl.lead.company.website!.lastAnalyzedAt.getTime() < freshMs);
    const stale = cls.filter((cl) => !fresh.includes(cl));
    // Cost control: analyse the most promising candidates first, up to 1.5× the requested quantity.
    const score = (cl: (typeof cls)[number]) => {
      const c = cl.lead.company;
      return (c.businessStatus === 'operational' ? 2 : 0) + (c.phoneE164 ? 1 : 0) + Math.min(3, Math.log10((c.ratingCount ?? 0) + 1)) + (c.website?.status === 'found' ? 2 : 0) + (c.website?.confidence === 'high' ? 1 : 0);
    };
    const limit = Math.max(0, Math.ceil(this.params.quantity * 1.5) - fresh.length);
    const todo = stale.sort((a, b) => score(b) - score(a)).slice(0, limit);
    const skipped = stale.length - todo.length;
    const notes = [`Analysing ${todo.length} website(s); ${fresh.length} reused from analyses newer than ${this.cfg.REANALYZE_AFTER_DAYS} days.`];
    if (skipped > 0) notes.push(`${skipped} lower-ranked website(s) not analysed to control cost (use “Analyze” on a lead to run it).`);
    await this.appendLog(notes);
    let done = 0;
    await mapLimit(
      todo,
      this.cfg.ANALYSIS_CONCURRENCY,
      async (cl) => {
        await this.checkControl();
        await analyzeCompanyWebsite(cl.lead.companyId, { ai: this.deps.registry.ai, visualAi: this.params.visualAi, searchJobId: this.searchJobId, log: this.log, signal: this.deps.signal }).catch((e) =>
          this.log.warn({ companyId: cl.lead.companyId, error: errorMessage(e) }, 'analysis error (isolated)'),
        );
        done++;
        await this.setProgress('analyzing', done, todo.length);
      },
      this.deps.signal,
    );
  }

  // ───────────── contacts ─────────────
  private async contacts(): Promise<void> {
    const cls = await this.jobLeads();
    let i = 0;
    for (const cl of cls) {
      if (++i % 25 === 0) await this.checkControl();
      const c = cl.lead.company;
      const obs = contactsFromSources(c.sourceRecords.filter((r) => !r.purgedAt).map(recordFromRow), c.country);
      await storeContacts(c.id, obs, c.primaryDomain);
    }
  }

  // ───────────── qualifying ─────────────
  private async qualifying(): Promise<void> {
    const cls = await this.jobLeads();
    const model = await loadActiveModel('reply');
    let i = 0;
    for (const cl of cls) {
      if (++i % 10 === 0) {
        await this.checkControl();
        await this.setProgress('qualifying', i, cls.length);
      }
      await qualifyLead(cl.leadId, { params: this.params, log: this.log, model }).catch((e) => this.log.warn({ leadId: cl.leadId, error: errorMessage(e) }, 'qualification failed (isolated)'));
    }
    await this.setProgress('qualifying', cls.length, cls.length);
  }

  // ───────────── reporting ─────────────
  private async reporting(): Promise<void> {
    if (this.params.generateAudits !== 'top') return;
    const leads = await db().lead.findMany({
      where: { campaignLeads: { some: { searchJobId: this.searchJobId, excludedReason: null } }, priority: { in: ['very_high', 'high'] }, audits: { none: {} } },
      orderBy: [{ priorityRank: 'desc' }, { leadFit: 'desc' }],
      take: Math.min(25, this.params.quantity),
      select: { id: true },
    });
    let done = 0;
    for (const l of leads) {
      await this.checkControl();
      await generateAuditForLead(l.id, { ai: null, log: this.log }).catch((e) => this.log.warn({ leadId: l.id, error: errorMessage(e) }, 'audit generation failed'));
      await this.setProgress('reporting', ++done, leads.length);
    }
  }

  // ───────────── counts ─────────────
  async updateCounts(): Promise<SearchCounts> {
    const counts = await computeJobCounts(this.searchJobId);
    await db().searchJob.update({ where: { id: this.searchJobId }, data: { counts: counts as unknown as Prisma.InputJsonValue } });
    return counts;
  }
}

/** Real counts for the results page, computed only from this job's rows. */
export async function computeJobCounts(searchJobId: string): Promise<SearchCounts> {
  const counts = emptyCounts();
  const hitIds = await db().queryHit.findMany({ where: { searchQuery: { searchJobId } }, select: { sourceRecordId: true }, distinct: ['sourceRecordId'] });
  const own = await db().sourceRecord.findMany({ where: { searchJobId }, select: { id: true } });
  counts.found = new Set([...hitIds.map((h) => h.sourceRecordId), ...own.map((o) => o.id)]).size;
  const cls = await db().campaignLead.findMany({
    where: { searchJobId },
    select: { excludedReason: true, lead: { select: { priority: true, stage: true, contactAvailability: true, company: { select: { id: true, website: { select: { status: true, lastAnalyzedAt: true, id: true } } } } } } },
  });
  counts.duplicatesMerged = Math.max(0, counts.found - cls.length);
  for (const cl of cls) {
    const l = cl.lead;
    if (cl.excludedReason || l.priority === 'excluded') counts.excluded++;
    else counts.valid++;
    const w = l.company.website;
    if (w?.status === 'found' || w?.status === 'unreachable') counts.websites++;
    if (w?.status === 'not_found') counts.noWebsite++;
    if (w?.lastAnalyzedAt) counts.analyzed++;
    if (cl.excludedReason) continue;
    switch (l.priority) {
      case 'very_high':
        counts.veryHigh++;
        break;
      case 'high':
        counts.high++;
        break;
      case 'medium':
        counts.medium++;
        break;
      case 'low':
        counts.low++;
        break;
      case 'insufficient_data':
        counts.insufficient++;
        break;
    }
    if (['very_high', 'high', 'medium'].includes(l.priority ?? '') && l.contactAvailability && l.contactAvailability !== 'none') counts.contactReady++;
  }
  const failed = await db().analysis.findMany({ where: { searchJobId, status: { in: ['failed', 'unreachable'] } }, select: { companyId: true }, distinct: ['companyId'] });
  counts.analysisFailed = failed.length;
  return counts;
}
