import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DATASETS, loadDataset, parseDatasetKeys, type DatasetKey } from './lib/dataset.js';
import { execute, loadSelection, writeReport, type RunConfig } from './lib/execute.js';
import { BENCH_ROOT, resultsDir } from './lib/paths.js';
import { waitForLoad } from './lib/load.js';
import { excludedByUpstreamPolicy } from './lib/policy.js';
import { prepareRepo } from './lib/repos.js';
import { renderMarkdown } from './lib/render.js';
import { SelectionError } from './lib/select.js';
import { DEFAULT_RESAMPLES, DEFAULT_SEED } from './lib/stats.js';
import { buildSplitsFile, verifySplitsFile, type Split } from './lib/split.js';
import { parseVariantSpec, type VariantSpec } from './lib/variants.js';

const USAGE = `RepoSqueeze SWE retrieval benchmark (SWE-bench Lite / Multilingual / Verified)

Usage: node --import tsx bench/run.ts [command] [options]

Commands
  run (default)  run variants on the selected instances and write rows.jsonl, report.json, report.md
  data           download + cache the datasets, print sizes, hashes and gold-extraction statistics (dev only)
  splits         write bench/splits.json from the cached datasets (--check verifies it instead)
  prepare        clone repositories and fetch base commits for the selection, without running anything
  report         regenerate report.json/report.md from an existing --out directory

Selection
  --dataset lite,multilingual,verified   datasets to use (default lite,multilingual)
  --split dev|test                       dev (default). test is held out and refused unless
                                         --i-am-the-orchestrator-final-run is given
  --repos owner/name,...                 restrict to repositories
  --instances id,...                     restrict to instance ids (must belong to the split)
  --sample N [--sample-mode even|proportional]   deterministic repository-stratified sample
  --limit N                              first N instances in execution order
  --seed N                               seed for sampling and bootstrap (default ${DEFAULT_SEED})

Execution
  --variant name=/path/to/repo[:ENV=VAL,ENV=VAL][:@truncate=N]   repeatable; bare names: ripgrep-naive, baseline, current
  --variant-env name:KEY=VALUE           extra environment for one variant (repeatable)
  --budget N                             token budget, 256..32000 (default 4000)
  --workers N                            parallel instances (default 2; keep <= 3)
  --timeout SEC                          per-run hard timeout (default 120)
  --out DIR                              output directory (required); re-running the same command resumes it
  --retry-failed                         re-run timeouts/errors found in an existing --out
  --force-resume                         resume even if variant sources or settings changed
  --offline                              never use the network (instances not in the corpus are reported unavailable)
  --prepare-jobs N                       concurrent clones (default 2)
  --clone-mode full|shallow              full (default): complete clones, git history available to variants.
                                         shallow: one depth-1 snapshot per base commit; far less data for huge repos,
                                         but variants see no history
  --max-load N                           back off while the machine's 1-minute load average exceeds N (default 40; 0 = off)
  --max-old-space-mb N                   V8 heap cap per child process (default: Node default)
  --keep-checkouts                       keep worker checkouts after the run
  --no-save-packs                        do not store pack text
  --bootstrap N                          bootstrap resamples (default ${DEFAULT_RESAMPLES}, minimum ${DEFAULT_RESAMPLES})
  --dry-run                              print the plan only
  --refresh-data                         re-download the datasets
`;

const options = {
  dataset: { type: 'string', default: 'lite,multilingual' },
  split: { type: 'string', default: 'dev' },
  'i-am-the-orchestrator-final-run': { type: 'boolean', default: false },
  repos: { type: 'string' },
  instances: { type: 'string' },
  sample: { type: 'string' },
  'sample-mode': { type: 'string', default: 'even' },
  limit: { type: 'string' },
  seed: { type: 'string', default: String(DEFAULT_SEED) },
  variant: { type: 'string', multiple: true },
  'variant-env': { type: 'string', multiple: true },
  budget: { type: 'string', default: '4000' },
  workers: { type: 'string', default: '2' },
  timeout: { type: 'string', default: '120' },
  out: { type: 'string' },
  'retry-failed': { type: 'boolean', default: false },
  'force-resume': { type: 'boolean', default: false },
  offline: { type: 'boolean', default: false },
  'prepare-jobs': { type: 'string', default: '2' },
  'clone-mode': { type: 'string', default: 'full' },
  'max-load': { type: 'string', default: '40' },
  'max-old-space-mb': { type: 'string', default: '0' },
  'keep-checkouts': { type: 'boolean', default: false },
  'no-save-packs': { type: 'boolean', default: false },
  bootstrap: { type: 'string', default: String(DEFAULT_RESAMPLES) },
  'dry-run': { type: 'boolean', default: false },
  'refresh-data': { type: 'boolean', default: false },
  check: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

class UsageError extends Error {}

function integer(name: string, value: string | undefined, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`--${name} must be an integer in [${min}, ${max}], got "${value}"`);
  return n;
}

const list = (value: string | undefined) => (value ? value.split(',').map(s => s.trim()).filter(Boolean) : undefined);

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

async function main(): Promise<number> {
  const parsed = parseArgs({ options, allowPositionals: true, strict: true });
  const values = parsed.values;
  const command = parsed.positionals[0] ?? 'run';
  if (values.help || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (parsed.positionals.length > 1) throw new UsageError(`unexpected argument "${parsed.positionals[1]}"`);

  const split = values.split as string;
  if (split !== 'dev' && split !== 'test') throw new UsageError('--split must be dev or test');
  if (split === 'test' && !values['i-am-the-orchestrator-final-run']) {
    throw new UsageError('REFUSING to touch the held-out TEST split. It may only be executed once, by the orchestrator, with --i-am-the-orchestrator-final-run.');
  }
  const datasets = parseDatasetKeys(values.dataset as string);
  const cloneMode = values['clone-mode'] as string;
  if (cloneMode !== 'full' && cloneMode !== 'shallow') throw new UsageError('--clone-mode must be full or shallow');
  const seed = integer('seed', values.seed as string, 0)!;
  const filters = {
    repos: list(values.repos),
    instances: list(values.instances),
    sample: integer('sample', values.sample, 1),
    sampleMode: (values['sample-mode'] === 'proportional' ? 'proportional' : 'even') as 'even' | 'proportional',
    limit: integer('limit', values.limit, 1),
  };
  const log = (message: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
  const selectionConfig = { datasets, split: split as Split, filters, seed, refreshData: values['refresh-data'], log };

  if (command === 'data') return dataCommand(datasets, values['refresh-data'] as boolean, log);
  if (command === 'splits') return splitsCommand(values.check as boolean, values['refresh-data'] as boolean, log);
  if (command === 'report') {
    if (!values.out) throw new UsageError('report needs --out DIR');
    const resamples = integer('bootstrap', values.bootstrap as string, DEFAULT_RESAMPLES)!;
    const report = await writeReport(resolve(values.out), resamples);
    console.log(renderMarkdown(report, { compact: true }));
    return 0;
  }
  if (command === 'prepare') {
    const selection = await loadSelection(selectionConfig);
    const byRepo = new Map<string, string[]>();
    for (const instance of selection.selected) byRepo.set(instance.repo, [...(byRepo.get(instance.repo) ?? []), instance.baseCommit]);
    let failures = 0;
    const maxLoad = integer('max-load', values['max-load'] as string, 0)!;
    for (const [repo, commits] of byRepo) {
      if (!values.offline) await waitForLoad({ maxLoad, log });
      const state = await prepareRepo(repo, commits, { offline: values.offline as boolean, cloneMode, log });
      log(`${repo}: ${state.error ? `ERROR ${state.error}` : `ok, ${commits.length} commit(s), ${state.missing.length} missing`}`);
      if (state.error || state.missing.length) failures++;
    }
    return failures ? 2 : 0;
  }
  if (command !== 'run') throw new UsageError(`unknown command "${command}"`);

  const variantArgs = values.variant ?? [];
  if (!variantArgs.length) throw new UsageError('at least one --variant is required, e.g. --variant baseline --variant ripgrep-naive');
  const variants: VariantSpec[] = variantArgs.map(parseVariantSpec);
  const names = new Set<string>();
  for (const variant of variants) {
    if (names.has(variant.name)) throw new UsageError(`duplicate variant name "${variant.name}"`);
    names.add(variant.name);
  }
  for (const entry of values['variant-env'] ?? []) {
    const match = /^([^:=]+):([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(entry);
    const target = match && variants.find(v => v.name === match[1]);
    if (!match || !target) throw new UsageError(`--variant-env expects name:KEY=VALUE for a declared variant, got "${entry}"`);
    target.env[match[2]] = match[3];
  }
  const resamples = integer('bootstrap', values.bootstrap as string, DEFAULT_RESAMPLES)!;
  if (!values.out && !values['dry-run']) throw new UsageError('--out DIR is required');
  const config: RunConfig = {
    ...selectionConfig,
    out: values.out ? resolve(values.out) : join(resultsDir(), 'dry-run'),
    variants,
    budget: integer('budget', values.budget as string, 256, 32000)!,
    workers: integer('workers', values.workers as string, 1, 64)!,
    timeoutSec: integer('timeout', values.timeout as string, 1)!,
    resamples,
    offline: values.offline as boolean,
    retryFailed: values['retry-failed'] as boolean,
    savePacks: !values['no-save-packs'],
    keepCheckouts: values['keep-checkouts'] as boolean,
    forceResume: values['force-resume'] as boolean,
    maxOldSpaceMB: integer('max-old-space-mb', values['max-old-space-mb'] as string, 0)!,
    prepareJobs: integer('prepare-jobs', values['prepare-jobs'] as string, 1, 16)!,
    maxLoad: integer('max-load', values['max-load'] as string, 0)!,
    cloneMode: cloneMode,
    command: `node --import tsx bench/run.ts ${process.argv.slice(2).map(quote).join(' ')}`,
  };
  if (config.workers > 3) log(`warning: --workers ${config.workers} exceeds the recommended maximum of 3 heavy processes`);

  if (values['dry-run']) {
    const selection = await loadSelection(config);
    const repos = new Map<string, number>();
    const languages = new Map<string, number>();
    for (const instance of selection.selected) {
      repos.set(instance.repo, (repos.get(instance.repo) ?? 0) + 1);
      languages.set(instance.language, (languages.get(instance.language) ?? 0) + 1);
    }
    console.log(JSON.stringify({
      split, datasets: selection.datasetStats.map(d => ({ key: d.key, total: d.total, dev: d.dev, test: d.test, prepared: d.prepared, selected: d.selected })),
      skipped: Object.fromEntries(selection.skipped.reduce((m, s) => m.set(s.reason, (m.get(s.reason) ?? 0) + 1), new Map<string, number>())),
      selected: selection.selected.length, repos: Object.fromEntries(repos), languages: Object.fromEntries(languages),
      variants: variants.map(v => ({ name: v.name, root: v.root, env: v.env, truncate: v.truncate })),
    }, null, 2));
    return 0;
  }
  return execute(config);
}

async function dataCommand(keys: DatasetKey[], refresh: boolean, log: (message: string) => void): Promise<number> {
  const { mergeInstances } = await import('./lib/dataset.js');
  const { prepareSplit } = await import('./lib/gold.js');
  const { splitOf } = await import('./lib/split.js');
  const loaded = [];
  for (const key of keys) loaded.push(await loadDataset(key, { refresh, log }));
  const rows: string[][] = [['dataset', 'hf revision', 'rows per hf split', 'content sha256', 'unique ids', 'dev', 'held-out test']];
  for (const d of loaded) {
    const ids = [...new Set(d.instances.map(i => i.instanceId))];
    rows.push([d.hfId, d.revision?.slice(0, 12) ?? 'unknown', d.files.map(f => `${f.hfSplit}:${f.rows}`).join(' '), d.contentSha256.slice(0, 16), String(ids.length), String(ids.filter(id => splitOf(id) === 'dev').length), String(ids.filter(id => splitOf(id) === 'test').length)]);
  }
  console.log(rows.map(r => r.join(' | ')).join('\n'));
  // Content-level statistics are computed for the dev split only; held-out instances are never parsed or shown.
  const dev = prepareSplit(mergeInstances(loaded), 'dev');
  const reasons = Object.entries(dev.stats.skipped).map(([k, v]) => `${k}=${v}`).join(', ') || 'none';
  console.log(`\ndev instances: ${dev.stats.total}; usable after gold extraction: ${dev.stats.selected}; skipped: ${reasons}`);
  const byLanguage = new Map<string, number>();
  for (const p of dev.prepared) byLanguage.set(p.language, (byLanguage.get(p.language) ?? 0) + 1);
  console.log(`dev by language: ${[...byLanguage].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`dev repositories: ${new Set(dev.prepared.map(p => p.repo)).size}`);
  const mentions = dev.prepared.filter(p => p.mentions.any).length;
  const unreachable = dev.prepared.filter(p => p.gold.every(g => excludedByUpstreamPolicy(g.path))).length;
  const partlyUnreachable = dev.prepared.filter(p => p.gold.some(g => excludedByUpstreamPolicy(g.path))).length;
  console.log(`dev instances whose issue names a gold file: ${mentions} (${((100 * mentions) / dev.prepared.length).toFixed(1)}%)`);
  console.log(`dev instances with a gold file under paths upstream 2.1.0 never indexes: ${partlyUnreachable} (${unreachable} with no reachable gold file at all)`);
  const python = dev.prepared.filter(p => p.language === 'Python');
  const django = python.filter(p => p.repo === 'django/django').length;
  console.log(`dev Python instances: ${python.length}, of which django/django: ${django} (${((100 * django) / Math.max(1, python.length)).toFixed(1)}%)`);
  return 0;
}

async function splitsCommand(check: boolean, refresh: boolean, log: (message: string) => void): Promise<number> {
  const loaded = [];
  for (const key of Object.keys(DATASETS) as DatasetKey[]) loaded.push(await loadDataset(key, { refresh, log }));
  const file = buildSplitsFile(loaded);
  const path = join(BENCH_ROOT, 'splits.json');
  if (check) {
    const stored = JSON.parse(await readFile(path, 'utf8'));
    const problems = verifySplitsFile(stored);
    if (JSON.stringify(stored) !== JSON.stringify(file)) problems.push('bench/splits.json differs from the splits recomputed from the cached datasets');
    for (const problem of problems) console.error(problem);
    console.log(problems.length ? 'splits.json is NOT consistent' : 'splits.json is consistent with the rule and the cached datasets');
    return problems.length ? 1 : 0;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 1) + '\n');
  for (const [key, entry] of Object.entries(file.datasets)) console.log(`${key}: ${entry.counts.total} ids -> dev ${entry.counts.dev}, test ${entry.counts.test}`);
  console.log(`wrote ${path}`);
  return 0;
}

main().then(
  code => process.exit(code),
  error => {
    if (error instanceof UsageError || error instanceof SelectionError || (error as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      console.error(`error: ${(error as Error).message}\n(run with --help for usage)`);
      process.exit(2);
    }
    console.error(error);
    process.exit(1);
  },
);
