// Sanity statistics for src/trace.ts on SWE-bench problem statements.
//
//   node --import tsx scripts/trace-stats.ts [--dir <rows dir>] [--out <json>] [--budgets 6000,3000,1500] [--datasets lite,multi]
//
// Reads datasets-server row pages (lite_*.json, multi_*.json) from the rows directory. Only DEV instances are used:
// an instance is DEV iff the first byte of SHA-256("rsq-v3:" + instance_id) is even. TEST rows are counted and dropped
// before any text is looked at.
//
// Key metric, gold-identifier retention: identifiers (>= 4 characters) that occur in both the problem statement and the
// gold patch are the ones a retriever needs. For each condensing budget we report the fraction of them that survives
// condenseQuery, next to plain truncation of the statement to the same budget.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { condenseQuery, parseQuery } from '../src/trace.js';

interface Row { instance_id: string; repo: string; problem_statement: string; patch: string }

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const rowsDir = arg('dir', join(homedir(), 'reposqueeze-lab', 'tmp', 'trace'));
const outFile = arg('out', join(homedir(), 'reposqueeze-lab', 'results', 'trace', 'trace-stats.json'));
const datasetPrefixes = arg('datasets', 'lite,multi').split(',');
const budgets = arg('budgets', '6000,3000,1500').split(',').map(Number).filter(n => n > 0);

const isDev = (id: string): boolean => createHash('sha256').update(`rsq-v3:${id}`).digest()[0] % 2 === 0;

function loadDev(): { rows: (Row & { dataset: string })[]; dropped: number; truncated: number } {
  const rows: (Row & { dataset: string })[] = [];
  let dropped = 0;
  let truncated = 0;
  if (!existsSync(rowsDir)) return { rows, dropped, truncated };
  for (const file of readdirSync(rowsDir).filter(f => /^(?:lite|multi)_\d+\.json$/.test(f) && datasetPrefixes.some(prefix => f.startsWith(`${prefix}_`))).sort()) {
    const page = JSON.parse(readFileSync(join(rowsDir, file), 'utf8')) as { rows?: { row: Record<string, unknown>; truncated_cells?: string[] }[] };
    for (const entry of page.rows ?? []) {
      const id = String(entry.row.instance_id ?? '');
      if (!id || !isDev(id)) { dropped++; continue; }
      if (entry.truncated_cells?.some(cell => cell === 'problem_statement' || cell === 'patch')) { truncated++; continue; }
      rows.push({ instance_id: id, repo: String(entry.row.repo ?? ''), problem_statement: String(entry.row.problem_statement ?? ''),
        patch: String(entry.row.patch ?? ''), dataset: file.startsWith('lite') ? 'lite' : 'multilingual' });
    }
  }
  return { rows, dropped, truncated };
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{3,}/g;

/** Identifier tokens of the changed lines, hunk-header context and file paths of a unified diff. */
function patchTokens(patch: string): Set<string> {
  const tokens = new Set<string>();
  const add = (text: string): void => { for (const m of text.matchAll(IDENTIFIER)) tokens.add(m[0]); };
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git')) add(line.slice(10));
    else if (line.startsWith('@@')) add(line.slice(line.indexOf('@@', 2) + 2));
    else if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) add(line.slice(1));
  }
  return tokens;
}

const tokensOf = (text: string): Set<string> => new Set([...text.matchAll(IDENTIFIER)].map(m => m[0]));
const codeLike = (token: string): boolean => /_/.test(token) || /[a-z0-9][A-Z]/.test(token) || /^[A-Z][a-z0-9]+[A-Z]/.test(token) || /^[A-Z]{2,}[a-z]/.test(token);

interface Retention { shared: number; kept: number; keptNaive: number; sharedCode: number; keptCode: number; keptCodeNaive: number; lost: string[] }

function retention(statement: string, patch: Set<string>, condensed: string, budget: number): Retention {
  const original = tokensOf(statement);
  const kept = tokensOf(condensed);
  const naive = tokensOf(statement.slice(0, budget));
  const r: Retention = { shared: 0, kept: 0, keptNaive: 0, sharedCode: 0, keptCode: 0, keptCodeNaive: 0, lost: [] };
  for (const token of original) {
    if (!patch.has(token)) continue;
    r.shared++;
    if (kept.has(token)) r.kept++;
    else r.lost.push(token);
    if (naive.has(token)) r.keptNaive++;
    if (codeLike(token)) {
      r.sharedCode++;
      if (kept.has(token)) r.keptCode++;
      if (naive.has(token)) r.keptCodeNaive++;
    }
  }
  return r;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

const { rows, dropped, truncated } = loadDev();
if (rows.length === 0) {
  console.error(`No DEV rows found in ${rowsDir}. Fetch pages named lite_<offset>.json / multi_<offset>.json first.`);
  process.exit(1);
}

const perInstance: Record<string, unknown>[] = [];
const totals = new Map<string, Retention[]>();
const frameCounts: number[] = [];
const condensedLengths = new Map<number, number[]>();
const lostCounts = new Map<string, number>();
const startedAt = performance.now();
const startLoad = loadavg()[0];
let parseMs = 0;
let condenseMs = 0;

const addTotal = (scope: string, budget: number, r: Retention): void => {
  const key = `${scope}:${budget}`;
  totals.set(key, [...(totals.get(key) ?? []), r]);
};

for (const row of rows) {
  const t0 = performance.now();
  const parsed = parseQuery(row.problem_statement);
  parseMs += performance.now() - t0;
  const gold = patchTokens(row.patch);
  const record: Record<string, unknown> = { id: row.instance_id, dataset: row.dataset, chars: row.problem_statement.length, frames: parsed.frames.length,
    isTrace: parsed.isTrace, errorLines: parsed.errorLines.length, tests: parsed.testNames.length, symbols: parsed.symbols.length, paths: parsed.paths.length };
  frameCounts.push(parsed.frames.length);
  for (const budget of budgets) {
    const t1 = performance.now();
    const condensed = condenseQuery(row.problem_statement, budget);
    condenseMs += performance.now() - t1;
    const r = retention(row.problem_statement, gold, condensed, budget);
    addTotal(row.dataset, budget, r);
    addTotal('all', budget, r);
    if (row.problem_statement.length > budget) {
      addTotal('longer-than-budget', budget, r);
      for (const token of r.lost) lostCounts.set(`${budget}:${token}`, (lostCounts.get(`${budget}:${token}`) ?? 0) + 1);
    } else for (const token of r.lost) lostCounts.set(`${budget}:(fits) ${token}`, (lostCounts.get(`${budget}:(fits) ${token}`) ?? 0) + 1);
    condensedLengths.set(budget, [...(condensedLengths.get(budget) ?? []), condensed.length]);
    record[`kept@${budget}`] = r.shared ? r.kept / r.shared : null;
    record[`len@${budget}`] = condensed.length;
    record[`lost@${budget}`] = r.lost;
  }
  perInstance.push(record);
}

const load = loadavg()[0];
const withFrames = perInstance.filter(r => (r.frames as number) > 0).length / rows.length;
const summary: Record<string, unknown> = {
  devInstances: rows.length, testRowsDropped: dropped, truncatedSkipped: truncated,
  datasets: Object.fromEntries(['lite', 'multilingual'].map(d => [d, rows.filter(r => r.dataset === d).length])),
  statementChars: { mean: mean(rows.map(r => r.problem_statement.length)), over6000: rows.filter(r => r.problem_statement.length > 6000).length, over1500: rows.filter(r => r.problem_statement.length > 1500).length },
  parse: {
    withFrames,
    withErrorLine: perInstance.filter(r => (r.errorLines as number) > 0).length / rows.length,
    isTrace: perInstance.filter(r => r.isTrace).length / rows.length,
    meanFrames: mean(frameCounts),
  },
  timing: { parseMsPerInstance: parseMs / rows.length, condenseMsPerCall: condenseMs / (rows.length * budgets.length), loadAverage1mAtStart: startLoad, loadAverage1mAtEnd: load,
    wallMs: performance.now() - startedAt },
  retention: {} as Record<string, unknown>,
};

console.log(`DEV instances: ${rows.length} (TEST rows dropped unread: ${dropped}; truncated cells skipped: ${truncated})`);
console.log(`Frames: ${pct(withFrames)} of statements have >= 1 frame; mean ${mean(frameCounts).toFixed(2)} frames`);
console.log(`Machine 1-min load average: start ${startLoad.toFixed(1)}, end ${load.toFixed(1)}`);
console.log('\nGold-identifier retention (identifiers >= 4 chars shared by statement and gold patch)');
console.log('scope               budget    n  meanLen  micro(cond) micro(trunc) macro(cond) macro(trunc) all100%  | code-like micro(cond) micro(trunc)');
for (const [key, list] of [...totals].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const [scope, budgetText] = key.split(':');
  const budget = Number(budgetText);
  const withShared = list.filter(r => r.shared > 0);
  const sum = (f: (r: Retention) => number): number => list.reduce((a, r) => a + f(r), 0);
  const micro = sum(r => r.kept) / Math.max(1, sum(r => r.shared));
  const microNaive = sum(r => r.keptNaive) / Math.max(1, sum(r => r.shared));
  const macro = mean(withShared.map(r => r.kept / r.shared));
  const macroNaive = mean(withShared.map(r => r.keptNaive / r.shared));
  const perfect = withShared.filter(r => r.kept === r.shared).length / Math.max(1, withShared.length);
  const microCode = sum(r => r.keptCode) / Math.max(1, sum(r => r.sharedCode));
  const microCodeNaive = sum(r => r.keptCodeNaive) / Math.max(1, sum(r => r.sharedCode));
  const lengths = scope === 'all' ? condensedLengths.get(budget) ?? [] : [];
  (summary.retention as Record<string, unknown>)[key] = { instances: list.length, withSharedTokens: withShared.length, sharedTokens: sum(r => r.shared), microCondensed: micro, microTruncated: microNaive,
    macroCondensed: macro, macroTruncated: macroNaive, fractionPerfect: perfect, codeLikeMicroCondensed: microCode, codeLikeMicroTruncated: microCodeNaive, meanCondensedChars: lengths.length ? mean(lengths) : undefined };
  console.log(`${scope.padEnd(19)} ${String(budget).padStart(6)} ${String(list.length).padStart(4)} ${lengths.length ? mean(lengths).toFixed(0).padStart(8) : '       -'}  ${pct(micro).padStart(10)} ${pct(microNaive).padStart(12)} ${pct(macro).padStart(11)} ${pct(macroNaive).padStart(12)} ${pct(perfect).padStart(8)}  | ${pct(microCode).padStart(9)} ${pct(microCodeNaive).padStart(12)}`);
}

for (const budget of [Math.max(...budgets), Math.min(...budgets)]) {
  const topLost = [...lostCounts].filter(([k]) => k.startsWith(`${budget}:`)).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 45);
  console.log(`\nMost frequently lost shared identifiers at budget ${budget} ("(fits)" = statement fits the budget): ${topLost.map(([t, n]) => `${t.slice(String(budget).length + 1)}×${n}`).join(' ')}`);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ summary, perInstance }, null, 2));
console.log(`\nWrote ${outFile}`);
