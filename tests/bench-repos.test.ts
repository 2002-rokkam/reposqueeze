import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CheckoutSlot, missingCommits, prepareRepo, repoDirName, repoUrl } from '../bench/lib/repos.js';
import { git, makeRepo, scratch } from './bench-helpers.js';

const exists = (path: string) => access(path).then(() => true, () => false);

/** Points the corpus and the "GitHub" remote at scratch directories for the duration of a test. */
async function lab(t: TestContext) {
  const root = await scratch(t, 'repos');
  const previous = { corpus: process.env.RSQ_BENCH_CORPUS_DIR, template: process.env.RSQ_BENCH_REPO_URL_TEMPLATE };
  process.env.RSQ_BENCH_CORPUS_DIR = join(root, 'corpus');
  process.env.RSQ_BENCH_REPO_URL_TEMPLATE = `file://${join(root, 'remotes')}/{dir}`;
  t.after(() => {
    if (previous.corpus === undefined) delete process.env.RSQ_BENCH_CORPUS_DIR;
    else process.env.RSQ_BENCH_CORPUS_DIR = previous.corpus;
    if (previous.template === undefined) delete process.env.RSQ_BENCH_REPO_URL_TEMPLATE;
    else process.env.RSQ_BENCH_REPO_URL_TEMPLATE = previous.template;
  });
  const shas = await makeRepo(join(root, 'remotes', 'fixture__proj'), [
    { 'src/a.py': 'v1\n', 'keep.txt': 'k\n' },
    { 'src/a.py': 'v2\n' },
    { 'src/a.py': 'v3\n', 'future.txt': 'only in the fix commit\n' },
  ]);
  return { root, shas, corpus: join(root, 'corpus') };
}

test('repository names map to stable directory names and clone URLs', () => {
  assert.equal(repoDirName('BurntSushi/ripgrep'), 'burntsushi__ripgrep');
  const previous = process.env.RSQ_BENCH_REPO_URL_TEMPLATE;
  delete process.env.RSQ_BENCH_REPO_URL_TEMPLATE;
  assert.equal(repoUrl('pallets/flask'), 'https://github.com/pallets/flask.git');
  if (previous !== undefined) process.env.RSQ_BENCH_REPO_URL_TEMPLATE = previous;
});

test('prepareRepo clones once, reports commit times, and is offline-capable afterwards', { timeout: 120_000 }, async t => {
  const { shas } = await lab(t);
  const state = await prepareRepo('Fixture/Proj', [shas[0], shas[1]], { minFreeGiB: 0 });
  assert.equal(state.error, undefined);
  assert.deepEqual(state.missing, []);
  assert.equal(state.commitTimes.size, 2);
  assert.ok([...state.commitTimes.values()].every(seconds => seconds > 1_600_000_000));
  assert.deepEqual(await missingCommits(state.dir, [shas[2], '0'.repeat(40)]), ['0'.repeat(40)]);
  const offline = await prepareRepo('fixture/proj', [shas[0]], { offline: true });
  assert.deepEqual(offline.missing, []);
  const unknown = await prepareRepo('fixture/proj', ['1'.repeat(40)], { offline: true });
  assert.deepEqual(unknown.missing, ['1'.repeat(40)]);
  const absent = await prepareRepo('nobody/nothing', [shas[0]], { offline: true });
  assert.match(absent.error ?? '', /not cloned/);
});

test('a checkout slot is pristine, private and cannot see commits newer than its base commit', { timeout: 120_000 }, async t => {
  const { shas } = await lab(t);
  const state = await prepareRepo('fixture/proj', shas, { minFreeGiB: 0 });
  const slot = new CheckoutSlot('fixture/proj', state.dir, 'test-slot');
  t.after(() => slot.dispose());

  await slot.checkout(shas[1]);
  assert.equal(await readFile(join(slot.dir, 'src/a.py'), 'utf8'), 'v2\n');
  assert.equal(await exists(join(slot.dir, 'future.txt')), false);
  assert.equal(git(slot.dir, 'rev-parse', 'HEAD'), shas[1]);
  assert.equal(git(slot.dir, 'for-each-ref'), '', 'no refs: nothing to enumerate');
  assert.equal(git(slot.dir, 'log', '--all', '--topo-order', '--format=%H'), `${shas[1]}\n${shas[0]}`, 'git log --all shows only ancestors of the base commit');
  assert.throws(() => git(slot.dir, 'rev-parse', '--verify', 'main'));
  assert.throws(() => git(slot.dir, 'describe', '--all', '--contains', shas[2]));
  assert.equal(await exists(join(slot.dir, '.git', 'logs')), false, 'no reflog that could reveal other checkouts');

  // whatever a variant writes into the checkout is gone before the next run
  await writeFile(join(slot.dir, 'src/a.py'), 'modified by a variant\n');
  await writeFile(join(slot.dir, 'cache.bin'), 'x');
  await slot.reset();
  assert.equal(await readFile(join(slot.dir, 'src/a.py'), 'utf8'), 'v2\n');
  assert.equal(await exists(join(slot.dir, 'cache.bin')), false);
  assert.equal(git(slot.dir, 'status', '--porcelain', '--ignored'), '');

  // moving to another commit is incremental and still isolated
  await slot.checkout(shas[0]);
  assert.equal(await readFile(join(slot.dir, 'src/a.py'), 'utf8'), 'v1\n');
  assert.equal(git(slot.dir, 'log', '--all', '--topo-order', '--format=%H'), shas[0]);
});

test('shallow mode fetches only the requested snapshots and slots stop history cleanly', { timeout: 120_000 }, async t => {
  const { shas } = await lab(t);
  const state = await prepareRepo('fixture/proj', [shas[1]], { cloneMode: 'shallow', minFreeGiB: 0 });
  assert.equal(state.error, undefined);
  assert.deepEqual(state.missing, []);
  assert.equal(git(state.dir, 'rev-list', '--count', shas[1]), '1');
  assert.deepEqual(await missingCommits(state.dir, [shas[0], shas[2]]), [shas[0], shas[2]]);
  const slot = new CheckoutSlot('fixture/proj', state.dir, 'shallow-slot');
  t.after(() => slot.dispose());
  await slot.checkout(shas[1]);
  assert.equal(await readFile(join(slot.dir, 'src/a.py'), 'utf8'), 'v2\n');
  assert.equal(git(slot.dir, 'log', '--all', '--topo-order', '--format=%H'), shas[1], 'history ends at the snapshot without errors');
  const again = await prepareRepo('fixture/proj', [shas[1], shas[2]], { cloneMode: 'shallow', minFreeGiB: 0 });
  assert.deepEqual(again.missing, []);
});
