import type { ScoreFactor } from '../../domain/types.js';

/**
 * Freshness engine: how current is what we know about this company?
 * A website being unreachable never marks a company as closed; only explicit source
 * statuses do, and conflicting statuses are surfaced (see Discrepancy).
 */
export interface FreshnessInput {
  sourceFetches: Date[];
  lastVerifiedAt: Date | null;
  analysisAt: Date | null;
  businessStatus: string;
  discrepancyCount: number;
  providerCount: number;
  websiteStatus?: string | null;
  now?: Date;
}

export type FreshnessLabel = 'fresh' | 'recent' | 'aging' | 'stale' | 'unknown';

export interface FreshnessResult {
  score: number;
  label: FreshnessLabel;
  factors: ScoreFactor[];
  newestSignalAt: Date | null;
}

function ageScore(days: number): number {
  if (days <= 7) return 100;
  if (days <= 30) return 80;
  if (days <= 90) return 55;
  if (days <= 180) return 35;
  return 15;
}

export function computeFreshness(input: FreshnessInput): FreshnessResult {
  const now = input.now ?? new Date();
  const factors: ScoreFactor[] = [];
  const signals = [...input.sourceFetches, input.lastVerifiedAt, input.analysisAt].filter((d): d is Date => !!d);
  if (signals.length === 0) {
    return { score: 0, label: 'unknown', factors: [{ label: 'No dated source information', points: 0, kind: 'gap' }], newestSignalAt: null };
  }
  const newest = signals.reduce((a, b) => (a > b ? a : b));
  const days = (now.getTime() - newest.getTime()) / 86_400_000;
  let score = ageScore(days);
  factors.push({ label: `Newest verification ${days < 1 ? 'today' : `${Math.round(days)} day(s) ago`}`, points: score, kind: 'fact' });

  if (input.analysisAt) {
    const ad = (now.getTime() - input.analysisAt.getTime()) / 86_400_000;
    if (ad <= 30) factors.push({ label: 'Website analysed live within 30 days', points: 0, kind: 'observation' });
  }
  if (input.providerCount >= 2) {
    score += 10;
    factors.push({ label: `Corroborated by ${input.providerCount} independent sources`, points: 10, kind: 'fact' });
  }
  if (input.businessStatus === 'closed_temporarily') {
    score -= 30;
    factors.push({ label: 'A source reports the business as temporarily closed', points: -30, kind: 'fact' });
  }
  if (input.businessStatus === 'closed_permanently') {
    score = 0;
    factors.push({ label: 'A source reports the business as permanently closed', points: -100, kind: 'fact' });
  }
  if (input.discrepancyCount > 0) {
    const p = Math.min(20, input.discrepancyCount * 5);
    score -= p;
    factors.push({ label: `${input.discrepancyCount} conflicting value(s) between sources`, points: -p, kind: 'fact' });
  }
  if (input.websiteStatus === 'unreachable') {
    factors.push({ label: 'Website was unreachable at last check (not treated as closed)', points: 0, kind: 'observation' });
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const label: FreshnessLabel = score >= 85 ? 'fresh' : score >= 65 ? 'recent' : score >= 40 ? 'aging' : 'stale';
  return { score, label, factors, newestSignalAt: newest };
}
