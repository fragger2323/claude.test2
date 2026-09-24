import type { PortfolioMatchResult } from '../../domain/types.js';
import { resolveNiche } from '../strategy/strategy-engine.js';
import { stripDiacritics } from '../../lib/text.js';

/**
 * Portfolio matching: suggests which of the studio's real projects to show a lead.
 * Similarity is computed only from stored facts (industry, services, technology);
 * if nothing is genuinely similar, no project is suggested.
 */
export interface PortfolioProjectInput {
  id: string;
  name: string;
  url: string | null;
  industry: string | null;
  technologies: string[];
  styles: string[];
  services: string[];
  active: boolean;
}

export interface LeadForPortfolio {
  industry: string | null;
  categories: string[];
  nicheKey?: string | null;
  recommendedServices: string[];
  platform: string | null;
}

const norm = (s: string) => stripDiacritics(s.toLowerCase()).trim();

export const PORTFOLIO_THRESHOLD = 0.4;

export function matchPortfolio(projects: PortfolioProjectInput[], lead: LeadForPortfolio): { best: PortfolioMatchResult | null; ranked: PortfolioMatchResult[]; note: string } {
  const leadNiche = lead.nicheKey ?? (lead.industry ? resolveNiche(lead.industry).def?.key : undefined) ?? null;
  const leadIndustryText = norm([lead.industry, ...lead.categories].filter(Boolean).join(' '));
  const ranked: PortfolioMatchResult[] = [];
  for (const p of projects.filter((x) => x.active)) {
    const reasons: string[] = [];
    let score = 0;
    const projNiche = p.industry ? resolveNiche(p.industry).def?.key ?? null : null;
    if (projNiche && leadNiche && projNiche === leadNiche) {
      score += 0.5;
      reasons.push(`same industry (${p.industry})`);
    } else if (p.industry && leadIndustryText.includes(norm(p.industry))) {
      score += 0.4;
      reasons.push(`industry overlap (${p.industry})`);
    }
    const sharedServices = p.services.filter((s) => lead.recommendedServices.includes(s));
    if (sharedServices.length) {
      score += 0.3;
      reasons.push(`same service (${sharedServices.join(', ').replace(/-/g, ' ')})`);
    }
    if (lead.platform && p.technologies.some((t) => norm(t) === norm(lead.platform!))) {
      score += 0.15;
      reasons.push(`same platform (${lead.platform})`);
    }
    if (score > 0) ranked.push({ projectId: p.id, name: p.name, url: p.url, score: Math.round(score * 100) / 100, reasons });
  }
  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0] && ranked[0].score >= PORTFOLIO_THRESHOLD ? ranked[0] : null;
  const note = best
    ? `Suggested because: ${best.reasons.join(' + ')}.`
    : projects.length === 0
      ? 'No portfolio projects added yet (My Business → Portfolio).'
      : 'No portfolio project is similar enough by industry/service/platform — none will be referenced.';
  return { best, ranked: ranked.slice(0, 5), note };
}
