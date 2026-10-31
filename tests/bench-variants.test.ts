import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describeVariant, fingerprintVariant, parseVariantSpec, truncateQuery } from '../bench/lib/variants.js';
import { scratch, writeFiles } from './bench-helpers.js';

test('parses a plain variant', () => {
  const spec = parseVariantSpec('baseline=/opt/rsq/baseline');
  assert.deepEqual(spec, { name: 'baseline', root: '/opt/rsq/baseline', env: {}, truncate: null });
});

test('parses environment options and the truncation option in any combination', () => {
  const a = parseVariantSpec('current=/repo:RSQ_FEATURES=-git,REPOSQUEEZE_CACHE_DIR=/var/cache/x');
  assert.deepEqual(a.env, { RSQ_FEATURES: '-git', REPOSQUEEZE_CACHE_DIR: '/var/cache/x' });
  assert.equal(a.truncate, null);
  const b = parseVariantSpec('baseline=/repo:@truncate=8000');
  assert.equal(b.truncate, 8000);
  assert.deepEqual(b.env, {});
  const c = parseVariantSpec('v=/repo:A=1:@truncate=500,B=2');
  assert.deepEqual(c.env, { A: '1', B: '2' });
  assert.equal(c.truncate, 500);
});

test('values may contain separators as long as no KEY= follows them', () => {
  const spec = parseVariantSpec('v=/repo:PATHS=/a:/b,/c:D=4');
  assert.deepEqual(spec.env, { PATHS: '/a:/b,/c', D: '4' });
  const windows = parseVariantSpec('v=C:\\work\\repo:X=1');
  assert.equal(windows.root.endsWith('repo'), true);
  assert.equal(windows.env.X, '1');
});

test('rejects malformed specs', () => {
  assert.throws(() => parseVariantSpec('bad name=/x'), /invalid variant name/);
  assert.throws(() => parseVariantSpec('v='), /no path/);
  assert.throws(() => parseVariantSpec('v=/x:@truncate=0'), /positive integer/);
  assert.throws(() => parseVariantSpec('v=/x:@truncate=abc'), /positive integer/);
  assert.throws(() => parseVariantSpec('v=/x:@nope=1'), /unknown variant option/);
  assert.throws(() => parseVariantSpec('unknown-bare-name'), /needs a path/);
});

test('bare names select the bundled and lab variants', () => {
  const rg = parseVariantSpec('ripgrep-naive');
  assert.equal(rg.name, 'ripgrep-naive');
  assert.ok(rg.root.endsWith('/bench/variants/ripgrep-naive'));
  const baseline = parseVariantSpec('baseline');
  assert.equal(baseline.truncate, 8000);
  assert.ok(baseline.root.endsWith('/baseline'));
});

test('truncateQuery cuts to the limit without splitting a surrogate pair', () => {
  assert.equal(truncateQuery('abcdef', null), 'abcdef');
  assert.equal(truncateQuery('abcdef', 6), 'abcdef');
  assert.equal(truncateQuery('abcdef', 4), 'abcd');
  const emoji = 'a😀b'; // 'a' + surrogate pair + 'b'
  assert.equal(truncateQuery(emoji, 2), 'a');
  assert.equal(truncateQuery(emoji, 3), 'a😀');
  assert.equal(truncateQuery('x'.repeat(100_000), 8000).length, 8000);
});

test('fingerprint tracks engine sources and ignores unrelated files', async t => {
  const root = await scratch(t, 'variant');
  await writeFiles(root, { 'src/engine.ts': 'export class Engine {}', 'package.json': '{"version":"1.2.3"}', 'README.md': 'x' });
  const first = await fingerprintVariant(root);
  assert.equal(await fingerprintVariant(root), first);
  await writeFiles(root, { 'README.md': 'changed', 'notes.txt': 'new' });
  assert.equal(await fingerprintVariant(root), first);
  await writeFiles(root, { 'src/engine.ts': 'export class Engine { x = 1 }' });
  assert.notEqual(await fingerprintVariant(root), first);
});

test('describeVariant reports version and fingerprint and rejects roots without an engine', async t => {
  const root = await scratch(t, 'variant');
  await writeFiles(root, { 'src/engine.ts': 'export class Engine {}', 'variant.json': '{"version":"9.9.9"}' });
  const info = await describeVariant({ name: 'v', root, env: { A: '1' }, truncate: 100 });
  assert.equal(info.engineVersion, '9.9.9');
  assert.equal(info.fingerprint.length, 64);
  assert.deepEqual(info.env, { A: '1' });
  await mkdir(join(root, 'empty'), { recursive: true });
  await assert.rejects(describeVariant({ name: 'v', root: join(root, 'empty'), env: {}, truncate: null }), /engine\.ts not found/);
});
