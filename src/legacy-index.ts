import { terms } from './tokenize.js';
import type { Chunk, Snapshot } from './types.js';

export interface RetrieveOptions {
  symbolWeight?: number;
  pathWeight?: number;
  k1?: number;
  b?: number;
  limit?: number;
}

export interface WeightedTerm {
  term: string;
  weight: number;
}

export interface Retrieved {
  chunk: Chunk;
  score: number;
}

const cache = new WeakMap<Snapshot, SearchIndex>();

/**
 * Inverted index over the chunks of a snapshot with the same scoring formula as the 2.1.0 ranker
 * (BM25-style saturation, a bonus for terms in the symbol name and a smaller one for terms in the path),
 * but evaluated through postings lists instead of a scan over every chunk.
 */
export class SearchIndex {
  readonly chunkCount: number;
  private readonly postings = new Map<string, { docs: number[]; tf: number[] }>();
  private readonly lengths: Float64Array;
  private readonly averageLength: number;
  private readonly nameTerms = new Map<number, Set<string>>();
  private readonly pathTerms = new Map<string, Set<string>>();

  private constructor(readonly chunks: readonly Chunk[]) {
    this.chunkCount = chunks.length;
    this.lengths = new Float64Array(chunks.length);
    let total = 0;
    chunks.forEach((chunk, doc) => {
      const counts = new Map<string, number>();
      const chunkTerms = chunk.terms;
      for (const term of chunkTerms) counts.set(term, (counts.get(term) ?? 0) + 1);
      for (const [term, count] of counts) {
        let list = this.postings.get(term);
        if (!list) this.postings.set(term, (list = { docs: [], tf: [] }));
        list.docs.push(doc);
        list.tf.push(count);
      }
      this.lengths[doc] = chunkTerms.length;
      total += chunkTerms.length;
    });
    this.averageLength = total / Math.max(chunks.length, 1);
  }

  static build(snapshot: Snapshot): SearchIndex {
    let index = cache.get(snapshot);
    if (!index) cache.set(snapshot, (index = new SearchIndex(snapshot.chunks)));
    return index;
  }

  documentFrequency(term: string): number {
    return this.postings.get(term)?.docs.length ?? 0;
  }

  idf(term: string): number {
    const df = this.documentFrequency(term);
    return Math.log(1 + (this.chunkCount - df + 0.5) / (df + 0.5));
  }

  private namesOf(doc: number): Set<string> {
    let names = this.nameTerms.get(doc);
    if (!names) this.nameTerms.set(doc, (names = new Set(terms(this.chunks[doc].name))));
    return names;
  }

  private pathsOf(path: string): Set<string> {
    let set = this.pathTerms.get(path);
    if (!set) this.pathTerms.set(path, (set = new Set(terms(path))));
    return set;
  }

  retrieve(query: readonly (string | WeightedTerm)[], options: RetrieveOptions = {}): Retrieved[] {
    const { symbolWeight = 2, pathWeight = 0.4, k1 = 1.2, b = 0.75, limit = 300 } = options;
    const scores = new Float64Array(this.chunkCount);
    const touched: number[] = [];
    const seen = new Set<string>();
    for (const entry of query) {
      const term = typeof entry === 'string' ? entry : entry.term;
      const weight = typeof entry === 'string' ? 1 : entry.weight;
      if (seen.has(term)) continue;
      seen.add(term);
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = this.idf(term);
      for (let i = 0; i < list.docs.length; i++) {
        const doc = list.docs[i];
        const f = list.tf[i];
        let gain = (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * this.lengths[doc]) / Math.max(this.averageLength, 1)));
        if (this.namesOf(doc).has(term)) gain += idf * symbolWeight;
        if (this.pathsOf(this.chunks[doc].path).has(term)) gain += idf * pathWeight;
        if (scores[doc] === 0) touched.push(doc);
        scores[doc] += gain * weight;
      }
    }
    const rows = touched.filter(doc => scores[doc] > 0).map(doc => ({ chunk: this.chunks[doc], score: scores[doc] }));
    rows.sort((x, y) => y.score - x.score || x.chunk.path.localeCompare(y.chunk.path) || x.chunk.start - y.chunk.start);
    return rows.slice(0, limit);
  }
}
