// Compact in-memory inverted index over chunks (stage-1 lexical retrieval).
//
// Layout (all typed arrays, no per-chunk strings):
//   rows      CSR  chunk -> (termId, tf)           rowStart / rowTerm / rowTf, chunkLen = token count of the chunk
//   postings  CSC  term  -> (chunk, tf)            built by transposing the rows, chunks ascending within a term
//   names     CSC  term  -> chunks whose symbol name contains the term
//   paths     CSC  term  -> chunks whose file path contains the term
// Term ids come from a TermDictionary that only ever grows, so rows written earlier stay valid.
import { terms as tokenize } from './tokenize.js';
import type { Chunk, Snapshot } from './types.js';

/** 32-bit FNV-1a over UTF-16 code units. Shared with the file sketches of the large-repository cascade. */
export function termHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

/** Largest term frequency a Uint16 cell holds; larger counts are kept exactly in an overflow table. */
const TF_LIMIT = 0xffff;

/** Append-only string <-> id dictionary with a typed-array representation that can be used without decoding. */
export class TermDictionary {
  private blob: Buffer = Buffer.alloc(0);
  private offsets: Uint32Array = new Uint32Array(1);
  private hashes: Uint32Array = new Uint32Array(0);
  private table: Uint32Array = new Uint32Array(0);
  private stored = 0;
  private readonly added = new Map<string, number>();
  private readonly addedTerms: string[] = [];

  get size(): number { return this.stored + this.addedTerms.length; }

  /** Id of a term, or -1 when the dictionary has never seen it. */
  idOf(term: string): number {
    const hash = termHash(term);
    if (this.stored) {
      const mask = this.table.length - 1;
      for (let probe = 0, slot = hash & mask; probe < this.table.length; probe++, slot = (slot + 1) & mask) {
        const entry = this.table[slot];
        if (entry === 0) break;
        const id = entry - 1;
        if (this.hashes[id] === hash && this.decode(id) === term) return id;
      }
    }
    return this.added.get(term) ?? -1;
  }

  add(term: string): number {
    const known = this.idOf(term);
    if (known >= 0) return known;
    const id = this.size;
    this.added.set(term, id);
    this.addedTerms.push(term);
    return id;
  }

  termOf(id: number): string {
    if (!Number.isInteger(id) || id < 0 || id >= this.size) throw new RangeError(`term id ${id} out of range`);
    return id < this.stored ? this.decode(id) : this.addedTerms[id - this.stored];
  }

  private decode(id: number): string {
    return this.blob.toString('utf8', this.offsets[id], this.offsets[id + 1]);
  }

  /** Typed-array form used by the persistent index; the blob is UTF-8, offsets/hashes are indexed by term id. */
  serialize(): { blob: Uint8Array; offsets: Uint32Array; hashes: Uint32Array; table: Uint32Array } {
    const total = this.size;
    const encoded = this.addedTerms.map(term => Buffer.from(term, 'utf8'));
    const storedBytes = this.stored ? this.offsets[this.stored] : 0;
    const blob = Buffer.allocUnsafe(storedBytes + encoded.reduce((sum, buffer) => sum + buffer.length, 0));
    this.blob.copy(blob, 0, 0, storedBytes);
    const offsets = new Uint32Array(total + 1);
    offsets.set(this.offsets.subarray(0, this.stored + 1));
    const hashes = new Uint32Array(total);
    hashes.set(this.hashes.subarray(0, this.stored));
    let cursor = storedBytes;
    encoded.forEach((buffer, i) => {
      buffer.copy(blob, cursor);
      cursor += buffer.length;
      offsets[this.stored + i + 1] = cursor;
      hashes[this.stored + i] = termHash(this.addedTerms[i]);
    });
    let size = 16;
    while (size < total * 2) size *= 2;
    const table = new Uint32Array(size);
    const mask = size - 1;
    for (let id = 0; id < total; id++) {
      let slot = hashes[id] & mask;
      while (table[slot] !== 0) slot = (slot + 1) & mask;
      table[slot] = id + 1;
    }
    return { blob, offsets, hashes, table };
  }

  /** Validates untrusted typed arrays (from a cache file) and wraps them without copying. */
  static fromSerialized(blob: Uint8Array, offsets: Uint32Array, hashes: Uint32Array, table: Uint32Array): TermDictionary {
    const count = hashes.length;
    if (offsets.length !== count + 1 || offsets[0] !== 0 || offsets[count] !== blob.length) throw new RangeError('bad term offsets');
    for (let i = 0; i < count; i++) if (offsets[i + 1] < offsets[i]) throw new RangeError('term offsets not monotonic');
    if (table.length < 16 || (table.length & (table.length - 1)) !== 0 || table.length < count * 2) throw new RangeError('bad term table size');
    let occupied = 0;
    for (let slot = 0; slot < table.length; slot++) {
      const entry = table[slot];
      if (entry === 0) continue;
      if (entry > count) throw new RangeError('term table entry out of range');
      occupied++;
    }
    if (occupied !== count) throw new RangeError('term table is inconsistent');
    const dictionary = new TermDictionary();
    dictionary.blob = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
    dictionary.offsets = offsets;
    dictionary.hashes = hashes;
    dictionary.table = table;
    dictionary.stored = count;
    return dictionary;
  }

  static from(terms: Iterable<string>): TermDictionary {
    const dictionary = new TermDictionary();
    for (const term of terms) dictionary.add(term);
    return dictionary;
  }
}

/** Everything the index needs about a list of chunks; produced by the repository index or from plain chunks. */
export interface RowSet {
  dictionary: TermDictionary;
  chunks: readonly Chunk[];
  rowStart: Uint32Array;
  rowTerm: Uint32Array;
  rowTf: Uint16Array;
  /** Exact term frequencies that do not fit Uint16 (stored as 0xFFFF in rowTf), keyed by entry index. */
  tfOverflow?: ReadonlyMap<number, number>;
  chunkLen: Uint32Array;
  nameStart: Uint32Array;
  nameTerm: Uint32Array;
  fileOfChunk: Uint32Array;
  pathStart: Uint32Array;
  pathTerm: Uint32Array;
}

const rowSets = new WeakMap<Snapshot, RowSet>();
const indexes = new WeakMap<object, SearchIndex>();
/**
 * Lets a producer that already holds dictionary-coded rows hand them over instead of having the index re-tokenize
 * chunks. Snapshots that share one RowSet (identical repository state) share one SearchIndex.
 */
export function attachRowSet(snapshot: Snapshot, rows: RowSet): void { rowSets.set(snapshot, rows); }

/** Builds rows from chunks that only carry term arrays (hand-made snapshots, benchmarks). */
export function rowSetFromChunks(chunks: readonly Chunk[]): RowSet {
  const dictionary = new TermDictionary();
  const rowStart = new Uint32Array(chunks.length + 1), nameStart = new Uint32Array(chunks.length + 1);
  const chunkLen = new Uint32Array(chunks.length), fileOfChunk = new Uint32Array(chunks.length);
  const rowTerm: number[] = [], rowTf: number[] = [], nameTerm: number[] = [];
  const overflow = new Map<number, number>();
  const fileNumber = new Map<string, number>();
  const pathStart: number[] = [0], pathTerm: number[] = [];
  chunks.forEach((chunk, index) => {
    const counts = new Map<number, number>();
    for (const term of chunk.terms) {
      const id = dictionary.add(term);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    chunkLen[index] = chunk.terms.length;
    for (const [id, tf] of counts) {
      if (tf >= TF_LIMIT) overflow.set(rowTerm.length, tf);
      rowTerm.push(id);
      rowTf.push(Math.min(tf, TF_LIMIT));
    }
    rowStart[index + 1] = rowTerm.length;
    for (const term of new Set(tokenize(chunk.name))) nameTerm.push(dictionary.add(term));
    nameStart[index + 1] = nameTerm.length;
    let file = fileNumber.get(chunk.path);
    if (file === undefined) {
      file = fileNumber.size;
      fileNumber.set(chunk.path, file);
      for (const term of new Set(tokenize(chunk.path))) pathTerm.push(dictionary.add(term));
      pathStart.push(pathTerm.length);
    }
    fileOfChunk[index] = file;
  });
  return {
    dictionary, chunks, rowStart, rowTerm: Uint32Array.from(rowTerm), rowTf: Uint16Array.from(rowTf), tfOverflow: overflow.size ? overflow : undefined,
    chunkLen, nameStart, nameTerm: Uint32Array.from(nameTerm), fileOfChunk, pathStart: Uint32Array.from(pathStart), pathTerm: Uint32Array.from(pathTerm)
  };
}

export interface RetrieveOptions {
  /** Added once per query term found in a chunk's symbol name, times the term's idf. Default 2. */
  symbolWeight?: number;
  /** Added once per query term found in a chunk's path, times the term's idf. Default 0.4. */
  pathWeight?: number;
  k1?: number;
  b?: number;
  /** Number of results; default 300. Use Infinity for every chunk with a positive score. */
  limit?: number;
  /**
   * Extra score per chunk index, added after all term contributions and before the cut to `limit`
   * (for example the exact-chunk-name-in-query bonus). Chunks listed here join the candidate set.
   */
  bonus?: ReadonlyMap<number, number>;
}

interface Selection { chunk: Chunk; score: number }

export class SearchIndex {
  readonly chunkCount: number;
  readonly termCount: number;
  private readonly rows: RowSet;
  private readonly postStart: Uint32Array;
  private readonly postChunk: Uint32Array;
  private readonly postTf: Uint16Array;
  private postOverflow?: Map<number, number>;
  private readonly nameStart: Uint32Array;
  private readonly nameChunk: Uint32Array;
  private readonly pathStart: Uint32Array;
  private readonly pathChunk: Uint32Array;
  private readonly totalLength: number;
  private readonly norms = new Map<string, Float64Array>();
  private score?: Float64Array;
  private stamp?: Uint32Array;
  private touched?: Uint32Array;
  private generation = 0;
  private chunkStart?: Uint32Array;
  private fileRank?: Uint32Array;
  private names?: Map<string, number[]>;
  private chunkNumbers?: Map<Chunk, number>;

  /** Index over a snapshot's chunks; memoized per snapshot (and per RowSet when the snapshot supplies one). */
  static build(snapshot: Snapshot): SearchIndex {
    let key: object = snapshot;
    let rows = rowSets.get(snapshot);
    if (rows) key = rows;
    let index = indexes.get(key);
    if (!index) {
      index = new SearchIndex(rows ?? rowSetFromChunks(snapshot.chunks));
      indexes.set(key, index);
    }
    indexes.set(snapshot, index);
    return index;
  }

  static fromRows(rows: RowSet): SearchIndex { return new SearchIndex(rows); }

  constructor(rows: RowSet) {
    this.rows = rows;
    this.chunkCount = rows.chunks.length;
    this.termCount = rows.dictionary.size;
    const n = this.chunkCount, terms = this.termCount;
    this.totalLength = rows.chunkLen.reduce((sum, length) => sum + length, 0);

    // Postings: counting-sort transposition of the CSR rows.
    const entries = rows.rowTerm.length;
    this.postStart = new Uint32Array(terms + 1);
    for (let e = 0; e < entries; e++) this.postStart[rows.rowTerm[e] + 1]++;
    for (let t = 0; t < terms; t++) this.postStart[t + 1] += this.postStart[t];
    const cursor = this.postStart.slice(0, terms);
    this.postChunk = new Uint32Array(entries);
    this.postTf = new Uint16Array(entries);
    for (let c = 0; c < n; c++) {
      for (let e = rows.rowStart[c]; e < rows.rowStart[c + 1]; e++) {
        const slot = cursor[rows.rowTerm[e]]++;
        this.postChunk[slot] = c;
        this.postTf[slot] = rows.rowTf[e];
        if (rows.rowTf[e] === TF_LIMIT && rows.tfOverflow?.has(e)) (this.postOverflow ??= new Map()).set(slot, rows.tfOverflow.get(e)!);
      }
    }

    [this.nameStart, this.nameChunk] = this.transposeNames(rows);
    [this.pathStart, this.pathChunk] = this.transposePaths(rows);
  }

  private transposeNames(rows: RowSet): [Uint32Array, Uint32Array] {
    const start = new Uint32Array(this.termCount + 1);
    for (let e = 0; e < rows.nameTerm.length; e++) start[rows.nameTerm[e] + 1]++;
    for (let t = 0; t < this.termCount; t++) start[t + 1] += start[t];
    const cursor = start.slice(0, this.termCount), chunk = new Uint32Array(rows.nameTerm.length);
    for (let c = 0; c < this.chunkCount; c++) for (let e = rows.nameStart[c]; e < rows.nameStart[c + 1]; e++) chunk[cursor[rows.nameTerm[e]]++] = c;
    return [start, chunk];
  }

  private transposePaths(rows: RowSet): [Uint32Array, Uint32Array] {
    const start = new Uint32Array(this.termCount + 1);
    const perChunk = (c: number, visit: (term: number) => void) => {
      const file = rows.fileOfChunk[c];
      for (let e = rows.pathStart[file]; e < rows.pathStart[file + 1]; e++) visit(rows.pathTerm[e]);
    };
    for (let c = 0; c < this.chunkCount; c++) perChunk(c, term => { start[term + 1]++; });
    for (let t = 0; t < this.termCount; t++) start[t + 1] += start[t];
    const cursor = start.slice(0, this.termCount), chunk = new Uint32Array(start[this.termCount]);
    for (let c = 0; c < this.chunkCount; c++) perChunk(c, term => { chunk[cursor[term]++] = c; });
    return [start, chunk];
  }

  get dictionary(): TermDictionary { return this.rows.dictionary; }
  get chunks(): readonly Chunk[] { return this.rows.chunks; }
  chunkAt(index: number): Chunk { return this.rows.chunks[index]; }

  /** Position of a chunk of this index in index order, or -1. */
  indexOf(chunk: Chunk): number {
    if (!this.chunkNumbers) this.chunkNumbers = new Map(this.rows.chunks.map((entry, i) => [entry, i]));
    return this.chunkNumbers.get(chunk) ?? -1;
  }

  /** Number of chunks containing the term (path and symbol-name words count as contained). */
  documentFrequency(term: string): number {
    const id = this.rows.dictionary.idOf(term);
    return id < 0 || id >= this.termCount ? 0 : this.postStart[id + 1] - this.postStart[id];
  }

  /** ln(1 + (n - df + 0.5) / (df + 0.5)), exactly the weight of the baseline lexical ranker. */
  idf(term: string): number { return this.idfFor(this.documentFrequency(term)); }
  private idfFor(df: number): number { return Math.log(1 + (this.chunkCount - df + 0.5) / (df + 0.5)); }

  /** Token count (duplicates included) of a chunk: path words + symbol words + body words. */
  chunkLength(index: number): number { return this.rows.chunkLen[index]; }

  termFrequency(index: number, term: string): number {
    const id = this.rows.dictionary.idOf(term);
    if (id < 0) return 0;
    const { rowStart, rowTerm, rowTf, tfOverflow } = this.rows;
    for (let e = rowStart[index]; e < rowStart[index + 1]; e++) {
      if (rowTerm[e] === id) return rowTf[e] === TF_LIMIT ? tfOverflow?.get(e) ?? TF_LIMIT : rowTf[e];
    }
    return 0;
  }
  hasTerm(index: number, term: string): boolean { return this.termFrequency(index, term) > 0; }

  /** Distinct term ids of a chunk, in row order. */
  termIds(index: number): Uint32Array { return this.rows.rowTerm.subarray(this.rows.rowStart[index], this.rows.rowStart[index + 1]); }

  /** Chunks whose symbol name (length > 2) occurs in the lower-cased query: the baseline exact-name bonus condition. */
  exactNameMatches(query: string): number[] {
    if (!this.names) {
      this.names = new Map();
      this.rows.chunks.forEach((chunk, index) => {
        if (!chunk.name || chunk.name.length <= 2) return;
        const key = chunk.name.toLowerCase();
        const list = this.names!.get(key);
        if (list) list.push(index); else this.names!.set(key, [index]);
      });
    }
    const lower = query.toLowerCase(), matches: number[] = [];
    for (const [name, list] of this.names) if (lower.includes(name)) matches.push(...list);
    return matches.sort((a, b) => a - b);
  }

  private lengthNorm(k1: number, b: number): Float64Array {
    const key = `${k1}|${b}`;
    let norm = this.norms.get(key);
    if (!norm) {
      const average = Math.max(this.totalLength / Math.max(this.chunkCount, 1), 1);
      norm = new Float64Array(this.chunkCount);
      for (let c = 0; c < this.chunkCount; c++) norm[c] = k1 * ((1 - b) + b * this.rows.chunkLen[c] / average);
      this.norms.set(key, norm);
    }
    return norm;
  }

  /** Rank of each file under String.prototype.localeCompare, matching the baseline tie-break on equal scores. */
  private ensureOrder(): void {
    if (this.fileRank) return;
    const { chunks, fileOfChunk } = this.rows;
    this.chunkStart = Uint32Array.from(chunks, chunk => chunk.start);
    const paths: (string | undefined)[] = new Array(this.rows.pathStart.length - 1);
    for (let c = 0; c < chunks.length; c++) paths[fileOfChunk[c]] ??= chunks[c].path;
    const files: number[] = [];
    paths.forEach((path, file) => { if (path !== undefined) files.push(file); });
    files.sort((a, b) => paths[a]!.localeCompare(paths[b]!));
    this.fileRank = new Uint32Array(paths.length);
    let rank = 0;
    files.forEach((file, i) => {
      if (i > 0 && paths[file]!.localeCompare(paths[files[i - 1]]!) !== 0) rank++;
      this.fileRank![file] = rank;
    });
  }

  /**
   * BM25-style stage-1 retrieval with the scoring formula of the baseline `rank()`:
   *   per query term q (unique, in the given order): idf(q) * f * (k1 + 1) / (f + k1 * (1 - b + b * len / avgLen))
   *   + idf(q) * symbolWeight if q is a word of the chunk's symbol name + idf(q) * pathWeight if q is a word of its path.
   * Chunks are accumulated in index order per term, so floating-point sums are reproducible and bit-identical to the
   * baseline. Results are sorted by score, then path (localeCompare), then start line, then index order.
   */
  retrieve(queryTerms: readonly string[], options: RetrieveOptions = {}): Selection[] {
    const symbolWeight = options.symbolWeight ?? 2, pathWeight = options.pathWeight ?? 0.4;
    const k1 = options.k1 ?? 1.2, b = options.b ?? 0.75, limit = options.limit ?? 300;
    const n = this.chunkCount;
    if (!n || limit <= 0) return [];
    this.ensureOrder();
    const norm = this.lengthNorm(k1, b), kPlusOne = k1 + 1;
    const score = (this.score ??= new Float64Array(n)), stamp = (this.stamp ??= new Uint32Array(n)), touched = (this.touched ??= new Uint32Array(n));
    if (++this.generation === 0xffffffff) { stamp.fill(0); this.generation = 1; }
    const generation = this.generation;
    let count = 0;
    const add = (c: number, amount: number) => {
      if (stamp[c] === generation) { score[c] += amount; return; }
      stamp[c] = generation; score[c] = amount; touched[count++] = c;
    };

    const seen = new Set<string>();
    for (const term of queryTerms) {
      if (seen.has(term)) continue;
      seen.add(term);
      const id = this.rows.dictionary.idOf(term);
      if (id < 0 || id >= this.termCount) continue;
      const first = this.postStart[id], last = this.postStart[id + 1];
      const idf = this.idfFor(last - first);
      for (let p = first; p < last; p++) {
        const c = this.postChunk[p];
        let f = this.postTf[p];
        if (f === TF_LIMIT) f = this.postOverflow?.get(p) ?? f;
        add(c, idf * f * kPlusOne / (f + norm[c]));
      }
      for (let p = this.nameStart[id]; p < this.nameStart[id + 1]; p++) add(this.nameChunk[p], idf * symbolWeight);
      for (let p = this.pathStart[id]; p < this.pathStart[id + 1]; p++) add(this.pathChunk[p], idf * pathWeight);
    }
    if (options.bonus) for (const [c, amount] of options.bonus) if (c >= 0 && c < n) add(c, amount);

    const better = (a: number, c: number): boolean => {
      if (score[a] !== score[c]) return score[a] > score[c];
      const fileA = this.rows.fileOfChunk[a], fileC = this.rows.fileOfChunk[c];
      if (fileA !== fileC && this.fileRank![fileA] !== this.fileRank![fileC]) return this.fileRank![fileA] < this.fileRank![fileC];
      if (this.chunkStart![a] !== this.chunkStart![c]) return this.chunkStart![a] < this.chunkStart![c];
      return a < c;
    };
    const winners = selectBest(touched, count, Math.min(limit, count), c => score[c] > 0, better);
    return winners.map(c => ({ chunk: this.rows.chunks[c], score: score[c] }));
  }
}

/** Best `k` items (by `better`) among items[0..count) accepted by `keep`, returned best first. */
function selectBest(items: Uint32Array, count: number, k: number, keep: (item: number) => boolean, better: (a: number, b: number) => boolean): number[] {
  const heap: number[] = [];
  // Min-heap on `better`: the root is the worst item currently kept.
  const worseThan = (a: number, c: number) => better(c, a);
  const siftDown = (start: number) => {
    let i = start;
    for (;;) {
      const left = 2 * i + 1, right = left + 1;
      let worst = i;
      if (left < heap.length && worseThan(heap[left], heap[worst])) worst = left;
      if (right < heap.length && worseThan(heap[right], heap[worst])) worst = right;
      if (worst === i) return;
      [heap[i], heap[worst]] = [heap[worst], heap[i]];
      i = worst;
    }
  };
  for (let i = 0; i < count; i++) {
    const item = items[i];
    if (!keep(item)) continue;
    if (heap.length < k) {
      heap.push(item);
      for (let child = heap.length - 1; child > 0;) {
        const parent = (child - 1) >> 1;
        if (!worseThan(heap[child], heap[parent])) break;
        [heap[child], heap[parent]] = [heap[parent], heap[child]];
        child = parent;
      }
    } else if (k > 0 && better(item, heap[0])) {
      heap[0] = item;
      siftDown(0);
    }
  }
  return heap.sort((a, c) => (better(a, c) ? -1 : better(c, a) ? 1 : 0));
}
