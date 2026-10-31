import { existsSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { args, runCli, type CliRun, type Outcome } from './cli.js';
import { checkBudget, findSecrets, parseContextHeader, parseMapHeader, verifyExpand, verifyFrames, type ExpandVerification, type HeaderInfo, type SecretFinding } from './analyze.js';
import { LAB } from './paths.js';
import { parsePack } from './packcheck.js';
import { distinctiveLines, findLeakedLines, isSecretPath } from './secrets.js';
import type { Tokenizer } from './tokens.js';
import type { Variant } from './variants.js';
import type { GeneratedQueries } from './queries.js';
import { readCacheFiles } from './fixtures.js';

const exec = promisify(execFile);

export interface RepoInfo {
  name: string;
  dir: string;
  ecosystem: string;
  category: string;
  sha: string;
  gitFiles: number;
  eligibleEstimate: number;
  workTreeBytes: number;
  files: readonly string[];
  generated: GeneratedQueries;
}

export interface BenchOptions {
  timeoutMs: number;
  scratchDir: string;
  /** Kill a command whose RSS exceeds this (bytes). */
  maxRssBytes: number;
  /** Fewer commands (cold, warm, one budget sweep) for development runs. */
  quick: boolean;
  /** Strip every path, query, match and message from the record (private targets). */
  redact: boolean;
  tokenizer: Tokenizer;
  log: (line: string) => void;
}

export interface CommandRecord {
  id: string;
  kind: 'context' | 'map' | 'expand';
  label: string;
  budget: number;
  json: boolean;
  phase: string;
  outcome: Outcome | 'skipped';
  detail: string;
  exitCode: number | null;
  timedOut: boolean;
  starvationExtensions: number;
  wallMs: number;
  cpuSec: number | null;
  rssMiB: number | null;
  load1: number;
  stdoutBytes: number;
  stdoutTokens: number | null;
  tokensApprox: boolean;
  withinBudget: boolean | null;
  /** Tokens of the whole --json document (wrapper included), informational. */
  jsonDocTokens?: number;
  stdoutSha: string;
  stderrHead: string;
  header?: HeaderInfo;
  selfReportedTokens?: number | null;
  selfReportMatches?: boolean | null;
  frames?: number;
  badPaths?: string[];
  notVerbatim?: number;
  receiptsChecked?: number;
  receiptsMatching?: number;
  expand?: ExpandVerification;
  secretFindings?: SecretFinding[];
  secretLineLeaks?: { line: string; duplicatedElsewhere: boolean }[];
}

export interface DeterminismCheck {
  name: string;
  identical: boolean;
  a: string;
  b: string;
}

export interface RepoResult {
  schema: 1;
  variant: string;
  variantRoot: string;
  variantEnv: Record<string, string>;
  mode: 'git' | 'non-git';
  repo: Omit<RepoInfo, 'dir' | 'files' | 'generated'> & { bucket: string };
  queries: { kind: string; text: string; source: { path: string; line: number } | null }[];
  expandTarget: { path: string; start: number; end: number } | null;
  commands: CommandRecord[];
  determinism: DeterminismCheck[];
  index: { cacheBytesAfterCold: number; cacheFiles: number; dirs: string[] };
  secretPathFiles: number;
  secretLinesChecked: number;
  aborted?: string;
  durationSec: number;
}

interface CacheSetup {
  env: Record<string, string>;
  dirs: string[];
}

/**
 * Cache directories the variant may write for this repository. REPOSQUEEZE_CACHE_DIR (when set and inside
 * the lab) is treated as a base directory and given a per-repository subfolder so "cold" is a plain rm -rf.
 */
export function cacheSetup(variant: Variant, repoDir: string, repoName: string): CacheSetup {
  const env = { ...variant.env };
  const dirs = [join(repoDir, '.reposqueeze-v2'), join(repoDir, '.reposqueeze')];
  const base = env.REPOSQUEEZE_CACHE_DIR;
  if (base) {
    if (base.startsWith(LAB + '/')) {
      env.REPOSQUEEZE_CACHE_DIR = join(base, repoName);
      dirs.push(env.REPOSQUEEZE_CACHE_DIR);
    }
  }
  return { env, dirs };
}

async function dirSize(dirs: readonly string[]): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  for (const file of await readCacheFiles(dirs)) {
    files++;
    bytes += file.views[0].length;
  }
  return { bytes, files };
}

const parseStats = (stderr: string): { outputTokens?: number } | null => {
  for (const line of stderr.trim().split('\n').reverse()) {
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as { outputTokens?: number };
    } catch {
      return null;
    }
  }
  return null;
};

/** Does `line` also occur in some tracked/untracked file that is not secret-named? (then it is not a leak of a secret file). */
async function duplicatedElsewhere(root: string, line: string, cache: Map<string, boolean>): Promise<boolean> {
  const cached = cache.get(line);
  if (cached !== undefined) return cached;
  let result = false;
  try {
    const { stdout } = await exec('git', ['grep', '--untracked', '-F', '-x', '-l', '-e', line], { cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
    result = stdout.split('\n').filter(Boolean).some(file => !isSecretPath(file));
  } catch {
    result = false;
  }
  cache.set(line, result);
  return result;
}

interface Plan {
  id: string;
  kind: 'context' | 'map' | 'expand';
  label: string;
  budget: number;
  json?: boolean;
  phase: string;
  clearCache?: boolean;
  args: string[];
}

function buildPlan(repo: RepoInfo, root: string, quick: boolean): Plan[] {
  const [q1, q2, q3] = repo.generated.queries;
  // Repetitions that only re-check determinism or add a second budget are cheap for small repositories and
  // expensive (minutes of CPU) for large ones, so they are restricted to repositories below the cascade threshold.
  const small = repo.gitFiles < 5_000;
  const ctx = (label: string, query: string, budget: number, phase: string, extra: Partial<Plan> = {}): Plan => ({
    id: `context:${label}:b${budget}${extra.json ? ':json' : ''}:${phase}`,
    kind: 'context',
    label,
    budget,
    phase,
    args: args.context(root, query, budget, extra.json),
    ...extra,
  });
  const plan: Plan[] = [ctx('identifier', q1.text, 1000, 'cold', { clearCache: true }), ctx('identifier', q1.text, 1000, 'warm')];
  if (small) plan.push(ctx('identifier', q1.text, 1000, 'warm-2'));
  plan.push(
    ctx('identifier', q1.text, 1000, 'cold-again', { clearCache: true }),
    ctx('identifier', q1.text, 256, 'budget'),
    ctx('identifier', q1.text, 4000, 'budget'),
    ctx('identifier', q1.text, 32000, 'budget'),
    ctx('identifier', q1.text, 1000, 'json', { json: true }),
  );
  if (!quick) {
    plan.push(ctx('comment', q2.text, 1000, 'query'), ctx('trace', q3.text, 1000, 'query'));
    if (small) plan.push(ctx('comment', q2.text, 4000, 'query'), ctx('trace', q3.text, 4000, 'query'));
  }
  plan.push({ id: 'map:b1500:a', kind: 'map', label: 'map', budget: 1500, phase: 'map', args: args.map(root, 1500) });
  if (small) plan.push({ id: 'map:b1500:b', kind: 'map', label: 'map', budget: 1500, phase: 'map-2', args: args.map(root, 1500) });
  const target = repo.generated.expand;
  if (target) {
    const expandArgs = args.expand(root, target.path, target.start, target.end);
    plan.push({ id: 'expand:a', kind: 'expand', label: 'expand', budget: 3000, phase: 'expand', args: expandArgs });
    if (small) plan.push({ id: 'expand:b', kind: 'expand', label: 'expand', budget: 3000, phase: 'expand-2', args: expandArgs });
  }
  return plan;
}

/** Runs every planned command of one repository against one variant and records the evidence. */
export async function benchRepo(variant: Variant, repo: RepoInfo, options: BenchOptions, mode: 'git' | 'non-git' = 'git', rootOverride?: string): Promise<RepoResult> {
  const root = rootOverride ?? repo.dir;
  const started = performance.now();
  const { env, dirs } = cacheSetup(variant, root, repo.name);
  const listing = new Set(repo.files);
  const secretFiles = repo.files.filter(isSecretPath);
  const secretLines: string[] = [];
  for (const file of secretFiles.slice(0, 60)) {
    try {
      const info = await stat(join(repo.dir, file));
      if (info.isFile() && info.size <= 256 * 1024) secretLines.push(...distinctiveLines(await readFile(join(repo.dir, file), 'utf8'), 500));
    } catch {
      /* unreadable secret file: nothing to compare */
    }
  }
  const duplicates = new Map<string, boolean>();
  const clearCaches = async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  };

  const result: RepoResult = {
    schema: 1,
    variant: variant.name,
    variantRoot: variant.root,
    variantEnv: variant.env,
    mode,
    repo: {
      name: repo.name,
      ecosystem: repo.ecosystem,
      category: repo.category,
      sha: repo.sha,
      gitFiles: repo.gitFiles,
      eligibleEstimate: repo.eligibleEstimate,
      workTreeBytes: repo.workTreeBytes,
      bucket: '',
    },
    queries: options.redact ? [] : repo.generated.queries,
    expandTarget: options.redact ? null : repo.generated.expand,
    commands: [],
    determinism: [],
    index: { cacheBytesAfterCold: 0, cacheFiles: 0, dirs: [] },
    secretPathFiles: secretFiles.length,
    secretLinesChecked: secretLines.length,
    durationSec: 0,
  };

  const plan = buildPlan(repo, root, options.quick);
  const byId = new Map<string, CliRun>();
  let consecutiveTimeouts = 0;
  let coldCpuSec = 0;
  for (const step of plan) {
    if (result.aborted) {
      result.commands.push(skipped(step, result.aborted));
      continue;
    }
    // A rebuilt cold cache only adds information when the variant keeps a persistent index, and it
    // doubles the most expensive call, so it is skipped for index builds that already cost minutes.
    if (step.phase === 'cold-again' && (result.index.cacheBytesAfterCold === 0 || coldCpuSec > 150)) {
      result.commands.push(skipped(step, result.index.cacheBytesAfterCold === 0 ? 'no persistent index was written' : 'cold run already used more than 150 s CPU'));
      continue;
    }
    if (step.clearCache) await clearCaches();
    const run = await runCli({ variant: { ...variant, env }, args: step.args, cwd: root, timeoutMs: options.timeoutMs, scratchDir: options.scratchDir, maxRssBytes: options.maxRssBytes });
    byId.set(step.id, run);
    const record = await analyze(step, run, { root, listing, options, secretLines, duplicates, repoDir: repo.dir });
    result.commands.push(record);
    if (step.phase === 'cold') {
      const size = await dirSize(dirs);
      result.index = { cacheBytesAfterCold: size.bytes, cacheFiles: size.files, dirs: dirs.filter(dir => existsSync(dir)).map(dir => (dir.startsWith(repo.dir) ? dir.slice(repo.dir.length + 1) : '<cache-dir>')) };
    }
    if (step.phase === 'cold' && run.outcome === 'ok') coldCpuSec = (run.userSec ?? 0) + (run.sysSec ?? 0);
    consecutiveTimeouts = run.outcome === 'timeout' ? consecutiveTimeouts + 1 : 0;
    if (consecutiveTimeouts >= 3) result.aborted = 'aborted after 3 consecutive timeouts';
  }

  const pair = (name: string, a: string, b: string) => {
    const left = byId.get(a);
    const right = byId.get(b);
    if (left && right && left.outcome === 'ok' && right.outcome === 'ok') result.determinism.push({ name, a, b, identical: left.stdoutSha === right.stdoutSha });
  };
  pair('context cold vs warm', 'context:identifier:b1000:cold', 'context:identifier:b1000:warm');
  pair('context warm vs warm', 'context:identifier:b1000:warm', 'context:identifier:b1000:warm-2');
  pair('context cold vs cold (cache rebuilt)', 'context:identifier:b1000:cold', 'context:identifier:b1000:cold-again');
  pair('map run 1 vs run 2', 'map:b1500:a', 'map:b1500:b');
  pair('expand run 1 vs run 2', 'expand:a', 'expand:b');

  await clearCaches();
  result.durationSec = (performance.now() - started) / 1000;
  return result;
}

function skipped(step: Plan, reason: string): CommandRecord {
  return {
    id: step.id,
    kind: step.kind,
    label: step.label,
    budget: step.budget,
    json: !!step.json,
    phase: step.phase,
    outcome: 'skipped',
    detail: reason,
    exitCode: null,
    timedOut: false,
    starvationExtensions: 0,
    wallMs: 0,
    cpuSec: null,
    rssMiB: null,
    load1: 0,
    stdoutBytes: 0,
    stdoutTokens: null,
    tokensApprox: false,
    withinBudget: null,
    stdoutSha: '',
    stderrHead: '',
  };
}

interface AnalyzeContext {
  root: string;
  repoDir: string;
  listing: ReadonlySet<string>;
  options: BenchOptions;
  secretLines: readonly string[];
  duplicates: Map<string, boolean>;
}

async function analyze(step: Plan, run: CliRun, ctx: AnalyzeContext): Promise<CommandRecord> {
  const { options } = ctx;
  const record: CommandRecord = {
    id: step.id,
    kind: step.kind,
    label: step.label,
    budget: step.budget,
    json: !!step.json,
    phase: step.phase,
    outcome: run.outcome,
    detail: options.redact ? '' : run.detail,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    starvationExtensions: run.starvationExtensions,
    wallMs: Math.round(run.wallMs),
    cpuSec: run.userSec !== undefined && run.sysSec !== undefined ? Math.round((run.userSec + run.sysSec) * 100) / 100 : null,
    rssMiB: run.rssBytes === undefined ? null : Math.round((run.rssBytes / 1048576) * 10) / 10,
    load1: Math.round(run.load1 * 10) / 10,
    stdoutBytes: run.stdoutBytes,
    stdoutTokens: null,
    tokensApprox: false,
    withinBudget: null,
    stdoutSha: run.stdoutSha,
    stderrHead: options.redact ? '' : run.stderrText.slice(0, 300),
  };
  if (run.outcome !== 'ok') return record;

  let packText = run.stdoutText;
  if (step.json) {
    try {
      const doc = JSON.parse(run.stdoutText) as { text: string; stats?: { outputTokens?: number } };
      packText = doc.text;
      record.jsonDocTokens = checkBudget(options.tokenizer, run.stdoutText, Infinity).tokens;
      record.selfReportedTokens = doc.stats?.outputTokens ?? null;
    } catch {
      record.detail = 'stdout is not valid JSON';
      record.outcome = 'crash';
      return record;
    }
    const check = checkBudget(options.tokenizer, packText, step.budget);
    record.stdoutTokens = check.tokens;
    record.tokensApprox = check.approximated;
    record.withinBudget = check.withinBudget;
    record.selfReportMatches = record.selfReportedTokens === null ? null : record.selfReportedTokens === check.tokens;
  } else {
    const check = checkBudget(options.tokenizer, run.stdoutText, step.budget);
    record.stdoutTokens = check.tokens;
    record.tokensApprox = check.approximated;
    record.withinBudget = check.withinBudget;
    if (step.kind === 'context') {
      const stats = parseStats(run.stderrText);
      record.selfReportedTokens = stats?.outputTokens ?? null;
      record.selfReportMatches = stats?.outputTokens === undefined ? null : stats.outputTokens === check.tokens;
    }
  }

  if (step.kind === 'context') {
    record.header = parseContextHeader(packText);
    const pack = parsePack(packText);
    const frames = await verifyFrames(ctx.repoDir, pack, ctx.listing);
    record.frames = frames.frames;
    record.badPaths = options.redact ? frames.badPaths.map(() => '') : frames.badPaths;
    record.notVerbatim = frames.notVerbatim.length;
    record.receiptsChecked = frames.receiptsChecked;
    record.receiptsMatching = frames.receiptsMatching;
  } else if (step.kind === 'map') {
    record.header = parseMapHeader(packText);
  } else if (step.kind === 'expand') {
    const path = step.args.find(arg => arg.startsWith('--path='))?.slice(7) ?? '';
    record.expand = await verifyExpand(ctx.repoDir, path, run.stdoutText);
  }

  const findings = findSecrets(packText);
  if (findings.length) record.secretFindings = options.redact ? findings.map(f => ({ ...f, match: '', sourcePath: undefined })) : findings;
  const leaked = findLeakedLines(packText, ctx.secretLines);
  if (leaked.length) {
    record.secretLineLeaks = [];
    for (const line of leaked.slice(0, 20)) {
      record.secretLineLeaks.push({ line: options.redact ? '' : line.slice(0, 160), duplicatedElsewhere: await duplicatedElsewhere(ctx.repoDir, line, ctx.duplicates) });
    }
  }
  return record;
}
