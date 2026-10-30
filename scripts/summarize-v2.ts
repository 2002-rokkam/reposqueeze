import { readFile, writeFile } from 'node:fs/promises';

type Detail = Record<string, string | number | boolean> & {
  sampleId: string;
  repo: string;
  kind: string;
  variant: 'v1' | 'v2-pcr';
};
type Report = {
  fingerprint: string;
  arbArchiveSha256: string;
  groups: Record<string, string | number>[];
  details: Detail[];
};

const development = JSON.parse(await readFile('benchmarks/v2-arb-development.json', 'utf8')) as Report;
const test = JSON.parse(await readFile('benchmarks/v2-arb-test.json', 'utf8')) as Report;
if (development.fingerprint !== test.fingerprint) throw new Error('Development and held-out fingerprints differ');

const original = test.details.filter(row => row.kind === 'original');
const pairs = new Map<string, {v1?: Detail; 'v2-pcr'?: Detail}>();
for (const row of original) {
  const pair = pairs.get(row.sampleId) ?? {};
  pair[row.variant] = row;
  pairs.set(row.sampleId, pair);
}
const completePairs = [...pairs].map(([sampleId, pair]) => {
  if (!pair.v1 || !pair['v2-pcr']) throw new Error(`Incomplete pair ${sampleId}`);
  return {sampleId, v1: pair.v1, v2: pair['v2-pcr']};
});

const number = (row: Detail, key: string) => Number(row[key]);
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
function generator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
function bootstrap(key: string, iterations = 20_000) {
  const deltas = completePairs.map(pair => number(pair.v2, key) - number(pair.v1, key));
  const random = generator(0x52535632);
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let total = 0;
    for (let index = 0; index < deltas.length; index++) total += deltas[Math.floor(random() * deltas.length)];
    samples.push(total / deltas.length);
  }
  samples.sort((a, b) => a - b);
  return [samples[Math.floor(iterations * 0.025)], samples[Math.floor(iterations * 0.975)]];
}
function choose(n: number, k: number) {
  let value = 1;
  for (let i = 1; i <= k; i++) value = value * (n - k + i) / i;
  return value;
}
function exactMcNemar(key: string) {
  let v1Only = 0, v2Only = 0;
  for (const pair of completePairs) {
    const a = Boolean(pair.v1[key]), b = Boolean(pair.v2[key]);
    if (a && !b) v1Only++;
    if (!a && b) v2Only++;
  }
  const discordant = v1Only + v2Only;
  let probability = 1;
  if (discordant) {
    const lower = Math.min(v1Only, v2Only);
    let tail = 0;
    for (let k = 0; k <= lower; k++) tail += choose(discordant, k) / 2 ** discordant;
    probability = Math.min(1, 2 * tail);
  }
  return {v1Only, v2Only, twoSidedP: probability};
}

const metricNames: Record<string, string> = {
  mrr: 'MRR', any5: 'Any@5', any10: 'Any@10', any20: 'Any@20', recall20: 'Recall@20',
  hardNegative5: 'Hard-negative hit@5', lineRecall: 'Line recall at 4K',
  linePrecision: 'Line precision at 4K', packedTokens: 'Packed tokens'
};
const binary = new Set(['any5', 'any10', 'any20', 'hardNegative5']);
const comparisons = Object.keys(metricNames).map(key => {
  const v1 = mean(completePairs.map(pair => number(pair.v1, key)));
  const v2 = mean(completePairs.map(pair => number(pair.v2, key)));
  return {
    metric: metricNames[key], key, v1, v2, difference: v2 - v1,
    bootstrap95: bootstrap(key),
    ...(binary.has(key) ? {exactMcNemar: exactMcNemar(key)} : {})
  };
});

const failures = {
  v2Any10Misses: completePairs.filter(pair => !pair.v2.any10).map(pair => ({
    sampleId: pair.sampleId, repo: pair.v2.repo, v1Mrr: pair.v1.mrr, v2Mrr: pair.v2.mrr,
    hardNegative5: pair.v2.hardNegative5
  })),
  v1OnlyAny10Successes: completePairs.filter(pair => pair.v1.any10 && !pair.v2.any10).map(pair => pair.sampleId),
  v2HardNegative5Hits: completePairs.filter(pair => pair.v2.hardNegative5).map(pair => ({
    sampleId: pair.sampleId, repo: pair.v2.repo, any10: pair.v2.any10
  })),
  v2MrrRegressions: completePairs.filter(pair => number(pair.v2, 'mrr') < number(pair.v1, 'mrr')).map(pair => pair.sampleId)
};

const summary = {
  method: 'Deterministic paired bootstrap with 20,000 sample-level resamples and seed 0x52535632; exact two-sided McNemar test for binary outcomes.',
  fingerprint: test.fingerprint,
  arbArchiveSha256: test.arbArchiveSha256,
  developmentSamples: new Set(development.details.map(row => row.sampleId)).size,
  heldOutSamples: completePairs.length,
  comparisons,
  perturbationGroups: test.groups.filter(group => group.kind === 'all'),
  failures,
  cautions: [
    'The 80:20 partition is sample-level, not repository-disjoint.',
    'The 21 held-out samples are a small test set.',
    'Four query forms from one sample are correlated and are not independent observations.',
    'Retrieval metrics do not measure answer correctness, patch success, or billed provider credits.'
  ]
};

await writeFile('benchmarks/v2-summary.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
