import type { Prisma } from '@prisma/client';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { loadConfig } from '../../config/env.js';
import { db } from '../../db/client.js';
import type { FindingDraft } from '../../domain/types.js';
import { errorMessage, sha256 } from '../../lib/misc.js';
import { registrableDomain } from '../../lib/url.js';
import type { AiProvider } from '../../providers/types.js';
import { analyzeWebsite, ANALYZER_VERSION } from '../../providers/website/analyzer.js';
import type { AnalyzerRaw } from '../../providers/website/types.js';
import { contactsFromAnalysis } from '../contacts/contact-discovery.js';
import { storeContacts } from '../contacts/contact-store.js';
import { buildFindings, techSummary } from './checks.js';
import { runVisualAnalysis } from './visual-ai.js';
import { runLighthouseIfEnabled } from './lighthouse.js';

/**
 * Runs a live analysis for a company's website and persists it as a historical snapshot
 * (Analysis + Findings + Screenshots), then diffs it against the previous snapshot.
 */

export interface AnalysisOutcome {
  analysisId: string | null;
  status: string;
  findings: number;
  skipped?: string;
}

export function summarizeMetrics(raw: AnalyzerRaw): Record<string, unknown> {
  const d = raw.runs.desktop;
  const m = raw.runs.mobile;
  const net = d?.network ?? [];
  const sum = (t?: string) => net.filter((n) => !t || n.type === t).reduce((s, n) => s + n.bytes, 0);
  return {
    note: 'Lab measurements from a single load by the analyser (not Lighthouse, not field data).',
    desktop: d?.snapshot
      ? {
          lcpMs: d.snapshot.perf.lcp,
          cls: d.snapshot.perf.cls,
          ttfbMs: d.snapshot.perf.ttfb,
          loadMs: d.snapshot.perf.load,
          requests: net.length,
          transferKB: Math.round(sum() / 1024),
          jsKB: Math.round(sum('script') / 1024),
          imageKB: Math.round(sum('image') / 1024),
          cssKB: Math.round(sum('stylesheet') / 1024),
          fontKB: Math.round(sum('font') / 1024),
          thirdPartyKB: Math.round(net.filter((n) => n.thirdParty).reduce((s, n) => s + n.bytes, 0) / 1024),
          longTasks: d.snapshot.perf.longTasks,
        }
      : null,
    mobile: m?.snapshot ? { lcpMs: m.snapshot.perf.lcp, cls: m.snapshot.perf.cls, requests: m.network.length, transferKB: Math.round(m.network.reduce((s, n) => s + n.bytes, 0) / 1024) } : null,
  };
}

/** Structural fingerprint of the homepage: changes a lot when a site is redesigned. */
export function contentHash(raw: AnalyzerRaw): string | null {
  const s = raw.runs.desktop?.snapshot;
  if (!s) return null;
  const nav = s.links.filter((l) => l.inNav).map((l) => l.text).slice(0, 20).join('|');
  const heads = s.headings.slice(0, 15).map((h) => `${h.level}:${h.text}`).join('|');
  const scripts = s.scripts.filter((x) => x.src).map((x) => (x.src ?? '').split('?')[0]!.split('/').pop()).slice(0, 15).join('|');
  return sha256(`${nav}#${heads}#${scripts}#${techSummary(raw).platform}`);
}

export function diffAnalyses(prev: { fingerprintCodes: string[]; contentHash: string | null; platform: string | null; at: Date }, cur: { fingerprintCodes: string[]; contentHash: string | null; platform: string | null }) {
  const prevSet = new Set(prev.fingerprintCodes);
  const curSet = new Set(cur.fingerprintCodes);
  const fixed = [...prevSet].filter((c) => !curSet.has(c));
  const added = [...curSet].filter((c) => !prevSet.has(c));
  const structureChanged = !!prev.contentHash && !!cur.contentHash && prev.contentHash !== cur.contentHash;
  const platformChanged = !!prev.platform && !!cur.platform && prev.platform !== cur.platform;
  const churn = prevSet.size + curSet.size > 0 ? (fixed.length + added.length) / (prevSet.size + curSet.size) : 0;
  const redesignSuspected = platformChanged || (structureChanged && churn > 0.5);
  return {
    previousAt: prev.at.toISOString(),
    fixed,
    added,
    unchanged: [...curSet].filter((c) => prevSet.has(c)).length,
    structureChanged,
    platformChanged,
    redesignSuspected,
    note: redesignSuspected ? 'Navigation/heading structure or platform changed substantially since the previous snapshot — the site may have been redesigned.' : undefined,
  };
}

export async function analyzeCompanyWebsite(
  companyId: string,
  opts: { ai: AiProvider; visualAi: boolean; searchJobId?: string; log: Logger; signal?: AbortSignal },
): Promise<AnalysisOutcome> {
  const cfg = loadConfig();
  const company = await db().company.findUnique({ where: { id: companyId }, include: { website: true } });
  const website = company?.website;
  if (!company || !website?.url || website.status === 'not_found') return { analysisId: null, status: 'skipped', findings: 0, skipped: 'no website' };

  const analysis = await db().analysis.create({
    data: {
      websiteId: website.id,
      companyId,
      searchJobId: opts.searchJobId,
      analyzerVersion: ANALYZER_VERSION,
      status: 'running',
      url: website.url,
      redirectChain: [],
      pagesVisited: [],
      metrics: {},
      tech: {},
      summary: {},
      contactsFound: [],
      errors: [],
    },
  });
  const screenshotRoot = join(cfg.DATA_DIR, 'screenshots');
  let raw: AnalyzerRaw;
  try {
    raw = await analyzeWebsite(website.url, { analysisId: analysis.id, signal: opts.signal, screenshotDir: screenshotRoot });
  } catch (e) {
    await db().analysis.update({ where: { id: analysis.id }, data: { status: 'failed', errors: [errorMessage(e)], finishedAt: new Date() } });
    opts.log.warn({ companyId, url: website.url, error: errorMessage(e) }, 'analysis failed');
    return { analysisId: analysis.id, status: 'failed', findings: 0 };
  }

  const drafts: FindingDraft[] = buildFindings(raw);
  const screenshots = Object.values(raw.runs).flatMap((r) => r?.screenshots ?? []);

  // AI visual analysis — optional; failure never discards the technical analysis.
  const visual = await runVisualAnalysis({
    ai: opts.ai,
    enabled: opts.visualAi && cfg.AI_VISUAL_ANALYSIS,
    screenshots,
    screenshotDir: join(screenshotRoot, analysis.id),
    context: { companyName: company.name, industry: company.industry, url: raw.finalUrl ?? website.url, codeFindingTitles: drafts.filter((f) => f.polarity === 'negative').map((f) => f.title) },
    log: opts.log,
    signal: opts.signal,
  });
  drafts.push(...visual.findings);

  const lighthouse = raw.status === 'completed' || raw.status === 'partial' ? await runLighthouseIfEnabled(raw.finalUrl ?? website.url, opts.log) : null;

  // Persist screenshots and map evidence keys → ids.
  const keyToId = new Map<string, string>();
  for (const s of screenshots) {
    const row = await db().screenshot.create({
      data: { analysisId: analysis.id, pageUrl: s.pageUrl, viewport: s.viewport, kind: s.kind, path: `${analysis.id}/${s.path}`, width: s.width, height: s.height, bytes: s.bytes, sha256: s.sha256 },
    });
    keyToId.set(s.key, row.id);
  }
  const now = new Date();
  await db().finding.createMany({
    data: drafts.map((f) => ({
      analysisId: analysis.id,
      companyId,
      code: f.code,
      category: f.category,
      polarity: f.polarity,
      severity: f.severity,
      kind: f.kind,
      source: f.source,
      title: f.title.slice(0, 300),
      detail: f.detail.slice(0, 2000),
      evidence: f.evidence.map((e) => (e.type === 'screenshot' && e.ref ? { ...e, ref: keyToId.get(e.ref) ?? e.ref, key: e.ref } : e)) as unknown as Prisma.InputJsonValue,
      pageUrl: f.pageUrl ?? raw.finalUrl ?? website.url,
      viewport: f.viewport,
      confidence: f.confidence,
      problemTags: f.problemTags,
      detectedAt: now,
    })),
  });

  // Contacts published on the official site.
  const contactObs = contactsFromAnalysis(raw, company.country);
  await storeContacts(companyId, contactObs, registrableDomain(raw.finalUrl ?? website.url));

  // History: diff against the previous completed snapshot.
  const tech = techSummary(raw);
  const codes = drafts.filter((f) => f.polarity === 'negative' && f.source === 'code').map((f) => f.code).sort();
  const hash = contentHash(raw);
  const prev = await db().analysis.findFirst({
    where: { websiteId: website.id, id: { not: analysis.id }, status: { in: ['completed', 'partial'] } },
    orderBy: { startedAt: 'desc' },
    include: { findings: { where: { polarity: 'negative', source: 'code' }, select: { code: true } } },
  });
  const diff = prev
    ? diffAnalyses(
        { fingerprintCodes: prev.findings.map((f) => f.code), contentHash: prev.contentHash, platform: (prev.tech as { platform?: string } | null)?.platform ?? null, at: prev.startedAt },
        { fingerprintCodes: codes, contentHash: hash, platform: tech.platform },
      )
    : null;

  const negative = drafts.filter((f) => f.polarity === 'negative');
  const byCategory: Record<string, number> = {};
  for (const f of negative) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  const status = raw.status === 'robots_disallowed' ? 'robots_disallowed' : raw.status;
  await db().analysis.update({
    where: { id: analysis.id },
    data: {
      status,
      finalUrl: raw.finalUrl,
      httpStatus: raw.http.homepageStatus,
      redirectChain: raw.http.redirectChain as unknown as Prisma.InputJsonValue,
      pagesVisited: [{ url: raw.finalUrl ?? website.url, kind: 'home' }, ...raw.pages.map((p) => ({ url: p.url, kind: p.kind, ok: p.ok, status: p.status }))] as unknown as Prisma.InputJsonValue,
      metrics: summarizeMetrics(raw) as Prisma.InputJsonValue,
      tech: tech as unknown as Prisma.InputJsonValue,
      summary: {
        negative: negative.length,
        positive: drafts.filter((f) => f.polarity === 'positive').length,
        aiObservations: visual.findings.length,
        byCategory,
        linksChecked: raw.links.length,
        http: { httpsOk: raw.http.httpsOk, hsts: raw.http.hsts, robots: raw.http.robots, sitemap: raw.http.sitemap, soft404: raw.http.soft404, headers: raw.http.headers },
        viewports: Object.fromEntries(Object.entries(raw.runs).map(([k, r]) => [k, { ok: r?.ok, error: r?.error, durationMs: r?.durationMs, blockedRequests: r?.blockedRequests.length }])),
        visualOverall: visual.overall ?? null,
      } as Prisma.InputJsonValue,
      contactsFound: contactObs.map((c) => ({ type: c.type, value: c.value, sourceUrl: c.sourceUrl, label: c.label })) as unknown as Prisma.InputJsonValue,
      errors: [...raw.errors, ...(visual.error ? [`AI visual analysis: ${visual.error}`] : [])],
      aiStatus: visual.status,
      aiModel: visual.model,
      lighthouse: (lighthouse ?? undefined) as Prisma.InputJsonValue | undefined,
      fingerprint: sha256(codes.join(',')),
      contentHash: hash,
      diff: (diff ?? undefined) as Prisma.InputJsonValue | undefined,
      finishedAt: new Date(),
    },
  });
  await db().website.update({
    where: { id: website.id },
    data: {
      lastAnalyzedAt: new Date(),
      lastCheckedAt: new Date(),
      httpStatus: raw.http.homepageStatus,
      finalUrl: raw.finalUrl,
      platform: tech.platform,
      status: status === 'unreachable' ? 'unreachable' : 'found',
    },
  });
  await db().company.update({ where: { id: companyId }, data: { lastVerifiedAt: status === 'unreachable' ? undefined : new Date() } });
  opts.log.info({ companyId, url: website.url, status, findings: drafts.length, ai: visual.status }, 'analysis stored');
  return { analysisId: analysis.id, status, findings: drafts.length };
}
