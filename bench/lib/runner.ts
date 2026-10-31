import { fork, type ChildProcess } from 'node:child_process';
import { WORKER_PATH } from './paths.js';
import type { TaskMessage, WorkerFailure, WorkerResult } from './worker.js';

export interface ChildRunOptions {
  variantRoot: string;
  repoRoot: string;
  query: string;
  budget: number;
  env: Record<string, string>;
  timeoutMs: number;
  /** V8 old-space cap for the child in MiB (0 or undefined = Node default). */
  maxOldSpaceMB?: number;
  /** Override the worker entry point (tests only). */
  workerPath?: string;
}

export type ChildOutcome =
  | { status: 'ok'; wallMs: number; result: WorkerResult }
  | { status: 'timeout' | 'error'; wallMs: number; error: string; stderrTail: string };

const live = new Set<ChildProcess>();

/** Kills the whole process group of a child (an engine may spawn helpers such as rg or git). */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

export function killAllChildren(): void {
  for (const child of live) killGroup(child);
}

process.on('exit', killAllChildren);

let tsxLoader: string | undefined;
function tsxUrl(): string {
  tsxLoader ??= import.meta.resolve('tsx');
  return tsxLoader;
}

const TAIL_CHARS = 6000;
const tail = (chunks: string[]) => chunks.join('').slice(-TAIL_CHARS);

/** Runs one query in a fresh child process with a hard timeout. Never rejects. */
export function runInChild(options: ChildRunOptions): Promise<ChildOutcome> {
  return new Promise(resolve => {
    const started = performance.now();
    const execArgv = ['--import', tsxUrl()];
    if (options.maxOldSpaceMB) execArgv.push(`--max-old-space-size=${options.maxOldSpaceMB}`);
    const child = fork(options.workerPath ?? WORKER_PATH, [], {
      cwd: options.variantRoot,
      env: { ...process.env, TSX_DISABLE_CACHE: '1', ...options.env },
      execArgv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: true, // own process group, so the kill below reaches grandchildren
    });
    live.add(child);
    const stderr: string[] = [];
    const stdout: string[] = [];
    const keep = (buffer: string[]) => (chunk: Buffer) => {
      buffer.push(String(chunk));
      if (buffer.length > 200) buffer.splice(0, 100);
    };
    child.stderr?.on('data', keep(stderr));
    child.stdout?.on('data', keep(stdout));

    let message: WorkerResult | WorkerFailure | undefined;
    let timedOut = false;
    let settled = false;
    let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let disconnected = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, options.timeoutMs);

    const finish = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.delete(child);
      killGroup(child); // reap any helper the engine left running
      resolve(outcome);
    };

    // IPC messages are always delivered before 'disconnect', but 'close' can overtake them.
    const decide = () => {
      if (settled || !closed) return;
      const wallMs = performance.now() - started;
      const stderrTail = tail(stderr) || tail(stdout);
      if (message?.ok) finish({ status: 'ok', wallMs, result: message });
      else if (timedOut) finish({ status: 'timeout', wallMs, error: `timed out after ${options.timeoutMs} ms`, stderrTail });
      else if (message && !message.ok) finish({ status: 'error', wallMs, error: message.error, stderrTail });
      else finish({ status: 'error', wallMs, error: `worker exited without a result (code ${closed.code}, signal ${closed.signal})`, stderrTail });
    };

    child.on('message', (incoming: WorkerResult | WorkerFailure | { type: 'ready' }) => {
      if (incoming.type === 'ready') {
        const task: TaskMessage = { type: 'task', variantRoot: options.variantRoot, repoRoot: options.repoRoot, query: options.query, budget: options.budget };
        child.send(task);
      } else {
        message = incoming;
        setTimeout(() => killGroup(child), 3000).unref(); // the worker exits by itself; this frees pipes held by stragglers
      }
    });
    child.on('exit', () => setTimeout(() => killGroup(child), 1000).unref());
    child.on('disconnect', () => {
      disconnected = true;
      decide();
    });
    child.on('error', error => finish({ status: 'error', wallMs: performance.now() - started, error: `failed to start worker: ${error.message}`, stderrTail: tail(stderr) }));
    child.on('close', (code, signal) => {
      closed = { code, signal };
      if (disconnected || !child.connected) decide();
      else setTimeout(decide, 2000).unref();
    });
  });
}
