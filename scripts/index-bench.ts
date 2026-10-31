// Measures the index pipeline of one repository and prints a single JSON line.
//   node --import tsx scripts/index-bench.ts <repo> [--query "text"] [--repeat 5] [--clear] [--exact]
// --clear deletes the repository's cache first (cold run). Without it the cache is used as it is (warm run).
// Stage 1 is measured the way the ranking will use it: every PCR query view goes through SearchIndex.retrieve.
// Worker threads are only used from the bundled build: bundle this script with esbuild (see docs/INDEX.md) and point
// REPOSQUEEZE_WORKER_FILE at dist/index-worker.cjs.
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Repository } from '../src/repository.js';
import { SearchIndex } from '../src/search-index.js';
import { terms } from '../src/tokenize.js';
import { queryViews } from '../src/v2.js';

const cpu = () => { const usage = process.cpuUsage(); return (usage.user + usage.system) / 1000; };
const median = (numbers: number[]) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { query: { type: 'string' }, repeat: { type: 'string', default: '5' }, clear: { type: 'boolean' }, exact: { type: 'boolean' } }
  });
  const root = positionals[0];
  if (!root) throw new Error('usage: index-bench.ts <repo> [--query text] [--repeat n] [--clear] [--exact]');
  const query = values.query ?? 'authentication token refresh failure in the request handler\nTypeError: undefined is not a function at retryWithBackoff';
  if (values.exact) process.env.REPOSQUEEZE_EXACT_STATS = '1';

  const repo = new Repository(root);
  if (values.clear) await repo.clearCache();

  const cpuStart = cpu();
  let started = performance.now();
  const snapshot = await repo.snapshot(query);
  const snapshotMs = performance.now() - started;
  const snapshotCpuMs = cpu() - cpuStart;

  started = performance.now();
  const index = SearchIndex.build(snapshot);
  const indexBuildMs = performance.now() - started;

  const views = queryViews(query);
  const runs: number[] = [];
  let resultHash = '';
  for (let run = 0; run < Number(values.repeat); run++) {
    started = performance.now();
    const hash = createHash('sha256');
    for (const view of views) {
      for (const hit of index.retrieve(terms(view), { limit: 300 }).slice(0, 40)) hash.update(`${hit.chunk.id}:${hit.score};`);
    }
    runs.push(performance.now() - started);
    resultHash = hash.digest('hex').slice(0, 16);
  }

  started = performance.now();
  let touched = 0;
  for (const hit of index.retrieve(terms(query), { limit: 40 })) touched += hit.chunk.text.length;
  const textMs = performance.now() - started;

  console.log(JSON.stringify({
    root: snapshot.root.split('/').pop(), mode: values.clear ? 'cold' : 'warm', indexMode: snapshot.indexMode, files: snapshot.totalFiles, candidateFiles: snapshot.candidateFiles, chunks: snapshot.chunks.length,
    snapshotMs: Math.round(snapshotMs), snapshotCpuMs: Math.round(snapshotCpuMs), indexBuildMs: Math.round(indexBuildMs), views: views.length, stage1MsMedian: Number(median(runs).toFixed(1)),
    firstTextMs: Math.round(textMs), textCharsOfTop40: touched, rssMB: Math.round(process.memoryUsage().rss / 1e6), totalTokens: snapshot.totalTokens, estimated: snapshot.totalTokensEstimated,
    revision: snapshot.revision, resultHash, diagnostics: snapshot.diagnostics
  }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
