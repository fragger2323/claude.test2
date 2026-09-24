import { db } from '../../db/client.js';
import { jsonArray, jsonObject } from '../../lib/misc.js';

/**
 * Real-data analytics for Dashboard, Learning and the search-quality loop.
 * Rates are only reported when the denominator reaches MIN_N; otherwise the UI shows
 * "insufficient data (n=…)". Nothing here is estimated or invented.
 */
export const MIN_N = 10;

export interface Rate {
  value: number | null;
  numerator: number;
  n: number;
  sufficient: boolean;
}

export function rate(numerator: number, n: number, min = MIN_N): Rate {
  return { value: n >= min && n > 0 ? numerator / n : null, numerator, n, sufficient: n >= min };
}

const POSITIVE_REPLY = new Set(['replied', 'meeting', 'proposal', 'won']);

interface LeadRow {
  id: string;
  stage: string;
  priority: string | null;
  contactedAt: Date | null;
  primaryServiceSlug: string | null;
  qualifiedAt: Date | null;
  contactAvailability: string | null;
  contactedFeatures: unknown;
  campaignId: string | null;
  company: { id: string; industry: string | null; city: string | null; sources: unknown; website: { status: string } | null };
  outcomes: Array<{ type: string; serviceSlug: string | null; dealValue: number | null; recordedAt: Date }>;
}

async function loadLeads(where: Record<string, unknown> = {}): Promise<LeadRow[]> {
  return db().lead.findMany({
    where,
    select: {
      id: true,
      stage: true,
      priority: true,
      contactedAt: true,
      primaryServiceSlug: true,
      qualifiedAt: true,
      contactAvailability: true,
      contactedFeatures: true,
      campaignId: true,
      company: { select: { id: true, industry: true, city: true, sources: true, website: { select: { status: true } } } },
      outcomes: { select: { type: true, serviceSlug: true, dealValue: true, recordedAt: true } },
    },
  }) as unknown as Promise<LeadRow[]>;
}

const has = (l: LeadRow, types: string[]) => l.outcomes.some((o) => types.includes(o.type)) || types.includes(l.stage);
const isQualified = (l: LeadRow) => !!l.priority && !['excluded', 'insufficient_data'].includes(l.priority);
const isHigh = (l: LeadRow) => l.priority === 'high' || l.priority === 'very_high';

export interface Funnel {
  discovered: number;
  websitesFound: number;
  verified: number;
  analyzed: number;
  qualified: number;
  contactReady: number;
  contacted: number;
  replies: number;
  meetings: number;
  proposals: number;
  won: number;
  lost: number;
}

export function funnelFrom(leads: LeadRow[], analyzedCompanyIds: Set<string>): Funnel {
  return {
    discovered: leads.length,
    websitesFound: leads.filter((l) => l.company.website?.status === 'found').length,
    verified: leads.filter((l) => !['new', 'discovered'].includes(l.stage)).length,
    analyzed: leads.filter((l) => analyzedCompanyIds.has(l.company.id)).length,
    qualified: leads.filter(isQualified).length,
    contactReady: leads.filter((l) => isQualified(l) && l.contactAvailability && l.contactAvailability !== 'none').length,
    contacted: leads.filter((l) => !!l.contactedAt).length,
    replies: leads.filter((l) => has(l, ['replied', 'meeting', 'proposal', 'won'])).length,
    meetings: leads.filter((l) => has(l, ['meeting', 'proposal', 'won'])).length,
    proposals: leads.filter((l) => has(l, ['proposal', 'won'])).length,
    won: leads.filter((l) => has(l, ['won'])).length,
    lost: leads.filter((l) => has(l, ['lost', 'not_interested', 'wrong_fit'])).length,
  };
}

function groupPerformance(leads: LeadRow[], key: (l: LeadRow) => string[] | string | null) {
  const groups = new Map<string, LeadRow[]>();
  for (const l of leads) {
    const k = key(l);
    const keys = Array.isArray(k) ? k : k ? [k] : ['unknown'];
    for (const kk of keys) groups.set(kk, [...(groups.get(kk) ?? []), l]);
  }
  return [...groups.entries()]
    .map(([k, ls]) => {
      const contacted = ls.filter((l) => !!l.contactedAt);
      return {
        key: k,
        leads: ls.length,
        qualified: ls.filter(isQualified).length,
        highPriority: ls.filter(isHigh).length,
        contacted: contacted.length,
        replyRate: rate(contacted.filter((l) => has(l, [...POSITIVE_REPLY])).length, contacted.length),
        winRate: rate(ls.filter((l) => has(l, ['won'])).length, ls.filter((l) => has(l, ['won', 'lost', 'not_interested', 'wrong_fit'])).length, 5),
        won: ls.filter((l) => has(l, ['won'])).length,
      };
    })
    .sort((a, b) => b.leads - a.leads);
}

export async function dashboard(campaignId?: string) {
  const leads = await loadLeads(campaignId ? { campaignLeads: { some: { campaignId } } } : {});
  const analyzed = await db().analysis.findMany({ where: { status: { in: ['completed', 'partial'] } }, select: { companyId: true }, distinct: ['companyId'] });
  const funnel = funnelFrom(leads, new Set(analyzed.map((a) => a.companyId)));
  const contacted = leads.filter((l) => !!l.contactedAt);
  const decided = leads.filter((l) => has(l, ['won', 'lost', 'not_interested', 'wrong_fit']));
  return {
    funnel,
    rates: {
      replyRate: rate(funnel.replies, contacted.length),
      meetingRate: rate(funnel.meetings, contacted.length),
      proposalRate: rate(funnel.proposals, contacted.length),
      winRate: rate(funnel.won, decided.length, 5),
    },
    sourcePerformance: groupPerformance(leads, (l) => jsonArray<string>(l.company.sources)),
    serviceDemand: groupPerformance(leads.filter(isQualified), (l) => l.primaryServiceSlug),
    industryPerformance: groupPerformance(leads, (l) => l.company.industry),
    locationPerformance: groupPerformance(leads, (l) => l.company.city),
    minN: MIN_N,
  };
}

/** Which observed problem types and contact channels are associated with replies (descriptive only). */
export async function outcomeInsights() {
  const leads = (await loadLeads({ contactedAt: { not: null } })).filter((l) => l.outcomes.length > 0 || ['replied', 'meeting', 'proposal', 'won', 'lost'].includes(l.stage));
  const byProblem = groupPerformance(leads, (l) => jsonArray<string>(jsonObject<Record<string, unknown>>(l.contactedFeatures, {}).cat_problems));
  const byChannel = groupPerformance(leads, (l) => l.contactAvailability);
  const byPriority = groupPerformance(leads, (l) => l.priority);
  const wonDeals = leads.flatMap((l) => l.outcomes.filter((o) => o.type === 'won').map((o) => ({ service: o.serviceSlug ?? l.primaryServiceSlug, value: o.dealValue })));
  const servicesSold = new Map<string, { count: number; value: number }>();
  for (const d of wonDeals) {
    const k = d.service ?? 'unknown';
    const e = servicesSold.get(k) ?? { count: 0, value: 0 };
    e.count++;
    e.value += d.value ?? 0;
    servicesSold.set(k, e);
  }
  return {
    labelledLeads: leads.length,
    byProblem: byProblem.filter((g) => g.contacted >= 1),
    byChannel,
    byPriority,
    servicesSold: [...servicesSold.entries()].map(([service, v]) => ({ service, ...v })),
    note: 'Descriptive statistics from your own outcomes. Groups below the sample threshold are shown without rates.',
  };
}

/** Search-quality loop: yield of each query template (which variations produce good leads). */
export async function queryTemplateStats(nicheKey?: string) {
  const queries = await db().searchQuery.findMany({
    where: nicheKey ? { template: { startsWith: `${nicheKey}|` } } : {},
    select: { template: true, text: true, id: true, resultsCount: true, hits: { select: { sourceRecord: { select: { companyId: true } } } } },
  });
  const companyIds = new Set(queries.flatMap((q) => q.hits.map((h) => h.sourceRecord.companyId).filter((x): x is string => !!x)));
  const leads = await db().lead.findMany({
    where: { companyId: { in: [...companyIds] } },
    select: { companyId: true, priority: true, contactedAt: true, stage: true, outcomes: { select: { type: true } } },
  });
  const byCompany = new Map(leads.map((l) => [l.companyId, l]));
  const byTemplate = new Map<string, { template: string; example: string; queries: number; results: number; companies: Set<string> }>();
  for (const q of queries) {
    const e = byTemplate.get(q.template) ?? { template: q.template, example: q.text, queries: 0, results: 0, companies: new Set<string>() };
    e.queries++;
    e.results += q.resultsCount;
    for (const h of q.hits) if (h.sourceRecord.companyId) e.companies.add(h.sourceRecord.companyId);
    byTemplate.set(q.template, e);
  }
  return [...byTemplate.values()]
    .map((e) => {
      const ls = [...e.companies].map((id) => byCompany.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
      const high = ls.filter((l) => l.priority === 'high' || l.priority === 'very_high').length;
      const contacted = ls.filter((l) => !!l.contactedAt);
      const replied = contacted.filter((l) => l.outcomes.some((o) => POSITIVE_REPLY.has(o.type)) || POSITIVE_REPLY.has(l.stage)).length;
      const unique = e.companies.size;
      return {
        template: e.template,
        example: e.example,
        queries: e.queries,
        results: e.results,
        uniqueCompanies: unique,
        highPriority: high,
        contacted: contacted.length,
        replied,
        // smoothed yield used to order future queries (Laplace smoothing)
        yield: (high + 3 * replied + 1) / (unique + 5),
      };
    })
    .sort((a, b) => b.yield - a.yield);
}

export async function templateYieldMap(nicheKey?: string): Promise<Map<string, number>> {
  const stats = await queryTemplateStats(nicheKey);
  return new Map(stats.filter((s) => s.uniqueCompanies >= 5).map((s) => [s.template, s.yield]));
}
