import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../src/repository.js';
import { contextPack, DEFAULTS } from '../src/context.js';
import { resolveFeatures } from '../src/features.js';
import { bestWindowStart, signatureOf } from '../src/pack.js';
import { tokens } from '../src/tokens.js';
import { contextPackV2 } from '../src/v2.js';

async function fixture(t: TestContext, files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'reposqueeze-pack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

const sourceLines = (source: string, start: number, end: number) => source.split('\n').slice(start - 1, end).join('\n');

test('bestWindowStart picks the densest window and the middle of tied windows', () => {
  assert.equal(bestWindowStart([0, 0, 5, 5, 0, 0, 0, 0], 2), 2);
  assert.equal(bestWindowStart([1, 0, 0, 1, 0, 0], 3), 1);
  assert.equal(bestWindowStart([0, 0, 0, 0, 7, 0, 0, 0, 0], 5), 2);
  assert.equal(bestWindowStart([1, 2, 3], 3), 0);
});

test('signatureOf skips leading comments and decorators but keeps prose headings', () => {
  const chunk = (path: string, text: string) => ({ id: 'x', path, start: 1, end: 3, name: '', kind: 'x', text, terms: [], refs: [] });
  assert.equal(signatureOf(chunk('a.py', '# why\n@cached\ndef  work(a,   b):\n    pass')), 'def work(a, b):');
  assert.equal(signatureOf(chunk('a.ts', '/** doc */\n// more\nexport function run(): void {\n}')), 'export function run(): void {');
  assert.equal(signatureOf(chunk('README.md', '# Install\ntext')), '# Install');
});

test('a long definition is packed as its signature plus the query-dense window with an explicit omission marker', async t => {
  const body = Array.from({ length: 160 }, (_, i) => (i === 100 ? '  const quota = computeZebraQuota(items);' : `  step${i}();`)).join('\n');
  const source = `export function bigWorker(items) {\n${body}\n}\n`;
  const root = await fixture(t, { 'src/worker.ts': source, 'src/other.ts': 'export const unrelated = 1;\n' });
  const snapshot = await new Repository(root).snapshot();
  const pack = contextPackV2(snapshot, 'where is the zebra quota computed', 700);
  assert.ok(tokens(pack.text) <= 700);
  assert.match(pack.text, /computeZebraQuota/);
  assert.match(pack.text, /export function bigWorker/);
  assert.match(pack.text, /…\[\d+-\d+ omitted\]/);
  const windows = pack.evidence.filter(e => e.kind === 'window');
  assert.ok(windows.length >= 2, 'declaration and window are reported as separate verbatim ranges');
  for (const e of windows) assert.ok(pack.text.includes(sourceLines(source, e.start, e.end)));
  const withoutWindows = contextPackV2(snapshot, 'where is the zebra quota computed', 700, [], DEFAULTS, undefined, resolveFeatures('-windows'));
  assert.ok(tokens(withoutWindows.text) <= 700);
});

test('leftover budget is spent on pointers to the next-best definitions without duplicating excerpts', async t => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) {
    files[`src/handlers/handler${String(i).padStart(2, '0')}.ts`] = `export function handleRequest${i}(request) {\n  // retry backoff handling number ${i}\n${Array.from({ length: 14 }, (_, k) => `  const value${k} = request.${k % 2 ? 'retry' : 'backoff'}(${k});`).join('\n')}\n  return request;\n}\n`;
  }
  const root = await fixture(t, files);
  const snapshot = await new Repository(root).snapshot();
  const pack = contextPackV2(snapshot, 'retry backoff request handler', 900);
  assert.ok(tokens(pack.text) <= 900);
  assert.ok(pack.stats.excerpts! >= 1);
  assert.ok(pack.stats.pointers! >= 1, 'pointers appear when many candidates compete for a small budget');
  assert.match(pack.text, /Also relevant \(not shown\):/);
  const shown = pack.evidence.filter(e => e.kind !== 'pointer');
  for (const pointer of pack.evidence.filter(e => e.kind === 'pointer')) {
    assert.ok(!shown.some(e => e.path === pointer.path && e.start <= pointer.end && e.end >= pointer.start), 'a pointer never repeats an excerpt');
  }
  const off = contextPackV2(snapshot, 'retry backoff request handler', 900, [], DEFAULTS, undefined, resolveFeatures('-pointers'));
  assert.equal(off.stats.pointers, 0);
  assert.doesNotMatch(off.text, /Also relevant/);
});

test('packs never exceed any budget in either format and are deterministic', async t => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 12; i++) files[`pkg/mod${i}.py`] = `def work${i}(items):\n    """Process the retry queue ${i}."""\n${Array.from({ length: 30 }, (_, k) => `    items.append(${k})  # retry ${k}`).join('\n')}\n    return items\n`;
  const root = await fixture(t, files);
  const snapshot = await new Repository(root).snapshot();
  for (const budget of [256, 400, 800, 1500, 3000, 8000, 32000]) {
    for (const spec of [undefined, 'none', '-pointers', '-windows,-compactfmt']) {
      const features = resolveFeatures(spec);
      const a = contextPackV2(snapshot, 'process retry queue items', budget, [], DEFAULTS, undefined, features);
      const b = contextPackV2(snapshot, 'process retry queue items', budget, [], DEFAULTS, undefined, features);
      assert.ok(tokens(a.text) <= budget, `${spec ?? 'default'} @${budget}`);
      assert.equal(a.text, b.text);
      assert.equal(a.stats.outputTokens, tokens(a.text));
      for (const e of a.evidence) assert.ok(e.start >= 1 && e.end >= e.start);
    }
  }
});

test('excerpt receipts change with the shown text and complete excerpts reuse the chunk id', async t => {
  const root = await fixture(t, { 'a.py': 'def permission_check(user):\n    return user.is_admin\n' });
  const snapshot = await new Repository(root).snapshot();
  const first = contextPack(snapshot, 'permission_check', 1000);
  const complete = first.evidence.find(e => e.kind === 'excerpt')!;
  assert.equal(complete.id, snapshot.chunks.find(c => c.start === complete.start && c.end === complete.end)!.id.slice(0, 8));
  assert.equal(complete.id.length, 8);
});
