import type { GroupTable, PairSummary, Report, VariantSummary } from './report.js';
import { METRICS, SHOWN_METRICS } from './report.js';
import type { PairRow } from './report.js';
import type { Interval } from './stats.js';

const num = (x: number, digits = 3) => (Number.isFinite(x) ? x.toFixed(digits) : 'n/a');
const withCi = (i: Interval | undefined) => (i ? `${num(i.mean)} [${num(i.lo, 2)}, ${num(i.hi, 2)}]` : 'n/a');
const pct = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : 'n/a');
const pValue = (p: number) => (p < 0.0001 ? '<0.0001' : p.toFixed(4));

function table(headers: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.map(c => String(c).replace(/\|/g, '\\|')).join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

function overall(summaries: VariantSummary[]): string {
  const headers = ['variant', 'N', 'fail (timeout/error)', ...METRICS.map(m => m.label), 'tokens', 'sec mean (p50/p90)', 'cpu sec mean', 'load avg', 'RSS MB mean/max'];
  const rows = summaries.map(s => [
    s.variant,
    s.n,
    `${s.timeouts + s.errors} (${s.timeouts}/${s.errors})`,
    ...METRICS.map(m => withCi(s.metrics[m.key])),
    num(s.outputTokens, 0),
    `${num(s.seconds.mean, 1)} (${num(s.seconds.p50, 1)}/${num(s.seconds.p90, 1)})`,
    num(s.cpuSeconds.mean, 2),
    num(s.load1, 1),
    `${num(s.rssMB.mean, 0)}/${num(s.rssMB.max, 0)}`,
  ]);
  return table(headers, rows);
}

function shownOverall(summaries: VariantSummary[]): string {
  const headers = ['variant', ...SHOWN_METRICS.map(m => m.label), 'note'];
  const rows = summaries.map(s => [
    s.variant,
    ...SHOWN_METRICS.map(m => (s.shownMetrics ? withCi(s.shownMetrics[m.key]) : 'n/a')),
    s.shownMetrics ? '' : 'evidence kinds not recorded and packs contain pointers',
  ]);
  return table(headers, rows);
}

function pairTable(summary: PairSummary, rows: PairRow[]): string {
  const headers = ['metric', summary.a, summary.b, `${summary.b} - ${summary.a} [95% CI]`, `only ${summary.a} / only ${summary.b}`, 'McNemar exact p'];
  const body = rows.map(r => [
    r.metric,
    num(r.meanA, r.metric === 'outputTokens' || r.metric === 'seconds' ? 1 : 3),
    num(r.meanB, r.metric === 'outputTokens' || r.metric === 'seconds' ? 1 : 3),
    `${r.diff >= 0 ? '+' : ''}${num(r.diff, 3)} [${num(r.lo, 3)}, ${num(r.hi, 3)}]`,
    r.mcnemar ? `${r.mcnemar.onlyA} / ${r.mcnemar.onlyB}` : '',
    r.mcnemar ? pValue(r.mcnemar.p) : '',
  ]);
  return table(headers, body);
}

function pairs(summary: PairSummary): string {
  const shown = summary.shownRows ? `\n\n**Shown-only metrics** (pointer entries excluded):\n\n${pairTable(summary, summary.shownRows)}` : '\n\nShown-only metrics: n/a (one variant has no evidence kinds).';
  return `Paired over ${summary.n} common instances. **All-evidence metrics** (pointer entries count as packed):\n\n${pairTable(summary, summary.rows)}${shown}`;
}

function groups(t: GroupTable, variants: string[]): string {
  const keys = ['packFileHit', 'packFileRecall', 'goldLineRecall', 'mrr'] as const;
  const headers = [t.dimension, 'N', ...variants.flatMap(v => [`${v} hit`, `${v} recall`, `${v} line`, `${v} MRR`, `${v} fail`])];
  const rows = Object.entries(t.groups).map(([key, byVariant]) => [
    key,
    t.sizes[key],
    ...variants.flatMap(v => {
      const cell = byVariant[v];
      return cell ? [...keys.map(k => num(cell.means[k], 2)), cell.failures] : ['', '', '', '', ''];
    }),
  ]);
  return table(headers, rows);
}

export interface RenderOptions {
  /** Omit the per-repo table, per-pair details and the failure list. */
  compact?: boolean;
}

export function renderMarkdown(report: Report, options: RenderOptions = {}): string {
  const m = report.manifest;
  const out: string[] = [];
  out.push(`# SWE retrieval benchmark: ${m.split.toUpperCase()} split`);
  out.push('');
  out.push(`- Command: \`${m.command}\``);
  out.push(`- Started: ${m.startedAt}${m.finishedAt ? `, finished: ${m.finishedAt}` : ''}`);
  out.push(`- Environment: Node ${m.node}, ${m.platform}/${m.arch}, ${m.cpus} cores, ${m.memGiB.toFixed(0)} GiB RAM, ${m.workers} worker(s), ${m.timeoutSec} s task timeout`);
  out.push(`- Budget: ${m.budget} o200k_base tokens; bootstrap: ${m.bootstrapResamples.toLocaleString()} resamples, seed ${m.seed}; harness ${m.harness.gitSha?.slice(0, 12) ?? 'unknown'}${m.harness.dirty ? ' (dirty)' : ''}`);
  out.push(`- Instances: ${m.instanceCount} (SHA-256 of sorted ids ${m.instancesSha256.slice(0, 16)})`);
  const modes = Object.values(m.corpus ?? {});
  if (modes.length) out.push(`- Corpus: ${modes.filter(x => x === 'full').length} full clone(s), ${modes.filter(x => x === 'shallow').length} depth-1 snapshot repo(s) (shallow repos give variants no git history)`);
  const filters = Object.entries(m.filters).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`);
  if (filters.length) out.push(`- Filters: ${filters.join(' ')}`);
  out.push('');

  out.push('## Datasets');
  out.push('');
  out.push(table(['dataset', 'HF revision', 'content SHA-256', 'unique instances', 'dev', 'held-out test', `${m.split} prepared`, 'selected'], m.datasets.map(d => [
    d.hfId, d.revision?.slice(0, 12) ?? 'unknown', d.contentSha256.slice(0, 16), d.total, d.dev, d.test, d.prepared, d.selected,
  ])));
  out.push('');
  const skipped = Object.entries(m.skipped);
  out.push(skipped.length ? `Skipped during gold extraction: ${skipped.map(([reason, n]) => `${reason}=${n}`).join(', ')}.` : 'No instance was skipped during gold extraction.');
  if (m.unavailable.length) out.push(`Unavailable (infrastructure, excluded for every variant): ${m.unavailable.length} (${m.unavailable.slice(0, 8).map(u => `${u.instanceId}: ${u.reason}`).join('; ')}${m.unavailable.length > 8 ? '; ...' : ''}).`);
  out.push('');

  out.push('## Variants');
  out.push('');
  out.push(table(['variant', 'path', 'git SHA', 'dirty', 'engine version', 'env', 'query truncation', 'src fingerprint'], m.variants.map(v => [
    v.name, v.root, v.gitSha?.slice(0, 12) ?? 'n/a', v.dirty === null ? 'n/a' : v.dirty ? 'yes' : 'no', v.engineVersion ?? 'n/a',
    Object.entries(v.env).map(([k, val]) => `${k}=${val}`).join(' ') || '-', v.truncate ? `${v.truncate} chars` : 'none', v.fingerprint.slice(0, 12),
  ])));
  out.push('');

  out.push('## Overall');
  out.push('');
  out.push('Means over all instances; a timeout or error counts as a zero for every retrieval metric (`fail` shows how many). Intervals are 95% percentile-bootstrap CIs over instances. Hit@k and MRR rank distinct files by first appearance in `pack.evidence`; line recall uses pre-image edit-site lines (removed lines plus context anchors around pure insertions). Seconds are `engine.context()` wall time over completed runs.');
  out.push('');
  out.push('**All-evidence metrics** (every `pack.evidence` entry counts, including one-line pointers):');
  out.push('');
  out.push(overall(report.summaries));
  out.push('');
  out.push('**Shown-only metrics**: the same metrics computed on evidence with `kind != \'pointer\'` (pointers are "Also relevant (not shown)" references, not source code):');
  out.push('');
  out.push(shownOverall(report.summaries));
  const violations = report.summaries.filter(s => s.budgetViolations);
  if (violations.length) out.push(`\n**Budget violations** (harness-counted tokens above the budget): ${violations.map(s => `${s.variant}=${s.budgetViolations}`).join(', ')}.`);
  out.push('');

  if (report.pairs.length) {
    out.push('## Paired comparisons');
    out.push('');
    for (const p of options.compact ? report.pairs.filter(x => x.a === report.variants[0]) : report.pairs) {
      out.push(`### ${p.b} vs ${p.a}`);
      out.push('');
      out.push(pairs(p));
      out.push('');
    }
  }

  const b = report.bias;
  out.push('## Bias indicator: does the issue name a gold file?');
  out.push('');
  out.push(`${b.mentionsAny} of ${b.instances} instances (${pct(b.mentionsAny, b.instances)}) literally mention a gold file by path or file name (${b.mentionsPath} by path suffix, ${b.mentionsBasename} by file name; ${b.mentionsStem} also by bare file stem, a weaker signal). ${b.codeGoldInstances} of ${b.instances} have at least one code file in the gold set; ${b.multiFileGold} have more than one gold file. Retrievers benefit from such literal hints, so read the split below before concluding anything about semantic retrieval.`);
  out.push('');

  for (const t of report.tables) {
    if (options.compact && !['dataset', 'language', 'issue names a gold file'].includes(t.dimension)) continue;
    out.push(`## By ${t.dimension}`);
    out.push('');
    out.push(groups(t, report.variants));
    out.push('');
  }

  if (!options.compact && report.failures.length) {
    out.push('## Failures');
    out.push('');
    out.push(table(['instance', 'variant', 'status', 'first error line'], report.failures.slice(0, 100).map(f => [f.instance_id, f.variant, f.status, f.error])));
    if (report.failures.length > 100) out.push(`\n... ${report.failures.length - 100} more in report.json.`);
    out.push('');
  }
  if (m.notes.length) {
    out.push('## Notes');
    out.push('');
    for (const note of m.notes) out.push(`- ${note}`);
    out.push('');
  }
  return out.join('\n');
}
