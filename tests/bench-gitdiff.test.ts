import test from 'node:test';
import assert from 'node:assert/strict';
import { goldFromDiff, mergeRanges, parseUnifiedDiff } from '../bench/lib/gitdiff.js';

/** Builds a hunk whose header counts are derived from the body, so fixtures cannot drift. */
function hunk(oldStart: number, newStart: number, body: string[], section = ''): string {
  const oldCount = body.filter(line => line[0] === ' ' || line[0] === '-').length;
  const newCount = body.filter(line => line[0] === ' ' || line[0] === '+').length;
  return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${section}`, ...body].join('\n');
}

function modify(path: string, ...hunks: string[]): string {
  return [`diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`, ...hunks, ''].join('\n');
}

test('modification hunks yield the removed pre-image lines only', () => {
  const patch = modify('pkg/mod.py',
    hunk(10, 10, [' a', ' b', ' c', '-d = 4', '+d = 5', ' e', ' f', ' g'], ' def foo():'),
    hunk(40, 40, [' x', ' y', '-old1', '-old2', '+new1', ' z']));
  const [file] = parseUnifiedDiff(patch);
  assert.equal(file.oldPath, 'pkg/mod.py');
  assert.equal(file.kind, 'modified');
  assert.equal(file.hunks.length, 2);
  const { gold } = goldFromDiff([file]);
  assert.deepEqual(gold[0].ranges, [[13, 13], [42, 43]]);
  assert.equal(gold[0].lineCount, 3);
});

test('pure insertions are anchored on the context lines around the insertion point', () => {
  const patch = modify('a.go', hunk(20, 20, [' one', ' two', ' three', '+added1', '+added2', ' four', ' five', ' six']));
  const { gold } = goldFromDiff(parseUnifiedDiff(patch));
  assert.deepEqual(gold[0].ranges, [[22, 23]]);
});

test('an insertion at the end of the file has only the preceding anchor', () => {
  const patch = modify('a.rs', hunk(7, 7, [' one', ' two', ' last', '+tail']));
  const { gold } = goldFromDiff(parseUnifiedDiff(patch));
  assert.deepEqual(gold[0].ranges, [[9, 9]]);
});

test('zero-context insertions use the line named by the hunk header', () => {
  const patch = ['diff --git a/x.c b/x.c', '--- a/x.c', '+++ b/x.c', '@@ -10,0 +11,2 @@', '+int a;', '+int b;', ''].join('\n');
  const { gold } = goldFromDiff(parseUnifiedDiff(patch));
  assert.deepEqual(gold[0].ranges, [[10, 10]]);
});

test('hunk headers without counts mean one line', () => {
  const patch = ['diff --git a/x.c b/x.c', '--- a/x.c', '+++ b/x.c', '@@ -5 +5 @@', '-old', '+new', ''].join('\n');
  const [file] = parseUnifiedDiff(patch);
  assert.deepEqual(file.hunks[0].editRanges, [[5, 5]]);
});

test('new files are skipped, deleted files cover every removed line', () => {
  const added = ['diff --git a/new.py b/new.py', 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', '+++ b/new.py', '@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\n');
  const deleted = ['diff --git a/old.py b/old.py', 'deleted file mode 100644', 'index 1111111..0000000', '--- a/old.py', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-a', '-b', '-c', ''].join('\n');
  const result = goldFromDiff(parseUnifiedDiff(added + deleted));
  assert.deepEqual(result.skipped, [{ path: 'new.py', reason: 'new_file' }]);
  assert.equal(result.gold.length, 1);
  assert.equal(result.gold[0].path, 'old.py');
  assert.equal(result.gold[0].status, 'deleted');
  assert.deepEqual(result.gold[0].ranges, [[1, 3]]);
});

test('renames keep the pre-image path; pure renames carry no content change', () => {
  const edited = ['diff --git a/old/name.py b/new/name.py', 'similarity index 80%', 'rename from old/name.py', 'rename to new/name.py', 'index 1..2 100644', '--- a/old/name.py', '+++ b/new/name.py', hunk(3, 3, [' a', '-b', '+c', ' d']), ''].join('\n');
  const pure = ['diff --git a/p.py b/q.py', 'similarity index 100%', 'rename from p.py', 'rename to q.py', ''].join('\n');
  const result = goldFromDiff(parseUnifiedDiff(edited + pure));
  assert.equal(result.gold.length, 1);
  assert.equal(result.gold[0].path, 'old/name.py');
  assert.equal(result.gold[0].newPath, 'new/name.py');
  assert.equal(result.gold[0].status, 'renamed');
  assert.deepEqual(result.gold[0].ranges, [[4, 4]]);
  assert.deepEqual(result.skipped, [{ path: 'p.py', reason: 'no_content_change' }]);
});

test('mode-only and binary changes are not gold', () => {
  const patch = [
    'diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755',
    'diff --git a/img.png b/img.png', 'index 1..2 100644', 'Binary files a/img.png and b/img.png differ',
    'diff --git a/blob.dat b/blob.dat', 'GIT binary patch', 'literal 10', 'zcmV;g0Q', '',
  ].join('\n');
  const result = goldFromDiff(parseUnifiedDiff(patch));
  assert.deepEqual(result.gold, []);
  assert.deepEqual(result.skipped.map(s => s.reason), ['no_content_change', 'binary', 'binary']);
});

test('test files are removed from the gold set', () => {
  const patch = modify('src/lib.py', hunk(1, 1, ['-a', '+b'])) + modify('tests/test_lib.py', hunk(1, 1, ['-a', '+b'])) + modify('conftest.py', hunk(1, 1, ['-a', '+b']));
  const result = goldFromDiff(parseUnifiedDiff(patch));
  assert.deepEqual(result.gold.map(g => g.path), ['src/lib.py']);
  assert.deepEqual(result.skipped.map(s => s.reason), ['test_file', 'test_file']);
});

test('quoted paths, spaces and unicode survive', () => {
  const quoted = ['diff --git "a/caf\\303\\251/n\\303\\266.py" "b/caf\\303\\251/n\\303\\266.py"', 'index 1..2 100644', '--- "a/caf\\303\\251/n\\303\\266.py"', '+++ "b/caf\\303\\251/n\\303\\266.py"', hunk(1, 1, ['-a', '+b']), ''].join('\n');
  const spaced = modify('dir with space/my file.py', hunk(2, 2, ['-a', '+b']));
  const files = parseUnifiedDiff(quoted + spaced);
  assert.equal(files[0].oldPath, 'café/nö.py');
  assert.equal(files[1].oldPath, 'dir with space/my file.py');
});

test('CRLF patches parse like LF patches', () => {
  const lf = modify('a/b.js', hunk(5, 5, [' x', '-old', '+new', ' y']));
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.deepEqual(goldFromDiff(parseUnifiedDiff(crlf)).gold, goldFromDiff(parseUnifiedDiff(lf)).gold);
  assert.equal(goldFromDiff(parseUnifiedDiff(crlf)).gold[0].path, 'a/b.js');
});

test('removed lines that look like file headers stay inside their hunk', () => {
  const patch = modify('doc.sql', hunk(1, 1, ['--- comment', '-- note', '+++ added', ' keep', '-x', '+y']));
  const files = parseUnifiedDiff(patch);
  assert.equal(files.length, 1);
  // '--- comment' and '-- note' are removals of '-- comment' and '- note'; '+++ added' is an insertion
  assert.deepEqual(files[0].hunks[0].editRanges, [[1, 2], [4, 4]]);
});

test('"No newline at end of file" markers are ignored', () => {
  const patch = modify('a.txt', hunk(1, 1, ['-a', '\\ No newline at end of file', '+b', '\\ No newline at end of file']));
  const files = parseUnifiedDiff(patch);
  assert.deepEqual(files[0].hunks[0].editRanges, [[1, 1]]);
});

test('plain unified diffs without a git header are understood', () => {
  const patch = ['--- a/x.txt\t2020-01-01', '+++ b/x.txt\t2020-01-02', hunk(1, 1, [' a', '-b', '+c']), '--- /dev/null', '+++ b/y.txt', '@@ -0,0 +1 @@', '+n', ''].join('\n');
  const files = parseUnifiedDiff(patch);
  assert.equal(files.length, 2);
  assert.equal(files[0].oldPath, 'x.txt');
  assert.equal(files[1].kind, 'added');
});

test('wrong hunk counts resynchronise instead of looping or swallowing the next file', () => {
  const broken = ['diff --git a/a.py b/a.py', '--- a/a.py', '+++ b/a.py', '@@ -1,50 +1,50 @@', ' ctx', '-gone', '+here', ''].join('\n');
  const next = modify('b.py', hunk(3, 3, ['-q', '+r']));
  const files = parseUnifiedDiff(broken + next);
  assert.equal(files.length, 2);
  assert.deepEqual(files[0].hunks[0].editRanges, [[2, 2]]);
  assert.deepEqual(files[1].hunks[0].editRanges, [[3, 3]]);
});

test('empty, garbage and binary-noise input never throws', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);
  assert.deepEqual(parseUnifiedDiff('not a diff at all\n@@ nonsense @@\n+++\n---'), []);
  const noise = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) % 256)).toString('latin1');
  assert.doesNotThrow(() => parseUnifiedDiff(noise));
  assert.doesNotThrow(() => parseUnifiedDiff('diff --git ' + noise));
});

test('pathological long lines are linear time', () => {
  const huge = 'x'.repeat(2_000_000);
  const patch = modify('big.min.js', hunk(1, 1, [`-${huge}`, `+${huge}y`]));
  const started = performance.now();
  const files = parseUnifiedDiff(patch);
  assert.deepEqual(files[0].hunks[0].editRanges, [[1, 1]]);
  const adversarial = `@@ -${'1'.repeat(5000)} +1 @@\n` + '@'.repeat(100_000);
  assert.doesNotThrow(() => parseUnifiedDiff(`diff --git a/a b/a\n${adversarial}`));
  assert.ok(performance.now() - started < 2000, 'parsing must not exhibit super-linear behaviour');
});

test('mergeRanges merges overlapping and adjacent ranges and drops invalid ones', () => {
  assert.deepEqual(mergeRanges([[5, 6], [1, 2], [3, 4], [10, 12], [11, 11], [0, 3], [9, 8]]), [[1, 6], [10, 12]]);
});
