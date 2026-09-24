import type { Prisma } from '@prisma/client';
import { db } from '../../db/client.js';
import { jsonObject } from '../../lib/misc.js';
import { NUMERIC_FEATURES, numericFeatures } from './features.js';
import { bootstrapModels, crossValidate, fitLogistic, type Dataset, type TrainedModel } from './logistic.js';

/**
 * "Learn from my outcomes": trains a model only on the user's real outcomes.
 * A model is activated only if there is enough data AND it beats the base rate in
 * cross-validation. Otherwise the heuristic (Mode A) stays in charge — and the UI says why.
 */
export const MIN_SAMPLES = 40;
export const MIN_CLASS = 8;

const POSITIVE: Record<'reply' | 'won', string[]> = {
  reply: ['replied', 'meeting', 'proposal', 'won'],
  won: ['won'],
};
const NEGATIVE: Record<'reply' | 'won', string[]> = {
  reply: ['no_reply', 'not_interested', 'wrong_fit', 'lost'],
  won: ['lost', 'not_interested', 'wrong_fit', 'no_reply'],
};

export interface LabelledRow {
  leadId: string;
  label: 0 | 1;
  snapshot: Record<string, unknown>;
}

export async function collectLabelledRows(target: 'reply' | 'won'): Promise<LabelledRow[]> {
  const leads = await db().lead.findMany({
    where: { outcomes: { some: {} } },
    select: { id: true, contactedFeatures: true, outcomes: { select: { type: true, features: true } } },
  });
  const rows: LabelledRow[] = [];
  for (const l of leads) {
    const types = l.outcomes.map((o) => o.type);
    let label: 0 | 1 | null = null;
    if (types.some((t) => POSITIVE[target].includes(t))) label = 1;
    else if (types.some((t) => NEGATIVE[target].includes(t))) label = 0;
    if (label == null) continue;
    const snap = jsonObject<Record<string, unknown>>(l.contactedFeatures ?? l.outcomes.find((o) => o.features)?.features, {});
    if (Object.keys(snap).length === 0) continue;
    rows.push({ leadId: l.id, label, snapshot: snap });
  }
  return rows;
}

function topValues(values: string[], min = 3, max = 8): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, c]) => c >= min)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([v]) => v);
}

export function buildDataset(rows: LabelledRow[]): { ds: Dataset; vocab: { industry: string[]; service: string[]; problems: string[] } } {
  const vocab = {
    industry: topValues(rows.map((r) => String(r.snapshot.cat_industry ?? 'unknown'))),
    service: topValues(rows.map((r) => String(r.snapshot.cat_service ?? 'none'))),
    problems: topValues(rows.flatMap((r) => (Array.isArray(r.snapshot.cat_problems) ? (r.snapshot.cat_problems as string[]) : []))),
  };
  const featureNames = [...NUMERIC_FEATURES, ...vocab.industry.map((v) => `industry=${v}`), ...vocab.service.map((v) => `service=${v}`), ...vocab.problems.map((v) => `problem=${v}`)];
  const X = rows.map((r) => {
    const f = numericFeatures(r.snapshot, vocab);
    return featureNames.map((n) => f[n] ?? 0);
  });
  return { ds: { featureNames, X, y: rows.map((r) => r.label) }, vocab };
}

export interface TrainReport {
  target: 'reply' | 'won';
  status: 'trained' | 'insufficient_data' | 'failed';
  active: boolean;
  sampleSize: number;
  positives: number;
  negatives: number;
  needed: { samples: number; perClass: number };
  metrics?: Record<string, unknown>;
  insights?: Array<{ feature: string; effect: 'positive' | 'negative'; weight: number }>;
  version?: number;
  note: string;
}

export async function trainOutcomeModel(target: 'reply' | 'won'): Promise<TrainReport> {
  const rows = await collectLabelledRows(target);
  const positives = rows.filter((r) => r.label === 1).length;
  const negatives = rows.length - positives;
  const prev = await db().modelRun.findFirst({ where: { target }, orderBy: { version: 'desc' } });
  const version = (prev?.version ?? 0) + 1;
  const base = { target, sampleSize: rows.length, positives, negatives, needed: { samples: MIN_SAMPLES, perClass: MIN_CLASS } };

  if (rows.length < MIN_SAMPLES || positives < MIN_CLASS || negatives < MIN_CLASS) {
    const note = `Not enough labelled outcomes yet: ${rows.length}/${MIN_SAMPLES} contacted leads with a recorded result (${positives} positive, ${negatives} negative; need ≥${MIN_CLASS} of each). Priority stays heuristic.`;
    await db().modelRun.create({
      data: { target, version, status: 'insufficient_data', active: false, sampleSize: rows.length, positives, metrics: { negatives }, coefficients: {}, featureSpec: {}, notes: note },
    });
    return { ...base, status: 'insufficient_data', active: false, version, note };
  }

  try {
    const { ds, vocab } = buildDataset(rows);
    const cv = crossValidate(ds, 5);
    const model = fitLogistic(ds);
    const boot = bootstrapModels(ds, 30);
    const beatsBaseline = cv.brier < cv.baselineBrier * 0.97;
    const insights = model.featureNames
      .map((f, j) => ({ feature: f, weight: Math.round(model.weights[j]! * 1000) / 1000 }))
      .filter((x) => Math.abs(x.weight) > 0.05)
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
      .slice(0, 10)
      .map((x) => ({ ...x, effect: x.weight > 0 ? ('positive' as const) : ('negative' as const) }));
    const note = beatsBaseline
      ? `Model v${version} beats the base rate in 5-fold cross-validation (Brier ${cv.brier.toFixed(3)} vs ${cv.baselineBrier.toFixed(3)}). Probabilities are shown with uncertainty.`
      : `Model v${version} does not beat the base rate in cross-validation (Brier ${cv.brier.toFixed(3)} vs ${cv.baselineBrier.toFixed(3)}); it is stored but NOT used. Priority stays heuristic.`;
    if (beatsBaseline) await db().modelRun.updateMany({ where: { target, active: true }, data: { active: false } });
    await db().modelRun.create({
      data: {
        target,
        version,
        status: 'trained',
        active: beatsBaseline,
        sampleSize: rows.length,
        positives,
        metrics: { ...cv, negatives, baseRate: positives / rows.length } as unknown as Prisma.InputJsonValue,
        coefficients: { model, bootstrap: boot } as unknown as Prisma.InputJsonValue,
        featureSpec: { vocab, featureNames: ds.featureNames } as unknown as Prisma.InputJsonValue,
        notes: note,
      },
    });
    return { ...base, status: 'trained', active: beatsBaseline, version, metrics: { brier: cv.brier, baselineBrier: cv.baselineBrier, auc: cv.auc, logLoss: cv.logLoss, calibration: cv.calibration }, insights, note };
  } catch (e) {
    const note = `Training failed: ${(e as Error).message}`;
    await db().modelRun.create({ data: { target, version, status: 'failed', active: false, sampleSize: rows.length, positives, metrics: {}, coefficients: {}, featureSpec: {}, notes: note } });
    return { ...base, status: 'failed', active: false, version, note };
  }
}

export interface ActiveModel {
  trained: TrainedModel;
  vocab: { industry: string[]; service: string[]; problems: string[] };
}

export async function loadActiveModel(target: 'reply' | 'won' = 'reply'): Promise<ActiveModel | null> {
  const run = await db().modelRun.findFirst({ where: { target, active: true, status: 'trained' }, orderBy: { version: 'desc' } });
  if (!run) return null;
  const coef = run.coefficients as unknown as { model: TrainedModel['model']; bootstrap: TrainedModel['bootstrap'] };
  const spec = run.featureSpec as unknown as { vocab: ActiveModel['vocab'] };
  if (!coef?.model || !spec?.vocab) return null;
  return {
    trained: { target, version: run.version, trainedAt: run.trainedAt.toISOString(), sampleSize: run.sampleSize, positives: run.positives, model: coef.model, bootstrap: coef.bootstrap ?? [] },
    vocab: spec.vocab,
  };
}
