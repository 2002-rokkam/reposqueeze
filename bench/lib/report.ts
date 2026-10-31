import { bootstrapMeans, mcnemar, mean, quantile, type Interval } from './stats.js';
import { cmp } from './util.js';
import type { Mentions } from './mentions.js';
import type { RetrievalMetrics } from './metrics.js';
import type { VariantInfo } from './variants.js';

export type RowStatus = 'ok' | 'timeout' | 'error' | 'infra';

/** One result per (instance, variant). Self-contained: metrics can be recomputed from evidence + goldRanges. */
export interface RunRow {
  instance_id: string;
  repo: string;
  language: string;
  datasets: string[];
  split: 'dev' | 'test';
  variant: string;
  status: RowStatus;
  error?: string;
  stderrTail?: string;
  baseCommit: string;
  goldFiles: string[];
  goldLines: number;
  goldRanges: Record<string, [number, number][]>;
  hasCodeGold: boolean;
  mentions: Mentions;
  queryChars: number;
  queryTruncatedTo: number | null;
  /** Distinct files in order of first appearance in pack.evidence. */
  packedFiles: string[];
  numExcerpts: number;
  evidence: { path: string; start: number; end: number }[];
  metrics: RetrievalMetrics;
  /** Tokens of pack.text counted by the harness with o200k_base. */
  outputTokens: number;
  reportedOutputTokens: number | null;
  budget: number;
  budgetViolation: boolean;
  /** engine.context() wall time in the child (timeouts: the time until the kill). */
  ms: number;
  /** CPU time (user+system) of the worker process during the query; null for failures. */
  cpuMs: number | null;
  /** One-minute load average of the machine when the run started (wall times are only comparable at similar load). */
  load1: number | null;
  wallMs: number;
  rssMB: number | null;
  rssBaseMB: number | null;
  engineStats?: Record<string, unknown>;
}

export interface DatasetStat {
  key: string;
  hfId: string;
  revision: string | null;
  contentSha256: string;
  files: { hfSplit: string; rows: number; sha256: string }[];
  /** Unique instances in the dataset (all splits of the benchmark rule). */
  total: number;
  dev: number;
  test: number;
  /** DEV (or requested split) instances that survived preparation. */
  prepared: number;
  selected: number;
}

export interface Manifest {
  schema: 'rsq-bench-swe/1';
  command: string;
  startedAt: string;
  finishedAt?: string;
  /** Timestamps of resumptions of the same output directory. */
  resumes: string[];
  node: string;
  platform: string;
  arch: string;
  cpus: number;
  memGiB: number;
  harness: { gitSha: string | null; dirty: boolean | null };
  split: 'dev' | 'test';
  seed: number;
  bootstrapResamples: number;
  budget: number;
  timeoutSec: number;
  workers: number;
  /** How the corpus was obtained: full clones (git history available) or one depth-1 snapshot per base commit. */
  cloneMode: 'full' | 'shallow';
  /** Actual corpus mode of every repository used by this run (a corpus can mix both). */
  corpus: Record<string, 'full' | 'shallow'>;
  datasets: DatasetStat[];
  filters: { repos?: string[]; instances?: string[]; sample?: number; sampleMode?: string; limit?: number };
  instanceCount: number;
  instancesSha256: string;
  skipped: Record<string, number>;
  /** Selected instances that could not be evaluated for infrastructure reasons (never counted for any variant). */
  unavailable: { instanceId: string; reason: string }[];
  variants: VariantInfo[];
  notes: string[];
}

export interface MetricDef {
  key: keyof RetrievalMetrics;
  label: string;
  binary: boolean;
}

export const METRICS: MetricDef[] = [
  { key: 'packFileHit', label: 'packFileHit', binary: true },
  { key: 'packFileRecall', label: 'packFileRecall', binary: false },
  { key: 'goldLineRecall', label: 'goldLineRecall', binary: false },
  { key: 'packLineHit', label: 'packLineHit', binary: true },
  { key: 'mrr', label: 'MRR', binary: false },
  { key: 'hit1', label: 'Hit@1', binary: true },
  { key: 'hit3', label: 'Hit@3', binary: true },
  { key: 'hit5', label: 'Hit@5', binary: true },
  { key: 'hit10', label: 'Hit@10', binary: true },
];

export interface VariantSummary {
  variant: string;
  n: number;
  ok: number;
  timeouts: number;
  errors: number;
  budgetViolations: number;
  metrics: Record<string, Interval>;
  outputTokens: number;
  seconds: { mean: number; p50: number; p90: number; max: number };
  /** CPU seconds of the worker process during the query (load-independent latency proxy). */
  cpuSeconds: { mean: number; p50: number; p90: number };
  /** Mean one-minute machine load average at the start of the runs. */
  load1: number;
  rssMB: { mean: number; max: number };
}

export interface PairRow {
  metric: string;
  binary: boolean;
  meanA: number;
  meanB: number;
  diff: number;
  lo: number;
  hi: number;
  mcnemar?: { onlyA: number; onlyB: number; p: number };
}

export interface PairSummary {
  a: string;
  b: string;
  n: number;
  rows: PairRow[];
}

export interface GroupCell {
  n: number;
  failures: number;
  means: Record<string, number>;
  outputTokens: number;
  seconds: number;
}

export interface GroupTable {
  dimension: string;
  /** group value -> variant -> cell */
  groups: Record<string, Record<string, GroupCell>>;
  /** group value -> instance count */
  sizes: Record<string, number>;
}

export interface Report {
  manifest: Manifest;
  variants: string[];
  summaries: VariantSummary[];
  pairs: PairSummary[];
  tables: GroupTable[];
  bias: { instances: number; mentionsAny: number; mentionsPath: number; mentionsBasename: number; mentionsStem: number; codeGoldInstances: number; multiFileGold: number };
  failures: { instance_id: string; variant: string; status: RowStatus; error: string }[];
  rows: RunRow[];
}

const METRIC_KEYS = METRICS.map(m => m.key);
const metricValue = (row: RunRow, key: keyof RetrievalMetrics) => (row.status === 'ok' ? Number(row.metrics[key] ?? 0) : 0);
const seconds = (row: RunRow) => row.ms / 1000;

function summarize(variant: string, rows: RunRow[], resamples: number, seed: number): VariantSummary {
  const intervals = bootstrapMeans(METRICS.map(m => rows.map(r => metricValue(r, m.key))), { resamples, seed });
  const ok = rows.filter(r => r.status === 'ok');
  const times = ok.map(seconds);
  const cpu = ok.map(r => r.cpuMs).filter((x): x is number => typeof x === 'number').map(x => x / 1000);
  const loads = rows.map(r => r.load1).filter((x): x is number => typeof x === 'number');
  const rss = ok.map(r => r.rssMB).filter((x): x is number => typeof x === 'number');
  return {
    variant,
    n: rows.length,
    ok: ok.length,
    timeouts: rows.filter(r => r.status === 'timeout').length,
    errors: rows.filter(r => r.status === 'error').length,
    budgetViolations: rows.filter(r => r.budgetViolation).length,
    metrics: Object.fromEntries(METRICS.map((m, i) => [m.key, intervals[i]])),
    outputTokens: mean(ok.map(r => r.outputTokens)),
    seconds: { mean: mean(times), p50: quantile(times, 0.5), p90: quantile(times, 0.9), max: times.length ? Math.max(...times) : Number.NaN },
    cpuSeconds: { mean: mean(cpu), p50: quantile(cpu, 0.5), p90: quantile(cpu, 0.9) },
    load1: mean(loads),
    rssMB: { mean: mean(rss), max: rss.length ? Math.max(...rss) : Number.NaN },
  };
}

function pair(a: string, b: string, rowsA: Map<string, RunRow>, rowsB: Map<string, RunRow>, resamples: number, seed: number): PairSummary {
  const ids = [...rowsA.keys()].filter(id => rowsB.has(id)).sort();
  const columns = (map: Map<string, RunRow>) => METRICS.map(m => ids.map(id => metricValue(map.get(id)!, m.key)));
  const colsA = columns(rowsA);
  const colsB = columns(rowsB);
  const extraA = [ids.map(id => rowsA.get(id)!.outputTokens), ids.map(id => seconds(rowsA.get(id)!))];
  const extraB = [ids.map(id => rowsB.get(id)!.outputTokens), ids.map(id => seconds(rowsB.get(id)!))];
  const allA = [...colsA, ...extraA];
  const allB = [...colsB, ...extraB];
  const diffs = allA.map((col, i) => col.map((x, j) => allB[i][j] - x));
  const intervals = bootstrapMeans(diffs, { resamples, seed });
  const labels = [...METRICS.map(m => ({ label: m.label, binary: m.binary })), { label: 'outputTokens', binary: false }, { label: 'seconds', binary: false }];
  return {
    a,
    b,
    n: ids.length,
    rows: labels.map((meta, i) => ({
      metric: meta.label,
      binary: meta.binary,
      meanA: mean(allA[i]),
      meanB: mean(allB[i]),
      diff: intervals[i].mean,
      lo: intervals[i].lo,
      hi: intervals[i].hi,
      ...(meta.binary ? { mcnemar: (({ onlyA, onlyB, p }) => ({ onlyA, onlyB, p }))(mcnemar(allA[i], allB[i])) } : {}),
    })),
  };
}

function groupTable(dimension: string, rows: RunRow[], variants: string[], keys: (row: RunRow) => string[]): GroupTable {
  const buckets = new Map<string, Map<string, RunRow[]>>();
  for (const row of rows) {
    for (const key of keys(row)) {
      const byVariant = buckets.get(key) ?? new Map<string, RunRow[]>();
      byVariant.set(row.variant, [...(byVariant.get(row.variant) ?? []), row]);
      buckets.set(key, byVariant);
    }
  }
  const groups: GroupTable['groups'] = {};
  const sizes: GroupTable['sizes'] = {};
  for (const [key, byVariant] of [...buckets].sort((x, y) => cmp(x[0], y[0]))) {
    groups[key] = {};
    sizes[key] = Math.max(...variants.map(v => byVariant.get(v)?.length ?? 0));
    for (const variant of variants) {
      const list = byVariant.get(variant) ?? [];
      const ok = list.filter(r => r.status === 'ok');
      groups[key][variant] = {
        n: list.length,
        failures: list.length - ok.length,
        means: Object.fromEntries(METRIC_KEYS.map(k => [k, mean(list.map(r => metricValue(r, k)))])),
        outputTokens: mean(ok.map(r => r.outputTokens)),
        seconds: mean(ok.map(seconds)),
      };
    }
  }
  return { dimension, groups, sizes };
}

export interface BuildOptions {
  resamples: number;
  seed: number;
}

export function buildReport(manifest: Manifest, allRows: RunRow[], options: BuildOptions): Report {
  const variants = manifest.variants.map(v => v.name);
  const rows = allRows.filter(r => r.status !== 'infra' && variants.includes(r.variant));
  const byVariant = new Map<string, Map<string, RunRow>>(variants.map(v => [v, new Map(rows.filter(r => r.variant === v).map(r => [r.instance_id, r]))]));

  const summaries = variants.map(v => summarize(v, [...byVariant.get(v)!.values()], options.resamples, options.seed));
  const pairs: PairSummary[] = [];
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) pairs.push(pair(variants[i], variants[j], byVariant.get(variants[i])!, byVariant.get(variants[j])!, options.resamples, options.seed));
  }

  const instances = new Map<string, RunRow>();
  for (const row of rows) instances.set(row.instance_id, row);
  const unique = [...instances.values()];
  const tables = [
    groupTable('dataset', rows, variants, r => r.datasets),
    groupTable('language', rows, variants, r => [r.language]),
    groupTable('repo', rows, variants, r => [r.repo]),
    groupTable('issue names a gold file', rows, variants, r => [r.mentions.any ? 'names a gold file (path or file name)' : 'does not name a gold file']),
    groupTable('gold content', rows, variants, r => [r.hasCodeGold ? 'code gold' : 'docs/config-only gold']),
  ];
  return {
    manifest,
    variants,
    summaries,
    pairs,
    tables,
    bias: {
      instances: unique.length,
      mentionsAny: unique.filter(r => r.mentions.any).length,
      mentionsPath: unique.filter(r => r.mentions.path).length,
      mentionsBasename: unique.filter(r => r.mentions.basename).length,
      mentionsStem: unique.filter(r => r.mentions.stem).length,
      codeGoldInstances: unique.filter(r => r.hasCodeGold).length,
      multiFileGold: unique.filter(r => r.goldFiles.length > 1).length,
    },
    failures: rows.filter(r => r.status !== 'ok').map(r => ({ instance_id: r.instance_id, variant: r.variant, status: r.status, error: (r.error ?? '').split('\n')[0].slice(0, 200) })),
    rows: allRows,
  };
}
