import { tokens } from './tokens.js';
import type { Chunk, SourceFile } from './types.js';

/**
 * Definition analysis and skeleton rendering ("progressive disclosure").
 *
 * A skeleton shows a line range as its definition headers, one doc line per definition and the lines that
 * mention the query, and replaces everything else by explicit `… (N lines elided, L<a>-L<b>)` markers.
 * Every kept line is copied verbatim from the source (CRLF endings are normalised to LF).
 */

export type DefinitionRole = 'container' | 'callable' | 'variable';

export interface Definition {
  /** Identifier of the definition; empty when the chunker recorded no usable name. */
  name: string;
  kind: string;
  role: DefinitionRole;
  /** One-based inclusive span. The chunker splits long definitions into pieces; `end` covers all of them. */
  start: number;
  end: number;
  /** Number of enclosing definitions. */
  depth: number;
  /** Index of the enclosing definition in the analysed list, or -1. */
  parent: number;
  /** Declared inside a function body, so not part of the file's visible surface. */
  local: boolean;
  /** First chunk of the definition; its text begins at `start`. */
  chunk: Chunk;
}

export interface ChunkAnalysis {
  definitions: Definition[];
  /** One chunk per distinct definition node, including whole-file nodes that are not definitions (Python modules). */
  roots: Chunk[];
}

export type ChunkSource = Pick<SourceFile, 'language' | 'chunks'>;

const KIND_ROLES: Record<string, DefinitionRole> = {
  class_declaration: 'container', class_definition: 'container', class: 'container', module: 'container',
  interface_declaration: 'container', struct_item: 'container', enum_item: 'container', impl_item: 'container',
  type_declaration: 'container',
  function_declaration: 'callable', function_definition: 'callable', method_definition: 'callable',
  method_declaration: 'callable', function_item: 'callable', method: 'callable', singleton_method: 'callable',
  lexical_declaration: 'variable', variable_declaration: 'variable', assignment: 'variable', const_item: 'variable',
  type_alias_declaration: 'variable'
};
const CONTAINER_KIND = /class|struct|interface|enum|trait|protocol|namespace|module|impl|object|record|union/;
const CALLABLE_KIND = /func|method|ctor|constructor|lambda|procedure|(^|_)def(_|$)/;

export function roleOfKind(kind: string): DefinitionRole {
  return KIND_ROLES[kind] ?? (CONTAINER_KIND.test(kind) ? 'container' : CALLABLE_KIND.test(kind) ? 'callable' : 'variable');
}

const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
const QUALIFIED = /^[\p{L}_$][\p{L}\p{N}_$]*(?:(?:::|\.)[\p{L}_$][\p{L}\p{N}_$]*)+$/u;
const LEADING_IDENTIFIER = /^([\p{L}_$][\p{L}\p{N}_$]*)/u;

// ---------------------------------------------------------------------------------------------------------------
// Signatures

export interface SignatureOptions {
  language: string;
  role?: DefinitionRole;
  /** Longest signature returned, in UTF-16 units (default 160). Longer ones end with an ellipsis. */
  maxChars?: number;
}
export interface Signature {
  /** Single-line header text, whitespace collapsed, without the body opener. */
  text: string;
  /** Physical source lines the header occupies, including leading annotation lines. */
  lines: number;
  /** Leading annotation/decorator-only lines that are part of the span but not of `text`. */
  skipped: number;
}

const SCAN_LIMIT = 2000;
const MAX_HEADER_LINES = 12;
// The value of a variable is rarely part of its identity; keep the head of the declaration only.
const VARIABLE_MAX_CHARS = 72;
const GENERIC_LANGUAGES = new Set(['typescript', 'tsx', 'java', 'c_sharp', 'rust', 'cpp']);
// A header that ends like this continues on the next line.
const CONTINUES = /(?:=|,|\\|->|\bwhere)$/;
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Removes leading `@annotation(...)` / `@decorator` groups. */
function stripAnnotations(text: string): string {
  let rest = text.trim();
  while (rest.startsWith('@')) {
    const name = /^@[\w.$]+/.exec(rest);
    if (!name) break;
    rest = rest.slice(name[0].length).trimStart();
    if (rest.startsWith('(')) {
      let depth = 0, i = 0;
      for (; i < rest.length; i++) {
        if (rest[i] === '(') depth++;
        else if (rest[i] === ')' && --depth === 0) break;
      }
      rest = rest.slice(i + 1).trimStart();
    }
  }
  return rest;
}

function collapse(text: string): string {
  return text.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim()
    .replace(/([(\[]) /g, '$1').replace(/ ([)\]])/g, '$1').replace(/, ?([)\]])/g, '$1');
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, Math.max(1, maxChars - 1));
  const space = cut.lastIndexOf(' ');
  return `${space > maxChars * 0.6 ? cut.slice(0, space) : cut}…`;
}

// A Rust `'` starts a character literal only when it is closed right after one character or an escape.
function startsRustChar(source: string, i: number): boolean {
  return source[i + 1] === '\\' || source[i + 2] === "'";
}

/**
 * Extracts the header of a definition from the text that starts at its first line: everything up to the body
 * opener (`{`, a newline outside brackets, `=>`, `;`). Comments are dropped, annotation-only lines are skipped.
 */
export function extractSignature(source: string, options: SignatureOptions): Signature {
  const { language, role = 'callable' } = options;
  const maxChars = options.maxChars ?? 160;
  const hashComments = language === 'python' || language === 'ruby';
  const generics = GENERIC_LANGUAGES.has(language);
  const constraints = language === 'rust' || language === 'c_sharp'; // `where` clauses may start the next line
  const end = Math.min(source.length, SCAN_LIMIT);
  let out = '';
  let assigned = false; // an `=` at the top level was seen
  let logicalStart = 0;
  let nesting = 0; // () and []
  let angle = 0; // <>
  let quote = '';
  let line = 1;
  let skipped = 0;
  for (let i = 0; i < end; i++) {
    const ch = source[i];
    if (ch === '\r') continue;
    if (ch === '\n') {
      quote = '';
      if (nesting > 0) {
        out += ' ';
        if (++line > MAX_HEADER_LINES) break;
        continue;
      }
      const current = out.slice(logicalStart).trim();
      if (!current) {
        out = out.slice(0, logicalStart);
        line++;
        continue;
      }
      if (stripAnnotations(current) === '') {
        out = out.slice(0, logicalStart);
        skipped++;
        line++;
        continue;
      }
      if (line < MAX_HEADER_LINES && (CONTINUES.test(current) || (constraints && /^\s*where\b/.test(source.slice(i + 1, i + 40))))) {
        out += ' ';
        line++;
        continue;
      }
      break;
    }
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < end) out += source[++i];
      else if (ch === quote) quote = '';
      continue;
    }
    if (hashComments ? ch === '#' : ch === '/' && source[i + 1] === '/') {
      while (i + 1 < end && source[i + 1] !== '\n') i++;
      continue;
    }
    if (!hashComments && ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close < 0 || close >= end) break;
      for (let j = i; j < close; j++) if (source[j] === '\n') line++;
      i = close + 1;
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      if (language === 'rust' && ch === "'" && !startsRustChar(source, i)) {
        out += ch;
        continue;
      }
      if (language === 'python' && ch !== '`' && source.startsWith(ch.repeat(3), i)) {
        out += ' …';
        break;
      }
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '[' && role === 'variable' && assigned && nesting === 0 && angle === 0) {
      out += '[…]';
      break;
    }
    if (ch === '(' || ch === '[') nesting++;
    else if (ch === ')' || ch === ']') nesting = Math.max(0, nesting - 1);
    else if (generics && nesting === 0 && ch === '<' && /[\w>]/.test(out.at(-1) ?? '')) angle++;
    else if (generics && nesting === 0 && ch === '>' && angle > 0 && out.at(-1) !== '-' && out.at(-1) !== '=') angle--;
    else if (nesting === 0 && angle === 0) {
      if (ch === '=' && source[i + 1] !== '=' && source[i + 1] !== '>' && !/[=!<>+\-*/%&|^]/.test(source[i - 1] ?? '')) assigned = true;
      if (ch === '{') {
        if (role === 'variable') out += ' {…}';
        break;
      }
      if (ch === '=' && source[i + 1] === '>') {
        out += '=>';
        break;
      }
      if (ch === ';') {
        out += ';';
        break;
      }
    }
    out += ch;
  }
  const cap = role === 'variable' ? Math.min(maxChars, VARIABLE_MAX_CHARS) : maxChars;
  return { text: truncate(stripAnnotations(collapse(out)), cap), lines: Math.min(line, MAX_HEADER_LINES), skipped };
}

// ---------------------------------------------------------------------------------------------------------------
// Definitions

/** The grammar reports the return type (or a storage class) as the name of C and C++ functions. */
function cFunctionName(source: string, language: string): string {
  const header = extractSignature(source, { language, role: 'callable', maxChars: 400 }).text;
  const open = header.indexOf('(');
  if (open < 0) return '';
  const match = /([\p{L}_$~][\p{L}\p{N}_$]*)(?:\s*<[^<>]*>)?\s*$/u.exec(header.slice(0, open));
  return match?.[1] ?? '';
}

function definitionName(chunk: Chunk, role: DefinitionRole, language: string): string {
  const raw = chunk.name.trim();
  if (chunk.kind === 'impl_item') return '';
  if ((language === 'c' || language === 'cpp') && role === 'callable') return cFunctionName(chunk.text, language);
  if (IDENTIFIER.test(raw)) return raw;
  if (language === 'go' && chunk.kind === 'type_declaration') return LEADING_IDENTIFIER.exec(raw)?.[1] ?? '';
  if (role === 'variable') {
    const typed = /^([\p{L}_$][\p{L}\p{N}_$]*)\s*[:!?]/u.exec(raw); // TypeScript `name: Type`
    return typed?.[1] ?? '';
  }
  if (QUALIFIED.test(raw)) return raw.split(/::|\./).at(-1) ?? '';
  return '';
}

interface Root {
  chunk: Chunk;
  start: number;
  end: number;
}

function sameRefs(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const analyses = new WeakMap<readonly Chunk[], { language: string; value: ChunkAnalysis }>();

/**
 * Turns the chunker's output into definitions: pieces of one long definition are merged, nesting is resolved from
 * the line spans, and whole-file Python `module` nodes are reported only as reference roots.
 */
export function analyzeChunks(file: ChunkSource): ChunkAnalysis {
  const cached = analyses.get(file.chunks);
  if (cached && cached.language === file.language) return cached.value;
  const pieces = file.chunks.filter(chunk => chunk.kind !== 'window').sort((a, b) => a.start - b.start || b.end - a.end);
  const roots: Root[] = [];
  const open = new Map<string, Root>();
  for (const chunk of pieces) {
    const key = `${chunk.kind}\0${chunk.name}`;
    const root = open.get(key);
    if (root && chunk.start > root.start && chunk.start <= root.end && sameRefs(chunk.refs, root.chunk.refs)) {
      root.end = Math.max(root.end, chunk.end);
      continue;
    }
    const fresh = { chunk, start: chunk.start, end: chunk.end };
    roots.push(fresh);
    open.set(key, fresh);
  }
  const definitions: Definition[] = [];
  const stack: number[] = [];
  for (const root of roots) {
    const { chunk } = root;
    if (file.language === 'python' && chunk.kind === 'module') continue;
    while (stack.length && (definitions[stack.at(-1)!].end < root.start || root.end > definitions[stack.at(-1)!].end)) stack.pop();
    const parent = stack.length ? stack.at(-1)! : -1;
    const role = roleOfKind(chunk.kind);
    // An indented declaration outside any definition sits in an anonymous function or a block: not a module-level name.
    const local = parent >= 0 ? definitions[parent].role === 'callable' || definitions[parent].local : role === 'variable' && /^\s/.test(chunk.text);
    definitions.push({
      name: definitionName(chunk, role, file.language), kind: chunk.kind, role, start: root.start, end: root.end,
      depth: stack.length, parent, local, chunk
    });
    stack.push(definitions.length - 1);
  }
  const value = { definitions, roots: roots.map(root => root.chunk) };
  analyses.set(file.chunks, { language: file.language, value });
  return value;
}

export function listDefinitions(file: ChunkSource): Definition[] {
  return analyzeChunks(file).definitions;
}

// ---------------------------------------------------------------------------------------------------------------
// Skeleton

export type SkeletonSource = Pick<SourceFile, 'text' | 'language' | 'chunks'> & { path?: string };

export interface SkeletonOptions {
  /** Lines containing any of these (case-insensitive substring) are kept. */
  focusTerms?: readonly string[];
  /** Hard cap on the o200k_base tokens of the returned text. */
  maxTokens: number;
  /** Prefix kept lines with their one-based number (`  42│ code`). */
  numbered?: boolean;
  /** Lines kept around every focus hit (default 1). */
  contextLines?: number;
}

export interface SkeletonResult {
  text: string;
  keptLines: number;
  elidedLines: number;
  tokens: number;
  /** Exact one-based inclusive ranges of the source lines that were kept, in order. */
  keptRanges: [number, number][];
  /** Exact one-based inclusive ranges covered by the elision markers, in order. */
  elidedRanges: [number, number][];
}

const sourceLineCache = new WeakMap<object, { text: string; lines: string[] }>();

function sourceLines(file: SkeletonSource): string[] {
  const cached = sourceLineCache.get(file);
  if (cached && cached.text === file.text) return cached.lines;
  const lines = file.text.split('\n');
  if (lines.length && lines.at(-1) === '') lines.pop();
  for (let i = 0; i < lines.length; i++) if (lines[i].endsWith('\r')) lines[i] = lines[i].slice(0, -1);
  sourceLineCache.set(file, { text: file.text, lines });
  return lines;
}

const HASH_LANGUAGES = new Set(['python', 'ruby']);
const LICENSE = /copyright|licen[sc]e|spdx|all rights reserved/i;
const COMMENT_PREFIX = /^(?:\/\/[/!]?|\/\*+|\*+\/?|--|;;|#+)\s*/;

function isCommentLine(line: string, language: string): boolean {
  const text = line.trim();
  if (text.startsWith('//') || text.startsWith('/*') || text.startsWith('*') || text.startsWith('--') || text.startsWith(';;')) return true;
  return HASH_LANGUAGES.has(language) && text.startsWith('#');
}

function commentSummary(text: string): boolean {
  const body = text.trim().replace(COMMENT_PREFIX, '');
  return /[\p{L}\p{N}]{3}/u.test(body) && !LICENSE.test(body);
}

/** Lines (one-based) holding the first sentence of the definition's documentation. */
function docLines(lines: string[], language: string, start: number, headerEnd: number): number[] {
  if (language === 'python') {
    let i = headerEnd + 1;
    while (i <= lines.length && i <= headerEnd + 2 && lines[i - 1].trim() === '') i++;
    const text = lines[i - 1];
    const opener = text === undefined ? null : /^\s*[rRuUbBfF]{0,2}("""|'''|"|')/.exec(text);
    if (!opener) return [];
    const rest = text.slice(opener[0].length).trim();
    if (rest && (opener[1].length === 1 || !rest.startsWith(opener[1]))) return [i];
    const next = lines[i]?.trim() ? [i + 1] : [];
    return [i, ...next];
  }
  let i = start - 1;
  while (i >= 1 && /^\s*(?:@|#\[)/.test(lines[i - 1])) i--;
  const blockEnd = i;
  while (i >= 1 && isCommentLine(lines[i - 1], language)) i--;
  for (let j = i + 1; j <= blockEnd; j++) if (commentSummary(lines[j - 1])) return [j];
  return [];
}

// Used for files the chunker could not parse (other languages, plain text).
const HEADER_KEYWORD = /^\s*(?:(?:export|default|public|private|protected|internal|static|final|abstract|async|override|virtual|open|data|sealed|inline|suspend|pub(?:\([^)]*\))?|unsafe|extern|const|readonly|partial)\s+)*(?:def|class|function|func|fun|interface|struct|enum|trait|impl|object|protocol|module|namespace|type|sub|proc)\s+[\p{L}_$]/u;
const MARKDOWN_HEADING = /^#{1,6}\s+\S/;

function fallbackHeaders(lines: string[], path: string | undefined, first: number, last: number): { start: number; depth: number }[] {
  const markdown = /\.(?:md|markdown|mdx)$/i.test(path ?? '');
  const found: { start: number; depth: number }[] = [];
  for (let n = first; n <= last; n++) {
    const line = lines[n - 1];
    if (line.length > 400) continue;
    if (markdown ? MARKDOWN_HEADING.test(line) : HEADER_KEYWORD.test(line)) {
      const indent = /^[ \t]*/.exec(line)![0].replace(/\t/g, '    ').length;
      found.push({ start: n, depth: markdown ? line.indexOf(' ') - 1 : Math.min(3, Math.ceil(indent / 4)) });
    }
  }
  return found;
}

// Selection classes, best first. Lower numbers are kept before higher ones when the budget is tight.
const CLASS_SHALLOW_HEADER = 1;
const CLASS_STRONG_HIT = 2;
const CLASS_WEAK_HIT = 3;
const CLASS_DEEP_HEADER = 4;
const CLASS_DOC = 5;
const CLASS_CONTEXT = 6;
const MAX_FOCUS_TERMS = 64;
const MAX_FILLED_GAP = 24;

function normalizeTerms(terms: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const term of terms ?? []) {
    const lowered = term.trim().toLowerCase();
    if (lowered.length >= 2 && lowered.length <= 120) seen.add(lowered);
    if (seen.size >= MAX_FOCUS_TERMS) break;
  }
  return [...seen];
}

/**
 * Renders `range` (one-based, inclusive) of `file` as a skeleton under a hard token cap. Kept lines are exact source
 * lines; every other line is covered by an elision marker with its exact line numbers.
 */
export function renderSkeleton(file: SkeletonSource, range: { start: number; end: number }, options: SkeletonOptions): SkeletonResult {
  const { maxTokens } = options;
  if (!Number.isInteger(maxTokens) || maxTokens < 0) throw new RangeError('maxTokens must be a non-negative integer');
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start) {
    throw new RangeError('invalid one-based line range');
  }
  const lines = sourceLines(file);
  if (range.start > lines.length) throw new RangeError('start is beyond end of file');
  const first = range.start;
  const last = Math.min(range.end, lines.length);
  const span = last - first + 1;
  const numbered = options.numbered === true;
  const context = Math.min(20, Math.max(0, Math.trunc(options.contextLines ?? 1)));
  const terms = normalizeTerms(options.focusTerms);
  // A kept line must be able to fit; longer lines (minified code) can only be elided.
  const maxLineChars = Math.max(200, maxTokens * 12);
  const priority = new Float64Array(span).fill(Infinity);
  const offer = (line: number, cls: number, sub = 0) => {
    if (line < first || line > last || lines[line - 1].length > maxLineChars) return;
    const value = cls * 1e9 + sub * 1e6 + line;
    if (value < priority[line - first]) priority[line - first] = value;
  };

  const hasDefinitions = file.chunks.some(chunk => chunk.kind !== 'window');
  const headers: { start: number; depth: number; role: DefinitionRole }[] = [];
  if (hasDefinitions) {
    for (const def of listDefinitions(file)) {
      if (!def.local && def.start >= first && def.start <= last) headers.push({ start: def.start, depth: def.depth, role: def.role });
    }
  } else {
    for (const header of fallbackHeaders(lines, file.path, first, last)) headers.push({ ...header, role: 'callable' });
  }
  for (const header of headers) {
    const head = lines.slice(header.start - 1, header.start - 1 + MAX_HEADER_LINES).join('\n');
    const signature = extractSignature(head, { language: file.language, role: header.role, maxChars: 400 });
    const headerEnd = Math.min(last, header.start + signature.lines - 1);
    const cls = header.depth <= 1 ? CLASS_SHALLOW_HEADER : CLASS_DEEP_HEADER;
    const depth = Math.min(header.depth, 99);
    for (let n = header.start; n <= headerEnd; n++) offer(n, cls, depth);
    for (const n of docLines(lines, file.language, header.start, headerEnd)) offer(n, CLASS_DOC, depth);
  }

  const hits: number[] = [];
  if (terms.length) {
    for (let n = first; n <= last; n++) {
      const line = lines[n - 1];
      if (line.length > maxLineChars) continue;
      const lowered = line.toLowerCase();
      let matched = 0;
      for (const term of terms) if (lowered.includes(term)) matched++;
      if (!matched) continue;
      hits.push(n);
      offer(n, matched > 1 ? CLASS_STRONG_HIT : CLASS_WEAK_HIT, 999 - Math.min(matched, 999));
    }
    for (const hit of hits) for (let d = 1; d <= context; d++) {
      offer(hit - d, CLASS_CONTEXT, d);
      offer(hit + d, CLASS_CONTEXT, d);
    }
  }

  const order: number[] = [];
  for (let o = 0; o < span; o++) if (priority[o] !== Infinity) order.push(o);
  order.sort((a, b) => priority[a] - priority[b]);

  const width = String(last).length;
  const format = (n: number) => numbered ? `  ${String(n).padStart(width)}│ ${lines[n - 1]}` : lines[n - 1];
  const marker = (a: number, b: number) => `… (${b - a + 1} lines elided, L${a}-L${b})`;
  // A marker costs a dozen tokens: a gap that is cheaper to show than to mark is kept as it is.
  const fillCache = new Map<number, boolean>();
  const cheaperToKeep = (a: number, b: number) => {
    if (b - a + 1 > MAX_FILLED_GAP) return false;
    const key = a * 4096 + (b - a);
    let fill = fillCache.get(key);
    if (fill === undefined) {
      const rows: string[] = [];
      for (let n = a; n <= b; n++) {
        if (lines[n - 1].length > maxLineChars) break;
        rows.push(format(n));
      }
      fill = rows.length === b - a + 1 && tokens(rows.join('\n')) <= tokens(marker(a, b));
      fillCache.set(key, fill);
    }
    return fill;
  };
  const assemble = (kept: Uint8Array) => {
    const out: string[] = [];
    const keptRanges: [number, number][] = [];
    const elidedRanges: [number, number][] = [];
    const keep = (a: number, b: number) => {
      for (let n = a; n <= b; n++) out.push(format(n));
      const previous = keptRanges.at(-1);
      if (previous && previous[1] === a - 1) previous[1] = b; else keptRanges.push([a, b]);
    };
    let o = 0;
    while (o < span) {
      const isKept = kept[o] === 1;
      let e = o;
      while (e + 1 < span && (kept[e + 1] === 1) === isKept) e++;
      if (isKept || cheaperToKeep(first + o, first + e)) keep(first + o, first + e);
      else {
        out.push(marker(first + o, first + e));
        elidedRanges.push([first + o, first + e]);
      }
      o = e + 1;
    }
    return { text: out.join('\n'), keptRanges, elidedRanges };
  };
  const withPrefix = (count: number, extra: number[] = []) => {
    const kept = new Uint8Array(span);
    for (let j = 0; j < count; j++) kept[order[j]] = 1;
    for (const o of extra) kept[o] = 1;
    return kept;
  };

  const empty: SkeletonResult = { text: '', keptLines: 0, elidedLines: span, tokens: 0, keptRanges: [], elidedRanges: span ? [[first, last]] : [] };
  if (tokens(assemble(new Uint8Array(span)).text) > maxTokens) return empty;
  // Prefix search over the priority order. Token counts are not strictly monotone (a kept line can merge two
  // markers), so a short greedy pass afterwards tries the next few candidates individually.
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tokens(assemble(withPrefix(mid)).text) <= maxTokens) lo = mid; else hi = mid - 1;
  }
  const extra: number[] = [];
  for (let j = lo + 1; j < Math.min(order.length, lo + 49); j++) {
    if (tokens(assemble(withPrefix(lo, [...extra, order[j]])).text) <= maxTokens) extra.push(order[j]);
  }
  const built = assemble(withPrefix(lo, extra));
  const keptLines = built.keptRanges.reduce((sum, [a, b]) => sum + b - a + 1, 0);
  return { text: built.text, keptLines, elidedLines: span - keptLines, tokens: tokens(built.text), keptRanges: built.keptRanges, elidedRanges: built.elidedRanges };
}
