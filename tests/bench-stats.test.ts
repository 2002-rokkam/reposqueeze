import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RESAMPLES, bootstrapMeans, exactMcNemarP, mcnemar, mean, mulberry32, pairedBootstrap, quantile } from '../bench/lib/stats.js';

test('mulberry32 is deterministic and roughly uniform', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 1000 }, () => b()));
  assert.ok(xs.every(x => x >= 0 && x < 1));
  assert.ok(Math.abs(mean(xs) - 0.5) < 0.05);
  assert.notDeepEqual(xs.slice(0, 5), Array.from({ length: 5 }, mulberry32(43)).slice(0, 5));
});

test('quantile uses linear interpolation', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([5], 0.9), 5);
  assert.equal(quantile([3, 1, 2], 0), 1);
  assert.ok(Number.isNaN(quantile([], 0.5)));
});

test('exact McNemar p-values match hand-computed binomial tails', () => {
  assert.equal(exactMcNemarP(0, 0), 1);
  assert.ok(Math.abs(exactMcNemarP(10, 0) - 2 / 1024) < 1e-15);
  assert.equal(exactMcNemarP(5, 5), 1);
  assert.ok(Math.abs(exactMcNemarP(1, 7) - 18 / 256) < 1e-15);
  assert.ok(Math.abs(exactMcNemarP(7, 1) - 18 / 256) < 1e-15);
  assert.ok(Math.abs(exactMcNemarP(3, 12) - 2 * (1 + 15 + 105 + 455) / 32768) < 1e-15);
  const big = exactMcNemarP(400, 500);
  assert.ok(big > 0 && big < 0.01, `p=${big}`);
  assert.ok(Number.isFinite(exactMcNemarP(5000, 4000)));
});

test('mcnemar tallies the paired contingency table', () => {
  const result = mcnemar([1, 1, 0, 0, 1, 0, 1, 1], [1, 0, 0, 1, 0, 0, 0, 0]);
  assert.deepEqual({ both: result.both, neither: result.neither, onlyA: result.onlyA, onlyB: result.onlyB }, { both: 1, neither: 2, onlyA: 4, onlyB: 1 });
  assert.equal(result.p, exactMcNemarP(4, 1));
  assert.throws(() => mcnemar([1], [1, 0]));
});

test('bootstrap intervals are reproducible, contain the mean and shrink with more data', () => {
  const rng = mulberry32(7);
  const small = Array.from({ length: 40 }, () => (rng() < 0.6 ? 1 : 0));
  const large = Array.from({ length: 1000 }, () => (rng() < 0.6 ? 1 : 0));
  const [s1] = bootstrapMeans([small], { resamples: 2000, seed: 1 });
  const [s2] = bootstrapMeans([small], { resamples: 2000, seed: 1 });
  assert.deepEqual(s1, s2);
  const [l] = bootstrapMeans([large], { resamples: 2000, seed: 1 });
  assert.ok(s1.lo <= s1.mean && s1.mean <= s1.hi);
  assert.ok(l.hi - l.lo < s1.hi - s1.lo);
  const continuous = Array.from({ length: 60 }, () => rng());
  const [c1] = bootstrapMeans([continuous], { resamples: 2000, seed: 1 });
  const [c2] = bootstrapMeans([continuous], { resamples: 2000, seed: 2 });
  assert.notDeepEqual(c1, c2);
});

test('bootstrap handles degenerate samples', () => {
  const [constant] = bootstrapMeans([[1, 1, 1, 1]], { resamples: 500 });
  assert.deepEqual(constant, { mean: 1, lo: 1, hi: 1 });
  const [single] = bootstrapMeans([[0.25]], { resamples: 500 });
  assert.equal(single.lo, 0.25);
  const [none] = bootstrapMeans([[]], { resamples: 10 });
  assert.ok(Number.isNaN(none.mean));
  assert.throws(() => bootstrapMeans([[1, 2], [1]]));
});

test('paired bootstrap reports B - A and a CI that excludes zero for a consistent gain', () => {
  const a = Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : 0));
  const b = a.map((x, i) => (i % 10 === 0 ? 1 : x)); // B is never worse and wins on ten instances
  const result = pairedBootstrap(a, b, { resamples: 4000, seed: 3 });
  assert.ok(Math.abs(result.diff - 0.1) < 1e-12);
  assert.ok(result.lo > 0, `lo=${result.lo}`);
  const same = pairedBootstrap(a, a, { resamples: 500, seed: 3 });
  assert.deepEqual([same.diff, same.lo, same.hi], [0, 0, 0]);
});

test('the default configuration uses at least 10,000 resamples with a fixed seed', () => {
  assert.ok(DEFAULT_RESAMPLES >= 10_000);
  const values = Array.from({ length: 50 }, (_, i) => i % 3);
  const first = bootstrapMeans([values]);
  const second = bootstrapMeans([values]);
  assert.deepEqual(first, second);
});
