import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, loadavg, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DATASETS, loadDataset, mergeInstances, type DatasetKey, type LoadedDataset } from './dataset.js';
import { prepareSplit, type InstanceSkipReason, type PreparedInstance } from './gold.js';
import { retry, runGit } from './git.js';
import { waitForLoad } from './load.js';
import { backfillShownMetrics } from './shown.js';
import { computeMetrics, computeShownMetrics, distinctFiles, ZERO_METRICS } from './metrics.js';
import { REPO_ROOT } from './paths.js';
import { buildReport, type DatasetStat, type Manifest, type Report, type RunRow } from './report.js';
import { renderMarkdown } from './render.js';
import { CheckoutSlot, prepareRepo, sweepStaleSlots, type CloneMode, type RepoState } from './repos.js';
import { killAllChildren, runInChild, type ChildOutcome } from './runner.js';
import { selectInstances, sortInstances, type SampleMode, type SelectionFilters } from './select.js';
import { splitOf, type Split } from './split.js';
import { cmp } from './util.js';
import { describeVariant, truncateQuery, type VariantInfo, type VariantSpec } from './variants.js';

export interface SelectionConfig {
  datasets: DatasetKey[];
  split: Split;
  filters: SelectionFilters;
  seed: number;
  refreshData?: boolean;
  log?: (message: string) => void;
}

export interface RunConfig extends SelectionConfig {
  out: string;
  variants: VariantSpec[];
  budget: number;
  workers: number;
  timeoutSec: number;
  resamples: number;
  offline: boolean;
  retryFailed: boolean;
  savePacks: boolean;
  keepCheckouts: boolean;
  forceResume: boolean;
  maxOldSpaceMB: number;
  prepareJobs: number;
  /** Back off while the machine's one-minute load average is above this (0 = never wait). */
  maxLoad: number;
  cloneMode: CloneMode;
  command: string;
}

export interface Selection {
  loaded: LoadedDataset[];
  prepared: PreparedInstance[];
  skipped: { instanceId: string; reason: InstanceSkipReason; detail: string }[];
  selected: PreparedInstance[];
  datasetStats: DatasetStat[];
}

export async function loadSelection(config: SelectionConfig): Promise<Selection> {
  const loaded: LoadedDataset[] = [];
  for (const key of config.datasets) loaded.push(await loadDataset(key, { refresh: config.refreshData, log: config.log }));
  const merged = mergeInstances(loaded);
  const { prepared, skipped } = prepareSplit(merged, config.split);
  const selected = selectInstances(prepared, config.filters, config.seed, new Set(merged.map(i => i.instanceId)));
  const datasetStats: DatasetStat[] = loaded.map(dataset => {
    const ids = [...new Set(dataset.instances.map(i => i.instanceId))];
    const inDataset = (instance: PreparedInstance) => instance.datasets.includes(dataset.key);
    return {
      key: dataset.key,
      hfId: dataset.hfId,
      revision: dataset.revision,
      contentSha256: dataset.contentSha256,
      files: dataset.files.map(f => ({ hfSplit: f.hfSplit, rows: f.rows, sha256: f.sha256 })),
      total: ids.length,
      dev: ids.filter(id => splitOf(id) === 'dev').length,
      test: ids.filter(id => splitOf(id) === 'test').length,
      prepared: prepared.filter(inDataset).length,
      selected: selected.filter(inDataset).length,
    };
  });
  return { loaded, prepared, skipped, selected, datasetStats };
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function emptyRow(instance: PreparedInstance, variant: string, budget: number): RunRow {
  return {
    instance_id: instance.instanceId,
    repo: instance.repo,
    language: instance.language,
    datasets: instance.datasets,
    split: instance.split,
    variant,
    status: 'ok',
    baseCommit: instance.baseCommit,
    goldFiles: instance.gold.map(g => g.path),
    goldLines: instance.goldLines,
    goldRanges: Object.fromEntries(instance.gold.map(g => [g.path, g.ranges])),
    hasCodeGold: instance.hasCodeGold,
    mentions: instance.mentions,
    queryChars: instance.statement.length,
    queryTruncatedTo: null,
    packedFiles: [],
    numExcerpts: 0,
    evidence: [],
    metrics: { ...ZERO_METRICS },
    outputTokens: 0,
    reportedOutputTokens: null,
    budget,
    budgetViolation: false,
    ms: 0,
    cpuMs: null,
    load1: null,
    wallMs: 0,
    rssMB: null,
    rssBaseMB: null,
  };
}

/** Turns a child outcome into a result row, scoring the pack against the gold set. */
export function buildRow(instance: PreparedInstance, variant: VariantSpec, outcome: ChildOutcome, budget: number, load1: number | null = null): RunRow {
  const row = emptyRow(instance, variant.name, budget);
  row.load1 = load1;
  row.queryTruncatedTo = variant.truncate !== null && instance.statement.length > variant.truncate ? variant.truncate : null;
  row.wallMs = outcome.wallMs;
  if (outcome.status !== 'ok') {
    row.status = outcome.status;
    row.error = outcome.error;
    if (outcome.stderrTail) row.stderrTail = outcome.stderrTail.slice(-1500);
    row.ms = outcome.wallMs;
    return row;
  }
  const { result } = outcome;
  row.evidence = result.evidence.map(({ path, start, end, kind }) => ({ path, start, end, ...(kind ? { kind } : {}) }));
  row.packedFiles = distinctFiles(row.evidence);
  row.numExcerpts = row.evidence.length;
  const gold = instance.gold.map(g => ({ path: g.path, ranges: g.ranges }));
  row.metrics = computeMetrics(row.evidence, gold);
  row.shownMetrics = computeShownMetrics(row.evidence, gold);
  row.outputTokens = result.tokens;
  const reported = result.stats.outputTokens;
  row.reportedOutputTokens = typeof reported === 'number' ? reported : null;
  row.budgetViolation = result.tokens > budget;
  row.ms = result.ms;
  row.cpuMs = result.cpuMs;
  row.rssMB = result.rssMB;
  row.rssBaseMB = result.rssBaseMB;
  row.engineStats = result.stats;
  return row;
}

async function readRows(path: string): Promise<RunRow[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  const rows: RunRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as RunRow);
    } catch {
      // a torn last line from an interrupted run: the instance is simply re-run
    }
  }
  return rows;
}

/** Keeps the latest row per (instance, variant). */
function latestRows(rows: RunRow[]): Map<string, RunRow> {
  const latest = new Map<string, RunRow>();
  for (const row of rows) latest.set(`${row.instance_id}\t${row.variant}`, row);
  return latest;
}

function manifestDifferences(old: Manifest, next: Manifest): string[] {
  const problems: string[] = [];
  if (old.split !== next.split) problems.push(`split ${old.split} -> ${next.split}`);
  if (old.budget !== next.budget) problems.push(`budget ${old.budget} -> ${next.budget}`);
  if ((old.cloneMode ?? 'full') !== next.cloneMode) problems.push(`clone mode ${old.cloneMode} -> ${next.cloneMode}`);
  if (old.seed !== next.seed) problems.push(`seed ${old.seed} -> ${next.seed}`);
  for (const dataset of next.datasets) {
    const before = old.datasets.find(d => d.key === dataset.key);
    if (before && before.contentSha256 !== dataset.contentSha256) problems.push(`dataset ${dataset.key} content changed`);
  }
  for (const variant of next.variants) {
    const before = old.variants.find(v => v.name === variant.name);
    if (!before) continue;
    if (before.fingerprint !== variant.fingerprint) problems.push(`variant ${variant.name}: source fingerprint changed (${before.gitSha?.slice(0, 8) ?? 'n/a'} -> ${variant.gitSha?.slice(0, 8) ?? 'n/a'})`);
    if (before.root !== variant.root) problems.push(`variant ${variant.name}: path changed`);
    if (JSON.stringify(before.env) !== JSON.stringify(variant.env)) problems.push(`variant ${variant.name}: env changed`);
    if (before.truncate !== variant.truncate) problems.push(`variant ${variant.name}: truncate changed`);
  }
  return problems;
}

async function harnessIdentity(): Promise<Manifest['harness']> {
  try {
    const git = async (args: string[]) => (await runGit(args, { cwd: REPO_ROOT, configPath: '/dev/null', timeoutMs: 20_000 })).trim();
    return { gitSha: await git(['rev-parse', 'HEAD']), dirty: (await git(['status', '--porcelain', '--untracked-files=no', '--', 'bench'])).length > 0 };
  } catch {
    return { gitSha: null, dirty: null };
  }
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export async function writeReport(out: string, resamples: number): Promise<Report> {
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as Manifest;
  const rows = [...latestRows(await readRows(join(out, 'rows.jsonl'))).values()];
  const instances = new Set(JSON.parse(await readFile(join(out, 'instances.json'), 'utf8')).map((i: { id: string }) => i.id) as string[]);
  const selectedRows = (await backfillShownMetrics(out, rows))
    .filter(r => instances.has(r.instance_id))
    .sort((a, b) => cmp(a.repo, b.repo) || cmp(a.instance_id, b.instance_id) || cmp(a.variant, b.variant));
  const report = buildReport(manifest, selectedRows, { resamples, seed: manifest.seed });
  await writeFile(join(out, 'report.json'), JSON.stringify(report));
  await writeFile(join(out, 'report.md'), renderMarkdown(report));
  await writeFile(join(out, 'report-compact.md'), renderMarkdown(report, { compact: true }));
  return report;
}

interface Task {
  instance: PreparedInstance;
  todo: VariantInfo[];
}

export async function execute(config: RunConfig): Promise<number> {
  const log = (message: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
  config.log = log;
  const selection = await loadSelection(config);
  if (!selection.selected.length) throw new Error('the selection is empty');
  const variants: VariantInfo[] = [];
  for (const spec of config.variants) variants.push(await describeVariant(spec));

  await mkdir(config.out, { recursive: true });
  const manifestPath = join(config.out, 'manifest.json');
  const rowsPath = join(config.out, 'rows.jsonl');
  const skipped: Record<string, number> = {};
  for (const item of selection.skipped) skipped[item.reason] = (skipped[item.reason] ?? 0) + 1;
  const ids = selection.selected.map(i => i.instanceId).sort(cmp);
  const manifest: Manifest = {
    schema: 'rsq-bench-swe/1',
    command: config.command,
    startedAt: new Date().toISOString(),
    resumes: [],
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    memGiB: totalmem() / 2 ** 30,
    harness: await harnessIdentity(),
    split: config.split,
    seed: config.seed,
    bootstrapResamples: config.resamples,
    budget: config.budget,
    timeoutSec: config.timeoutSec,
    workers: config.workers,
    cloneMode: config.cloneMode,
    corpus: {},
    datasets: selection.datasetStats,
    filters: config.filters,
    instanceCount: ids.length,
    instancesSha256: sha256(ids.join('\n')),
    skipped,
    unavailable: [],
    variants,
    notes: [
      'Gold = pre-image files edited by the gold patch (tests and new files excluded); gold lines = removed lines plus context anchors around pure insertions.',
      'Every (instance, variant) pair runs in a fresh child process on its own pristine checkout of the base commit; variants of one instance run sequentially in a hash-determined order.',
      'Timeouts and engine errors count as zero for every retrieval metric and are reported separately.',
    ],
  };
  try {
    const previous = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
    const problems = manifestDifferences(previous, manifest);
    if (problems.length && !config.forceResume) {
      throw new Error(`refusing to resume ${config.out}: ${problems.join('; ')}. Use a new --out directory, or --force-resume to mix results knowingly.`);
    }
    manifest.startedAt = previous.startedAt;
    manifest.resumes = [...(previous.resumes ?? []), new Date().toISOString()];
    manifest.corpus = { ...(previous.corpus ?? {}) };
    if (previous.timeoutSec !== manifest.timeoutSec) manifest.notes.push(`The task timeout changed between resumes (${previous.timeoutSec} s -> ${manifest.timeoutSec} s).`);
    if (problems.length) manifest.notes.push(`Resumed with --force-resume despite: ${problems.join('; ')}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  await writeFile(join(config.out, 'instances.json'), JSON.stringify(selection.selected.map(i => ({ id: i.instanceId, repo: i.repo, language: i.language, datasets: i.datasets, baseCommit: i.baseCommit })), null, 1));

  const latest = latestRows(await readRows(rowsPath));
  const isDone = (instanceId: string, variant: string) => {
    const row = latest.get(`${instanceId}\t${variant}`);
    return !!row && (row.status === 'ok' || (!config.retryFailed && (row.status === 'timeout' || row.status === 'error')));
  };
  const pendingInstances = selection.selected.filter(i => variants.some(v => !isDone(i.instanceId, v.name)));
  const totalTasks = selection.selected.length * variants.length;
  let finished = totalTasks - pendingInstances.reduce((sum, i) => sum + variants.filter(v => !isDone(i.instanceId, v.name)).length, 0);
  log(`${selection.selected.length} instances x ${variants.length} variant(s) = ${totalTasks} runs; ${finished} already done, ${totalTasks - finished} to run`);

  // Phase 1: make sure every repository and base commit exists locally (network happens only here).
  const states = new Map<string, RepoState>();
  const byRepo = new Map<string, PreparedInstance[]>();
  for (const instance of pendingInstances) byRepo.set(instance.repo, [...(byRepo.get(instance.repo) ?? []), instance]);
  const repoQueue = [...byRepo.keys()].sort(cmp);
  await Promise.all(Array.from({ length: Math.max(1, config.prepareJobs) }, async () => {
    for (let repo = repoQueue.shift(); repo; repo = repoQueue.shift()) {
      if (!config.offline) await waitForLoad({ maxLoad: config.maxLoad, log });
      const state = await prepareRepo(repo, byRepo.get(repo)!.map(i => i.baseCommit), { offline: config.offline, cloneMode: config.cloneMode, log });
      states.set(repo, state);
      if (state.error) log(`${repo}: unavailable (${state.error})`);
    }
  }));
  const runnable: PreparedInstance[] = [];
  for (const [repo, state] of states) if (!state.error) manifest.corpus[repo] = state.mode;
  for (const instance of pendingInstances) {
    const state = states.get(instance.repo)!;
    if (state.error || state.missing.includes(instance.baseCommit)) {
      manifest.unavailable.push({ instanceId: instance.instanceId, reason: state.error ?? `base commit ${instance.baseCommit.slice(0, 10)} not available` });
      finished += variants.filter(v => !isDone(instance.instanceId, v.name)).length;
    } else {
      runnable.push(instance);
    }
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // Phase 2: run. Instances are ordered by repository and base-commit date so each worker's checkout changes little.
  const commitTimes = new Map<string, number>();
  for (const state of states.values()) for (const [sha, time] of state.commitTimes) commitTimes.set(sha, time);
  const queue: Task[] = sortInstances(runnable, commitTimes).map(instance => ({ instance, todo: variants.filter(v => !isDone(instance.instanceId, v.name)) }));
  let stopping = false;
  let infraFailures = 0;
  const started = Date.now();
  const startFinished = finished;
  const next = (affinity: string): Task | undefined => {
    const index = queue.findIndex(task => task.instance.repo === affinity);
    return queue.splice(index >= 0 ? index : 0, 1)[0];
  };
  const record = async (row: RunRow) => {
    await appendFile(rowsPath, JSON.stringify(row) + '\n');
    finished++;
    const rate = (Date.now() - started) / 1000 / Math.max(1, finished - startFinished);
    const m = row.metrics;
    log(`[${String(finished).padStart(String(totalTasks).length)}/${totalTasks}] ${row.variant.padEnd(14)} ${row.instance_id.padEnd(40)} ${row.status.padEnd(7)} file=${m.packFileHit} rec=${m.packFileRecall.toFixed(2)} line=${m.goldLineRecall.toFixed(2)} rank=${m.firstGoldRank ?? '-'} tok=${row.outputTokens} ${(row.ms / 1000).toFixed(1)}s | eta ${formatDuration(rate * (totalTasks - finished))}`);
  };

  const onSignal = () => {
    if (stopping) process.exit(130);
    stopping = true;
    log('interrupt: stopping workers (finished rows are kept; re-run the same command to resume)');
    killAllChildren();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  await sweepStaleSlots(log);
  const worker = async (index: number) => {
    let slot: CheckoutSlot | undefined;
    let current = '';
    for (let task = next(current); task && !stopping; task = next(current)) {
      const { instance } = task;
      const state = states.get(instance.repo)!;
      if (!slot || instance.repo !== current) {
        if (slot && !config.keepCheckouts) await slot.dispose();
        current = instance.repo;
        slot = new CheckoutSlot(instance.repo, state.dir, `p${process.pid}-w${index}`);
      }
      try {
        await waitForLoad({ maxLoad: config.maxLoad, log, shouldStop: () => stopping });
        if (stopping) break;
        await retry(() => slot!.checkout(instance.baseCommit), 3, 3000, (error, attempt) => log(`checkout ${instance.instanceId} failed (attempt ${attempt}): ${(error as Error).message}`));
      } catch (error) {
        infraFailures++;
        for (const variant of task.todo) {
          const row = emptyRow(instance, variant.name, config.budget);
          row.status = 'infra';
          row.error = `checkout failed: ${(error as Error).message}`;
          await record(row);
        }
        continue;
      }
      // Hash-determined variant order removes systematic file-cache advantages between variants.
      const order = [...task.todo].sort((a, b) => cmp(sha256(`${instance.instanceId}:${a.name}`), sha256(`${instance.instanceId}:${b.name}`)));
      for (const variant of order) {
        if (stopping) break;
        await waitForLoad({ maxLoad: config.maxLoad, log, shouldStop: () => stopping });
        if (stopping) break;
        await slot.reset().catch(() => slot!.checkout(instance.baseCommit));
        const load1 = loadavg()[0];
        const outcome = await runInChild({
          variantRoot: variant.root,
          repoRoot: slot.dir,
          query: truncateQuery(instance.statement, variant.truncate),
          budget: config.budget,
          env: variant.env,
          timeoutMs: config.timeoutSec * 1000,
          maxOldSpaceMB: config.maxOldSpaceMB,
        });
        if (stopping) break; // killed by the interrupt, not a genuine failure
        const row = buildRow(instance, variant, outcome, config.budget, load1);
        if (config.savePacks && outcome.status === 'ok') {
          const file = join(config.out, 'packs', variant.name, `${instance.instanceId}.txt.gz`);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, gzipSync(outcome.result.text));
        }
        await record(row);
      }
    }
    if (slot && !config.keepCheckouts) await slot.dispose();
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, config.workers) }, (_, index) => worker(index)));
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    killAllChildren();
  }

  manifest.finishedAt = new Date().toISOString();
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const report = await writeReport(config.out, config.resamples);
  log(`report written to ${config.out}/report.md`);
  console.log(renderMarkdown(report, { compact: true }));
  return stopping ? 130 : infraFailures || manifest.unavailable.length ? 2 : 0;
}
