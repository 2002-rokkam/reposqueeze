import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { httpGetJson } from './http.js';
import { dataDir } from './paths.js';

export type DatasetKey = 'lite' | 'multilingual' | 'verified';

export interface DatasetSpec {
  key: DatasetKey;
  hfId: string;
  /** HuggingFace split names, in the order they are hashed. */
  hfSplits: string[];
  /** Instance counts published by the dataset authors (used only to warn on drift). */
  expected: Record<string, number>;
}

export const DATASETS: Record<DatasetKey, DatasetSpec> = {
  lite: { key: 'lite', hfId: 'SWE-bench/SWE-bench_Lite', hfSplits: ['dev', 'test'], expected: { dev: 23, test: 300 } },
  multilingual: { key: 'multilingual', hfId: 'SWE-bench/SWE-bench_Multilingual', hfSplits: ['test'], expected: { test: 300 } },
  verified: { key: 'verified', hfId: 'SWE-bench/SWE-bench_Verified', hfSplits: ['test'], expected: { test: 500 } },
};

export function parseDatasetKeys(list: string): DatasetKey[] {
  const keys = list.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!keys.length) throw new Error('no dataset given');
  for (const key of keys) if (!(key in DATASETS)) throw new Error(`unknown dataset "${key}" (expected: ${Object.keys(DATASETS).join(', ')})`);
  return [...new Set(keys)] as DatasetKey[];
}

/** One benchmark instance after normalisation; only fields the benchmark needs are kept. */
export interface DatasetInstance {
  instanceId: string;
  repo: string;
  baseCommit: string;
  patch: string;
  problemStatement: string;
  createdAt: string;
  version: string;
  /** Dataset keys that contain this instance (Lite is a subset of Verified for many ids). */
  datasets: DatasetKey[];
  hfSplit: string;
  /** Columns the HF rows API had to truncate (never expected; such instances are skipped). */
  truncatedCells: string[];
}

export interface SplitFileInfo {
  hfSplit: string;
  file: string;
  rows: number;
  sha256: string;
}

export interface LoadedDataset {
  key: DatasetKey;
  hfId: string;
  /** HuggingFace hub commit of the dataset repo when the cache was created (null if unknown). */
  revision: string | null;
  files: SplitFileInfo[];
  /** SHA-256 over the per-split file hashes: a single identity for the dataset contents. */
  contentSha256: string;
  instances: DatasetInstance[];
}

interface CacheMeta {
  hfId: string;
  hfSplit: string;
  numRows: number;
  sha256: string;
  revision: string | null;
  fetchedAt: string;
  source: string;
}

interface RowsPage {
  rows: { row_idx: number; row: Record<string, unknown>; truncated_cells?: string[] }[];
  num_rows_total: number;
}

const PAGE = 100;
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function cachePaths(spec: DatasetSpec, hfSplit: string, dir = dataDir()) {
  const base = join(dir, `${spec.hfId.split('/')[1]}.${hfSplit}`);
  return { jsonl: `${base}.jsonl`, meta: `${base}.meta.json` };
}

async function fetchRevision(hfId: string): Promise<string | null> {
  try {
    const info = await httpGetJson<{ sha?: string }>(`https://huggingface.co/api/datasets/${hfId}`, { retries: 2, timeoutMs: 30_000 });
    return info.sha ?? null;
  } catch {
    return null;
  }
}

async function fetchSplitRows(hfId: string, hfSplit: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < total; offset += PAGE) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(hfId)}&config=default&split=${hfSplit}&offset=${offset}&length=${PAGE}`;
    const page = await httpGetJson<RowsPage>(url);
    total = page.num_rows_total;
    for (const entry of page.rows) {
      const row = entry.row;
      if (entry.truncated_cells?.length) row._truncated_cells = entry.truncated_cells;
      rows[entry.row_idx] = row;
    }
  }
  for (let i = 0; i < total; i++) if (!rows[i]) throw new Error(`${hfId}/${hfSplit}: missing row ${i}`);
  return rows;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

async function readCache(spec: DatasetSpec, hfSplit: string, dir: string): Promise<{ text: string; meta: CacheMeta } | null> {
  const paths = cachePaths(spec, hfSplit, dir);
  try {
    const [text, metaText] = await Promise.all([readFile(paths.jsonl, 'utf8'), readFile(paths.meta, 'utf8')]);
    const meta = JSON.parse(metaText) as CacheMeta;
    return sha256(text) === meta.sha256 ? { text, meta } : null;
  } catch {
    return null;
  }
}

export async function ensureSplitCache(spec: DatasetSpec, hfSplit: string, options: { refresh?: boolean; dir?: string; log?: (msg: string) => void } = {}) {
  const dir = options.dir ?? dataDir();
  await mkdir(dir, { recursive: true });
  const cached = options.refresh ? null : await readCache(spec, hfSplit, dir);
  if (cached) return cached;
  options.log?.(`fetching ${spec.hfId} [${hfSplit}] from the HuggingFace datasets-server`);
  const rows = await fetchSplitRows(spec.hfId, hfSplit);
  const revision = await fetchRevision(spec.hfId);
  const text = rows.map(row => canonicalJson(row)).join('\n') + '\n';
  const meta: CacheMeta = {
    hfId: spec.hfId,
    hfSplit,
    numRows: rows.length,
    sha256: sha256(text),
    revision,
    fetchedAt: new Date().toISOString(),
    source: 'datasets-server /rows (canonical JSON, keys sorted, row order)',
  };
  const paths = cachePaths(spec, hfSplit, dir);
  await writeAtomic(paths.jsonl, text);
  await writeAtomic(paths.meta, JSON.stringify(meta, null, 2) + '\n');
  return { text, meta };
}

export function normalizeRow(raw: Record<string, unknown>, key: DatasetKey, hfSplit: string): DatasetInstance {
  const str = (name: string) => (typeof raw[name] === 'string' ? (raw[name] as string) : '');
  return {
    instanceId: str('instance_id'),
    repo: str('repo'),
    baseCommit: str('base_commit'),
    patch: str('patch'),
    problemStatement: str('problem_statement'),
    createdAt: str('created_at'),
    version: str('version'),
    datasets: [key],
    hfSplit,
    truncatedCells: Array.isArray(raw._truncated_cells) ? (raw._truncated_cells as string[]) : [],
  };
}

export async function loadDataset(key: DatasetKey, options: { refresh?: boolean; dir?: string; log?: (msg: string) => void } = {}): Promise<LoadedDataset> {
  const spec = DATASETS[key];
  const files: SplitFileInfo[] = [];
  const instances: DatasetInstance[] = [];
  let revision: string | null = null;
  for (const hfSplit of spec.hfSplits) {
    const { text, meta } = await ensureSplitCache(spec, hfSplit, options);
    revision ??= meta.revision;
    const lines = text.split('\n').filter(Boolean);
    const expected = spec.expected[hfSplit];
    if (expected !== undefined && lines.length !== expected) {
      options.log?.(`warning: ${spec.hfId}[${hfSplit}] has ${lines.length} rows, expected ${expected}`);
    }
    files.push({ hfSplit, file: cachePaths(spec, hfSplit, options.dir).jsonl, rows: lines.length, sha256: meta.sha256 });
    for (const line of lines) instances.push(normalizeRow(JSON.parse(line) as Record<string, unknown>, key, hfSplit));
  }
  const contentSha256 = sha256(files.map(f => `${f.hfSplit}:${f.sha256}\n`).join(''));
  return { key, hfId: spec.hfId, revision, files, contentSha256, instances };
}

/** Union of datasets keyed by instance id; an instance in several datasets lists all of them. */
export function mergeInstances(datasets: LoadedDataset[]): DatasetInstance[] {
  const byId = new Map<string, DatasetInstance>();
  for (const dataset of datasets) {
    for (const instance of dataset.instances) {
      const existing = byId.get(instance.instanceId);
      if (existing) {
        if (!existing.datasets.includes(dataset.key)) existing.datasets.push(dataset.key);
      } else {
        byId.set(instance.instanceId, { ...instance, datasets: [...instance.datasets] });
      }
    }
  }
  return [...byId.values()].sort((a, b) => (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0));
}
