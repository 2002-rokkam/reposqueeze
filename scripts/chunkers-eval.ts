/**
 * Developer tool for the structured chunkers.
 *
 *   node --import tsx scripts/chunkers-eval.ts show <file> [--text]
 *       Print the spans for one file (optionally with the first lines of each chunk).
 *   node --import tsx scripts/chunkers-eval.ts stats <dir>... [--json <out.json>] [--md <out.md>] [--repeat N]
 *       Run the chunkers over every supported file below the directories (git-tracked files when the
 *       directory is a git repository) and report per-format throughput and chunk statistics.
 *
 * Statistics use real repository files only; nothing is modified or executed.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chunkStructured, structuredFormat } from '../src/chunkers.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function listFiles(root: string): string[] {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return out.split('\0').filter(Boolean).sort().map(f => join(root, f));
  } catch {
    const files: string[] = [];
    const visit = (dir: string, depth: number): void => {
      if (depth > 30) return;
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) visit(full, depth + 1);
        else if (entry.isFile()) files.push(full);
      }
    };
    visit(root, 0);
    return files;
  }
}

function show(path: string, withText: boolean): void {
  const text = readFileSync(path, 'utf8');
  const spans = chunkStructured(path, text);
  if (!spans) {
    console.log(`${path}: not a structured format (format=${structuredFormat(path, text)})`);
    return;
  }
  const lines = text.split('\n');
  console.log(`${path}: format=${structuredFormat(path, text)} lines=${lines.length} spans=${spans.length}`);
  for (const s of spans) {
    console.log(`${String(s.start).padStart(5)}-${String(s.end).padEnd(5)} ${s.kind.padEnd(16)} ${JSON.stringify(s.name)}${s.scope ? `  [${s.scope}]` : ''}`);
    if (s.signature) console.log(`      sig: ${s.signature}`);
    if (s.refs?.length) console.log(`      refs(${s.refs.length}): ${s.refs.slice(0, 10).join(' | ')}`);
    if (withText) for (const l of lines.slice(s.start - 1, Math.min(s.end, s.start + 2))) console.log(`      > ${l.slice(0, 110)}`);
  }
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

interface Row {
  format: string;
  files: number;
  bytes: number;
  ms: number;
  mbPerSecond: number;
  filesWithSpans: number;
  spans: number;
  spansPerFileMedian: number;
  linesPerSpanMedian: number;
  linesPerSpanP95: number;
  coveredPercent: number;
  redundancy: number;
  slowest: { path: string; ms: number; kb: number }[];
}

function stats(roots: string[], repeat: number): Row[] {
  const perFormat = new Map<string, { files: number; bytes: number; ms: number; filesWithSpans: number; perFile: number[]; spanLines: number[]; covered: number; content: number; spanTotal: number; fileLines: number; slow: { path: string; ms: number; kb: number }[] }>();
  for (const root of roots) {
    for (const file of listFiles(root)) {
      const format = structuredFormat(file);
      if (!format) continue;
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES || size === 0) continue;
      const buffer = readFileSync(file);
      if (buffer.includes(0)) continue;
      const text = buffer.toString('utf8');
      const format2 = structuredFormat(file, text) ?? format;
      let elapsed = Infinity;
      let spans = chunkStructured(file, text);
      for (let r = 0; r < repeat; r++) {
        const t0 = performance.now();
        spans = chunkStructured(file, text);
        elapsed = Math.min(elapsed, performance.now() - t0);
      }
      if (!spans) continue;
      const row = perFormat.get(format2) ?? { files: 0, bytes: 0, ms: 0, filesWithSpans: 0, perFile: [], spanLines: [], covered: 0, content: 0, spanTotal: 0, fileLines: 0, slow: [] };
      perFormat.set(format2, row);
      row.files++;
      row.bytes += size;
      row.ms += elapsed;
      row.slow.push({ path: relative(root, file), ms: elapsed, kb: Math.round(size / 1024) });
      row.slow.sort((a, b) => b.ms - a.ms);
      row.slow.length = Math.min(row.slow.length, 3);
      const lines = text.split('\n');
      row.fileLines += lines.length;
      if (spans.length) row.filesWithSpans++;
      row.perFile.push(spans.length);
      const mark = new Uint8Array(lines.length + 2);
      for (const s of spans) {
        row.spanLines.push(s.end - s.start + 1);
        row.spanTotal += s.end - s.start + 1;
        for (let n = s.start; n <= s.end; n++) mark[n] = 1;
      }
      for (let n = 1; n <= lines.length; n++) if (lines[n - 1].trim()) { row.content++; if (mark[n]) row.covered++; }
    }
  }
  return [...perFormat].sort((a, b) => b[1].bytes - a[1].bytes).map(([format, r]) => {
    const sorted = [...r.spanLines].sort((a, b) => a - b);
    const files = [...r.perFile].sort((a, b) => a - b);
    return {
      format,
      files: r.files,
      bytes: r.bytes,
      ms: Math.round(r.ms * 10) / 10,
      mbPerSecond: Math.round((r.bytes / 1048576 / (r.ms / 1000)) * 10) / 10,
      filesWithSpans: r.filesWithSpans,
      spans: r.spanLines.length,
      spansPerFileMedian: quantile(files, 0.5),
      linesPerSpanMedian: quantile(sorted, 0.5),
      linesPerSpanP95: quantile(sorted, 0.95),
      coveredPercent: Math.round((1000 * r.covered) / Math.max(1, r.content)) / 10,
      redundancy: Math.round((100 * r.spanTotal) / Math.max(1, r.fileLines)) / 100,
      slowest: r.slow,
    };
  });
}

function markdown(rows: Row[]): string {
  const head = '| format | files | MB | ms | MB/s | files w/ spans | spans | spans/file (median) | lines/span (median) | lines/span (p95) | % non-blank lines covered | span lines / file lines |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|';
  const body = rows.map(r => `| ${r.format} | ${r.files} | ${(r.bytes / 1048576).toFixed(2)} | ${r.ms} | ${r.mbPerSecond} | ${r.filesWithSpans} | ${r.spans} | ${r.spansPerFileMedian} | ${r.linesPerSpanMedian} | ${r.linesPerSpanP95} | ${r.coveredPercent} | ${r.redundancy} |`);
  return [head, ...body].join('\n');
}

const [command, ...args] = process.argv.slice(2);
if (command === 'show' && args[0]) {
  show(args[0], args.includes('--text'));
} else if (command === 'stats' && args.length) {
  const take = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at >= 0 ? args.splice(at, 2)[1] : undefined;
  };
  const json = take('--json');
  const md = take('--md');
  const repeat = Number(take('--repeat') ?? 3);
  const rows = stats(args, repeat);
  const table = markdown(rows);
  console.log(table);
  if (json) writeFileSync(json, JSON.stringify(rows, null, 2) + '\n');
  if (md) writeFileSync(md, table + '\n');
} else {
  console.error('usage: chunkers-eval.ts show <file> [--text] | stats <dir>... [--json out] [--md out] [--repeat N]');
  process.exit(2);
}
