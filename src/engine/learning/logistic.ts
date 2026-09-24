/**
 * Small, dependency-free L2-regularised logistic regression with standardisation,
 * k-fold cross-validation, calibration bins and bootstrap prediction intervals.
 * Deliberately simple: the user's dataset is small, and simple models are honest.
 */

export interface Dataset {
  featureNames: string[];
  X: number[][];
  y: number[];
}

export interface FittedLogistic {
  featureNames: string[];
  weights: number[];
  bias: number;
  means: number[];
  stds: number[];
}

export interface TrainedModel {
  target: 'reply' | 'won';
  version: number;
  trainedAt: string;
  sampleSize: number;
  positives: number;
  model: FittedLogistic;
  bootstrap: Array<{ weights: number[]; bias: number }>;
}

export interface TrainOptions {
  l2?: number;
  learningRate?: number;
  epochs?: number;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));

/** Deterministic PRNG so training is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function standardize(X: number[][]): { Z: number[][]; means: number[]; stds: number[] } {
  const d = X[0]?.length ?? 0;
  const means = new Array<number>(d).fill(0);
  const stds = new Array<number>(d).fill(0);
  for (const row of X) row.forEach((v, j) => (means[j]! += v / X.length));
  for (const row of X) row.forEach((v, j) => (stds[j]! += (v - means[j]!) ** 2 / X.length));
  for (let j = 0; j < d; j++) stds[j] = Math.sqrt(stds[j]!) || 1;
  return { Z: X.map((row) => row.map((v, j) => (v - means[j]!) / stds[j]!)), means, stds };
}

export function fitLogistic(ds: Dataset, opts: TrainOptions = {}): FittedLogistic {
  const l2 = opts.l2 ?? 1.0;
  const lr = opts.learningRate ?? 0.1;
  const epochs = opts.epochs ?? 600;
  const { Z, means, stds } = standardize(ds.X);
  const n = Z.length;
  const d = ds.featureNames.length;
  const w = new Array<number>(d).fill(0);
  const base = ds.y.reduce((s, v) => s + v, 0) / Math.max(1, n);
  let b = Math.log((base + 1e-3) / (1 - base + 1e-3));
  for (let e = 0; e < epochs; e++) {
    const gw = new Array<number>(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const zi = Z[i]!;
      let z = b;
      for (let j = 0; j < d; j++) z += w[j]! * zi[j]!;
      const err = sigmoid(z) - ds.y[i]!;
      for (let j = 0; j < d; j++) gw[j]! += (err * zi[j]!) / n;
      gb += err / n;
    }
    for (let j = 0; j < d; j++) w[j]! -= lr * (gw[j]! + (l2 / n) * w[j]!);
    b -= lr * gb;
  }
  return { featureNames: ds.featureNames, weights: w, bias: b, means, stds };
}

export function predictOne(m: { weights: number[]; bias: number; means: number[]; stds: number[]; featureNames: string[] }, x: number[]): number {
  let z = m.bias;
  for (let j = 0; j < m.weights.length; j++) z += m.weights[j]! * ((x[j]! - m.means[j]!) / m.stds[j]!);
  return sigmoid(z);
}

export function vectorize(featureNames: string[], features: Record<string, number>): number[] {
  return featureNames.map((f) => features[f] ?? 0);
}

export function brier(p: number[], y: number[]): number {
  return p.reduce((s, pi, i) => s + (pi - y[i]!) ** 2, 0) / Math.max(1, p.length);
}

export function logLoss(p: number[], y: number[]): number {
  return -p.reduce((s, pi, i) => s + (y[i]! * Math.log(Math.max(1e-9, pi)) + (1 - y[i]!) * Math.log(Math.max(1e-9, 1 - pi))), 0) / Math.max(1, p.length);
}

export function auc(p: number[], y: number[]): number | null {
  const pos = p.filter((_, i) => y[i] === 1);
  const neg = p.filter((_, i) => y[i] === 0);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export interface CvResult {
  brier: number;
  baselineBrier: number;
  logLoss: number;
  auc: number | null;
  calibration: Array<{ bin: string; predicted: number; observed: number; n: number }>;
  folds: number;
}

export function crossValidate(ds: Dataset, k = 5, opts: TrainOptions = {}, seed = 42): CvResult {
  const n = ds.X.length;
  const rand = mulberry32(seed);
  const idx = Array.from({ length: n }, (_, i) => i).sort(() => rand() - 0.5);
  const preds = new Array<number>(n).fill(0);
  const basePreds = new Array<number>(n).fill(0);
  const folds = Math.min(k, n);
  for (let f = 0; f < folds; f++) {
    const test = idx.filter((_, i) => i % folds === f);
    const testSet = new Set(test);
    const trainIdx = idx.filter((i) => !testSet.has(i));
    const train: Dataset = { featureNames: ds.featureNames, X: trainIdx.map((i) => ds.X[i]!), y: trainIdx.map((i) => ds.y[i]!) };
    const m = fitLogistic(train, opts);
    const baseRate = train.y.reduce((s, v) => s + v, 0) / Math.max(1, train.y.length);
    for (const i of test) {
      preds[i] = predictOne(m, ds.X[i]!);
      basePreds[i] = baseRate;
    }
  }
  const bins = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
  const calibration = bins.slice(0, -1).map((lo, bi) => {
    const hi = bins[bi + 1]!;
    const members = preds.map((p, i) => ({ p, y: ds.y[i]! })).filter((x) => x.p >= lo && x.p < hi);
    return {
      bin: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`,
      predicted: members.length ? members.reduce((s, x) => s + x.p, 0) / members.length : 0,
      observed: members.length ? members.reduce((s, x) => s + x.y, 0) / members.length : 0,
      n: members.length,
    };
  });
  return { brier: brier(preds, ds.y), baselineBrier: brier(basePreds, ds.y), logLoss: logLoss(preds, ds.y), auc: auc(preds, ds.y), calibration, folds };
}

export function bootstrapModels(ds: Dataset, rounds = 30, opts: TrainOptions = {}, seed = 7): Array<{ weights: number[]; bias: number }> {
  const rand = mulberry32(seed);
  const n = ds.X.length;
  const out: Array<{ weights: number[]; bias: number }> = [];
  for (let r = 0; r < rounds; r++) {
    const sample = Array.from({ length: n }, () => Math.floor(rand() * n));
    const y = sample.map((i) => ds.y[i]!);
    if (y.every((v) => v === y[0])) continue;
    const m = fitLogistic({ featureNames: ds.featureNames, X: sample.map((i) => ds.X[i]!), y }, { ...opts, epochs: Math.min(400, opts.epochs ?? 400) });
    // express bootstrap weights in the main model's standardisation space by refitting on raw scale
    out.push({ weights: m.weights.map((w, j) => w / m.stds[j]!), bias: m.bias - m.weights.reduce((s, w, j) => s + (w * m.means[j]!) / m.stds[j]!, 0) });
  }
  return out;
}

/** Probability with an 80% bootstrap interval. */
export function predictWithInterval(model: TrainedModel, features: Record<string, number>): { probability: number; interval: [number, number] } {
  const x = vectorize(model.model.featureNames, features);
  const probability = predictOne(model.model, x);
  const samples = model.bootstrap
    .map((b) => sigmoid(b.bias + b.weights.reduce((s, w, j) => s + w * x[j]!, 0)))
    .sort((a, b) => a - b);
  if (samples.length < 5) return { probability, interval: [Math.max(0, probability - 0.2), Math.min(1, probability + 0.2)] };
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.max(0, Math.floor(p * (samples.length - 1))))]!;
  return { probability, interval: [Math.min(q(0.1), probability), Math.max(q(0.9), probability)] };
}
