// Columnar table of indexed files: per-file metadata, per-chunk metadata and dictionary-coded term rows, plus the
// lazily materialized Chunk/SourceFile objects handed to callers. Everything is typed arrays so that loading a cache
// file is a handful of views over one buffer and nothing proportional to the source size stays in memory.
import { isSafeFieldName, lineStarts, type FileIndexResult } from './file-indexer.js';
import { TermDictionary, type RowSet } from './search-index.js';
import { CacheCorruptError, decodeContainer, encodeContainer } from './store.js';
import { terms as tokenize } from './tokenize.js';
import type { Chunk, SourceFile } from './types.js';

const TABLE_MAGIC = 'RSQINDEX';
const TF_LIMIT = 0xffff;
const MAX_EXTRA_RECORDS = 5_000_000;

/** Append-only string table (ids are stable); stored strings are decoded lazily from one UTF-8 blob. */
export class StringTable {
  private blob: Buffer = Buffer.alloc(0);
  private offsets: Uint32Array = new Uint32Array(1);
  private stored = 0;
  private readonly decoded = new Map<number, string>();
  private readonly added: string[] = [];
  private lookup?: Map<string, number>;

  /** Id 0 is always the empty string. */
  constructor(seedEmpty = true) { if (seedEmpty) this.added.push(''); }

  get size(): number { return this.stored + this.added.length; }

  /** Decodes without remembering the result (for values that are unique anyway, such as chunk ids). */
  read(id: number): string {
    return id < this.stored ? this.blob.toString('utf8', this.offsets[id], this.offsets[id + 1]) : this.added[id - this.stored];
  }

  get(id: number): string {
    if (id >= this.stored) return this.added[id - this.stored];
    let value = this.decoded.get(id);
    if (value === undefined) { value = this.read(id); this.decoded.set(id, value); }
    return value;
  }

  /** Id of `value`, appending it when new. */
  add(value: string): number {
    if (!this.lookup) {
      this.lookup = new Map();
      for (let id = 0; id < this.size; id++) this.lookup.set(this.read(id), id);
    }
    let id = this.lookup.get(value);
    if (id === undefined) { id = this.size; this.added.push(value); this.lookup.set(value, id); }
    return id;
  }

  /** Appends without deduplication (chunk ids are unique, so a lookup entry would only cost memory). */
  addUnique(value: string): number {
    this.added.push(value);
    return this.size - 1;
  }

  serialize(): { blob: Uint8Array; offsets: Uint32Array } {
    const encoded = this.added.map(value => Buffer.from(value, 'utf8'));
    const storedBytes = this.stored ? this.offsets[this.stored] : 0;
    const blob = Buffer.allocUnsafe(storedBytes + encoded.reduce((sum, buffer) => sum + buffer.length, 0));
    this.blob.copy(blob, 0, 0, storedBytes);
    const offsets = new Uint32Array(this.size + 1);
    offsets.set(this.offsets.subarray(0, this.stored + 1));
    let cursor = storedBytes;
    encoded.forEach((buffer, i) => { buffer.copy(blob, cursor); cursor += buffer.length; offsets[this.stored + i + 1] = cursor; });
    return { blob, offsets };
  }

  static fromSerialized(blob: Uint8Array, offsets: Uint32Array): StringTable {
    const count = offsets.length - 1;
    if (count < 1 || offsets[0] !== 0 || offsets[count] !== blob.length || offsets[1] !== 0) throw new RangeError('bad string offsets');
    for (let i = 0; i < count; i++) if (offsets[i + 1] < offsets[i]) throw new RangeError('string offsets not monotonic');
    const table = new StringTable(false);
    table.blob = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
    table.offsets = offsets;
    table.stored = count;
    return table;
  }
}

export interface FileMeta {
  path: string;
  /** sha256 (hex) of the raw file bytes. */
  hash: string;
  size: number;
  mtimeMs: number;
  /** Exact o200k_base token count of "--- path ---\n" + text, or -1 when not computed. */
  tokenCount: number;
}

export type TableItem = { source: FileTable; file: number } | { meta: FileMeta; result: FileIndexResult };

/** One file's columns with global ids, ready to be copied into a new table. */
interface FileBlock {
  path: string;
  hash: Uint8Array;
  size: number;
  mtimeMs: number;
  language: number;
  lines: number;
  flags: number;
  tokenCount: number;
  chunkCount: number;
  starts: Uint32Array;
  ends: Uint32Array;
  ids: Uint32Array;
  names: Uint32Array;
  kinds: Uint32Array;
  chunkLen: Uint32Array;
  rowStart: Uint32Array;
  rowBase: number;
  rowTerm: Uint32Array;
  rowTf: Uint16Array;
  nameStart: Uint32Array;
  nameBase: number;
  nameTerm: Uint32Array;
  refStart: Uint32Array;
  refBase: number;
  refIds: Uint32Array;
  pathTerm: Uint32Array;
  overflow: [number, number][];
  chunkExtras: [number, Record<string, unknown>][];
  textOverrides: [number, string][];
  fileExtras?: Record<string, unknown>;
}

export class FileTable {
  paths: string[] = [];
  hashes = new Uint8Array(0);
  sizes = new Float64Array(0);
  mtimes = new Float64Array(0);
  languages = new Uint32Array(0);
  lines = new Uint32Array(0);
  flags = new Uint8Array(0);
  tokenCounts = new Float64Array(0);
  chunkFirst = new Uint32Array(1);
  pathTermStart = new Uint32Array(1);
  pathTerms = new Uint32Array(0);
  fileExtras = new Map<number, Record<string, unknown>>();

  starts = new Uint32Array(0);
  ends = new Uint32Array(0);
  idStrings = new Uint32Array(0);
  nameStrings = new Uint32Array(0);
  kindStrings = new Uint32Array(0);
  chunkLen = new Uint32Array(0);
  rowStart = new Uint32Array(1);
  rowTerm = new Uint32Array(0);
  rowTf = new Uint16Array(0);
  tfOverflow = new Map<number, number>();
  nameStart = new Uint32Array(1);
  nameTerm = new Uint32Array(0);
  refStart = new Uint32Array(1);
  refIds = new Uint32Array(0);
  chunkExtras = new Map<number, Record<string, unknown>>();
  textOverrides = new Map<number, string>();

  private pathIndex?: Map<string, number>;
  private materialized?: { cache: TextCache; files: IndexedFile[]; chunks: IndexedChunk[]; rows: RowSet };

  constructor(readonly dictionary: TermDictionary, readonly strings: StringTable) {}

  get fileCount(): number { return this.paths.length; }
  get chunkCount(): number { return this.starts.length; }

  /** File number of a path, or -1. */
  fileOf(path: string): number {
    if (!this.pathIndex) this.pathIndex = new Map(this.paths.map((entry, i) => [entry, i]));
    return this.pathIndex.get(path) ?? -1;
  }

  hashHex(file: number): string { return Buffer.from(this.hashes.buffer, this.hashes.byteOffset + file * 32, 32).toString('hex'); }

  refStrings(chunk: number): string[] {
    const out: string[] = [];
    for (let e = this.refStart[chunk]; e < this.refStart[chunk + 1]; e++) out.push(this.strings.get(this.refIds[e]));
    return out;
  }

  static empty(dictionary = new TermDictionary(), strings = new StringTable()): FileTable { return new FileTable(dictionary, strings); }

  /** New table made of whole files taken from existing tables (same dictionary and strings) or freshly indexed. */
  static assemble(dictionary: TermDictionary, strings: StringTable, items: readonly TableItem[]): FileTable {
    const blocks = items.map(item => 'source' in item ? blockFromTable(item.source, item.file, dictionary, strings) : blockFromResult(item.meta, item.result, dictionary, strings));
    const table = new FileTable(dictionary, strings);
    const files = blocks.length;
    let chunks = 0, entries = 0, names = 0, refs = 0, pathTerms = 0;
    for (const block of blocks) {
      chunks += block.chunkCount; entries += block.rowTerm.length; names += block.nameTerm.length; refs += block.refIds.length; pathTerms += block.pathTerm.length;
    }
    table.paths = blocks.map(block => block.path);
    table.hashes = new Uint8Array(files * 32);
    table.sizes = new Float64Array(files);
    table.mtimes = new Float64Array(files);
    table.languages = new Uint32Array(files);
    table.lines = new Uint32Array(files);
    table.flags = new Uint8Array(files);
    table.tokenCounts = new Float64Array(files);
    table.chunkFirst = new Uint32Array(files + 1);
    table.pathTermStart = new Uint32Array(files + 1);
    table.pathTerms = new Uint32Array(pathTerms);
    table.starts = new Uint32Array(chunks);
    table.ends = new Uint32Array(chunks);
    table.idStrings = new Uint32Array(chunks);
    table.nameStrings = new Uint32Array(chunks);
    table.kindStrings = new Uint32Array(chunks);
    table.chunkLen = new Uint32Array(chunks);
    table.rowStart = new Uint32Array(chunks + 1);
    table.rowTerm = new Uint32Array(entries);
    table.rowTf = new Uint16Array(entries);
    table.nameStart = new Uint32Array(chunks + 1);
    table.nameTerm = new Uint32Array(names);
    table.refStart = new Uint32Array(chunks + 1);
    table.refIds = new Uint32Array(refs);
    let chunkCursor = 0, entryCursor = 0, nameCursor = 0, refCursor = 0, pathCursor = 0;
    blocks.forEach((block, file) => {
      table.hashes.set(block.hash, file * 32);
      table.sizes[file] = block.size;
      table.mtimes[file] = block.mtimeMs;
      table.languages[file] = block.language;
      table.lines[file] = block.lines;
      table.flags[file] = block.flags;
      table.tokenCounts[file] = block.tokenCount;
      table.chunkFirst[file] = chunkCursor;
      table.pathTermStart[file] = pathCursor;
      table.pathTerms.set(block.pathTerm, pathCursor);
      pathCursor += block.pathTerm.length;
      if (block.fileExtras) table.fileExtras.set(file, block.fileExtras);
      table.starts.set(block.starts, chunkCursor);
      table.ends.set(block.ends, chunkCursor);
      table.idStrings.set(block.ids, chunkCursor);
      table.nameStrings.set(block.names, chunkCursor);
      table.kindStrings.set(block.kinds, chunkCursor);
      table.chunkLen.set(block.chunkLen, chunkCursor);
      for (let i = 0; i < block.chunkCount; i++) {
        table.rowStart[chunkCursor + i] = entryCursor + block.rowStart[i] - block.rowBase;
        table.nameStart[chunkCursor + i] = nameCursor + block.nameStart[i] - block.nameBase;
        table.refStart[chunkCursor + i] = refCursor + block.refStart[i] - block.refBase;
      }
      table.rowTerm.set(block.rowTerm, entryCursor);
      table.rowTf.set(block.rowTf, entryCursor);
      table.nameTerm.set(block.nameTerm, nameCursor);
      table.refIds.set(block.refIds, refCursor);
      for (const [entry, tf] of block.overflow) table.tfOverflow.set(entryCursor + entry, tf);
      for (const [chunk, extras] of block.chunkExtras) table.chunkExtras.set(chunkCursor + chunk, extras);
      for (const [chunk, text] of block.textOverrides) table.textOverrides.set(chunkCursor + chunk, text);
      chunkCursor += block.chunkCount; entryCursor += block.rowTerm.length; nameCursor += block.nameTerm.length; refCursor += block.refIds.length;
    });
    table.chunkFirst[files] = chunks;
    table.pathTermStart[files] = pathTerms;
    table.rowStart[chunks] = entries;
    table.nameStart[chunks] = names;
    table.refStart[chunks] = refs;
    return table;
  }

  /** Subset/reordering of this table's files as a new table that shares the dictionary and strings. */
  select(files: readonly number[]): FileTable {
    return FileTable.assemble(this.dictionary, this.strings, files.map(file => ({ source: this, file })));
  }

  /** Rows for SearchIndex over this table's chunks (one entry per chunk of `chunks`, in table order). */
  rowSet(chunks: readonly Chunk[]): RowSet {
    const fileOfChunk = new Uint32Array(this.chunkCount);
    for (let file = 0; file < this.fileCount; file++) fileOfChunk.fill(file, this.chunkFirst[file], this.chunkFirst[file + 1]);
    return {
      dictionary: this.dictionary, chunks, rowStart: this.rowStart, rowTerm: this.rowTerm, rowTf: this.rowTf,
      tfOverflow: this.tfOverflow.size ? this.tfOverflow : undefined, chunkLen: this.chunkLen,
      nameStart: this.nameStart, nameTerm: this.nameTerm, fileOfChunk, pathStart: this.pathTermStart, pathTerm: this.pathTerms
    };
  }

  /** SourceFile/Chunk objects (and index rows) over this table; memoized so identical snapshots share them. */
  materialize(cache: TextCache): { cache: TextCache; files: IndexedFile[]; chunks: IndexedChunk[]; rows: RowSet } {
    if (this.materialized?.cache === cache) return this.materialized;
    const files: IndexedFile[] = [], chunks: IndexedChunk[] = [];
    for (let f = 0; f < this.fileCount; f++) {
      const extras = this.fileExtras.get(f);
      const file = new IndexedFile(this.paths[f], this.hashHex(f), this.strings.get(this.languages[f]), (this.flags[f] & 1) === 1, this.lines[f], this.sizes[f], cache);
      if (extras) assignSafe(file, extras);
      for (let c = this.chunkFirst[f]; c < this.chunkFirst[f + 1]; c++) {
        const chunk = new IndexedChunk(this.strings.read(this.idStrings[c]), this.paths[f], this.starts[c], this.ends[c], this.strings.get(this.nameStrings[c]), this.strings.get(this.kindStrings[c]), file, this, c);
        const chunkExtras = this.chunkExtras.get(c);
        if (chunkExtras) assignSafe(chunk, chunkExtras);
        file.chunks.push(chunk);
        chunks.push(chunk);
      }
      files.push(file);
    }
    return (this.materialized = { cache, files, chunks, rows: this.rowSet(chunks) });
  }

  /**
   * Table without terms/strings that no row references (the dictionary only ever grows), or `this` when fewer than
   * a quarter of the entries are dead. The result owns a fresh dictionary and string table.
   */
  compacted(): FileTable {
    const usedTerms = new Uint8Array(this.dictionary.size), usedStrings = new Uint8Array(this.strings.size);
    for (const term of this.rowTerm) usedTerms[term] = 1;
    for (const term of this.nameTerm) usedTerms[term] = 1;
    for (const term of this.pathTerms) usedTerms[term] = 1;
    usedStrings[0] = 1;
    for (const array of [this.languages, this.idStrings, this.nameStrings, this.kindStrings, this.refIds]) for (const id of array) usedStrings[id] = 1;
    const liveTerms = usedTerms.reduce((sum, flag) => sum + flag, 0), liveStrings = usedStrings.reduce((sum, flag) => sum + flag, 0);
    if (liveTerms * 4 >= this.dictionary.size * 3 && liveStrings * 4 >= this.strings.size * 3) return this;
    const dictionary = new TermDictionary(), strings = new StringTable();
    const termMap = new Uint32Array(this.dictionary.size), stringMap = new Uint32Array(this.strings.size);
    for (let id = 0; id < usedTerms.length; id++) if (usedTerms[id]) termMap[id] = dictionary.add(this.dictionary.termOf(id));
    for (let id = 1; id < usedStrings.length; id++) if (usedStrings[id]) stringMap[id] = strings.addUnique(this.strings.read(id));
    const copy = new FileTable(dictionary, strings);
    Object.assign(copy, this, { dictionary, strings, pathIndex: undefined, materialized: undefined });
    const remap = (source: Uint32Array, map: Uint32Array) => Uint32Array.from(source, id => map[id]);
    copy.rowTerm = remap(this.rowTerm, termMap);
    copy.nameTerm = remap(this.nameTerm, termMap);
    copy.pathTerms = remap(this.pathTerms, termMap);
    copy.languages = remap(this.languages, stringMap);
    copy.idStrings = remap(this.idStrings, stringMap);
    copy.nameStrings = remap(this.nameStrings, stringMap);
    copy.kindStrings = remap(this.kindStrings, stringMap);
    copy.refIds = remap(this.refIds, stringMap);
    return copy;
  }

  serialize(versions: unknown, options: { compress?: boolean } = {}): Uint8Array[] {
    const dictionary = this.dictionary.serialize(), strings = this.strings.serialize();
    const header = {
      kind: 'index', versions, files: this.fileCount, chunks: this.chunkCount, entries: this.rowTerm.length, nameEntries: this.nameTerm.length,
      refEntries: this.refIds.length, pathTerms: this.pathTerms.length, terms: this.dictionary.size, strings: this.strings.size,
      fileExtras: [...this.fileExtras], chunkExtras: [...this.chunkExtras], textOverrides: [...this.textOverrides], tfOverflow: [...this.tfOverflow]
    };
    const sections = [
      ['paths', Buffer.from(this.paths.join('\n'), 'utf8')], ['fHash', this.hashes], ['fSize', this.sizes], ['fMtime', this.mtimes], ['fLang', this.languages],
      ['fLines', this.lines], ['fFlags', this.flags], ['fTokens', this.tokenCounts], ['fChunk', this.chunkFirst], ['fPathS', this.pathTermStart], ['fPathT', this.pathTerms],
      ['cStart', this.starts], ['cEnd', this.ends], ['cId', this.idStrings], ['cName', this.nameStrings], ['cKind', this.kindStrings], ['cLen', this.chunkLen],
      ['rowS', this.rowStart], ['rowT', this.rowTerm], ['rowF', this.rowTf], ['nameS', this.nameStart], ['nameT', this.nameTerm], ['refS', this.refStart], ['refI', this.refIds],
      ['tBlob', dictionary.blob], ['tOff', dictionary.offsets], ['tHash', dictionary.hashes], ['tTab', dictionary.table], ['sBlob', strings.blob], ['sOff', strings.offsets]
    ] as const;
    return encodeContainer(TABLE_MAGIC, header, sections.map(([name, data]) => ({ name, data })), options);
  }

  /** Parses and fully validates a cache file. Returns undefined when it was written by incompatible code. */
  static deserialize(file: Buffer, versions: unknown): FileTable | undefined {
    const container = decodeContainer(file, TABLE_MAGIC);
    const header = container.header as Record<string, unknown>;
    if (!header || header.kind !== 'index') throw new CacheCorruptError('not an index file');
    if (JSON.stringify(header.versions) !== JSON.stringify(versions)) return undefined;
    try {
      return readTable(container, header);
    } catch (error) {
      if (error instanceof CacheCorruptError) throw error;
      throw new CacheCorruptError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Cheap statistics of a cache file without validating it (for `cache` summaries). */
  static peek(file: Buffer): { files: number; chunks: number; terms: number } | undefined {
    try {
      const header = decodeContainer(file, TABLE_MAGIC).header as Record<string, unknown>;
      return { files: Number(header.files), chunks: Number(header.chunks), terms: Number(header.terms) };
    } catch { return undefined; }
  }
}

function assignSafe(target: object, extras: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(extras)) if (isSafeFieldName(key)) Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function blockFromTable(table: FileTable, file: number, dictionary: TermDictionary, strings: StringTable): FileBlock {
  if (table.dictionary !== dictionary || table.strings !== strings) throw new Error('tables must share their dictionary and string table');
  const c0 = table.chunkFirst[file], c1 = table.chunkFirst[file + 1];
  const e0 = table.rowStart[c0], e1 = table.rowStart[c1], n0 = table.nameStart[c0], n1 = table.nameStart[c1], r0 = table.refStart[c0], r1 = table.refStart[c1];
  const overflow: [number, number][] = [], chunkExtras: [number, Record<string, unknown>][] = [], textOverrides: [number, string][] = [];
  for (const [entry, tf] of table.tfOverflow) if (entry >= e0 && entry < e1) overflow.push([entry - e0, tf]);
  if (table.chunkExtras.size || table.textOverrides.size) {
    for (let c = c0; c < c1; c++) {
      const extras = table.chunkExtras.get(c), text = table.textOverrides.get(c);
      if (extras) chunkExtras.push([c - c0, extras]);
      if (text !== undefined) textOverrides.push([c - c0, text]);
    }
  }
  return {
    path: table.paths[file], hash: table.hashes.subarray(file * 32, file * 32 + 32), size: table.sizes[file], mtimeMs: table.mtimes[file],
    language: table.languages[file], lines: table.lines[file], flags: table.flags[file], tokenCount: table.tokenCounts[file], chunkCount: c1 - c0,
    starts: table.starts.subarray(c0, c1), ends: table.ends.subarray(c0, c1), ids: table.idStrings.subarray(c0, c1), names: table.nameStrings.subarray(c0, c1),
    kinds: table.kindStrings.subarray(c0, c1), chunkLen: table.chunkLen.subarray(c0, c1),
    rowStart: table.rowStart.subarray(c0, c1 + 1), rowBase: e0, rowTerm: table.rowTerm.subarray(e0, e1), rowTf: table.rowTf.subarray(e0, e1),
    nameStart: table.nameStart.subarray(c0, c1 + 1), nameBase: n0, nameTerm: table.nameTerm.subarray(n0, n1),
    refStart: table.refStart.subarray(c0, c1 + 1), refBase: r0, refIds: table.refIds.subarray(r0, r1),
    pathTerm: table.pathTerms.subarray(table.pathTermStart[file], table.pathTermStart[file + 1]),
    overflow, chunkExtras, textOverrides, fileExtras: table.fileExtras.get(file)
  };
}

function blockFromResult(meta: FileMeta, result: FileIndexResult, dictionary: TermDictionary, strings: StringTable): FileBlock {
  const hash = Buffer.from(meta.hash, 'hex');
  if (hash.length !== 32) throw new Error('file hash must be a sha256 hex digest');
  const termMap = Uint32Array.from(result.localTerms, term => dictionary.add(term));
  const remap = (ids: Uint32Array) => Uint32Array.from(ids, id => termMap[id]);
  const refMap = Uint32Array.from(result.refTable, ref => strings.add(ref));
  return {
    path: meta.path, hash: new Uint8Array(hash), size: meta.size, mtimeMs: meta.mtimeMs, language: strings.add(result.language), lines: result.lines,
    flags: result.parsed ? 1 : 0, tokenCount: meta.tokenCount, chunkCount: result.chunkCount, starts: result.starts, ends: result.ends,
    ids: Uint32Array.from(result.ids, id => strings.addUnique(id)), names: Uint32Array.from(result.names, name => strings.add(name)),
    kinds: Uint32Array.from(result.kinds, kind => strings.add(kind)), chunkLen: result.chunkLen,
    rowStart: result.rowStart, rowBase: 0, rowTerm: remap(result.rowTerm), rowTf: result.rowTf,
    nameStart: result.nameStart, nameBase: 0, nameTerm: remap(result.nameTerm), refStart: result.refStart, refBase: 0, refIds: Uint32Array.from(result.refIds, id => refMap[id]),
    pathTerm: remap(result.pathTerm), overflow: result.tfOverflow ?? [], chunkExtras: result.chunkExtras ?? [], textOverrides: result.textOverrides ?? [], fileExtras: result.fileExtras
  };
}

function readTable(container: ReturnType<typeof decodeContainer>, header: Record<string, unknown>): FileTable {
  const count = (name: string) => {
    const value = header[name];
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0x7fffffff) throw new CacheCorruptError(`bad count ${name}`);
    return value as number;
  };
  const files = count('files'), chunks = count('chunks'), entries = count('entries'), nameEntries = count('nameEntries'), refEntries = count('refEntries');
  const pathTerms = count('pathTerms'), terms = count('terms'), strings = count('strings');
  const expect = (condition: boolean, what: string) => { if (!condition) throw new CacheCorruptError(what); };

  const dictionary = TermDictionary.fromSerialized(container.bytes('tBlob'), container.array('tOff', Uint32Array), container.array('tHash', Uint32Array), container.array('tTab', Uint32Array));
  const stringTable = StringTable.fromSerialized(container.bytes('sBlob'), container.array('sOff', Uint32Array));
  expect(dictionary.size === terms && stringTable.size === strings, 'dictionary size mismatch');

  const table = new FileTable(dictionary, stringTable);
  const pathText = Buffer.from(container.bytes('paths')).toString('utf8');
  table.paths = files ? pathText.split('\n') : [];
  expect(table.paths.length === files, 'path count mismatch');
  table.hashes = container.array('fHash', Uint8Array);
  table.sizes = container.array('fSize', Float64Array);
  table.mtimes = container.array('fMtime', Float64Array);
  table.languages = container.array('fLang', Uint32Array);
  table.lines = container.array('fLines', Uint32Array);
  table.flags = container.array('fFlags', Uint8Array);
  table.tokenCounts = container.array('fTokens', Float64Array);
  table.chunkFirst = container.array('fChunk', Uint32Array);
  table.pathTermStart = container.array('fPathS', Uint32Array);
  table.pathTerms = container.array('fPathT', Uint32Array);
  table.starts = container.array('cStart', Uint32Array);
  table.ends = container.array('cEnd', Uint32Array);
  table.idStrings = container.array('cId', Uint32Array);
  table.nameStrings = container.array('cName', Uint32Array);
  table.kindStrings = container.array('cKind', Uint32Array);
  table.chunkLen = container.array('cLen', Uint32Array);
  table.rowStart = container.array('rowS', Uint32Array);
  table.rowTerm = container.array('rowT', Uint32Array);
  table.rowTf = container.array('rowF', Uint16Array);
  table.nameStart = container.array('nameS', Uint32Array);
  table.nameTerm = container.array('nameT', Uint32Array);
  table.refStart = container.array('refS', Uint32Array);
  table.refIds = container.array('refI', Uint32Array);

  expect(table.hashes.length === files * 32 && table.sizes.length === files && table.mtimes.length === files && table.languages.length === files, 'file column length');
  expect(table.lines.length === files && table.flags.length === files && table.tokenCounts.length === files, 'file column length');
  expect(table.chunkFirst.length === files + 1 && table.pathTermStart.length === files + 1 && table.pathTerms.length === pathTerms, 'file offsets length');
  for (const column of [table.starts, table.ends, table.idStrings, table.nameStrings, table.kindStrings, table.chunkLen]) expect(column.length === chunks, 'chunk column length');
  expect(table.rowStart.length === chunks + 1 && table.nameStart.length === chunks + 1 && table.refStart.length === chunks + 1, 'row offsets length');
  expect(table.rowTerm.length === entries && table.rowTf.length === entries && table.nameTerm.length === nameEntries && table.refIds.length === refEntries, 'entry length');

  monotonic(table.chunkFirst, chunks, 'chunk offsets');
  monotonic(table.pathTermStart, pathTerms, 'path term offsets');
  monotonic(table.rowStart, entries, 'row offsets');
  monotonic(table.nameStart, nameEntries, 'name offsets');
  monotonic(table.refStart, refEntries, 'ref offsets');
  for (const [array, limit, what] of [[table.rowTerm, terms, 'row terms'], [table.nameTerm, terms, 'name terms'], [table.pathTerms, terms, 'path terms'], [table.languages, strings, 'languages'],
    [table.idStrings, strings, 'ids'], [table.nameStrings, strings, 'names'], [table.kindStrings, strings, 'kinds'], [table.refIds, strings, 'refs']] as const) {
    for (let i = 0; i < array.length; i++) if (array[i] >= limit) throw new CacheCorruptError(`${what} out of range`);
  }
  for (let i = 0; i < entries; i++) if (table.rowTf[i] === 0) throw new CacheCorruptError('zero term frequency');
  for (let file = 0; file < files; file++) {
    expect(table.flags[file] <= 1 && Number.isFinite(table.sizes[file]) && table.sizes[file] >= 0 && Number.isFinite(table.mtimes[file]) && Number.isFinite(table.tokenCounts[file]), 'file fields');
    for (let c = table.chunkFirst[file]; c < table.chunkFirst[file + 1]; c++) expect(table.starts[c] >= 1 && table.starts[c] <= table.ends[c] && table.ends[c] <= table.lines[file], 'chunk range');
  }

  const records = (name: string): unknown[][] => {
    const value = header[name];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_EXTRA_RECORDS || !value.every(item => Array.isArray(item) && item.length === 2)) throw new CacheCorruptError(`bad ${name}`);
    return value as unknown[][];
  };
  const index = (value: unknown, limit: number) => {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= limit) throw new CacheCorruptError('record index out of range');
    return value as number;
  };
  const plainObject = (value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CacheCorruptError('record is not an object');
    const clean: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (isSafeFieldName(key)) clean[key] = item;
    return clean;
  };
  for (const [file, extras] of records('fileExtras')) table.fileExtras.set(index(file, files), plainObject(extras));
  for (const [chunk, extras] of records('chunkExtras')) table.chunkExtras.set(index(chunk, chunks), plainObject(extras));
  for (const [chunk, text] of records('textOverrides')) {
    if (typeof text !== 'string') throw new CacheCorruptError('text override is not a string');
    table.textOverrides.set(index(chunk, chunks), text);
  }
  for (const [entry, tf] of records('tfOverflow')) {
    const at = index(entry, entries);
    if (table.rowTf[at] !== TF_LIMIT || !Number.isInteger(tf) || (tf as number) <= TF_LIMIT || (tf as number) > 0xffffffff) throw new CacheCorruptError('bad overflow entry');
    table.tfOverflow.set(at, tf as number);
  }
  return table;
}

function monotonic(offsets: Uint32Array, total: number, what: string): void {
  if (offsets[0] !== 0 || offsets[offsets.length - 1] !== total) throw new CacheCorruptError(`${what} do not span the data`);
  for (let i = 1; i < offsets.length; i++) if (offsets[i] < offsets[i - 1]) throw new CacheCorruptError(`${what} are not monotonic`);
}

/** LRU cache of file texts (bounded in characters) that serves chunk text on demand. */
export class TextCache {
  private readonly entries = new Map<string, { text: string; starts: Int32Array }>();
  private chars = 0;
  /** `read` must return the exact text the file had when it was indexed and throw if it changed. */
  constructor(private readonly read: (path: string, hash: string) => string, private readonly limit = 64 * 1024 * 1024) {}

  private load(path: string, hash: string) {
    const key = `${path}\0${hash}`;
    let entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry;
    }
    const text = this.read(path, hash);
    entry = { text, starts: lineStarts(text) };
    this.entries.set(key, entry);
    this.chars += text.length;
    for (const [oldest, value] of this.entries) {
      if (this.chars <= this.limit || oldest === key) break;
      this.entries.delete(oldest);
      this.chars -= value.text.length;
    }
    return entry;
  }

  text(path: string, hash: string): string { return this.load(path, hash).text; }

  /** Lines first..last (1-based, inclusive) joined with newlines, exactly as the chunkers cut them. */
  range(path: string, hash: string, first: number, last: number): string {
    const { text, starts } = this.load(path, hash);
    if (first < 1 || first > starts.length) return '';
    return text.slice(starts[first - 1], last < starts.length ? starts[last] - 1 : text.length);
  }
}

export class IndexedFile implements SourceFile {
  readonly chunks: IndexedChunk[] = [];
  constructor(
    readonly path: string, readonly hash: string, readonly language: string, readonly parsed: boolean,
    readonly lines: number, readonly size: number, private readonly cache: TextCache
  ) {}
  /** Loaded on demand (LRU-bounded); throws if the file changed since it was indexed. */
  get text(): string { return this.cache.text(this.path, this.hash); }
  range(first: number, last: number): string { return this.cache.range(this.path, this.hash, first, last); }
}

export class IndexedChunk implements Chunk {
  private cachedTerms?: string[];
  private cachedRefs?: string[];
  constructor(
    readonly id: string, readonly path: string, readonly start: number, readonly end: number, readonly name: string, readonly kind: string,
    private readonly file: IndexedFile, private readonly table: FileTable, private readonly ordinal: number
  ) {}
  get text(): string { return this.table.textOverrides.get(this.ordinal) ?? this.file.range(this.start, this.end); }
  /** Recomputed from the text on demand (the search index never needs it). */
  get terms(): string[] { return this.cachedTerms ??= tokenize(`${this.path} ${this.name} ${this.text}`); }
  get refs(): string[] { return this.cachedRefs ??= this.table.refStrings(this.ordinal); }
}
