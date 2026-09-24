import { PROBLEM_TAG_LABELS, PROVIDER_LABELS, type DecisionIntel, type LeadFitResult, type ProblemTag, type ServiceMatch } from '../../domain/types.js';
import type { FindingForScoring } from './service-matching.js';

/**
 * Decision intelligence for a lead card. Deterministic and evidence-bound:
 * everything here is derived from stored facts, findings, scores and contacts.
 */

export interface DecisionInput {
  company: {
    name: string;
    city: string | null;
    country: string | null;
    sources: string[];
    ratingCount: number | null;
    rating: number | null;
    businessStatus: string;
    firstSeenAt: Date;
    discrepancies: number;
  };
  website: { status: string; url: string | null; platform: string | null; notFoundReason: string | null };
  analysis: { at: Date | null; lighthouseRan: boolean; aiObservations: number; diff: { fixed: string[]; added: string[]; redesignSuspected: boolean; previousAt: string } | null; status: string | null } | null;
  findings: Array<FindingForScoring & { detail: string; evidenceSummary?: string }>;
  fit: LeadFitResult;
  services: { primary: ServiceMatch | null; secondary: ServiceMatch | null; doNotRecommend: ServiceMatch[] };
  contacts: Array<{ type: string; value: string; status: string; isRoleBased: boolean; isPersonal: boolean; sourceUrl: string | null }>;
  freshness: { label: string; lastVerifiedAt: Date | null; sources: Array<{ provider: string; fetchedAt: Date }> };
  portfolioNote?: string;
  now?: Date;
}

const SEV_ORDER: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
/** Pain-point ranking favours severe, customer-visible problems over many small technical ones. */
const PAIN_WEIGHT: Record<string, number> = { critical: 8, high: 5, medium: 3, low: 1, info: 0 };
const CUSTOMER_VISIBLE = new Set(['ux', 'performance', 'visual', 'content', 'accessibility', 'contact']);
const CONSENT_COUNTRIES = new Set(['PL', 'DE', 'AT', 'FR', 'IT', 'ES', 'NL', 'BE', 'CZ', 'SK', 'DK', 'SE', 'FI', 'PT', 'IE', 'LU', 'HU', 'RO', 'BG', 'HR', 'SI', 'LT', 'LV', 'EE', 'GR', 'CY', 'MT', 'GB']);

function interpretationFor(tag: ProblemTag, service: string | null): string {
  const svc = service ? ` — potential opportunity for ${service.toLowerCase()}` : '';
  switch (tag) {
    case 'mobile_experience':
    case 'responsive_bugs':
      return `Likely friction for visitors on phones${svc}.`;
    case 'weak_cta':
    case 'conversion_path':
    case 'contact_path':
      return `Visitors may need extra steps to get in touch${svc}.`;
    case 'outdated_design':
    case 'visual_quality':
      return `The site may not reflect the quality of the business${svc}.`;
    case 'performance':
    case 'heavy_assets':
      return `Pages are likely slow on mobile connections${svc}.`;
    case 'seo_foundation':
    case 'local_seo':
      return `Search engines get weak signals about the business${svc}.`;
    case 'technical_errors':
    case 'broken_links':
      return `Some site features or pages may not work as intended${svc}.`;
    case 'security_https':
      return `Browsers may show security warnings${svc}.`;
    case 'no_website':
      return `Online presence depends on third-party listings only${svc}.`;
    default:
      return `${PROBLEM_TAG_LABELS[tag]} observed${svc}.`;
  }
}

export function buildDecisionIntel(i: DecisionInput): DecisionIntel {
  const now = i.now ?? new Date();
  const negative = i.findings
    .filter((f) => f.polarity === 'negative')
    .sort((a, b) => (SEV_ORDER[b.severity] ?? 0) - (SEV_ORDER[a.severity] ?? 0) || (a.kind === 'ai_observation' ? 1 : 0) - (b.kind === 'ai_observation' ? 1 : 0));
  const observed = negative.filter((f) => f.kind !== 'ai_observation');
  const primaryName = i.services.primary?.serviceName ?? null;

  // Pain points: cluster by strongest problem tag.
  const tagScore = new Map<ProblemTag, { score: number; findings: typeof negative; parts: number[] }>();
  for (const f of negative) {
    for (const t of f.problemTags) {
      if (t.startsWith('platform_')) continue;
      const e = tagScore.get(t) ?? { score: 0, findings: [], parts: [] };
      e.parts.push((PAIN_WEIGHT[f.severity] ?? 1) * (f.kind === 'ai_observation' ? 0.6 : 1) * (CUSTOMER_VISIBLE.has(f.category) ? 1.3 : 1));
      e.findings.push(f);
      tagScore.set(t, e);
    }
  }
  // Diminishing returns: one severe problem outweighs many minor ones of another kind.
  for (const e of tagScore.values()) e.score = [...e.parts].sort((a, b) => b - a).reduce((s, p, idx) => s + p * 0.6 ** idx, 0);
  if (i.website.status === 'not_found') tagScore.set('no_website', { score: 99, findings: [], parts: [] });
  const tags = [...tagScore.entries()].sort((a, b) => b[1].score - a[1].score);
  const pain = (idx: number) => {
    const t = tags[idx];
    if (!t) return null;
    // Name a service only if its own evidence covers this problem (no "mobile issues → maintenance").
    const addressedBy = [i.services.primary, i.services.secondary].find((s) => s?.reasons.some((r) => r.tag === t[0]));
    const service = addressedBy?.serviceName ?? (t[0] === 'no_website' ? primaryName : null);
    return { title: PROBLEM_TAG_LABELS[t[0]], interpretation: interpretationFor(t[0], service), findingIds: t[1].findings.slice(0, 5).map((f) => f.id) };
  };
  const mainPain = pain(0);
  let secondPain = pain(1);
  if (secondPain && mainPain && secondPain.findingIds.every((id) => mainPain.findingIds.includes(id))) secondPain = pain(2);

  const whyThisLead: string[] = [];
  whyThisLead.push(...i.fit.priorityReasons.slice(0, 3));
  if (i.services.primary) whyThisLead.push(`Evidence supports “${i.services.primary.serviceName}” (fit ${i.services.primary.fitScore}).`);
  for (const f of observed.slice(0, 2)) whyThisLead.push(`Observed: ${f.title}.`);

  const whyNow: string[] = [];
  const firstSeenDays = (now.getTime() - i.company.firstSeenAt.getTime()) / 86_400_000;
  if (firstSeenDays <= 7) whyNow.push(`Newly discovered (first seen ${i.company.firstSeenAt.toISOString().slice(0, 10)}).`);
  if (i.analysis?.diff?.added.length) whyNow.push(`${i.analysis.diff.added.length} new issue(s) appeared since the previous snapshot (${i.analysis.diff.previousAt.slice(0, 10)}).`);
  if (i.analysis?.diff?.redesignSuspected) whyNow.push('The site structure changed substantially since the last snapshot (possible recent redesign — check before pitching a redesign).');
  if (i.analysis?.at && (now.getTime() - i.analysis.at.getTime()) / 86_400_000 <= 3) whyNow.push(`Issues were verified live on ${i.analysis.at.toISOString().slice(0, 10)}, so the observations are current.`);
  if (whyNow.length === 0) whyNow.push('No time-sensitive signal detected — timing is neutral.');

  const whatToOffer = [i.services.primary, i.services.secondary]
    .filter((s): s is ServiceMatch => !!s)
    .map((s) => ({ service: s.serviceName, reason: s.reasons.slice(0, 2).map((r) => r.text).join('; ') || `fit ${s.fitScore}` }));
  const whatNotToOffer = i.services.doNotRecommend.map((s) => ({ service: s.serviceName, reason: s.exclusionReasons.join(' ') }));

  const mentionable = observed
    .filter((f) => f.confidence === 'high' && CUSTOMER_VISIBLE.has(f.category))
    .concat(observed.filter((f) => f.confidence === 'high' && !CUSTOMER_VISIBLE.has(f.category)))
    .slice(0, 3);
  const whatToMention = mentionable.map((f) => ({ text: f.title, findingId: f.id, evidence: f.evidenceSummary ?? f.detail.slice(0, 160) }));

  const whatNotToClaim = [
    'Do not claim the company is losing clients, patients or revenue — this was not measured.',
    'Do not promise rankings, traffic or conversion increases.',
  ];
  if (!i.analysis?.lighthouseRan) whatNotToClaim.push('Do not quote PageSpeed/Lighthouse scores — Lighthouse was not run; our speed numbers are single lab measurements.');
  if ((i.analysis?.aiObservations ?? 0) > 0) whatNotToClaim.push('Do not present AI visual observations as facts; they are subjective opinions.');
  const bestEmail = i.contacts.find((c) => c.type === 'email' && c.status !== 'unverified');
  if (bestEmail && bestEmail.status === 'probable') whatNotToClaim.push(`Do not assume ${bestEmail.value} is monitored — it comes from a listing, not the website.`);
  if (i.website.status === 'unreachable') whatNotToClaim.push('Do not say the business is closed — only the website was unreachable when checked.');
  if (i.company.discrepancies > 0) whatNotToClaim.push('Sources disagree on some details (see Discrepancies) — confirm before quoting phone/address.');

  // Best channel
  const byStatus = (type: string) => i.contacts.filter((c) => c.type === type).sort((a, b) => (a.status === 'verified' ? -1 : 1) - (b.status === 'verified' ? -1 : 1));
  const email = byStatus('email').find((c) => c.status !== 'unverified' && !c.isPersonal) ?? byStatus('email').find((c) => c.status !== 'unverified');
  const form = byStatus('contact_form')[0];
  const phone = byStatus('phone').find((c) => c.status !== 'unverified');
  const cc = (i.company.country ?? '').toUpperCase().slice(0, 2);
  const consentNote = CONSENT_COUNTRIES.has(cc)
    ? 'Check local rules first: in many European countries (e.g. PL, DE) unsolicited commercial e-mails/calls to businesses can require prior consent. A short contact-form message asking whether you may send the audit is a safer first step.'
    : 'Check local anti-spam and data-protection rules before the first commercial message.';
  let bestContactChannel: DecisionIntel['bestContactChannel'] = null;
  if (form && CONSENT_COUNTRIES.has(cc)) bestContactChannel = { channel: 'contact_form', value: form.value, reason: 'Contact form on the official website — suitable for a permission-first message.', complianceNote: consentNote };
  else if (email) bestContactChannel = { channel: 'email', value: email.value, reason: `${email.status === 'verified' ? 'Published on the official website' : 'From a business listing'}${email.isRoleBased ? ' (role-based address)' : ''}.`, complianceNote: consentNote };
  else if (form) bestContactChannel = { channel: 'contact_form', value: form.value, reason: 'Contact form on the official website.', complianceNote: consentNote };
  else if (phone) bestContactChannel = { channel: 'phone', value: phone.value, reason: `${phone.status === 'verified' ? 'Verified' : 'Listed'} business phone.`, complianceNote: consentNote };

  const know: string[] = [];
  know.push(`Found in ${i.company.sources.length} source(s): ${i.company.sources.map((x) => PROVIDER_LABELS[x] ?? x).join(', ')}.`);
  if (i.company.ratingCount != null) know.push(`${i.company.ratingCount} public reviews${i.company.rating != null ? ` (avg ${i.company.rating.toFixed(1)})` : ''} according to listings.`);
  if (i.company.businessStatus !== 'unknown') know.push(`Business status per sources: ${i.company.businessStatus.replace('_', ' ')}.`);
  if (i.website.url) know.push(`Official website: ${i.website.url}${i.website.platform ? ` (${i.website.platform})` : ''}.`);
  else if (i.website.notFoundReason) know.push(i.website.notFoundReason);
  const verifiedContacts = i.contacts.filter((c) => c.status === 'verified').map((c) => c.type);
  if (verifiedContacts.length) know.push(`Verified public contacts: ${[...new Set(verifiedContacts)].join(', ')}.`);

  const observedList = observed.slice(0, 6).map((f) => f.title);
  const infer: string[] = [];
  if (mainPain) infer.push(`${mainPain.title}: ${mainPain.interpretation}`);
  if (secondPain) infer.push(`${secondPain.title}: ${secondPain.interpretation}`);
  for (const f of negative.filter((x) => x.kind === 'ai_observation').slice(0, 2)) infer.push(`AI observation (subjective): ${f.detail.slice(0, 140)}`);
  if (i.services.primary) infer.push(`Best-matching service: ${i.services.primary.serviceName} (evidence fit ${i.services.primary.fitScore}/100).`);

  const unknown: string[] = [
    'Budget, decision-maker and current agency relationships are unknown.',
    'Whether the owner is aware of or cares about these issues is unknown.',
    'Real-user (field) performance and actual conversion rates are unknown.',
  ];
  if (!i.analysis?.lighthouseRan) unknown.push('Lighthouse scores (not run).');
  for (const c of i.fit.components.filter((x) => x.score == null)) unknown.push(`${c.label}: no data.`);
  if (i.company.ratingCount == null) unknown.push('Company size (no review/location data).');

  return {
    whyThisLead,
    whyNow,
    whatToOffer,
    whatNotToOffer,
    whatToMention,
    whatNotToClaim,
    bestContactChannel,
    mainPainPoint: mainPain,
    secondaryPainPoint: secondPain,
    knowledge: { know, observed: observedList, infer, unknown },
    freshness: {
      label: i.freshness.label,
      lastVerifiedAt: i.freshness.lastVerifiedAt?.toISOString() ?? null,
      analysisAt: i.analysis?.at?.toISOString() ?? null,
      sources: i.freshness.sources.map((s) => ({ provider: s.provider, fetchedAt: s.fetchedAt.toISOString() })),
    },
  };
}
