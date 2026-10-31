/** Small statistics helpers used by the report generator. All functions tolerate empty input. */

export function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function mean(values: readonly number[]): number | null {
  return values.length ? sum(values) / values.length : null;
}

/** Linear-interpolated percentile (p in 0..100), the same definition as numpy's default. */
export function percentile(values: readonly number[], p: number): number | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return null;
  if (finite.length === 1) return finite[0];
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (finite.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return finite[lo] + (finite[hi] - finite[lo]) * (rank - lo);
}

export const median = (values: readonly number[]): number | null => percentile(values, 50);

export function max(values: readonly number[]): number | null {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
}

export function round(value: number | null | undefined, digits = 2): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export const SIZE_BUCKETS = ['<500', '500-2k', '2k-10k', '10k-50k', '>=50k'] as const;
export type SizeBucket = (typeof SIZE_BUCKETS)[number];

/** Bucket by number of files listed by git (tracked plus untracked-not-ignored). */
export function sizeBucket(files: number): SizeBucket {
  if (files < 500) return '<500';
  if (files < 2000) return '500-2k';
  if (files < 10000) return '2k-10k';
  if (files < 50000) return '10k-50k';
  return '>=50k';
}

export function groupBy<T, K extends string>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

export function bytesToMiB(bytes: number | null | undefined): number | null {
  return bytes === null || bytes === undefined ? null : round(bytes / 1048576, 1);
}
