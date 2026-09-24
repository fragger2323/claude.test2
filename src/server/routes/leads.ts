import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../../config/env.js';
import { db } from '../../db/client.js';
import { CRM_STAGES, OUTCOME_STAGE, OUTCOME_TYPES, PRIORITIES, type CrmStage } from '../../domain/types.js';
import { isValidEmailSyntax } from '../../engine/contacts/email.js';
import { captureContactedFeatures, qualifyLead } from '../../engine/qualify/qualify-lead.js';
import { renderAuditHtml, generateAuditForLead, generateOutreachForLead } from '../../engine/reports/generate.js';
import { auditToMarkdown, type AuditContent } from '../../engine/reports/audit.js';
import { lintOutreach } from '../../engine/reports/lint.js';
import { TONES } from '../../engine/reports/outreach.js';
import { enqueueJob } from '../../jobs/queue.js';
import { toCsv } from '../../lib/csv.js';
import { jsonArray } from '../../lib/misc.js';
import { normalizePhone } from '../../lib/phone.js';
import { normalizeName } from '../../lib/text.js';
import { normalizeUrl } from '../../lib/url.js';
import { buildProviderRegistry } from '../../providers/registry.js';
import { browserPool } from '../../providers/website/browser-pool.js';
import { assertId, HttpProblem, notFound, parseBody, reqLog } from '../validation.js';
import { leadRow } from './search.js';

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  priority: z.string().max(100).optional(),
  stage: z.string().max(200).optional(),
  industry: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  service: z.string().max(100).optional(),
  websiteStatus: z.enum(['found', 'not_found', 'unreachable']).optional(),
  contact: z.enum(['email', 'form', 'phone', 'social', 'none', 'any']).optional(),
  source: z.string().max(40).optional(),
  campaignId: z.string().max(40).optional(),
  freshness: z.enum(['fresh', 'recent', 'stale']).optional(),
  minWebsiteNeed: z.coerce.number().min(0).max(100).optional(),
  review: z.coerce.boolean().optional(),
  sort: z.enum(['priority', 'freshness', 'websiteNeed', 'contactability', 'leadFit', 'created', 'company']).default('priority'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

type ListQuery = z.infer<typeof listQuery>;

function buildWhere(q: ListQuery): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = [];
  if (q.q) and.push({ company: { OR: [{ normalizedName: { contains: normalizeName(q.q) } }, { primaryDomain: { contains: q.q.toLowerCase() } }] } });
  if (q.priority) and.push({ priority: { in: q.priority.split(',').filter((p) => (PRIORITIES as readonly string[]).includes(p)) } });
  if (q.stage) and.push({ stage: { in: q.stage.split(',').filter((s) => (CRM_STAGES as readonly string[]).includes(s)) } });
  if (q.industry) and.push({ company: { industry: q.industry } });
  if (q.city) and.push({ company: { city: q.city } });
  if (q.service) and.push({ primaryServiceSlug: q.service });
  if (q.websiteStatus) and.push({ company: { website: { status: q.websiteStatus } } });
  if (q.contact === 'any') and.push({ contactAvailability: { in: ['email', 'form', 'phone', 'social'] } });
  else if (q.contact) and.push({ contactAvailability: q.contact });
  if (q.source) and.push({ company: { sourceRecords: { some: { provider: q.source } } } });
  if (q.campaignId) and.push({ campaignLeads: { some: { campaignId: q.campaignId } } });
  if (q.freshness === 'fresh') and.push({ freshness: { gte: 85 } });
  if (q.freshness === 'recent') and.push({ freshness: { gte: 40, lt: 85 } });
  if (q.freshness === 'stale') and.push({ freshness: { lt: 40 } });
  if (q.minWebsiteNeed != null) and.push({ websiteNeed: { gte: q.minWebsiteNeed } });
  if (q.review) and.push({ OR: [{ priority: 'insufficient_data' }, { company: { website: { status: 'unreachable' } } }] });
  return and.length ? { AND: and } : {};
}

function orderBy(q: ListQuery): Prisma.LeadOrderByWithRelationInput[] {
  const d = q.dir;
  switch (q.sort) {
    case 'freshness':
      return [{ freshness: d }, { priorityRank: 'desc' }];
    case 'websiteNeed':
      return [{ websiteNeed: d }, { priorityRank: 'desc' }];
    case 'contactability':
      return [{ contactability: d }, { priorityRank: 'desc' }];
    case 'leadFit':
      return [{ leadFit: d }];
    case 'created':
      return [{ createdAt: d }];
    case 'company':
      return [{ company: { name: d } }];
    default:
      return [{ priorityRank: d }, { leadFit: d }];
  }
}

const rowInclude = {
  company: {
    select: {
      id: true,
      name: true,
      city: true,
      country: true,
      industry: true,
      sources: true,
      lastVerifiedAt: true,
      website: { select: { url: true, status: true, platform: true, lastAnalyzedAt: true } },
      contacts: { where: { expiredAt: null }, select: { type: true, status: true } },
    },
  },
} as const;

async function setStage(leadId: string, stage: CrmStage, summary?: string) {
  const lead = await db().lead.findUnique({ where: { id: leadId } });
  if (!lead) notFound('Lead');
  if (lead.stage === stage) return lead;
  const data: Prisma.LeadUpdateInput = { stage, stageChangedAt: new Date() };
  if (stage === 'contacted' && !lead.contactedAt) {
    data.contactedAt = new Date();
    data.contactedFeatures = ((await captureContactedFeatures(leadId)) ?? undefined) as Prisma.InputJsonValue | undefined;
  }
  const updated = await db().lead.update({ where: { id: leadId }, data });
  await db().activity.create({ data: { leadId, type: 'stage_change', summary: summary ?? `Stage: ${lead.stage} → ${stage}`, data: { from: lead.stage, to: stage } } });
  return updated;
}

export function registerLeadRoutes(app: FastifyInstance): void {
  app.get('/api/leads', async (req) => {
    const q = parseBody(listQuery, req.query);
    const where = buildWhere(q);
    const [total, leads] = await Promise.all([
      db().lead.count({ where }),
      db().lead.findMany({ where, orderBy: orderBy(q), skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: rowInclude }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, rows: leads.map(leadRow) };
  });

  app.get('/api/leads/facets', async () => {
    const [industries, cities, services, sources] = await Promise.all([
      db().company.findMany({ where: { lead: { isNot: null }, industry: { not: null } }, select: { industry: true }, distinct: ['industry'] }),
      db().company.findMany({ where: { lead: { isNot: null }, city: { not: null } }, select: { city: true }, distinct: ['city'], take: 200 }),
      db().lead.findMany({ where: { primaryServiceSlug: { not: null } }, select: { primaryServiceSlug: true }, distinct: ['primaryServiceSlug'] }),
      db().sourceRecord.findMany({ select: { provider: true }, distinct: ['provider'] }),
    ]);
    return {
      industries: industries.map((i) => i.industry).filter(Boolean),
      cities: cities.map((c) => c.city).filter(Boolean),
      services: services.map((s) => s.primaryServiceSlug).filter(Boolean),
      sources: sources.map((s) => s.provider),
    };
  });

  app.get('/api/leads/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const lead = await db().lead.findUnique({
      where: { id },
      include: {
        company: {
          include: {
            website: true,
            locations: true,
            contacts: { orderBy: [{ status: 'asc' }, { type: 'asc' }] },
            sourceRecords: { select: { id: true, provider: true, providerRecordId: true, name: true, address: true, phone: true, website: true, email: true, profileUrl: true, businessStatus: true, rating: true, ratingCount: true, categories: true, fetchedAt: true, firstSeenAt: true, lastSeenAt: true, purgedAt: true, retentionExpiresAt: true } },
          },
        },
        recommendations: true,
        audits: { orderBy: { createdAt: 'desc' }, select: { id: true, generator: true, status: true, createdAt: true, analysisId: true } },
        outreach: { orderBy: { createdAt: 'desc' } },
        activities: { orderBy: { createdAt: 'desc' }, take: 100 },
        followUps: { orderBy: { dueAt: 'asc' } },
        outcomes: { orderBy: { recordedAt: 'desc' } },
        campaignLeads: { include: { campaign: { select: { id: true, name: true } } } },
      },
    });
    if (!lead) notFound('Lead');
    const analyses = lead.company.website
      ? await db().analysis.findMany({
          where: { websiteId: lead.company.website.id },
          orderBy: { startedAt: 'desc' },
          take: 12,
          select: { id: true, status: true, startedAt: true, finishedAt: true, aiStatus: true, diff: true, summary: true, fingerprint: true, analyzerVersion: true },
        })
      : [];
    const latestId = analyses.find((a) => ['completed', 'partial', 'unreachable', 'robots_disallowed'].includes(a.status))?.id;
    const latest = latestId ? await db().analysis.findUnique({ where: { id: latestId }, include: { findings: true, screenshots: true } }) : null;
    const services = await db().service.findMany({ select: { slug: true, name: true, priceMin: true, priceMax: true, currency: true } });
    return { lead, analyses, latestAnalysis: latest, services };
  });

  app.patch('/api/leads/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const body = parseBody(
      z.object({
        stage: z.enum(CRM_STAGES).optional(),
        notes: z.string().max(10_000).nullable().optional(),
        doNotContact: z.boolean().optional(),
        isExistingClient: z.boolean().optional(),
      }),
      req.body,
    );
    const lead = await db().lead.findUnique({ where: { id } });
    if (!lead) notFound('Lead');
    if (body.stage) await setStage(id, body.stage);
    if (body.notes !== undefined) await db().lead.update({ where: { id }, data: { notes: body.notes } });
    if (body.doNotContact !== undefined || body.isExistingClient !== undefined) {
      await db().company.update({ where: { id: lead.companyId }, data: { doNotContact: body.doNotContact, isExistingClient: body.isExistingClient } });
      await qualifyLead(id, { log: reqLog(req) });
    }
    return db().lead.findUnique({ where: { id } });
  });

  /**
   * Erase a lead and everything stored about its company (e.g. on a data-deletion request):
   * company, source records, website analyses, findings, screenshots (rows and files), contacts
   * and CRM history. A future search may rediscover the business from public sources.
   */
  app.delete('/api/leads/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const lead = await db().lead.findUnique({ where: { id }, select: { companyId: true } });
    if (!lead) notFound('Lead');
    const analyses = await db().analysis.findMany({ where: { companyId: lead.companyId }, select: { id: true } });
    const [records] = await db().$transaction([db().sourceRecord.deleteMany({ where: { companyId: lead.companyId } }), db().company.delete({ where: { id: lead.companyId } })]);
    const root = resolve(loadConfig().DATA_DIR, 'screenshots');
    for (const a of analyses) {
      const dir = resolve(join(root, a.id));
      if (dir.startsWith(root + sep)) await rm(dir, { recursive: true, force: true });
    }
    req.log.info({ leadId: id, sourceRecords: records.count, analyses: analyses.length }, 'lead and company data erased');
    return { ok: true, deleted: { sourceRecords: records.count, analyses: analyses.length } };
  });

  app.post('/api/leads/:id/analyze', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const body = parseBody(z.object({ visualAi: z.boolean().default(true) }), req.body);
    if (!(await db().lead.findUnique({ where: { id } }))) notFound('Lead');
    const job = await enqueueJob('analyze_lead', { leadId: id, visualAi: body.visualAi }, { priority: 2 });
    return { jobId: job.id };
  });

  app.get('/api/jobs/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const j = await db().job.findUnique({ where: { id }, select: { id: true, type: true, status: true, attempts: true, lastError: true, result: true, createdAt: true, finishedAt: true } });
    if (!j) notFound('Job');
    return j;
  });

  app.post('/api/leads/:id/requalify', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const r = await qualifyLead(id, { log: reqLog(req) });
    if (!r) notFound('Lead');
    return r;
  });

  app.post('/api/leads/bulk', async (req) => {
    const body = parseBody(z.object({ ids: z.array(z.string().max(40)).min(1).max(500), action: z.enum(['stage', 'analyze', 'requalify']), stage: z.enum(CRM_STAGES).optional() }), req.body);
    if (body.action === 'stage') {
      if (!body.stage) throw new HttpProblem(400, 'validation_error', 'stage required');
      for (const id of body.ids) await setStage(assertId(id), body.stage);
      return { updated: body.ids.length };
    }
    if (body.action === 'analyze') {
      for (const id of body.ids) await enqueueJob('analyze_lead', { leadId: assertId(id) });
      return { enqueued: body.ids.length };
    }
    const job = await enqueueJob('qualify_all', { leadIds: body.ids });
    return { jobId: job.id };
  });

  // ── audits ──
  app.post('/api/leads/:id/audit', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const body = parseBody(z.object({ ai: z.boolean().default(false), language: z.string().max(5).optional() }), req.body);
    const registry = body.ai ? await buildProviderRegistry() : null;
    const res = await generateAuditForLead(id, { ai: registry?.ai ?? null, language: body.language, log: reqLog(req) });
    return res;
  });

  app.get('/api/audits/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const a = await db().audit.findUnique({ where: { id } });
    if (!a) notFound('Audit');
    return a;
  });

  app.put('/api/audits/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const body = parseBody(z.object({ markdown: z.string().max(200_000), status: z.enum(['draft', 'final']).optional() }), req.body);
    return db().audit.update({ where: { id }, data: { markdown: body.markdown, status: body.status } });
  });

  app.get('/api/audits/:id/export', async (req, reply) => {
    const id = assertId((req.params as { id: string }).id);
    const { format, internal } = parseBody(z.object({ format: z.enum(['html', 'md', 'pdf', 'json']).default('html'), internal: z.coerce.boolean().default(false) }), req.query);
    const a = await db().audit.findUnique({ where: { id }, include: { lead: { include: { company: { select: { name: true } } } } } });
    if (!a) notFound('Audit');
    const base = a.lead.company.name.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60) || 'audit';
    if (format === 'json') return reply.header('content-disposition', `attachment; filename="${base}-audit.json"`).send(a.content);
    if (format === 'md') return reply.type('text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="${base}-audit.md"`).send(a.markdown || auditToMarkdown(a.content as unknown as AuditContent));
    const html = await renderAuditHtml(id, { internal });
    if (format === 'html') return reply.type('text/html; charset=utf-8').header('content-disposition', `attachment; filename="${base}-audit.html"`).header('content-security-policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'").send(html);
    // PDF via the same controlled browser pool (offline: no network access needed).
    const pdf = await browserPool().withContext({ javaScriptEnabled: false, offline: true }, async (ctx) => {
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      return page.pdf({ format: 'A4', margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' }, printBackground: true });
    });
    return reply.type('application/pdf').header('content-disposition', `attachment; filename="${base}-audit.pdf"`).send(pdf);
  });

  // ── outreach ──
  app.post('/api/leads/:id/outreach', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const body = parseBody(
      z.object({ tone: z.enum(TONES).default('professional'), language: z.string().max(5).optional(), channel: z.enum(['email', 'contact_form', 'linkedin', 'phone_script']).default('email'), useAi: z.boolean().default(false), contactName: z.string().trim().max(100).nullable().optional() }),
      req.body,
    );
    const registry = body.useAi ? await buildProviderRegistry() : null;
    return generateOutreachForLead(id, { tone: body.tone, language: body.language, channel: body.channel, useAi: body.useAi, ai: registry?.ai ?? null, contactName: body.contactName ?? null, log: reqLog(req) });
  });

  app.patch('/api/outreach/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const body = parseBody(z.object({ subject: z.string().max(300).nullable().optional(), body: z.string().max(10_000).optional(), status: z.enum(['draft', 'approved', 'discarded']).optional() }), req.body);
    const o = await db().outreach.findUnique({ where: { id }, include: { lead: { include: { company: { select: { name: true } } } } } });
    if (!o) notFound('Outreach');
    const subject = body.subject !== undefined ? body.subject : o.subject;
    const text = body.body ?? o.body;
    const lint = lintOutreach(subject, text, { companyName: o.lead.company.name, tone: o.tone });
    return db().outreach.update({ where: { id }, data: { subject, body: text, status: body.status, lintWarnings: lint as unknown as Prisma.InputJsonValue } });
  });

  /** The user sent the message themselves (mail client / form / phone). We only record it. */
  app.post('/api/outreach/:id/mark-sent', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const o = await db().outreach.findUnique({ where: { id } });
    if (!o) notFound('Outreach');
    await db().outreach.update({ where: { id }, data: { status: 'sent_manually', sentAt: new Date() } });
    await setStage(o.leadId, 'contacted', `Marked as contacted via ${o.channel}`);
    await db().activity.create({ data: { leadId: o.leadId, type: 'outreach_sent', summary: `Message sent manually (${o.channel})`, data: { outreachId: id } } });
    return { ok: true };
  });

  // ── activities, follow-ups, outcomes, contacts ──
  app.post('/api/leads/:id/activities', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const body = parseBody(z.object({ type: z.enum(['note', 'call', 'email_sent', 'email_received', 'meeting', 'other']), summary: z.string().trim().min(1).max(2000) }), req.body);
    if (!(await db().lead.findUnique({ where: { id } }))) notFound('Lead');
    return db().activity.create({ data: { leadId: id, type: body.type, summary: body.summary } });
  });

  app.post('/api/leads/:id/followups', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const body = parseBody(z.object({ dueAt: z.coerce.date(), note: z.string().max(1000).optional(), channel: z.string().max(40).optional() }), req.body);
    if (!(await db().lead.findUnique({ where: { id } }))) notFound('Lead');
    const f = await db().followUp.create({ data: { leadId: id, dueAt: body.dueAt, note: body.note, channel: body.channel } });
    await refreshNextFollowUp(id);
    await db().activity.create({ data: { leadId: id, type: 'followup_scheduled', summary: `Follow-up scheduled for ${body.dueAt.toISOString().slice(0, 10)}` } });
    return f;
  });

  app.patch('/api/followups/:id', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const body = parseBody(z.object({ status: z.enum(['pending', 'done', 'skipped']).optional(), dueAt: z.coerce.date().optional(), note: z.string().max(1000).optional() }), req.body);
    const f = await db().followUp.update({ where: { id }, data: { status: body.status, dueAt: body.dueAt, note: body.note, completedAt: body.status === 'done' ? new Date() : undefined } });
    await refreshNextFollowUp(f.leadId);
    if (body.status === 'done') await db().activity.create({ data: { leadId: f.leadId, type: 'followup_done', summary: `Follow-up done${f.note ? `: ${f.note}` : ''}` } });
    return f;
  });

  app.get('/api/followups', async (req) => {
    const q = parseBody(z.object({ status: z.enum(['pending', 'done', 'skipped']).default('pending'), dueBefore: z.coerce.date().optional() }), req.query);
    return db().followUp.findMany({ where: { status: q.status, ...(q.dueBefore ? { dueAt: { lte: q.dueBefore } } : {}) }, orderBy: { dueAt: 'asc' }, take: 200, include: { lead: { select: { id: true, stage: true, priority: true, company: { select: { name: true, city: true } } } } } });
  });

  app.post('/api/leads/:id/outcomes', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const body = parseBody(z.object({ type: z.enum(OUTCOME_TYPES), dealValue: z.number().int().min(0).max(10_000_000).optional(), serviceSlug: z.string().max(80).optional(), notes: z.string().max(2000).optional() }), req.body);
    const lead = await db().lead.findUnique({ where: { id } });
    if (!lead) notFound('Lead');
    // Learning needs the contact-time snapshot; capture it now if the lead was never marked contacted.
    if (!lead.contactedAt) await setStage(id, 'contacted', 'Marked contacted (outcome recorded)');
    const refreshed = await db().lead.findUnique({ where: { id } });
    const outcome = await db().outcome.create({ data: { leadId: id, type: body.type, dealValue: body.dealValue, serviceSlug: body.serviceSlug ?? lead.primaryServiceSlug, notes: body.notes, features: (refreshed?.contactedFeatures ?? undefined) as Prisma.InputJsonValue | undefined } });
    const stage = OUTCOME_STAGE[body.type];
    if (stage) await setStage(id, stage, `Outcome: ${body.type}`);
    await db().activity.create({ data: { leadId: id, type: 'outcome', summary: `Outcome recorded: ${body.type}${body.dealValue ? ` (${body.dealValue})` : ''}`, data: { outcomeId: outcome.id } } });
    return outcome;
  });

  app.post('/api/leads/:id/contacts', async (req) => {
    const id = assertId((req.params as { id: string }).id);
    const body = parseBody(z.object({ type: z.enum(['email', 'phone', 'contact_form', 'social']), value: z.string().trim().min(3).max(300), personName: z.string().max(100).optional(), role: z.string().max(100).optional(), sourceUrl: z.string().max(500).optional() }), req.body);
    const lead = await db().lead.findUnique({ where: { id }, include: { company: true } });
    if (!lead) notFound('Lead');
    let normalized = body.value.toLowerCase();
    if (body.type === 'email' && !isValidEmailSyntax(normalized)) throw new HttpProblem(400, 'invalid_email', 'Invalid e-mail');
    if (body.type === 'phone') {
      const p = normalizePhone(body.value, lead.company.country);
      if (!p?.valid) throw new HttpProblem(400, 'invalid_phone', 'Invalid phone number');
      normalized = p.e164;
    }
    if (body.type === 'contact_form' || body.type === 'social') normalized = normalizeUrl(body.value) ?? normalized;
    const sighting = [{ source: 'manual', sourceUrl: body.sourceUrl, observedAt: new Date().toISOString(), onOfficialSite: false }];
    return db().contact.upsert({
      where: { companyId_type_normalizedValue: { companyId: lead.companyId, type: body.type, normalizedValue: normalized } },
      create: { companyId: lead.companyId, type: body.type, value: body.value, normalizedValue: normalized, personName: body.personName, role: body.role, source: 'manual', sourceUrl: body.sourceUrl, status: 'probable', confidence: 'medium', label: 'added manually', sightings: sighting },
      update: { personName: body.personName, role: body.role },
    });
  });

  // ── export ──
  app.get('/api/export/leads', async (req, reply) => {
    const q = parseBody(listQuery.extend({ format: z.enum(['csv', 'json']).default('csv'), pageSize: z.coerce.number().int().min(1).max(5000).default(5000) }), req.query);
    const leads = await db().lead.findMany({
      where: buildWhere(q),
      orderBy: orderBy(q),
      take: q.pageSize,
      include: {
        company: { include: { website: true, contacts: { where: { expiredAt: null } } } },
        outreach: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    const ids = leads.map((l) => l.companyId);
    // detectedAt must be selected: Prisma splits large IN lists into chunks and merge-sorts on it.
    const findings = await db().finding.findMany({ where: { companyId: { in: ids }, polarity: 'negative' }, orderBy: { detectedAt: 'desc' }, select: { companyId: true, title: true, kind: true, detectedAt: true } });
    const byCompany = new Map<string, string[]>();
    for (const f of findings) byCompany.set(f.companyId, [...(byCompany.get(f.companyId) ?? []), `${f.kind === 'ai_observation' ? '[AI] ' : ''}${f.title}`]);
    const rows = leads.map((l) => ({
      company: l.company.name,
      industry: l.company.industry,
      city: l.company.city,
      country: l.company.country,
      website: l.company.website?.url ?? '',
      website_status: l.company.website?.status ?? '',
      emails: l.company.contacts.filter((c) => c.type === 'email').map((c) => `${c.value} (${c.status})`).join('; '),
      phones: l.company.contacts.filter((c) => c.type === 'phone').map((c) => `${c.value} (${c.status})`).join('; '),
      contact_forms: l.company.contacts.filter((c) => c.type === 'contact_form').map((c) => c.value).join('; '),
      priority: l.priority,
      lead_fit: l.leadFit,
      website_need: l.websiteNeed,
      recommended_service: l.primaryServiceSlug,
      main_opportunity: l.mainOpportunity,
      top_findings: (byCompany.get(l.companyId) ?? []).slice(0, 5).join(' | '),
      stage: l.stage,
      sources: jsonArray<string>(l.company.sources).join(', '),
      last_verified: l.company.lastVerifiedAt?.toISOString() ?? '',
      outreach_subject: l.outreach[0]?.subject ?? '',
      outreach_body: l.outreach[0]?.body ?? '',
    }));
    const stamp = new Date().toISOString().slice(0, 10);
    if (q.format === 'json') return reply.header('content-disposition', `attachment; filename="leads-${stamp}.json"`).send(rows);
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="leads-${stamp}.csv"`).send(`\uFEFF${toCsv(rows, Object.keys(rows[0] ?? { company: '' }))}`);
  });
}

async function refreshNextFollowUp(leadId: string): Promise<void> {
  const next = await db().followUp.findFirst({ where: { leadId, status: 'pending' }, orderBy: { dueAt: 'asc' } });
  await db().lead.update({ where: { id: leadId }, data: { nextFollowUpAt: next?.dueAt ?? null } });
}
