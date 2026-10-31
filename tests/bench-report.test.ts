import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, type Manifest, type RunRow } from '../bench/lib/report.js';
import { renderMarkdown } from '../bench/lib/render.js';
import { computeMetrics } from '../bench/lib/metrics.js';
import type { VariantInfo } from '../bench/lib/variants.js';

const GOLD = { 'a.py': [[1, 2]] as [number, number][] };

function row(id: string, variant: string, hit: boolean, over: Partial<RunRow> = {}): RunRow {
  const evidence = [{ path: hit ? 'a.py' : 'other.py', start: 1, end: 5 }];
  return {
    instance_id: id, repo: 'o/r', language: 'Python', datasets: ['lite'], split: 'dev', variant, status: 'ok', baseCommit: 'c',
    goldFiles: ['a.py'], goldLines: 2, goldRanges: GOLD, hasCodeGold: true,
    mentions: { path: false, basename: false, stem: false, any: false }, queryChars: 10, queryTruncatedTo: null,
    packedFiles: evidence.map(e => e.path), numExcerpts: 1, evidence, metrics: computeMetrics(evidence, [{ path: 'a.py', ranges: GOLD['a.py'] }]),
    outputTokens: 100, reportedOutputTokens: 100, budget: 4000, budgetViolation: false, ms: 1000, cpuMs: 500, load1: 3, wallMs: 1200, rssMB: 300, rssBaseMB: 100,
    ...over,
  };
}

function variant(name: string): VariantInfo {
  return { name, root: `/v/${name}`, env: {}, truncate: null, gitSha: 'a'.repeat(40), gitBranch: 'main', dirty: false, engineVersion: '1.0.0', fingerprint: 'f'.repeat(64) };
}

function manifest(variants: string[]): Manifest {
  return {
    schema: 'rsq-bench-swe/1', command: 'test', startedAt: '2026-01-01T00:00:00Z', resumes: [], node: 'v25', platform: 'darwin', arch: 'arm64', cpus: 8, memGiB: 16,
    harness: { gitSha: 'b'.repeat(40), dirty: false }, split: 'dev', seed: 1, bootstrapResamples: 1000, budget: 4000, timeoutSec: 120, workers: 2, cloneMode: 'full', corpus: { 'o/r': 'full' },
    datasets: [{ key: 'lite', hfId: 'SWE-bench/SWE-bench_Lite', revision: 'abc', contentSha256: 'c'.repeat(64), files: [], total: 5, dev: 3, test: 2, prepared: 3, selected: 3 }],
    filters: {}, instanceCount: 3, instancesSha256: 'd'.repeat(64), skipped: { only_new_files: 1 }, unavailable: [], variants: variants.map(variant), notes: [],
  };
}

const rows = [
  row('i1', 'A', true), row('i2', 'A', true), row('i3', 'A', false),
  row('i1', 'B', true), row('i2', 'B', false, { status: 'timeout', error: 'timed out after 120000 ms', outputTokens: 0, ms: 120000 }), row('i3', 'B', true, { language: 'Go', mentions: { path: true, basename: true, stem: true, any: true }, budgetViolation: true }),
  row('i9', 'A', true, { status: 'infra', error: 'checkout failed' }), row('i9', 'B', true, { status: 'infra', error: 'checkout failed' }),
];

test('summaries count failures, ignore infrastructure rows and bootstrap the means', () => {
  const report = buildReport(manifest(['A', 'B']), rows, { resamples: 2000, seed: 5 });
  const [a, b] = report.summaries;
  assert.equal(a.n, 3);
  assert.equal(b.n, 3);
  assert.equal(b.timeouts, 1);
  assert.equal(b.errors, 0);
  assert.equal(b.budgetViolations, 1);
  assert.ok(Math.abs(a.metrics.packFileHit.mean - 2 / 3) < 1e-12);
  assert.ok(Math.abs(b.metrics.packFileHit.mean - 2 / 3) < 1e-12);
  assert.ok(a.metrics.packFileHit.lo <= a.metrics.packFileHit.mean && a.metrics.packFileHit.mean <= a.metrics.packFileHit.hi);
  assert.equal(b.seconds.mean, 1, 'timed-out runs do not pollute the latency of completed runs');
  assert.equal(a.cpuSeconds.mean, 0.5);
  assert.equal(a.load1, 3);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].status, 'timeout');
});

test('paired comparison reports discordant pairs and an exact McNemar p-value', () => {
  const report = buildReport(manifest(['A', 'B']), rows, { resamples: 2000, seed: 5 });
  const [pair] = report.pairs;
  assert.equal(pair.n, 3);
  const hit = pair.rows.find(r => r.metric === 'packFileHit')!;
  assert.deepEqual(hit.mcnemar, { onlyA: 1, onlyB: 1, p: 1 });
  assert.equal(hit.diff, 0);
  const tokens = pair.rows.find(r => r.metric === 'outputTokens')!;
  assert.ok(Math.abs(tokens.diff - (-100 / 3)) < 1e-9, `tokens diff ${tokens.diff}`);
  assert.equal(pair.rows.find(r => r.metric === 'MRR')!.mcnemar, undefined);
});

test('group tables and the bias indicator', () => {
  const report = buildReport(manifest(['A', 'B']), rows, { resamples: 1000, seed: 5 });
  const language = report.tables.find(t => t.dimension === 'language')!;
  assert.deepEqual(Object.keys(language.groups), ['Go', 'Python']);
  assert.equal(language.groups.Go.B.n, 1);
  assert.equal(language.groups.Go.B.means.packFileHit, 1);
  assert.equal(language.groups.Python.B.failures, 1);
  assert.equal(language.groups.Go.A.n, 0, 'a variant without rows in a group has an empty cell');
  assert.equal(report.bias.instances, 3);
  assert.equal(report.bias.mentionsAny, 1);
  assert.equal(report.bias.codeGoldInstances, 3);
});

test('markdown contains the identity, tables and honest notes', () => {
  const report = buildReport(manifest(['A', 'B']), rows, { resamples: 1000, seed: 5 });
  const markdown = renderMarkdown(report);
  for (const expected of ['# SWE retrieval benchmark: DEV split', 'SWE-bench/SWE-bench_Lite', '## Variants', '## Paired comparisons', 'Paired over 3 common instances', '## Bias indicator', '## By language', '## Failures', 'only_new_files=1', 'Budget violations']) {
    assert.ok(markdown.includes(expected), `missing: ${expected}`);
  }
  const compact = renderMarkdown(report, { compact: true });
  assert.ok(!compact.includes('## By repo'));
  assert.ok(compact.length < markdown.length);
});

test('a single variant produces no pairs and an empty selection produces NaN-free output', () => {
  const single = buildReport(manifest(['A']), rows.filter(r => r.variant === 'A'), { resamples: 500, seed: 1 });
  assert.equal(single.pairs.length, 0);
  const empty = buildReport(manifest(['A']), [], { resamples: 500, seed: 1 });
  assert.equal(empty.summaries[0].n, 0);
  assert.doesNotThrow(() => renderMarkdown(empty));
});
