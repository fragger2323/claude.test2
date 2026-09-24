import { PROBLEM_TAG_LABELS, type Confidence, type ProblemTag, type ServiceMatch, type Severity } from '../../domain/types.js';
import { nameSimilarity } from '../../lib/text.js';
import type { ExclusionRule, ServiceDef, WeightedProblem } from './service-catalog.js';

/**
 * Service matching: maps evidence (findings → problem tags) to the studio's service catalogue.
 * Output: PRIMARY / SECONDARY recommendations and DO NOT RECOMMEND with explicit reasons.
 */

export interface FindingForScoring {
  id: string;
  code: string;
  title: string;
  category: string;
  polarity: string;
  severity: Severity | string;
  confidence: Confidence | string;
  kind: string;
  problemTags: ProblemTag[];
}

const SEVERITY_W: Record<string, number> = { critical: 1, high: 0.8, medium: 0.55, low: 0.3, info: 0.15 };
const CONF_W: Record<string, number> = { high: 1, medium: 0.8, low: 0.5 };
const PLATFORM_TAGS = new Set<ProblemTag>(['platform_wordpress', 'platform_tilda', 'platform_webflow', 'platform_bitrix', 'platform_wix', 'platform_squarespace', 'platform_joomla', 'platform_shopify', 'platform_custom']);

export interface TagEvidence {
  tag: ProblemTag;
  strength: number;
  findings: FindingForScoring[];
}

/** Strength of evidence per problem tag (0..1). AI observations count at 60%. */
export function tagEvidence(findings: FindingForScoring[], opts: { noWebsite?: boolean } = {}): Map<ProblemTag, TagEvidence> {
  const map = new Map<ProblemTag, TagEvidence>();
  const add = (tag: ProblemTag, w: number, f?: FindingForScoring) => {
    const e = map.get(tag) ?? { tag, strength: 0, findings: [] };
    e.strength = Math.min(1, e.strength + w);
    if (f) e.findings.push(f);
    map.set(tag, e);
  };
  if (opts.noWebsite) add('no_website', 1);
  for (const f of findings) {
    for (const tag of f.problemTags) {
      if (PLATFORM_TAGS.has(tag)) {
        add(tag, f.confidence === 'low' ? 0.5 : 1, f);
        continue;
      }
      if (f.polarity !== 'negative') continue;
      const w = (SEVERITY_W[f.severity] ?? 0.3) * (CONF_W[f.confidence] ?? 0.7) * (f.kind === 'ai_observation' ? 0.6 : 1);
      add(tag, w, f);
    }
  }
  return map;
}

export interface MatchContext {
  hasWebsite: boolean;
  commercialRelevance: number | null;
  /** services the user never wants recommended (My Business → disallowed project types) */
  disallowed?: string[];
  preferredTechnologies?: string[];
}

function evaluateExclusions(rules: ExclusionRule[], evidence: Map<ProblemTag, TagEvidence>, ctx: MatchContext): string[] {
  const out: string[] = [];
  const categories = new Set([...evidence.values()].flatMap((e) => e.findings.filter((f) => f.polarity === 'negative').map((f) => f.category)));
  for (const r of rules) {
    switch (r.type) {
      case 'requires_website':
        if (!ctx.hasWebsite) out.push(r.reason);
        break;
      case 'requires_tag':
        if ((evidence.get(r.tag)?.strength ?? 0) < 0.3) out.push(r.reason);
        break;
      case 'excludes_tag':
        if ((evidence.get(r.tag)?.strength ?? 0) >= 0.3) out.push(r.reason);
        break;
      case 'min_commercial_relevance':
        if (ctx.commercialRelevance == null || ctx.commercialRelevance < r.value) out.push(r.reason);
        break;
      case 'min_evidence_categories':
        if (categories.size < r.value) out.push(r.reason);
        break;
    }
  }
  return out;
}

export function scoreService(service: ServiceDef, evidence: Map<ProblemTag, TagEvidence>, ctx: MatchContext): ServiceMatch {
  const totalWeight = service.problemTypes.reduce((s, p) => s + p.weight, 0);
  const normalizer = Math.max(4, totalWeight * 0.6);
  let raw = 0;
  const reasons: ServiceMatch['reasons'] = [];
  const sorted: WeightedProblem[] = [...service.problemTypes].sort((a, b) => b.weight - a.weight);
  for (const p of sorted) {
    const e = evidence.get(p.tag);
    if (!e || e.strength <= 0) continue;
    raw += p.weight * e.strength;
    const titles = e.findings.slice(0, 3).map((f) => f.title);
    reasons.push({
      text: `${PROBLEM_TAG_LABELS[p.tag]}${titles.length ? ` — ${titles.join('; ')}` : ''}`,
      findingIds: e.findings.map((f) => f.id).slice(0, 6),
      tag: p.tag,
    });
  }
  // Saturating curve (raw = normalizer → ~70) scaled by breadth of coverage, so services whose
  // problem profile is broadly evidenced rank above those matched by a single strong tag.
  const coveredWeight = service.problemTypes.filter((p) => (evidence.get(p.tag)?.strength ?? 0) > 0).reduce((s, p) => s + p.weight, 0);
  const coverage = totalWeight > 0 ? coveredWeight / totalWeight : 0;
  let fit = Math.round(100 * (1 - Math.exp((-1.2 * raw) / normalizer)) * (0.7 + 0.3 * coverage));
  if (ctx.preferredTechnologies?.length && service.technologies.some((t) => ctx.preferredTechnologies!.some((pt) => pt.toLowerCase() === t.toLowerCase()))) {
    fit = Math.min(100, fit + 5);
  }
  const exclusionReasons = evaluateExclusions(service.excludedCases, evidence, ctx);
  if (ctx.disallowed?.includes(service.slug)) exclusionReasons.push('Marked as a disallowed project type in My Business.');
  return { serviceSlug: service.slug, serviceName: service.name, fitScore: fit, kind: 'candidate', reasons, exclusionReasons };
}

export interface MatchResult {
  primary: ServiceMatch | null;
  secondary: ServiceMatch | null;
  doNotRecommend: ServiceMatch[];
  all: ServiceMatch[];
  requested: ServiceMatch | null;
}

/** Resolve a free-text requested service ("premium website redesign") to a catalogue entry. */
export function resolveRequestedService(requested: string | undefined | null, services: ServiceDef[]): ServiceDef | null {
  if (!requested) return null;
  const exact = services.find((s) => s.slug === requested);
  if (exact) return exact;
  let best: { s: ServiceDef; score: number } | null = null;
  for (const s of services) {
    const score = Math.max(nameSimilarity(requested, s.name), nameSimilarity(requested, s.slug.replace(/-/g, ' ')));
    if (!best || score > best.score) best = { s, score };
  }
  return best && best.score >= 0.55 ? best.s : null;
}

export function matchServices(services: ServiceDef[], findings: FindingForScoring[], ctx: MatchContext, requestedService?: string | null): MatchResult {
  const evidence = tagEvidence(findings, { noWebsite: !ctx.hasWebsite });
  const all = services.map((s) => scoreService(s, evidence, ctx));
  const eligible = all
    .filter((m) => m.exclusionReasons.length === 0)
    .filter((m) => m.fitScore >= (services.find((s) => s.slug === m.serviceSlug)?.minimumFit ?? 40))
    .sort((a, b) => b.fitScore - a.fitScore);
  // The service the user is searching for leads the recommendation whenever the evidence supports it.
  const req = resolveRequestedService(requestedService, services);
  const requestedEligible = req ? eligible.find((m) => m.serviceSlug === req.slug) : undefined;
  const top = requestedEligible ?? eligible[0];
  const primary = top ? { ...top, kind: 'primary' as const } : null;
  // secondary should add something different: prefer a service whose top tag differs from the primary's
  const rest = eligible.filter((m) => m.serviceSlug !== primary?.serviceSlug);
  const primaryTags = new Set(primary?.reasons.slice(0, 2).map((r) => r.tag));
  const secondaryCandidate = rest.find((m) => !primaryTags.has(m.reasons[0]?.tag)) ?? rest[0];
  const secondary = secondaryCandidate ? { ...secondaryCandidate, kind: 'secondary' as const } : null;

  const doNot: ServiceMatch[] = [];
  for (const m of all) {
    if (m.serviceSlug === primary?.serviceSlug || m.serviceSlug === secondary?.serviceSlug) continue;
    const def = services.find((s) => s.slug === m.serviceSlug)!;
    // Explicit exclusion where the service would otherwise be tempting, or big-ticket without evidence.
    const tempting = m.fitScore >= def.minimumFit * 0.6 || def.projectSize === 'large';
    if (m.exclusionReasons.length > 0 && tempting && !m.exclusionReasons.every((r) => /does not appear to run|Only relevant for|Only recommended for|already has a website/.test(r))) {
      doNot.push({ ...m, kind: 'do_not_recommend' });
    } else if (def.projectSize === 'large' && m.fitScore < def.minimumFit && m.exclusionReasons.length === 0) {
      doNot.push({ ...m, kind: 'do_not_recommend', exclusionReasons: [`Insufficient evidence for a ${def.name.toLowerCase()} offer (fit ${m.fitScore} < ${def.minimumFit}).`] });
    }
  }
  const requested = req ? all.find((m) => m.serviceSlug === req.slug) ?? null : null;
  return { primary, secondary, doNotRecommend: doNot.slice(0, 3), all, requested };
}
