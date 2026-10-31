import type { CliRun } from '../lib/cli.js';
import type { FileSpec } from '../lib/fixtures.js';
import type { McpSession } from '../lib/mcp.js';
import type { Tokenizer } from '../lib/tokens.js';
import type { Variant } from '../lib/variants.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low';
/** pass: invariant holds; warn: holds but a weakness is worth reporting; fail: invariant violated; error: the test itself broke; skip: not applicable. */
export type Status = 'pass' | 'warn' | 'fail' | 'error' | 'skip';

export interface Verdict {
  status: Status;
  note: string;
}

export const pass = (note = ''): Verdict => ({ status: 'pass', note });
export const warn = (note: string): Verdict => ({ status: 'warn', note });
export const fail = (note: string): Verdict => ({ status: 'fail', note });
export const skip = (note: string): Verdict => ({ status: 'skip', note });

export interface Metrics {
  runs: number;
  maxWallMs: number;
  maxRssMiB: number;
  cpuSec: number;
  exitCode: number | null;
  load1: number;
}

export interface CliOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  /** Skip the heavy-process slot cap (the load back-off still applies). Used only by the concurrency burst. */
  burst?: boolean;
}

export interface Ctx {
  variant: Variant;
  /** Fresh scratch directory owned by the current group. */
  dir: string;
  timeoutMs: number;
  tokenizer: Tokenizer;
  metrics: Metrics;
  log(line: string): void;
  cli(argv: string[], options?: CliOptions): Promise<CliRun>;
  mcp(root: string, options?: { env?: Record<string, string> }): Promise<McpSession>;
  /** Writes `files` below dir/name, optionally as a committed git repository, and returns its path. */
  makeRepo(name: string, files: FileSpec, options?: { git?: boolean }): Promise<string>;
  /** Environment for the variant with cache directories redirected into the group's scratch dir. */
  cacheEnv(name: string): { env: Record<string, string>; cacheDirs: string[] };
}

export interface Check<S> {
  id: string;
  title: string;
  /** Severity assigned when the check fails. */
  severity: Severity;
  run(state: S, ctx: Ctx): Promise<Verdict> | Verdict;
}

export interface Group<S = unknown> {
  id: string;
  category: string;
  title: string;
  /** Groups that build very large fixtures or need minutes; selectable with --skip-slow. */
  slow?: boolean;
  setup(ctx: Ctx): Promise<S>;
  checks: Check<S>[];
}

export interface CaseResult {
  id: string;
  group: string;
  category: string;
  title: string;
  severity: Severity;
  variant: string;
  status: Status;
  note: string;
  exitCode: number | null;
  wallMs: number;
  cpuSec: number;
  rssMiB: number;
  runs: number;
  load1: number;
}

/** Convenience for the many "one command, one check" groups. */
export function single(id: string, category: string, title: string, severity: Severity, body: (ctx: Ctx) => Promise<Verdict>): Group<Verdict> {
  return {
    id,
    category,
    title,
    setup: body,
    checks: [{ id, title, severity, run: verdict => verdict }],
  };
}

/** Short human note for a finished run: outcome, exit code, time and resident set. */
export function describeRun(run: CliRun): string {
  const cpu = run.userSec !== undefined && run.sysSec !== undefined ? `, cpu ${(run.userSec + run.sysSec).toFixed(1)}s` : '';
  const rss = run.rssBytes === undefined ? '' : `, rss ${(run.rssBytes / 1048576).toFixed(0)} MiB`;
  return `${run.outcome} (exit ${run.exitCode}, ${(run.wallMs / 1000).toFixed(1)}s wall${cpu}${rss})${run.detail ? `: ${run.detail}` : ''}`;
}
