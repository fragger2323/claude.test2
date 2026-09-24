import { db } from '../../db/client.js';
import { jsonArray } from '../../lib/misc.js';
import { MIN_SAMPLES } from '../learning/trainer.js';

/**
 * TODAY command centre. Every recommended action is a rule over real CRM data and
 * carries the count/ids it is based on. No generic advice.
 */
export interface RecommendedAction {
  id: string;
  title: string;
  detail: string;
  count: number;
  leadIds: string[];
  link: string;
  urgency: 'high' | 'medium' | 'low';
}

const DAY = 86_400_000;

export async function todayOverview(now = new Date()) {
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const leadSelect = { id: true, stage: true, priority: true, leadFit: true, mainOpportunity: true, primaryServiceSlug: true, contactAvailability: true, stageChangedAt: true, createdAt: true, company: { select: { name: true, city: true, industry: true, website: { select: { url: true } } } } } as const;

  const [newBest, followUps, replies, meetings, proposals, wonOutcomes, review] = await Promise.all([
    db().lead.findMany({
      where: { priority: { in: ['very_high', 'high'] }, stage: { in: ['qualified', 'contact_ready'] }, createdAt: { gte: new Date(now.getTime() - 7 * DAY) } },
      orderBy: [{ priorityRank: 'desc' }, { leadFit: 'desc' }],
      take: 12,
      select: leadSelect,
    }),
    db().followUp.findMany({ where: { status: 'pending', dueAt: { lte: endOfDay } }, orderBy: { dueAt: 'asc' }, take: 30, include: { lead: { select: leadSelect } } }),
    db().lead.findMany({ where: { stage: 'replied' }, orderBy: { stageChangedAt: 'asc' }, take: 20, select: leadSelect }),
    db().lead.findMany({ where: { stage: 'meeting' }, orderBy: { stageChangedAt: 'asc' }, take: 20, select: leadSelect }),
    db().lead.findMany({ where: { stage: 'proposal' }, orderBy: { stageChangedAt: 'asc' }, take: 20, select: leadSelect }),
    db().outcome.findMany({ where: { type: 'won', recordedAt: { gte: new Date(now.getTime() - 30 * DAY) } }, orderBy: { recordedAt: 'desc' }, take: 10, include: { lead: { select: leadSelect } } }),
    db().lead.findMany({
      where: { OR: [{ priority: 'insufficient_data' }, { company: { website: { status: 'unreachable' } } }], stage: { notIn: ['won', 'lost'] } },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      select: { ...leadSelect, company: { select: { ...leadSelect.company.select, discrepancies: true } } },
    }),
  ]);
  const withConflicts = await db().company.findMany({ where: { lead: { isNot: null } }, select: { id: true, discrepancies: true, lead: { select: { id: true } } } });
  const conflictLeadIds = withConflicts.filter((c) => jsonArray(c.discrepancies).length > 0 && c.lead).map((c) => c.lead!.id);

  const actions: RecommendedAction[] = [];
  const overdue = followUps.filter((f) => f.dueAt < new Date(now.getTime() - 60_000));
  if (overdue.length) {
    actions.push({ id: 'overdue_followups', title: `${overdue.length} follow-up(s) overdue`, detail: `Oldest: ${overdue[0]!.lead.company.name} (due ${overdue[0]!.dueAt.toISOString().slice(0, 10)}).`, count: overdue.length, leadIds: overdue.map((f) => f.leadId), link: '/crm?view=followups', urgency: 'high' });
  }
  const staleReplies = replies.filter((l) => now.getTime() - l.stageChangedAt.getTime() > DAY);
  if (staleReplies.length) {
    actions.push({ id: 'answer_replies', title: `${staleReplies.length} repl${staleReplies.length === 1 ? 'y' : 'ies'} waiting over 24h`, detail: staleReplies.slice(0, 3).map((l) => l.company.name).join(', '), count: staleReplies.length, leadIds: staleReplies.map((l) => l.id), link: '/crm?stage=replied', urgency: 'high' });
  }
  const readyNoDraft = await db().lead.findMany({ where: { stage: 'contact_ready', priority: { in: ['very_high', 'high'] }, outreach: { none: {} } }, select: { id: true, company: { select: { name: true } } }, take: 50 });
  if (readyNoDraft.length) {
    actions.push({ id: 'draft_outreach', title: `${readyNoDraft.length} high-priority lead(s) ready but without an outreach draft`, detail: readyNoDraft.slice(0, 3).map((l) => l.company.name).join(', '), count: readyNoDraft.length, leadIds: readyNoDraft.map((l) => l.id), link: '/leads?stage=contact_ready&priority=high', urgency: 'medium' });
  }
  const staleProposals = proposals.filter((l) => now.getTime() - l.stageChangedAt.getTime() > 7 * DAY);
  if (staleProposals.length) {
    const withFollowUp = new Set((await db().followUp.findMany({ where: { status: 'pending', leadId: { in: staleProposals.map((l) => l.id) } }, select: { leadId: true } })).map((f) => f.leadId));
    const noFu = staleProposals.filter((l) => !withFollowUp.has(l.id));
    if (noFu.length) actions.push({ id: 'proposal_followups', title: `${noFu.length} proposal(s) older than 7 days with no follow-up scheduled`, detail: noFu.slice(0, 3).map((l) => l.company.name).join(', '), count: noFu.length, leadIds: noFu.map((l) => l.id), link: '/crm?stage=proposal', urgency: 'medium' });
  }
  const contactedNoOutcome = await db().lead.findMany({ where: { stage: 'contacted', contactedAt: { lte: new Date(now.getTime() - 14 * DAY) }, outcomes: { none: {} } }, select: { id: true }, take: 200 });
  if (contactedNoOutcome.length) {
    actions.push({ id: 'record_outcomes', title: `${contactedNoOutcome.length} lead(s) contacted 14+ days ago with no recorded result`, detail: 'Mark “No reply” or the actual outcome so priority and the learning model improve.', count: contactedNoOutcome.length, leadIds: contactedNoOutcome.map((l) => l.id), link: '/crm?stage=contacted', urgency: 'low' });
  }
  const reviewIds = [...new Set([...review.map((l) => l.id), ...conflictLeadIds])];
  const extra = conflictLeadIds.filter((id) => !review.some((l) => l.id === id)).slice(0, 20);
  if (extra.length) {
    const more = await db().lead.findMany({ where: { id: { in: extra }, stage: { notIn: ['won', 'lost'] } }, select: { ...leadSelect, company: { select: { ...leadSelect.company.select, discrepancies: true } } } });
    review.push(...more);
  }
  if (reviewIds.length) {
    actions.push({ id: 'review_leads', title: `${reviewIds.length} lead(s) need review`, detail: 'Insufficient data, unreachable websites or conflicting source data.', count: reviewIds.length, leadIds: reviewIds.slice(0, 100), link: '/leads?review=1', urgency: 'low' });
  }
  const saved = await db().savedSearch.findMany({ orderBy: { lastRunAt: 'asc' }, take: 20 });
  const staleSaved = saved.filter((s) => s.lastRunAt && now.getTime() - s.lastRunAt.getTime() > 14 * DAY);
  if (staleSaved.length) {
    actions.push({ id: 'rerun_saved', title: `${staleSaved.length} saved search(es) not run for 14+ days`, detail: staleSaved.slice(0, 3).map((s) => s.name).join(', '), count: staleSaved.length, leadIds: [], link: '/saved', urgency: 'low' });
  }
  const labelled = await db().lead.count({ where: { contactedAt: { not: null }, outcomes: { some: {} } } });
  const learning = { labelledOutcomes: labelled, needed: MIN_SAMPLES };

  return {
    date: now.toISOString().slice(0, 10),
    newBestLeads: newBest,
    followUpsDue: followUps.map((f) => ({ id: f.id, dueAt: f.dueAt, note: f.note, channel: f.channel, overdue: f.dueAt < now, lead: f.lead })),
    replies,
    meetings,
    proposals,
    recentlyWon: wonOutcomes.map((o) => ({ id: o.id, recordedAt: o.recordedAt, dealValue: o.dealValue, lead: o.lead })),
    needsReview: review,
    recommendedActions: actions,
    learning,
  };
}
