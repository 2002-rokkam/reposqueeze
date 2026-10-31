import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createGzip, gunzipSync, gzipSync } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { args, type CliRun } from '../lib/cli.js';
import { git, gitInit, makeWritable } from '../lib/fixtures.js';
import { CONTROL, CONTROL_ANCHOR, processVerdict, rssGiB, runStats } from './common.js';
import { describeRun, fail, pass, single, skip, warn, type Ctx, type Group, type Verdict } from './types.js';

const CASCADE = { REPOSQUEEZE_LARGE_THRESHOLD: '10' };

/** `count` ordinary files so that a repository crosses the (lowered) persistent-index threshold. */
function filler(count: number, prefix = 'src/gen'): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) files[`${prefix}/mod${String(i).padStart(3, '0')}.py`] = `def helper_${i}(value):\n    return value + ${i}\n`;
  return files;
}

function found(run: CliRun): boolean {
  return run.outcome === 'ok' && run.stdoutText.includes(CONTROL_ANCHOR);
}

/** Runs context+map and requires: no crash/hang, and the control file retrievable. */
async function survives(ctx: Ctx, repo: string, env?: Record<string, string | undefined>, options: { timeoutMs?: number; expectControl?: boolean } = {}): Promise<Verdict> {
  const context = await ctx.cli(args.context(repo, CONTROL_ANCHOR, 1000), { env, timeoutMs: options.timeoutMs });
  const map = await ctx.cli(args.map(repo, 1500), { env, timeoutMs: options.timeoutMs });
  const problem = processVerdict([['context', context], ['map', map]], 2);
  if (problem) return problem;
  if (options.expectControl !== false && !found(context)) return fail(`context did not return the control file: ${describeRun(context)}`);
  return pass(`context ${runStats(context)}`);
}

const scenario = (id: string, title: string, severity: 'critical' | 'high' | 'medium' | 'low', body: (ctx: Ctx) => Promise<Verdict>): Group<Verdict> => single(id, 'environment', title, severity, body);

interface ConcurrencyState {
  rounds: { label: string; runs: CliRun[]; references: string[] }[];
  cacheValid: boolean;
  leftoverTemp: string[];
  followUpMatches: boolean;
  cachePath: string;
}

/** Eight simultaneous invocations sharing one persistent cache (cold start, then forced refresh). */
async function concurrency(ctx: Ctx): Promise<ConcurrencyState> {
  const repo = await ctx.makeRepo('concurrent', { ...CONTROL, ...filler(40) }, { git: true });
  const { env } = ctx.cacheEnv('concurrent');
  const base = { ...env, ...CASCADE };
  const queries = [CONTROL_ANCHOR, 'helper_7 value'];
  const references: string[] = [];
  for (const query of queries) references.push((await ctx.cli(args.context(repo, query, 1000), { env: base })).stdoutText);
  const cacheDir = join(repo, '.reposqueeze-v2');
  const state: ConcurrencyState = { rounds: [], cacheValid: false, leftoverTemp: [], followUpMatches: false, cachePath: cacheDir };
  const burst = async (label: string, extraEnv: Record<string, string>, cold: boolean) => {
    if (cold) await rm(cacheDir, { recursive: true, force: true });
    const runs = await Promise.all(Array.from({ length: 8 }, (_, i) => ctx.cli(args.context(repo, queries[i % 2], 1000), { env: { ...base, ...extraEnv }, burst: true })));
    state.rounds.push({ label, runs, references: runs.map((_, i) => references[i % 2]) });
  };
  await burst('cold start, round 1', {}, true);
  await burst('cold start, round 2', {}, true);
  await burst('forced refresh on a warm cache', { REPOSQUEEZE_REFRESH_INDEX: '1' }, false);
  const listing = await readdir(cacheDir).catch(() => [] as string[]);
  state.leftoverTemp = listing.filter(name => name.endsWith('.tmp'));
  try {
    const raw = await readFile(join(cacheDir, 'file-sketch-v1.json.gz'));
    JSON.parse(gunzipSync(raw).toString('utf8'));
    state.cacheValid = true;
  } catch {
    state.cacheValid = listing.length === 0;
  }
  const follow = await ctx.cli(args.context(repo, queries[0], 1000), { env: base });
  state.followUpMatches = follow.stdoutText === references[0];
  return state;
}

const concurrencyGroup: Group<ConcurrencyState> = {
  id: 'env/concurrency',
  category: 'environment',
  title: '8 simultaneous CLI invocations on one repository with a persistent cache',
  setup: concurrency,
  checks: [
    {
      id: 'env/concurrent-no-crash',
      title: '8 concurrent invocations (cold cache x2, forced refresh x1) all succeed',
      severity: 'high',
      run: state => {
        const failures = state.rounds.flatMap(round => round.runs.filter(run => run.outcome !== 'ok').map(run => `${round.label}: ${run.outcome} ${run.detail}`));
        return failures.length ? fail(`${failures.length}/24 invocations failed; first: ${failures[0]}`) : pass('24/24 succeeded');
      },
    },
    {
      id: 'env/concurrent-deterministic',
      title: 'concurrent invocations return the same bytes as sequential ones',
      severity: 'high',
      run: state => {
        const bad = state.rounds.flatMap(round => round.runs.filter((run, i) => run.outcome === 'ok' && run.stdoutText !== round.references[i]));
        return bad.length ? fail(`${bad.length} concurrent outputs differ from the sequential reference`) : pass();
      },
    },
    {
      id: 'env/concurrent-cache-intact',
      title: 'the shared cache is valid afterwards, no temporary files are left and the next run is still correct',
      severity: 'high',
      run: state => (state.cacheValid && !state.leftoverTemp.length && state.followUpMatches ? pass() : fail(`cache valid=${state.cacheValid}, leftover tmp=${state.leftoverTemp.join(',') || 'none'}, follow-up identical=${state.followUpMatches}`)),
    },
  ],
};

/** Read-only checkouts: permission-based (EACCES) and a genuinely read-only volume (EROFS). */
async function hdiutil(args_: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    const child = spawn('hdiutil', args_, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => (out += chunk));
    child.stderr.on('data', chunk => (out += chunk));
    child.on('error', error => resolve({ ok: false, out: error.message }));
    child.on('close', code => resolve({ ok: code === 0, out }));
  });
}

async function readOnlyErofs(ctx: Ctx): Promise<Verdict> {
  const source = await ctx.makeRepo('ro-source', { ...CONTROL, ...filler(40) }, { git: true });
  const image = join(ctx.dir, 'ro.dmg');
  const mount = join(ctx.dir, 'ro-mount');
  await mkdir(mount, { recursive: true });
  const created = await hdiutil(['create', '-srcfolder', source, '-format', 'UDRO', '-volname', 'rsqro', '-fs', 'HFS+', '-quiet', image]);
  if (!created.ok) return skip(`hdiutil create failed: ${created.out.trim().slice(0, 120)}`);
  const attached = await hdiutil(['attach', '-readonly', '-nobrowse', '-noverify', '-mountpoint', mount, image]);
  if (!attached.ok) return skip(`hdiutil attach failed: ${attached.out.trim().slice(0, 120)}`);
  try {
    const root = join(mount, 'ro-source');
    const probe = await stat(root).then(() => root, () => mount);
    const context = await ctx.cli(args.context(probe, CONTROL_ANCHOR, 1000), { env: CASCADE });
    const problem = processVerdict([['context', context]], 2);
    if (problem) return problem;
    return found(context) ? pass(`read-only volume: ${runStats(context)}`) : fail(`context on a read-only volume: ${describeRun(context)}`);
  } finally {
    await hdiutil(['detach', mount, '-force', '-quiet']);
  }
}

/** Bomb-sized gzip stream of zeros without holding it in memory. */
async function writeGzipBomb(path: string, mebibytes: number): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const zeros = Buffer.alloc(1024 * 1024);
  async function* chunks() {
    for (let i = 0; i < mebibytes; i++) yield zeros;
  }
  await pipeline(Readable.from(chunks()), createGzip({ level: 9 }), createWriteStream(path));
  return (await stat(path)).size;
}

async function plantedCache(ctx: Ctx, name: string, plant: (cacheFile: string, repo: string) => Promise<void>): Promise<{ context: CliRun; repo: string }> {
  const repo = await ctx.makeRepo(name, { ...CONTROL, ...filler(30) }, { git: true });
  await plant(join(repo, '.reposqueeze-v2', 'file-sketch-v1.json.gz'), repo);
  return { repo, context: await ctx.cli(args.context(repo, CONTROL_ANCHOR, 1000), { env: CASCADE }) };
}

const LOCALES = ['en_US.UTF-8', 'C', 'de_DE.UTF-8', 'sv_SE.UTF-8'];

export const environmentGroups: Group<any>[] = [
  scenario('env/unreadable-file-git', 'a file with mode 000 in a git checkout is skipped, not fatal', 'medium', async ctx => {
    const repo = await ctx.makeRepo('unreadable-file-git', { ...CONTROL, 'locked/locked.txt': 'lockedanchorqq\n' }, { git: true });
    await chmod(join(repo, 'locked/locked.txt'), 0o000);
    return survives(ctx, repo);
  }),
  scenario('env/unreadable-file-nongit', 'a file with mode 000 in a plain directory is skipped, not fatal', 'medium', async ctx => {
    const repo = await ctx.makeRepo('unreadable-file-nongit', { ...CONTROL, 'locked/locked.txt': 'lockedanchorqq\n' });
    await chmod(join(repo, 'locked/locked.txt'), 0o000);
    return survives(ctx, repo);
  }),
  scenario('env/unreadable-dir-git', 'a directory with mode 000 in a git checkout is skipped, not fatal', 'medium', async ctx => {
    const repo = await ctx.makeRepo('unreadable-dir-git', { ...CONTROL, 'locked/inner/a.txt': 'x\n' }, { git: true });
    await chmod(join(repo, 'locked'), 0o000);
    return survives(ctx, repo);
  }),
  scenario('env/unreadable-dir-nongit', 'a directory with mode 000 in a plain directory is skipped, not fatal', 'high', async ctx => {
    const repo = await ctx.makeRepo('unreadable-dir-nongit', { ...CONTROL, 'locked/inner/a.txt': 'x\n' });
    await chmod(join(repo, 'locked'), 0o000);
    return survives(ctx, repo);
  }),
  scenario('env/non-git-directory', 'a plain (non-git) directory works', 'medium', async ctx => survives(ctx, await ctx.makeRepo('plain', { ...CONTROL, ...filler(5) }))),
  scenario('env/empty-directory', 'an empty plain directory is answered or refused cleanly', 'medium', async ctx => {
    const repo = await ctx.makeRepo('empty-dir', {});
    const context = await ctx.cli(args.context(repo, 'anything at all', 1000));
    const map = await ctx.cli(args.map(repo, 500));
    const problem = processVerdict([['context', context], ['map', map]], 1);
    return problem ?? pass(`context ${context.outcome}, map ${map.outcome}`);
  }),
  scenario('env/empty-git-repository', 'a git repository without commits or files is answered or refused cleanly', 'medium', async ctx => {
    const repo = await ctx.makeRepo('empty-git', {});
    await gitInit(repo, { commit: false });
    const context = await ctx.cli(args.context(repo, 'anything at all', 1000));
    const expand = await ctx.cli(args.expand(repo, 'nothing.ts', 1, 10));
    const problem = processVerdict([['context', context], ['expand', expand]], 1);
    return problem ?? pass(`context ${context.outcome}, expand ${expand.outcome}`);
  }),
  scenario('env/binary-only-repository', 'a repository with only binary files is answered or refused cleanly', 'medium', async ctx => {
    const repo = await ctx.makeRepo('binary-only', { 'a.bin': Buffer.from([0, 1, 2, 3, 0, 255]), 'b.dat': Buffer.alloc(4096, 0), 'logo.png': Buffer.from([137, 80, 78, 71, 0]) }, { git: true });
    const context = await ctx.cli(args.context(repo, 'anything at all', 1000));
    const map = await ctx.cli(args.map(repo, 500));
    return processVerdict([['context', context], ['map', map]], 1) ?? pass(`context ${context.outcome}, map ${map.outcome}`);
  }),
  scenario('env/root-is-a-file', 'a --root that is a regular file is refused or answered, never a crash', 'medium', async ctx => {
    const repo = await ctx.makeRepo('root-file', CONTROL);
    const run = await ctx.cli(args.context(join(repo, 'README.md'), 'anything', 1000));
    return processVerdict([['context', run]], 1) ?? (run.outcome === 'clean-error' ? pass(`refused: ${run.detail}`) : warn(`accepted a file as the repository root (${run.outcome})`));
  }),
  scenario('env/root-missing', 'a missing --root gives a clean error', 'low', async ctx => {
    const run = await ctx.cli(args.context(join(ctx.dir, 'does-not-exist'), 'anything', 1000));
    return run.outcome === 'clean-error' ? pass(run.detail) : fail(describeRun(run));
  }),
  scenario('env/root-is-filesystem-root', '--root / is refused or stays bounded (output discarded)', 'medium', async ctx => {
    const run = await ctx.cli(args.context('/', 'password', 1000), { timeoutMs: Math.min(ctx.timeoutMs, 90_000) });
    if (run.outcome === 'clean-error') return pass(`refused: ${run.detail}`);
    if (run.outcome === 'ok') return rssGiB(run) <= 2 ? warn(`did not refuse: indexed the filesystem root in ${runStats(run)} (output discarded)`) : fail(`root indexing used ${rssGiB(run).toFixed(1)} GiB`);
    if (run.outcome === 'timeout') return fail(`did not refuse and did not finish within 90 s: walks the whole filesystem (${runStats(run)})`);
    return fail(describeRun(run));
  }),
  concurrencyGroup,
  scenario('env/read-only-checkout-eacces', 'a checkout without write permission still answers (persistent-index mode)', 'high', async ctx => {
    const repo = await ctx.makeRepo('ro-chmod', { ...CONTROL, ...filler(40) }, { git: true });
    await makeWritable(repo);
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (!entry.isSymbolicLink()) await chmod(path, 0o444);
      }
      await chmod(dir, 0o555);
    };
    await walk(repo);
    return survives(ctx, repo, CASCADE);
  }),
  scenario('env/read-only-checkout-erofs', 'a read-only volume (EROFS) still answers (persistent-index mode)', 'high', readOnlyErofs),
  scenario('env/git-missing-from-path', 'with git absent from PATH the tool falls back to directory walking', 'medium', async ctx => {
    const repo = await ctx.makeRepo('no-git-binary', { ...CONTROL, ...filler(5) }, { git: true });
    return survives(ctx, repo, { PATH: '/usr/nonexistent' });
  }),
  scenario('env/git-config-command-execution', 'a repository-controlled .git/config (core.fsmonitor) does not run commands during enumeration', 'critical', async ctx => {
    const repo = await ctx.makeRepo('fsmonitor', { ...CONTROL, ...filler(3) }, { git: true });
    const marker = join(ctx.dir, 'fsmonitor-ran.txt');
    const hook = join(ctx.dir, 'fsmonitor-hook.sh');
    await writeFile(hook, `#!/bin/sh\necho executed > "${marker}"\nprintf '\\0'\n`);
    await chmod(hook, 0o755);
    await git(repo, ['config', '--local', 'core.fsmonitor', hook]);
    const context = await ctx.cli(args.context(repo, CONTROL_ANCHOR, 1000));
    const map = await ctx.cli(args.map(repo, 500));
    const problem = processVerdict([['context', context], ['map', map]], 1);
    if (problem) return problem;
    const ran = await stat(marker).then(() => true, () => false);
    return ran ? fail('the repository\'s core.fsmonitor command was executed by the tool\'s git invocation') : pass('hook not executed');
  }),
  scenario('env/locale-independence', 'output is byte-identical under different LC_ALL/LANG settings (git and plain directory)', 'medium', async ctx => {
    const files: Record<string, string> = { ...CONTROL };
    for (const name of ['a', 'B', 'z', 'Z', 'ä', 'ö', 'å', 'ñ']) files[`names/${name}.txt`] = `localeanchor ${name} sorting sample\n`;
    for (let i = 0; i < 1240; i++) files[`data/f${String(i).padStart(4, '0')}.txt`] = `row ${i} localeanchor\n`;
    const results: string[] = [];
    for (const git of [true, false]) {
      const repo = await ctx.makeRepo(git ? 'locale-git' : 'locale-plain', files, { git });
      const outputs = new Map<string, string>();
      for (const locale of LOCALES) {
        const run = await ctx.cli(args.context(repo, 'localeanchor sorting sample', 1000), { env: { LC_ALL: locale, LANG: locale } });
        if (run.outcome !== 'ok') return fail(`${git ? 'git' : 'plain'} / ${locale}: ${describeRun(run)}`);
        outputs.set(locale, run.stdoutText);
      }
      const reference = outputs.get(LOCALES[0])!;
      const differing = LOCALES.filter(locale => outputs.get(locale) !== reference);
      if (differing.length) {
        const header = (text: string) => text.split('\n')[0].slice(0, 90);
        results.push(`${git ? 'git' : 'plain dir'}: differs under ${differing.join(', ')} (header "${header(outputs.get(differing[0])!)}" vs "${header(reference)}")`);
      }
    }
    return results.length ? fail(results.join('; ')) : pass(`identical under ${LOCALES.join(', ')}`);
  }),
  scenario('env/cwd-and-root-spelling-independence', 'same bytes whether --root is "." (any cwd), absolute, relative or has a trailing slash', 'low', async ctx => {
    const repo = await ctx.makeRepo('spelling', { ...CONTROL, ...filler(6) }, { git: true });
    const query = 'helper_3 value';
    const absolute = await ctx.cli(args.context(repo, query, 1000), { cwd: ctx.dir });
    const dot = await ctx.cli(['context', '--root=.', `--query=${query}`, '--budget=1000'], { cwd: repo });
    const relative = await ctx.cli(['context', '--root=spelling', `--query=${query}`, '--budget=1000'], { cwd: ctx.dir });
    const slash = await ctx.cli(args.context(`${repo}/`, query, 1000), { cwd: ctx.dir });
    const outs = [absolute, dot, relative, slash];
    const bad = outs.filter(run => run.outcome !== 'ok');
    if (bad.length) return fail(describeRun(bad[0]));
    return new Set(outs.map(run => run.stdoutSha)).size === 1 ? pass() : fail('output differs with the spelling of --root / cwd');
  }),
  scenario('env/location-order-mtime-independence', 'same content in another directory, created in another order with other mtimes, gives identical bytes (git and persistent-index mode)', 'medium', async ctx => {
    const files = { ...CONTROL, ...filler(30) };
    const names = Object.keys(files);
    const a = await ctx.makeRepo('twin-a', files, { git: true });
    const reversed: Record<string, string> = {};
    for (const name of [...names].reverse()) reversed[name] = files[name as keyof typeof files];
    const b = await ctx.makeRepo(join('nested', 'deeper', 'twin-b'), reversed, { git: true });
    for (const [index, name] of names.entries()) await utimes(join(b, name), new Date(1_500_000_000_000 + index * 86_400_000), new Date(1_500_000_000_000 + index * 86_400_000));
    const query = 'helper_7 value limitsanchorcontrol';
    for (const [label, env] of [['default', {}], ['persistent-index mode', CASCADE]] as const) {
      const left = await ctx.cli(args.context(a, query, 1000), { env });
      const right = await ctx.cli(args.context(b, query, 1000), { env });
      if (left.outcome !== 'ok' || right.outcome !== 'ok') return fail(`${label}: ${describeRun(left.outcome === 'ok' ? right : left)}`);
      if (left.stdoutSha !== right.stdoutSha) return fail(`${label}: output differs between two identical snapshots`);
    }
    return pass();
  }),
  scenario('env/planted-cache-garbage', 'an unreadable cache file planted in the repository is ignored', 'medium', async ctx => {
    const { context } = await plantedCache(ctx, 'cache-garbage', async file => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, Buffer.from('this is not gzip data at all'));
    });
    return processVerdict([['context', context]], 2) ?? (found(context) ? pass() : fail(describeRun(context)));
  }),
  scenario('env/planted-cache-wrong-shape', 'a well-formed but malformed cache planted in the repository cannot crash the tool', 'high', async ctx => {
    const { context } = await plantedCache(ctx, 'cache-shape', async (file, repo) => {
      const info = await stat(join(repo, 'src/control.py'));
      const files = [{ path: 'src/control.py', size: info.size, mtimeMs: Math.trunc(info.mtimeMs), digest: 'x', language: 'python', lines: 2, tokenCount: 5 }];
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, gzipSync(JSON.stringify({ version: 1, files })));
    });
    return processVerdict([['context', context]], 2) ?? (found(context) ? pass() : fail(describeRun(context)));
  }),
  scenario('env/planted-cache-gzip-bomb', 'a gzip bomb planted as the cache (512 MiB of zeros) does not exhaust memory', 'medium', async ctx => {
    let compressed = 0;
    const { context } = await plantedCache(ctx, 'cache-bomb', async file => {
      compressed = await writeGzipBomb(file, 512);
    });
    const problem = processVerdict([['context', context]], 1);
    if (problem) return problem;
    return found(context) ? pass(`${(compressed / 1024).toFixed(0)} KiB bomb: ${runStats(context)}`) : fail(describeRun(context));
  }),
  scenario('env/home-and-tmpdir-unusable', 'works with HOME unset and TMPDIR pointing nowhere', 'low', async ctx => survives(ctx, await ctx.makeRepo('no-home', CONTROL, { git: true }), { HOME: undefined, TMPDIR: '/nonexistent/tmp' })),
];
