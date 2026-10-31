import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Repository } from '../src/repository.js';
import { SearchIndex } from '../src/search-index.js';
import { queryViews } from '../src/v2.js';
import { terms } from '../src/tokenize.js';
import type { Chunk, Snapshot } from '../src/types.js';
import { SearchIndex as LegacyIndex } from './helpers/legacy-index.js';
import { digest } from './helpers/snapshot-digest.js';

const run = promisify(execFile);
const cacheDir = mkdtempSync(join(tmpdir(), 'reposqueeze-index-cache-'));
process.env.REPOSQUEEZE_CACHE_DIR = cacheDir;
after(() => { rmSync(cacheDir, { recursive: true, force: true }); });

async function scratch(t: TestContext, prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await chmod(dir, 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  return dir;
}

/** A repository with a few dozen files covering classes, functions, Unicode, CRLF, long lines and noise. */
async function fixture(t: TestContext) {
  const root = await scratch(t, 'reposqueeze-index-repo-');
  const write = async (path: string, text: string) => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  };
  for (let i = 0; i < 30; i++) {
    await write(`src/module${i}/service${i}.ts`, [
      `export class Service${i} {`,
      `  fetchUser${i}(id: string) { return lookupRecord(id, ${i}); }`,
      `  retryBackoff(attempt: number) { return Math.min(2 ** attempt, ${100 + i}); }`,
      '}',
      `export function lookupRecord(id: string, shard: number) { return id + shard + 'cache${i % 3}'; }`,
      ''
    ].join('\n'));
  }
  await write('py/worker.py', 'class Worker:\n    def run_job(self, payload):\n        return payload.get("retry_count", 0)\n');
  await write('docs/ünïcode.md', '# Naïve façade\nDie Größe der Straße — 日本語のテキスト retry backoff\n');
  await write('crlf.ts', 'export function windowsLines() {\r\n  return 1;\r\n}\r\nexport const second = 2;\r\n');
  await write('long.ts', `export const blob = "${'x'.repeat(1500)}";\nexport function afterBlob() { return blob.length; }\n`);
  await write('noise.bin.txt', Array.from({ length: 4000 }, (_, i) => String.fromCharCode(33 + ((i * 7919) % 90))).join(''));
  await write('redos.ts', `export const pattern = "${'a'.repeat(1200)}!";\n// ${'(a+)+$'.repeat(100)}\n`);
  return root;
}

const QUERIES = [
  'fetchUser7 lookupRecord retry backoff', 'Service12 class attempt', 'run_job payload retry_count', 'Größe Straße 日本語',
  'windowsLines second', 'afterBlob blob length', 'nonexistent_term_zzz', '', 'lookupRecord lookupRecord lookupRecord',
];

function sameRanking(actual: { chunk: Chunk; score: number }[], expected: { chunk: Chunk; score: number }[], label: string) {
  assert.equal(actual.length, expected.length, `${label}: result count`);
  actual.forEach((row, i) => {
    assert.equal(row.chunk.id, expected[i].chunk.id, `${label}: chunk at rank ${i}`);
    assert.equal(row.score, expected[i].score, `${label}: score at rank ${i}`);
  });
}

test('SearchIndex matches the legacy linear-scan index on a real repository for plain and weighted queries', async t => {
  const snapshot = await new Repository(await fixture(t)).snapshot('lookupRecord');
  const index = SearchIndex.build(snapshot), legacy = LegacyIndex.build(snapshot);
  assert.equal(index.chunkCount, legacy.chunkCount);
  for (const query of QUERIES) {
    const words = terms(query);
    const weighted = words.map((term, i) => ({ term, weight: 0.25 + (i % 4) * 0.5 }));
    for (const options of [{}, { symbolWeight: 3.5, pathWeight: 1 }, { k1: 2, b: 0.3, limit: 5 }, { limit: 1000 }]) {
      sameRanking(index.retrieve(words, options), legacy.retrieve(words, options), `${query} ${JSON.stringify(options)}`);
      sameRanking(index.retrieve(weighted, options), legacy.retrieve(weighted, options), `weighted ${query} ${JSON.stringify(options)}`);
    }
    for (const view of queryViews(query)) sameRanking(index.retrieve(terms(view)), legacy.retrieve(terms(view)), `view ${view}`);
  }
  for (const word of ['retry', 'lookuprecord', 'service7', 'zzz', 'src']) {
    assert.equal(index.documentFrequency(word), legacy.documentFrequency(word), word);
    assert.equal(index.idf(word), legacy.idf(word), word);
  }
});

test('SearchIndex works on hand-built snapshots that only carry chunk.terms', () => {
  const make = (id: string, path: string, name: string, text: string): Chunk => ({ id, path, start: 1, end: 3, name, kind: 'function', text, terms: terms(text), refs: [] });
  const chunks = [
    make('a', 'src/a.ts', 'alpha', 'alpha beta beta gamma'),
    make('b', 'src/b.ts', 'beta', 'beta delta delta delta'),
    make('c', 'lib/c.ts', '', 'gamma gamma gamma epsilon alpha'),
    make('d', 'lib/d.ts', 'delta', ''),
  ];
  const snapshot = { files: [], chunks, revision: 'x', skipped: 0, truncated: false, warnings: [], root: '/', elapsedMs: 0 } as Snapshot;
  const index = SearchIndex.build(snapshot), legacy = LegacyIndex.build(snapshot);
  assert.equal(SearchIndex.build(snapshot), index, 'memoized per snapshot');
  for (const query of [['alpha'], ['beta', 'delta'], ['gamma', 'src', 'lib'], ['missing'], [], ['delta', 'delta', 'alpha']]) {
    sameRanking(index.retrieve(query), legacy.retrieve(query), query.join(' '));
    sameRanking(index.retrieve(query.map((term, i) => ({ term, weight: 1 + i }))), legacy.retrieve(query.map((term, i) => ({ term, weight: 1 + i }))), `w ${query.join(' ')}`);
  }
  assert.equal(index.termFrequency(chunks[0], 'beta'), 2);
  assert.equal(index.termFrequency(chunks[0], 'epsilon'), 0);
  assert.ok(index.hasTerm(chunks[2], 'gamma') && !index.hasTerm(chunks[3], 'gamma'));
  assert.deepEqual(index.chunkTerms(chunks[0]), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(index.chunkTerms({ ...chunks[0] }), [], 'foreign chunk objects have no row');
  assert.equal(index.retrieve(['alpha'], { limit: 0 }).length, 0);
});

test('SearchIndex per-chunk term accessors agree with chunk.terms', async t => {
  const snapshot = await new Repository(await fixture(t)).snapshot('retry');
  const index = SearchIndex.build(snapshot);
  for (const chunk of snapshot.chunks.filter((_, i) => i % 7 === 0)) {
    const expected = new Map<string, number>();
    for (const term of chunk.terms) expected.set(term, (expected.get(term) ?? 0) + 1);
    assert.deepEqual(index.chunkTerms(chunk).sort(), [...expected.keys()].sort(), chunk.id);
    for (const [term, count] of expected) assert.equal(index.termFrequency(chunk, term), count, `${chunk.id} ${term}`);
    assert.equal(index.hasTerm(chunk, 'qqqqnotaterm'), false);
  }
});

test('BM25+ delta raises scores of matching chunks and is neutral at zero', () => {
  const chunk: Chunk = { id: 'a', path: 'a.ts', start: 1, end: 1, name: '', kind: 'x', text: 'alpha', terms: ['alpha'], refs: [] };
  const snapshot = { files: [], chunks: [chunk], revision: 'x', skipped: 0, truncated: false, warnings: [], root: '/', elapsedMs: 0 } as Snapshot;
  const index = SearchIndex.build(snapshot);
  const base = index.retrieve(['alpha'])[0].score;
  assert.equal(index.retrieve(['alpha'], { delta: 0 })[0].score, base);
  assert.ok(index.retrieve(['alpha'], { delta: 1 })[0].score > base);
});

test('snapshots are identical cold, warm and after a process restart', async t => {
  const root = await fixture(t);
  const query = 'fetchUser7 retry backoff lookupRecord';
  const cold = await digest(root, query);
  assert.match(cold.diagnostics.join(' '), /parsed/);
  const warm = await digest(root, query);
  const strip = ({ diagnostics, ...rest }: typeof cold) => rest;
  assert.deepEqual(strip(warm), strip(cold));
  assert.match(warm.diagnostics.join(' '), /\d+ indexed files reused, 0 parsed/);
  const { stdout } = await run(process.execPath, ['--import', 'tsx', 'tests/helpers/snapshot-digest.ts', root, query], { env: process.env, maxBuffer: 1 << 24 });
  assert.deepEqual(strip(JSON.parse(stdout)), strip(cold));
  // A completely different cache directory (a cold start) must give the same bytes as the warm cache.
  const other = await scratch(t, 'reposqueeze-index-other-');
  const { stdout: fresh } = await run(process.execPath, ['--import', 'tsx', 'tests/helpers/snapshot-digest.ts', root, query], { env: { ...process.env, REPOSQUEEZE_CACHE_DIR: other }, maxBuffer: 1 << 24 });
  assert.deepEqual(strip(JSON.parse(fresh)), strip(cold));
  const off = await run(process.execPath, ['--import', 'tsx', 'tests/helpers/snapshot-digest.ts', root, query], { env: { ...process.env, REPOSQUEEZE_CACHE_DIR: 'off' }, maxBuffer: 1 << 24 });
  assert.deepEqual(strip(JSON.parse(off.stdout)), strip(cold));
});

test('an edited file is re-indexed alone and changes the revision', async t => {
  const root = await fixture(t);
  const before = await digest(root, 'lookupRecord');
  await writeFile(join(root, 'src/module3/service3.ts'), 'export function brandNewSymbol() { return 42; }\n');
  const edited = await digest(root, 'brandNewSymbol');
  assert.notEqual(edited.revision, before.revision);
  assert.notEqual(edited.chunkDigest, before.chunkDigest);
  assert.match(edited.diagnostics.join(' '), / 1 parsed/);
});

test('an unwritable or nonexistent cache location degrades to in-memory indexing with identical results', async t => {
  const root = await fixture(t);
  const query = 'retry backoff';
  const expected = await digest(root, query);
  const strip = ({ diagnostics, ...rest }: typeof expected) => rest;
  const readOnly = await scratch(t, 'reposqueeze-index-ro-');
  await chmod(readOnly, 0o500);
  const home = join(readOnly, 'no', 'such', 'home');
  const environments: Record<string, NodeJS.ProcessEnv> = {
    'read-only cache dir': { ...process.env, REPOSQUEEZE_CACHE_DIR: readOnly },
    'nonexistent cache dir under a read-only parent': { ...process.env, REPOSQUEEZE_CACHE_DIR: join(readOnly, 'sub') },
    'nonexistent HOME': { ...process.env, REPOSQUEEZE_CACHE_DIR: '', HOME: home, USERPROFILE: home, XDG_CACHE_HOME: '', LOCALAPPDATA: '' },
  };
  for (const [label, env] of Object.entries(environments)) {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', resolve('tests/helpers/snapshot-digest.ts'), root, query], { env, maxBuffer: 1 << 24 });
    assert.deepEqual(strip(JSON.parse(stdout)), strip(expected), label);
  }
});

test('concurrent snapshots and concurrent processes on one cold cache all agree', async t => {
  const root = await fixture(t);
  const query = 'service retry lookupRecord';
  const shared = await scratch(t, 'reposqueeze-index-shared-');
  const env = { ...process.env, REPOSQUEEZE_CACHE_DIR: shared };
  const children = await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, ['--import', 'tsx', resolve('tests/helpers/snapshot-digest.ts'), root, query], { env, maxBuffer: 1 << 24 })));
  const digests = children.map(child => JSON.parse(child.stdout));
  const strip = ({ diagnostics, ...rest }: (typeof digests)[number]) => rest;
  for (const other of digests) assert.deepEqual(strip(other), strip(digests[0]));
  // Same repository object, overlapping calls: they are serialized and return equal snapshots.
  const repository = new Repository(root);
  const snapshots = await Promise.all([repository.snapshot(query), repository.snapshot(query), repository.snapshot('other')]);
  assert.equal(snapshots[0].revision, snapshots[1].revision);
  assert.deepEqual(snapshots[0].chunks.map(chunk => chunk.id), snapshots[2].chunks.map(chunk => chunk.id));
  const warm = await digest(root, query);
  assert.equal(warm.revision, digests[0].revision);
});
