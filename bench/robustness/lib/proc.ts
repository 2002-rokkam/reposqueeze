import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { enterHeavy } from './throttle.js';

export interface RunOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Merged over process.env. An undefined value removes the variable. */
  env?: Record<string, string | undefined>;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  /** Per-stream cap on retained bytes. Exceeding it kills the process (a runaway writer is a failure). */
  maxOutputBytes?: number;
  /** Wrap in /usr/bin/time to obtain peak RSS. Defaults to true when available. */
  measure?: boolean;
  /** Directory for the time(1) report files and TMPDIR. Must not be the system temp dir. */
  scratchDir: string;
  /**
   * The machine may be shared and oversubscribed. When the deadline passes while the process has used
   * under 35% of the elapsed wall time as CPU, the deadline is extended in 60 s steps up to maxWallMs
   * (default 3x timeoutMs) so contention is not reported as a hang.
   */
  maxWallMs?: number;
  /** Kill the process when its resident set exceeds this many bytes (guards the shared machine). */
  maxRssBytes?: number;
  /** Do not take a heavy-process slot (the load back-off still applies); only for deliberate concurrency bursts. */
  burst?: boolean;
}

export interface RunResult {
  command: string;
  args: string[];
  /** Exit status of the measured command; 1 when it died from a signal (see killedBySignal). */
  exitCode: number | null;
  /** True when the child was terminated by a signal that we did not send ourselves. */
  killedBySignal: boolean;
  timedOut: boolean;
  /** Number of 60 s deadline extensions granted because the process was CPU-starved. */
  starvationExtensions: number;
  /** CPU seconds consumed when the deadline finally fired (timeouts only). */
  cpuAtTimeoutSec?: number;
  /** True when the process was killed for exceeding RunOptions.maxRssBytes. */
  memoryLimitExceeded: boolean;
  outputOverflow: boolean;
  spawnError?: string;
  wallMs: number;
  /** 1-minute load average when the process started. */
  load1: number;
  realSec?: number;
  userSec?: number;
  sysSec?: number;
  rssBytes?: number;
  stdout: Buffer;
  stderr: Buffer;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface TimeReport {
  realSec?: number;
  userSec?: number;
  sysSec?: number;
  rssBytes?: number;
}

/** Parses `/usr/bin/time -l` (BSD/macOS) and `/usr/bin/time -v` (GNU) reports. Unknown formats yield an empty report. */
export function parseTimeReport(text: string): TimeReport {
  const report: TimeReport = {};
  const bsd = /^\s*([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/m.exec(text);
  if (bsd) {
    report.realSec = Number(bsd[1]);
    report.userSec = Number(bsd[2]);
    report.sysSec = Number(bsd[3]);
  }
  const bsdRss = /^\s*(\d+)\s+maximum resident set size/m.exec(text);
  if (bsdRss) report.rssBytes = Number(bsdRss[1]);
  const gnuRss = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(text);
  if (gnuRss) report.rssBytes = Number(gnuRss[1]) * 1024;
  const gnuUser = /User time \(seconds\):\s*([\d.]+)/.exec(text);
  if (gnuUser) report.userSec = Number(gnuUser[1]);
  const gnuSys = /System time \(seconds\):\s*([\d.]+)/.exec(text);
  if (gnuSys) report.sysSec = Number(gnuSys[1]);
  const gnuWall = /Elapsed \(wall clock\) time \(h:mm:ss or m:ss\):\s*(?:(\d+):)?(\d+):([\d.]+)/.exec(text);
  if (gnuWall) report.realSec = Number(gnuWall[1] ?? 0) * 3600 + Number(gnuWall[2]) * 60 + Number(gnuWall[3]);
  return report;
}

const TIME_BIN = '/usr/bin/time';
// BSD time(1) cannot report which signal ended the child; it prints this marker and exits with 1.
const SIGNAL_MARKER = /^time: command terminated abnormally\n(?:time: signal: [^\n]*\n)?/m;

function timeFlags(): string[] | undefined {
  if (!existsSync(TIME_BIN)) return undefined;
  if (process.platform === 'darwin') return ['-l'];
  if (process.platform === 'linux') return ['-v'];
  return undefined;
}

function childPids(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map(Number)
      .filter(Number.isInteger);
  } catch {
    return [];
  }
}

/** Parses `ps -o cputime` output ("0:03.31", "12:34.56", "1:02:03.00", "2-03:04:05") into seconds. */
export function parseCpuTime(value: string): number | null {
  const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!match) return null;
  return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4]);
}

function cpuSeconds(pids: readonly number[]): number | null {
  let total = 0;
  let known = false;
  for (const pid of pids) {
    try {
      const parsed = parseCpuTime(execFileSync('ps', ['-o', 'cputime=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
      if (parsed !== null) {
        total += parsed;
        known = true;
      }
    } catch {
      /* process vanished */
    }
  }
  return known ? total : null;
}

function residentBytes(pids: readonly number[]): number {
  let total = 0;
  for (const pid of pids) {
    try {
      const kib = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
      if (Number.isFinite(kib)) total += kib * 1024;
    } catch {
      /* process vanished */
    }
  }
  return total;
}

const STARVED_RATIO = 0.35;
const EXTENSION_MS = 60_000;

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    /* already gone */
  }
}

let counter = 0;

/**
 * Runs a command with a hard timeout and returns wall time, exit status, peak RSS and captured output.
 * On timeout only the measured process is killed first so that time(1) can still report its peak RSS;
 * the whole process group is swept afterwards so no orphan (for example a git child) survives.
 */
export async function runProcess(options: RunOptions): Promise<RunResult> {
  const release = await enterHeavy({ slot: !options.burst });
  try {
    return await execute(options);
  } finally {
    await release();
  }
}

async function execute(options: RunOptions): Promise<RunResult> {
  const args = [...(options.args ?? [])];
  const timeoutMs = options.timeoutMs ?? 300_000;
  const cap = options.maxOutputBytes ?? 64 * 1024 * 1024;
  const flags = options.measure === false ? undefined : timeFlags();
  await mkdir(options.scratchDir, { recursive: true });
  const reportFile = flags ? join(options.scratchDir, `time-${process.pid}-${counter++}.txt`) : undefined;
  const command = flags ? TIME_BIN : options.command;
  const argv = flags ? [...flags, '-o', reportFile!, options.command, ...args] : args;

  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', TMPDIR: options.scratchDir };
  delete env.NODE_OPTIONS;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const started = performance.now();
  const maxWallMs = options.maxWallMs ?? timeoutMs * 3;
  const result: RunResult = {
    command: options.command,
    args,
    exitCode: null,
    killedBySignal: false,
    timedOut: false,
    starvationExtensions: 0,
    memoryLimitExceeded: false,
    outputOverflow: false,
    load1: loadavg()[0],
    wallMs: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutBytes: 0,
    stderrBytes: 0,
  };

  await new Promise<void>(resolveRun => {
    const child = spawn(command, argv, {
      cwd: options.cwd,
      env,
      detached: true,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
    const kept = { stdout: 0, stderr: 0 };
    let finished = false;
    let hardKill: NodeJS.Timeout | undefined;
    let exitSignal: NodeJS.Signals | null = null;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;

    const terminate = () => {
      if (pid === undefined) return;
      const targets = flags ? childPids(pid) : [];
      if (targets.length) targets.forEach(target => signal(target, 'SIGKILL'));
      else signal(pid, 'SIGKILL');
      hardKill = setTimeout(() => signal(-pid, 'SIGKILL'), 3000);
    };

    const capture = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      result[`${stream}Bytes`] += chunk.length;
      const room = cap - kept[stream];
      if (room > 0) {
        const piece = chunk.length <= room ? chunk : chunk.subarray(0, room);
        chunks[stream].push(piece);
        kept[stream] += piece.length;
      }
      if (chunk.length > room && !result.outputOverflow) {
        result.outputOverflow = true;
        terminate();
      }
    };
    child.stdout!.on('data', capture('stdout'));
    child.stderr!.on('data', capture('stderr'));

    const finish = () => {
      if (finished) return;
      finished = true;
      for (const handle of [timer, hardKill, grace]) if (handle) clearTimeout(handle);
      if (rssPoll) clearInterval(rssPoll);
      if (pid !== undefined) signal(-pid, 'SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      result.stdout = Buffer.concat(chunks.stdout);
      result.stderr = Buffer.concat(chunks.stderr);
      if (exitSignal && !result.timedOut && !result.outputOverflow) result.killedBySignal = true;
      resolveRun();
    };

    child.on('error', error => {
      result.spawnError = error.message;
      finish();
    });
    if (options.stdin !== undefined) {
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(options.stdin);
    }

    const onDeadline = () => {
      const elapsed = performance.now() - started;
      const targets = pid === undefined ? [] : flags ? childPids(pid) : [pid];
      const cpu = cpuSeconds(targets);
      const starved = cpu !== null && cpu * 1000 < STARVED_RATIO * elapsed;
      if (starved && elapsed + EXTENSION_MS <= maxWallMs) {
        result.starvationExtensions++;
        timer = setTimeout(onDeadline, EXTENSION_MS);
        return;
      }
      if (cpu !== null) result.cpuAtTimeoutSec = cpu;
      result.timedOut = true;
      terminate();
    };
    timer = setTimeout(onDeadline, timeoutMs);
    let rssPoll: NodeJS.Timeout | undefined;
    if (options.maxRssBytes && pid !== undefined) {
      rssPoll = setInterval(() => {
        if (finished || result.memoryLimitExceeded) return;
        if (residentBytes(flags ? childPids(pid) : [pid]) > options.maxRssBytes!) {
          result.memoryLimitExceeded = true;
          terminate();
        }
      }, 1000);
    }

    child.on('exit', (code, sig) => {
      result.exitCode = code ?? (sig ? 1 : null);
      exitSignal = sig;
      // A grandchild may keep the pipes open; do not wait for it indefinitely.
      grace = setTimeout(finish, 2000);
    });
    child.on('close', finish);
  });

  result.wallMs = performance.now() - started;
  if (reportFile) {
    try {
      Object.assign(result, parseTimeReport(await readFile(reportFile, 'utf8')));
    } catch {
      /* the wrapper itself failed to start: no report */
    } finally {
      await rm(reportFile, { force: true });
    }
  }
  const stderr = result.stderr.toString('utf8');
  if (SIGNAL_MARKER.test(stderr)) {
    if (!result.timedOut && !result.outputOverflow) result.killedBySignal = true;
    result.stderr = Buffer.from(stderr.replace(SIGNAL_MARKER, ''), 'utf8');
  }
  return result;
}
