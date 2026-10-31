// Runs per-file indexing (parsing + term rows) inline or on worker threads.
//
// Parsing is CPU-bound and single-threaded (WebAssembly), so a cold index of a large repository is spread over a few
// worker threads. Workers are only started once a job is big enough to pay for them, are memory-limited, and a worker
// that crashes, runs out of memory or hangs on a hostile file costs that file its structural chunks (line windows
// remain), never the whole run.
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { indexFile, windowParse, type FileIndexResult } from './file-indexer.js';
import type { WorkerRequest, WorkerResponse } from './index-worker.js';

export interface FileIndexer {
  index(path: string, text: string): Promise<FileIndexResult>;
  close(): Promise<void>;
}

const WORKER_LIMITS = { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32 };
const TASK_TIMEOUT_MS = 60_000;
const MAX_WORKER_FAILURES = 8;
// Starting a worker costs on the order of 100 ms (isolate, WebAssembly, grammars): small jobs stay on the main thread.
const INLINE_FILES = 12, INLINE_BYTES = 512 * 1024;

/** Location of the bundled worker script next to the running bundle (or REPOSQUEEZE_WORKER_FILE), if there is one. */
export function workerScript(): string | undefined {
  const override = process.env.REPOSQUEEZE_WORKER_FILE;
  if (override) return existsSync(override) ? override : undefined;
  if (typeof __filename === 'string') {
    const candidate = join(dirname(__filename), 'index-worker.cjs');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** REPOSQUEEZE_WORKERS=0 turns worker threads off; the default is up to 4, always leaving one core to the main thread. */
export function workerCount(): number {
  const setting = process.env.REPOSQUEEZE_WORKERS;
  if (setting) {
    const count = Number(setting);
    if (Number.isInteger(count) && count >= 0 && count <= 16) return count;
  }
  return Math.max(0, Math.min(4, availableParallelism() - 1));
}

class WorkerFailure extends Error {}

interface Task { id: number; path: string; text: string; resolve: (result: FileIndexResult) => void; reject: (error: Error) => void }
interface Slot { worker: Worker; task?: Task; timer?: NodeJS.Timeout }

class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private nextId = 1;
  private failures = 0;
  private closed = false;
  unusable = false;

  constructor(private readonly script: string, count: number) {
    for (let i = 0; i < count; i++) this.spawn();
  }

  private spawn(): void {
    const worker = new Worker(this.script, { resourceLimits: WORKER_LIMITS });
    worker.unref();
    const slot: Slot = { worker };
    worker.on('message', (response: WorkerResponse) => {
      const task = slot.task;
      if (!task || task.id !== response.id) return;
      this.release(slot);
      if ('error' in response) task.reject(new Error(response.error)); else task.resolve(response.result);
      this.pump();
    });
    const died = (error: Error) => {
      const index = this.slots.indexOf(slot);
      if (index < 0) return;
      this.slots.splice(index, 1);
      const task = slot.task;
      this.release(slot);
      task?.reject(new WorkerFailure(error.message));
      if (this.closed) return;
      if (++this.failures > MAX_WORKER_FAILURES) this.fail(); else this.spawn();
      this.pump();
    };
    worker.on('error', died);
    worker.on('exit', code => died(new Error(`worker exited with code ${code}`)));
    this.slots.push(slot);
  }

  private release(slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.task = undefined;
  }

  /** Too many crashes: reject everything still queued so callers fall back, and stop accepting work. */
  private fail(): void {
    this.unusable = true;
    for (const task of this.queue.splice(0)) task.reject(new WorkerFailure('worker pool is unusable'));
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.task || !this.queue.length) continue;
      const task = this.queue.shift()!;
      slot.task = task;
      slot.timer = setTimeout(() => { void slot.worker.terminate(); }, TASK_TIMEOUT_MS);
      slot.timer.unref();
      slot.worker.postMessage({ id: task.id, path: task.path, text: task.text } satisfies WorkerRequest);
    }
  }

  index(path: string, text: string): Promise<FileIndexResult> {
    if (this.unusable) return Promise.reject(new WorkerFailure('worker pool is unusable'));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, path, text, resolve, reject });
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.queue.splice(0)) task.reject(new WorkerFailure('worker pool closed'));
    await Promise.all(this.slots.map(slot => slot.worker.terminate()));
    this.slots.length = 0;
  }
}

/** Indexes inline until the job proves large, then on worker threads (when a worker script and cores are available). */
export class AdaptiveIndexer implements FileIndexer {
  private pool?: WorkerPool;
  private inlineFiles = 0;
  private inlineBytes = 0;
  /** Files whose structural parse was abandoned (worker crash, out of memory, timeout). */
  degraded = 0;

  constructor(private readonly script = workerScript(), private readonly count = workerCount()) {}

  get usesWorkers(): boolean { return !!this.pool && !this.pool.unusable; }

  async index(path: string, text: string): Promise<FileIndexResult> {
    if (!this.pool && this.script && this.count > 0 && (this.inlineFiles >= INLINE_FILES || this.inlineBytes >= INLINE_BYTES)) {
      try { this.pool = new WorkerPool(this.script, this.count); } catch { this.pool = undefined; this.inlineBytes = -Infinity; }
    }
    if (this.pool && !this.pool.unusable) {
      try {
        return await this.pool.index(path, text);
      } catch (error) {
        if (!(error instanceof WorkerFailure)) throw error;
        this.degraded++;
        return indexFile(path, text, windowParse);
      }
    }
    this.inlineFiles++;
    this.inlineBytes += text.length;
    return indexFile(path, text);
  }

  async close(): Promise<void> {
    await this.pool?.close();
    this.pool = undefined;
  }
}
