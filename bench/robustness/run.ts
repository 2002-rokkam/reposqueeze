import { parseArgs } from 'node:util';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { benchRepo, type RepoInfo, type RepoResult } from './lib/bench-repo.js';
import { ensureClone, loadCorpus, loadLock, pruneClone, saveLock, type CorpusEntry, type Lock } from './lib/corpus.js';
import { DEFAULT_CORPUS_DIR, DEFAULT_RESULTS_DIR, PRIVATE_RESULTS_DIR, SCRATCH_ROOT } from './lib/paths.js';
import { runPool } from './lib/pool.js';
import { generateQueries } from './lib/queries.js';
import { eligibleByPath, headSha, listRepoFiles, topExtensions, treeStats } from './lib/repo-stats.js';
import { sizeBucket } from './lib/stats.js';
import { ensureSynthetic, removeSynthetic } from './lib/synthetic.js';
import { configureThrottle } from './lib/throttle.js';
import { loadTokenizer } from './lib/tokens.js';
import { resolveVariants } from './lib/variants.js';

const HELP = `Corpus robustness runner: runs RepoSqueeze variants as CLI processes over real repositories.

  --variant name=path[:ENV=VAL,...]  variant to run (repeatable). Default: baseline=~/reposqueeze-lab/baseline
  --corpus DIR       clone directory (default ~/reposqueeze-lab/corpus/shallow)
  --results DIR      result directory (default ~/reposqueeze-lab/results/bench-robust)
  --repos a,b        only repositories whose owner/name contains one of these
  --limit N          only the N smallest selected repositories
  --timeout S        hard wall timeout per command in seconds (default 300; CPU-starved runs are extended, see README)
  --parallel N       repositories processed in parallel (default 2, max 2; also the heavy-process cap)
  --heavy-files N    repositories with at least N files run alone (default 20000)
  --max-rss-gb G     kill a command above this resident size (default 6)
  --max-load L       back off while the 1-minute load average is above L (default 40)
  --max-wait-min M   stop backing off after M minutes and continue one process at a time (default 10)
  --fetch            clone missing repositories at their pinned commit (shallow)
  --include-huge     also process wave-2 repositories (50k-190k files); off by default on the shared machine
  --synthetic a,b    also run generated repositories, e.g. code:60000,tiny:100050
  --prune            delete each clone after it was measured
  --skip-existing    keep results that already exist
  --quick            fewer commands per repository (development runs)
  --non-git a,b      additionally run these repositories as plain directories (no .git)
  --private DIR      run a private directory with every path/query/match redacted; writes only to results/private
  --label NAME       label for --private runs (default private)`;

const { values } = parseArgs({
  options: {
    variant: { type: 'string', multiple: true },
    corpus: { type: 'string', default: DEFAULT_CORPUS_DIR },
    results: { type: 'string', default: DEFAULT_RESULTS_DIR },
    repos: { type: 'string' },
    limit: { type: 'string' },
    timeout: { type: 'string', default: '300' },
    parallel: { type: 'string', default: '2' },
    'heavy-files': { type: 'string', default: '20000' },
    'max-rss-gb': { type: 'string', default: '6' },
    'max-load': { type: 'string', default: '40' },
    'max-wait-min': { type: 'string', default: '10' },
    fetch: { type: 'boolean', default: false },
    'include-huge': { type: 'boolean', default: false },
    synthetic: { type: 'string' },
    prune: { type: 'boolean', default: false },
    'skip-existing': { type: 'boolean', default: false },
    quick: { type: 'boolean', default: false },
    'non-git': { type: 'string' },
    private: { type: 'string' },
    label: { type: 'string', default: 'private' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const { variants, skipped } = resolveVariants(values.variant);
for (const entry of skipped) console.error(`SKIPPED ${entry.reason}`);
if (!variants.length) {
  console.error('No runnable variant. Build the variant (npm run build) or pass --variant name=path.');
  process.exit(2);
}

const timeoutMs = Number(values.timeout) * 1000;
const maxRssBytes = Number(values['max-rss-gb']) * 1024 ** 3;
const parallel = Math.max(1, Math.min(2, Number(values.parallel)));
const heavyFiles = Number(values['heavy-files']);
const scratchBase = join(SCRATCH_ROOT, `run-${process.pid}`);
const log = (line: string) => console.log(line);
configureThrottle({ maxProcs: 2, maxLoad: Number(values['max-load']), maxWaitMs: Number(values['max-wait-min']) * 60_000, log: line => log(`[throttle] ${line}`) });

async function prepare(entry: CorpusEntry, lock: Lock): Promise<RepoInfo | null> {
  const present = existsSync(join(values.corpus!, entry.name, '.git'));
  if (!present && !values.fetch) {
    log(`skip ${entry.repo}: not cloned (use --fetch)`);
    return null;
  }
  const clone = await ensureClone(entry, lock, values.corpus);
  const files = await listRepoFiles(clone.dir);
  let info = lock.repos[entry.name];
  if (!info || info.sha !== clone.sha || info.gitFiles === undefined) {
    const tree = await treeStats(clone.dir, files);
    info = {
      url: entry.url,
      sha: clone.sha,
      ecosystem: entry.ecosystem,
      category: entry.category,
      gitFiles: files.length,
      eligibleEstimate: files.filter(eligibleByPath).length,
      workTreeBytes: tree.bytes,
      topExtensions: topExtensions(files, 4),
    };
    lock.repos[entry.name] = info;
    await saveLock(lock);
  }
  const generated = await generateQueries(clone.dir, files, `${entry.name}@${clone.sha}`, entry.repo.split('/')[1]);
  return {
    name: entry.name,
    dir: clone.dir,
    ecosystem: entry.ecosystem,
    category: entry.category,
    sha: clone.sha,
    gitFiles: files.length,
    eligibleEstimate: info.eligibleEstimate ?? files.length,
    workTreeBytes: info.workTreeBytes ?? 0,
    files,
    generated,
  };
}

async function writeResult(dir: string, name: string, result: RepoResult): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
}

function oneLine(result: RepoResult): string {
  const ok = result.commands.filter(c => c.outcome === 'ok').length;
  const bad = result.commands.filter(c => c.outcome === 'crash' || c.outcome === 'timeout' || c.outcome === 'memory-limit' || c.outcome === 'overflow');
  const cold = result.commands.find(c => c.phase === 'cold');
  const warm = result.commands.find(c => c.phase === 'warm');
  const violations = result.commands.filter(c => c.withinBudget === false).length;
  const nondeterministic = result.determinism.filter(d => !d.identical).length;
  const peak = Math.max(0, ...result.commands.map(c => c.rssMiB ?? 0));
  return `${result.repo.name}${result.mode === 'non-git' ? '@nogit' : ''} [${result.variant}] files=${result.repo.gitFiles} ok=${ok}/${result.commands.length} bad=${bad.length} budget-violations=${violations} nondeterministic=${nondeterministic} cold=${((cold?.wallMs ?? 0) / 1000).toFixed(1)}s(cpu ${cold?.cpuSec ?? '?'}) warm=${((warm?.wallMs ?? 0) / 1000).toFixed(1)}s peakRSS=${peak.toFixed(0)}MiB`;
}

async function runPrivate(directory: string): Promise<void> {
  const label = values.label!;
  const files = await listRepoFiles(directory).catch(() => [] as string[]);
  // Work on an APFS copy-on-write clone so the sanctioned target is never written to (caches, etc.).
  const copy = join(SCRATCH_ROOT, 'private-copy', label);
  await rm(copy, { recursive: true, force: true });
  await mkdir(join(SCRATCH_ROOT, 'private-copy'), { recursive: true });
  await cp(directory, copy, { recursive: true, mode: 1 /* COPYFILE_FICLONE */, verbatimSymlinks: true });
  try {
    const generated = await generateQueries(copy, files, `private:${label}`, label);
    const sha = await headSha(copy).catch(() => 'n/a');
    const tree = await treeStats(copy, files);
    const info: RepoInfo = { name: label, dir: copy, ecosystem: 'private', category: 'private', sha, gitFiles: files.length, eligibleEstimate: files.filter(eligibleByPath).length, workTreeBytes: tree.bytes, files, generated };
    for (const variant of variants) {
      const tokenizer = loadTokenizer(variant.root);
      const result = await benchRepo(variant, info, { timeoutMs, scratchDir: join(scratchBase, 'private'), maxRssBytes, quick: values.quick!, redact: true, tokenizer, log: () => undefined });
      result.repo.sha = '';
      result.repo.name = label;
      await writeResult(PRIVATE_RESULTS_DIR, `${label}-${variant.name}`, result);
      log(`private ${oneLine(result).replace(/^\S+/, label)}`);
    }
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

interface Job {
  name: string;
  size: number;
  repo: string;
  prepare(): Promise<RepoInfo | null>;
  cleanup(): Promise<void>;
}

function corpusJob(entry: CorpusEntry, lock: Lock): Job {
  return {
    name: entry.name,
    repo: entry.repo,
    size: lock.repos[entry.name]?.gitFiles ?? 0,
    prepare: () => prepare(entry, lock),
    cleanup: async () => {
      if (values.prune) await pruneClone(entry, values.corpus);
    },
  };
}

/** `code:60000,tiny:100050` -> generated repositories (see lib/synthetic.ts). */
function syntheticJobs(spec: string | undefined): Job[] {
  return (spec ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      const [kind, count] = item.split(':');
      if ((kind !== 'code' && kind !== 'tiny') || !Number.isInteger(Number(count))) throw new Error(`Invalid --synthetic entry "${item}" (use code:N or tiny:N)`);
      const synthetic = { kind, files: Number(count) } as const;
      const name = `synthetic-${kind}-${count}`;
      return {
        name,
        repo: name,
        size: synthetic.files,
        prepare: async () => {
          const dir = await ensureSynthetic(synthetic, line => log(line));
          const files = await listRepoFiles(dir);
          const tree = await treeStats(dir, files);
          const generated = await generateQueries(dir, files, name, name);
          return { name, dir, ecosystem: 'synthetic', category: `synthetic-${kind}`, sha: await headSha(dir), gitFiles: files.length, eligibleEstimate: files.filter(eligibleByPath).length, workTreeBytes: tree.bytes, files, generated };
        },
        cleanup: async () => {
          if (values.prune) await removeSynthetic(synthetic);
        },
      };
    });
}

async function main(): Promise<void> {
  if (values.private) {
    await runPrivate(values.private);
    return;
  }
  const lock = loadLock();
  const filters = values.repos?.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  const entries = loadCorpus().filter(entry => {
    if (entry.wave === 2 && !values['include-huge'] && !filters?.length) return false;
    return !filters?.length || filters.some(filter => entry.repo.toLowerCase().includes(filter) || entry.name.toLowerCase().includes(filter));
  });
  let jobs = [...entries.map(entry => corpusJob(entry, lock)), ...syntheticJobs(values.synthetic)].sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  if (values.limit) jobs = jobs.slice(0, Number(values.limit));
  const nonGit = new Set(values['non-git']?.split(',').map(item => item.trim().toLowerCase()).filter(Boolean));
  log(`variants: ${variants.map(v => v.name).join(', ')}; repositories: ${jobs.length}; timeout ${timeoutMs / 1000}s; parallel ${parallel}; machine load ${loadavg()[0].toFixed(0)}`);

  const worker = async (job: Job): Promise<void> => {
    const todo = variants.filter(v => !(values['skip-existing'] && existsSync(join(values.results!, v.name, 'corpus', `${job.name}.json`))));
    if (!todo.length) return;
    const repo = await job.prepare().catch(error => {
      log(`FAILED to prepare ${job.repo}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (!repo) return;
    for (const variant of todo) {
      const tokenizer = loadTokenizer(variant.root);
      const options = { timeoutMs, scratchDir: join(scratchBase, job.name), maxRssBytes, quick: values.quick!, redact: false, tokenizer, log };
      const result = await benchRepo(variant, repo, options);
      result.repo.bucket = sizeBucket(repo.gitFiles);
      await writeResult(join(values.results!, variant.name, 'corpus'), job.name, result);
      log(oneLine(result));
      if ([...nonGit].some(token => job.repo.toLowerCase().includes(token))) {
        const copy = join(SCRATCH_ROOT, 'nongit', job.name);
        await rm(copy, { recursive: true, force: true });
        await mkdir(join(SCRATCH_ROOT, 'nongit'), { recursive: true });
        await cp(repo.dir, copy, { recursive: true, mode: 1, verbatimSymlinks: true });
        await rm(join(copy, '.git'), { recursive: true, force: true });
        try {
          const plain = await benchRepo(variant, repo, options, 'non-git', copy);
          plain.repo.bucket = sizeBucket(repo.gitFiles);
          await writeResult(join(values.results!, variant.name, 'corpus'), `${job.name}@nogit`, plain);
          log(oneLine(plain));
        } finally {
          await rm(copy, { recursive: true, force: true });
        }
      }
    }
    await job.cleanup();
  };

  const light = jobs.filter(job => job.size < heavyFiles);
  const heavy = jobs.filter(job => job.size >= heavyFiles);
  await runPool(light, parallel, worker);
  await runPool(heavy, 1, worker);
  await rm(scratchBase, { recursive: true, force: true });
}

await main();
