// File sketches for the large-repository cascade: one cheap record per eligible file (hash, counts, sorted term
// fingerprints), kept in typed arrays and persisted next to the parsed-file index. Sketches never contain source text.
import { createHash } from 'node:crypto';
import { languageFor } from './parser.js';
import { termHash } from './search-index.js';
import { CacheCorruptError, decodeContainer, encodeContainer } from './store.js';
import { terms } from './tokenize.js';

export { termHash };

const SKETCH_MAGIC = 'RSQSKTCH';
const MAX_TERM_HASHES = 8192;
const collator = new Intl.Collator();

export interface Sketch {
  path: string;
  size: number;
  mtimeMs: number;
  /** sha256 (hex) of the file bytes. */
  digest: string;
  language: string;
  lines: number;
  /** Exact o200k_base token count of "--- path ---\n" + text, or -1 when not computed. */
  tokenCount: number;
  /** Sorted unique hashes of the path and text terms (a deterministic sample for huge generated files). */
  termHashes: Uint32Array;
  /** Sorted unique hashes of the path terms alone. */
  pathHashes: Uint32Array;
}

export function makeSketch(path: string, text: string, size: number, mtimeMs: number, digest: string, tokenCount = -1): Sketch {
  const pathTerms = new Set(terms(path));
  const unique = new Set<number>();
  for (const term of pathTerms) unique.add(termHash(term));
  // Hash each distinct word once; the same word repeated thousands of times is common in source.
  for (const term of new Set(terms(text))) unique.add(termHash(term));
  const hashes = Uint32Array.from(unique).sort();
  // Extremely large generated files are represented by a deterministic sample. Ordinary source files stay well
  // below this ceiling and therefore have no file-level false negatives.
  const step = Math.ceil(hashes.length / MAX_TERM_HASHES);
  const termHashes = hashes.length <= MAX_TERM_HASHES ? hashes : hashes.filter((_, i) => i % step === 0).slice(0, MAX_TERM_HASHES);
  let lines = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines++;
  const pathHashes = Uint32Array.from(new Set([...pathTerms].map(termHash))).sort();
  return { path, size, mtimeMs, digest, language: languageFor(path), lines, tokenCount, termHashes, pathHashes };
}

function contains(sorted: Uint32Array, from: number, to: number, value: number): boolean {
  let low = from, high = to - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1, current = sorted[mid];
    if (current === value) return true;
    if (current < value) low = mid + 1; else high = mid - 1;
  }
  return false;
}

/** All sketches of a repository in typed arrays; immutable once built. */
export class SketchTable {
  paths: string[] = [];
  sizes = new Float64Array(0);
  mtimes = new Float64Array(0);
  digests = new Uint8Array(0);
  languageIds = new Uint32Array(0);
  languageNames: string[] = [];
  lines = new Uint32Array(0);
  tokenCounts = new Float64Array(0);
  hashStart = new Uint32Array(1);
  hashes = new Uint32Array(0);
  pathHashStart = new Uint32Array(1);
  pathHashes = new Uint32Array(0);
  /** File numbers in String.prototype.localeCompare order of their paths (used to pad candidate lists). */
  pathOrder = new Uint32Array(0);
  private index?: Map<string, number>;
  private cachedRevision?: string;
  private cachedInventory?: { path: string; language: string; lines: number }[];

  get count(): number { return this.paths.length; }

  /** Digest of every path and content hash, as the snapshot revision of a cascade-mode repository. */
  revision(): string {
    return this.cachedRevision ??= createHash('sha256').update(this.paths.map((path, i) => `${path}:${this.digestHex(i)}`).join('\n')).digest('hex').slice(0, 16);
  }

  inventory(): { path: string; language: string; lines: number }[] {
    return this.cachedInventory ??= this.paths.map((path, i) => ({ path, language: this.languageNames[this.languageIds[i]], lines: this.lines[i] }));
  }

  fileOf(path: string): number {
    if (!this.index) this.index = new Map(this.paths.map((entry, i) => [entry, i]));
    return this.index.get(path) ?? -1;
  }

  digestHex(file: number): string { return Buffer.from(this.digests.buffer, this.digests.byteOffset + file * 32, 32).toString('hex'); }

  sketchAt(file: number): Sketch {
    return {
      path: this.paths[file], size: this.sizes[file], mtimeMs: this.mtimes[file], digest: this.digestHex(file), language: this.languageNames[this.languageIds[file]],
      lines: this.lines[file], tokenCount: this.tokenCounts[file], termHashes: this.hashes.subarray(this.hashStart[file], this.hashStart[file + 1]),
      pathHashes: this.pathHashes.subarray(this.pathHashStart[file], this.pathHashStart[file + 1])
    };
  }

  static from(sketches: readonly Sketch[]): SketchTable {
    const table = new SketchTable(), count = sketches.length;
    const languages = new Map<string, number>();
    table.paths = sketches.map(sketch => sketch.path);
    table.sizes = Float64Array.from(sketches, sketch => sketch.size);
    table.mtimes = Float64Array.from(sketches, sketch => sketch.mtimeMs);
    table.digests = new Uint8Array(count * 32);
    table.languageIds = new Uint32Array(count);
    table.lines = Uint32Array.from(sketches, sketch => sketch.lines);
    table.tokenCounts = Float64Array.from(sketches, sketch => sketch.tokenCount);
    table.hashStart = new Uint32Array(count + 1);
    table.pathHashStart = new Uint32Array(count + 1);
    sketches.forEach((sketch, i) => {
      table.hashStart[i + 1] = table.hashStart[i] + sketch.termHashes.length;
      table.pathHashStart[i + 1] = table.pathHashStart[i] + sketch.pathHashes.length;
    });
    table.hashes = new Uint32Array(table.hashStart[count]);
    table.pathHashes = new Uint32Array(table.pathHashStart[count]);
    sketches.forEach((sketch, i) => {
      table.digests.set(Buffer.from(sketch.digest, 'hex'), i * 32);
      let language = languages.get(sketch.language);
      if (language === undefined) { language = languages.size; languages.set(sketch.language, language); }
      table.languageIds[i] = language;
      table.hashes.set(sketch.termHashes, table.hashStart[i]);
      table.pathHashes.set(sketch.pathHashes, table.pathHashStart[i]);
    });
    table.languageNames = [...languages.keys()];
    table.pathOrder = Uint32Array.from({ length: count }, (_, i) => i).sort((a, b) => collator.compare(table.paths[a], table.paths[b]) || a - b);
    return table;
  }

  serialize(versions: unknown, options: { compress?: boolean } = {}): Uint8Array[] {
    const header = { kind: 'sketch', versions, files: this.count, languages: this.languageNames };
    const sections = [
      ['paths', Buffer.from(this.paths.join('\n'), 'utf8')], ['sSize', this.sizes], ['sMtime', this.mtimes], ['sDigest', this.digests], ['sLang', this.languageIds],
      ['sLines', this.lines], ['sTokens', this.tokenCounts], ['hStart', this.hashStart], ['hashes', this.hashes], ['pStart', this.pathHashStart], ['pHashes', this.pathHashes], ['order', this.pathOrder]
    ] as const;
    return encodeContainer(SKETCH_MAGIC, header, sections.map(([name, data]) => ({ name, data })), options);
  }

  /** Parses and validates a cache file; undefined when written by incompatible code. */
  static deserialize(file: Buffer, versions: unknown): SketchTable | undefined {
    const container = decodeContainer(file, SKETCH_MAGIC);
    const header = container.header as { kind?: unknown; versions?: unknown; files?: unknown; languages?: unknown };
    if (header?.kind !== 'sketch') throw new CacheCorruptError('not a sketch file');
    if (JSON.stringify(header.versions) !== JSON.stringify(versions)) return undefined;
    const expect = (condition: boolean, what: string) => { if (!condition) throw new CacheCorruptError(what); };
    const count = header.files;
    expect(Number.isInteger(count) && (count as number) >= 0 && (count as number) <= 0x7fffffff, 'bad file count');
    expect(Array.isArray(header.languages) && header.languages.every(name => typeof name === 'string'), 'bad languages');
    const files = count as number, table = new SketchTable();
    table.languageNames = header.languages as string[];
    const text = Buffer.from(container.bytes('paths')).toString('utf8');
    table.paths = files ? text.split('\n') : [];
    table.sizes = container.array('sSize', Float64Array);
    table.mtimes = container.array('sMtime', Float64Array);
    table.digests = container.array('sDigest', Uint8Array);
    table.languageIds = container.array('sLang', Uint32Array);
    table.lines = container.array('sLines', Uint32Array);
    table.tokenCounts = container.array('sTokens', Float64Array);
    table.hashStart = container.array('hStart', Uint32Array);
    table.hashes = container.array('hashes', Uint32Array);
    table.pathHashStart = container.array('pStart', Uint32Array);
    table.pathHashes = container.array('pHashes', Uint32Array);
    table.pathOrder = container.array('order', Uint32Array);
    expect(table.paths.length === files && table.sizes.length === files && table.mtimes.length === files && table.digests.length === files * 32, 'column length');
    expect(table.languageIds.length === files && table.lines.length === files && table.tokenCounts.length === files && table.pathOrder.length === files, 'column length');
    expect(table.hashStart.length === files + 1 && table.pathHashStart.length === files + 1, 'offset length');
    for (const [offsets, total] of [[table.hashStart, table.hashes.length], [table.pathHashStart, table.pathHashes.length]] as const) {
      expect(offsets[0] === 0 && offsets[files] === total, 'offsets do not span the data');
      for (let i = 1; i <= files; i++) expect(offsets[i] >= offsets[i - 1], 'offsets are not monotonic');
    }
    const seen = new Uint8Array(files);
    for (let i = 0; i < files; i++) {
      expect(table.languageIds[i] < table.languageNames.length && Number.isFinite(table.sizes[i]) && Number.isFinite(table.mtimes[i]) && Number.isFinite(table.tokenCounts[i]), 'file fields');
      expect(table.pathOrder[i] < files && seen[table.pathOrder[i]] === 0, 'bad path order');
      seen[table.pathOrder[i]] = 1;
    }
    return table;
  }
}

const foundation = /(^|\/)(?:readme(?:\.[^/]*)?|package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle|makefile|dockerfile|compose\.ya?ml|tsconfig\.json|[^/]*config[^/]*)$/i;

/**
 * Ranks files for a query by corpus rarity of their terms plus path and foundation-file signals and returns the best
 * candidate file numbers. Same scoring and padding rules as the original per-sketch implementation.
 */
export function selectCandidates(table: SketchTable, query: string): number[] {
  const unique = [...new Set(terms(query).filter(term => !/^\d+$/.test(term)))].slice(0, 64);
  const hashes = unique.map(termHash);
  const count = table.count, width = hashes.length;
  // One membership test per (file, term); the document frequencies and the scores both read it.
  const present = new Uint8Array(count * width);
  const dfs = new Array<number>(width).fill(0);
  for (let file = 0; file < count; file++) {
    const from = table.hashStart[file], to = table.hashStart[file + 1];
    for (let i = 0; i < width; i++) {
      if (contains(table.hashes, from, to, hashes[i])) { present[file * width + i] = 1; dfs[i]++; }
    }
  }
  const idfs = dfs.map(df => Math.log(1 + (count - df + 0.5) / (df + 0.5)));
  const lower = query.toLowerCase();
  const scores = new Float64Array(count);
  for (let file = 0; file < count; file++) {
    const path = table.paths[file];
    let score = foundation.test(path) ? 0.35 : 0;
    for (let i = 0; i < width; i++) if (present[file * width + i]) score += idfs[i];
    for (const value of hashes) if (contains(table.pathHashes, table.pathHashStart[file], table.pathHashStart[file + 1], value)) score += 2.5;
    if (lower.includes(path.toLowerCase())) score += 1000;
    scores[file] = score;
  }
  const requested = Number(process.env.REPOSQUEEZE_MAX_CANDIDATES || 0);
  const limit = Number.isInteger(requested) && requested >= 100 && requested <= 5000 ? requested : Math.min(1800, Math.max(600, Math.ceil(Math.sqrt(count) * 8)));
  const positive: number[] = [];
  for (let file = 0; file < count; file++) if (scores[file] > 0) positive.push(file);
  positive.sort((a, b) => scores[b] - scores[a] || collator.compare(table.paths[a], table.paths[b]));
  const wanted = Math.min(200, count);
  if (positive.length < wanted) {
    const used = new Set(positive);
    for (const file of table.pathOrder) {
      if (used.has(file)) continue;
      positive.push(file);
      used.add(file);
      if (positive.length >= wanted) break;
    }
  }
  return positive.slice(0, limit);
}
