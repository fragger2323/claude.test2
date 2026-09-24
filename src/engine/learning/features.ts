import type { LeadFitResult } from '../../domain/types.js';

/**
 * Feature snapshot used for learning. Captured when a lead is marked "contacted" so the
 * model learns from what was known *at contact time* (no leakage from later updates).
 */
export interface FeatureSnapshotInput {
  fit: LeadFitResult | null;
  contactAvailability: string | null;
  websiteStatus: string | null;
  primaryService: string | null;
  industry: string | null;
  sources: string[];
  mainProblemTags: string[];
  priorityRank: number;
}

export function buildFeatureSnapshot(i: FeatureSnapshotInput): Record<string, number | string | string[]> {
  const comp = (k: string) => (i.fit?.components.find((c) => c.key === k)?.score ?? 50) / 100;
  return {
    websiteNeed: comp('websiteNeed'),
    serviceFit: comp('serviceFit'),
    businessFit: comp('businessFit'),
    contactability: comp('contactability'),
    freshness: comp('freshness'),
    technicalOpportunity: comp('technicalOpportunity'),
    commercialRelevance: comp('commercialRelevance'),
    leadFit: (i.fit?.leadFit ?? 50) / 100,
    priorityRank: i.priorityRank / 5,
    hasEmail: i.contactAvailability === 'email' ? 1 : 0,
    hasFormOnly: i.contactAvailability === 'form' ? 1 : 0,
    phoneOnly: i.contactAvailability === 'phone' ? 1 : 0,
    noWebsite: i.websiteStatus === 'not_found' ? 1 : 0,
    // categorical values are kept as strings; the trainer one-hot encodes frequent ones
    cat_industry: i.industry ?? 'unknown',
    cat_service: i.primaryService ?? 'none',
    cat_sources: i.sources,
    cat_problems: i.mainProblemTags,
  };
}

export const NUMERIC_FEATURES = [
  'websiteNeed',
  'serviceFit',
  'businessFit',
  'contactability',
  'freshness',
  'technicalOpportunity',
  'commercialRelevance',
  'leadFit',
  'priorityRank',
  'hasEmail',
  'hasFormOnly',
  'phoneOnly',
  'noWebsite',
];

/** Turn a stored snapshot into a numeric vector given the model's one-hot vocabulary. */
export function numericFeatures(snapshot: Record<string, unknown>, vocab: { industry: string[]; service: string[]; problems: string[] }): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of NUMERIC_FEATURES) out[f] = typeof snapshot[f] === 'number' ? (snapshot[f] as number) : 0;
  for (const v of vocab.industry) out[`industry=${v}`] = snapshot.cat_industry === v ? 1 : 0;
  for (const v of vocab.service) out[`service=${v}`] = snapshot.cat_service === v ? 1 : 0;
  const probs = Array.isArray(snapshot.cat_problems) ? (snapshot.cat_problems as string[]) : [];
  for (const v of vocab.problems) out[`problem=${v}`] = probs.includes(v) ? 1 : 0;
  return out;
}
