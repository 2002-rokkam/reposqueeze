/**
 * Child-process entry point: loads one variant's `src/engine.ts`, answers one query on one
 * repository checkout and reports the pack back over IPC. One process per (variant, task) means
 * variants never share module state and peak RSS is attributable to a single query.
 */
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getEncoding } from 'js-tiktoken';
import { normalizePath } from './metrics.js';

export interface TaskMessage {
  type: 'task';
  variantRoot: string;
  repoRoot: string;
  query: string;
  budget: number;
}

export interface WorkerResult {
  type: 'result';
  ok: true;
  /** Wall time of engine.context() only (excludes process start-up and module loading). */
  ms: number;
  /** User+system CPU time of the worker process during engine.context(); robust against machine load (child helpers such as rg are not included). */
  cpuMs: number;
  rssMB: number;
  /** RSS after loading the engine, before the query: the fixed overhead of the process. */
  rssBaseMB: number;
  /** o200k_base tokens of pack.text, counted here independently of what the engine reports. */
  tokens: number;
  text: string;
  evidence: { path: string; start: number; end: number; id?: string; kind?: string }[];
  stats: Record<string, unknown>;
}

export interface WorkerFailure {
  type: 'result';
  ok: false;
  error: string;
}

const encoder = getEncoding('o200k_base');
const countTokens = (text: string) => encoder.encode(text, [], []).length;

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(1, 6).join('\n')}`.slice(0, 2000);
  return String(error).slice(0, 2000);
}

function repoRelative(path: string, root: string): string {
  if (!isAbsolute(path)) return normalizePath(path);
  const rel = relative(root, path);
  return rel.startsWith('..') ? path : normalizePath(rel.split(sep).join('/'));
}

function jsonSafe(value: unknown): Record<string, unknown> {
  try {
    const text = JSON.stringify(value ?? {});
    return text.length <= 20_000 ? (JSON.parse(text) as Record<string, unknown>) : { truncated: true };
  } catch {
    return {};
  }
}

async function execute(task: TaskMessage): Promise<WorkerResult> {
  const module = (await import(pathToFileURL(join(task.variantRoot, 'src', 'engine.ts')).href)) as { Engine?: new (root: string) => { context(query: string, budget: number): Promise<unknown> } };
  if (typeof module.Engine !== 'function') throw new Error('src/engine.ts does not export a class named Engine');
  const engine = new module.Engine(task.repoRoot);
  const rssBaseMB = process.memoryUsage().rss / 2 ** 20;
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  const pack = (await engine.context(task.query, task.budget)) as { text?: unknown; evidence?: unknown; stats?: unknown } | undefined;
  const ms = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  if (!pack || typeof pack.text !== 'string') throw new Error('engine.context() did not return a pack with a text field');
  if (!Array.isArray(pack.evidence)) throw new Error('engine.context() did not return pack.evidence');
  const evidence = pack.evidence.map((item: { path?: unknown; start?: unknown; end?: unknown; id?: unknown; kind?: unknown }) => ({
    path: repoRelative(String(item.path ?? ''), task.repoRoot),
    start: Number(item.start),
    end: Number(item.end),
    ...(typeof item.id === 'string' ? { id: item.id } : {}),
    ...(typeof item.kind === 'string' ? { kind: item.kind } : {}),
  }));
  return {
    type: 'result',
    ok: true,
    ms,
    cpuMs: (cpu.user + cpu.system) / 1000,
    rssMB: process.resourceUsage().maxRSS / 1024,
    rssBaseMB,
    tokens: countTokens(pack.text),
    text: pack.text,
    evidence,
    stats: jsonSafe(pack.stats),
  };
}

process.on('disconnect', () => process.exit(2)); // never outlive the runner
process.on('message', (message: TaskMessage) => {
  if (message?.type !== 'task') return;
  execute(message)
    .catch((error): WorkerFailure => ({ type: 'result', ok: false, error: describe(error) }))
    .then(result => process.send?.(result, () => process.exit(result.ok ? 0 : 1)));
});
process.send?.({ type: 'ready' });
