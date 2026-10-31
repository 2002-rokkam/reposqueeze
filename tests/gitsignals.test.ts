/**
 * Tests for src/gitsignals.ts. Every test builds real git repositories with controlled commit dates
 * (git fast-import for bulk history, real `git commit` with GIT_*_DATE in one test) and runs the real git.
 *
 * Scratch space is $RSQ_TEST_TMPDIR when set, otherwise the OS temp directory.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { loadGitSignals, type GitSignals, type GitSignalsOptions } from '../src/gitsignals.js';

const SCRATCH = process.env.RSQ_TEST_TMPDIR || tmpdir();
const T0 = 1_600_000_000;
const DAY = 86_400;

// ------------------------------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------------------------------

/** Environment for the git commands that build fixtures: no user or system config, no inherited overrides. */
function pristineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const inherited = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OPTIONAL_LOCKS|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/;
    if (value !== undefined && !inherited.test(name)) env[name] = value;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string | Buffer): string {
  const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
  return execFileSync('git', [...identity, ...args], {
    cwd,
    env: { ...pristineEnv(), ...env },
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function scratch(t: TestContext, label: string): Promise<string> {
  await mkdir(SCRATCH, { recursive: true });
  const dir = await mkdtemp(join(SCRATCH, `gitsig-${label}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(root: string, path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

/** Appends `section.key = value` pairs to the repository's own config without spawning git. */
async function appendConfig(repo: string, entries: [string, string][]): Promise<void> {
  const sections = new Map<string, string[]>();
  for (const [key, value] of entries) {
    const dot = key.indexOf('.');
    const quoted = `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    sections.set(key.slice(0, dot), [...(sections.get(key.slice(0, dot)) ?? []), `\t${key.slice(dot + 1)} = ${quoted}`]);
  }
  const text = [...sections].map(([section, lines]) => `[${section}]\n${lines.join('\n')}\n`).join('');
  await appendFile(join(repo, '.git', 'config'), text);
}

interface Step {
  /** Commit time as days after T0; `time` (epoch seconds) wins when both are given. */
  day?: number;
  time?: number;
  /** Paths whose content changes in this commit (content is unique per step). */
  touch?: string[];
  /** Explicit contents; null deletes. */
  files?: Record<string, string | Buffer | null>;
  remove?: string[];
  ref?: string;
  /** Index of the first parent; defaults to the previous commit on the same ref. */
  from?: number;
  /** Index of a second parent, making this a merge commit. */
  merge?: number;
}

function quotePath(path: string): string {
  let quoted = '"';
  for (const byte of Buffer.from(path, 'utf8')) {
    if (byte === 0x22) quoted += '\\"';
    else if (byte === 0x5c) quoted += '\\\\';
    else if (byte >= 0x20 && byte < 0x7f) quoted += String.fromCharCode(byte);
    else quoted += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return `${quoted}"`;
}

function fastImportStream(steps: Step[]): Buffer {
  const parts: Buffer[] = [];
  const tips = new Map<string, number>();
  steps.forEach((step, index) => {
    const mark = index + 1;
    const ref = step.ref ?? 'refs/heads/main';
    const time = step.time ?? T0 + (step.day ?? index) * DAY;
    const message = `commit ${mark}`;
    const header = [`commit ${ref}`, `mark :${mark}`, `committer Test <test@example.com> ${time} +0000`, `data ${message.length}`, message];
    const from = step.from !== undefined ? step.from + 1 : tips.get(ref);
    if (from !== undefined) header.push(`from :${from}`);
    if (step.merge !== undefined) header.push(`merge :${step.merge + 1}`);
    parts.push(Buffer.from(`${header.join('\n')}\n`));
    const changes: Record<string, string | Buffer | null> = {};
    for (const path of step.touch ?? []) changes[path] = `${path} @ ${mark}\n`;
    for (const path of step.remove ?? []) changes[path] = null;
    Object.assign(changes, step.files);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) {
        parts.push(Buffer.from(`D ${quotePath(path)}\n`));
      } else {
        const data = Buffer.from(content);
        parts.push(Buffer.from(`M 100644 inline ${quotePath(path)}\ndata ${data.length}\n`), data, Buffer.from('\n'));
      }
    }
    parts.push(Buffer.from('\n'));
    tips.set(ref, mark);
  });
  return Buffer.concat(parts);
}

/**
 * Builds a repository on branch main from a fast-import stream. Without `checkout` there is no index or
 * working tree, which is enough (and much cheaper) for tests that only look at history.
 */
async function buildRepo(t: TestContext, steps: Step[], { checkout = false } = {}): Promise<string> {
  const repo = await scratch(t, 'repo');
  git(repo, ['init', '-q']);
  git(repo, ['fast-import', '--quiet'], {}, fastImportStream(steps));
  await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  if (checkout) git(repo, ['reset', '-q', '--hard']);
  return repo;
}

async function withEnv<T>(changes: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = Object.keys(changes).map(name => [name, process.env[name]] as const);
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Removes the harness-level git config overrides so only the module's own hardening protects git. */
const WITHOUT_ENV_CONFIG: Record<string, string | undefined> = Object.fromEntries(
  Object.keys(process.env)
    .filter(name => /^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(name))
    .map(name => [name, undefined]),
);

function fingerprint(signals: GitSignals, paths: string[]): string {
  return JSON.stringify({
    available: signals.available,
    reason: signals.reason,
    head: signals.head,
    shallow: signals.shallow,
    truncated: signals.truncated,
    analysed: signals.commitsAnalysed,
    ignored: signals.commitsIgnored,
    files: paths.map(path => [path, String(signals.ageDays(path)), signals.churn(path), signals.coChanged(path, 1000)]),
    dirty: [...signals.dirty],
  });
}

function assertUnavailable(signals: GitSignals, reason: RegExp): void {
  assert.equal(signals.available, false);
  assert.match(signals.reason ?? '', reason);
  assert.equal(signals.shallow, false);
  assert.equal(signals.truncated, false);
  assert.equal(signals.commitsAnalysed, 0);
  assert.equal(signals.head, undefined);
  assert.equal(signals.dirty.size, 0);
  assert.equal(signals.ageDays('anything'), Infinity);
  assert.equal(signals.churn('anything'), 0);
  assert.deepEqual(signals.coChanged('anything'), []);
}

async function executable(t: TestContext, name: string, body: string): Promise<string> {
  const path = join(await scratch(t, 'bin'), name);
  await writeFile(path, body);
  await chmod(path, 0o755);
  return path;
}

// ------------------------------------------------------------------------------------------------------
// Recency, churn, co-change
// ------------------------------------------------------------------------------------------------------

test('recency is measured from the HEAD commit date and orders files by last change', async t => {
  const repo = await buildRepo(t, [
    { day: 0, touch: ['a.ts', 'b.ts', 'c.ts'] },
    { day: 10, touch: ['b.ts'] },
    { day: 25, touch: ['c.ts', 'd.ts'] },
    { day: 30.5, touch: ['d.ts'] },
  ]);
  const signals = await loadGitSignals(repo);
  assert.equal(signals.available, true);
  assert.equal(signals.reason, undefined);
  assert.equal(signals.head, git(repo, ['rev-parse', 'HEAD']).trim());
  assert.equal(signals.headTime, T0 + 30.5 * DAY);
  assert.equal(signals.shallow, false);
  assert.equal(signals.truncated, false);
  assert.equal(signals.commitsAnalysed, 4);
  assert.equal(signals.commitsIgnored, 0);
  assert.equal(signals.fromCache, false);
  assert.deepEqual(signals.warnings, []);
  assert.equal(signals.ageDays('d.ts'), 0);
  assert.equal(signals.ageDays('c.ts'), 5.5);
  assert.equal(signals.ageDays('b.ts'), 20.5);
  assert.equal(signals.ageDays('a.ts'), 30.5);
  assert.equal(signals.ageDays('missing.ts'), Infinity);
  assert.equal(signals.ageDays(''), Infinity);
});

test('churn counts analysed commits per path', async t => {
  const repo = await buildRepo(t, [
    { day: 0, touch: ['a.ts', 'b.ts', 'c.ts'] },
    { day: 10, touch: ['b.ts'] },
    { day: 25, touch: ['c.ts', 'd.ts'] },
    { day: 30, touch: ['d.ts'] },
  ]);
  const signals = await loadGitSignals(repo);
  assert.deepEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'missing.ts'].map(path => signals.churn(path)), [1, 2, 2, 2, 0]);
});

test('clock skew (a newer commit dated after HEAD) never yields a negative age', async t => {
  const repo = await buildRepo(t, [{ day: 9, touch: ['skewed.ts'] }, { day: 5, touch: ['head.ts'] }]);
  const signals = await loadGitSignals(repo);
  assert.equal(signals.headTime, T0 + 5 * DAY);
  assert.equal(signals.ageDays('skewed.ts'), 0);
  assert.equal(signals.ageDays('head.ts'), 0);
});

test('real git commits with GIT_COMMITTER_DATE give the same answers as fast-import history', async t => {
  const repo = await scratch(t, 'porcelain');
  git(repo, ['init', '-q']);
  const commit = async (day: number, files: string[]): Promise<void> => {
    for (const file of files) await write(repo, file, `${file} day ${day}\n`);
    git(repo, ['add', '-A']);
    const when = `${T0 + day * DAY} +0000`;
    git(repo, ['commit', '-q', '-m', `day ${day}`], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  };
  await commit(0, ['a.ts', 'b.ts']);
  await commit(3, ['a.ts']);
  await commit(7, ['c.ts']);
  const signals = await loadGitSignals(repo);
  assert.equal(signals.commitsAnalysed, 3);
  assert.equal(signals.ageDays('a.ts'), 4);
  assert.equal(signals.ageDays('b.ts'), 7);
  assert.equal(signals.ageDays('c.ts'), 0);
  assert.equal(signals.churn('a.ts'), 2);
  assert.deepEqual(signals.coChanged('a.ts'), [{ path: 'b.ts', weight: 0.5, support: 1 }]);
  assert.equal(signals.dirty.size, 0);
});

test('mass commits are ignored by churn, recency and co-change; exactly maxFilesPerCommit files still count', async t => {
  const mass = Array.from({ length: 41 }, (_, i) => `gen/g${i}.ts`);
  const exact = Array.from({ length: 40 }, (_, i) => `exact/e${i}.ts`);
  const repo = await buildRepo(t, [
    { day: 0, touch: ['x.ts', 'y.ts'] },
    { day: 5, touch: [...mass, 'x.ts'] },
    { day: 9, touch: ['x.ts'] },
    { day: 10, touch: exact },
  ]);
  const signals = await loadGitSignals(repo);
  assert.equal(signals.commitsAnalysed, 3);
  assert.equal(signals.commitsIgnored, 1);
  assert.equal(signals.churn('x.ts'), 2);
  assert.equal(signals.ageDays('x.ts'), 1);
  assert.equal(signals.ageDays('y.ts'), 10);
  assert.equal(signals.churn('gen/g0.ts'), 0);
  assert.equal(signals.ageDays('gen/g0.ts'), Infinity);
  assert.deepEqual(signals.coChanged('x.ts'), [{ path: 'y.ts', weight: 0.5, support: 1 }]);
  assert.equal(signals.churn('exact/e0.ts'), 1);
  assert.equal(signals.ageDays('exact/e0.ts'), 0);
  assert.equal(signals.coChanged('exact/e0.ts').length, 10);
  assert.equal(signals.coChanged('exact/e0.ts', 100).length, 39);

  const strict = await loadGitSignals(repo, { maxFilesPerCommit: 2 });
  assert.equal(strict.commitsAnalysed, 2);
  assert.equal(strict.commitsIgnored, 2);
  assert.equal(strict.churn('exact/e0.ts'), 0);
  assert.equal(strict.churn('x.ts'), 2);
});

test('a huge commit is skipped without being materialised', async t => {
  const everything = Array.from({ length: 20_000 }, (_, i) => `vendor/pkg${i % 50}/file${i}.js`);
  const repo = await buildRepo(t, [{ day: 0, touch: ['a.ts'] }, { day: 1, touch: everything }, { day: 2, touch: ['a.ts'] }]);
  const signals = await loadGitSignals(repo);
  assert.equal(signals.commitsAnalysed, 2);
  assert.equal(signals.commitsIgnored, 1);
  assert.equal(signals.churn('vendor/pkg1/file1.js'), 0);
  assert.equal(signals.churn('a.ts'), 2);
});

test('co-change weights are Jaccard-like, ordered by weight then path, and bounded by k', async t => {
  const repo = await buildRepo(t, [
    { day: 1, touch: ['a', 'b'] },
    { day: 2, touch: ['a', 'b'] },
    { day: 3, touch: ['a', 'b', 'c'] },
    { day: 4, touch: ['a'] },
    { day: 5, touch: ['b'] },
    { day: 6, touch: ['c'] },
    { day: 7, touch: ['p', 'q'] },
  ]);
  const signals = await loadGitSignals(repo);
  // churn: a=4, b=4, c=2; support(a,b)=3, support(a,c)=1, support(b,c)=1.
  assert.deepEqual(signals.coChanged('a'), [
    { path: 'b', weight: 3 / 5, support: 3 },
    { path: 'c', weight: 1 / 5, support: 1 },
  ]);
  assert.deepEqual(signals.coChanged('c'), [
    { path: 'a', weight: 1 / 5, support: 1 },
    { path: 'b', weight: 1 / 5, support: 1 },
  ]);
  assert.deepEqual(signals.coChanged('a', 1), [{ path: 'b', weight: 0.6, support: 3 }]);
  assert.deepEqual(signals.coChanged('p'), [{ path: 'q', weight: 1, support: 1 }]);
  assert.deepEqual(signals.coChanged('a', 0), []);
  assert.deepEqual(signals.coChanged('a', -3), []);
  assert.deepEqual(signals.coChanged('a', Number.NaN), signals.coChanged('a'));
  assert.equal(signals.coChanged('a', 1.9).length, 1);
  assert.equal(signals.coChanged('a', Infinity).length, 2);
  assert.deepEqual(signals.coChanged('missing'), []);
  for (const path of ['a', 'b', 'c', 'p', 'q']) {
    for (const partner of signals.coChanged(path)) {
      assert(partner.weight > 0 && partner.weight <= 1);
      assert.notEqual(partner.path, path);
    }
  }
});

test('co-change leaves out files whose newest commit deleted them and brings them back when re-added', async t => {
  const steps: Step[] = [
    { day: 1, touch: ['a', 'b'] },
    { day: 2, touch: ['a', 'c'] },
    { day: 3, remove: ['b'] },
    { day: 4, touch: ['a'] },
  ];
  const deleted = await loadGitSignals(await buildRepo(t, steps));
  assert.deepEqual(deleted.coChanged('a'), [{ path: 'c', weight: 1 / 3, support: 1 }]);
  assert.equal(deleted.churn('b'), 2);
  assert.equal(deleted.ageDays('b'), 1);

  // churn: a=3, b=3 (days 1, 3, 5), c=1; support(a,b)=1, support(a,c)=1.
  const restored = await loadGitSignals(await buildRepo(t, [...steps, { day: 5, touch: ['b'] }]));
  assert.deepEqual(restored.coChanged('a'), [
    { path: 'c', weight: 1 / 3, support: 1 },
    { path: 'b', weight: 1 / 5, support: 1 },
  ]);
});

test('default k is 10', async t => {
  const names = Array.from({ length: 15 }, (_, i) => `f${String(i).padStart(2, '0')}`);
  const repo = await buildRepo(t, [{ day: 0, touch: names }]);
  const signals = await loadGitSignals(repo);
  assert.deepEqual(signals.coChanged('f00').map(partner => partner.path), names.slice(1, 11));
});

test('merge commits are not counted but both sides of the merge are', async t => {
  const repo = await buildRepo(t, [
    { day: 0, touch: ['a'] },
    { day: 2, touch: ['b'] },
    { day: 1, touch: ['c'], ref: 'refs/heads/feature', from: 0 },
    { day: 3, touch: ['a', 'c'], ref: 'refs/heads/feature' },
    { day: 4, touch: ['resolved'], merge: 3 },
  ]);
  const signals = await loadGitSignals(repo);
  assert.equal(signals.commitsAnalysed, 4);
  assert.equal(signals.churn('resolved'), 0);
  assert.equal(signals.ageDays('resolved'), Infinity);
  assert.equal(signals.ageDays('a'), 1);
  assert.deepEqual(signals.coChanged('a'), [{ path: 'c', weight: 1 / 3, support: 1 }]);
});

test('binary files and empty commits are harmless', async t => {
  const repo = await buildRepo(t, [
    { day: 0, files: { 'blob.bin': Buffer.from([0, 1, 2, 0, 255, 254, 0]), 'text.txt': 'a\r\nb\r\n' } },
    { day: 1 },
    { day: 2, files: { 'blob.bin': Buffer.from([9, 0, 0, 0, 7]) } },
  ]);
  const signals = await loadGitSignals(repo);
  assert.equal(signals.commitsAnalysed, 2);
  assert.equal(signals.commitsIgnored, 1);
  assert.equal(signals.churn('blob.bin'), 2);
  assert.equal(signals.ageDays('text.txt'), 2);
});

test('maxCommits bounds the window and reports truncation only when older history exists', async t => {
  const steps = Array.from({ length: 12 }, (_, i): Step => ({ day: i, touch: [`f${i}.ts`, 'shared.ts'] }));
  const repo = await buildRepo(t, steps);

  const five = await loadGitSignals(repo, { maxCommits: 5 });
  assert.equal(five.commitsAnalysed, 5);
  assert.equal(five.truncated, true);
  assert.equal(five.truncatedBy, 'maxCommits');
  assert.deepEqual(five.warnings, []);
  assert.equal(five.churn('shared.ts'), 5);
  assert.equal(five.ageDays('f7.ts'), 4);
  assert.equal(five.ageDays('f6.ts'), Infinity);

  const all = await loadGitSignals(repo, { maxCommits: 12 });
  assert.equal(all.commitsAnalysed, 12);
  assert.equal(all.truncated, false);
  assert.equal(all.truncatedBy, undefined);
  assert.equal(all.churn('shared.ts'), 12);

  assert.equal((await loadGitSignals(repo, { maxCommits: 11 })).truncated, true);
  assert.equal((await loadGitSignals(repo, { maxCommits: 1 })).commitsAnalysed, 1);
  assert.equal((await loadGitSignals(repo)).truncated, false);
});

test('a history longer than the default window is cut at 2000 commits', async t => {
  const steps = Array.from({ length: 2500 }, (_, i): Step => ({ day: i / 10, touch: [`mod${i % 120}.ts`, `mod${(i + 1) % 120}.ts`] }));
  const repo = await buildRepo(t, steps);
  const started = performance.now();
  const signals = await loadGitSignals(repo);
  t.diagnostic(`2500 commits analysed in ${Math.round(performance.now() - started)} ms`);
  assert.equal(signals.commitsAnalysed, 2000);
  assert.equal(signals.truncatedBy, 'maxCommits');
  assert.equal(signals.ageDays('mod99.ts'), 0);
  const hot = signals.coChanged('mod5.ts');
  assert.deepEqual(hot.map(partner => partner.path).sort(), ['mod4.ts', 'mod6.ts']);
});

// ------------------------------------------------------------------------------------------------------
// Working tree
// ------------------------------------------------------------------------------------------------------

test('dirty covers staged, unstaged, untracked, deleted, renamed and intent-to-add paths but not ignored ones', async t => {
  const repo = await buildRepo(t, [
    {
      day: 0,
      files: {
        '.gitignore': '*.log\n',
        'tracked.txt': 'a\n',
        'touched.txt': 'a\n',
        'staged.txt': 'a\n',
        'unstaged.txt': 'a\n',
        'deleted.txt': 'a\n',
        'rename-me.txt': 'a\n',
        'staged-deleted.txt': 'a\n',
        'both.txt': 'a\n',
      },
    },
  ], { checkout: true });
  await write(repo, 'staged.txt', 'b\n');
  git(repo, ['add', 'staged.txt']);
  await write(repo, 'unstaged.txt', 'b\n');
  await rm(join(repo, 'deleted.txt'));
  git(repo, ['mv', 'rename-me.txt', 'renamed.txt']);
  git(repo, ['rm', '-q', 'staged-deleted.txt']);
  await write(repo, 'both.txt', 'b\n');
  git(repo, ['add', 'both.txt']);
  await write(repo, 'both.txt', 'c\n');
  await write(repo, 'untracked.txt', 'x\n');
  await write(repo, 'dir/deep/untracked2.txt', 'x\n');
  await write(repo, 'ignored.log', 'x\n');
  await write(repo, 'dir/ignored.log', 'x\n');
  await write(repo, 'staged-new.txt', 'x\n');
  git(repo, ['add', 'staged-new.txt']);
  await write(repo, 'intent.txt', 'x\n');
  git(repo, ['add', '-N', 'intent.txt']);
  await mkdir(join(repo, 'nested'));
  git(join(repo, 'nested'), ['init', '-q']);
  await write(repo, 'nested/inner.txt', 'x\n');
  // Same content, newer mtime: `git status` refreshes it to clean, a stat-only check would not.
  await utimes(join(repo, 'touched.txt'), new Date(2030, 0, 1), new Date(2030, 0, 1));

  const signals = await loadGitSignals(repo);
  assert.deepEqual([...signals.dirty].sort(), [
    'both.txt',
    'deleted.txt',
    'dir/deep/untracked2.txt',
    'intent.txt',
    'rename-me.txt',
    'renamed.txt',
    'staged-deleted.txt',
    'staged-new.txt',
    'staged.txt',
    'unstaged.txt',
    'untracked.txt',
  ]);
  assert.deepEqual(signals.warnings, []);
});

test('a clean working tree has an empty dirty set', async t => {
  const signals = await loadGitSignals(await buildRepo(t, [{ day: 0, touch: ['a.ts'] }], { checkout: true }));
  assert.equal(signals.dirty.size, 0);
});

test('a subdirectory root sees only its own files, relative to it, and ages relative to the repository HEAD', async t => {
  const repo = await buildRepo(t, [
    { day: 0, touch: ['pkg/a.ts', 'pkg/lib/b.ts', 'other/c.ts'] },
    { day: 4, touch: ['other/c.ts', 'root.ts'] },
    { day: 8, touch: ['pkg/a.ts'] },
    { day: 12, touch: ['other/c.ts'] },
  ], { checkout: true });
  await write(repo, 'pkg/a.ts', 'edited\n');
  await write(repo, 'pkg/new.ts', 'new\n');
  await write(repo, 'other/c.ts', 'edited\n');
  await write(repo, 'top.txt', 'new\n');

  const signals = await loadGitSignals(join(repo, 'pkg'));
  assert.equal(signals.available, true);
  assert.equal(signals.commitsAnalysed, 2);
  assert.equal(signals.churn('a.ts'), 2);
  assert.equal(signals.ageDays('a.ts'), 4);
  assert.equal(signals.ageDays('lib/b.ts'), 12);
  for (const outside of ['c.ts', 'other/c.ts', 'pkg/a.ts', 'root.ts', '../other/c.ts']) {
    assert.equal(signals.churn(outside), 0, outside);
    assert.equal(signals.ageDays(outside), Infinity, outside);
  }
  assert.deepEqual(signals.coChanged('a.ts'), [{ path: 'lib/b.ts', weight: 0.5, support: 1 }]);
  assert.deepEqual([...signals.dirty].sort(), ['a.ts', 'new.ts']);

  const deeper = await loadGitSignals(join(repo, 'pkg', 'lib'));
  assert.equal(deeper.commitsAnalysed, 1);
  assert.equal(deeper.ageDays('b.ts'), 12);
  assert.equal(deeper.dirty.size, 0);

  // Only files below root count toward maxFilesPerCommit.
  const narrow = await loadGitSignals(join(repo, 'pkg'), { maxFilesPerCommit: 2 });
  assert.equal(narrow.commitsAnalysed, 2);

  // A symlinked entry point resolves to the same repository and prefix.
  const alias = join(dirname(repo), `${repo.split('/').pop()}-alias`);
  await symlink(join(repo, 'pkg'), alias);
  t.after(() => rm(alias, { force: true }));
  assert.equal(fingerprint(await loadGitSignals(alias), ['a.ts', 'lib/b.ts']), fingerprint(signals, ['a.ts', 'lib/b.ts']));
});

test('shallow clones ignore the boundary commit whose diff is against an empty tree', async t => {
  const source = await buildRepo(t, [
    { day: 0, touch: ['old.ts', 'keep.ts'] },
    { day: 1, touch: ['old.ts'] },
    { day: 2, touch: ['mid.ts'] },
    { day: 3, touch: ['keep.ts', 'new.ts'] },
    { day: 4, touch: ['new.ts'] },
  ]);
  const parent = await scratch(t, 'clones');
  git(parent, ['clone', '-q', '--no-checkout', '--depth', '2', `file://${source}`, 'depth2']);
  git(parent, ['clone', '-q', '--no-checkout', '--depth', '1', `file://${source}`, 'depth1']);
  git(parent, ['clone', '-q', '--no-checkout', `file://${source}`, 'full']);

  const depth2 = await loadGitSignals(join(parent, 'depth2'));
  assert.equal(depth2.shallow, true);
  assert.equal(depth2.truncated, false);
  assert.equal(depth2.commitsAnalysed, 1);
  assert.equal(depth2.commitsIgnored, 1);
  assert.equal(depth2.churn('new.ts'), 1);
  assert.equal(depth2.ageDays('new.ts'), 0);
  // keep.ts, old.ts and mid.ts exist in the boundary commit's fake "everything was added" diff.
  for (const path of ['keep.ts', 'old.ts', 'mid.ts']) {
    assert.equal(depth2.churn(path), 0, path);
    assert.equal(depth2.ageDays(path), Infinity, path);
  }

  const depth1 = await loadGitSignals(join(parent, 'depth1'));
  assert.equal(depth1.shallow, true);
  assert.equal(depth1.commitsAnalysed, 0);
  assert.equal(depth1.churn('new.ts'), 0);

  const full = await loadGitSignals(join(parent, 'full'));
  assert.equal(full.shallow, false);
  assert.equal(full.commitsAnalysed, 5);
  assert.equal(full.churn('old.ts'), 2);
});

test('detached HEAD, linked worktrees and submodule roots work', async t => {
  const repo = await buildRepo(t, [
    { day: 0, touch: ['a.ts'] },
    { day: 10, touch: ['b.ts'] },
    { day: 20, touch: ['a.ts'] },
  ], { checkout: true });
  const first = git(repo, ['rev-list', '--max-parents=0', 'HEAD']).trim();
  const second = git(repo, ['rev-parse', 'HEAD~1']).trim();

  const parent = await scratch(t, 'trees');
  const worktree = join(parent, 'linked');
  git(repo, ['worktree', 'add', '-q', '--detach', worktree, second]);
  const detached = await loadGitSignals(worktree);
  assert.equal(detached.head, second);
  assert.equal(detached.commitsAnalysed, 2);
  assert.equal(detached.ageDays('a.ts'), 10);
  await write(worktree, 'wip.ts', 'x\n');
  assert.deepEqual([...(await loadGitSignals(worktree)).dirty], ['wip.ts']);
  assert.equal((await loadGitSignals(repo)).dirty.size, 0);

  git(repo, ['checkout', '-q', '--detach', first]);
  const atRoot = await loadGitSignals(repo);
  assert.equal(atRoot.head, first);
  assert.equal(atRoot.commitsAnalysed, 1);

  const library = await buildRepo(t, [{ day: 0, touch: ['lib.ts'] }, { day: 5, touch: ['lib.ts'] }]);
  const superproject = await buildRepo(t, [{ day: 0, touch: ['app.ts'] }], { checkout: true });
  git(superproject, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'vendor/lib']);
  git(superproject, ['commit', '-q', '-m', 'add submodule']);
  await write(superproject, 'vendor/lib/lib.ts', 'edited in submodule\n');
  const inner = await loadGitSignals(join(superproject, 'vendor', 'lib'));
  assert.equal(inner.available, true);
  assert.equal(inner.commitsAnalysed, 2);
  assert.deepEqual([...inner.dirty], ['lib.ts']);
  const outer = await loadGitSignals(superproject);
  assert.equal(outer.available, true);
  assert.equal(outer.dirty.has('vendor/lib'), false);
  assert.equal(outer.dirty.size, 0);
});

// ------------------------------------------------------------------------------------------------------
// Unavailable repositories and bad input
// ------------------------------------------------------------------------------------------------------

test('non-git directories, empty repositories and bad roots are unavailable, never errors', async t => {
  const plain = await scratch(t, 'plain');
  await write(plain, 'file.txt', 'x\n');
  const ceiling = { GIT_CEILING_DIRECTORIES: dirname(plain) };
  assertUnavailable(await withEnv(ceiling, () => loadGitSignals(plain)), /not a git repository/);

  const empty = await scratch(t, 'empty');
  git(empty, ['init', '-q']);
  await write(empty, 'pending.txt', 'x\n');
  assertUnavailable(await loadGitSignals(empty), /no commits/);

  const unborn = await buildRepo(t, [{ day: 0, touch: ['a.ts'] }]);
  git(unborn, ['checkout', '-q', '--orphan', 'fresh']);
  assertUnavailable(await loadGitSignals(unborn), /no commits/);

  assertUnavailable(await loadGitSignals(join(plain, 'missing')), /not a directory/);
  assertUnavailable(await loadGitSignals(join(plain, 'file.txt')), /not a directory/);
  assertUnavailable(await loadGitSignals(''), /not a valid path/);
  assertUnavailable(await loadGitSignals('bad\0path'), /not a valid path/);
  assertUnavailable(await loadGitSignals(undefined as unknown as string), /not a valid path/);
  assertUnavailable(await loadGitSignals(null as unknown as string), /not a valid path/);
  assertUnavailable(await loadGitSignals(plain, { gitBinary: join(plain, 'no-such-git') }), /not found/);
  assertUnavailable(await withEnv(ceiling, () => loadGitSignals(plain, null as unknown as GitSignalsOptions)), /not a git repository/);
});

test('bare repositories and the .git directory itself have no working tree', async t => {
  const repo = await buildRepo(t, [{ day: 0, touch: ['a.ts'] }]);
  const parent = await scratch(t, 'bare');
  git(parent, ['clone', '-q', '--bare', repo, 'bare.git']);
  const bare = await loadGitSignals(join(parent, 'bare.git'));
  assert.equal(bare.available, false);
  assert.notEqual(bare.reason, undefined);
  assertUnavailable(await loadGitSignals(join(repo, '.git')), /not inside a git working tree/);
});

test('hostile option values are clamped and never throw', async t => {
  const repo = await buildRepo(t, Array.from({ length: 4 }, (_, i): Step => ({ day: i, touch: [`f${i}`, 'common'] })));
  const weird = [
    { maxCommits: Number.NaN, maxFilesPerCommit: -1, timeoutMs: Number.NaN },
    { maxCommits: -5, maxFilesPerCommit: 0, timeoutMs: -1 },
    { maxCommits: Infinity, maxFilesPerCommit: Infinity, timeoutMs: Infinity },
    { maxCommits: '3' as unknown as number, maxFilesPerCommit: {} as unknown as number, timeoutMs: 'x' as unknown as number },
    { cacheDir: 42 as unknown as string, gitBinary: '', limits: 7 as unknown as GitSignalsOptions['limits'] },
  ];
  for (const options of weird) {
    const signals = await loadGitSignals(repo, options);
    assert.equal(signals.available, true, JSON.stringify(options));
  }
  assert.equal((await loadGitSignals(repo, { maxCommits: 0 })).commitsAnalysed, 4);
  assert.equal((await loadGitSignals(repo, { maxCommits: 1.9 })).commitsAnalysed, 1);
  assert.equal((await loadGitSignals(repo, { maxFilesPerCommit: 1.5 })).commitsAnalysed, 0);
});

test('safety caps truncate with a flag instead of growing without bound, and truncated results are not cached', async t => {
  const repo = await buildRepo(t, Array.from({ length: 6 }, (_, i): Step => ({ day: i, touch: [`f${i}`, 'shared'] })));
  const cacheDir = join(await scratch(t, 'cache'), 'c');

  // Newest first: the HEAD commit's two pairs fit, the next commit would exceed three stored pairs.
  const pairs = await loadGitSignals(repo, { limits: { incidences: 3 }, cacheDir });
  assert.equal(pairs.commitsAnalysed, 1);
  assert.equal(pairs.truncatedBy, 'limit');
  assert.equal(pairs.churn('shared'), 1);
  assert.match(pairs.warnings?.join('\n') ?? '', /size limit/);

  const bytes = await loadGitSignals(repo, { limits: { logBytes: 50 }, cacheDir });
  assert.equal(bytes.truncatedBy, 'limit');
  assert.equal(bytes.commitsAnalysed, 0);
  assert.deepEqual(await readdir(cacheDir).catch(() => []), []);

  const normal = await loadGitSignals(repo, { cacheDir });
  assert.equal(normal.commitsAnalysed, 6);
  assert.equal(normal.truncated, false);
});

test('an enormous dirty set is capped and flagged, and a broken index only costs the dirty set', async t => {
  const repo = await buildRepo(t, [{ day: 0, touch: ['a.ts', 'b.ts'] }, { day: 1, touch: ['a.ts'] }]);
  for (let i = 0; i < 8; i++) await write(repo, `untracked${i}.txt`, 'x\n');
  const capped = await loadGitSignals(repo, { limits: { dirtyPaths: 3 } });
  assert.equal(capped.dirty.size, 3);
  assert.equal(capped.truncated, false);
  assert.match(capped.warnings?.join('\n') ?? '', /dirty set is partial/);
  // No index at all: both tracked files show as deleted, next to the eight untracked ones.
  assert.equal((await loadGitSignals(repo)).dirty.size, 10);

  await writeFile(join(repo, '.git', 'index'), 'not an index');
  const broken = await loadGitSignals(repo);
  assert.equal(broken.available, true);
  assert.equal(broken.commitsAnalysed, 2);
  assert.equal(broken.churn('a.ts'), 2);
  assert.equal(broken.dirty.size, 0);
  assert.match(broken.warnings?.join('\n') ?? '', /git status failed/);
});

// ------------------------------------------------------------------------------------------------------
// Adversarial paths and output framing
// ------------------------------------------------------------------------------------------------------

test('unicode, spaces, newlines, quotes, leading dashes and header look-alikes survive intact', async t => {
  const names = [
    'with space/dir name/file name.txt',
    'uni/caf\u00e9 \u65e5\u672c\u8a9e \u{1F680}.txt',
    'line\nbreak.txt',
    '\nstarts-with-newline.txt',
    'tab\there.txt',
    'quote"d.txt',
    "apostrophe's.txt",
    'back\\slash.txt',
    '-leading-dash.txt',
    '--help',
    'cr\r.txt',
    ' leading-space.txt',
    'trailing-space.txt ',
    `${'0123456789'.repeat(4)} ${T0}`,
    'M',
    'A\nM\nD',
    '#hash',
    '100%',
    '[brackets] {braces} (parens).txt',
    '$HOME `tick` $(sub).txt',
  ];
  const repo = await buildRepo(t, [{ day: 1, touch: ['plain.txt', 'M'] }, { day: 3, touch: [...names, 'plain.txt'] }], { checkout: true });
  await write(repo, 'new\nuntracked \u00fc.txt', 'x\n');
  await write(repo, '--untracked-dash', 'x\n');

  const signals = await loadGitSignals(repo);
  assert.equal(signals.commitsAnalysed, 2);
  for (const name of names) {
    const expected = name === 'M' ? 2 : 1;
    assert.equal(signals.churn(name), expected, JSON.stringify(name));
    assert.equal(signals.ageDays(name), 0, JSON.stringify(name));
  }
  assert.equal(signals.churn('plain.txt'), 2);
  const partners = signals.coChanged('plain.txt', 100);
  assert.equal(partners.length, names.length);
  assert.deepEqual(partners.map(partner => partner.path).sort(), [...names].sort());
  assert.equal(partners.find(partner => partner.path === 'M')?.weight, 1);
  assert.equal(partners.find(partner => partner.path === 'tab\there.txt')?.weight, 1 / 2);
  assert.deepEqual([...signals.dirty].sort(), ['--untracked-dash', 'new\nuntracked \u00fc.txt']);
});

test('very long paths are handled; paths no file system could hold are skipped without desynchronising the parser', async t => {
  const component = (letter: string, n: number): string => `${letter.repeat(200)}${n}`;
  const long = Array.from({ length: 15 }, (_, i) => component('d', i)).join('/') + '/file.txt';
  const absurd = Array.from({ length: 100 }, (_, i) => component('e', i)).join('/') + '/file.txt';
  assert(long.length > 3000 && absurd.length > 20_000);
  const repo = await buildRepo(
    t,
    [{ day: 0, touch: [long, absurd, 'zz-after.txt', 'aa-before.txt'] }, { day: 1, touch: ['zz-after.txt'] }],
    { checkout: false },
  );
  const signals = await loadGitSignals(repo);
  assert.equal(signals.commitsAnalysed, 2);
  assert.equal(signals.churn(long), 1);
  assert.equal(signals.churn(absurd), 0);
  assert.equal(signals.churn('aa-before.txt'), 1);
  assert.equal(signals.churn('zz-after.txt'), 2);
  const partners = signals.coChanged('aa-before.txt', 10).map(partner => partner.path);
  assert(partners.includes(long));
  assert(!partners.includes(absurd));
});

/**
 * A stand-in git that replays a canned `git log` stream in tiny slices and answers the probes with fixed
 * text, so chunk boundaries are exercised deterministically.
 */
async function replayGit(t: TestContext, stream: Buffer, env: Record<string, string>): Promise<{ git: string; env: Record<string, string | undefined> }> {
  const dir = await scratch(t, 'replay');
  const script = [
    "import { readFileSync } from 'node:fs';",
    "const args = process.argv.slice(2).join(' ');",
    "if (args.includes('--name-status')) {",
    "  const stream = readFileSync(process.env.FAKE_GIT_STREAM);",
    "  const size = Number(process.env.FAKE_GIT_CHUNK) || stream.length;",
    "  for (let at = 0; at < stream.length; at += size) {",
    "    process.stdout.write(stream.subarray(at, at + size));",
    "    await new Promise(resolve => setTimeout(resolve, 1));",
    "  }",
    "} else if (args.includes('--is-inside-work-tree')) process.stdout.write('true\\nfalse\\nfalse\\n\\n');",
    "else if (args.includes('--format=%H %ct')) process.stdout.write(process.env.FAKE_GIT_HEAD + '\\n');",
  ].join('\n');
  await writeFile(join(dir, 'fake-git.mjs'), script);
  await writeFile(join(dir, 'stream.bin'), stream);
  const wrapper = await executable(t, 'git', `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake-git.mjs')}" "$@"\n`);
  return { git: wrapper, env: { FAKE_GIT_STREAM: join(dir, 'stream.bin'), ...env } };
}

/**
 * Like replayGit but in plain sh (cheap to start): records its pid in `<dir>/pid`, prints the stream, then
 * runs `after(dir)` (e.g. hangs).
 */
async function shellReplay(
  t: TestContext,
  stream: Buffer,
  head: string,
  after: (dir: string) => string,
): Promise<{ git: string; dir: string }> {
  const dir = await scratch(t, 'replay');
  await writeFile(join(dir, 'stream.bin'), stream);
  const git = await executable(
    t,
    'git',
    [
      '#!/bin/sh',
      'case "$*" in',
      '  *--is-inside-work-tree*) printf "true\\nfalse\\nfalse\\n\\n" ;;',
      `  *"--format=%H %ct"*) printf "%s\\n" "${head}" ;;`,
      `  *--name-status*) echo $$ > "${join(dir, 'pid')}"; cat "${join(dir, 'stream.bin')}"; ${after(dir)} ;;`,
      'esac',
      '',
    ].join('\n'),
  );
  return { git, dir };
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const oid = (n: number): string => n.toString(16).padStart(40, '0');

function logRecord(n: number, time: number, entries: [string, string][]): Buffer {
  const header = `${oid(n)} ${time}${entries.length > 0 ? '\n' : ''}`;
  return Buffer.concat([Buffer.from(header), ...entries.map(([status, path]) => Buffer.from(`${status}\0${path}\0`))]);
}

function logStream(records: Buffer[]): Buffer {
  return Buffer.concat(records.flatMap((record, i) => (i === 0 ? [record] : [Buffer.from('\0'), record])));
}

test('the parser is independent of how git output is chunked, including inside multi-byte characters', async t => {
  const tricky = ['caf\u00e9 \u{1F680} \u65e5\u672c\u8a9e.txt', 'line\nbreak.txt', `${oid(7)} ${T0}`, 'M', '', 'x'];
  const stream = logStream([
    logRecord(1, T0 + 5 * DAY, [['M', tricky[0]], ['M', tricky[1]], ['A', tricky[2]]]),
    logRecord(2, T0 + 4 * DAY, []),
    logRecord(3, T0 + 3 * DAY, [['D', tricky[3]], ['M', tricky[0]]]),
    logRecord(4, T0 + 2 * DAY, [['M', 'x']]),
  ]);
  const head = `${oid(1)} ${T0 + 6 * DAY}`;
  const results: string[] = [];
  for (const chunk of ['100000', '1', '2', '3', '7']) {
    const fake = await replayGit(t, stream, { FAKE_GIT_CHUNK: chunk, FAKE_GIT_HEAD: head });
    const dir = await scratch(t, 'cwd');
    const signals = await withEnv(fake.env, () => loadGitSignals(dir, { gitBinary: fake.git, timeoutMs: 120_000 }));
    assert.equal(signals.available, true, chunk);
    assert.equal(signals.commitsAnalysed, 3, chunk);
    assert.equal(signals.commitsIgnored, 1, chunk);
    assert.equal(signals.churn(tricky[0]), 2, chunk);
    assert.equal(signals.ageDays('x'), 4, chunk);
    assert.equal(signals.ageDays(tricky[1]), 1, chunk);
    results.push(fingerprint(signals, tricky));
  }
  assert.equal(new Set(results).size, 1);
});

test('git that dies mid-stream or prints something unexpected degrades to a flagged, partial result', async t => {
  const garbage = Buffer.from('this is not a log\0at all\0');
  const fake = await replayGit(t, garbage, { FAKE_GIT_CHUNK: '5', FAKE_GIT_HEAD: `${oid(1)} ${T0}` });
  const dir = await scratch(t, 'cwd');
  const signals = await withEnv(fake.env, () => loadGitSignals(dir, { gitBinary: fake.git, timeoutMs: 120_000 }));
  assert.equal(signals.available, true);
  assert.equal(signals.commitsAnalysed, 0);
  assert.equal(signals.truncated, true);
  assert.equal(signals.truncatedBy, 'error');
  assert.match(signals.warnings?.join('\n') ?? '', /unrecognised git log output/);
});

test('timeout returns what was parsed so far, flagged as truncated, and persists nothing', async t => {
  const stream = logStream([
    logRecord(1, T0 + 86_400, [['M', 'a.ts'], ['M', 'b.ts']]),
    logRecord(2, T0, [['M', 'a.ts']]),
  ]);
  // The third record is cut mid-token: it must be discarded, not half-counted.
  const cut = Buffer.concat([stream, Buffer.from('\0'), Buffer.from(`${oid(3)} ${T0 - 1}\nM\0c.t`)]);
  const fake = await shellReplay(t, cut, `${oid(1)} ${T0 + 2 * DAY}`, () => 'exec sleep 30');
  const dir = await scratch(t, 'cwd');
  const cacheDir = join(await scratch(t, 'cache'), 'c');
  const started = performance.now();
  const signals = await loadGitSignals(dir, { gitBinary: fake.git, timeoutMs: 4000, cacheDir });
  assert(performance.now() - started < 25_000);
  assert.equal(signals.available, true);
  assert.equal(signals.truncated, true);
  assert.equal(signals.truncatedBy, 'timeout');
  assert.equal(signals.commitsAnalysed, 2);
  assert.equal(signals.churn('a.ts'), 2);
  assert.equal(signals.churn('b.ts'), 1);
  assert.equal(signals.churn('c.ts'), 0);
  assert.equal(signals.ageDays('a.ts'), 1);
  assert.match(signals.warnings?.join('\n') ?? '', /timed out/);
  assert.deepEqual(await readdir(cacheDir).catch(() => []), []);
  assert.equal(isAlive(Number(await readFile(join(fake.dir, 'pid'), 'utf8'))), false, 'the hung git was killed');
});

test('a stray grandchild holding the output pipe cannot stall the timeout', async t => {
  const dir = await scratch(t, 'cwd');
  const fake = await shellReplay(t, Buffer.alloc(0), `${oid(1)} ${T0}`, where => `sleep 12 & echo $! > "${join(where, 'orphan')}"; wait`);
  t.after(async () => {
    const orphan = Number(await readFile(join(fake.dir, 'orphan'), 'utf8').catch(() => '0'));
    if (orphan > 0 && isAlive(orphan)) process.kill(orphan, 'SIGKILL');
  });
  const started = performance.now();
  const signals = await loadGitSignals(dir, { gitBinary: fake.git, timeoutMs: 4000 });
  assert(performance.now() - started < 11_000, 'returned before the stray process ended');
  assert.equal(signals.truncatedBy, 'timeout');
  assert.equal(signals.commitsAnalysed, 0);
  assert.equal(isAlive(Number(await readFile(join(fake.dir, 'pid'), 'utf8'))), false, 'the hung git was killed');
});

test('a timeout before git even answers makes the signals unavailable', async t => {
  const repo = await buildRepo(t, [{ day: 0, touch: ['a.ts'] }]);
  assertUnavailable(await loadGitSignals(repo, { timeoutMs: 1 }), /timed out/);
});

// ------------------------------------------------------------------------------------------------------
// Determinism, isolation, read-only guarantees
// ------------------------------------------------------------------------------------------------------

const COMPLEX_FILES = ['a.ts', 'b.ts', 'c.ts', 'd e/f g.ts', 'm', 'gone.ts', 'new.ts'];

async function complexRepo(t: TestContext): Promise<string> {
  const repo = await buildRepo(t, [
    { day: 0, touch: ['a.ts', 'b.ts', 'gone.ts'] },
    { day: 2, touch: ['a.ts', 'c.ts', 'd e/f g.ts'] },
    { day: 2.5, touch: ['m'], ref: 'refs/heads/side', from: 0 },
    { day: 3, touch: ['b.ts', 'c.ts'] },
    { day: 4, remove: ['gone.ts'], touch: ['a.ts'] },
    { day: 5, touch: ['d e/f g.ts', 'm'], merge: 2 },
  ], { checkout: true });
  await write(repo, 'a.ts', 'dirty\n');
  await write(repo, 'new.ts', 'untracked\n');
  return repo;
}

test('results are identical across calls, time zones, concurrency, the wall clock and a hostile environment', async t => {
  const repo = await complexRepo(t);
  const decoy = await buildRepo(t, [{ day: 0, touch: ['decoy.ts'] }]);
  const base = fingerprint(await loadGitSignals(repo), COMPLEX_FILES);
  assert.equal(base, fingerprint(await loadGitSignals(repo), COMPLEX_FILES));

  for (const zone of ['Pacific/Kiritimati', 'America/Anchorage']) {
    const shifted = await withEnv({ TZ: zone }, () => loadGitSignals(repo));
    assert.equal(fingerprint(shifted, COMPLEX_FILES), base, zone);
  }

  const parallel = await Promise.all([1, 2, 3, 4].map(() => loadGitSignals(repo)));
  for (const signals of parallel) assert.equal(fingerprint(signals, COMPLEX_FILES), base);

  await sleep(1200);
  assert.equal(fingerprint(await loadGitSignals(repo), COMPLEX_FILES), base);

  // Variables that would point git at another repository, or change pathspec meaning, are ignored.
  const hostile = {
    GIT_DIR: join(decoy, '.git'),
    GIT_WORK_TREE: decoy,
    GIT_INDEX_FILE: join(decoy, '.git', 'index'),
    GIT_OBJECT_DIRECTORY: join(decoy, '.git', 'objects'),
    GIT_NAMESPACE: 'elsewhere',
    GIT_PREFIX: 'zzz/',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_ICASE_PATHSPECS: '1',
    GIT_EXTERNAL_DIFF: devNull,
    GIT_TRACE: join(dirname(repo), 'must-not-be-written.trace'),
    GIT_TRACE2: join(dirname(repo), 'must-not-be-written.trace2'),
  };
  assert.equal(fingerprint(await withEnv(hostile, () => loadGitSignals(repo)), COMPLEX_FILES), base);
  await assert.rejects(stat(hostile.GIT_TRACE));
  await assert.rejects(stat(hostile.GIT_TRACE2));
});

test('commit dates far in the past or future give the same ages as recent ones', async t => {
  const shifted = (offset: number): Step[] => [
    { time: offset, touch: ['a'] },
    { time: offset + 3 * DAY, touch: ['b'] },
    { time: offset + 10 * DAY, touch: ['c'] },
  ];
  for (const offset of [86_400, T0, 4_102_444_800]) {
    const signals = await loadGitSignals(await buildRepo(t, shifted(offset)));
    assert.deepEqual(['a', 'b', 'c'].map(path => signals.ageDays(path)), [10, 7, 0], String(offset));
  }
});

test('the module reads no clock or randomness, and leaves process.env alone', async t => {
  const source = await readFile(new URL('../src/gitsignals.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bDate\.now\s*\(|\bnew Date\b|\bMath\.random\s*\(|\bprocess\.hrtime\b/);
  const repo = await buildRepo(t, [{ day: 0, touch: ['a.ts'] }]);
  const before = JSON.stringify(process.env);
  await loadGitSignals(repo, { cacheDir: join(await scratch(t, 'cache'), 'x') });
  assert.equal(JSON.stringify(process.env), before);
});

/** Everything that identifies repository state: names, sizes, mtimes of all .git files plus key contents. */
async function gitDirFingerprint(repo: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        lines.push(`d ${relative}`);
        await walk(full, `${relative}/`);
      } else {
        const info = await lstat(full);
        const content = ['index', 'HEAD', 'config', 'packed-refs'].includes(entry.name)
          ? createHash('sha256').update(await readFile(full)).digest('hex')
          : '';
        lines.push(`f ${relative} ${info.size} ${info.mtimeMs} ${content}`);
      }
    }
  };
  await walk(join(repo, '.git'), '');
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

test('the repository is never modified, even when a plain git status would rewrite the index', async t => {
  const prepare = async (): Promise<string> => {
    const repo = await complexRepo(t);
    // Make every tracked file stat-dirty but content-identical: a normal `git status` refreshes and rewrites the index.
    for (const file of ['b.ts', 'c.ts', 'd e/f g.ts', 'm']) await utimes(join(repo, file), new Date(2031, 0, 1), new Date(2031, 0, 1));
    return repo;
  };

  const control = await prepare();
  const controlBefore = await gitDirFingerprint(control);
  execFileSync('git', ['status', '--porcelain'], { cwd: control, env: { ...pristineEnv() } });
  if (controlBefore === (await gitDirFingerprint(control))) t.diagnostic('control: plain git status did not rewrite the index on this git');

  const repo = await prepare();
  const before = await gitDirFingerprint(repo);
  const signals = await loadGitSignals(repo);
  assert.equal(signals.available, true);
  assert.equal(await gitDirFingerprint(repo), before);
  await assert.rejects(stat(join(repo, '.git', 'index.lock')));
  const dirtyAgain = await loadGitSignals(repo);
  assert.equal(await gitDirFingerprint(repo), before);
  assert.deepEqual([...dirtyAgain.dirty].sort(), ['a.ts', 'new.ts']);
});

test('repository-controlled config cannot run code and cannot change results', async t => {
  const repo = await complexRepo(t);
  const baseline = fingerprint(await withEnv(WITHOUT_ENV_CONFIG, () => loadGitSignals(repo)), COMPLEX_FILES);

  const hostRoot = await scratch(t, 'hooks');
  const marker = join(hostRoot, 'MARKER');
  const hook = join(hostRoot, 'fsmonitor-hook');
  await writeFile(hook, `#!/bin/sh\necho "$@" >> "${marker}"\nprintf '\\0'\n`);
  await chmod(hook, 0o755);
  const config: [string, string][] = [
    ['core.fsmonitor', hook],
    ['core.hooksPath', hostRoot],
    ['core.pager', `${hook}`],
    ['diff.external', hook],
    ['log.showSignature', 'true'],
    ['log.showRoot', 'false'],
    ['log.follow', 'true'],
    ['log.decorate', 'full'],
    ['diff.renames', 'copies'],
    ['diff.relative', 'true'],
    ['color.ui', 'always'],
    ['core.quotepath', 'true'],
    ['status.showUntrackedFiles', 'no'],
    ['status.relativePaths', 'false'],
    ['status.renames', 'copies'],
    ['status.short', 'true'],
    ['i18n.logOutputEncoding', 'ISO-8859-1'],
    ['format.pretty', 'oneline'],
    ['pretty.format', '%an'],
    ['alias.log', '!echo hijacked'],
  ];

  // Control: with the same config a plain `git status` does run the fsmonitor hook (when this git supports it).
  await appendConfig(repo, config);
  execFileSync('git', ['status', '--porcelain'], { cwd: repo, env: pristineEnv(), stdio: 'ignore' });
  const controlRan = await stat(marker).then(() => true, () => false);
  t.diagnostic(`control: plain git status ${controlRan ? 'did' : 'did not'} run the fsmonitor hook`);
  await rm(marker, { force: true });

  const hostile = await withEnv(WITHOUT_ENV_CONFIG, () => loadGitSignals(repo));
  await assert.rejects(stat(marker), 'fsmonitor hook must not run');
  assert.equal(fingerprint(hostile, COMPLEX_FILES), baseline);
});

test('replace refs cannot rewrite the history that is read', async t => {
  const repo = await complexRepo(t);
  const baseline = fingerprint(await loadGitSignals(repo), COMPLEX_FILES);
  const [recent, older] = git(repo, ['rev-list', '--first-parent', '-n', '2', 'HEAD']).trim().split('\n');
  git(repo, ['replace', '-f', recent, older]);
  assert.equal(fingerprint(await loadGitSignals(repo), COMPLEX_FILES), baseline);
});

test('partial clones never fetch: blob:none works offline, a clone without trees degrades with warnings', async t => {
  const source = await buildRepo(t, [{ day: 0, touch: ['a.ts', 'b.ts'] }, { day: 1, touch: ['a.ts'] }]);
  await appendConfig(source, [['uploadpack.allowFilter', 'true'], ['uploadpack.allowAnySHA1InWant', 'true']]);
  const parent = await scratch(t, 'partial');
  git(parent, ['clone', '-q', '--no-checkout', '--filter=blob:none', `file://${source}`, 'blobless']);
  git(parent, ['clone', '-q', '--no-checkout', '--filter=tree:0', `file://${source}`, 'treeless']);

  const blobless = join(parent, 'blobless');
  const before = await gitDirFingerprint(blobless);
  const complete = await loadGitSignals(blobless);
  assert.equal(complete.commitsAnalysed, 2);
  assert.equal(complete.churn('a.ts'), 2);
  assert.deepEqual(complete.warnings, []);
  assert.equal(await gitDirFingerprint(blobless), before);

  // A plain `git log` here would quietly fetch the missing trees from the promisor remote.
  const treeless = join(parent, 'treeless');
  const untouched = await gitDirFingerprint(treeless);
  const degraded = await loadGitSignals(treeless);
  assert.equal(degraded.available, true);
  assert.equal(degraded.commitsAnalysed, 0);
  assert.equal(degraded.truncatedBy, 'error');
  assert.match(degraded.warnings?.join('\n') ?? '', /git log failed/);
  assert.equal(await gitDirFingerprint(treeless), untouched, 'nothing was fetched');
});

// ------------------------------------------------------------------------------------------------------
// Persisted index
// ------------------------------------------------------------------------------------------------------

const cacheFiles = async (dir: string): Promise<string[]> => (await readdir(dir)).filter(name => name.startsWith('gitsig-')).sort();

test('cache: round trip is identical, private, atomic, and keyed by HEAD and options', async t => {
  const repo = await complexRepo(t);
  const cacheDir = join(await scratch(t, 'cache'), 'nested', 'dir');
  const first = await loadGitSignals(repo, { cacheDir });
  assert.equal(first.fromCache, false);
  const [file] = await cacheFiles(cacheDir);
  assert.match(file, /^gitsig-[0-9a-f]{32}\.json\.gz$/);
  assert.equal((await stat(join(cacheDir, file))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(cacheDir)).filter(name => name.endsWith('.tmp')), []);

  const second = await loadGitSignals(repo, { cacheDir });
  assert.equal(second.fromCache, true);
  assert.equal(fingerprint(second, COMPLEX_FILES), fingerprint(first, COMPLEX_FILES));
  assert.equal(second.commitsAnalysed, first.commitsAnalysed);
  assert.equal(second.headTime, first.headTime);

  // The working tree is never cached.
  await write(repo, 'b.ts', 'dirty now\n');
  const third = await loadGitSignals(repo, { cacheDir });
  assert.equal(third.fromCache, true);
  assert.deepEqual([...third.dirty].sort(), ['a.ts', 'b.ts', 'new.ts']);

  // A different window, file limit, root prefix or HEAD is a different entry; a truncated window is cacheable.
  await loadGitSignals(repo, { cacheDir, maxCommits: 3 });
  const windowed = await loadGitSignals(repo, { cacheDir, maxCommits: 3 });
  assert.equal(windowed.fromCache, true);
  assert.equal(windowed.commitsAnalysed, 3);
  assert.equal(windowed.truncatedBy, 'maxCommits');
  await loadGitSignals(repo, { cacheDir, maxFilesPerCommit: 2 });
  await loadGitSignals(join(repo, 'd e'), { cacheDir });
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'move head']);
  assert.equal((await loadGitSignals(repo, { cacheDir })).fromCache, false);
  assert.equal((await cacheFiles(cacheDir)).length, 5);
});

test('cache: concurrent writers never corrupt the entry', async t => {
  const repo = await complexRepo(t);
  const cacheDir = join(await scratch(t, 'cache'), 'c');
  const results = await Promise.all([1, 2, 3, 4].map(() => loadGitSignals(repo, { cacheDir })));
  const [first, ...rest] = results.map(signals => fingerprint(signals, COMPLEX_FILES));
  for (const other of rest) assert.equal(other, first);
  assert.equal((await cacheFiles(cacheDir)).length, 1);
  assert.deepEqual((await readdir(cacheDir)).filter(name => name.endsWith('.tmp')), []);
  assert.equal((await loadGitSignals(repo, { cacheDir })).fromCache, true);
});

test('cache: a hit does not run git log at all', async t => {
  const repo = await complexRepo(t);
  const cacheDir = join(await scratch(t, 'cache'), 'c');
  const log = join(await scratch(t, 'calls'), 'calls.txt');
  const spy = await executable(t, 'git', '#!/bin/sh\necho "$*" >> "$RSQ_FAKE_GIT_CALLS"\nexec git "$@"\n');
  const options = { cacheDir, gitBinary: spy };
  await withEnv({ RSQ_FAKE_GIT_CALLS: log }, async () => {
    await loadGitSignals(repo, options);
    const cold = (await readFile(log, 'utf8')).split('\n').filter(line => line.includes('--name-status')).length;
    assert.equal(cold, 1);
    await rm(log);
    const warm = await loadGitSignals(repo, options);
    assert.equal(warm.fromCache, true);
    const calls = await readFile(log, 'utf8');
    assert.equal(calls.split('\n').filter(line => line.includes('--name-status')).length, 0);
    assert.match(calls, /status --porcelain/);
  });
});

test('cache: corrupt, forged and hostile cache files are ignored and replaced', async t => {
  const repo = await complexRepo(t);
  const cacheDir = join(await scratch(t, 'cache'), 'c');
  const baseline = await loadGitSignals(repo, { cacheDir });
  const [name] = await cacheFiles(cacheDir);
  const path = join(cacheDir, name);
  const good = await readFile(path);
  const parsed = JSON.parse(gunzipSync(good).toString('utf8')) as Record<string, unknown>;
  const forge = (change: Record<string, unknown>): Buffer => gzipSync(JSON.stringify({ ...parsed, ...change }));
  const items = parsed.items as number[];
  const paths = parsed.paths as string[];

  const variants: [string, Buffer][] = [
    ['random bytes', Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 73 + 11) % 256))],
    ['empty file', Buffer.alloc(0)],
    ['truncated gzip', good.subarray(0, Math.floor(good.length / 2))],
    ['gzip of text', gzipSync('definitely not json')],
    ['json array', gzipSync('[]')],
    ['wrong version', forge({ version: 99 })],
    ['wrong key', forge({ key: 'f'.repeat(32) })],
    ['item out of range', forge({ items: [...items.slice(0, -1), 99_999_999] })],
    ['fractional item', forge({ items: [...items.slice(0, -1), 0.5] })],
    ['starts not matching items', forge({ starts: [0, 1] })],
    ['starts decreasing', forge({ starts: [0, items.length, 1, items.length] })],
    ['duplicate paths', forge({ paths: paths.map(() => paths[0]) })],
    ['numeric path', forge({ paths: [7, ...paths.slice(1)] })],
    ['negative time', forge({ newest: (parsed.newest as number[]).map(() => -5) })],
    ['dead out of range', forge({ dead: [12345] })],
    ['ignored not a number', forge({ ignored: 'many' })],
    ['decompression bomb', gzipSync(Buffer.alloc(80 * 1024 * 1024))],
  ];
  const want = fingerprint(baseline, COMPLEX_FILES);
  for (const [label, bytes] of variants) {
    await writeFile(path, bytes);
    const signals = await loadGitSignals(repo, { cacheDir });
    assert.equal(signals.fromCache, false, label);
    assert.equal(fingerprint(signals, COMPLEX_FILES), want, label);
    assert.deepEqual(JSON.parse(gunzipSync(await readFile(path)).toString('utf8')), parsed, `${label}: replaced by a valid cache`);
  }
});

test('cache: symlinks are never followed, read or written through', async t => {
  const repo = await complexRepo(t);
  const root = await scratch(t, 'cache');
  const cacheDir = join(root, 'c');
  await loadGitSignals(repo, { cacheDir });
  const [name] = await cacheFiles(cacheDir);
  const path = join(cacheDir, name);

  // A valid cache planted behind a symlink must not be used, and the link target must stay untouched.
  const decoy = join(root, 'decoy.json.gz');
  const bytes = await readFile(path);
  await writeFile(decoy, bytes);
  await rm(path);
  await symlink(decoy, path);
  const signals = await loadGitSignals(repo, { cacheDir });
  assert.equal(signals.fromCache, false);
  assert.deepEqual(await readFile(decoy), bytes);
  assert.equal((await lstat(path)).isSymbolicLink(), false);
  assert.equal((await loadGitSignals(repo, { cacheDir })).fromCache, true);

  // A dangling link where the file should go is replaced, not written through.
  const victim = join(root, 'victim.txt');
  await rm(path);
  await symlink(victim, path);
  await loadGitSignals(repo, { cacheDir });
  await assert.rejects(stat(victim));
  assert.equal((await lstat(path)).isFile(), true);
});

test('cache: an unusable cache directory only costs the cache', async t => {
  const repo = await buildRepo(t, [{ day: 0, touch: ['a.ts'] }]);
  const root = await scratch(t, 'cache');
  await writeFile(join(root, 'plain-file'), 'x');
  const blocked = await loadGitSignals(repo, { cacheDir: join(root, 'plain-file', 'sub') });
  assert.equal(blocked.available, true);
  assert.equal(blocked.fromCache, false);
  assert.equal(blocked.churn('a.ts'), 1);
  if (process.getuid?.() !== 0) {
    const readOnly = join(root, 'ro');
    await mkdir(readOnly, { mode: 0o500 });
    const denied = await loadGitSignals(repo, { cacheDir: readOnly });
    assert.equal(denied.available, true);
    assert.deepEqual(await readdir(readOnly), []);
    await chmod(readOnly, 0o700);
  }
});

test('cache: old entries are pruned but foreign files are left alone', async t => {
  const repo = await buildRepo(t, [{ day: 0, touch: ['a.ts'] }]);
  const cacheDir = await scratch(t, 'cache');
  await writeFile(join(cacheDir, 'notes.txt'), 'keep me');
  const old = new Date(2001, 0, 1);
  for (let i = 0; i < 70; i++) {
    const stale = join(cacheDir, `gitsig-${i.toString(16).padStart(32, '0')}.json.gz`);
    await writeFile(stale, 'stale');
    await utimes(stale, old, old);
  }
  const signals = await loadGitSignals(repo, { cacheDir });
  assert.equal(signals.available, true);
  const remaining = await cacheFiles(cacheDir);
  assert(remaining.length <= 64, `kept ${remaining.length}`);
  assert.equal((await loadGitSignals(repo, { cacheDir })).fromCache, true);
  assert.equal(await readFile(join(cacheDir, 'notes.txt'), 'utf8'), 'keep me');
});
