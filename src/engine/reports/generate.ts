import type { Prisma } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { loadConfig } from '../../config/env.js';
import { db } from '../../db/client.js';
import type { DecisionIntel, EvidenceItem, PortfolioMatchResult, Priority, ProblemTag } from '../../domain/types.js';
import { jsonArray, jsonObject } from '../../lib/misc.js';
import type { AiProvider } from '../../providers/types.js';
import { activeServices, businessProfile } from '../defaults.js';
import { latestAnalysis } from '../qualify/qualify-lead.js';
import { aiPolishAudit, auditToHtml, auditToMarkdown, buildAudit, type AuditContent } from './audit.js';
import { aiOutreach, templateOutreach, type OutreachDraft, type OutreachFacts, type Tone } from './outreach.js';
import { langFor } from './phrases.js';
import { resolveNiche } from '../strategy/strategy-engine.js';

/** Loads a lead's evidence from the DB and produces an Audit or Outreach draft. */

async function leadBundle(leadId: string) {
  const lead = await db().lead.findUnique({
    where: { id: leadId },
    include: { company: { include: { website: true, contacts: true } }, recommendations: true },
  });
  if (!lead) throw new Error('lead not found');
  const analysis = lead.company.website ? await latestAnalysis(lead.company.website.id) : null;
  return { lead, analysis };
}

function countryLanguage(country: string | null): string | null {
  const c = (country ?? '').toLowerCase();
  if (/^(pl|poland|polska)/.test(c)) return 'pl';
  if (/^(de|at|germany|austria|deutschland|österreich)/.test(c)) return 'de';
  if (/^(ua|ukraine|україна)/.test(c)) return 'uk';
  return null;
}

export async function generateAuditForLead(leadId: string, opts: { ai?: AiProvider | null; language?: string; log: Logger }): Promise<{ id: string; content: AuditContent }> {
  const { lead, analysis } = await leadBundle(leadId);
  const services = await activeServices();
  const profile = await businessProfile();
  const nameOf = (slug: string | null) => services.find((s) => s.slug === slug)?.name ?? slug ?? '';
  const recs = lead.recommendations;
  const toSvc = (kind: string) => {
    const r = recs.find((x) => x.kind === kind);
    return r ? { name: nameOf(r.serviceSlug), slug: r.serviceSlug, reasons: jsonArray<{ text: string }>(r.reasons).map((x) => x.text) } : null;
  };
  const decision = jsonObject<Partial<DecisionIntel>>(lead.decision, {});
  const language = opts.language ?? countryLanguage(lead.company.country) ?? profile.communicationLanguage ?? 'en';
  let content = buildAudit({
    company: { name: lead.company.name, website: lead.company.website?.url ?? null, city: lead.company.city, industry: lead.company.industry },
    analysis: analysis ? { at: analysis.finishedAt, pages: jsonArray(analysis.pagesVisited).length || 1, lighthouseRan: !!analysis.lighthouse, aiStatus: analysis.aiStatus, status: analysis.status } : null,
    websiteStatus: lead.company.website?.status ?? 'none',
    findings: (analysis?.findings ?? []).map((f) => ({
      findingId: f.id,
      title: f.title,
      detail: f.detail,
      category: f.category,
      severity: f.severity,
      kind: f.kind,
      confidence: f.confidence,
      evidence: jsonArray<EvidenceItem>(f.evidence),
      pageUrl: f.pageUrl,
      viewport: f.viewport,
      problemTags: jsonArray<ProblemTag>(f.problemTags),
      polarity: f.polarity,
    })),
    services: { primary: toSvc('primary'), secondary: toSvc('secondary'), doNot: recs.filter((r) => r.kind === 'do_not_recommend').map((r) => ({ name: nameOf(r.serviceSlug), reasons: jsonArray<string>(r.exclusionReasons) })) },
    priority: { level: (lead.priority ?? 'insufficient_data') as Priority, reasons: jsonArray<string>(lead.priorityReasons) },
    interpretations: [decision.mainPainPoint, decision.secondaryPainPoint].filter((p): p is NonNullable<typeof p> => !!p).map((p) => `${p.title}: ${p.interpretation}`),
    screenshots: (analysis?.screenshots ?? []).map((s) => ({ id: s.id, viewport: s.viewport, kind: s.kind })),
    language,
  });
  if (opts.ai?.isConfigured()) {
    try {
      content = await aiPolishAudit(opts.ai, content, opts.log);
    } catch (e) {
      opts.log.warn({ leadId, error: (e as Error).message }, 'AI audit polish failed; template audit kept');
    }
  }
  const row = await db().audit.create({
    data: { leadId, analysisId: analysis?.id, generator: content.generator, aiModel: content.generator === 'ai' ? opts.ai?.model : null, content: content as unknown as Prisma.InputJsonValue, markdown: auditToMarkdown(content) },
  });
  await db().activity.create({ data: { leadId, type: 'audit_generated', summary: `Audit generated (${content.generator})`, actor: 'system', data: { auditId: row.id } } });
  return { id: row.id, content };
}

/** HTML for export/PDF with screenshots embedded as data URIs. */
export async function renderAuditHtml(auditId: string, opts: { internal?: boolean } = {}): Promise<string> {
  const audit = await db().audit.findUnique({ where: { id: auditId } });
  if (!audit) throw new Error('audit not found');
  const content = audit.content as unknown as AuditContent;
  const images: Record<string, string> = {};
  if (content.screenshots.length) {
    const shots = await db().screenshot.findMany({ where: { id: { in: content.screenshots.map((s) => s.id) } } });
    const root = join(loadConfig().DATA_DIR, 'screenshots');
    for (const s of shots) {
      try {
        const buf = await readFile(join(root, s.path));
        images[s.id] = `data:image/jpeg;base64,${buf.toString('base64')}`;
      } catch {
        // screenshot file missing (e.g. data dir pruned) — render without it
      }
    }
  }
  return auditToHtml(content, images, opts);
}

export async function generateOutreachForLead(
  leadId: string,
  opts: { tone: Tone; language?: string; channel?: string; useAi?: boolean; ai?: AiProvider | null; contactName?: string | null; log: Logger },
): Promise<{ id: string; draft: OutreachDraft }> {
  const { lead, analysis } = await leadBundle(leadId);
  const profile = await businessProfile();
  const services = await activeServices();
  const primary = lead.recommendations.find((r) => r.kind === 'primary');
  const decision = jsonObject<Partial<DecisionIntel>>(lead.decision, {});
  const mentionIds = new Set((decision.whatToMention ?? []).map((m) => m.findingId));
  const all = (analysis?.findings ?? []).filter((f) => f.polarity === 'negative' && f.kind !== 'ai_observation' && f.confidence !== 'low');
  const sev: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
  const ordered = [...all.filter((f) => mentionIds.has(f.id)), ...all.filter((f) => !mentionIds.has(f.id)).sort((a, b) => (sev[b.severity] ?? 0) - (sev[a.severity] ?? 0))];
  const portfolio = jsonObject<{ best?: PortfolioMatchResult | null }>(lead.portfolioMatch, {}).best ?? null;
  const language = opts.language ?? countryLanguage(lead.company.country) ?? profile.communicationLanguage ?? 'en';
  const niche = resolveNiche(lead.company.industry ?? '').def;
  const lang2 = langFor(language);
  // Client-facing industry wording must be in the message language; otherwise leave it out.
  const industry = niche ? (lang2 === 'en' ? niche.label.toLowerCase() : niche.labels?.[lang2] ?? null) : lang2 === 'en' ? lead.company.industry : null;
  const facts: OutreachFacts = {
    company: lead.company.name,
    industry,
    city: lead.company.city,
    website: lead.company.website?.url ?? null,
    contactName: opts.contactName ?? null,
    hasWebsite: lead.company.website?.status !== 'not_found',
    observations: ordered.slice(0, 5).map((f) => ({
      findingId: f.id,
      code: f.code,
      title: f.title,
      detail: f.detail,
      vars: f.code === 'visual.copyright_old' ? { year: f.title.match(/(19|20)\d{2}/)?.[0] ?? '' } : undefined,
    })),
    service: primary ? { slug: primary.serviceSlug, name: services.find((s) => s.slug === primary.serviceSlug)?.name ?? primary.serviceSlug } : null,
    portfolio: portfolio ? { name: portfolio.name, url: portfolio.url, reason: portfolio.reasons.join(', ') } : null,
    sender: { name: profile.senderName, studio: profile.studioName, website: profile.website, role: profile.senderRole },
  };
  let draft: OutreachDraft;
  if (opts.useAi && opts.ai?.isConfigured()) {
    try {
      draft = await aiOutreach(opts.ai, facts, opts.tone, language, opts.log);
      if (draft.lint.some((l) => l.level === 'error')) {
        const fallback = templateOutreach(facts, opts.tone, language);
        fallback.note = `AI draft violated rules (${draft.lint.filter((l) => l.level === 'error').map((l) => l.rule).join(', ')}); template draft used instead.`;
        draft = fallback;
      }
    } catch (e) {
      draft = templateOutreach(facts, opts.tone, language);
      draft.note = `AI unavailable (${(e as Error).message}); template draft used.`;
    }
  } else {
    draft = templateOutreach(facts, opts.tone, langFor(language));
  }
  const row = await db().outreach.create({
    data: {
      leadId,
      channel: opts.channel ?? 'email',
      tone: opts.tone,
      language: draft.language,
      subject: draft.subject,
      body: draft.body,
      generator: draft.generator,
      aiModel: draft.aiModel,
      usedFindingIds: draft.usedFindingIds,
      portfolioProjectId: draft.portfolioUsed ? portfolio?.projectId : null,
      lintWarnings: draft.lint as unknown as Prisma.InputJsonValue,
    },
  });
  await db().activity.create({ data: { leadId, type: 'outreach_drafted', summary: `Outreach draft (${draft.tone}, ${draft.language}, ${draft.generator})`, actor: 'system', data: { outreachId: row.id } } });
  return { id: row.id, draft };
}
