import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execute, type RunConfig } from '../bench/lib/execute.js';
import { splitOf } from '../bench/lib/split.js';
import { makeRepo, scratch, writeFiles } from './bench-helpers.js';

const GOOD_ENGINE = `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export class Engine {
  constructor(root) { this.root = root; }
  async context(query, budget) {
    const file = query.includes('alpha') ? 'src/alpha.py' : 'src/beta.py';
    const text = readFileSync(join(this.root, file), 'utf8');
    return { text: '--- "' + file + '":1-2 ---\\n' + text, evidence: [{ path: file, start: 1, end: 2, id: 'x' }], stats: { outputTokens: 12 } };
  }
}`;
const BAD_ENGINE = `export class Engine { constructor() {} async context() { throw new Error('boom'); } }`;

function patchFor(file: string, before: string, after: string): string {
  return ['diff --git a/' + file + ' b/' + file, '--- a/' + file, '+++ b/' + file, '@@ -1,2 +1,2 @@', ` def f():`, `-    return ${before}`, `+    return ${after}`, ''].join('\n');
}

async function fixture(t: TestContext) {
  const root = await scratch(t, 'e2e');
  const env = { RSQ_BENCH_DATA_DIR: join(root, 'data'), RSQ_BENCH_CORPUS_DIR: join(root, 'corpus'), RSQ_BENCH_REPO_URL_TEMPLATE: `file://${join(root, 'remotes')}/{dir}` };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const [c1, c2] = await makeRepo(join(root, 'remotes', 'fixture__proj'), [
    { 'src/alpha.py': 'def f():\n    return 1\n', 'src/beta.py': 'def f():\n    return 2\n' },
    { 'src/alpha.py': 'def f():\n    return 10\n' },
  ]);
  // two DEV instances of the held-out-split rule
  const ids: string[] = [];
  for (let n = 1; ids.length < 2; n++) if (splitOf(`fixture__proj-${n}`) === 'dev') ids.push(`fixture__proj-${n}`);
  const instances = [
    { instance_id: ids[0], repo: 'fixture/proj', base_commit: c1, patch: patchFor('src/alpha.py', '1', '11'), problem_statement: 'alpha returns the wrong value', created_at: '2020-01-01 00:00:00', version: '1' },
    { instance_id: ids[1], repo: 'fixture/proj', base_commit: c2, patch: patchFor('src/beta.py', '2', '22'), problem_statement: 'beta returns the wrong value', created_at: '2020-02-01 00:00:00', version: '1' },
  ];
  await mkdir(env.RSQ_BENCH_DATA_DIR, { recursive: true });
  for (const [hfSplit, rows] of [['dev', instances], ['test', []]] as const) {
    const text = rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
    await writeFile(join(env.RSQ_BENCH_DATA_DIR, `SWE-bench_Lite.${hfSplit}.jsonl`), text);
    await writeFile(join(env.RSQ_BENCH_DATA_DIR, `SWE-bench_Lite.${hfSplit}.meta.json`), JSON.stringify({ hfId: 'SWE-bench/SWE-bench_Lite', hfSplit, numRows: rows.length, sha256: createHash('sha256').update(text).digest('hex'), revision: null, fetchedAt: 'x', source: 'test' }));
  }
  const good = join(root, 'variants', 'good');
  const bad = join(root, 'variants', 'bad');
  await writeFiles(good, { 'src/engine.ts': GOOD_ENGINE });
  await writeFiles(bad, { 'src/engine.ts': BAD_ENGINE });
  const out = join(root, 'out');
  const config: RunConfig = {
    datasets: ['lite'], split: 'dev', filters: {}, seed: 1, out,
    variants: [{ name: 'good', root: good, env: {}, truncate: null }, { name: 'bad', root: bad, env: {}, truncate: 10 }],
    budget: 1000, workers: 2, timeoutSec: 120, resamples: 10_000, offline: false, retryFailed: false, savePacks: true, keepCheckouts: false,
    forceResume: false, maxOldSpaceMB: 0, prepareJobs: 1, maxLoad: 0, cloneMode: 'full', command: 'test',
  };
  return { root, out, good, ids, config };
}

const readRows = async (out: string) => (await readFile(join(out, 'rows.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('end to end: runs variants on pristine base-commit checkouts, resumes, retries failures and guards the setup', { timeout: 600_000 }, async t => {
  const { out, good, ids, config } = await fixture(t);
  const silence = t.mock.method(console, 'log', () => undefined);

  assert.equal(await execute(config), 0);
  let rows = await readRows(out);
  assert.equal(rows.length, 4);
  const goodRows = rows.filter(r => r.variant === 'good');
  const badRows = rows.filter(r => r.variant === 'bad');
  assert.ok(goodRows.every(r => r.status === 'ok' && r.metrics.packFileHit === 1 && r.metrics.goldLineRecall === 1 && r.metrics.firstGoldRank === 1));
  assert.ok(badRows.every(r => r.status === 'error' && r.error.includes('boom')));
  assert.equal(goodRows[0].outputTokens > 0 && goodRows[0].budgetViolation === false, true);

  // each instance saw its own base commit
  const pack = (id: string) => gunzipSync(readFileSync(join(out, 'packs', 'good', `${id}.txt.gz`))).toString('utf8');
  const first = rows.find(r => r.instance_id === ids[0])!;
  assert.equal(first.baseCommit.length, 40);
  assert.match(pack(ids[0]), /return 1\n/);
  assert.doesNotMatch(pack(ids[0]), /return 10/);

  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  assert.equal(report.summaries.length, 2);
  assert.equal(report.manifest.instanceCount, 2);
  assert.equal(report.manifest.cloneMode, 'full');
  assert.equal(report.manifest.datasets[0].contentSha256.length, 64);
  assert.equal(report.manifest.variants[0].fingerprint.length, 64);
  assert.ok((await readFile(join(out, 'report.md'), 'utf8')).includes('# SWE retrieval benchmark: DEV split'));

  // identical command: nothing to do
  assert.equal(await execute(config), 0);
  assert.equal((await readRows(out)).length, 4);

  // --retry-failed re-runs only the errors
  assert.equal(await execute({ ...config, retryFailed: true }), 0);
  rows = await readRows(out);
  assert.equal(rows.length, 6);
  assert.equal(rows.filter(r => r.variant === 'good').length, 2);

  // changing a variant's source invalidates the resume
  await writeFile(join(good, 'src/engine.ts'), GOOD_ENGINE + '\n// edited\n');
  await assert.rejects(execute(config), /refusing to resume.*fingerprint/);
  silence.mock.restore();
});

test('the CLI refuses the held-out split without the orchestrator flag', { timeout: 120_000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  const { BENCH_ROOT } = await import('../bench/lib/paths.js');
  const result = spawnSync(process.execPath, ['--import', 'tsx', join(BENCH_ROOT, 'run.ts'), '--split', 'test', '--variant', 'ripgrep-naive', '--out', join(BENCH_ROOT, '.scratch', 'never-created')], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /REFUSING to touch the held-out TEST split/);
});
