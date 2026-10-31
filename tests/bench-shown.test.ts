import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { computeMetrics } from '../bench/lib/metrics.js';
import { emptyRow } from '../bench/lib/execute.js';
import { backfillShownMetrics, POINTER_MARKER } from '../bench/lib/shown.js';
import type { RunRow } from '../bench/lib/report.js';

function row(id: string, variant: string, evidence: RunRow['evidence']): RunRow {
  const instance = { instanceId: id, repo: 'r/r', language: 'Python', datasets: ['lite'], split: 'dev', baseCommit: 'abc', gold: [{ path: 'a.py', ranges: [[1, 5]] }], goldLines: 5, hasCodeGold: true, mentions: { any: false, path: false, basename: false, stem: false }, statement: 'x' };
  const result = emptyRow(instance as never, variant, 4000);
  result.evidence = evidence;
  result.metrics = computeMetrics(evidence, [{ path: 'a.py', ranges: [[1, 5]] }]);
  return result;
}

test('backfillShownMetrics: recompute from kinds, trust pointer-free packs, otherwise null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rsq-shown-'));
  try {
    await mkdir(join(dir, 'packs', 'old'), { recursive: true });
    await writeFile(join(dir, 'packs', 'old', 'clean.txt.gz'), gzipSync('--- "a.py":1-5 ---\ncode'));
    await writeFile(join(dir, 'packs', 'old', 'pointers.txt.gz'), gzipSync(`code\n${POINTER_MARKER}:\n  a.py:1-5`));
    const rows = [
      row('kinds', 'new', [{ path: 'a.py', start: 1, end: 5, kind: 'pointer' }]),
      row('clean', 'old', [{ path: 'a.py', start: 1, end: 5 }]),
      row('pointers', 'old', [{ path: 'a.py', start: 1, end: 5 }]),
      row('missing', 'old', [{ path: 'a.py', start: 1, end: 5 }]),
    ];
    const [kinds, clean, pointers, missing] = await backfillShownMetrics(dir, rows);
    assert.equal(kinds.shownMetrics?.packFileHit, 0);
    assert.equal(clean.shownMetrics?.packFileHit, 1);
    assert.equal(pointers.shownMetrics, null);
    assert.equal(missing.shownMetrics, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
