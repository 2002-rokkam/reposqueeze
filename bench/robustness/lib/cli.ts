import { createHash } from 'node:crypto';
import { runProcess, type RunResult } from './proc.js';
import { cliPath, type Variant } from './variants.js';

export type Outcome = 'ok' | 'clean-error' | 'crash' | 'timeout' | 'overflow' | 'memory-limit' | 'spawn-error';

export interface CliRun extends RunResult {
  outcome: Outcome;
  stdoutText: string;
  stderrText: string;
  /** SHA-256 of stdout, for determinism comparisons. */
  stdoutSha: string;
  /** Short reason for non-ok outcomes. */
  detail: string;
}

export interface CliCall {
  variant: Variant;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  scratchDir: string;
  maxOutputBytes?: number;
  maxRssBytes?: number;
  maxWallMs?: number;
  burst?: boolean;
}

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

const STACK_FRAME = /\n\s+at\s+\S.*[(:]\d+:\d+\)?/;
const FATAL = /FATAL ERROR|Segmentation fault|heap out of memory|JavaScript heap|Allocation failed|UnhandledPromiseRejection|Aborted|core dumped/i;

/** Classifies how a process ended. A crash is anything other than success or a short, deliberate error message. */
export function classify(run: RunResult, stderrText: string): { outcome: Outcome; detail: string } {
  if (run.spawnError) return { outcome: 'spawn-error', detail: run.spawnError };
  if (run.memoryLimitExceeded) return { outcome: 'memory-limit', detail: 'resident set exceeded the guard limit' };
  if (run.timedOut) return { outcome: 'timeout', detail: `hard timeout${run.cpuAtTimeoutSec === undefined ? '' : ` (${run.cpuAtTimeoutSec.toFixed(0)} s CPU used)`}` };
  if (run.outputOverflow) return { outcome: 'overflow', detail: 'output exceeded the capture cap' };
  if (run.killedBySignal) return { outcome: 'crash', detail: 'terminated by a signal' };
  if (FATAL.test(stderrText)) return { outcome: 'crash', detail: 'fatal runtime error' };
  if (run.exitCode === 0) return { outcome: 'ok', detail: '' };
  if (STACK_FRAME.test(stderrText) && !/^RepoSqueeze V2:/m.test(stderrText)) return { outcome: 'crash', detail: 'uncaught exception with stack trace' };
  if (run.exitCode === 1 || run.exitCode === 2) {
    const first = stderrText.trim().split('\n')[0] ?? '';
    return { outcome: 'clean-error', detail: first.slice(0, 200) };
  }
  return { outcome: 'crash', detail: `unexpected exit code ${run.exitCode}` };
}

export async function runCli(call: CliCall): Promise<CliRun> {
  const run = await runProcess({
    command: process.execPath,
    args: [cliPath(call.variant), ...call.args],
    cwd: call.cwd,
    env: { ...call.variant.env, ...call.env },
    stdin: call.stdin,
    timeoutMs: call.timeoutMs,
    maxOutputBytes: call.maxOutputBytes,
    maxRssBytes: call.maxRssBytes,
    maxWallMs: call.maxWallMs,
    burst: call.burst,
    scratchDir: call.scratchDir,
  });
  const stderrText = run.stderr.toString('utf8');
  const { outcome, detail } = classify(run, stderrText);
  return { ...run, outcome, detail, stdoutText: run.stdout.toString('utf8'), stderrText, stdoutSha: sha256(run.stdout) };
}

/** Argument builders. Values use the `--key=value` form so that values starting with "-" are never mistaken for options. */
export const args = {
  context: (root: string, query: string, budget: number | string, json = false): string[] => ['context', `--root=${root}`, `--query=${query}`, `--budget=${budget}`, ...(json ? ['--json'] : [])],
  map: (root: string, budget: number | string): string[] => ['map', `--root=${root}`, `--budget=${budget}`],
  expand: (root: string, path: string, start: number | string, end: number | string, budget?: number | string): string[] => [
    'expand',
    `--root=${root}`,
    `--path=${path}`,
    `--start=${start}`,
    `--end=${end}`,
    ...(budget === undefined ? [] : [`--budget=${budget}`]),
  ],
  compact: (budget: number | string): string[] => ['compact', `--budget=${budget}`],
  json: (): string[] => ['json'],
};

export type { RunResult };
