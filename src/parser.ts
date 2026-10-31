import Parser from 'web-tree-sitter';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Chunk, ParseResult } from './types.js';
import { terms } from './tokenize.js';
import { detectGenerated } from './generated.js';
import { profileForPath, profileByLanguage, type Profile, type Role } from './langs.js';
import { docText, signatureText, stripComment, stripDocstring, stripElixirDoc } from './outline.js';

const assetDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
export { terms };
export function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function languageFor(path: string): string { return profileForPath(path)?.language ?? 'text'; }

/** Optional switches for `parseSource`; the two-argument form keeps the original behaviour. */
export interface ParseOptions {
  /** Also chunk the extra definition kinds listed as `rich` in the language profiles (traits, namespaces, enums, ...). Defaults to `RSQ_PARSER_RICH=1`. */
  rich?: boolean;
  /** Wall-clock limit for one tree-sitter parse; on expiry the file falls back to line windows. */
  timeoutMs?: number;
}

const WINDOW_LINES = 64, WINDOW_STRIDE = 48, PIECE_LINES = 96, PIECE_STRIDE = 80;
const MAX_REFS = 2000;
const MAX_LEADING_LINES = 40;
const MAX_PARSE_CHARS = 4 * 1024 * 1024;
const MAX_TREE_NODES = 3_000_000;
const MAX_NESTING = 1000;
const PARSE_TIMEOUT_MS = 10_000;
const GENERATED_MAX_CHUNKS = 64, GENERATED_MIN_BUCKET = 8_000, GENERATED_TERMS_CHARS = 16_384, LONG_LINE = 2_000;

// `tree-sitter-bash` calls libc `isalpha`, which the web-tree-sitter runtime does not export. The build writes a tiny
// side module that provides it; without that file Bash files that use `${x#y}` style expansions fall back to windows.
function runtimeOptions(): Record<string, unknown> {
  const wasm = join(assetDir, 'tree-sitter.wasm');
  const shim = join(assetDir, 'libc-shim.wasm');
  let usable = false;
  try { usable = existsSync(shim) && WebAssembly.validate(readFileSync(shim)); } catch { /* the shim is optional */ }
  return { locateFile: (name: string) => name.endsWith('tree-sitter.wasm') ? wasm : name, ...(usable ? { dynamicLibraries: [shim] } : {}) };
}
let init: Promise<void> | undefined;
const parsers = new Map<string, Promise<Parser>>();
async function getParser(grammar: string): Promise<Parser> {
  init ??= Parser.init(runtimeOptions());
  await init;
  if (!parsers.has(grammar)) parsers.set(grammar, (async () => {
    const p = new Parser(); p.setLanguage(await Parser.Language.load(join(assetDir, `tree-sitter-${grammar}.wasm`))); return p;
  })());
  return parsers.get(grammar)!;
}

interface Span {
  start: number; end: number; name: string; kind: string; refs: string[];
  signature?: string; scope?: string; doc?: string;
}

/** A multi-line node that is a definition and/or a named scope. */
interface Entry {
  node: Parser.SyntaxNode; kind: string; role: Role;
  startIndex: number; endIndex: number; startRow: number; endRow: number;
  name?: string;
}

/** A comment or attribute that may sit directly above a definition. Rows are zero-based. */
interface Lead { start: number; end: number; ownLine: boolean; trailingBlank: boolean; comment: boolean }

interface Plan { search: string[]; definitions: Set<string>; containers: Set<string>; bodyTypes: Set<string> }
const plans = new Map<string, Plan>();
function planFor(profile: Profile, rich: boolean): Plan {
  const key = `${profile.language}:${rich}`;
  let plan = plans.get(key);
  if (!plan) {
    const definitions = new Set([...profile.definitions, ...(rich ? profile.rich ?? [] : [])]);
    const containers = new Set(profile.containers ?? []);
    plan = { search: [...new Set([...definitions, ...containers])], definitions, containers, bodyTypes: new Set(profile.bodyTypes ?? []) };
    plans.set(key, plan);
  }
  return plan;
}

const OBJC_MARKER = /^\s*(?:@(?:interface|protocol|implementation|class)\b|#import\b)/m;
const CPP_MARKER = /^\s*(?:namespace\s+\w+|template\s*<|class\s+\w+\s*(?::|\{)|using\s+namespace\b|(?:public|private|protected)\s*:)|\bstd::|\bconstexpr\b|\bnullptr\b|#include\s*<(?:string|vector|memory|map|set|iostream|algorithm|functional|utility|cstdint|cstddef|type_traits)>/m;
/** `.h` is C by default; headers that are plainly Objective-C or C++ use that grammar instead. */
function chooseProfile(path: string, text: string): Profile | undefined {
  const profile = profileForPath(path);
  if (profile?.language !== 'c' || !path.toLowerCase().endsWith('.h')) return profile;
  const head = text.slice(0, 65_536);
  if (OBJC_MARKER.test(head)) return profileByLanguage('objc');
  if (CPP_MARKER.test(head)) return profileByLanguage('cpp');
  return profile;
}

/** Same-length stand-in for the parser input: tree-sitter lexers stop at NUL. A leading BOM is dropped (rows are unaffected). */
function parseInput(text: string): string {
  let input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (input.includes('\0')) input = input.replaceAll('\0', ' ');
  return input;
}

function maxNesting(text: string): number {
  let depth = 0, max = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 40 || c === 91 || c === 123) { if (++depth > max) max = depth; }
    else if ((c === 41 || c === 93 || c === 125) && depth > 0) depth--;
  }
  return max;
}

function lineOffsets(lines: readonly string[]): Int32Array {
  const starts = new Int32Array(lines.length);
  for (let i = 1, offset = 0; i < lines.length; i++) { offset += lines[i - 1].length + 1; starts[i] = offset; }
  return starts;
}

/** Zero-based row containing the character index. */
function rowOf(starts: Int32Array, index: number): number {
  let low = 0, high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid; else high = mid - 1;
  }
  return low;
}

function isBlank(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (text.charCodeAt(i) > 32) return false;
  return true;
}

/** Start/end character indices of every comment, in document order. */
interface CommentRanges { starts: number[]; ends: number[] }

function collectLeads(root: Parser.SyntaxNode, text: string, lines: readonly string[], starts: Int32Array, profile: Profile): { leads: Map<number, Lead>; comments: CommentRanges } {
  const leads = new Map<number, Lead>();
  const comments: CommentRanges = { starts: [], ends: [] };
  const add = (nodes: Parser.SyntaxNode[], comment: boolean) => {
    for (const node of nodes) {
      if (!comment && profile.isAttribute && !profile.isAttribute(node, text)) continue;
      const startIndex = node.startIndex;
      const nodeEnd = node.endIndex;
      let endIndex = nodeEnd;
      while (endIndex > startIndex && text.charCodeAt(endIndex - 1) <= 32) endIndex--;
      if (endIndex <= startIndex) continue;
      if (comment) { comments.starts.push(startIndex); comments.ends.push(nodeEnd); }
      const start = node.startPosition.row, end = rowOf(starts, endIndex - 1);
      const lead: Lead = {
        start, end, comment,
        ownLine: isBlank(text, starts[start], startIndex),
        trailingBlank: isBlank(text, endIndex, starts[end] + lines[end].length),
      };
      const known = leads.get(end);
      if (!known || lead.start < known.start) leads.set(end, lead);
    }
  };
  add(root.descendantsOfType(profile.comments), true);
  if (profile.attributes) add(root.descendantsOfType(profile.attributes), false);
  return { leads, comments };
}

/**
 * Walks upward from a definition over contiguous own-line comments and attributes (no blank line between),
 * never into rows owned by an earlier definition and never further than MAX_LEADING_LINES above it.
 */
function extendUp(startRow: number, floorRow: number, leads: Map<number, Lead>): { row: number; used: Lead[] } {
  const used: Lead[] = [];
  let row = startRow;
  const sameRow = leads.get(startRow);
  if (sameRow?.ownLine && sameRow.start < startRow && startRow - sameRow.start <= MAX_LEADING_LINES && sameRow.start >= floorRow) {
    row = sameRow.start;
    used.push(sameRow);
  }
  for (;;) {
    const lead = leads.get(row - 1);
    if (!lead || !lead.ownLine || !lead.trailingBlank || lead.start < floorRow || startRow - lead.start > MAX_LEADING_LINES) break;
    row = lead.start;
    used.push(lead);
  }
  return { row, used };
}

function bodyStart(node: Parser.SyntaxNode, plan: Plan): number | undefined {
  const body = node.childForFieldName('body');
  if (body) return body.startIndex;
  if (plan.bodyTypes.size) {
    const child = node.namedChildren.find(candidate => plan.bodyTypes.has(candidate.type));
    if (child) return child.startIndex;
  }
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    // `const f = (a) => {` and `const C = class {`: the body of the first declarator's value.
    const inner = node.firstNamedChild?.childForFieldName('value')?.childForFieldName('body');
    if (inner) return inner.startIndex;
  }
  return undefined;
}

/** `text[from, to)` with the comments that start inside it cut out (a trailing `# note` after `def f():`). */
function withoutComments(text: string, from: number, to: number, comments: CommentRanges): string {
  let low = 0, high = comments.starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (comments.starts[mid] < from) low = mid + 1; else high = mid;
  }
  let result = '', cursor = from;
  for (let i = low; i < comments.starts.length && comments.starts[i] < to; i++) {
    result += text.slice(cursor, comments.starts[i]);
    cursor = Math.min(to, comments.ends[i]);
  }
  return result + text.slice(cursor, to);
}

const ANNOTATION_ONLY = /^\s*(?:@[\w.:]+(?:\([^)]*\))?\s*)+$/;

/** Declaration header: everything before the body opener, or the first real line when there is no body node. */
function signatureOf(node: Parser.SyntaxNode, text: string, plan: Plan, comments: CommentRanges): string | undefined {
  const start = node.startIndex;
  const body = bodyStart(node, plan);
  if (body !== undefined && body > start) return signatureText(withoutComments(text, start, Math.min(body, start + 2000), comments));
  // No body node: take the first line, plus the lines before it when those only carry annotations.
  let lineEnd = text.indexOf('\n', start);
  for (let extra = 0; extra < 4 && lineEnd >= 0 && lineEnd < node.endIndex && ANNOTATION_ONLY.test(text.slice(start, lineEnd).split('\n').pop()!); extra++) {
    lineEnd = text.indexOf('\n', lineEnd + 1);
  }
  const header = withoutComments(text, start, Math.min(node.endIndex, lineEnd < 0 ? text.length : lineEnd, start + 2000), comments);
  const brace = header.indexOf('{');
  return signatureText(brace >= 0 ? header.slice(0, brace) : header);
}

function extract(tree: Parser.Tree, text: string, lines: readonly string[], profile: Profile, plan: Plan): Span[] {
  const root = tree.rootNode;
  const entries: Entry[] = [];
  for (const node of plan.search.length ? root.descendantsOfType(plan.search) : []) {
    if (node.id === root.id) continue;
    const end = node.endPosition.row, startRow = node.startPosition.row;
    if (end <= startRow) continue;
    const type = node.type;
    let role = profile.classify?.(node);
    if (role === null) continue;
    role ??= { definition: plan.definitions.has(type), container: plan.containers.has(type) };
    const allowed = profile.onlyInside?.[type];
    if (allowed && role.definition && !allowed.includes(node.parent?.type ?? '')) role = { ...role, definition: false };
    if (!role.definition && !role.container) continue;
    entries.push({ node, kind: role.kind ?? type, role, startIndex: node.startIndex, endIndex: node.endIndex, startRow, endRow: end });
  }
  if (!entries.some(entry => entry.role.definition)) return [];

  const starts = lineOffsets(lines);
  const { leads, comments } = collectLeads(root, text, lines, starts, profile);
  const ids = root.descendantsOfType(profile.identifiers);
  const idStarts = Int32Array.from(ids, node => node.startIndex);
  const idTexts: (string | undefined)[] = new Array(ids.length);
  const refsOf = (from: number, to: number): string[] => {
    let low = 0, high = idStarts.length;
    while (low < high) { const mid = (low + high) >> 1; if (idStarts[mid] < from) low = mid + 1; else high = mid; }
    const unique = new Set<string>();
    for (let i = low; i < idStarts.length && i < low + MAX_REFS && idStarts[i] < to; i++) {
      unique.add(idTexts[i] ??= text.slice(idStarts[i], ids[i].endIndex));
    }
    return [...unique];
  };
  const nameOf = (entry: Entry): string => {
    entry.name ??= (profile.name?.(entry.node) ?? entry.node.childForFieldName('name')?.text.slice(0, 120)) ?? '';
    return entry.name;
  };

  const spans: Span[] = [];
  const open: Entry[] = [];
  let closedEndRow = -1;
  for (const entry of entries) {
    while (open.length && open[open.length - 1].endIndex <= entry.startIndex) {
      const closed = open.pop()!;
      if (closed.role.definition) closedEndRow = Math.max(closedEndRow, closed.endRow);
    }
    if (entry.role.definition) {
      const name = nameOf(entry);
      const trail = open.filter(parent => parent.role.container).map(nameOf).filter(Boolean);
      const owner = profile.owner?.(entry.node);
      if (owner) trail.push(owner);
      const lead = extendUp(entry.startRow, closedEndRow + 1, leads);
      const fragments = lead.used.filter(item => item.comment || profile.language === 'elixir').reverse().map(item => {
        const raw = lines.slice(item.start, item.end + 1).join('\n');
        return item.comment ? stripComment(raw) : stripElixirDoc(raw) ?? '';
      });
      const docstring = profile.docstring?.(entry.node);
      spans.push({
        start: lead.row + 1, end: entry.endRow + 1, name, kind: entry.kind,
        refs: refsOf(entry.startIndex, entry.endIndex),
        signature: signatureOf(entry.node, text, plan, comments),
        scope: trail.length ? [...trail, name].filter(Boolean).join(' > ') : undefined,
        doc: (docstring ? docText([stripDocstring(docstring)]) : undefined) ?? docText(fragments),
      });
    }
    open.push(entry);
  }
  return spans;
}

async function astSpans(profile: Profile, text: string, lines: readonly string[], options: ParseOptions): Promise<{ spans: Span[]; parsed: boolean }> {
  const parser = await getParser(profile.grammar);
  parser.setTimeoutMicros(Math.round((options.timeoutMs ?? PARSE_TIMEOUT_MS) * 1000));
  const input = parseInput(text);
  let tree: Parser.Tree;
  try { tree = parser.parse(input); } catch { parser.reset(); return { spans: [], parsed: false }; }
  try {
    const root = tree.rootNode;
    if (root.descendantCount > MAX_TREE_NODES) return { spans: [], parsed: false };
    const rich = options.rich ?? process.env.RSQ_PARSER_RICH === '1';
    // Indices and rows refer to `input`; it only differs from `text` by a dropped BOM, which keeps every row.
    const inputLines = input === text ? lines : input.split('\n');
    return { spans: extract(tree, input, inputLines, profile, planFor(profile, rich)), parsed: !root.hasError };
  } finally { tree.delete(); }
}

/** Generated and minified files: at most GENERATED_MAX_CHUNKS windows balanced by size, text always exact lines. */
function generatedChunks(path: string, text: string, lines: readonly string[]): Chunk[] {
  const bucketChars = Math.max(GENERATED_MIN_BUCKET, Math.ceil(text.length / GENERATED_MAX_CHUNKS));
  const chunks: Chunk[] = [];
  const flush = (first: number, last: number) => {
    const body = lines.slice(first, last + 1).join('\n');
    if (!body.trim()) return;
    const start = first + 1, end = last + 1;
    chunks.push({
      id: hash(`${path}:${start}:${end}:${body}`).slice(0, 16), path, start, end, name: '',
      kind: first === last && body.length > LONG_LINE ? 'longline' : 'window',
      text: body, terms: terms(`${path}  ${body.slice(0, GENERATED_TERMS_CHARS)}`), refs: [], generated: true,
    });
  };
  let first = 0, bucket = 0, offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const current = Math.floor(offset / bucketChars);
    if (current !== bucket) { flush(first, i - 1); first = i; bucket = current; }
    offset += lines[i].length + 1;
  }
  flush(first, lines.length - 1);
  return chunks;
}

export async function parseSource(path: string, text: string, options: ParseOptions = {}): Promise<ParseResult> {
  const lines = text.split('\n');
  const verdict = detectGenerated(path, text, lines);
  if (verdict.generated) return { chunks: generatedChunks(path, text, lines), parsed: false, generated: true, generatedReason: verdict.reason };
  const spans: Span[] = [];
  let parsed = false;
  const profile = chooseProfile(path, text);
  if (profile && text.length <= (profile.maxChars ?? MAX_PARSE_CHARS) && maxNesting(text) <= MAX_NESTING) {
    try {
      const result = await astSpans(profile, text, lines, options);
      for (const span of result.spans) spans.push(span);
      parsed = result.parsed;
    } catch { spans.length = 0; parsed = false; }
  }
  // Every line remains searchable, including imports, comments and unsupported languages.
  for (let start = 1; start <= lines.length; start += WINDOW_STRIDE) {
    spans.push({ start, end: Math.min(lines.length, start + WINDOW_LINES - 1), name: '', kind: 'window', refs: [] });
  }
  const chunks: Chunk[] = [];
  const seen = new Set<string>();
  // A first piece must not lose its range to the continuation piece of another definition.
  const firstPieces = new Set<string>();
  for (const span of spans) if (span.kind !== 'window') firstPieces.add(`${span.start}:${Math.min(span.end, span.start + PIECE_LINES - 1)}`);
  for (const span of spans) {
    // Bound huge classes/functions without dropping their internal definitions.
    for (let start = span.start; start <= span.end; start += PIECE_STRIDE) {
      const end = Math.min(span.end, start + PIECE_LINES - 1);
      const key = `${start}:${end}`;
      if (seen.has(key) || (start > span.start && firstPieces.has(key))) continue;
      seen.add(key);
      const body = lines.slice(start - 1, end).join('\n');
      if (!body.trim()) continue;
      const chunk: Chunk = { id: hash(`${path}:${start}:${end}:${body}`).slice(0, 16), path, start, end, name: span.name, kind: span.kind, text: body, terms: terms(`${path} ${span.name} ${body}`), refs: span.refs };
      if (start === span.start) {
        if (span.signature) chunk.signature = span.signature;
        if (span.doc) chunk.doc = span.doc;
      } else chunk.cont = true;
      if (span.scope) chunk.scope = span.scope;
      chunks.push(chunk);
      if (end === span.end) break;
    }
  }
  return { chunks, parsed };
}
