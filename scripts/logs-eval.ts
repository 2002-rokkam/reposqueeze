/**
 * Baseline-vs-new evaluation of compactLog on real CI logs (dev split only).
 *
 *   node --import tsx scripts/logs-eval.ts [--corpus DIR] [--baseline DIR] [--out FILE] [--split dev]
 *
 * The corpus is written by scripts/logs-fetch.mjs (default ~/reposqueeze-lab/corpus/logs, never committed). The baseline is a
 * pristine checkout of the original compact.ts (default ~/reposqueeze-lab/baseline). Held-out ("test") logs are refused.
 *
 * Failure-signal retention uses an independent definition that does not reuse the compactor's own classifier: a log line
 * is a "failure line" when it matches STRONG below. A line is retained when its normalised head (timestamp and CI workspace
 * prefix removed, alphanumerics only, first 60 characters) occurs in the normalised output. Distinct lines only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { compactLog as compactNew } from '../src/compact.js';
import { tokens } from '../src/tokens.js';

const { values: args } = parseArgs({
  options: {
    corpus: { type: 'string', default: join(homedir(), 'reposqueeze-lab/corpus/logs') },
    baseline: { type: 'string', default: join(homedir(), 'reposqueeze-lab/baseline') },
    out: { type: 'string' },
    split: { type: 'string', default: 'dev' }
  }
});
if (args.split !== 'dev') throw new Error('only the dev split may be evaluated by this script');

const baselineModule = (await import(pathToFileURL(join(args.baseline!, 'src/compact.ts')).href)) as { compactLog: (text: string, budget: number) => { text: string } };
const compactBaseline = baselineModule.compactLog;

const STRONG = /(##\[error\]|\bFAILED\b|\bFAIL\b|\bERROR\b|\berror(\[E\d+\])?:|\bpanic:|Traceback \(most recent call last\)|\b\w*(Error|Exception):|\bAssertion|✖|✗|\bfatal:|npm ERR!|BUILD FAILURE|\[ERROR\]|--- FAIL|Process completed with exit code [1-9])/;
// `gh run view` prefixes every line with "job<TAB>step<TAB>[BOM]timestamp ".
const PREFIX = /^(?:[^\t\n]*\t[^\t\n]*\t)?\uFEFF?\s*(?:\d{4}-\d\d-\d\dT[\d:.]+Z?\s?)?/;
const WORKSPACE = /(\/home\/runner\/work\/[^/\s]+\/[^/\s]+\/|[A-Z]:\\a\\[^\\\s]+\\[^\\\s]+\\|\/Users\/runner\/work\/[^/\s]+\/[^/\s]+\/)/g;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

// The subset of STRONG that names the actual cause: failing tests, assertion/exception headers, build and step failures.
const ROOT = /(##\[error\]|\bFAILED\b|--- FAIL|Traceback \(most recent call last\)|\b\w*(Error|Exception):|\bpanic:|BUILD FAILURE|Process completed with exit code [1-9]|\berror\[E\d+\])/;

const key = (line: string) => line.replace(ANSI, '').replace(PREFIX, '').replace(WORKSPACE, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 60);
const squash = (text: string) => text.replace(ANSI, '').replace(WORKSPACE, '').replace(/[^A-Za-z0-9]/g, '');

function failureKeys(log: string, pattern: RegExp): string[] {
  const keys = new Set<string>();
  for (const line of log.split('\n')) {
    const stripped = line.replace(ANSI, '').replace(PREFIX, '');
    if (stripped.length > 0 && pattern.test(stripped)) {
      const k = key(line);
      if (k.length >= 8) keys.add(k);
    }
  }
  return [...keys];
}

interface Manifest { entries: { instance: string; repo: string; ecosystem: string; split: string; file: string; bytes: number }[] }
const manifest = JSON.parse(readFileSync(join(args.corpus!, 'manifest.json'), 'utf8')) as Manifest;
const entries = manifest.entries.filter(entry => entry.split === 'dev').sort((a, b) => a.file.localeCompare(b.file));

const BUDGETS = [1000, 2000];
type Variant = 'base' | 'new';
interface Outcome { tokens: number; strongKept: number; rootKept: number }
interface Row { file: string; ecosystem: string; repo: string; inTokens: number; strong: number; root: number; budgets: Record<number, Record<Variant, Outcome>> }

const rows: Row[] = [];
for (const entry of entries) {
  const raw = readFileSync(join(args.corpus!, entry.file), 'utf8');
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) continue;
  const strong = failureKeys(raw, STRONG), root = failureKeys(raw, ROOT);
  const row: Row = { file: entry.file, ecosystem: entry.ecosystem, repo: entry.repo, inTokens: tokens(raw), strong: strong.length, root: root.length, budgets: {} };
  for (const budget of BUDGETS) {
    const outcome = (text: string): Outcome => {
      const squashed = squash(text);
      return { tokens: tokens(text), strongKept: strong.filter(k => squashed.includes(k)).length, rootKept: root.filter(k => squashed.includes(k)).length };
    };
    row.budgets[budget] = { base: outcome(compactBaseline(raw, budget).text), new: outcome(compactNew(raw, budget).text) };
    if (row.budgets[budget].new.tokens > budget) throw new Error(`budget exceeded: ${entry.file} @${budget}`);
  }
  rows.push(row);
}

const pct = (value: number) => `${(100 * value).toFixed(1)}%`;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const mean = (values: number[]) => sum(values) / Math.max(1, values.length);
const inputTokens = sum(rows.map(r => r.inTokens));
const lines: string[] = [`compactLog on ${rows.length} real dev CI logs from ${new Set(rows.map(r => r.repo)).size} repositories, ${inputTokens} input tokens (o200k_base)`, ''];
lines.push(
  '| budget | variant | output tokens | reduction vs raw | strong lines kept (macro mean per log) | strong lines kept (pooled) | root-cause lines kept (macro) | root-cause lines kept (pooled) | logs with all root-cause lines kept | logs with no root-cause line kept |',
  '|---|---|---|---|---|---|---|---|---|---|'
);
for (const budget of BUDGETS) {
  for (const variant of ['base', 'new'] as const) {
    const out = sum(rows.map(r => r.budgets[budget][variant].tokens));
    const withStrong = rows.filter(r => r.strong > 0), withRoot = rows.filter(r => r.root > 0);
    const strongMacro = mean(withStrong.map(r => r.budgets[budget][variant].strongKept / r.strong));
    const strongPooled = sum(withStrong.map(r => r.budgets[budget][variant].strongKept)) / Math.max(1, sum(withStrong.map(r => r.strong)));
    const rootMacro = mean(withRoot.map(r => r.budgets[budget][variant].rootKept / r.root));
    const rootPooled = sum(withRoot.map(r => r.budgets[budget][variant].rootKept)) / Math.max(1, sum(withRoot.map(r => r.root)));
    const all = withRoot.filter(r => r.budgets[budget][variant].rootKept === r.root).length;
    const none = withRoot.filter(r => r.budgets[budget][variant].rootKept === 0).length;
    lines.push(`| ${budget} | ${variant === 'base' ? 'baseline' : 'new'} | ${out} | ${pct(1 - out / inputTokens)} | ${pct(strongMacro)} | ${pct(strongPooled)} | ${pct(rootMacro)} | ${pct(rootPooled)} | ${all}/${withRoot.length} | ${none}/${withRoot.length} |`);
  }
}
lines.push('', `${rows.filter(r => r.inTokens <= 2000).length} logs are already within 2000 tokens; ${rows.filter(r => r.strong === 0).length} logs contain no strong failure line.`);
const report = lines.join('\n');
console.log(report);
if (args.out) writeFileSync(args.out, `${report}\n\n${JSON.stringify(rows, null, 1)}\n`);
