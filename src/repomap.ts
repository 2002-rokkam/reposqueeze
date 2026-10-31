import { fit, tokens } from './tokens.js';
import { analyzeChunks, extractSignature, type Definition } from './skeleton.js';
import type { Chunk, Snapshot, SourceFile } from './types.js';

/**
 * Importance-ranked repository map.
 *
 * Files are the nodes of a reference graph: file G points at file F when a definition chunk of G mentions a name that F
 * defines. Weighted PageRank over that graph (personalised towards focus files/terms when given) scores the files, the
 * flow of rank into each (file, name) pair scores the definitions, and the best definitions that fit the token budget
 * are rendered as signatures. The approach follows Aider's repo map; deviations are listed in docs/REPOMAP.md.
 */

export interface RepoMapOptions {
  /** o200k_base token budget, default 1500, clamped to 256..32000. */
  budget?: number;
  /** Files (or directories ending in `/`) the map should be centred on, e.g. gold candidates or dirty files. */
  focusPaths?: readonly string[];
  /** Query terms or identifiers the map should be centred on. */
  focusTerms?: readonly string[];
  /** Hard cap on the number of files shown (default 200). */
  maxFiles?: number;
}

export interface RepoMapResult {
  text: string;
  /** Files shown, with or without definitions. */
  files: number;
  /** Definition lines shown (container headers added for context included). */
  symbols: number;
  tokens: number;
  /** Files shown in descending score order. */
  ranked: { path: string; score: number }[];
  /** Files shown with at least one definition; the rest are listed by name only. */
  describedFiles: number;
}

export interface RepoMapParams {
  damping: number;
  iterations: number;
  tolerance: number;
  /** Share of the teleport vector that follows the focus when one is given. */
  focusBlend: number;
  /** Weight of reversed reference edges in a focused run (0 = follow references only). */
  reverseWeight: number;
  /** The k-th best definition of a file competes for budget with `decay^k` of the file's score. */
  decay: number;
  maxDefsPerFile: number;
  /** Names defined in more files than this carry no edges. */
  maxDefiners: number;
  /** No ambiguity penalty up to this many defining files. */
  freeDefiners: number;
  compoundBoost: number;
  compoundMinLength: number;
  privatePenalty: number;
  genericPenalty: number;
  mentionBoost: number;
  testFactor: number;
  auxFactor: number;
  vendorFactor: number;
  /** Plain text, markup and data files rank below source files of equal graph position. */
  textFactor: number;
  /** Weight of an edge to the file whose name equals an identifier (module imports); 0 disables. */
  stemWeight: number;
  /** Larger files get a larger teleport share: `1 + sizeBoost * log2(1 + lines / 100)`; 0 disables. */
  sizeBoost: number;
  /** Share of the budget kept for files listed by name only. */
  bareReserve: number;
  maxSignatureChars: number;
}

export const DEFAULT_PARAMS: RepoMapParams = {
  damping: 0.85, iterations: 100, tolerance: 1e-6, focusBlend: 0.7, reverseWeight: 0, decay: 0.5,
  maxDefsPerFile: 10, maxDefiners: 40, freeDefiners: 3, compoundBoost: 10, compoundMinLength: 8, privatePenalty: 0.1,
  genericPenalty: 0.05, mentionBoost: 10, testFactor: 0.3, auxFactor: 0.4, vendorFactor: 0.1, textFactor: 0.25,
  stemWeight: 0, sizeBoost: 0, bareReserve: 0.2, maxSignatureChars: 110
};

const DEFAULT_BUDGET = 1500;
const DEFAULT_MAX_FILES = 200;
const MAX_FOCUS_TERMS = 64;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// PageRank

export interface RankGraph {
  size: number;
  /** CSR row offsets, length size + 1. */
  rowStart: Uint32Array;
  target: Uint32Array;
  weight: Float64Array;
}

function rowSums(graph: RankGraph): Float64Array {
  const sums = new Float64Array(graph.size);
  for (let i = 0; i < graph.size; i++) {
    let total = 0;
    for (let e = graph.rowStart[i]; e < graph.rowStart[i + 1]; e++) total += graph.weight[e];
    sums[i] = total;
  }
  return sums;
}

function normalizedTeleport(size: number, teleport?: Float64Array): Float64Array {
  const result = new Float64Array(size);
  let total = 0;
  for (let i = 0; i < size; i++) {
    const value = teleport?.[i] ?? 1;
    if (value > 0 && Number.isFinite(value)) {
      result[i] = value;
      total += value;
    }
  }
  if (total <= 0) return new Float64Array(size).fill(1 / size);
  for (let i = 0; i < size; i++) result[i] /= total;
  return result;
}

/**
 * Weighted PageRank by power iteration over a CSR graph. Dangling nodes return their mass to the teleport vector, as
 * in Aider's personalised variant. Cost is O(iterations × edges); non-positive and non-finite weights are ignored.
 */
export function pageRank(graph: RankGraph, options: { damping?: number; iterations?: number; tolerance?: number; teleport?: Float64Array } = {}): Float64Array {
  const n = graph.size;
  if (n === 0) return new Float64Array(0);
  const damping = options.damping ?? DEFAULT_PARAMS.damping;
  const iterations = options.iterations ?? DEFAULT_PARAMS.iterations;
  const tolerance = options.tolerance ?? DEFAULT_PARAMS.tolerance;
  const teleport = normalizedTeleport(n, options.teleport);
  const outWeight = rowSums(graph);
  let rank = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);
  for (let iteration = 0; iteration < iterations; iteration++) {
    next.fill(0);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (!(outWeight[i] > 0) || !Number.isFinite(outWeight[i])) {
        dangling += rank[i];
        continue;
      }
      const share = (damping * rank[i]) / outWeight[i];
      for (let e = graph.rowStart[i]; e < graph.rowStart[i + 1]; e++) next[graph.target[e]] += share * graph.weight[e];
    }
    const restart = damping * dangling + (1 - damping);
    let change = 0;
    for (let j = 0; j < n; j++) {
      const value = next[j] + restart * teleport[j];
      change += Math.abs(value - rank[j]);
      next[j] = value;
    }
    [rank, next] = [next, rank];
    if (change < tolerance) break;
  }
  return rank;
}

/** Adds every edge a second time in the opposite direction, scaled by `reverseWeight`. */
function withReverseEdges(graph: RankGraph, reverseWeight: number): RankGraph {
  const n = graph.size;
  const total = graph.target.length;
  const rowStart = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) rowStart[i + 1] += graph.rowStart[i + 1] - graph.rowStart[i];
  for (let e = 0; e < total; e++) rowStart[graph.target[e] + 1]++;
  for (let i = 0; i < n; i++) rowStart[i + 1] += rowStart[i];
  const cursor = rowStart.slice(0, n);
  const target = new Uint32Array(total * 2);
  const weight = new Float64Array(total * 2);
  for (let i = 0; i < n; i++) {
    for (let e = graph.rowStart[i]; e < graph.rowStart[i + 1]; e++) {
      target[cursor[i]] = graph.target[e];
      weight[cursor[i]++] = graph.weight[e];
    }
  }
  for (let i = 0; i < n; i++) {
    for (let e = graph.rowStart[i]; e < graph.rowStart[i + 1]; e++) {
      const j = graph.target[e];
      target[cursor[j]] = i;
      weight[cursor[j]++] = graph.weight[e] * reverseWeight;
    }
  }
  return { size: n, rowStart, target, weight };
}

class Uint32Buffer {
  private data = new Uint32Array(1024);
  length = 0;
  push(value: number): void {
    if (this.length === this.data.length) {
      const bigger = new Uint32Array(this.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data[this.length++] = value;
  }
  view(): Uint32Array {
    return this.data.subarray(0, this.length);
  }
}

class Float64Buffer {
  private data = new Float64Array(1024);
  length = 0;
  push(value: number): void {
    if (this.length === this.data.length) {
      const bigger = new Float64Array(this.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data[this.length++] = value;
  }
  add(index: number, value: number): void {
    this.data[index] += value;
  }
  view(): Float64Array {
    return this.data.subarray(0, this.length);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// File and name classification

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?|testing|testdata|test_?utils?|fixtures?|e2e|integration_tests?)(?:\/|$)|(?:^|\/)(?:test_[^/]*|[^/]*_test\.[a-z]+|[^/]*\.(?:test|spec)\.[cm]?[jt]sx?|conftest\.py|[^/]*Tests?\.(?:java|cs|kt|scala|swift))$/i;
const AUX_PATH = /(?:^|\/)(?:docs?|documentation|examples?|samples?|demos?|benchmarks?|bench|tutorials?|scripts?|tools?|contrib|sandbox|\.[^/]+)(?:\/|$)|(?:^|\/)(?:setup|noxfile|tasks|fabfile|manage|gulpfile|gruntfile|[^/]*\.config|[^/]*\.conf)\.[a-z]+$/i;
const VENDOR_PATH = /(?:^|\/)(?:vendor|vendored|third_party|third-party|extern(?:al)?|deps|_vendor|generated|__generated__|autogen|migrations)(?:\/|$)|\.min\.[cm]?js$|\.pb\.(?:go|cc|h)$|_pb2(?:_grpc)?\.py$|\.generated\.|\.d\.ts$/i;

// Project manifests orient a reader (what is built, tested, depended on) and rank with source files.
const MANIFEST_PATH = /^(?:README(?:\.[a-z]+)?|package\.json|pyproject\.toml|setup\.(?:py|cfg)|tox\.ini|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|Makefile|Dockerfile|CMakeLists\.txt|Gemfile|composer\.json|tsconfig\.json)$|^\.github\/workflows\/[^/]+$/i;
const DATA_PATH = /\.(?:csv|tsv|svg|lock|snap|log|txt|map|ya?ml|json|xml|html?|css)$/i;

function roleFactor(path: string, language: string, params: RepoMapParams): number {
  let factor = 1;
  if (VENDOR_PATH.test(path)) factor = params.vendorFactor;
  else if (TEST_PATH.test(path)) factor = params.testFactor;
  else if (AUX_PATH.test(path) && !path.startsWith('.github/workflows/')) factor = params.auxFactor;
  if (language !== 'text') return factor;
  if (MANIFEST_PATH.test(path)) return factor;
  return factor * (DATA_PATH.test(path) ? params.textFactor / 5 : params.textFactor);
}

// Names every codebase defines for the same few reasons (standard-library protocols, container verbs, lifecycle hooks):
// a textual match says little about which definition is meant.
const GENERIC_NAMES = new Set((
  'main init setup teardown setUp tearDown run test get set new name value type id data self this cls constructor ' +
  'toString valueOf equals hashCode compareTo clone close open read write reset start stop update delete remove add put ' +
  'push pop append extend clear copy keys values items iter next len size length index apply call then catch map filter ' +
  'forEach reduce join split trim replace format String Error Len Less Swap Read Write Close Reset Init Run Start Stop New Get Set ' +
  'default from into fmt eq hash drop is_empty as_ref deref borrow build finish source cmp partial_cmp try_from from_str to_string ' +
  'size iterator contains isEmpty length accept build create'
).split(' '));

function isGenericName(name: string): boolean {
  return GENERIC_NAMES.has(name) || /^__\w+__$/.test(name) || /^test_/.test(name);
}

function nameMultiplier(name: string, params: RepoMapParams): number {
  let multiplier = 1;
  const word = /[A-Za-z]/.test(name);
  const compound = word && (name.includes('_') || name.includes('-') || (/[A-Z]/.test(name) && /[a-z]/.test(name)));
  if (compound && name.length >= params.compoundMinLength) multiplier *= params.compoundBoost;
  if (name.startsWith('_')) multiplier *= params.privatePenalty;
  if (isGenericName(name)) multiplier *= params.genericPenalty;
  return multiplier;
}

function subwords(text: string): string[] {
  return text.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Paths come from untrusted snapshots; anything that could escape the root or break the line format is skipped. */
function usablePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(path) && !path.includes('\\') &&
    !path.split('/').some(part => part === '' || part === '..' || part === '.');
}

const GENERIC_STEMS = new Set(['test', 'tests', 'setup', 'conftest', 'types', 'config', 'common', 'base', 'util', 'helpers']);

/** Module name of a file: its basename without extension, or the directory name for package entry points. */
function moduleStem(path: string): string {
  const parts = path.split('/');
  const stem = parts[parts.length - 1].replace(/\.[^.]*$/, '');
  return /^(?:__init__|index|mod|lib)$/.test(stem) && parts.length > 1 ? parts[parts.length - 2] : stem;
}

// ---------------------------------------------------------------------------------------------------------------
// Preparation: definitions and references

interface Symbol {
  file: number;
  name: number;
  def: Definition;
  /** Variables are worth less than types and functions. */
  weight: number;
}

interface Prepared {
  paths: string[];
  parsed: (SourceFile | undefined)[];
  language: string[];
  lineCounts: number[];
  roles: Float64Array;
  symbols: Symbol[];
  fileSymbols: number[][];
  fileDefinitions: Definition[][];
  fileRoots: Chunk[][];
  names: string[];
  /** CSR lists of the symbols defining each name. */
  definerStart: Uint32Array;
  definers: Uint32Array;
  nameMultipliers: Float64Array;
  /** Files by module name, for import-style references. */
  stems: Map<string, number[]>;
}

function countLines(text: string): number {
  let count = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) count++;
  return count;
}

function prepare(snapshot: Snapshot, params: RepoMapParams): Prepared {
  const parsedByPath = new Map<string, SourceFile>();
  for (const file of snapshot.files) if (usablePath(file.path) && !parsedByPath.has(file.path)) parsedByPath.set(file.path, file);
  const inventory = new Map<string, { path: string; language: string; lines: number }>();
  for (const entry of snapshot.inventory ?? []) if (usablePath(entry.path) && !inventory.has(entry.path)) inventory.set(entry.path, entry);
  const paths = [...new Set([...parsedByPath.keys(), ...inventory.keys()])].sort(compareText);
  const parsed = paths.map(path => parsedByPath.get(path));
  const lineCounts = paths.map((path, i) => inventory.get(path)?.lines ?? (parsed[i] ? countLines(parsed[i]!.text) : 1));
  const language = paths.map((path, i) => parsed[i]?.language ?? inventory.get(path)?.language ?? 'text');
  const roles = Float64Array.from(paths, (path, i) => roleFactor(path, language[i], params));

  const nameIds = new Map<string, number>();
  const names: string[] = [];
  const symbols: Symbol[] = [];
  const fileSymbols: number[][] = paths.map(() => []);
  const fileDefinitions: Definition[][] = paths.map(() => []);
  const fileRoots: Chunk[][] = paths.map(() => []);
  const stems = new Map<string, number[]>();
  for (let f = 0; f < paths.length; f++) {
    if (params.stemWeight > 0 && language[f] !== 'text') {
      const stem = moduleStem(paths[f]);
      if (stem.length >= 3 && !GENERIC_STEMS.has(stem)) {
        const list = stems.get(stem);
        if (list) list.push(f); else stems.set(stem, [f]);
      }
    }
    const file = parsed[f];
    if (!file) continue;
    const analysis = analyzeChunks(file);
    fileDefinitions[f] = analysis.definitions;
    fileRoots[f] = analysis.roots;
    const seen = new Set<number>();
    for (const def of analysis.definitions) {
      if (!def.name || def.local) continue;
      let id = nameIds.get(def.name);
      if (id === undefined) {
        id = names.length;
        nameIds.set(def.name, id);
        names.push(def.name);
      }
      if (seen.has(id)) continue;
      seen.add(id);
      fileSymbols[f].push(symbols.length);
      symbols.push({ file: f, name: id, def, weight: def.role === 'variable' ? 0.6 : 1 });
    }
  }
  const definerStart = new Uint32Array(names.length + 1);
  for (const symbol of symbols) definerStart[symbol.name + 1]++;
  for (let i = 0; i < names.length; i++) definerStart[i + 1] += definerStart[i];
  const definers = new Uint32Array(symbols.length);
  const cursor = definerStart.slice(0, names.length);
  symbols.forEach((symbol, index) => { definers[cursor[symbol.name]++] = index; });
  const nameMultipliers = Float64Array.from(names, name => nameMultiplier(name, params));
  return { paths, parsed, language, lineCounts, roles, symbols, fileSymbols, fileDefinitions, fileRoots, names, definerStart, definers, nameMultipliers, stems };
}

// ---------------------------------------------------------------------------------------------------------------
// Focus

interface Focus {
  /** Teleport mass per file (relative). */
  teleport: Float64Array | null;
  /** Edge multiplier per name id. */
  mention: Float64Array | null;
  /** How strongly each name id matches the focus terms, 0..1. */
  match: Float64Array | null;
}

function normalizeFocusTerm(term: string): string {
  return term.trim().replace(/^[`'"([{]+|[`'"\])}.,;:!?]+$/g, '').replace(/\(\)$/, '');
}

function buildFocus(prepared: Prepared, options: Pick<RepoMapOptions, 'focusTerms' | 'focusPaths'>, params: RepoMapParams): Focus {
  const { paths, names } = prepared;
  const rawTerms = [...new Set((options.focusTerms ?? []).map(normalizeFocusTerm).filter(term => term.length >= 2 && term.length <= 120))].slice(0, MAX_FOCUS_TERMS);
  const focusPaths = (options.focusPaths ?? []).map(path => path.trim().replace(/^\.\//, '')).filter(Boolean);
  if (!rawTerms.length && !focusPaths.length) return { teleport: null, mention: null, match: null };

  const exact = new Set(rawTerms);
  const lowered = new Set(rawTerms.map(term => term.toLowerCase()));
  const termWords = new Set<string>();
  for (const term of rawTerms) for (const word of subwords(term)) if (word.length >= 2) termWords.add(word);

  // Name matching: identifiers equal to a term, then names whose words all occur among the terms' words, then a weak
  // overlap score weighted by how rare the shared words are among definition names.
  const nameWords = names.map(subwords);
  const wordFrequency = new Map<string, number>();
  for (const words of nameWords) for (const word of new Set(words)) wordFrequency.set(word, (wordFrequency.get(word) ?? 0) + 1);
  const weight = (word: string) => Math.log(1 + names.length / (wordFrequency.get(word) ?? 1));
  const match = new Float64Array(names.length);
  for (let id = 0; id < names.length; id++) {
    const name = names[id];
    if (exact.has(name)) match[id] = 1;
    else if (lowered.has(name.toLowerCase())) match[id] = 0.9;
    else {
      const words = nameWords[id];
      const shared = words.filter(word => termWords.has(word));
      if (!shared.length) continue;
      if (shared.length === words.length && words.length >= 2) match[id] = 0.7;
      else {
        const total = words.reduce((sum, word) => sum + weight(word), 0);
        match[id] = (0.3 * shared.reduce((sum, word) => sum + weight(word), 0)) / total;
      }
    }
  }
  const mention = new Float64Array(names.length).fill(1);
  for (let id = 0; id < names.length; id++) {
    const strength = match[id] >= 0.5 ? match[id] : match[id] / 3;
    mention[id] = 1 + (params.mentionBoost - 1) * strength;
  }

  // Path matching.
  const pathWords = paths.map(path => subwords(path));
  const pathFrequency = new Map<string, number>();
  for (const words of pathWords) for (const word of new Set(words)) pathFrequency.set(word, (pathFrequency.get(word) ?? 0) + 1);
  const pathNorm = Math.log(1 + paths.length);
  const pathTerms = rawTerms.filter(term => term.includes('/') || /\.\w{1,5}$/.test(term)).map(term => term.replace(/^\.?\//, ''));
  const teleport = new Float64Array(paths.length);
  let any = false;
  for (let f = 0; f < paths.length; f++) {
    const path = paths[f];
    let strength = 0;
    if (focusPaths.some(focus => path === focus || (focus.endsWith('/') ? path.startsWith(focus) : path.startsWith(`${focus}/`) || (!focus.includes('/') && path.endsWith(`/${focus}`))))) strength = 1;
    if (pathTerms.some(term => path === term || path.endsWith(`/${term}`))) strength = 1;
    let words = 0;
    for (const word of new Set(pathWords[f])) {
      if (termWords.has(word)) words += Math.log(1 + paths.length / (pathFrequency.get(word) ?? 1)) / pathNorm;
    }
    strength = Math.max(strength, Math.min(1, words));
    let definitions = 0;
    for (const s of prepared.fileSymbols[f]) {
      const symbol = prepared.symbols[s];
      const definerCount = prepared.definerStart[symbol.name + 1] - prepared.definerStart[symbol.name];
      if (definerCount <= params.maxDefiners) definitions += match[symbol.name] / Math.sqrt(definerCount);
    }
    teleport[f] = strength + Math.min(2, definitions);
    if (teleport[f] > 0) any = true;
  }
  return { teleport: any ? teleport : null, mention, match };
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring

interface Scores {
  fileScore: Float64Array;
  /** Rank flowing into each symbol from referencing files. */
  flow: Float64Array;
}

function scoreRepository(prepared: Prepared, focus: Focus, params: RepoMapParams): Scores {
  const { paths, symbols, names, definerStart, definers, fileRoots, nameMultipliers, roles, lineCounts, stems } = prepared;
  const nameIds = new Map<string, number>(names.map((name, id) => [name, id]));
  const fileCount = paths.length;
  const rawSource = new Uint32Buffer();
  const rawSymbol = new Uint32Buffer();
  const rawWeight = new Float64Buffer();
  const rowStart = new Uint32Array(fileCount + 1);
  const target = new Uint32Buffer();
  const weight = new Float64Buffer();
  const counts = new Uint32Array(names.length);
  const slot = new Int32Array(fileCount);
  const stamp = new Uint32Array(fileCount);
  const useStems = params.stemWeight > 0 && stems.size > 0;
  for (let g = 0; g < fileCount; g++) {
    const touched: number[] = [];
    const stemCounts = new Map<string, number>();
    for (const chunk of fileRoots[g]) {
      for (const ref of chunk.refs) {
        const id = nameIds.get(ref);
        if (id !== undefined && counts[id]++ === 0) touched.push(id);
        if (useStems && stems.has(ref)) stemCounts.set(ref, (stemCounts.get(ref) ?? 0) + 1);
      }
    }
    const addEdge = (f: number, value: number) => {
      if (stamp[f] === g + 1) weight.add(slot[f], value);
      else {
        stamp[f] = g + 1;
        slot[f] = target.length;
        target.push(f);
        weight.push(value);
      }
    };
    for (const id of touched) {
      const count = counts[id];
      counts[id] = 0;
      const definerCount = definerStart[id + 1] - definerStart[id];
      if (definerCount > params.maxDefiners) continue;
      const ambiguity = definerCount <= params.freeDefiners ? 1 : params.freeDefiners / definerCount;
      const base = roles[g] * Math.sqrt(count) * nameMultipliers[id] * (focus.mention?.[id] ?? 1) * ambiguity;
      if (!(base > 0)) continue;
      for (let d = definerStart[id]; d < definerStart[id + 1]; d++) {
        const symbolIndex = definers[d];
        const f = symbols[symbolIndex].file;
        if (f === g) continue;
        rawSource.push(g);
        rawSymbol.push(symbolIndex);
        rawWeight.push(base);
        addEdge(f, base);
      }
    }
    for (const [stem, count] of stemCounts) {
      const files = stems.get(stem)!;
      if (files.length > params.maxDefiners) continue;
      const ambiguity = files.length <= params.freeDefiners ? 1 : params.freeDefiners / files.length;
      const value = params.stemWeight * roles[g] * Math.sqrt(count) * ambiguity;
      for (const f of files) if (f !== g && value > 0) addEdge(f, value);
    }
    rowStart[g + 1] = target.length;
  }
  let graph: RankGraph = { size: fileCount, rowStart, target: target.view(), weight: weight.view() };
  const focused = focus.teleport !== null;
  if (focused && params.reverseWeight > 0) graph = withReverseEdges(graph, params.reverseWeight);

  const base = new Float64Array(fileCount);
  let baseTotal = 0;
  for (let f = 0; f < fileCount; f++) {
    base[f] = roles[f] * (params.sizeBoost > 0 ? 1 + params.sizeBoost * Math.log2(1 + lineCounts[f] / 100) : 1);
    baseTotal += base[f];
  }
  let focusTotal = 0;
  if (focus.teleport) for (let f = 0; f < fileCount; f++) focusTotal += focus.teleport[f];
  const teleport = new Float64Array(fileCount);
  for (let f = 0; f < fileCount; f++) {
    teleport[f] = focused && focusTotal > 0
      ? (1 - params.focusBlend) * (base[f] / baseTotal) + params.focusBlend * (focus.teleport![f] / focusTotal)
      : base[f] / baseTotal;
  }
  const rank = pageRank(graph, { damping: params.damping, iterations: params.iterations, tolerance: params.tolerance, teleport });

  const outWeight = rowSums(graph);
  const flow = new Float64Array(symbols.length);
  const sources = rawSource.view();
  const rawSymbols = rawSymbol.view();
  const rawWeights = rawWeight.view();
  for (let e = 0; e < sources.length; e++) {
    const g = sources[e];
    if (outWeight[g] > 0) flow[rawSymbols[e]] += (rank[g] * rawWeights[e]) / outWeight[g];
  }
  const fileScore = new Float64Array(fileCount);
  for (let f = 0; f < fileCount; f++) fileScore[f] = rank[f] * roles[f];
  return { fileScore, flow };
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

const QUOTE_SEGMENT = /[\s"\\\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]|^(?:also:?)$|^L\d+$/;

/** A path segment as it appears in the map: plain, or JSON-quoted when it could be mistaken for markup. */
function segment(text: string): string {
  if (text !== '' && !QUOTE_SEGMENT.test(text)) return text;
  return JSON.stringify(text).replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

interface DirNode {
  children: Map<string, DirNode>;
  described: number[];
  bare: number[];
}

function newNode(): DirNode {
  return { children: new Map(), described: [], bare: [] };
}

interface Rendered {
  text: string;
  files: number[];
  described: number;
  symbols: number;
}

export function buildRepoMap(snapshot: Snapshot, options: RepoMapOptions = {}, params: RepoMapParams = DEFAULT_PARAMS): RepoMapResult {
  const requested = options.budget ?? DEFAULT_BUDGET;
  const budget = Math.min(32000, Math.max(256, Math.floor(Number.isFinite(requested) ? requested : DEFAULT_BUDGET)));
  const maxFiles = Math.min(5000, Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES) || DEFAULT_MAX_FILES));
  const prepared = prepare(snapshot, params);
  const { paths, symbols, fileSymbols, fileDefinitions, lineCounts, language, roles } = prepared;
  const focus = buildFocus(prepared, options, params);
  const { fileScore, flow } = scoreRepository(prepared, focus, params);
  const revision = (snapshot.revision ?? '').slice(0, 8);
  const totalFiles = Math.max(snapshot.totalFiles ?? 0, paths.length);

  // Files nothing resolvable points at still have the teleport share, so the ordering stays total. Files that were
  // not parsed (cascade snapshots) have no graph position and rank just below parsed ones.
  const parsedCount = prepared.parsed.filter(Boolean).length;
  const floor = parsedCount ? ((1 - params.damping) / parsedCount) * 0.5 : 0;
  const score = (f: number) => (prepared.parsed[f] ? fileScore[f] : floor * roles[f]);
  const fileOrder = paths.map((_, f) => f).sort((a, b) => score(b) - score(a) || compareText(paths[a], paths[b]));

  const signatures = new Map<Definition, string>();
  const signatureOf = (f: number, def: Definition): string => {
    let cached = signatures.get(def);
    if (cached === undefined) {
      const provided = (def.chunk as { signature?: unknown }).signature;
      const source = typeof provided === 'string' && provided.trim() ? provided : def.chunk.text;
      cached = extractSignature(source, { language: language[f], role: def.role, maxChars: params.maxSignatureChars }).text || `${def.kind} ${def.name}`.trim();
      signatures.set(def, cached);
    }
    return cached;
  };

  // Candidate definitions: the best few of each of the top-ranked files, ordered by decayed file score.
  const generic = (s: number) => (isGenericName(prepared.names[symbols[s].name]) ? 1 : 0);
  const symbolKey = (s: number) => flow[s] * symbols[s].weight + (focus.match ? score(symbols[s].file) * focus.match[symbols[s].name] : 0);
  const candidateFiles = fileOrder.filter(f => fileSymbols[f].length > 0).slice(0, Math.min(paths.length, maxFiles * 4));
  const items: { file: number; symbol: number; gain: number }[] = [];
  for (const f of candidateFiles) {
    const ordered = [...fileSymbols[f]].sort((a, b) =>
      symbolKey(b) - symbolKey(a) || generic(a) - generic(b) || symbols[a].def.depth - symbols[b].def.depth || symbols[a].def.start - symbols[b].def.start);
    ordered.slice(0, params.maxDefsPerFile).forEach((symbol, k) => items.push({ file: f, symbol, gain: score(f) * params.decay ** k }));
  }
  items.sort((a, b) => b.gain - a.gain || compareText(paths[a.file], paths[b.file]) || symbols[a.symbol].def.start - symbols[b.symbol].def.start);
  // distinctFiles[n] = files described by the first n items; the item list ends where maxFiles would be exceeded.
  const distinctFiles = [0];
  const seenFiles = new Set<number>();
  let itemCap = 0;
  while (itemCap < items.length && (seenFiles.has(items[itemCap].file) || seenFiles.size < maxFiles)) {
    seenFiles.add(items[itemCap++].file);
    distinctFiles.push(seenFiles.size);
  }

  const baseName = (f: number) => paths[f].slice(paths[f].lastIndexOf('/') + 1);
  const byBaseName = (a: number, b: number) => compareText(baseName(a), baseName(b));
  const render = (itemCount: number, nameCount: number): Rendered => {
    const chosen = new Map<number, number[]>();
    for (let j = 0; j < itemCount; j++) {
      const list = chosen.get(items[j].file);
      if (list) list.push(items[j].symbol);
      else chosen.set(items[j].file, [items[j].symbol]);
    }
    const bare: number[] = [];
    const bareLimit = Math.min(nameCount, maxFiles - chosen.size);
    for (const f of fileOrder) {
      if (bare.length >= bareLimit) break;
      if (!chosen.has(f)) bare.push(f);
    }
    const root = newNode();
    const place = (f: number, kind: 'described' | 'bare') => {
      let node = root;
      for (const part of paths[f].split('/').slice(0, -1)) {
        let child = node.children.get(part);
        if (!child) node.children.set(part, child = newNode());
        node = child;
      }
      node[kind].push(f);
    };
    for (const f of chosen.keys()) place(f, 'described');
    for (const f of bare) place(f, 'bare');

    let definitionLines = 0;
    const body: string[] = [];
    const emitFile = (f: number, indent: number) => {
      body.push(`${' '.repeat(indent)}${segment(baseName(f))} (${lineCounts[f]} lines)`);
      const defs = fileDefinitions[f];
      const shown = new Set<number>();
      for (const s of chosen.get(f)!) {
        let at = defs.indexOf(symbols[s].def);
        shown.add(at);
        // The enclosing containers give context for nested definitions (methods).
        for (at = defs[at].parent; at >= 0; at = defs[at].parent) shown.add(at);
      }
      for (const at of [...shown].sort((a, b) => defs[a].start - defs[b].start)) {
        const def = defs[at];
        body.push(`${' '.repeat(indent + 1)}L${def.start} ${' '.repeat(Math.min(def.depth, 4))}${signatureOf(f, def)}`);
        definitionLines++;
      }
    };
    const emitFiles = (node: DirNode, indent: number) => {
      for (const f of [...node.described].sort(byBaseName)) emitFile(f, indent);
      if (node.bare.length) body.push(`${' '.repeat(indent)}also: ${[...node.bare].sort(byBaseName).map(f => segment(baseName(f))).join(' ')}`);
    };
    // A directory header holds the longest chain of directories without files of their own, so shared prefixes print once.
    const emitDirectory = (node: DirNode, label: string, indent: number) => {
      let current = node;
      let name = label;
      while (current.described.length === 0 && current.bare.length === 0 && current.children.size === 1) {
        const [[part, child]] = [...current.children];
        name += `${segment(part)}/`;
        current = child;
      }
      body.push(`${' '.repeat(indent)}${name}`);
      emitFiles(current, indent + 1);
      for (const part of [...current.children.keys()].sort(compareText)) emitDirectory(current.children.get(part)!, `${segment(part)}/`, indent + 1);
    };
    emitFiles(root, 0);
    for (const part of [...root.children.keys()].sort(compareText)) emitDirectory(root.children.get(part)!, `${segment(part)}/`, 0);

    const shownFiles = [...chosen.keys(), ...bare];
    const cascade = snapshot.indexMode === 'cascade' ? ` | cascade: graph over ${parsedCount} parsed of ${totalFiles} files` : '';
    const incomplete = snapshot.truncated ? ' | incomplete scan' : '';
    const header = `# repomap ${revision} | ${totalFiles} files, ${symbols.length} defs | ${shownFiles.length} shown, ${chosen.size} with defs | ranked by reference-graph centrality; not exhaustive${cascade}${incomplete}`;
    return { text: [header, ...body].join('\n'), files: shownFiles, described: chosen.size, symbols: definitionLines };
  };

  const tokensOf = (itemCount: number, nameCount: number) => tokens(render(itemCount, nameCount).text);
  const largest = (low: number, high: number, fits: (n: number) => boolean): number => {
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid; else high = mid - 1;
    }
    return low;
  };

  // 1) Definitions get the budget minus what the names of the remaining files would need, at most `bareReserve`.
  const namesAvailable = Math.min(maxFiles, fileOrder.length);
  const reserve = Math.min(Math.floor(params.bareReserve * budget), tokensOf(0, namesAvailable) - tokensOf(0, 0));
  let itemCount = largest(0, itemCap, n => tokensOf(n, 0) <= budget - reserve);
  // 2) Names of further files fill what is left.
  let nameCount = largest(0, namesAvailable, m => tokensOf(itemCount, m) <= budget);
  // 3) If that listed every remaining file, definitions may take the budget the names did not need.
  const everyFileListed = () => nameCount >= Math.min(maxFiles, fileOrder.length) - distinctFiles[itemCount];
  if (itemCount < itemCap && everyFileListed()) {
    itemCount = largest(itemCount, itemCap, n => tokensOf(n, namesAvailable) <= budget);
    nameCount = largest(0, namesAvailable, m => tokensOf(itemCount, m) <= budget);
  }
  let rendered = render(itemCount, nameCount);
  // Token counts are not strictly monotone in the selection, so verify and shrink if a search ended on the wrong side.
  while ((nameCount > 0 || itemCount > 0) && tokens(rendered.text) > budget) {
    if (nameCount > 0) nameCount = Math.max(0, nameCount - Math.max(1, Math.floor(nameCount / 8)));
    else itemCount = Math.max(0, itemCount - Math.max(1, Math.floor(itemCount / 8)));
    rendered = render(itemCount, nameCount);
  }
  let text = rendered.text;
  let used = tokens(text);
  if (used > budget) {
    text = fit(text, budget);
    used = tokens(text);
  }
  const ranked = rendered.files.map(f => ({ path: paths[f], score: score(f) })).sort((a, b) => b.score - a.score || compareText(a.path, b.path));
  return { text, files: rendered.files.length, symbols: rendered.symbols, tokens: used, ranked, describedFiles: rendered.described };
}

/** All files ordered by importance, for callers that want the ranking without the rendering (e.g. as a retrieval prior). */
export function rankRepositoryFiles(snapshot: Snapshot, options: Pick<RepoMapOptions, 'focusTerms' | 'focusPaths'> = {}, params: RepoMapParams = DEFAULT_PARAMS): { path: string; score: number }[] {
  const prepared = prepare(snapshot, params);
  const { fileScore } = scoreRepository(prepared, buildFocus(prepared, options, params), params);
  return prepared.paths.map((path, f) => ({ path, score: fileScore[f] })).sort((a, b) => b.score - a.score || compareText(a.path, b.path));
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a map back

export interface ParsedRepoMap {
  header: string;
  files: { path: string; lines: number | null; described: boolean; definitions: { line: number; text: string }[] }[];
}

function splitSegments(label: string): string[] {
  return [...label.matchAll(/"(?:[^"\\]|\\.)*"|[^/"]+/g)].map(match => match[0].startsWith('"') ? JSON.parse(match[0]) as string : match[0]);
}

function splitNames(list: string): string[] {
  return [...list.matchAll(/"(?:[^"\\]|\\.)*"|\S+/g)].map(match => match[0].startsWith('"') ? JSON.parse(match[0]) as string : match[0]);
}

/** Inverse of the rendering: reconstructs file paths from the directory tree layout. Used by tests and evaluations. */
export function parseRepoMapText(text: string): ParsedRepoMap {
  const rows = text.split('\n');
  const result: ParsedRepoMap = { header: rows[0] ?? '', files: [] };
  const directories: string[] = [];
  let current: ParsedRepoMap['files'][number] | undefined;
  for (const row of rows.slice(1)) {
    if (!row.trim()) continue;
    const indent = /^ */.exec(row)![0].length;
    const body = row.slice(indent);
    const definition = /^L(\d+) (.*)$/.exec(body);
    if (definition) {
      current?.definitions.push({ line: Number(definition[1]), text: definition[2].trimStart() });
      continue;
    }
    const parent = indent === 0 ? '' : directories[indent - 1] ?? '';
    if (body.startsWith('also: ')) {
      for (const name of splitNames(body.slice(6))) result.files.push({ path: parent + name, lines: null, described: false, definitions: [] });
      current = undefined;
    } else if (body.endsWith('/')) {
      directories[indent] = `${parent}${splitSegments(body).join('/')}/`;
      directories.length = indent + 1;
      current = undefined;
    } else {
      const file = /^(.*) \((\d+) lines\)$/.exec(body);
      if (!file) continue;
      current = { path: parent + splitSegments(file[1]).join('/'), lines: Number(file[2]), described: true, definitions: [] };
      result.files.push(current);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Focus terms from free text

const STOPWORDS = new Set((
  'the and for are but not you all any can had her was one our out has have been from that this with they will would there their what when which while about after again also because before being between both could does doing down during each ' +
  'few further here how into just more most other over same should some such than then these those through under until very were where whether who whom why your its itself only own too use used using like make made need needs want ' +
  'issue bug error problem please thanks following example expected actual behavior behaviour reproduce steps description version python code test tests file files line lines call calls called return returns returned raise raises raised ' +
  'case cases fix fixed fails failing failure work works working should shouldn doesn don isn wasn weren hasn haven won wouldn couldn get gets set sets add adds new old true false none null'
).split(' '));

/**
 * Naive, model-free extraction of identifiers and file names from an issue text or query: backticked spans, dotted or
 * slashed names, snake_case and CamelCase words come first, plain words of five or more letters fill the rest.
 */
export function extractFocusTerms(text: string, limit = 32): string[] {
  const body = text.slice(0, 20000);
  const found = new Map<string, { score: number; first: number }>();
  const add = (term: string, score: number, first: number) => {
    const key = term.replace(/^[.:/-]+|[.:/-]+$/g, '');
    if (key.length < 3 || key.length > 100 || /^\d/.test(key) || STOPWORDS.has(key.toLowerCase())) return;
    const known = found.get(key);
    if (known) known.score = Math.max(known.score, score) + 0.25;
    else found.set(key, { score, first });
  };
  const backticked = new Set<string>();
  for (const match of body.matchAll(/`([^`\n]{2,100})`/g)) for (const token of match[1].match(/[A-Za-z_$][\w$]*(?:[./:-][A-Za-z_$][\w$]*)*/g) ?? []) backticked.add(token);
  for (const match of body.matchAll(/[A-Za-z_$][\w$]*(?:[./:-][A-Za-z_$][\w$]*)*/g)) {
    const token = match[0];
    const first = match.index ?? 0;
    const codeLike = token.includes('_') || (/[A-Z]/.test(token) && /[a-z]/.test(token) && !/^[A-Z][a-z]+$/.test(token));
    const pathLike = /[./]/.test(token);
    let score = 0;
    if (backticked.has(token)) score = 4;
    else if (codeLike || pathLike) score = 3;
    else if (/^[A-Z]{3,}$/.test(token)) score = 2;
    else if (/^[A-Z][a-z]{3,}$/.test(token)) score = 1.5;
    else if (/^[a-z]{5,}$/.test(token)) score = 1;
    if (!score) continue;
    add(token, score, first);
    if (pathLike) for (const part of token.split(/[./:-]/)) if (/^[A-Za-z_$][\w$]{3,}$/.test(part)) add(part, Math.max(1, score - 1.5), first);
  }
  return [...found].sort((a, b) => b[1].score - a[1].score || a[1].first - b[1].first || compareText(a[0], b[0])).slice(0, limit).map(([term]) => term);
}
