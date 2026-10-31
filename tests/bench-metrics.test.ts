import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, distinctFiles, overlapLines, ZERO_METRICS } from '../bench/lib/metrics.js';

const gold = [
  { path: 'src/a.py', ranges: [[10, 14], [30, 30]] as [number, number][] },
  { path: 'src/b.py', ranges: [[5, 5]] as [number, number][] },
];

test('distinctFiles keeps first-appearance order and normalises paths', () => {
  const files = distinctFiles([{ path: './x.py' }, { path: 'y.py' }, { path: 'x.py' }, { path: 'dir\\z.py' }]);
  assert.deepEqual(files, ['x.py', 'y.py', 'dir/z.py']);
});

test('overlapLines counts shared lines of merged range lists', () => {
  assert.equal(overlapLines([[1, 10], [20, 30]], [[5, 22]]), 6 + 3);
  assert.equal(overlapLines([[1, 3]], [[4, 9]]), 0);
  assert.equal(overlapLines([], [[1, 3]]), 0);
});

test('empty pack scores zero', () => {
  assert.deepEqual(computeMetrics([], gold), ZERO_METRICS);
});

test('file hit, recall, line recall, MRR and Hit@k follow the definitions', () => {
  const evidence = [
    { path: 'src/other.py', start: 1, end: 50 },
    { path: 'src/other.py', start: 60, end: 90 },
    { path: 'src/a.py', start: 12, end: 40 },
    { path: 'src/c.py', start: 1, end: 5 },
  ];
  const m = computeMetrics(evidence, gold);
  assert.equal(m.packFileHit, 1);
  assert.equal(m.packFileRecall, 0.5);
  // gold lines: a.py 10-14 (5) + 30 (1) + b.py 5 (1) = 7; covered: a.py 12-14 (3) + 30 (1) = 4
  assert.equal(m.goldLineRecall, 4 / 7);
  assert.equal(m.packLineHit, 1);
  assert.equal(m.firstGoldRank, 2); // other.py is rank 1 although it has two excerpts
  assert.equal(m.mrr, 0.5);
  assert.deepEqual([m.hit1, m.hit3, m.hit5, m.hit10], [0, 1, 1, 1]);
});

test('a gold file present only outside the gold lines counts for file metrics but not line metrics', () => {
  const m = computeMetrics([{ path: 'src/b.py', start: 100, end: 120 }], gold);
  assert.equal(m.packFileHit, 1);
  assert.equal(m.packFileRecall, 0.5);
  assert.equal(m.goldLineRecall, 0);
  assert.equal(m.packLineHit, 0);
  assert.equal(m.mrr, 1);
});

test('rank ten is the Hit@10 boundary and rank eleven is a miss', () => {
  const filler = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.py`, start: 1, end: 2 }));
  const at11 = computeMetrics([...filler, { path: 'src/b.py', start: 5, end: 5 }], gold);
  assert.equal(at11.firstGoldRank, 11);
  assert.equal(at11.hit10, 0);
  assert.equal(at11.packFileHit, 1);
  assert.equal(at11.packLineHit, 1);
  const at10 = computeMetrics([...filler.slice(0, 9), { path: 'src/b.py', start: 5, end: 5 }], gold);
  assert.equal(at10.hit10, 1);
  assert.equal(at10.hit5, 0);
});

test('overlapping excerpts are not double counted and invalid ranges are ignored for lines only', () => {
  const evidence = [
    { path: 'src/a.py', start: 10, end: 20 },
    { path: 'src/a.py', start: 12, end: 14 },
    { path: 'src/b.py', start: Number.NaN, end: 4 },
    { path: 'src/b.py', start: 9, end: 3 },
  ];
  const m = computeMetrics(evidence, gold);
  assert.equal(m.goldLineRecall, 5 / 7);
  assert.equal(m.packFileRecall, 1);
});

test('duplicate gold paths are merged and an empty gold set yields zeros', () => {
  const m = computeMetrics([{ path: 'x.py', start: 1, end: 9 }], [{ path: 'x.py', ranges: [[1, 2]] }, { path: 'x.py', ranges: [[2, 3]] }]);
  assert.equal(m.goldLineRecall, 1);
  assert.equal(m.packFileRecall, 1);
  assert.deepEqual(computeMetrics([{ path: 'x.py', start: 1, end: 9 }], []), ZERO_METRICS);
});

test('large evidence lists and Unicode paths are handled', () => {
  const evidence = Array.from({ length: 20_000 }, (_, i) => ({ path: `dir/ファイル${i % 500}.py`, start: i + 1, end: i + 3 }));
  const m = computeMetrics(evidence, [{ path: 'dir/ファイル499.py', ranges: [[500, 502]] }]);
  assert.equal(m.packFileHit, 1);
  assert.equal(m.firstGoldRank, 500);
  assert.equal(m.hit10, 0);
});
