import { contextPack, DEFAULTS, type Settings } from './context.js';
import { resolveFeatures, type FeatureSet } from './features.js';
import { SearchIndex, type Retrieved, type WeightedTerm } from './legacy-index.js';
import { hash } from './parser.js';
import { terms } from './tokenize.js';
import { createFrameResolver, frameKind, orderFrames, parseQuery } from './trace.js';
import type { GitSignals } from './gitsignals.js';
import type { Chunk, Pack, Snapshot } from './types.js';

export interface V2Ranked {
  chunk: Chunk;
  score: number;
  stability: number;
  obligations: string[];
}

// Perturbation-consensus retrieval (PCR): rank several deterministic views of the same request and
// reward evidence that remains useful when wording is removed. No model calls; the same snapshot and
// query always produce the same result.
export function queryViews(query: string): string[] {
  const all = [...new Set(terms(query))];
  if (!all.length) return [];
  const views = [query];
  const diagnostic = query
    .split('\n')
    .filter(line => /error|fail|exception|panic|undefined|not found|expected|actual|assert|traceback/i.test(line))
    .join('\n');
  if (diagnostic.trim()) views.push(diagnostic);
  const symbols = querySymbols(query).join(' ');
  if (symbols.trim()) views.push(symbols);
  // Three leave-one-bucket-out views test whether a hit depends on one fragile term.
  for (let bucket = 0; bucket < 3; bucket++) {
    const kept = all.filter(term => parseInt(hash(term).slice(0, 2), 16) % 3 !== bucket);
    if (kept.length >= 2) views.push(kept.join(' '));
  }
  const unique = new Map<string, string>();
  for (const view of views) {
    const key = [...new Set(terms(view))].sort().join(' ');
    if (key && !unique.has(key)) unique.set(key, view);
  }
  return [...unique.values()].slice(0, 6);
}

/** Identifier-like words of a request: camelCase, snake_case, dotted or qualified names and long words. */
export function querySymbols(query: string): string[] {
  return [...query.matchAll(/\b[A-Za-z_$][\w$]*(?:(?:::|\.|#)[A-Za-z_$][\w$]*)*\b/g)].map(match => match[0]).filter(word => /[_$A-Z.]|::/.test(word) || word.length >= 9);
}

function isTrace(query: string): boolean {
  return /(?:^|\n).*(?:error|fail|exception|panic|traceback|undefined|assert)/i.test(query) || /(?:go test|pytest|cargo test|npm test|mvn test)/i.test(query);
}

const TEST_PATH = /(?:^|\/)(?:tests?|specs?|__tests__|testing|testdata|fixtures?|e2e|cypress)(?:\/|$)|(?:^|[_.-])(?:test|tests|spec)(?:[_.-]|$)|(?:Tests?|IT)\.(?:java|kt|cs|scala)$/i;
const DOC_PATH = /(?:^|\/)(?:docs?|documentation|examples?|samples?|tutorials?|website|blog|benchmarks?)(?:\/|$)|\.(?:md|markdown|rst|txt|adoc)$|(?:^|\/)(?:changelog|changes|history|news|license|authors|contributing)(?:\.|$)/i;
const BULK_PATH = /(?:^|\/)(?:vendor|third[_-]?party|external|node_modules|dist|build|generated|__generated__|migrations?)(?:\/|$)|\.(?:min|bundle)\.(?:js|css)$|\.pb\.go$|_pb2\.py$|\.generated\./i;

export function testLike(path: string): boolean {
  return TEST_PATH.test(path);
}

function wantsTests(query: string): boolean {
  return /\b(?:write|add|update|extend|improve|where are|how (?:is|are)|show)\b[^.\n]{0,40}\btests?\b|\btest (?:coverage|suite|files?|cases?)\b|\bunit tests?\b|\bspec files?\b/i.test(query);
}

function wantsDocs(query: string): boolean {
  return /\b(?:docs?|documentation|readme|changelog|tutorial|examples?|guide)\b/i.test(query);
}

/** Multiplier applied to chunks of files that are rarely the place where a task has to be solved. */
export function filePrior(path: string, query: string): number {
  let prior = 1;
  if (TEST_PATH.test(path) && !wantsTests(query)) prior *= 0.75;
  if (DOC_PATH.test(path) && !wantsDocs(query)) prior *= 0.8;
  if (BULK_PATH.test(path)) prior *= 0.55;
  return prior;
}

function visibleSourceStems(query: string): Set<string> {
  const out = new Set<string>();
  for (const match of query.matchAll(/(?:^|[\s"'`(])([\w./\\-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|cs|cpp|cc|h|hpp))(?::\d+)?/gim)) {
    const file = match[1].split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '').replace(/(?:^|[_.-])(?:test|tests|spec|specs)(?:$|[_.-])/gi, '');
    if (file.length > 1) out.add(file.toLowerCase());
  }
  return out;
}

export function evidenceObligations(snapshot: Snapshot, query: string): string[] {
  const index = SearchIndex.build(snapshot);
  const wanted = [...new Set(terms(query))].filter(term => term.length >= 3 && !/^\d+$/.test(term) && !/^[a-f\d]{12,}$/i.test(term));
  const df = new Map(wanted.map(term => [term, index.documentFrequency(term)]));
  return wanted.sort((a, b) => df.get(a)! - df.get(b)! || b.length - a.length).slice(0, 12);
}

const nameIndexes = new WeakMap<Snapshot, Map<string, Chunk[]>>();

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function chunksByName(snapshot: Snapshot): Map<string, Chunk[]> {
  let map = nameIndexes.get(snapshot);
  if (!map) {
    map = new Map();
    for (const chunk of snapshot.chunks) {
      if (!chunk.name || chunk.kind === 'window') continue;
      const key = normalizeName(chunk.name);
      if (key.length < 3) continue;
      const list = map.get(key);
      if (list) list.push(chunk); else map.set(key, [chunk]);
    }
    nameIndexes.set(snapshot, map);
  }
  return map;
}

/** Definitions whose name is literally mentioned in the request (`Foo.bar`, `parse_args`, `HTTPServer`). Rarer names first. */
function identifierMatches(snapshot: Snapshot, query: string, scores: Map<string, number>): Chunk[] {
  const byName = chunksByName(snapshot);
  const found = new Map<Chunk, number>();
  for (const symbol of new Set(querySymbols(query))) {
    const candidates = [normalizeName(symbol), ...symbol.split(/::|\.|#/).map(normalizeName)];
    for (const key of new Set(candidates)) {
      const hits = byName.get(key);
      if (!hits || hits.length > 8) continue;
      for (const chunk of hits) found.set(chunk, Math.max(found.get(chunk) ?? 0, 1 / hits.length + (key === candidates[0] ? 0.5 : 0)));
    }
  }
  return [...found]
    .sort((a, b) => b[1] - a[1] || (scores.get(b[0].id) ?? 0) - (scores.get(a[0].id) ?? 0) || a[0].path.localeCompare(b[0].path) || a[0].start - b[0].start)
    .map(([chunk]) => chunk);
}

function bigramsOf(sequence: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 1; i < sequence.length; i++) out.add(`${sequence[i - 1]} ${sequence[i]}`);
  return out;
}

/** Candidates that contain adjacent query word pairs (a phrase such as "retry backoff", or retryBackoff / retry_backoff). */
function phraseMatches(index: SearchIndex, query: string, candidates: readonly Chunk[]): Chunk[] {
  const queryBigrams = [...bigramsOf(terms(query))];
  if (!queryBigrams.length) return [];
  const weight = new Map(queryBigrams.map(pair => [pair, pair.split(' ').reduce((sum, term) => sum + index.idf(term), 0)]));
  const rows: { chunk: Chunk; score: number }[] = [];
  for (const chunk of candidates) {
    const present = bigramsOf(terms(`${chunk.name} ${chunk.text}`));
    let score = 0;
    for (const pair of queryBigrams) if (present.has(pair)) score += weight.get(pair)!;
    if (score > 0) rows.push({ chunk, score });
  }
  return rows.sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path) || a.chunk.start - b.chunk.start).map(row => row.chunk);
}

/** Pseudo-relevance feedback: terms that characterise the first-pass top chunks but are rare in the corpus. */
function expansionTerms(index: SearchIndex, top: readonly Chunk[], known: ReadonlySet<string>, count = 10): WeightedTerm[] {
  const weights = new Map<string, number>();
  top.forEach((chunk, rankPosition) => {
    const documentWeight = 1 / (1 + rankPosition);
    const counts = new Map<string, number>();
    const chunkTerms = chunk.terms;
    for (const term of chunkTerms) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const [term, tf] of counts) {
      if (known.has(term) || term.length < 3 || /^\d+$/.test(term)) continue;
      if (index.documentFrequency(term) > 0.08 * index.chunkCount) continue;
      weights.set(term, (weights.get(term) ?? 0) + documentWeight * (tf / chunkTerms.length) * index.idf(term));
    }
  });
  const best = [...weights].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, count);
  const max = best[0]?.[1] ?? 1;
  return best.map(([term, weight]) => ({ term, weight: 0.5 * (weight / max) }));
}

const frameResolvers = new WeakMap<Snapshot, ReturnType<typeof createFrameResolver>>();

/** Files named by application frames of a stack trace in the query; the innermost application frame is boosted most. */
function frameBoosts(snapshot: Snapshot, query: string): Map<string, number> {
  const boosts = new Map<string, number>();
  const parsed = parseQuery(query);
  if (!parsed.isTrace) return boosts;
  let resolve = frameResolvers.get(snapshot);
  if (!resolve) frameResolvers.set(snapshot, (resolve = createFrameResolver(snapshot.inventory?.map(file => file.path) ?? snapshot.files.map(file => file.path))));
  orderFrames(parsed)
    .filter(frame => frameKind(frame) === 'app')
    .forEach((frame, i) => {
      for (const path of resolve!(frame).slice(0, 2)) boosts.set(path, Math.max(boosts.get(path) ?? 1, i === 0 ? 1.5 : 1.25));
    });
  return boosts;
}

/** Mild version-history prior: files with uncommitted work, recent commits, or co-change partners of the strongest files. */
function gitBoosts(git: GitSignals, ranked: readonly V2Ranked[]): (path: string) => number {
  const top = [...new Set(ranked.slice(0, 20).map(row => row.chunk.path))].slice(0, 3);
  const partners = new Set(top.flatMap(path => git.coChanged(path, 5).map(partner => partner.path)));
  return path => {
    let boost = 1;
    if (git.dirty.has(path)) boost *= 1.15;
    if (git.ageDays(path) <= 30) boost *= 1.05;
    if (partners.has(path) && !top.includes(path)) boost *= 1.05;
    return boost;
  };
}

export function rankV2(snapshot: Snapshot, query: string, settings: Settings = DEFAULTS, semanticScores?: Map<string, number>, features: FeatureSet = resolveFeatures(), git?: GitSignals): V2Ranked[] {
  const views = queryViews(query);
  if (!views.length) return [];
  const index = SearchIndex.build(snapshot);
  const chunkById = new Map(snapshot.chunks.map(chunk => [chunk.id, chunk]));
  const fused = new Map<string, number>();
  const appearances = new Map<string, number>();
  const fileFused = new Map<string, number>();
  const viewRows: Retrieved[][] = [];

  views.forEach((view, viewIndex) => {
    const ranked = index.retrieve([...new Set(terms(view))], { symbolWeight: settings.symbolWeight, limit: 240 });
    viewRows.push(ranked);
    const weight = viewIndex === 0 ? 1.35 : 1;
    const seenFiles = new Set<string>();
    ranked.forEach(({ chunk }, i) => {
      fused.set(chunk.id, (fused.get(chunk.id) ?? 0) + weight / (30 + i + 1));
      if (i < 80) appearances.set(chunk.id, (appearances.get(chunk.id) ?? 0) + 1);
      if (!seenFiles.has(chunk.path)) {
        fileFused.set(chunk.path, (fileFused.get(chunk.path) ?? 0) + weight / (20 + seenFiles.size + 1));
        seenFiles.add(chunk.path);
      }
    });
  });

  const fuseList = (chunks: readonly Chunk[], weight: number) =>
    chunks.slice(0, 240).forEach((chunk, i) => fused.set(chunk.id, (fused.get(chunk.id) ?? 0) + weight / (30 + i + 1)));
  const byFusedScore = () => [...fused].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => chunkById.get(id)!);

  if (semanticScores) {
    const semantic = [...semanticScores].sort((a, b) => b[1] - a[1]).slice(0, 240);
    semantic.forEach(([id], i) => fused.set(id, (fused.get(id) ?? 0) + 1 / (30 + i + 1)));
  }
  if (features.has('prf')) {
    const queryTerms = new Set(terms(query));
    const expansion = expansionTerms(index, byFusedScore().slice(0, 8), queryTerms);
    if (expansion.length) {
      const weighted: WeightedTerm[] = [...queryTerms].map(term => ({ term, weight: 1 })).concat(expansion);
      fuseList(index.retrieve(weighted, { symbolWeight: settings.symbolWeight, limit: 240 }).map(row => row.chunk), 1);
    }
  }
  if (features.has('phrase')) {
    const firstPass = new Map(viewRows[0].map(row => [row.chunk.id, row.score]));
    fuseList(identifierMatches(snapshot, query, firstPass), 1.5);
    fuseList(phraseMatches(index, query, byFusedScore().slice(0, 120)), 0.8);
  }

  const obligations = evidenceObligations(snapshot, query);
  const trace = isTrace(query);
  const stems = visibleSourceStems(query);
  const testsWanted = /\btests?|specs?|coverage\b/i.test(query) && !trace;
  const rows: V2Ranked[] = [];
  for (const [id, base] of fused) {
    const chunk = chunkById.get(id)!;
    const chunkTerms = new Set(chunk.terms);
    const covered = obligations.filter(term => chunkTerms.has(term));
    const stability = (appearances.get(id) ?? 0) / views.length;
    let score = base + 0.16 * (fileFused.get(chunk.path) ?? 0) + 0.004 * stability + 0.0007 * covered.length;
    if (trace && testLike(chunk.path) && !testsWanted) score *= 0.48;
    if (trace && !testLike(chunk.path)) {
      const basename = chunk.path.split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();
      if ([...stems].some(stem => basename.includes(stem) || stem.includes(basename))) score *= 1.35;
    }
    if (features.has('priors')) score *= filePrior(chunk.path, query);
    rows.push({ chunk, score, stability, obligations: covered });
  }
  const sorted = () => rows.sort((a, b) => b.score - a.score || b.stability - a.stability || a.chunk.path.localeCompare(b.chunk.path) || a.chunk.start - b.chunk.start);
  const boosts = features.has('frames') ? frameBoosts(snapshot, query) : undefined;
  const history = features.has('git') && git?.available ? gitBoosts(git, sorted()) : undefined;
  if (boosts?.size || history) for (const row of rows) row.score *= (boosts?.get(row.chunk.path) ?? 1) * (history?.(row.chunk.path) ?? 1);
  return sorted();
}

export function v2Diagnostics(snapshot: Snapshot, query: string, shownText: string, ranked: readonly V2Ranked[]) {
  const obligations = evidenceObligations(snapshot, query);
  const shown = new Set(terms(shownText));
  const missing = obligations.filter(term => !shown.has(term));
  const top = ranked.slice(0, Math.min(20, ranked.length));
  const stability = top.length ? top.reduce((sum, row) => sum + row.stability, 0) / top.length : 0;
  return { views: queryViews(query).length, obligations, missing, stability };
}

export function contextPackV2(snapshot: Snapshot, query: string, budget = 3000, known: string[] = [], settings: Settings = DEFAULTS, semanticScores?: Map<string, number>, features: FeatureSet = resolveFeatures(), git?: GitSignals): Pack {
  const ranked = rankV2(snapshot, query, settings, semanticScores, features, git);
  const note = `V2 perturbation consensus: ${queryViews(query).length} deterministic query views; stability is a retrieval signal, not confidence.`;
  const pack = contextPack(snapshot, query, budget, settings, known, undefined, ranked, features.has('compactfmt') ? '' : note, features);
  pack.stats.v2 = v2Diagnostics(snapshot, query, pack.text, ranked);
  return pack;
}
