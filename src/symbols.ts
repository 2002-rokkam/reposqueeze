import { signatureOf } from './pack.js';
import { fit, tokens } from './tokens.js';
import type { Chunk, Snapshot } from './types.js';

export interface SymbolHit {
  path: string;
  start: number;
  end: number;
  name: string;
  kind: string;
  signature: string;
}

const CONTAINER_KIND = /class|interface|struct|enum|trait|module|namespace|impl|type/i;
const KIND_RANK = (kind: string) => (CONTAINER_KIND.test(kind) ? 0 : /function|method|def/i.test(kind) ? 1 : 2);

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const nameIndexes = new WeakMap<Snapshot, { key: string; chunks: Chunk[] }[]>();

function definitions(snapshot: Snapshot) {
  let index = nameIndexes.get(snapshot);
  if (!index) {
    const byKey = new Map<string, Chunk[]>();
    for (const chunk of snapshot.chunks) {
      if (chunk.kind === 'window' || !chunk.name) continue;
      const key = normalize(chunk.name);
      if (!key) continue;
      const list = byKey.get(key);
      if (list) list.push(chunk); else byKey.set(key, [chunk]);
    }
    index = [...byKey].map(([key, chunks]) => ({ key, chunks }));
    nameIndexes.set(snapshot, index);
  }
  return index;
}

/** Long definitions are indexed as overlapping pieces; keep one hit per (path, name, kind) spanning all pieces. */
function mergePieces(chunks: readonly Chunk[]): Chunk[] {
  const merged = new Map<string, Chunk>();
  for (const chunk of chunks) {
    const key = `${chunk.path}\0${chunk.name}\0${chunk.kind}\0${chunk.start}`;
    const sameStart = merged.get(key);
    if (sameStart) continue;
    const chained = [...merged.values()].find(other => other.path === chunk.path && other.name === chunk.name && other.kind === chunk.kind && chunk.start <= other.end + 1 && chunk.start > other.start);
    if (chained) merged.set(`${chained.path}\0${chained.name}\0${chained.kind}\0${chained.start}`, { ...chained, end: Math.max(chained.end, chunk.end) });
    else merged.set(key, chunk);
  }
  return [...merged.values()];
}

/** Definitions whose name equals, starts with or contains one of the words of the query; best matches first. */
export function findSymbols(snapshot: Snapshot, query: string, limit = 20): SymbolHit[] {
  const words = [...new Set(query.split(/[\s,;()]+/).map(normalize).filter(word => word.length >= 2))].slice(0, 12);
  if (!words.length) return [];
  const rows: { chunk: Chunk; score: number }[] = [];
  for (const { key, chunks } of definitions(snapshot)) {
    let score = 0;
    for (const word of words) {
      if (key === word) score = Math.max(score, 100);
      else if (key.startsWith(word)) score = Math.max(score, 60 - Math.min(20, key.length - word.length));
      else if (word.length >= 3 && key.includes(word)) score = Math.max(score, 30 - Math.min(15, key.length - word.length));
    }
    if (score > 0) for (const chunk of mergePieces(chunks)) rows.push({ chunk, score });
  }
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      KIND_RANK(a.chunk.kind) - KIND_RANK(b.chunk.kind) ||
      a.chunk.path.split('/').length - b.chunk.path.split('/').length ||
      a.chunk.path.localeCompare(b.chunk.path) ||
      a.chunk.start - b.chunk.start,
  );
  return rows.slice(0, limit).map(({ chunk }) => ({ path: chunk.path, start: chunk.start, end: chunk.end, name: chunk.name, kind: chunk.kind, signature: signatureOf(chunk) }));
}

export function renderSymbols(hits: readonly SymbolHit[], budget: number): string {
  if (!hits.length) return 'No definition with a matching name. Use context(query) for text search.';
  return fit(hits.map(hit => `${hit.path}:${hit.start}-${hit.end}  ${hit.signature}`).join('\n'), budget, '\n[more matches omitted]');
}

/** Indented list of the definitions of one file with their line ranges: the cheapest way to see what a file contains. */
export function renderOutline(path: string, chunks: readonly Chunk[], lineCount: number, budget: number): string {
  const defs = mergePieces(chunks.filter(chunk => chunk.path === path && chunk.kind !== 'window' && chunk.name)).sort((a, b) => a.start - b.start || b.end - a.end);
  const header = `${path} · ${lineCount} lines`;
  if (!defs.length) return `${header}\nno definitions indexed (plain text or unsupported language); use expand(path,start,end).`;
  const open: Chunk[] = [];
  const lines = [header];
  for (const def of defs) {
    while (open.length && open[open.length - 1].end < def.start) open.pop();
    lines.push(`${'  '.repeat(open.length)}${def.start}-${def.end}  ${signatureOf(def).slice(0, 110)}`);
    open.push(def);
  }
  const text = lines.join('\n');
  return tokens(text) <= budget ? text : fit(text, budget, '\n[outline truncated; narrow with expand(path,start,end)]');
}
