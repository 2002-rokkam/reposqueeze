import test from 'node:test';
import assert from 'node:assert/strict';
import { frameImbalance, markerOutsideFrames, parsePack } from '../bench/robustness/lib/packcheck.js';
import { mulberry32, seedFrom } from '../bench/robustness/lib/prng.js';
import { distinctiveLines, findLeakedLines, scanSecrets, shannonEntropy } from '../bench/robustness/lib/secrets.js';
import { median, percentile, sizeBucket } from '../bench/robustness/lib/stats.js';
import { parseVariantSpec } from '../bench/robustness/lib/variants.js';

const FRAMED = ['header', '--- "src/a.ts":1-2 id=0123456789abcdef ---', 'const a = 1;', 'const b = 2;', '--- END SOURCE ---', 'tail note'].join('\n');

test('percentile interpolates linearly and tolerates empty or non-finite input', () => {
  assert.equal(median([]), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([1, Number.NaN, 3], 100), 3);
  assert.equal(sizeBucket(499), '<500');
  assert.equal(sizeBucket(10_000), '10k-50k');
});

test('seeded PRNG is deterministic and stays in [0, 1)', () => {
  const a = mulberry32(seedFrom('x', 1));
  const b = mulberry32(seedFrom('x', 1));
  for (let i = 0; i < 1000; i++) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1);
  }
  assert.notEqual(seedFrom('a', 'b'), seedFrom('ab'));
});

test('parseVariantSpec keeps colons in paths and commas in env values', () => {
  const variant = parseVariantSpec('cur=/tmp/a:b:RSQ_FEATURES=-prf,-git,RSQ_TOKENIZER=v1');
  assert.equal(variant.root, '/tmp/a:b');
  assert.deepEqual(variant.env, { RSQ_FEATURES: '-prf,-git', RSQ_TOKENIZER: 'v1' });
  assert.throws(() => parseVariantSpec('no-equals'));
  assert.throws(() => parseVariantSpec('bad name=/x'));
});

test('parsePack separates frames from tool-authored text', () => {
  const pack = parsePack(FRAMED);
  assert.equal(pack.excerpts.length, 1);
  assert.deepEqual([pack.excerpts[0].path, pack.excerpts[0].start, pack.excerpts[0].end], ['src/a.ts', 1, 2]);
  assert.equal(frameImbalance(FRAMED), 0);
  assert.equal(markerOutsideFrames(FRAMED, 'const a').length, 0);
  assert.equal(markerOutsideFrames(FRAMED, 'tail').length, 1);
});

test('unclosed frames and orphan END markers are counted as imbalance', () => {
  assert.equal(frameImbalance('--- "a":1-1 id=0123456789abcdef ---\nx'), 1);
  assert.equal(parsePack('').excerpts.length, 0);
  assert.equal(frameImbalance('--- END SOURCE ---'), 1);
});

test('secret scanner finds planted keys, survives long and binary-ish input', () => {
  const key = `AKIA${'Q'.repeat(16)}`;
  const hits = scanSecrets(`line one\nid = "${key}"\n`);
  assert.ok(hits.some(hit => hit.line === 2));
  const started = Date.now();
  scanSecrets('a'.repeat(200_000) + '\u0000\ufffd' + '-'.repeat(100_000));
  assert.ok(Date.now() - started < 5000, 'scanner must not backtrack catastrophically');
  assert.equal(shannonEntropy(''), 0);
  assert.ok(shannonEntropy('abcdefgh') > shannonEntropy('aaaaaaab'));
});

test('leak detection matches whole distinctive lines only', () => {
  const lines = distinctiveLines('}\nshort\nPASSWORD_CANARY_9f8e7d6c5b4a=hunter2hunter2\n');
  assert.deepEqual(lines, ['PASSWORD_CANARY_9f8e7d6c5b4a=hunter2hunter2']);
  assert.deepEqual(findLeakedLines('x\r\n  PASSWORD_CANARY_9f8e7d6c5b4a=hunter2hunter2  \r\ny', lines), lines);
  assert.deepEqual(findLeakedLines('nothing here', lines), []);
});
