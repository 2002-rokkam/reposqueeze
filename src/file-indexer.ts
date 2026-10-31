// Per-file indexing: parse a file (black-box `parseSource`) and turn its chunks into dictionary-ready term rows.
// Pure and self-contained so it can run on the main thread or inside a worker thread.
import { languageFor, parseSource } from './parser.js';
import { terms as tokenize } from './tokenize.js';
import type { Chunk } from './types.js';

/** What indexing one file yields. Term ids are local to the file (`localTerms[id]`); the table maps them to global ids. */
export interface FileIndexResult {
  language: string;
  parsed: boolean;
  lines: number;
  /** Unknown fields of the parse result besides `chunks`/`parsed` (for example `generated`), JSON-normalized. */
  fileExtras?: Record<string, unknown>;
  chunkCount: number;
  starts: Uint32Array;
  ends: Uint32Array;
  ids: string[];
  names: string[];
  kinds: string[];
  refs: string[][];
  /** Unknown optional chunk fields (signature, scope, doc, ...) by chunk number, JSON-normalized. */
  chunkExtras?: [number, Record<string, unknown>][];
  /** Chunks whose text is not the exact line range of the file text (kept verbatim). */
  textOverrides?: [number, string][];
  localTerms: string[];
  chunkLen: Uint32Array;
  rowStart: Uint32Array;
  rowTerm: Uint32Array;
  rowTf: Uint16Array;
  tfOverflow?: [number, number][];
  nameStart: Uint32Array;
  nameTerm: Uint32Array;
  pathTerm: Uint32Array;
}

const KNOWN_CHUNK_FIELDS = new Set(['id', 'path', 'start', 'end', 'name', 'kind', 'text', 'terms', 'refs']);
const KNOWN_RESULT_FIELDS = new Set(['chunks', 'parsed']);
const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const FORBIDDEN_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const TF_LIMIT = 0xffff;

/** Field names a persisted record may restore onto a chunk or file object. */
export function isSafeFieldName(name: string): boolean {
  return SAFE_FIELD_NAME.test(name) && !FORBIDDEN_FIELD_NAMES.has(name) && !KNOWN_CHUNK_FIELDS.has(name);
}

function extraFields(source: object, known: ReadonlySet<string>): Record<string, unknown> | undefined {
  let extras: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(source)) {
    if (known.has(key) || !isSafeFieldName(key) || value === undefined || typeof value === 'function' || typeof value === 'symbol') continue;
    try {
      // Normalize exactly like the cache will, so cold and warm runs expose identical values.
      const normalized = JSON.parse(JSON.stringify(value)) as unknown;
      if (normalized !== undefined) (extras ??= {})[key] = normalized;
    } catch { /* not representable in the cache: dropped */ }
  }
  return extras;
}

export function lineStarts(text: string): Int32Array {
  let count = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
  const starts = new Int32Array(count);
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts[line++] = at + 1;
  return starts;
}

/**
 * Parses `text` and builds the term rows of every chunk.
 *
 * A chunk's row is the multiset of tokens of `${path} ${name} ${text}` (the baseline chunk.terms). Tokenization never
 * crosses a line break, so each distinct line range between chunk boundaries is tokenized once and the per-chunk counts
 * are sums of those segments; chunks overlap heavily, which makes this about twice as cheap as tokenizing every chunk.
 */
export async function indexFile(path: string, text: string): Promise<FileIndexResult> {
  const parse = await parseSource(path, text);
  const result = parse as unknown as Record<string, unknown>;
  const starts = lineStarts(text), lineCount = starts.length;
  const sliceLines = (first: number, last: number) => text.slice(starts[first - 1], last < lineCount ? starts[last] - 1 : text.length);

  const chunks = (parse.chunks as Chunk[]).filter(chunk => Number.isInteger(chunk.start) && Number.isInteger(chunk.end) && chunk.start >= 1 && chunk.end >= chunk.start && chunk.end <= lineCount);
  const localIds = new Map<string, number>(), localTerms: string[] = [];
  const idOf = (term: string) => {
    let id = localIds.get(term);
    if (id === undefined) { id = localTerms.length; localIds.set(term, id); localTerms.push(term); }
    return id;
  };
  const pathIds = tokenize(path).map(idOf);
  const overrides: [number, string][] = [];
  const nameIds = chunks.map(chunk => tokenize(String(chunk.name ?? '')).map(idOf));
  const bodyIds: (number[] | undefined)[] = chunks.map((chunk, i) => {
    if (chunk.text === sliceLines(chunk.start, chunk.end)) return undefined;
    overrides.push([i, chunk.text]);
    return tokenize(chunk.text).map(idOf);
  });

  // Segments: maximal line ranges between consecutive chunk boundaries that some chunk covers.
  const boundaries = [...new Set(chunks.flatMap(chunk => [chunk.start, chunk.end + 1]))].sort((a, b) => a - b);
  const boundaryIndex = new Map(boundaries.map((line, i) => [line, i]));
  const coverage = new Int32Array(boundaries.length + 1);
  for (const chunk of chunks) { coverage[boundaryIndex.get(chunk.start)!]++; coverage[boundaryIndex.get(chunk.end + 1)!]--; }
  const segments: (Uint32Array | undefined)[] = new Array(Math.max(boundaries.length - 1, 0));
  for (let i = 0, covered = 0; i < segments.length; i++) {
    covered += coverage[i];
    if (covered > 0) segments[i] = Uint32Array.from(tokenize(sliceLines(boundaries[i], boundaries[i + 1] - 1)), idOf);
  }

  const counts = new Uint32Array(localTerms.length);
  const touched: number[] = [];
  const bump = (id: number) => { if (counts[id]++ === 0) touched.push(id); };
  const rowStart = new Uint32Array(chunks.length + 1), nameStart = new Uint32Array(chunks.length + 1), chunkLen = new Uint32Array(chunks.length);
  const rowTerm: number[] = [], rowTf: number[] = [], nameTerm: number[] = [], overflow: [number, number][] = [];
  chunks.forEach((chunk, i) => {
    let length = pathIds.length + nameIds[i].length;
    for (const id of pathIds) bump(id);
    for (const id of nameIds[i]) bump(id);
    const body = bodyIds[i];
    if (body) {
      length += body.length;
      for (const id of body) bump(id);
    } else {
      for (let s = boundaryIndex.get(chunk.start)!, last = boundaryIndex.get(chunk.end + 1)!; s < last; s++) {
        const ids = segments[s]!;
        length += ids.length;
        for (let k = 0; k < ids.length; k++) bump(ids[k]);
      }
    }
    for (const id of touched) {
      const tf = counts[id];
      counts[id] = 0;
      if (tf >= TF_LIMIT) overflow.push([rowTerm.length, tf]);
      rowTerm.push(id);
      rowTf.push(Math.min(tf, TF_LIMIT));
    }
    touched.length = 0;
    chunkLen[i] = length;
    rowStart[i + 1] = rowTerm.length;
    for (const id of new Set(nameIds[i])) nameTerm.push(id);
    nameStart[i + 1] = nameTerm.length;
  });

  const chunkExtras: [number, Record<string, unknown>][] = [];
  chunks.forEach((chunk, i) => {
    const extras = extraFields(chunk, KNOWN_CHUNK_FIELDS);
    if (extras) chunkExtras.push([i, extras]);
  });

  return {
    language: languageFor(path),
    parsed: !!parse.parsed,
    lines: lineCount,
    fileExtras: extraFields(result, KNOWN_RESULT_FIELDS),
    chunkCount: chunks.length,
    starts: Uint32Array.from(chunks, chunk => chunk.start),
    ends: Uint32Array.from(chunks, chunk => chunk.end),
    ids: chunks.map(chunk => String(chunk.id)),
    names: chunks.map(chunk => String(chunk.name ?? '')),
    kinds: chunks.map(chunk => String(chunk.kind ?? '')),
    refs: chunks.map(chunk => Array.isArray(chunk.refs) ? chunk.refs.filter(ref => typeof ref === 'string') : []),
    chunkExtras: chunkExtras.length ? chunkExtras : undefined,
    textOverrides: overrides.length ? overrides : undefined,
    localTerms,
    chunkLen,
    rowStart,
    rowTerm: Uint32Array.from(rowTerm),
    rowTf: Uint16Array.from(rowTf),
    tfOverflow: overflow.length ? overflow : undefined,
    nameStart,
    nameTerm: Uint32Array.from(nameTerm),
    pathTerm: Uint32Array.from(new Set(pathIds))
  };
}
