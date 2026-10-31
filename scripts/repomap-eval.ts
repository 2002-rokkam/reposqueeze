/**
 * Evaluation harness for the repository map and the skeleton renderer.
 *
 *   node --use-system-ca --import tsx scripts/repomap-eval.ts gold     [--budget 1500] [--limit N] [--repo a,b] [--lite] [--out file]
 *   node --use-system-ca --import tsx scripts/repomap-eval.ts grid     [--budget 1500]            (parameter ablations on cached snapshots)
 *   node --use-system-ca --import tsx scripts/repomap-eval.ts skeleton [--per-repo 15]
 *   node --use-system-ca --import tsx scripts/repomap-eval.ts scale
 *
 * Inputs live in ~/reposqueeze-lab/corpus/repomap (override with RSQ_LAB): dev-lite.jsonl and dev-multilingual.jsonl
 * hold ONLY dev-split SWE-bench rows (first byte of SHA-256("rsq-v3:" + instance_id) even; see fetch-dev.mjs), repos/
 * holds blobless bare clones named owner__name.git. Held-out rows are refused at load time.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { Repository } from '../src/repository.js';
import { repositoryMap } from '../src/context.js';
import { tokens } from '../src/tokens.js';
import { DEFAULT_PARAMS, buildRepoMap, extractFocusTerms, parseRepoMapText, type RepoMapParams } from '../src/repomap.js';
import { extractSignature, listDefinitions, renderSkeleton } from '../src/skeleton.js';
import type { Chunk, Snapshot, SourceFile } from '../src/types.js';

process.env.REPOSQUEEZE_LARGE_THRESHOLD = '1000000'; // build full snapshots: the map needs every file parsed
const LAB = process.env.RSQ_LAB ?? join(homedir(), 'reposqueeze-lab');
const CORPUS = join(LAB, 'corpus/repomap');
const RESULTS = join(LAB, 'results/repomap');
mkdirSync(RESULTS, { recursive: true });

interface Instance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  patch: string;
}

function isDev(id: string): boolean {
  return (createHash('sha256').update(`rsq-v3:${id}`).digest()[0] & 1) === 0;
}

/** `filter` is a comma-separated list of repository name fragments; `lite` restricts to SWE-bench Lite. */
function loadInstances(filter?: string, exclude: string[] = [], lite = false): Instance[] {
  const rows: Instance[] = [];
  const fragments = (filter ?? '').split(',').filter(Boolean);
  for (const file of lite ? ['dev-lite.jsonl'] : ['dev-lite.jsonl', 'dev-multilingual.jsonl']) {
    for (const line of readFileSync(join(CORPUS, file), 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line) as Instance;
      if (!isDev(row.instance_id)) throw new Error(`held-out instance in ${file}; refusing to continue`);
      if (existsSync(repoGit(row.repo)) && (!fragments.length || fragments.some(part => row.repo.includes(part))) && !exclude.some(part => row.repo.includes(part))) rows.push(row);
    }
  }
  rows.sort((a, b) => a.repo.localeCompare(b.repo) || a.instance_id.localeCompare(b.instance_id));
  // Round-robin over repositories so that an interrupted run still covers every language.
  const byRepo = new Map<string, Instance[]>();
  for (const row of rows) byRepo.set(row.repo, [...(byRepo.get(row.repo) ?? []), row]);
  const interleaved: Instance[] = [];
  for (let k = 0; interleaved.length < rows.length; k++) for (const list of byRepo.values()) if (k < list.length) interleaved.push(list[k]);
  return interleaved;
}

function repoGit(repo: string): string {
  return join(CORPUS, 'repos', `${repo.replace('/', '__').toLowerCase()}.git`);
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}

const MAX_LOAD = Number(process.env.RSQ_MAX_LOAD ?? 40);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The lab machine is shared: before any heavy step wait (up to 2 minutes) until the 1-minute load average drops. */
async function waitForQuietMachine(): Promise<number> {
  for (let waited = 0; loadavg()[0] > MAX_LOAD && waited < 2 * 60_000; waited += 30_000) {
    console.error(`load ${loadavg()[0].toFixed(0)} > ${MAX_LOAD}: sleeping 30 s`);
    await sleep(30_000);
  }
  return loadavg()[0];
}

// One persistent worktree per repository: moving it to the next commit rewrites only the files that differ.
const checkouts = new Map<string, string>();

async function withCheckout<T>(instance: Instance, work: (dir: string) => Promise<T>): Promise<T> {
  await waitForQuietMachine();
  const bare = repoGit(instance.repo);
  const dir = join(CORPUS, 'work', instance.repo.replace('/', '__').toLowerCase());
  // One shallow, unfiltered fetch of exactly this commit; checking out of a blobless clone would fetch blob by blob.
  git(['--git-dir', bare, 'fetch', '--quiet', '--depth=1', '--no-filter', '--no-tags', 'origin', instance.base_commit]);
  if (checkouts.has(instance.repo)) {
    git(['-C', dir, 'checkout', '--quiet', '--detach', '--force', instance.base_commit]);
    git(['-C', dir, 'clean', '-fdxq']);
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(CORPUS, 'work'), { recursive: true });
    git(['--git-dir', bare, 'worktree', 'add', '--quiet', '--detach', '--force', dir, instance.base_commit]);
    checkouts.set(instance.repo, dir);
  }
  return work(dir);
}

function releaseCheckouts(): void {
  for (const [repo, dir] of checkouts) {
    const bare = repoGit(repo);
    try { git(['--git-dir', bare, 'worktree', 'remove', '--force', dir]); } catch { rmSync(dir, { recursive: true, force: true }); }
    try { git(['--git-dir', bare, 'worktree', 'prune']); } catch { /* ignore */ }
  }
  checkouts.clear();
}
process.on('exit', releaseCheckouts);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

// ---------------------------------------------------------------------------------------------------------------
// Slim snapshot cache: everything the map needs, none of the term vectors.

interface Slim {
  version: 1;
  snapshotMs: number;
  revision: string;
  skipped: number;
  truncated: boolean;
  warnings: string[];
  chunkCount: number;
  inventory: { path: string; language: string; lines: number }[];
  files: { path: string; text: string; language: string; parsed: boolean; hash: string; chunks: { id: string; start: number; end: number; name: string; kind: string; refs: string[]; text: string }[] }[];
}

function slimOf(snapshot: Snapshot): Slim {
  return {
    version: 1, snapshotMs: snapshot.elapsedMs, revision: snapshot.revision, skipped: snapshot.skipped, truncated: snapshot.truncated,
    warnings: snapshot.warnings, chunkCount: snapshot.chunks.length, inventory: snapshot.inventory ?? [],
    files: snapshot.files.map(file => ({
      path: file.path, text: file.text, language: file.language, parsed: file.parsed, hash: file.hash,
      chunks: file.chunks.filter(chunk => chunk.kind !== 'window').map(({ id, start, end, name, kind, refs, text }) => ({ id, start, end, name, kind, refs, text }))
    }))
  };
}

function inflate(slim: Slim, root: string): Snapshot {
  const files: SourceFile[] = slim.files.map(file => ({
    path: file.path, text: file.text, hash: file.hash, language: file.language, parsed: file.parsed,
    chunks: file.chunks.map(chunk => ({ ...chunk, path: file.path, terms: [] }) as Chunk)
  }));
  return {
    files, chunks: new Array(slim.chunkCount) as Chunk[], revision: slim.revision, skipped: slim.skipped, truncated: slim.truncated,
    warnings: slim.warnings, root, elapsedMs: slim.snapshotMs, totalFiles: slim.files.length, candidateFiles: slim.files.length,
    indexMode: 'full', inventory: slim.inventory
  };
}

const codeVersion = createHash('sha256').update(['parser.ts', 'repository.ts', 'types.ts'].map(name => readFileSync(join(import.meta.dirname, '..', 'src', name), 'utf8')).join('\0')).digest('hex').slice(0, 12);

async function slimSnapshot(instance: Instance, fresh = false): Promise<Snapshot> {
  const cacheDir = join(CORPUS, 'snapshots', codeVersion);
  const cache = join(cacheDir, `${instance.instance_id}.json.gz`);
  if (!fresh && existsSync(cache)) return inflate(JSON.parse(gunzipSync(readFileSync(cache)).toString('utf8')) as Slim, instance.repo);
  return withCheckout(instance, async dir => {
    const started = performance.now();
    const snapshot = await new Repository(dir).snapshot('__repository_map__');
    snapshot.elapsedMs = performance.now() - started;
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cache, gzipSync(JSON.stringify(slimOf(snapshot))));
    return inflate(slimOf(snapshot), instance.repo);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Statistics

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

function bootstrapCI(values: number[], resamples = 10000, seed = 20260601): [number, number] {
  const random = mulberry32(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * resamples)], means[Math.floor(0.975 * resamples)]];
}

function pairedCI(a: number[], b: number[]): [number, number] {
  return bootstrapCI(a.map((value, i) => value - b[i]), 10000, 20260602);
}

/** Two-sided exact McNemar test on discordant pairs. */
function mcnemar(a: boolean[], b: boolean[]): { onlyA: number; onlyB: number; p: number } {
  let onlyA = 0, onlyB = 0;
  a.forEach((value, i) => { if (value && !b[i]) onlyA++; else if (!value && b[i]) onlyB++; });
  const n = onlyA + onlyB;
  if (n === 0) return { onlyA, onlyB, p: 1 };
  let tail = 0;
  let term = Math.pow(0.5, n);
  for (let k = 0; k <= Math.min(onlyA, onlyB); k++) {
    tail += term;
    term = (term * (n - k)) / (k + 1);
  }
  return { onlyA, onlyB, p: Math.min(1, 2 * tail) };
}

const pct = (value: number) => `${(100 * value).toFixed(1)}%`;
const ci = ([lo, hi]: [number, number]) => `[${pct(lo)}, ${pct(hi)}]`;

// ---------------------------------------------------------------------------------------------------------------
// Gold-file coverage

function goldFiles(instance: Instance, snapshot: Snapshot): string[] {
  const present = new Set([...snapshot.files.map(file => file.path), ...(snapshot.inventory ?? []).map(entry => entry.path)]);
  const found = new Set<string>();
  for (const match of instance.patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) if (present.has(match[2])) found.add(match[2]);
  return [...found].sort();
}

interface Shown {
  text: string;
  paths: Set<string>;
  described: Set<string>;
  tokens: number;
  files: number;
  symbols: number;
  ms: number;
}

function baselineMap(snapshot: Snapshot, budget: number, goldAndAll: string[]): Shown {
  const started = performance.now();
  const text = repositoryMap(snapshot, budget);
  const ms = performance.now() - started;
  const starts = text.split('\n');
  const paths = new Set<string>();
  for (const path of goldAndAll) if (starts.some(line => line.startsWith(`${path} (`))) paths.add(path);
  const shownFiles = starts.filter(line => /^.+ \(\d+ lines\)/.test(line)).length;
  const withNames = starts.filter(line => /^.+ \(\d+ lines\): /.test(line));
  return { text, paths, described: new Set([...paths].filter(path => withNames.some(line => line.startsWith(`${path} (`)))), tokens: tokens(text), files: shownFiles, symbols: withNames.reduce((sum, line) => sum + line.split(': ').slice(1).join(': ').split(', ').filter(name => name !== '…').length, 0), ms };
}

function mineMap(snapshot: Snapshot, budget: number, options: { focusTerms?: string[]; focusPaths?: string[] }, params: RepoMapParams): Shown {
  const started = performance.now();
  const result = buildRepoMap(snapshot, { budget, ...options }, params);
  const ms = performance.now() - started;
  const parsed = parseRepoMapText(result.text);
  const paths = new Set(parsed.files.map(file => file.path));
  if (paths.size !== result.files || result.ranked.some(entry => !paths.has(entry.path))) throw new Error('rendered text disagrees with result.ranked');
  return { text: result.text, paths, described: new Set(parsed.files.filter(file => file.described).map(file => file.path)), tokens: result.tokens, files: result.files, symbols: result.symbols, ms };
}

interface Row {
  id: string;
  repo: string;
  load1: number;
  gold: string[];
  goldCode: string[];
  total: number;
  variants: Record<string, { recall: number; hit: number; recallCode: number; describedRecall: number; tokens: number; files: number; symbols: number; ms: number }>;
}

function score(shown: Shown, gold: string[], goldCode: string[], total: number) {
  const inShown = (list: string[], set: Set<string>) => list.filter(path => set.has(path)).length / Math.max(1, list.length);
  return {
    recall: inShown(gold, shown.paths), hit: gold.some(path => shown.paths.has(path)) ? 1 : 0, recallCode: goldCode.length ? inShown(goldCode, shown.paths) : NaN,
    describedRecall: inShown(gold, shown.described), tokens: shown.tokens, files: shown.files, symbols: shown.symbols, ms: shown.ms, chance: shown.files / Math.max(1, total)
  };
}

type VariantSpec = { name: string; run: (snapshot: Snapshot, instance: Instance, budget: number) => Shown };

function variantsFor(grid: boolean): VariantSpec[] {
  const base = DEFAULT_PARAMS;
  const withTerms = (params: RepoMapParams): VariantSpec['run'] => (snapshot, instance, budget) =>
    mineMap(snapshot, budget, { focusTerms: extractFocusTerms(instance.problem_statement) }, params);
  const plain = (params: RepoMapParams): VariantSpec['run'] => (snapshot, _instance, budget) => mineMap(snapshot, budget, {}, params);
  const list: VariantSpec[] = [
    { name: 'baseline-alphabetical', run: (snapshot, _instance, budget) => baselineMap(snapshot, budget, snapshot.inventory!.map(entry => entry.path)) },
    { name: 'pagerank-unfocused', run: plain(base) },
    { name: 'pagerank-focused-terms', run: withTerms(base) }
  ];
  if (!grid) return list;
  const vary = (name: string, patch: Partial<RepoMapParams>) => {
    list.push({ name: `unfocused ${name}`, run: plain({ ...base, ...patch }) });
    list.push({ name: `focused ${name}`, run: withTerms({ ...base, ...patch }) });
  };
  vary('reserve=0', { bareReserve: 0 });
  vary('reserve=0.35', { bareReserve: 0.35 });
  vary('decay=0.25', { decay: 0.25 });
  vary('decay=0.75', { decay: 0.75 });
  vary('maxSig=80', { maxSignatureChars: 80 });
  vary('compoundBoost=1', { compoundBoost: 1 });
  vary('test/aux/vendor=1', { testFactor: 1, auxFactor: 1, vendorFactor: 1 });
  list.push({ name: 'focused blend=0.4', run: withTerms({ ...base, focusBlend: 0.4 }) });
  list.push({ name: 'focused blend=0.9', run: withTerms({ ...base, focusBlend: 0.9 }) });
  list.push({ name: 'focused reverse=0.5', run: withTerms({ ...base, reverseWeight: 0.5 }) });
  list.push({ name: 'focused reverse=1', run: withTerms({ ...base, reverseWeight: 1 }) });
  list.push({ name: 'focused mention=1', run: withTerms({ ...base, mentionBoost: 1 }) });
  return list;
}

async function gold(options: { budget: number; limit?: number; repo?: string; exclude: string[]; out: string; grid: boolean; fresh: boolean; lite: boolean }): Promise<void> {
  const instances = loadInstances(options.repo, options.exclude, options.lite).slice(0, options.limit ?? Infinity);
  const variants = variantsFor(options.grid);
  const rows: Row[] = [];
  for (const [index, instance] of instances.entries()) {
    const started = performance.now();
    let snapshot: Snapshot;
    try { snapshot = await slimSnapshot(instance, options.fresh); } catch (error) { console.error(`skip ${instance.instance_id}: ${String(error).slice(0, 200)}`); continue; }
    const golds = goldFiles(instance, snapshot);
    if (!golds.length) { console.error(`skip ${instance.instance_id}: no gold file present in snapshot`); continue; }
    const language = new Map(snapshot.files.map(file => [file.path, file.language]));
    const goldCode = golds.filter(path => (language.get(path) ?? 'text') !== 'text');
    const row: Row = { id: instance.instance_id, repo: instance.repo, load1: loadavg()[0], gold: golds, goldCode, total: snapshot.inventory!.length, variants: {} };
    for (const variant of variants) row.variants[variant.name] = score(variant.run(snapshot, instance, options.budget), golds, goldCode, row.total);
    rows.push(row);
    console.error(`[${index + 1}/${instances.length}] ${instance.instance_id} files=${row.total} gold=${golds.length} ${((performance.now() - started) / 1000).toFixed(1)}s ` +
      variants.slice(0, 3).map(v => `${v.name.split('-')[0]}=${pct(row.variants[v.name].recall)}`).join(' '));
  }
  writeFileSync(options.out, JSON.stringify({ budget: options.budget, codeVersion, rows }, null, 1));
  console.log(summary(rows, variants.map(v => v.name), options.budget));
}

function summary(rows: Row[], names: string[], budget: number): string {
  const out: string[] = [`Gold-file coverage at ${budget} tokens, ${rows.length} dev instances from ${new Set(rows.map(r => r.repo)).size} repositories`, ''];
  const base = rows.map(row => row.variants[names[0]]);
  out.push('| variant | gold recall (95% CI) | any-gold hit | code-gold recall | described gold | Δ recall vs baseline (95% CI) | McNemar hit (only-A/only-B, p) | tokens | files shown | tok/file | defs/1k tok | build ms (median) |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const name of names) {
    const items = rows.map(row => row.variants[name]);
    const recalls = items.map(item => item.recall);
    const code = items.map(item => item.recallCode).filter(value => !Number.isNaN(value));
    const diff = name === names[0] ? '–' : `${(100 * mean(recalls.map((v, i) => v - base[i].recall))).toFixed(1)} pp ${ci(pairedCI(recalls, base.map(b => b.recall)))}`;
    const test = name === names[0] ? '–' : (() => { const t = mcnemar(items.map(i => i.hit === 1), base.map(b => b.hit === 1)); return `${t.onlyA}/${t.onlyB}, p=${t.p.toFixed(4)}`; })();
    const files = mean(items.map(i => i.files)), toks = mean(items.map(i => i.tokens)), defs = mean(items.map(i => i.symbols));
    const ms = items.map(i => i.ms).sort((a, b) => a - b)[Math.floor(items.length / 2)];
    out.push(`| ${name} | ${pct(mean(recalls))} ${ci(bootstrapCI(recalls))} | ${pct(mean(items.map(i => i.hit)))} | ${pct(mean(code))} | ${pct(mean(items.map(i => i.describedRecall)))} | ${diff} | ${test} | ${toks.toFixed(0)} | ${files.toFixed(1)} | ${(toks / Math.max(1, files)).toFixed(1)} | ${(1000 * defs / toks).toFixed(1)} | ${ms.toFixed(1)} |`);
  }
  const chance = mean(rows.map(row => row.variants[names[1]].files / Math.max(1, row.total)));
  out.push('', `Chance level for a random selection of as many files as variant "${names[1]}" shows: ${pct(chance)} (mean of shown/total).`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Skeleton evaluation

interface SkeletonRow {
  repo: string;
  language: string;
  path: string;
  start: number;
  end: number;
  fullTokens: number;
  ratio: number;
  headersTotal: number;
  headersKept: number;
  exact: boolean;
  markersOk: boolean;
  tightRatio: number;
  tightHeadersKept: number;
  tightOk: boolean;
  focusOk: boolean;
  focusHitsKept: number;
  focusHits: number;
}

function sourceLinesOf(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(line => line.replace(/\r$/, ''));
}

/** Verifies kept lines against the source and the marker arithmetic. Returns the kept line numbers. */
function verifySkeleton(text: string, source: string[], start: number, end: number, numbered: boolean): { ok: boolean; kept: Set<number> } {
  const kept = new Set<number>();
  if (text === '') return { ok: true, kept };
  let next = start;
  for (const row of text.split('\n')) {
    const marker = /^… \((\d+) lines elided, L(\d+)-L(\d+)\)$/.exec(row);
    if (marker) {
      const [count, a, b] = [Number(marker[1]), Number(marker[2]), Number(marker[3])];
      if (a !== next || b - a + 1 !== count) return { ok: false, kept };
      next = b + 1;
      continue;
    }
    let line = row;
    if (numbered) {
      const prefix = /^ {2} *(\d+)│ /.exec(row);
      if (!prefix || Number(prefix[1]) !== next) return { ok: false, kept };
      line = row.slice(prefix[0].length);
    }
    if (line !== source[next - 1]) return { ok: false, kept };
    kept.add(next++);
  }
  return { ok: next === end + 1, kept };
}

async function skeleton(options: { perRepo: number }): Promise<void> {
  const byRepo = new Map<string, Instance>();
  for (const instance of loadInstances()) if (!byRepo.has(instance.repo)) byRepo.set(instance.repo, instance);
  const rows: SkeletonRow[] = [];
  for (const instance of byRepo.values()) {
    await withCheckout(instance, async dir => {
      const snapshot = await new Repository(dir).snapshot('__skeleton__');
      const candidates: { file: SourceFile; start: number; end: number }[] = [];
      for (const file of snapshot.files) {
        if (file.language === 'text') continue;
        for (const def of listDefinitions(file)) {
          if (!def.local && def.role !== 'variable' && def.end - def.start + 1 >= 6 && def.end - def.start + 1 <= 400) candidates.push({ file, start: def.start, end: def.end });
        }
      }
      candidates.sort((a, b) => createHash('sha256').update(`${a.file.path}:${a.start}`).digest('hex').localeCompare(createHash('sha256').update(`${b.file.path}:${b.start}`).digest('hex')));
      const random = mulberry32(createHash('sha256').update(instance.repo).digest().readUInt32LE(0));
      for (const { file, start, end } of candidates.slice(0, options.perRepo)) {
        const source = sourceLinesOf(file.text);
        const full = source.slice(start - 1, end).join('\n');
        const fullTokens = tokens(full);
        const defs = listDefinitions(file).filter(def => !def.local && def.start >= start && def.end <= end && def.name !== '');
        const headerLines = (def: (typeof defs)[number]) => {
          const signature = extractSignature(source.slice(def.start - 1, def.start + 11).join('\n'), { language: file.language, role: def.role, maxChars: 400 });
          return Array.from({ length: signature.lines }, (_, i) => def.start + i).filter(line => line <= end);
        };
        const countKept = (kept: Set<number>) => defs.filter(def => headerLines(def).every(line => kept.has(line))).length;
        const unlimited = renderSkeleton(file, { start, end }, { maxTokens: 32000 });
        const check = verifySkeleton(unlimited.text, source, start, end, false);
        const tightBudget = Math.max(40, Math.ceil(0.15 * fullTokens));
        const tight = renderSkeleton(file, { start, end }, { maxTokens: tightBudget });
        const tightCheck = verifySkeleton(tight.text, source, start, end, false);
        const words = [...new Set((full.match(/[A-Za-z_][A-Za-z0-9_]{5,}/g) ?? []))].sort();
        const picks = Array.from({ length: Math.min(3, words.length) }, () => words[Math.floor(random() * words.length)]);
        const focusBudget = Math.max(60, Math.ceil(0.4 * fullTokens));
        const focused = renderSkeleton(file, { start, end }, { maxTokens: focusBudget, focusTerms: picks, numbered: true });
        const focusCheck = verifySkeleton(focused.text, source, start, end, true);
        const hitLines = source.slice(start - 1, end).map((line, i) => [line.toLowerCase(), start + i] as const).filter(([line]) => picks.some(word => line.includes(word.toLowerCase()))).map(([, n]) => n);
        rows.push({
          repo: instance.repo, language: file.language, path: file.path, start, end, fullTokens, ratio: unlimited.tokens / Math.max(1, fullTokens),
          headersTotal: defs.length, headersKept: countKept(check.kept), exact: check.ok, markersOk: check.ok && unlimited.keptLines + unlimited.elidedLines === end - start + 1,
          tightRatio: tight.tokens / Math.max(1, fullTokens), tightHeadersKept: countKept(tightCheck.kept), tightOk: tightCheck.ok && tight.tokens <= tightBudget,
          focusOk: focusCheck.ok && focused.tokens <= focusBudget, focusHitsKept: hitLines.filter(n => focusCheck.kept.has(n)).length, focusHits: hitLines.length
        });
      }
    });
    console.error(`${instance.repo}: ${rows.filter(r => r.repo === instance.repo).length} definitions`);
  }
  writeFileSync(join(RESULTS, 'skeleton-eval.json'), JSON.stringify(rows, null, 1));
  console.log(skeletonSummary(rows));
}

function skeletonSummary(rows: SkeletonRow[]): string {
  const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))];
  const line = (label: string, subset: SkeletonRow[]) => {
    const headers = subset.reduce((s, r) => s + r.headersTotal, 0);
    const kept = subset.reduce((s, r) => s + r.headersKept, 0);
    const tightKept = subset.reduce((s, r) => s + r.tightHeadersKept, 0);
    const hits = subset.reduce((s, r) => s + r.focusHits, 0);
    const hitsKept = subset.reduce((s, r) => s + r.focusHitsKept, 0);
    const ratios = subset.map(r => r.ratio);
    const totalFull = subset.reduce((s, r) => s + r.fullTokens, 0);
    const weighted = subset.reduce((s, r) => s + r.ratio * r.fullTokens, 0) / totalFull;
    return `| ${label} | ${subset.length} | ${mean(ratios).toFixed(3)} | ${quantile(ratios, 0.5).toFixed(3)} | ${quantile(ratios, 0.1).toFixed(3)}–${quantile(ratios, 0.9).toFixed(3)} | ${weighted.toFixed(3)} | ${pct(kept / Math.max(1, headers))} | ${pct(tightKept / Math.max(1, headers))} (ratio ${mean(subset.map(r => r.tightRatio)).toFixed(3)}) | ${pct(hitsKept / Math.max(1, hits))} | ${pct(subset.filter(r => r.exact).length / subset.length)} | ${pct(subset.filter(r => r.markersOk).length / subset.length)} | ${pct(subset.filter(r => r.tightOk && r.focusOk).length / subset.length)} |`;
  };
  const out = ['| group | defs | mean ratio | median | p10–p90 | token-weighted ratio | headers kept (no cap) | headers kept (cap = 15% of full) | focus hits kept (cap = 40%) | kept lines exact | line arithmetic ok | cap respected |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  out.push(line('all', rows));
  for (const language of [...new Set(rows.map(r => r.language))].sort()) out.push(line(language, rows.filter(r => r.language === language)));
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Scale

function syntheticSnapshot(files: number, definitionsPerFile = 6): Snapshot {
  const random = mulberry32(7);
  const out: SourceFile[] = [];
  for (let i = 0; i < files; i++) {
    const path = `pkg${i % 97}/mod${Math.floor(i / 97) % 211}/file${i}.py`;
    const chunks: Chunk[] = [];
    for (let d = 0; d < definitionsPerFile; d++) {
      const refs = [`def_${i}_${d}`];
      for (let r = 0; r < 12; r++) refs.push(`def_${Math.floor(random() ** 2 * files)}_${Math.floor(random() * definitionsPerFile)}`, `local${r}`);
      chunks.push({ id: `${i}:${d}`, path, start: 1 + d * 10, end: 8 + d * 10, name: `def_${i}_${d}`, kind: 'function_definition', text: `def def_${i}_${d}(a, b):\n    return a\n`, terms: [], refs });
    }
    out.push({ path, text: '', hash: String(i), language: 'python', chunks, parsed: true });
  }
  return { files: out, chunks: [], revision: 'synthetic0', skipped: 0, truncated: false, warnings: [], root: '/synthetic', elapsedMs: 0, totalFiles: files, inventory: out.map(file => ({ path: file.path, language: 'python', lines: 100 })) };
}

async function scale(): Promise<void> {
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const rows: string[] = ['| snapshot | files | defs | refs | buildRepoMap ms (median of 5) | baseline repositoryMap ms | Repository.snapshot ms |', '|---|---|---|---|---|---|---|'];
  const time = (snapshot: Snapshot, budget = 1500) => {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      buildRepoMap(snapshot, { budget });
      times.push(performance.now() - started);
    }
    return median(times);
  };
  const measured = new Map<string, { files: number; ms: number; snapshotMs: number; defs: number; refs: number; baselineMs: number }>();
  for (const instance of loadInstances()) {
    const snapshot = await slimSnapshot(instance);
    const key = instance.repo;
    const files = snapshot.files.length;
    if (measured.has(key) && measured.get(key)!.files >= files) continue;
    let defs = 0, refs = 0;
    for (const file of snapshot.files) for (const chunk of file.chunks) if (chunk.kind !== 'window') { defs++; refs += chunk.refs.length; }
    const started = performance.now();
    repositoryMap(snapshot, 1500);
    measured.set(key, { files, ms: time(snapshot), snapshotMs: snapshot.elapsedMs, defs, refs, baselineMs: performance.now() - started });
  }
  for (const [repo, m] of [...measured].sort((a, b) => a[1].files - b[1].files)) rows.push(`| ${repo} (largest dev snapshot) | ${m.files} | ${m.defs} | ${m.refs} | ${m.ms.toFixed(1)} | ${m.baselineMs.toFixed(1)} | ${m.snapshotMs.toFixed(0)} |`);
  for (const files of [100, 1000, 10000, 50000]) {
    const snapshot = syntheticSnapshot(files);
    rows.push(`| synthetic ${files} files | ${files} | ${files * 6} | ${files * 6 * 25} | ${time(snapshot).toFixed(1)} | – | – |`);
  }
  console.log(rows.join('\n'));
}

// ---------------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      budget: { type: 'string', default: '1500' }, limit: { type: 'string' }, repo: { type: 'string' }, exclude: { type: 'string', default: '' }, out: { type: 'string' },
      'per-repo': { type: 'string', default: '15' }, fresh: { type: 'boolean', default: false }, lite: { type: 'boolean', default: false }
    }
  });
  const command = positionals[0];
  if (command === 'gold' || command === 'grid') {
    await gold({ budget: Number(values.budget), limit: values.limit ? Number(values.limit) : undefined, repo: values.repo, exclude: (values.exclude ?? '').split(',').filter(Boolean), grid: command === 'grid', fresh: values.fresh === true, lite: values.lite === true,
      out: values.out ?? join(RESULTS, command === 'grid' ? 'gold-grid.json' : 'gold-coverage.json') });
  } else if (command === 'skeleton') await skeleton({ perRepo: Number(values['per-repo']) });
  else if (command === 'scale') await scale();
  else console.error('usage: repomap-eval.ts gold|grid|skeleton|scale [options]; see the header of this file');
}
await main();
