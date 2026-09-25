import type { ScoreFactor } from '../../domain/types.js';

/**
 * Freshness engine: how current is what we know about this company?
 *
 * The time WE fetched a record says nothing about how current the record is (an OpenStreetMap
 * entry fetched today may not have been edited for eight years). Only three things count:
 *   1. a live check of the real website by our analyser (the site is up and matches the company),
 *   2. a listing in a source that maintains open/closed status (Google, Foursquare, Yelp) — capped,
 *      because "listed" is weaker than "seen",
 *   3. the source's own last-edit date when it provides one (OpenStreetMap).
 * A website being unreachable never marks a company as closed; only explicit source statuses do,
 * and conflicting statuses are surfaced (see Discrepancy).
 */
export const MAINTAINED_SOURCES = new Set(['google_places', 'foursquare', 'yelp']);

export interface FreshnessSource {
  provider: string;
  fetchedAt: Date;
  /** the source's own last change of this record, when known */
  sourceUpdatedAt?: Date | null;
}

export interface FreshnessInput {
  sources: FreshnessSource[];
  /** when our analyser last saw the real website (completed/partial analysis) */
  liveVerifiedAt: Date | null;
  businessStatus: string;
  discrepancyCount: number;
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

const LISTED_CAP = 85;

function ageScore(days: number): number {
  if (days <= 7) return 100;
  if (days <= 30) return 80;
  if (days <= 90) return 55;
  if (days <= 180) return 35;
  if (days <= 365) return 25;
  return 15;
}

const PROVIDER_NAMES: Record<string, string> = { google_places: 'Google Places', foursquare: 'Foursquare', yelp: 'Yelp', osm: 'OpenStreetMap', import: 'your import', web_search: 'web search' };
const day = (d: Date) => d.toISOString().slice(0, 10);

export function computeFreshness(input: FreshnessInput): FreshnessResult {
  const now = input.now ?? new Date();
  const ageDays = (d: Date) => Math.max(0, (now.getTime() - d.getTime()) / 86_400_000);
  const factors: ScoreFactor[] = [];
  const candidates: Array<{ score: number; at: Date; label: string; kind: ScoreFactor['kind'] }> = [];

  if (input.liveVerifiedAt) {
    candidates.push({ score: ageScore(ageDays(input.liveVerifiedAt)), at: input.liveVerifiedAt, label: `Website checked live on ${day(input.liveVerifiedAt)}`, kind: 'observation' });
  }
  for (const s of input.sources) {
    if (MAINTAINED_SOURCES.has(s.provider)) {
      candidates.push({ score: Math.min(LISTED_CAP, ageScore(ageDays(s.fetchedAt))), at: s.fetchedAt, label: `Listed by ${PROVIDER_NAMES[s.provider] ?? s.provider} (which maintains open/closed status) as of ${day(s.fetchedAt)}`, kind: 'fact' });
    }
    if (s.sourceUpdatedAt) {
      candidates.push({ score: ageScore(ageDays(s.sourceUpdatedAt)), at: s.sourceUpdatedAt, label: `${PROVIDER_NAMES[s.provider] ?? s.provider} record last edited ${day(s.sourceUpdatedAt)}`, kind: 'fact' });
    }
  }
  const undated = [...new Set(input.sources.filter((s) => !MAINTAINED_SOURCES.has(s.provider) && !s.sourceUpdatedAt).map((s) => PROVIDER_NAMES[s.provider] ?? s.provider))];

  if (candidates.length === 0) {
    factors.push({ label: undated.length ? `Only undated data (${undated.join(', ')}): we cannot tell how current it is` : 'No dated source information', points: 0, kind: 'gap' });
    if (input.businessStatus === 'closed_permanently') factors.push({ label: 'A source reports the business as permanently closed', points: -100, kind: 'fact' });
    return { score: 0, label: 'unknown', factors, newestSignalAt: null };
  }
  const best = candidates.sort((a, b) => b.score - a.score || b.at.getTime() - a.at.getTime())[0]!;
  let score = best.score;
  factors.push({ label: best.label, points: best.score, kind: best.kind });
  for (const c of candidates.slice(1, 3)) factors.push({ label: c.label, points: 0, kind: c.kind });
  if (undated.length) factors.push({ label: `Undated data from ${undated.join(', ')} (does not count as verification)`, points: 0, kind: 'gap' });

  const independent = new Set(input.sources.map((s) => s.provider)).size;
  if (independent >= 2) {
    score += 10;
    factors.push({ label: `Corroborated by ${independent} independent sources`, points: 10, kind: 'fact' });
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
  const newest = candidates.reduce((m, c) => (c.at > m ? c.at : m), candidates[0]!.at);
  return { score, label, factors, newestSignalAt: newest };
}
