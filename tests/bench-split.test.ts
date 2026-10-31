import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildSplitsFile, splitOf, verifySplitsFile, SPLIT_SALT } from '../bench/lib/split.js';
import { mergeInstances, normalizeRow, type DatasetInstance, type LoadedDataset } from '../bench/lib/dataset.js';
import { prepareSplit } from '../bench/lib/gold.js';

function dataset(key: 'lite' | 'verified', ids: string[]): LoadedDataset {
  const instances: DatasetInstance[] = ids.map(id => normalizeRow({
    instance_id: id, repo: 'o/r', base_commit: 'c'.repeat(40), problem_statement: 'p', created_at: '2020-01-01', version: '1',
    patch: 'diff --git a/src/a.py b/src/a.py\n--- a/src/a.py\n+++ b/src/a.py\n@@ -1,1 +1,1 @@\n-a\n+b\n',
  }, key, 'test'));
  return { key, hfId: `x/${key}`, revision: null, files: [], contentSha256: 'f'.repeat(64), instances };
}

test('the split rule is the parity of the first SHA-256 byte of "rsq-v3:" + id (golden values)', () => {
  assert.equal(SPLIT_SALT, 'rsq-v3:');
  const golden: Record<string, 'dev' | 'test'> = {
    'django__django-11099': 'test', 'astropy__astropy-12907': 'dev', 'pallets__flask-4992': 'test',
    'psf__requests-2317': 'dev', 'gin-gonic__gin-3612': 'dev', a: 'dev', b: 'dev', c: 'test',
  };
  for (const [id, expected] of Object.entries(golden)) assert.equal(splitOf(id), expected, id);
  for (const id of ['x', 'y', 'ünïcödé-1', '']) {
    const first = createHash('sha256').update(`rsq-v3:${id}`).digest()[0];
    assert.equal(splitOf(id), first % 2 === 0 ? 'dev' : 'test');
  }
});

test('the split is balanced, deterministic and independent of input order', () => {
  const ids = Array.from({ length: 10_000 }, (_, i) => `repo__name-${i}`);
  const dev = ids.filter(id => splitOf(id) === 'dev').length;
  assert.ok(dev > 4800 && dev < 5200, `dev fraction ${dev / ids.length}`);
  const a = buildSplitsFile([dataset('lite', ids.slice(0, 500))]);
  const b = buildSplitsFile([dataset('lite', [...ids.slice(0, 500)].reverse())]);
  assert.deepEqual(a, b);
  assert.deepEqual(verifySplitsFile(a), []);
});

test('verifySplitsFile catches tampering', () => {
  const file = buildSplitsFile([dataset('lite', ['a', 'c'])]);
  assert.deepEqual(file.datasets.lite.dev, ['a']);
  assert.deepEqual(file.datasets.lite.test, ['c']);
  file.datasets.lite.dev.push('c');
  assert.ok(verifySplitsFile(file).length >= 1);
});

test('an instance present in two datasets gets one split and lists both datasets', () => {
  const merged = mergeInstances([dataset('lite', ['a', 'c']), dataset('verified', ['c', 'b'])]);
  assert.deepEqual(merged.map(i => i.instanceId), ['a', 'b', 'c']);
  assert.deepEqual(merged.find(i => i.instanceId === 'c')!.datasets, ['lite', 'verified']);
});

test('prepareSplit only looks at the requested split and reports skip reasons', () => {
  const ok = dataset('lite', ['a', 'b', 'c']).instances;
  const testOnly: DatasetInstance = { ...ok[0], instanceId: 'dev-only-tests', patch: 'diff --git a/tests/test_a.py b/tests/test_a.py\n--- a/tests/test_a.py\n+++ b/tests/test_a.py\n@@ -1,1 +1,1 @@\n-a\n+b\n' };
  const newOnly: DatasetInstance = { ...ok[0], instanceId: 'dev-new-file', patch: 'diff --git a/n.py b/n.py\nnew file mode 100644\n--- /dev/null\n+++ b/n.py\n@@ -0,0 +1 @@\n+x\n' };
  const empty: DatasetInstance = { ...ok[0], instanceId: 'dev-empty', patch: '' };
  const all = [...ok, testOnly, newOnly, empty];
  const dev = prepareSplit(all, 'dev');
  const ids = dev.prepared.map(p => p.instanceId);
  for (const id of ids) assert.equal(splitOf(id), 'dev');
  assert.ok(!ids.includes('c'), 'held-out instance leaked into the dev selection');
  const skippedFor = (id: string) => dev.skipped.find(s => s.instanceId === id)?.reason;
  const expected = (id: string, reason: string) => {
    if (splitOf(id) === 'dev') assert.equal(skippedFor(id), reason, id);
  };
  expected('dev-only-tests', 'only_test_files');
  expected('dev-new-file', 'only_new_files');
  expected('dev-empty', 'empty_patch');
  assert.equal(dev.stats.total, dev.stats.selected + dev.skipped.length);
});
