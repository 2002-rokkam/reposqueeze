/**
 * Measures src/gitsignals.ts on real or synthetic repositories.
 *
 *   node --import tsx scripts/gitsignals-eval.ts run <repo>... [--runs 3] [--max-commits 2000] [--cache-dir DIR] [--json FILE]
 *   node --import tsx scripts/gitsignals-eval.ts synth <dir> [--commits N] [--files N] [--mass-every N] [--mass-size N]
 *   node --import tsx scripts/gitsignals-eval.ts lift <repo>... --scratch DIR [--snapshots 25] [--span 1500] [--json FILE]
 *
 * `run` measures every repository in a fresh process (so peak RSS is meaningful): cold wall time (median of
 * --runs), a cache write + cache hit, and, on macOS, the CPU time of each git process via /usr/bin/time.
 * Wall time on a loaded machine mostly measures the load, so every row reports the load average seen while
 * measuring and CPU time next to it. `synth` generates a deterministic repository with fast-import (no
 * working tree) so scale can be tested without cloning large projects.
 *
 * `lift` asks whether the signals carry information at all: for sampled historical commits C it loads the
 * signals as of C's parent (a scratch repository that borrows the objects of <repo> and points HEAD at the
 * parent, so nothing is checked out and <repo> is untouched) and checks where the files that C modified rank
 * under recency and churn, and whether co-change finds the other modified files given one of them.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGitSignals, type GitSignalsOptions } from '../src/gitsignals.js';

const SCRIPT = fileURLToPath(import.meta.url);

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const positional = (): string[] => {
  const values: string[] = [];
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) i++;
    else values.push(process.argv[i]);
  }
  return values;
};

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;
const load = (): string => loadavg().map(value => value.toFixed(1)).join('/');

// ---------------------------------------------------------------------------------------------------------
// Child: one measurement in a clean process
// ---------------------------------------------------------------------------------------------------------

interface Measurement {
  wallMs: number;
  nodeCpuMs: number;
  baseRssMb: number;
  peakRssMb: number;
  commitsAnalysed: number;
  commitsIgnored: number;
  truncatedBy: string | null;
  dirty: number;
  trackedFiles: number;
  trackedWithHistory: number;
  fromCache: boolean;
  queryMicros: { churn: number; ageDays: number; coChanged: number };
  loadAtEnd: string;
  git?: Record<string, { cpuMs: number; maxRssMb: number; calls: number }>;
}

/** One file per git invocation: its first line is `CMD <args>`, the rest is the output of `/usr/bin/time -l`. */
function parseGitTimings(files: string[]): Measurement['git'] {
  const result: NonNullable<Measurement['git']> = {};
  for (const text of files) {
    const [command = '', ...rest] = text.split('\n');
    const words = ` ${command} `;
    const kind = words.includes(' log ') ? 'log' : words.includes(' status ') ? 'status' : 'other';
    result[kind] ??= { cpuMs: 0, maxRssMb: 0, calls: 0 };
    result[kind].calls++;
    for (const line of rest) {
      const cpu = /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/.exec(line);
      if (cpu) result[kind].cpuMs += (Number(cpu[2]) + Number(cpu[3])) * 1000;
      const rss = /(\d+)\s+maximum resident set size/.exec(line);
      if (rss) result[kind].maxRssMb = Math.max(result[kind].maxRssMb, mb(Number(rss[1])));
    }
  }
  return result;
}

async function measure(repo: string, options: GitSignalsOptions, withGitCpu: boolean): Promise<Measurement> {
  // From HEAD's tree rather than the index, so repositories without a working tree work too.
  const listing = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { cwd: repo, maxBuffer: 1 << 30 });
  const tracked = listing.toString('utf8').split('\0').filter(Boolean);
  let timingDir = '';
  if (withGitCpu) {
    timingDir = mkdtempSync(join(process.env.RSQ_EVAL_TMP || tmpdir(), 'gitsig-eval-'));
    const wrapper = join(timingDir, 'git');
    const script = [
      '#!/bin/sh',
      'out="$RSQ_EVAL_TIMING/call.$$"',
      'echo "CMD $*" > "$out"',
      'exec /usr/bin/time -l -a -o "$out" git "$@"',
      '',
    ].join('\n');
    writeFileSync(wrapper, script);
    chmodSync(wrapper, 0o755);
    process.env.RSQ_EVAL_TIMING = timingDir;
    options = { ...options, gitBinary: wrapper };
  }

  const baseRss = process.memoryUsage().rss;
  let peak = baseRss;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 5);
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  const signals = await loadGitSignals(repo, options);
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);

  const time = (run: () => void, count: number): number => {
    const begin = performance.now();
    run();
    return ((performance.now() - begin) * 1000) / count;
  };
  const sample = tracked.filter((_, i) => i % Math.max(1, Math.floor(tracked.length / 500)) === 0).slice(0, 500);
  const queryMicros = {
    churn: time(() => sample.forEach(path => signals.churn(path)), sample.length || 1),
    ageDays: time(() => sample.forEach(path => signals.ageDays(path)), sample.length || 1),
    coChanged: time(() => sample.forEach(path => signals.coChanged(path, 10)), sample.length || 1),
  };
  let git: Measurement['git'];
  if (withGitCpu) {
    const calls = readdirSync(timingDir).filter(name => name.startsWith('call.'));
    git = parseGitTimings(calls.map(name => readFileSync(join(timingDir, name), 'utf8')));
    rmSync(timingDir, { recursive: true, force: true });
  }
  return {
    wallMs,
    nodeCpuMs: (cpu.user + cpu.system) / 1000,
    baseRssMb: mb(baseRss),
    peakRssMb: mb(peak),
    commitsAnalysed: signals.commitsAnalysed,
    commitsIgnored: signals.commitsIgnored ?? 0,
    truncatedBy: signals.truncatedBy ?? null,
    dirty: signals.dirty.size,
    trackedFiles: tracked.length,
    trackedWithHistory: tracked.filter(path => signals.churn(path) > 0).length,
    fromCache: signals.fromCache === true,
    queryMicros,
    loadAtEnd: load(),
    git,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Parent: orchestrate fresh processes
// ---------------------------------------------------------------------------------------------------------

function child(repo: string, extra: string[]): Measurement {
  const run = spawnSync(process.execPath, [...process.execArgv, SCRIPT, 'measure', repo, ...extra], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  if (run.status !== 0) throw new Error(`measurement failed: ${run.stderr || run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}') as Measurement;
}

function runAll(): void {
  const repos = positional();
  const runs = Number(flag('runs', '3'));
  const maxCommits = flag('max-commits', '2000');
  const cacheDir = flag('cache-dir', '');
  const header = [
    'repo', 'tracked files', 'commits (total)', 'analysed / ignored', 'files with history',
    `cold wall ms (median of ${runs})`, 'node CPU ms', 'git CPU ms log / status / other', 'warm cache wall ms',
    'peak RSS MB (base)', 'churn / age / coChanged µs per call', 'load 1m/5m/15m',
  ];
  console.log(`| ${header.join(' | ')} |`);
  console.log(`|${header.map(() => '---').join('|')}|`);

  const rows: Record<string, unknown>[] = [];
  for (const repo of repos) {
    const name = repo.split('/').filter(Boolean).pop() ?? repo;
    const total = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo }).toString().trim());
    const common = ['--max-commits', maxCommits];
    const loadBefore = load();
    const cold = Array.from({ length: runs }, () => child(repo, common));
    const cpuRun = process.platform === 'darwin' ? child(repo, [...common, '--git-cpu']) : undefined;
    let warm: Measurement | undefined;
    if (cacheDir) {
      rmSync(cacheDir, { recursive: true, force: true });
      child(repo, [...common, '--cache-dir', cacheDir]);
      warm = child(repo, [...common, '--cache-dir', cacheDir]);
      rmSync(cacheDir, { recursive: true, force: true });
    }
    rows.push({ repo: name, total, loadBefore, cold, cpuRun, warm });

    const first = cold[0];
    const git = cpuRun?.git ?? {};
    const truncated = first.truncatedBy ? ` (truncated: ${first.truncatedBy})` : '';
    const cells = [
      name,
      first.trackedFiles,
      total,
      `${first.commitsAnalysed} / ${first.commitsIgnored}${truncated}`,
      first.trackedWithHistory,
      Math.round(median(cold.map(m => m.wallMs))),
      Math.round(median(cold.map(m => m.nodeCpuMs))),
      ['log', 'status', 'other'].map(kind => Math.round(git[kind]?.cpuMs ?? 0)).join(' / '),
      warm ? Math.round(warm.wallMs) : '-',
      `${Math.max(...cold.map(m => m.peakRssMb))} (${first.baseRssMb})`,
      [first.queryMicros.churn, first.queryMicros.ageDays].map(v => v.toFixed(2)).concat(first.queryMicros.coChanged.toFixed(1)).join(' / '),
      `${loadBefore} -> ${cold[cold.length - 1].loadAtEnd}`,
    ];
    console.log(`| ${cells.join(' | ')} |`);
  }
  const out = flag('json', '');
  if (out) writeFileSync(out, `${JSON.stringify({ node: process.version, platform: process.platform, maxCommits, rows }, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------------------
// Synthetic repositories
// ---------------------------------------------------------------------------------------------------------

/** Deterministic PRNG so the same flags always produce the same repository. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function synthesise(): Promise<void> {
  const [target] = positional();
  if (!target) throw new Error('usage: synth <dir> [--commits N] [--files N] [--mass-every N] [--mass-size N]');
  const commits = Number(flag('commits', '20000'));
  const files = Number(flag('files', '20000'));
  const massEvery = Number(flag('mass-every', '1000'));
  const massSize = Number(flag('mass-size', '500'));
  const perDirectory = 50;
  const directories = Math.ceil(files / perDirectory);
  const pathOf = (id: number): string => `src/d${Math.floor(id / perDirectory)}/f${id % perDirectory}.ts`;
  const random = mulberry32(20260101);

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  execFileSync('git', ['init', '-q'], { cwd: target, env });
  writeFileSync(join(target, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const importer = spawn('git', ['fast-import', '--quiet'], { cwd: target, env, stdio: ['pipe', 'inherit', 'inherit'] });
  const finished = new Promise<void>((resolve, reject) => {
    importer.on('close', code => (code === 0 ? resolve() : reject(new Error(`fast-import exited with ${code}`))));
  });

  const base = 1_600_000_000;
  let buffer: string[] = [];
  const flush = async (): Promise<void> => {
    if (!importer.stdin.write(buffer.join(''))) await new Promise(resolve => importer.stdin.once('drain', resolve));
    buffer = [];
  };
  for (let commit = 0; commit < commits; commit++) {
    let ids: number[];
    if (commit === 0) ids = Array.from({ length: files }, (_, id) => id);
    else if (massEvery > 0 && commit % massEvery === 0) ids = Array.from({ length: massSize }, () => Math.floor(random() * files));
    else {
      // Files of one directory tend to change together.
      const directory = Math.floor(random() * directories);
      ids = Array.from({ length: 2 + Math.floor(random() * 5) }, () => directory * perDirectory + Math.floor(random() * perDirectory));
    }
    const message = `c${commit}`;
    buffer.push(`commit refs/heads/main\ncommitter Synth <synth@example.com> ${base + commit * 1800} +0000\ndata ${message.length}\n${message}\n`);
    for (const id of new Set(ids)) {
      if (id >= files) continue;
      const body = `${pathOf(id)}@${commit}\n`;
      buffer.push(`M 100644 inline ${pathOf(id)}\ndata ${body.length}\n${body}\n`);
    }
    buffer.push('\n');
    if (commit % 500 === 499) await flush();
  }
  await flush();
  importer.stdin.end();
  await finished;
  console.log(`synthesised ${commits} commits over ${files} files in ${target}`);
}

// ---------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------
// Do the signals carry information? Prior-only lift on historical snapshots
// ---------------------------------------------------------------------------------------------------------

interface HistoricalChange {
  commit: string;
  parent: string;
  modified: string[];
}

/** Parses `git log -z --name-status --pretty=format:'%H %P'`: header[\nSTATUS] (PATH NUL STATUS NUL)*, commits end at an empty token. */
function parseLog(text: string): { header: string; entries: [string, string][] }[] {
  const tokens = text.split('\0');
  const commits: { header: string; entries: [string, string][] }[] = [];
  let at = 0;
  while (at < tokens.length) {
    const token = tokens[at++];
    if (token === '') continue;
    const newline = token.indexOf('\n');
    const entries: [string, string][] = [];
    if (newline !== -1) {
      let status = token.slice(newline + 1);
      for (;;) {
        entries.push([status, tokens[at++]]);
        if (tokens[at] === undefined || tokens[at] === '') {
          at++;
          break;
        }
        status = tokens[at++];
      }
    }
    commits.push({ header: newline === -1 ? token : token.slice(0, newline), entries });
  }
  return commits;
}

/** Single-parent commits that modify 1..maxFiles existing files, newest first. */
function historicalChanges(repo: string, span: number, maxFiles: number): HistoricalChange[] {
  const raw = execFileSync(
    'git',
    ['log', '-z', '--no-merges', '--no-renames', '--name-status', `--max-count=${span}`, '--pretty=format:%H %P'],
    { cwd: repo, maxBuffer: 1 << 30 },
  );
  const changes: HistoricalChange[] = [];
  for (const { header, entries } of parseLog(raw.toString('utf8'))) {
    const [commit, ...parents] = header.split(' ').filter(Boolean);
    const modified = entries.filter(([status]) => status === 'M').map(([, path]) => path);
    if (parents.length === 1 && modified.length > 0 && entries.length <= maxFiles) {
      changes.push({ commit, parent: parents[0], modified });
    }
  }
  return changes;
}

/** Mid-rank percentile in [0, 1] of `value` among `all` when smaller is better; 0.5 is what a random order gives. */
function percentile(value: number, all: number[]): number {
  let better = 0;
  let tied = 0;
  for (const other of all) {
    if (other < value) better++;
    else if (other === value) tied++;
  }
  return (better + (tied - 1) / 2) / Math.max(1, all.length - 1);
}

/** Chance that a random list of `size` files out of `universe - 1` contains at least one of `targets`. */
function randomHit(universe: number, targets: number, size: number): number {
  let miss = 1;
  for (let i = 0; i < size; i++) miss *= Math.max(0, universe - 1 - targets - i) / Math.max(1, universe - 1 - i);
  return 1 - miss;
}

/** 95% percentile bootstrap interval of the mean (10,000 resamples, fixed seed). */
function bootstrapInterval(values: number[]): [number, number] {
  if (values.length === 0) return [Number.NaN, Number.NaN];
  const random = mulberry32(12345);
  const means = Array.from({ length: 10_000 }, () => {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)];
    return sum / values.length;
  }).sort((a, b) => a - b);
  return [means[Math.floor(means.length * 0.025)], means[Math.floor(means.length * 0.975)]];
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const fixed = (value: number): string => value.toFixed(3);

async function liftAll(): Promise<void> {
  const repos = positional();
  const scratch = flag('scratch', '');
  if (!scratch) throw new Error('lift needs --scratch DIR (a directory outside the repositories)');
  const snapshots = Number(flag('snapshots', '25'));
  const span = Number(flag('span', '1500'));
  const pooled = { recency: [] as number[], churn: [] as number[] };
  const report: Record<string, unknown>[] = [];
  console.log('| repo | snapshots | target files | recency percentile (mean, lower is better) | churn percentile | co-change cases | co-change hit@10 | random hit@10 | co-change MRR |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const repo of repos) {
    const name = basename(repo);
    const changes = historicalChanges(repo, span, 10);
    const stride = Math.max(1, Math.floor(changes.length / snapshots));
    const chosen = Array.from({ length: Math.min(snapshots, changes.length) }, (_, i) => changes[i * stride]);

    // A scratch repository that shares the objects of `repo` and is moved to each parent by editing HEAD.
    const borrowed = join(scratch, `lift-${name}`);
    rmSync(borrowed, { recursive: true, force: true });
    mkdirSync(borrowed, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: borrowed });
    writeFileSync(join(borrowed, '.git', 'objects', 'info', 'alternates'), `${join(repo, '.git', 'objects')}\n`);

    const recency: number[] = [];
    const churn: number[] = [];
    const hits: number[] = [];
    const baselines: number[] = [];
    const reciprocal: number[] = [];
    let targetFiles = 0;
    for (const change of chosen) {
      writeFileSync(join(borrowed, '.git', 'HEAD'), `${change.parent}\n`);
      const signals = await loadGitSignals(borrowed);
      const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', change.parent], { cwd: repo, maxBuffer: 1 << 28 });
      const universe = tree.toString('utf8').split('\0').filter(Boolean);
      const ages = universe.map(path => signals.ageDays(path));
      const churns = universe.map(path => -signals.churn(path));
      const known = new Set(universe);
      const targets = change.modified.filter(path => known.has(path)).sort();
      if (targets.length === 0) continue;
      targetFiles += targets.length;
      recency.push(mean(targets.map(path => percentile(signals.ageDays(path), ages))));
      churn.push(mean(targets.map(path => percentile(-signals.churn(path), churns))));
      if (targets.length >= 2) {
        const [seed, ...others] = targets;
        const partners = signals.coChanged(seed, 10).map(partner => partner.path);
        const first = partners.findIndex(path => others.includes(path));
        hits.push(first === -1 ? 0 : 1);
        reciprocal.push(first === -1 ? 0 : 1 / (first + 1));
        baselines.push(randomHit(universe.length, others.length, 10));
      }
    }
    pooled.recency.push(...recency);
    pooled.churn.push(...churn);
    console.log(
      `| ${name} | ${recency.length} | ${targetFiles} | ${fixed(mean(recency))} | ${fixed(mean(churn))} | ${hits.length} | ${fixed(mean(hits))} | ${fixed(mean(baselines))} | ${fixed(mean(reciprocal))} |`,
    );
    report.push({ repo: name, snapshots: recency.length, targetFiles, recency: mean(recency), churn: mean(churn), cases: hits.length, hitAt10: mean(hits), randomHitAt10: mean(baselines), mrr: mean(reciprocal) });
    rmSync(borrowed, { recursive: true, force: true });
  }
  const [rLow, rHigh] = bootstrapInterval(pooled.recency);
  const [cLow, cHigh] = bootstrapInterval(pooled.churn);
  console.log(`\npooled over ${pooled.recency.length} snapshots: recency percentile ${fixed(mean(pooled.recency))} (95% bootstrap CI ${fixed(rLow)}..${fixed(rHigh)}), churn percentile ${fixed(mean(pooled.churn))} (${fixed(cLow)}..${fixed(cHigh)}); 0.500 is a random order`);
  const out = flag('json', '');
  if (out) writeFileSync(out, `${JSON.stringify({ load: load(), report, pooledRecency: mean(pooled.recency), pooledChurn: mean(pooled.churn) }, null, 2)}\n`);
}

const command = process.argv[2];
if (command === 'measure') {
  const repo = process.argv[3];
  const options: GitSignalsOptions = { maxCommits: Number(flag('max-commits', '2000')) };
  const cacheDir = flag('cache-dir', '');
  if (cacheDir) options.cacheDir = cacheDir;
  console.log(JSON.stringify(await measure(repo, options, process.argv.includes('--git-cpu'))));
} else if (command === 'run') {
  runAll();
} else if (command === 'synth') {
  await synthesise();
} else if (command === 'lift') {
  await liftAll();
} else {
  console.error('usage: gitsignals-eval.ts run|synth|lift ... (see the header of this file)');
  process.exitCode = 2;
}
