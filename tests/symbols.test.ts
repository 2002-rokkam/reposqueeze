import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../src/repository.js';
import { findSymbols, renderOutline, renderSymbols } from '../src/symbols.js';
import { tokens } from '../src/tokens.js';

async function fixture(t: TestContext, files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'reposqueeze-symbols-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

const files = {
  'auth/permissions.ts': 'export class PermissionChecker {\n  check(user) {\n    return user.isAdmin;\n  }\n\n  deny(user) {\n    return false;\n  }\n}\n\nexport function permissionCheck(user) {\n  return new PermissionChecker().check(user);\n}\n',
  'web/routes.ts': 'export function permissionRoutes() {\n  return [];\n}\nexport const unrelated = 1;\n',
  'lib/long.ts': `export function giantWorker(items) {\n${Array.from({ length: 200 }, (_, i) => `  step${i}(items);`).join('\n')}\n  return items;\n}\n`,
};

test('findSymbols ranks exact names before prefixes before substrings and merges long definitions', async t => {
  const snapshot = await new Repository(await fixture(t, files)).snapshot();
  const exact = findSymbols(snapshot, 'permission_check');
  assert.equal(exact[0].name, 'permissionCheck');
  assert.equal(exact[0].path, 'auth/permissions.ts');
  assert.match(exact[0].signature, /^export function permissionCheck\(user\) \{/);
  const prefix = findSymbols(snapshot, 'permission');
  assert.ok(prefix.some(hit => hit.name === 'PermissionChecker'));
  assert.ok(prefix.some(hit => hit.name === 'permissionRoutes'));
  const giant = findSymbols(snapshot, 'giantWorker');
  assert.equal(giant.length, 1, 'overlapping pieces of one long function become one hit');
  assert.equal(giant[0].start, 1);
  assert.ok(giant[0].end >= 200);
  assert.deepEqual(findSymbols(snapshot, ''), []);
  assert.deepEqual(findSymbols(snapshot, 'zzzznothing'), []);
  assert.match(renderSymbols([], 500), /No definition/);
  assert.ok(tokens(renderSymbols(findSymbols(snapshot, 'permission'), 256)) <= 256);
});

test('renderOutline nests methods under their class with line ranges and respects the budget', async t => {
  const snapshot = await new Repository(await fixture(t, files)).snapshot();
  const file = snapshot.files.find(f => f.path === 'auth/permissions.ts')!;
  const outline = renderOutline(file.path, file.chunks, file.text.split('\n').length, 800);
  assert.match(outline, /^auth\/permissions\.ts · \d+ lines/);
  assert.match(outline, /\n1-9 {2}export class PermissionChecker \{/);
  assert.match(outline, /\n {2}2-4 {2}check\(user\) \{/);
  assert.match(outline, /\n {2}6-8 {2}deny\(user\) \{/);
  assert.match(outline, /\n11-13 {2}export function permissionCheck\(user\) \{/);
  assert.ok(tokens(renderOutline(file.path, file.chunks, 13, 20)) <= 20);
  assert.match(renderOutline('notes.txt', [], 4, 100), /no definitions indexed/);
});
