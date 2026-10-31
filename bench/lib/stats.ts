/** Seeded PRNG, resampling statistics and exact tests. No dependency on Math.random or the clock. */

/** Small, fast, well-distributed 32-bit generator (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(values: ArrayLike<number>): number {
  if (!values.length) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return sum / values.length;
}

/** Linear-interpolation quantile (R type 7) of an unsorted sample. */
export function quantile(values: ArrayLike<number>, q: number): number {
  if (!values.length) return Number.NaN;
  const sorted = Float64Array.from(values).sort();
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export interface BootstrapOptions {
  resamples?: number;
  seed?: number;
  alpha?: number;
}

export interface Interval {
  mean: number;
  lo: number;
  hi: number;
}

export const DEFAULT_RESAMPLES = 10_000;
export const DEFAULT_SEED = 1729;

/**
 * Percentile bootstrap of the mean for several columns that share the same units (same length).
 * All columns see the identical resampled indices, so differences between columns are paired.
 */
export function bootstrapMeans(columns: ArrayLike<number>[], options: BootstrapOptions = {}): Interval[] {
  const resamples = options.resamples ?? DEFAULT_RESAMPLES;
  const alpha = options.alpha ?? 0.05;
  const n = columns[0]?.length ?? 0;
  for (const column of columns) if (column.length !== n) throw new Error('bootstrap columns must have equal length');
  if (!columns.length) return [];
  if (n === 0) return columns.map(() => ({ mean: Number.NaN, lo: Number.NaN, hi: Number.NaN }));

  const random = mulberry32(options.seed ?? DEFAULT_SEED);
  const sums = columns.map(() => new Float64Array(resamples));
  const indices = new Int32Array(n);
  for (let b = 0; b < resamples; b++) {
    for (let i = 0; i < n; i++) indices[i] = (random() * n) | 0;
    for (let c = 0; c < columns.length; c++) {
      const column = columns[c];
      let total = 0;
      for (let i = 0; i < n; i++) total += column[indices[i]];
      sums[c][b] = total / n;
    }
  }
  const lowIndex = Math.floor((alpha / 2) * resamples);
  const highIndex = Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * resamples) - 1);
  return columns.map((column, c) => {
    const sorted = sums[c].sort();
    return { mean: mean(column), lo: sorted[lowIndex], hi: sorted[highIndex] };
  });
}

export interface PairedInterval {
  meanA: number;
  meanB: number;
  /** meanB - meanA with its paired-bootstrap percentile interval. */
  diff: number;
  lo: number;
  hi: number;
}

export function pairedBootstrap(a: ArrayLike<number>, b: ArrayLike<number>, options: BootstrapOptions = {}): PairedInterval {
  if (a.length !== b.length) throw new Error('paired samples must have equal length');
  const differences = Float64Array.from({ length: a.length }, (_, i) => b[i] - a[i]);
  const [interval] = bootstrapMeans([differences], options);
  return { meanA: mean(a), meanB: mean(b), diff: interval.mean, lo: interval.lo, hi: interval.hi };
}

const logFactorials: number[] = [0];
function logFactorial(n: number): number {
  for (let i = logFactorials.length; i <= n; i++) logFactorials.push(logFactorials[i - 1] + Math.log(i));
  return logFactorials[n];
}

/** Two-sided exact binomial (p = 0.5) tail used by McNemar's test: min(1, 2 * P(X <= min(b, c))). */
export function exactMcNemarP(onlyA: number, onlyB: number): number {
  const n = onlyA + onlyB;
  if (n === 0) return 1;
  const k = Math.min(onlyA, onlyB);
  let cumulative = 0;
  for (let i = 0; i <= k; i++) cumulative += Math.exp(logFactorial(n) - logFactorial(i) - logFactorial(n - i) - n * Math.LN2);
  return Math.min(1, 2 * cumulative);
}

export interface McNemar {
  both: number;
  neither: number;
  /** Instances where A succeeded and B failed. */
  onlyA: number;
  onlyB: number;
  p: number;
}

export function mcnemar(a: ArrayLike<number | boolean>, b: ArrayLike<number | boolean>): McNemar {
  if (a.length !== b.length) throw new Error('paired samples must have equal length');
  const result = { both: 0, neither: 0, onlyA: 0, onlyB: 0 };
  for (let i = 0; i < a.length; i++) {
    const x = Boolean(a[i]);
    const y = Boolean(b[i]);
    if (x && y) result.both++;
    else if (!x && !y) result.neither++;
    else if (x) result.onlyA++;
    else result.onlyB++;
  }
  return { ...result, p: exactMcNemarP(result.onlyA, result.onlyB) };
}
