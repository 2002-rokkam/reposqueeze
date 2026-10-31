import { parseArgs } from 'node:util';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliRun } from './lib/cli.js';
import { freshDir, gitInit, makeWritable, writeTree } from './lib/fixtures.js';
import { openMcpSession, type McpSession } from './lib/mcp.js';
import { DEFAULT_RESULTS_DIR, LAB, SCRATCH_ROOT } from './lib/paths.js';
import { removeSynthetic } from './lib/synthetic.js';
import { configureThrottle, enterHeavy } from './lib/throttle.js';
import { loadTokenizer } from './lib/tokens.js';
import { resolveVariants, type Variant } from './lib/variants.js';
import { environmentGroups } from './adversarial/environment.js';
import { injectionGroup } from './adversarial/injection.js';
import { inputGroups } from './adversarial/inputs.js';
import { limitsGroups } from './adversarial/limits.js';
import { pathsGroup } from './adversarial/paths.js';
import { secretsGroup } from './adversarial/secrets.js';
import type { CaseResult, CliOptions, Ctx, Group, Metrics, Verdict } from './adversarial/types.js';

const ALL_GROUPS: Group<any>[] = [secretsGroup, injectionGroup, pathsGroup, ...limitsGroups, ...environmentGroups, ...inputGroups];

const HELP = `Adversarial suite: synthetic hostile fixtures run against every variant (CLI and MCP).

  --variant name=path[:ENV=VAL,...]  variant to test (repeatable). Default: baseline=~/reposqueeze-lab/baseline
  --results DIR      result directory (default ~/reposqueeze-lab/results/bench-robust); writes <variant>/adversarial.json
  --only a,b         run only groups/categories/checks whose id contains one of these
  --skip-slow        skip groups that build very large fixtures (100,050-file repositories)
  --timeout S        hard wall timeout per command in seconds (default 300; hang probes use 120)
  --max-load L       back off while the 1-minute load average is above L (default 40)
  --max-wait-min M   stop backing off after M minutes and continue one process at a time (default 10)
  --keep             keep per-group scratch directories
  --cleanup          remove generated synthetic repositories when done
  --list             list groups and checks, then exit`;

const { values } = parseArgs({
  options: {
    variant: { type: 'string', multiple: true },
    results: { type: 'string', default: DEFAULT_RESULTS_DIR },
    only: { type: 'string' },
    'skip-slow': { type: 'boolean', default: false },
    timeout: { type: 'string', default: '300' },
    'max-load': { type: 'string', default: '40' },
    'max-wait-min': { type: 'string', default: '10' },
    keep: { type: 'boolean', default: false },
    cleanup: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (values.list) {
  for (const group of ALL_GROUPS) {
    console.log(`${group.slow ? '[slow] ' : ''}${group.id} — ${group.title}`);
    for (const check of group.checks) console.log(`    ${check.id}  (${check.severity})`);
  }
  process.exit(0);
}

const { variants, skipped } = resolveVariants(values.variant);
for (const entry of skipped) console.error(`SKIPPED ${entry.reason}`);
if (!variants.length) {
  console.error('No runnable variant. Build the variant (npm run build) or pass --variant name=path.');
  process.exit(2);
}

const log = (line: string) => console.log(line);
configureThrottle({ maxProcs: 2, maxLoad: Number(values['max-load']), maxWaitMs: Number(values['max-wait-min']) * 60_000, log: line => log(`[throttle] ${line}`) });
const timeoutMs = Number(values.timeout) * 1000;
const filters = values.only?.split(',').map(item => item.trim().toLowerCase()).filter(Boolean) ?? [];
const selected = ALL_GROUPS.filter(group => {
  if (values['skip-slow'] && group.slow) return false;
  if (!filters.length) return true;
  return filters.some(filter => group.id.toLowerCase().includes(filter) || group.category.toLowerCase().includes(filter) || group.checks.some(check => check.id.toLowerCase().includes(filter)));
});

/** REPOSQUEEZE_CACHE_DIR, when configured inside the lab, is split per group so persistent indexes never leak between tests. */
function groupEnv(variant: Variant, scope: string): Record<string, string> {
  const env = { ...variant.env };
  const base = env.REPOSQUEEZE_CACHE_DIR;
  if (base && base.startsWith(`${LAB}/`)) env.REPOSQUEEZE_CACHE_DIR = join(base, scope);
  return env;
}

function makeContext(variant: Variant, group: Group<any>, dir: string, scratchDir: string, sessions: Set<McpSession>): Ctx {
  const tokenizer = loadTokenizer(variant.root);
  const metrics: Metrics = { runs: 0, maxWallMs: 0, maxRssMiB: 0, cpuSec: 0, exitCode: null, load1: 0 };
  const scope = group.id.replace(/[^A-Za-z0-9]+/g, '-');
  const record = (run: CliRun) => {
    metrics.runs++;
    metrics.maxWallMs = Math.max(metrics.maxWallMs, run.wallMs);
    metrics.maxRssMiB = Math.max(metrics.maxRssMiB, (run.rssBytes ?? 0) / 1048576);
    metrics.cpuSec += (run.userSec ?? 0) + (run.sysSec ?? 0);
    metrics.exitCode = run.exitCode;
    metrics.load1 = Math.max(metrics.load1, run.load1);
  };
  const ctx: Ctx = {
    variant,
    dir,
    timeoutMs,
    tokenizer,
    metrics,
    log,
    async cli(argv: string[], options: CliOptions = {}) {
      const run = await runCli({
        variant: { ...variant, env: groupEnv(variant, scope) },
        args: argv,
        cwd: options.cwd,
        env: options.env,
        stdin: options.stdin,
        timeoutMs: options.timeoutMs ?? timeoutMs,
        scratchDir,
        maxRssBytes: 6 * 1024 ** 3,
        burst: options.burst,
      });
      record(run);
      return run;
    },
    async mcp(root: string, options: { env?: Record<string, string> } = {}) {
      const release = await enterHeavy();
      let session: McpSession;
      try {
        session = await openMcpSession({ ...variant, env: groupEnv(variant, scope) }, root, { env: options.env, scratchDir, timeoutMs });
      } catch (error) {
        await release();
        throw error;
      }
      sessions.add(session);
      metrics.runs++;
      let closed = false;
      return {
        ...session,
        call: async (name, args, timeout) => {
          const started = performance.now();
          try {
            return await session.call(name, args, timeout);
          } finally {
            metrics.maxWallMs = Math.max(metrics.maxWallMs, performance.now() - started);
            metrics.maxRssMiB = Math.max(metrics.maxRssMiB, (session.rssKb() ?? 0) / 1024);
          }
        },
        async close() {
          if (closed) return { exited: true };
          closed = true;
          const result = await session.close();
          sessions.delete(session);
          await release();
          return result;
        },
      } satisfies McpSession;
    },
    async makeRepo(name: string, files, options = {}) {
      const root = join(dir, name);
      await mkdir(root, { recursive: true });
      await writeTree(root, files);
      if (options.git) await gitInit(root);
      return root;
    },
    cacheEnv(name: string) {
      const env: Record<string, string> = {};
      const cacheDirs: string[] = [];
      const base = variant.env.REPOSQUEEZE_CACHE_DIR;
      if (base && base.startsWith(`${LAB}/`)) {
        env.REPOSQUEEZE_CACHE_DIR = join(base, scope, name);
        cacheDirs.push(env.REPOSQUEEZE_CACHE_DIR);
      }
      return { env, cacheDirs };
    },
  };
  return ctx;
}

async function runGroup(variant: Variant, group: Group<any>, runId: string): Promise<CaseResult[]> {
  const scope = group.id.replace(/[^A-Za-z0-9]+/g, '-');
  const dir = await freshDir('adv', variant.name, scope);
  const scratchDir = join(SCRATCH_ROOT, runId, scope);
  const sessions = new Set<McpSession>();
  const ctx = makeContext(variant, group, dir, scratchDir, sessions);
  let state: unknown;
  let setupError: string | undefined;
  const started = performance.now();
  try {
    state = await group.setup(ctx);
  } catch (error) {
    setupError = error instanceof Error ? `${error.message}`.slice(0, 200) : String(error);
  }
  for (const session of sessions) await session.close().catch(() => undefined);
  const rows: CaseResult[] = [];
  for (const check of group.checks) {
    let verdict: Verdict;
    if (setupError !== undefined) verdict = { status: 'error', note: `setup failed: ${setupError}` };
    else {
      try {
        verdict = await check.run(state, ctx);
      } catch (error) {
        verdict = { status: 'error', note: `check threw: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}` };
      }
    }
    rows.push({
      id: check.id,
      group: group.id,
      category: group.category,
      title: check.title,
      severity: check.severity,
      variant: variant.name,
      status: verdict.status,
      note: verdict.note.slice(0, 400),
      exitCode: ctx.metrics.exitCode,
      wallMs: Math.round(ctx.metrics.maxWallMs),
      cpuSec: Math.round(ctx.metrics.cpuSec * 10) / 10,
      rssMiB: Math.round(ctx.metrics.maxRssMiB),
      runs: ctx.metrics.runs,
      load1: Math.round(ctx.metrics.load1 * 10) / 10,
    });
  }
  log(`  ${group.id}: ${summarize(rows)} (${((performance.now() - started) / 1000).toFixed(0)}s, ${ctx.metrics.runs} runs)`);
  if (!values.keep) {
    await makeWritable(dir);
    await rm(dir, { recursive: true, force: true });
    await rm(scratchDir, { recursive: true, force: true });
  }
  return rows;
}

function summarize(rows: CaseResult[]): string {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(', ');
}

async function main(): Promise<void> {
  const runId = `adversarial-${process.pid}`;
  log(`adversarial suite: ${selected.length} groups, ${selected.reduce((sum, group) => sum + group.checks.length, 0)} checks, variants ${variants.map(v => v.name).join(', ')}; load ${loadavg()[0].toFixed(0)}`);
  for (const variant of variants) {
    log(`variant ${variant.name}`);
    const started = performance.now();
    const startLoad = loadavg()[0];
    const results: CaseResult[] = [];
    const outDir = join(values.results!, variant.name);
    await mkdir(outDir, { recursive: true });
    const write = async (final: boolean) => {
      const document = {
        schema: 1,
        variant: variant.name,
        variantRoot: variant.root,
        variantEnv: variant.env,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        loadAtStart: Math.round(startLoad * 10) / 10,
        loadAtEnd: Math.round(loadavg()[0] * 10) / 10,
        complete: final,
        durationSec: Math.round((performance.now() - started) / 1000),
        results,
      };
      const target = join(outDir, 'adversarial.json');
      await writeFile(`${target}.tmp`, `${JSON.stringify(document, null, 2)}\n`);
      await rename(`${target}.tmp`, target);
    };
    for (const group of selected) {
      results.push(...(await runGroup(variant, group, runId)));
      await write(false);
    }
    await write(true);
    log(`variant ${variant.name}: ${summarize(results)}`);
  }
  await rm(join(SCRATCH_ROOT, `adversarial-${process.pid}`), { recursive: true, force: true });
  if (values.cleanup) {
    await removeSynthetic({ kind: 'tiny', files: 100_050 });
    await removeSynthetic({ kind: 'code', files: 60_000 });
  }
}

await main();
