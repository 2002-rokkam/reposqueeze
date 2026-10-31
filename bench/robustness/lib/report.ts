import { homedir } from 'node:os';
import type { CommandRecord, RepoResult } from './bench-repo.js';
import { bytesToMiB, groupBy, max, median, percentile, round, SIZE_BUCKETS, sizeBucket, sum } from './stats.js';
import type { CaseResult } from '../adversarial/types.js';

export interface AdversarialDocument {
  schema: 1;
  variant: string;
  variantRoot: string;
  variantEnv: Record<string, string>;
  node: string;
  platform: string;
  loadAtStart: number;
  loadAtEnd: number;
  complete: boolean;
  durationSec: number;
  results: CaseResult[];
}

interface Spread {
  n: number;
  median: number | null;
  p95: number | null;
  max: number | null;
}

const spread = (values: readonly number[]): Spread => ({ n: values.length, median: round(median(values)), p95: round(percentile(values, 95)), max: round(max(values)) });

const ok = (command: CommandRecord) => command.outcome === 'ok';
const withPhase = (result: RepoResult, phase: string) => result.commands.find(command => command.phase === phase);

export interface LatencyRow {
  bucket: string;
  repos: number;
  coldWallSec: Spread;
  coldCpuSec: Spread;
  warmWallSec: Spread;
  warmCpuSec: Spread;
  mapWallSec: Spread;
  expandWallSec: Spread;
  peakRssMiB: Spread;
  indexMiB: Spread;
  medianLoad1: number | null;
}

export interface CorpusSummary {
  repos: number;
  ecosystems: Record<string, number>;
  commands: number;
  outcomes: Record<string, number>;
  crashes: { repo: string; command: string; detail: string }[];
  timeouts: { repo: string; command: string; detail: string; wallSec: number; cpuSec: number | null }[];
  budgetChecks: number;
  budgetViolations: { repo: string; command: string; tokens: number; budget: number }[];
  selfReportChecks: number;
  selfReportMismatches: { repo: string; command: string }[];
  determinismChecks: number;
  nondeterministic: { repo: string; check: string }[];
  frames: { total: number; notVerbatim: number; badPaths: number; receiptsChecked: number; receiptsMatching: number };
  expandChecks: { total: number; parsed: number; verbatim: number; missingNotice: number };
  truncation: { overLimit: number; flaggedIncomplete: number; unflagged: { repo: string; files: number; indexed: number | null }[] };
  indexedVsListed: { repos: number; medianRatio: number | null; minRatio: number | null };
  secretFindings: { rule: string; classification: string; repo: string; path: string; match: string }[];
  secretLineLeaks: { repo: string; command: string; duplicatedElsewhere: number; trueLeaks: number }[];
  latency: LatencyRow[];
  load: { median: number | null; p95: number | null; max: number | null };
  table: CorpusRow[];
}

export interface CorpusRow {
  repo: string;
  mode: string;
  ecosystem: string;
  category: string;
  files: number;
  eligibleEstimate: number;
  mib: number | null;
  sha: string;
  bucket: string;
  indexedFiles: number | null;
  incomplete: boolean | null;
  indexMode: string | null;
  coldWallSec: number | null;
  coldCpuSec: number | null;
  warmWallSec: number | null;
  warmCpuSec: number | null;
  peakRssMiB: number | null;
  indexMiB: number | null;
  bad: number;
  commandsOk: string;
}

const secretsOf = (result: RepoResult) => result.commands.flatMap(command => (command.secretFindings ?? []).map(finding => ({ command, finding })));

export function summarizeCorpus(results: readonly RepoResult[]): CorpusSummary {
  const commands = results.flatMap(result => result.commands.map(command => ({ result, command })));
  const outcomes: Record<string, number> = {};
  for (const { command } of commands) outcomes[command.outcome] = (outcomes[command.outcome] ?? 0) + 1;
  const label = (result: RepoResult) => `${result.repo.name}${result.mode === 'non-git' ? '@nogit' : ''}`;

  const frames = { total: 0, notVerbatim: 0, badPaths: 0, receiptsChecked: 0, receiptsMatching: 0 };
  const expandChecks = { total: 0, parsed: 0, verbatim: 0, missingNotice: 0 };
  for (const { command } of commands) {
    frames.total += command.frames ?? 0;
    frames.notVerbatim += command.notVerbatim ?? 0;
    frames.badPaths += command.badPaths?.length ?? 0;
    frames.receiptsChecked += command.receiptsChecked ?? 0;
    frames.receiptsMatching += command.receiptsMatching ?? 0;
    if (command.expand) {
      expandChecks.total++;
      if (command.expand.parsed) expandChecks.parsed++;
      if (command.expand.verbatim) expandChecks.verbatim++;
      if (!command.expand.untrustedNotice) expandChecks.missingNotice++;
    }
  }

  const gitResults = results.filter(result => result.mode === 'git');
  const overLimit = gitResults.filter(result => result.repo.eligibleEstimate > 100_000 || result.repo.gitFiles > 100_000);
  const flagged = overLimit.filter(result => result.commands.some(command => command.header?.incomplete === true));
  const ratios = results
    .map(result => {
      const indexed = withPhase(result, 'cold')?.header?.files;
      return indexed === undefined || !result.repo.gitFiles ? null : indexed / result.repo.gitFiles;
    })
    .filter((value): value is number => value !== null);

  const latency: LatencyRow[] = SIZE_BUCKETS.map(bucket => {
    const rows = results.filter(result => result.mode === 'git' && sizeBucket(result.repo.gitFiles) === bucket);
    const wall = (phase: string) => rows.map(result => withPhase(result, phase)).filter((c): c is CommandRecord => !!c && ok(c)).map(c => c.wallMs / 1000);
    const cpu = (phase: string) => rows.map(result => withPhase(result, phase)).filter((c): c is CommandRecord => !!c && ok(c) && c.cpuSec !== null).map(c => c.cpuSec!);
    const loads = rows.flatMap(result => result.commands.map(c => c.load1));
    return {
      bucket,
      repos: rows.length,
      coldWallSec: spread(wall('cold')),
      coldCpuSec: spread(cpu('cold')),
      warmWallSec: spread(wall('warm')),
      warmCpuSec: spread(cpu('warm')),
      mapWallSec: spread(wall('map')),
      expandWallSec: spread(wall('expand')),
      peakRssMiB: spread(rows.map(result => max(result.commands.map(c => c.rssMiB ?? 0)) ?? 0).filter(value => value > 0)),
      indexMiB: spread(rows.map(result => result.index.cacheBytesAfterCold / 1048576).filter(value => value > 0)),
      medianLoad1: round(median(loads), 1),
    };
  }).filter(row => row.repos > 0);

  const allLoads = commands.map(({ command }) => command.load1).filter(value => value > 0);
  const secrets = results.flatMap(result => secretsOf(result).map(({ finding }) => ({ rule: finding.rule, classification: finding.classification.kind, repo: label(result), path: finding.sourcePath ?? '', match: finding.match })));
  const uniqueSecrets = [...new Map(secrets.map(item => [`${item.repo}|${item.rule}|${item.path}|${item.match}`, item])).values()];

  return {
    repos: results.length,
    ecosystems: Object.fromEntries([...groupBy(results.filter(result => result.mode === 'git'), result => result.repo.ecosystem)].map(([key, value]) => [key, value.length]).sort()),
    commands: commands.length,
    outcomes,
    crashes: commands.filter(({ command }) => command.outcome === 'crash' || command.outcome === 'memory-limit' || command.outcome === 'overflow').map(({ result, command }) => ({ repo: label(result), command: command.id, detail: command.detail })),
    timeouts: commands.filter(({ command }) => command.outcome === 'timeout').map(({ result, command }) => ({ repo: label(result), command: command.id, detail: command.detail, wallSec: round(command.wallMs / 1000, 0) ?? 0, cpuSec: command.cpuSec })),
    budgetChecks: commands.filter(({ command }) => command.withinBudget !== null).length,
    budgetViolations: commands.filter(({ command }) => command.withinBudget === false).map(({ result, command }) => ({ repo: label(result), command: command.id, tokens: command.stdoutTokens ?? 0, budget: command.budget })),
    selfReportChecks: commands.filter(({ command }) => command.selfReportMatches !== undefined && command.selfReportMatches !== null).length,
    selfReportMismatches: commands.filter(({ command }) => command.selfReportMatches === false).map(({ result, command }) => ({ repo: label(result), command: command.id })),
    determinismChecks: sum(results.map(result => result.determinism.length)),
    nondeterministic: results.flatMap(result => result.determinism.filter(check => !check.identical).map(check => ({ repo: label(result), check: check.name }))),
    frames,
    expandChecks,
    truncation: {
      overLimit: overLimit.length,
      flaggedIncomplete: flagged.length,
      unflagged: overLimit.filter(result => !flagged.includes(result)).map(result => ({ repo: label(result), files: result.repo.gitFiles, indexed: withPhase(result, 'cold')?.header?.files ?? null })),
    },
    indexedVsListed: { repos: ratios.length, medianRatio: round(median(ratios), 3), minRatio: round(ratios.length ? Math.min(...ratios) : null, 3) },
    secretFindings: uniqueSecrets,
    secretLineLeaks: results.flatMap(result =>
      result.commands
        .filter(command => command.secretLineLeaks?.length)
        .map(command => ({ repo: label(result), command: command.id, duplicatedElsewhere: command.secretLineLeaks!.filter(leak => leak.duplicatedElsewhere).length, trueLeaks: command.secretLineLeaks!.filter(leak => !leak.duplicatedElsewhere).length })),
    ),
    latency,
    load: { median: round(median(allLoads), 1), p95: round(percentile(allLoads, 95), 1), max: round(max(allLoads), 1) },
    table: results
      .map((result): CorpusRow => {
        const cold = withPhase(result, 'cold');
        const warm = withPhase(result, 'warm');
        const peak = max(result.commands.map(command => command.rssMiB ?? 0));
        return {
          repo: label(result),
          mode: result.mode,
          ecosystem: result.repo.ecosystem,
          category: result.repo.category,
          files: result.repo.gitFiles,
          eligibleEstimate: result.repo.eligibleEstimate,
          mib: bytesToMiB(result.repo.workTreeBytes),
          sha: result.repo.sha.slice(0, 10),
          bucket: sizeBucket(result.repo.gitFiles),
          indexedFiles: cold?.header?.files ?? null,
          incomplete: cold?.header?.incomplete ?? null,
          indexMode: cold?.header?.mode ?? null,
          coldWallSec: cold && ok(cold) ? round(cold.wallMs / 1000, 1) : null,
          coldCpuSec: cold && ok(cold) ? cold.cpuSec : null,
          warmWallSec: warm && ok(warm) ? round(warm.wallMs / 1000, 1) : null,
          warmCpuSec: warm && ok(warm) ? warm.cpuSec : null,
          peakRssMiB: peak === null || peak === 0 ? null : round(peak, 0),
          indexMiB: round(result.index.cacheBytesAfterCold / 1048576, 1),
          bad: result.commands.filter(command => ['crash', 'timeout', 'memory-limit', 'overflow'].includes(command.outcome)).length,
          commandsOk: `${result.commands.filter(ok).length}/${result.commands.length}`,
        };
      })
      .sort((a, b) => a.files - b.files || a.repo.localeCompare(b.repo)),
  };
}

export interface AdversarialSummary {
  total: number;
  counts: Record<string, number>;
  byCategory: { category: string; pass: number; warn: number; fail: number; error: number; skip: number }[];
  failures: CaseResult[];
  warnings: CaseResult[];
  errors: CaseResult[];
}

export function summarizeAdversarial(document: AdversarialDocument | undefined): AdversarialSummary {
  const results = document?.results ?? [];
  const counts: Record<string, number> = {};
  for (const row of results) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  const byRank = (a: CaseResult, b: CaseResult) => severityRank[a.severity] - severityRank[b.severity] || a.id.localeCompare(b.id);
  return {
    total: results.length,
    counts,
    byCategory: [...groupBy(results, row => row.category)]
      .map(([category, rows]) => ({ category, pass: rows.filter(r => r.status === 'pass').length, warn: rows.filter(r => r.status === 'warn').length, fail: rows.filter(r => r.status === 'fail').length, error: rows.filter(r => r.status === 'error').length, skip: rows.filter(r => r.status === 'skip').length }))
      .sort((a, b) => a.category.localeCompare(b.category)),
    failures: results.filter(r => r.status === 'fail').sort(byRank),
    warnings: results.filter(r => r.status === 'warn').sort(byRank),
    errors: results.filter(r => r.status === 'error').sort(byRank),
  };
}

export interface Report {
  schema: 1;
  variant: string;
  variantEnv: Record<string, string>;
  machine: { node: string | null; platform: string | null; adversarialLoadStart: number | null; adversarialLoadEnd: number | null; corpusLoad: CorpusSummary['load'] };
  corpus: CorpusSummary;
  adversarial: AdversarialSummary;
}

export function buildReport(variant: string, corpus: readonly RepoResult[], adversarial: AdversarialDocument | undefined): Report {
  const summary = summarizeCorpus(corpus);
  return {
    schema: 1,
    variant,
    variantEnv: corpus[0]?.variantEnv ?? adversarial?.variantEnv ?? {},
    machine: { node: adversarial?.node ?? null, platform: adversarial?.platform ?? null, adversarialLoadStart: adversarial?.loadAtStart ?? null, adversarialLoadEnd: adversarial?.loadAtEnd ?? null, corpusLoad: summary.load },
    corpus: summary,
    adversarial: summarizeAdversarial(adversarial),
  };
}

const home = homedir();
const esc = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const num = (value: number | null | undefined, digits = 1) => (value === null || value === undefined ? '–' : value.toLocaleString('en-US', { maximumFractionDigits: digits }));
const sp = (value: Spread) => (value.n ? `${num(value.median)} / ${num(value.p95)}` : '–');

export function renderMarkdown(report: Report): string {
  const { corpus, adversarial } = report;
  const lines: string[] = [];
  const push = (...rows: string[]) => lines.push(...rows);
  push(`# Robustness report — variant \`${report.variant}\``, '');
  push(`Generated by \`bench/robustness\`. Machine: ${report.machine.platform ?? 'n/a'}, Node ${report.machine.node ?? 'n/a'}. **Timings were taken on a shared, heavily loaded machine: 1-minute load average during the corpus run — median ${num(corpus.load.median, 0)}, p95 ${num(corpus.load.p95, 0)}, max ${num(corpus.load.max, 0)}** (adversarial suite: ${num(report.machine.adversarialLoadStart, 0)} at start, ${num(report.machine.adversarialLoadEnd, 0)} at end; 8 cores). Wall-clock numbers are therefore inflated and noisy; CPU seconds (user+sys from \`/usr/bin/time -l\`) are the stable measure. Cold = persistent index cache removed (OS page cache is not purged).`, '');
  if (Object.keys(report.variantEnv).length) push(`Variant environment: \`${Object.entries(report.variantEnv).map(([k, v]) => `${k}=${v}`).join(' ')}\``, '');

  push('## Corpus run', '');
  push(`${corpus.repos} repository runs (${Object.keys(corpus.ecosystems).length} ecosystems), ${corpus.commands} commands. Outcomes: ${Object.entries(corpus.outcomes).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '');
  push('| Check | Result |', '| --- | --- |');
  push(`| Crashes (signal, fatal error, uncaught exception, OOM guard) | ${corpus.crashes.length} |`);
  push(`| Timeouts (hard limit) | ${corpus.timeouts.length} |`);
  push(`| Budget violations (o200k_base tokens of stdout > budget) | ${corpus.budgetViolations.length} of ${corpus.budgetChecks} checked |`);
  push(`| Self-reported \`outputTokens\` differs from recount | ${corpus.selfReportMismatches.length} of ${corpus.selfReportChecks} |`);
  push(`| Non-deterministic repeats (cold/warm/rebuilt cache/map/expand) | ${corpus.nondeterministic.length} of ${corpus.determinismChecks} |`);
  push(`| Excerpts not verbatim / cited path not in repository | ${corpus.frames.notVerbatim} / ${corpus.frames.badPaths} of ${corpus.frames.total} excerpts |`);
  push(`| Excerpt receipts matching the 2.1 formula | ${corpus.frames.receiptsMatching} of ${corpus.frames.receiptsChecked} |`);
  push(`| expand verbatim / missing untrusted notice | ${corpus.expandChecks.verbatim} of ${corpus.expandChecks.total} / ${corpus.expandChecks.missingNotice} |`);
  push(`| Repositories above 100,000 files that flagged \`incomplete=true\` | ${corpus.truncation.flaggedIncomplete} of ${corpus.truncation.overLimit} |`);
  push(`| Indexed files / \`git ls-files\` files (median, min) | ${num(corpus.indexedVsListed.medianRatio, 3)}, ${num(corpus.indexedVsListed.minRatio, 3)} over ${corpus.indexedVsListed.repos} repos |`);
  push(`| Secret-regex hits in outputs (unique) | ${corpus.secretFindings.length} (${corpus.secretFindings.filter(f => f.classification === 'needs-review').length} need review) |`);
  push(`| Verbatim lines of secret-named files found in outputs (not duplicated elsewhere) | ${sum(corpus.secretLineLeaks.map(l => l.trueLeaks))} (${sum(corpus.secretLineLeaks.map(l => l.duplicatedElsewhere))} also present in ordinary files) |`, '');

  if (corpus.crashes.length) push('### Crashes', '', '| Repo | Command | Detail |', '| --- | --- | --- |', ...corpus.crashes.map(c => `| ${c.repo} | ${c.command} | ${esc(c.detail)} |`), '');
  if (corpus.timeouts.length) push('### Timeouts', '', '| Repo | Command | Wall s | CPU s at kill | Detail |', '| --- | --- | ---: | ---: | --- |', ...corpus.timeouts.map(t => `| ${t.repo} | ${t.command} | ${t.wallSec} | ${num(t.cpuSec)} | ${esc(t.detail)} |`), '');
  if (corpus.budgetViolations.length) push('### Budget violations', '', '| Repo | Command | Tokens | Budget |', '| --- | --- | ---: | ---: |', ...corpus.budgetViolations.map(v => `| ${v.repo} | ${v.command} | ${v.tokens} | ${v.budget} |`), '');
  if (corpus.nondeterministic.length) push('### Non-deterministic repeats', '', '| Repo | Check |', '| --- | --- |', ...corpus.nondeterministic.map(n => `| ${n.repo} | ${n.check} |`), '');

  push('### Latency, memory and index size by repository size (git files)', '', 'Cells are `median / p95` over repositories in the bucket. Wall seconds under load; CPU seconds are user+sys.', '');
  push('| Files | Repos | Cold wall s | Cold CPU s | Warm wall s | Warm CPU s | map wall s | expand wall s | Peak RSS MiB | Index MiB | Median load |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of corpus.latency) push(`| ${row.bucket} | ${row.repos} | ${sp(row.coldWallSec)} | ${sp(row.coldCpuSec)} | ${sp(row.warmWallSec)} | ${sp(row.warmCpuSec)} | ${sp(row.mapWallSec)} | ${sp(row.expandWallSec)} | ${sp(row.peakRssMiB)} | ${sp(row.indexMiB)} | ${num(row.medianLoad1, 0)} |`);
  push('');

  push('### Corpus table', '', '| Repository | Ecosystem | Git files | MiB | SHA | Indexed | Mode | Cold s (cpu) | Warm s (cpu) | Peak RSS MiB | Index MiB | OK cmds | Bad |', '| --- | --- | ---: | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: |');
  for (const row of corpus.table) push(`| ${row.repo} | ${row.ecosystem} | ${row.files.toLocaleString('en-US')} | ${num(row.mib, 0)} | ${row.sha} | ${row.indexedFiles?.toLocaleString('en-US') ?? '–'}${row.incomplete ? ' ⚠' : ''} | ${row.indexMode ?? '–'} | ${num(row.coldWallSec)} (${num(row.coldCpuSec)}) | ${num(row.warmWallSec)} (${num(row.warmCpuSec)}) | ${num(row.peakRssMiB, 0)} | ${num(row.indexMiB)} | ${row.commandsOk} | ${row.bad} |`);
  push('');

  const review = corpus.secretFindings.filter(finding => finding.classification === 'needs-review');
  if (review.length) {
    push('### Secret-regex hits needing manual classification', '', '| Repo | Rule | Source path | Match (truncated) |', '| --- | --- | --- | --- |', ...review.slice(0, 60).map(f => `| ${f.repo} | ${f.rule} | ${esc(f.path)} | \`${esc(f.match.slice(0, 60))}\` |`), '');
    if (review.length > 60) push(`… ${review.length - 60} more in the JSON report.`, '');
  }

  push('## Adversarial suite', '');
  push(`${adversarial.total} checks: ${Object.entries(adversarial.counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none run'}.`, '');
  push('| Category | Pass | Warn | Fail | Error | Skip |', '| --- | ---: | ---: | ---: | ---: | ---: |', ...adversarial.byCategory.map(c => `| ${c.category} | ${c.pass} | ${c.warn} | ${c.fail} | ${c.error} | ${c.skip} |`), '');
  const table = (title: string, rows: CaseResult[]) => {
    if (!rows.length) return;
    push(`### ${title}`, '', '| Severity | Check | Exit | Wall s | CPU s | RSS MiB | Load | Note |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const row of rows) push(`| ${row.severity} | \`${row.id}\` | ${row.exitCode ?? '–'} | ${num(row.wallMs / 1000)} | ${num(row.cpuSec)} | ${num(row.rssMiB, 0)} | ${num(row.load1, 0)} | ${esc(row.note)} |`);
    push('');
  };
  table('Failures', adversarial.failures);
  table('Warnings', adversarial.warnings);
  table('Errors (the check itself could not run)', adversarial.errors);
  return `${lines.join('\n').replaceAll(home, '~')}\n`;
}

/** Aggregate-only summary for private targets: counts and pass/fail, no names, paths, queries or content. */
export function renderPrivateMarkdown(label: string, variant: string, results: readonly RepoResult[], adversarialNote = ''): string {
  const summary = summarizeCorpus(results);
  const lines = [
    `# Private target "${label}" — variant \`${variant}\` (aggregate only)`,
    '',
    `1-minute load average while measuring: median ${num(summary.load.median, 0)}, p95 ${num(summary.load.p95, 0)}, max ${num(summary.load.max, 0)} (8 cores; timings inflated, CPU seconds are the stable measure).`,
    '',
    '| Check | Result |',
    '| --- | --- |',
    `| Files listed by git / estimated eligible | ${results.map(r => `${r.repo.gitFiles} / ${r.repo.eligibleEstimate}`).join(', ')} |`,
    `| Commands run | ${summary.commands} (${Object.entries(summary.outcomes).map(([k, v]) => `${k} ${v}`).join(', ')}) |`,
    `| Crashes | ${summary.crashes.length} |`,
    `| Timeouts | ${summary.timeouts.length} |`,
    `| Budget violations | ${summary.budgetViolations.length} of ${summary.budgetChecks} |`,
    `| Self-reported token count mismatches | ${summary.selfReportMismatches.length} of ${summary.selfReportChecks} |`,
    `| Non-deterministic repeats | ${summary.nondeterministic.length} of ${summary.determinismChecks} |`,
    `| Excerpts not verbatim / bad cited paths | ${summary.frames.notVerbatim} / ${summary.frames.badPaths} of ${summary.frames.total} |`,
    `| Secret-regex hits in outputs | ${summary.secretFindings.length} (by classification: ${Object.entries(countBy(summary.secretFindings.map(f => f.classification))).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}) |`,
    `| Secret-regex hits by rule | ${Object.entries(countBy(summary.secretFindings.map(f => f.rule))).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} |`,
    `| Verbatim lines of secret-named files found in outputs | ${sum(summary.secretLineLeaks.map(l => l.trueLeaks + l.duplicatedElsewhere))} line(s) over ${summary.secretLineLeaks.length} command(s) |`,
    `| Secret-named files in the target | ${sum(results.map(r => r.secretPathFiles))} |`,
    `| Persistent index written | ${results.map(r => `${num(r.index.cacheBytesAfterCold / 1048576)} MiB`).join(', ')} |`,
    '',
    '| Phase | Wall s | CPU s | Peak RSS MiB |',
    '| --- | ---: | ---: | ---: |',
    ...['cold', 'warm', 'warm-2', 'cold-again', 'map', 'expand'].flatMap(phase => {
      const rows = results.flatMap(result => result.commands.filter(command => command.phase === phase && ok(command)));
      return rows.length ? [`| ${phase} | ${num(median(rows.map(r => r.wallMs / 1000)))} | ${num(median(rows.map(r => r.cpuSec ?? 0)))} | ${num(max(rows.map(r => r.rssMiB ?? 0)), 0)} |`] : [];
    }),
    '',
    adversarialNote,
  ];
  return `${lines.join('\n')}\n`;
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}
