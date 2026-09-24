import type { LeadFitResult, SalesPotential, ScoreFactor } from '../../domain/types.js';
import { predictWithInterval, type TrainedModel } from '../learning/logistic.js';

/**
 * "Chance of sale" — honest version.
 * Mode A (default): heuristic High/Medium/Low with the factors behind it. NOT a probability.
 * Mode B: only when a model trained on the user's own outcomes is active: probability with
 * uncertainty interval, sample size, model version and training date — always labelled a forecast.
 */
export function heuristicPotential(fit: LeadFitResult): { level: 'high' | 'medium' | 'low'; factors: ScoreFactor[] } {
  const get = (k: string) => fit.components.find((c) => c.key === k)?.score ?? null;
  const lf = fit.leadFit ?? 0;
  const ct = get('contactability') ?? 0;
  const cr = get('commercialRelevance');
  const score = 0.5 * lf + 0.25 * ct + 0.25 * (cr ?? 40);
  const factors: ScoreFactor[] = [
    { label: `Lead Fit ${fit.leadFit ?? '—'}`, points: Math.round(0.5 * lf), kind: 'inference' },
    { label: `Contactability ${ct}`, points: Math.round(0.25 * ct), kind: 'fact' },
    { label: cr == null ? 'Commercial relevance unknown (neutral 40 used)' : `Commercial relevance ${cr}`, points: Math.round(0.25 * (cr ?? 40)), kind: cr == null ? 'gap' : 'inference' },
  ];
  const level = fit.priority === 'excluded' ? 'low' : score >= 65 ? 'high' : score >= 45 ? 'medium' : 'low';
  return { level, factors };
}

export function salesPotential(fit: LeadFitResult, model: TrainedModel | null, features: Record<string, number> | null): SalesPotential {
  const h = heuristicPotential(fit);
  if (model && features) {
    const p = predictWithInterval(model, features);
    return {
      mode: 'B',
      target: model.target,
      probability: p.probability,
      interval: p.interval,
      sampleSize: model.sampleSize,
      modelVersion: model.version,
      trainedAt: model.trainedAt,
      note: `Forecast of ${model.target === 'reply' ? 'a reply (or better)' : 'a won deal'} from a logistic model trained on ${model.sampleSize} of your own outcomes. It is an estimate with the uncertainty shown, not a promise.`,
      heuristic: h,
    };
  }
  return {
    mode: 'A',
    level: h.level,
    label: 'Estimated Sales Potential (heuristic)',
    factors: h.factors,
    note: 'Not a probability. A calibrated probability appears only after enough of your own outcomes are recorded (Learning → Learn from my outcomes).',
  };
}
