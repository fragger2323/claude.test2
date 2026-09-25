import type { Prisma } from '@prisma/client';
import type { Logger } from 'pino';
import { db } from '../../db/client.js';
import { searchParamsSchema, type SearchParams } from '../../domain/search-params.js';
import { CRM_STAGES, PIPELINE_STAGES, PRIORITY_RANK, type CrmStage, type EvidenceItem, type Priority, type ProblemTag } from '../../domain/types.js';
import { jsonArray } from '../../lib/misc.js';
import { contactAvailability } from '../contacts/contact-discovery.js';
import { buildDecisionIntel } from '../fit/decision-intel.js';
import { computeLeadFit } from '../fit/lead-fit.js';
import { salesPotential } from '../fit/sales-potential.js';
import { matchServices, type FindingForScoring } from '../fit/service-matching.js';
import { computeFreshness } from '../freshness/freshness.js';
import { buildFeatureSnapshot, numericFeatures } from '../learning/features.js';
import { loadActiveModel, type ActiveModel } from '../learning/trainer.js';
import { matchPortfolio } from '../portfolio/portfolio-matching.js';
import { resolveNiche } from '../strategy/strategy-engine.js';
import { activeServices, businessProfile } from '../defaults.js';

/** Pipeline stages only ever move forward, and never override stages the user set. */
export function advanceStage(current: string, target: CrmStage): CrmStage {
  const cur = current as CrmStage;
  if (!PIPELINE_STAGES.includes(cur)) return cur;
  return CRM_STAGES.indexOf(target) > CRM_STAGES.indexOf(cur) ? target : cur;
}

export async function latestAnalysis(websiteId: string) {
  return db().analysis.findFirst({
    where: { websiteId, status: { in: ['completed', 'partial', 'unreachable', 'robots_disallowed', 'blocked'] } },
    orderBy: { startedAt: 'desc' },
    include: { findings: true, screenshots: true },
  });
}

export async function paramsForLead(campaignId: string | null): Promise<Partial<SearchParams>> {
  if (!campaignId) return {};
  const job = await db().searchJob.findFirst({ where: { campaignId }, orderBy: { createdAt: 'desc' } });
  const parsed = job ? searchParamsSchema.safeParse(job.params) : null;
  return parsed?.success ? parsed.data : {};
}

export interface QualifyContext {
  params?: Partial<SearchParams>;
  log: Logger;
  model?: ActiveModel | null;
}

export interface QualifyResult {
  priority: Priority;
  leadFit: number | null;
  contactAvailability: string;
  stage: CrmStage;
}

export async function qualifyLead(leadId: string, ctx: QualifyContext): Promise<QualifyResult | null> {
  const lead = await db().lead.findUnique({
    where: { id: leadId },
    include: {
      company: { include: { website: true, contacts: true, locations: true, sourceRecords: { select: { provider: true, fetchedAt: true, sourceUpdatedAt: true, purgedAt: true } } } },
      outcomes: { select: { type: true } },
    },
  });
  if (!lead) return null;
  const c = lead.company;
  const params = ctx.params ?? (await paramsForLead(lead.campaignId));
  const [services, profile, portfolio] = await Promise.all([activeServices(), businessProfile(), db().portfolioProject.findMany({ where: { active: true } })]);
  const analysis = c.website ? await latestAnalysis(c.website.id) : null;
  const findings = (analysis?.findings ?? []).map((f) => ({
    id: f.id,
    code: f.code,
    title: f.title,
    detail: f.detail,
    category: f.category,
    polarity: f.polarity,
    severity: f.severity,
    confidence: f.confidence,
    kind: f.kind,
    problemTags: jsonArray<ProblemTag>(f.problemTags),
    evidence: jsonArray<EvidenceItem>(f.evidence),
  }));
  const scoring: FindingForScoring[] = findings;
  const websiteStatus = (c.website?.status ?? 'none') as 'found' | 'not_found' | 'unreachable' | 'unverified' | 'none';
  const analyzed = !!analysis && ['completed', 'partial'].includes(analysis.status);
  const nicheKey = resolveNiche(c.industry ?? params.niche ?? '').def?.key ?? null;
  const contacts = c.contacts.filter((x) => !x.expiredAt).map((x) => ({ type: x.type, status: x.status, isRoleBased: x.isRoleBased, isPersonal: x.isPersonal, value: x.value, sourceUrl: x.sourceUrl }));
  const activeSources = c.sourceRecords.filter((s) => !s.purgedAt);
  const sawRealSite = !!analysis && ['completed', 'partial'].includes(analysis.status);
  const freshness = computeFreshness({
    sources: c.sourceRecords.map((s) => ({ provider: s.provider, fetchedAt: s.fetchedAt, sourceUpdatedAt: s.sourceUpdatedAt })),
    liveVerifiedAt: sawRealSite ? (analysis!.finishedAt ?? analysis!.startedAt) : null,
    businessStatus: c.businessStatus,
    discrepancyCount: jsonArray(c.discrepancies).length,
    websiteStatus: c.website?.status,
  });
  const copyrightYear = (analysis?.tech as { websiteAgeSignal?: { copyrightYear?: number | null } } | null)?.websiteAgeSignal?.copyrightYear ?? null;
  const baseInput = {
    company: {
      name: c.name,
      industry: c.industry,
      categories: jsonArray<string>(c.categories),
      city: c.city,
      country: c.country,
      businessStatus: c.businessStatus,
      rating: c.rating,
      ratingCount: c.ratingCount,
      priceLevel: c.priceLevel,
      locations: Math.max(1, c.locations.length),
      isExistingClient: c.isExistingClient,
      doNotContact: c.doNotContact,
    },
    website: { status: websiteStatus, analyzed, analysisStatus: analysis?.status ?? null },
    findings: scoring,
    contacts,
    freshness: { score: freshness.label === 'unknown' ? null : freshness.score, factors: freshness.factors },
    nicheKey,
    params,
    profile,
    previouslyContacted: !!lead.contactedAt || lead.outcomes.length > 0,
    websiteAgeYears: copyrightYear ? new Date().getFullYear() - copyrightYear : null,
    weights: profile.scoringWeights ?? undefined,
  };
  // Pass 1 (for commercial relevance, used by service exclusion rules).
  const pre = computeLeadFit({ ...baseInput, serviceFit: { score: null, serviceName: null } });
  const commercial = pre.components.find((x) => x.key === 'commercialRelevance')?.score ?? null;
  const match = matchServices(services, scoring, { hasWebsite: websiteStatus !== 'not_found' && websiteStatus !== 'unverified', websiteUnknown: websiteStatus === 'unverified', commercialRelevance: commercial, disallowed: profile.disallowedProjectTypes, preferredTechnologies: profile.preferredTechnologies }, params.service);
  const svcForFit = match.requested && match.requested.exclusionReasons.length === 0 ? match.requested : match.primary;
  const fit = computeLeadFit({ ...baseInput, serviceFit: { score: svcForFit?.fitScore ?? (match.all.length ? 0 : null), serviceName: svcForFit?.serviceName ?? null } });
  if (match.requested && svcForFit !== match.requested) {
    fit.priorityReasons.push(`Requested service “${match.requested.serviceName}” ${match.requested.exclusionReasons.length ? `is not recommended: ${match.requested.exclusionReasons[0]}` : `fits weakly (${match.requested.fitScore})`}`);
  }

  const availability = contactAvailability(contacts);
  const portfolioMatch = matchPortfolio(
    portfolio.map((p) => ({ id: p.id, name: p.name, url: p.url, industry: p.industry, technologies: jsonArray<string>(p.technologies), styles: jsonArray<string>(p.styles), services: jsonArray<string>(p.services), active: p.active })),
    { industry: c.industry, categories: jsonArray<string>(c.categories), nicheKey, recommendedServices: [match.primary?.serviceSlug, match.secondary?.serviceSlug].filter((x): x is string => !!x), platform: c.website?.platform ?? null },
  );

  const model = ctx.model === undefined ? await loadActiveModel('reply') : ctx.model;
  const snapshot = buildFeatureSnapshot({
    fit,
    contactAvailability: availability,
    websiteStatus,
    primaryService: match.primary?.serviceSlug ?? null,
    industry: nicheKey ?? c.industry,
    sources: [...new Set(activeSources.map((s) => s.provider))],
    mainProblemTags: [...new Set(scoring.filter((f) => f.polarity === 'negative').flatMap((f) => f.problemTags))].slice(0, 8),
    priorityRank: PRIORITY_RANK[fit.priority],
  });
  const potential = salesPotential(fit, model?.trained ?? null, model ? numericFeatures(snapshot, model.vocab) : null);

  const aiObservations = findings.filter((f) => f.kind === 'ai_observation').length;
  const decision = buildDecisionIntel({
    company: {
      name: c.name,
      city: c.city,
      country: c.country,
      sources: jsonArray<string>(c.sources),
      ratingCount: c.ratingCount,
      rating: c.rating,
      businessStatus: c.businessStatus,
      firstSeenAt: c.firstSeenAt,
      discrepancies: jsonArray(c.discrepancies).length,
    },
    website: { status: websiteStatus, url: c.website?.url ?? null, platform: c.website?.platform ?? null, notFoundReason: c.website?.notFoundReason ?? null },
    analysis: analysis
      ? { at: analysis.finishedAt, lighthouseRan: !!analysis.lighthouse, aiObservations, diff: (analysis.diff as never) ?? null, status: analysis.status }
      : null,
    findings: findings.map((f) => ({ ...f, evidenceSummary: f.evidence.filter((e) => e.type !== 'screenshot').map((e) => [e.label, e.excerpt, e.value].filter((x) => x != null).join(': ')).filter(Boolean)[0] })),
    fit,
    services: { primary: match.primary, secondary: match.secondary, doNotRecommend: match.doNotRecommend },
    contacts,
    freshness: { label: freshness.label, lastVerifiedAt: c.lastVerifiedAt, sources: activeSources.map((s) => ({ provider: s.provider, fetchedAt: s.fetchedAt })) },
    portfolioNote: portfolioMatch.note,
  });

  let stage = lead.stage as CrmStage;
  if (analyzed || websiteStatus === 'not_found') stage = advanceStage(stage, 'analyzed');
  if (!['excluded', 'insufficient_data'].includes(fit.priority)) stage = advanceStage(stage, 'qualified');
  if (['very_high', 'high', 'medium'].includes(fit.priority) && availability !== 'none') stage = advanceStage(stage, 'contact_ready');

  const comp = (k: string) => fit.components.find((x) => x.key === k)?.score ?? null;
  await db().$transaction([
    db().recommendation.deleteMany({ where: { leadId } }),
    db().recommendation.createMany({
      data: [
        ...(match.primary ? [{ ...match.primary }] : []),
        ...(match.secondary ? [{ ...match.secondary }] : []),
        ...match.doNotRecommend,
      ].map((m) => ({
        leadId,
        serviceId: services.find((s) => s.slug === m.serviceSlug)?.id ?? null,
        serviceSlug: m.serviceSlug,
        kind: m.kind,
        fitScore: m.fitScore,
        reasons: m.reasons as unknown as Prisma.InputJsonValue,
        exclusionReasons: m.exclusionReasons as unknown as Prisma.InputJsonValue,
      })),
    }),
    db().lead.update({
      where: { id: leadId },
      data: {
        priority: fit.priority,
        priorityRank: PRIORITY_RANK[fit.priority],
        leadFit: fit.leadFit,
        websiteNeed: comp('websiteNeed'),
        serviceFit: comp('serviceFit'),
        contactability: comp('contactability'),
        freshness: comp('freshness'),
        components: { components: fit.components, dataCompleteness: fit.dataCompleteness, serviceMatches: match.all.map((m) => ({ slug: m.serviceSlug, name: m.serviceName, fit: m.fitScore, excluded: m.exclusionReasons })) } as unknown as Prisma.InputJsonValue,
        priorityReasons: fit.priorityReasons,
        salesPotential: potential as unknown as Prisma.InputJsonValue,
        decision: decision as unknown as Prisma.InputJsonValue,
        primaryServiceSlug: match.primary?.serviceSlug ?? null,
        secondaryServiceSlug: match.secondary?.serviceSlug ?? null,
        mainOpportunity: decision.mainPainPoint?.title ?? null,
        contactAvailability: availability,
        portfolioMatch: portfolioMatch as unknown as Prisma.InputJsonValue,
        excludedReason: fit.priority === 'excluded' ? fit.priorityReasons[0] ?? null : null,
        qualifiedAt: fit.priority !== 'insufficient_data' ? new Date() : lead.qualifiedAt,
        lastScoredAt: new Date(),
        stage,
        stageChangedAt: stage !== lead.stage ? new Date() : undefined,
      },
    }),
  ]);
  return { priority: fit.priority, leadFit: fit.leadFit, contactAvailability: availability, stage };
}

/** Feature snapshot for learning, captured when the user marks a lead as contacted. */
export async function captureContactedFeatures(leadId: string): Promise<Record<string, unknown> | null> {
  const lead = await db().lead.findUnique({ where: { id: leadId }, include: { company: { include: { website: true, sourceRecords: { select: { provider: true } } } } } });
  if (!lead) return null;
  const comps = (lead.components as { components?: Array<{ key: string; score: number | null; label: string; weight: number; factors: [] }>; dataCompleteness?: number } | null)?.components ?? [];
  const analysis = lead.company.website ? await latestAnalysis(lead.company.website.id) : null;
  return buildFeatureSnapshot({
    fit: { leadFit: lead.leadFit, components: comps as never, priority: (lead.priority ?? 'insufficient_data') as Priority, priorityReasons: [], dataCompleteness: 1 },
    contactAvailability: lead.contactAvailability,
    websiteStatus: lead.company.website?.status ?? 'none',
    primaryService: lead.primaryServiceSlug,
    industry: resolveNiche(lead.company.industry ?? '').def?.key ?? lead.company.industry,
    sources: [...new Set(lead.company.sourceRecords.map((s) => s.provider))],
    mainProblemTags: [...new Set((analysis?.findings ?? []).filter((f) => f.polarity === 'negative').flatMap((f) => jsonArray<string>(f.problemTags)))].slice(0, 8),
    priorityRank: lead.priorityRank,
  });
}
