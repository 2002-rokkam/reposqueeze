// Deterministic, dependency-free understanding of failure traces and issue text.
//
//   parseQuery     structured view of a query: stack frames, error lines, failing tests, symbols, paths
//   condenseQuery  reduces arbitrarily long issue/log text to a compact, high-signal query
//   resolveFrame   maps a printed frame path to repository-relative paths
//
// Every scanner is linear in the input size: patterns are anchored, use disjoint character classes or are
// written as manual scans, and long lines are split into bounded windows before matching.

export type FrameLanguage = 'python' | 'javascript' | 'java' | 'go' | 'rust' | 'c' | 'csharp' | 'ruby' | 'php' | 'kotlin' | 'swift' | 'unknown';

export interface StackFrame {
  /** Path as printed, with slashes normalised and scheme, webpack prefixes and query strings removed. */
  path: string;
  /** One-based line. */
  line?: number;
  column?: number;
  /** Function or method as printed, for example `handle_request`, `Foo.bar`, `org.x.Y.z`. */
  func?: string;
  /** Container of the function: Java package, Go package, Rust module path, Ruby module, class prefix. */
  qualifier?: string;
  language: FrameLanguage;
  /** The original line, trimmed and cut to 300 characters. */
  raw: string;
  /** Order of appearance in the text, zero based. */
  index: number;
  /** Trace segment (chained exceptions, `Caused by:`, goroutines) the frame belongs to, zero based. */
  segment?: number;
}

export interface ParsedQuery {
  frames: StackFrame[];
  /** True when the trace format lists the most recent call first. */
  innermostFirst: boolean;
  errorLines: string[];
  testNames: string[];
  symbols: string[];
  quoted: string[];
  paths: string[];
  isTrace: boolean;
}

export type FrameKind = 'app' | 'dependency' | 'runtime';

type Order = 'first' | 'last';

const MAX_INPUT_CHARS = 4_000_000;
const HEAD_KEEP_CHARS = 2_500_000;
const MAX_LINE_CHARS = 2_000;
const WINDOW_CHARS = 1_000;
const MAX_FRAMES_HEAD = 2_500;
const MAX_FRAMES_TAIL = 2_500;
const MAX_ERROR_LINES = 20;
const MAX_TEST_NAMES = 50;
const MAX_SYMBOLS = 60;
const MAX_QUOTED = 40;
const MAX_PATHS = 200;
const RAW_CHARS = 300;

const SOURCE_EXTENSIONS = new Set(('py pyi pyx pxd ipynb js jsx mjs cjs ts tsx mts cts vue svelte astro java kt kts scala groovy gradle ' +
  'go rs c h cc cpp cxx hpp hh hxx inl m mm cs csx fs fsx vb rb rake gemspec erb haml slim php phtml twig swift dart lua pl pm r jl ' +
  'ex exs erl hrl hs lhs clj cljs cljc elm sh bash zsh fish ps1 psm1 bat cmd sql graphql gql proto thrift html htm xhtml css scss sass ' +
  'less styl json jsonc json5 yaml yml toml ini cfg conf properties xml xsd xsl xslt md markdown rst txt tex adoc cmake mk dockerfile tf ' +
  'tfvars hcl nix bzl bazel').split(' '));

const KNOWN_FILE_NAMES = new Set(['Makefile', 'makefile', 'GNUmakefile', 'Dockerfile', 'Containerfile', 'Rakefile', 'Gemfile', 'Podfile',
  'Procfile', 'Vagrantfile', 'Jenkinsfile', 'CMakeLists.txt', 'BUILD', 'WORKSPACE', 'SConstruct', 'Pipfile', 'Brewfile', 'Justfile']);

// Library and product names that look like `name.ext` file names in prose.
const BRAND_NAMES = new Set(['node.js', 'vue.js', 'next.js', 'nuxt.js', 'd3.js', 'three.js', 'chart.js', 'ember.js', 'backbone.js', 'angular.js',
  'react.js', 'express.js', 'p5.js', 'alpine.js', 'nest.js', 'deno.js', 'socket.io', 'moment.js', 'knockout.js', 'underscore.js', 'require.js']);

const EXTENSION_LANGUAGE: Record<string, FrameLanguage> = {
  py: 'python', pyi: 'python', pyx: 'python', pxd: 'python',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'javascript', tsx: 'javascript', mts: 'javascript',
  cts: 'javascript', vue: 'javascript', svelte: 'javascript', astro: 'javascript',
  java: 'java', scala: 'java', groovy: 'java', kt: 'kotlin', kts: 'kotlin',
  go: 'go', rs: 'rust',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', hxx: 'c', inl: 'c', m: 'c', mm: 'c',
  cs: 'csharp', rb: 'ruby', rake: 'ruby', erb: 'ruby', php: 'php', phtml: 'php', swift: 'swift',
};

// ---------------------------------------------------------------------------------------------------------------
// Character helpers

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isUpper = (c: number): boolean => c >= 65 && c <= 90;
const isLower = (c: number): boolean => c >= 97 && c <= 122;
const isAlpha = (c: number): boolean => isUpper(c) || isLower(c);
const isIdentStart = (c: number): boolean => isAlpha(c) || c === 95 || c === 36 || c > 127;
const isIdentChar = (c: number): boolean => isIdentStart(c) || isDigit(c);
const isSpace = (c: number): boolean => c === 32 || c === 9;

const PATH_TABLE = (() => {
  const table = new Uint8Array(128);
  for (const ch of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./\\@~+$%[]!&') table[ch.charCodeAt(0)] = 1;
  return table;
})();

function isPathCode(c: number): boolean {
  if (c < 128) return PATH_TABLE[c] === 1;
  return !(c === 0xa0 || c === 0xab || c === 0xbb || c === 0x3000 || (c >= 0x2000 && c <= 0x206f));
}

// ---------------------------------------------------------------------------------------------------------------
// Text preparation

const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
const SGR_LEFTOVER = /\[\d{1,3}(?:;\d{1,3}){0,4}m/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufeff\ufffd]/g;
const ESCAPED_TRACE = /\\n(?: {2,}|\\t)?(?:at |File |#\d|Caused by|\.\.\. \d)/;
const JSON_ESCAPE = /\\(?:r\\n|n|t|"|\\|\/)/g;

function unescapeJson(match: string): string {
  switch (match) {
    case '\\n': case '\\r\\n': return '\n';
    case '\\t': return '\t';
    case '\\"': return '"';
    case '\\\\': return '\\';
    default: return '/';
  }
}

/** Splits text into bounded, printable lines. Input beyond MAX_INPUT_CHARS keeps its head and its tail. */
function prepareText(input: string): { lines: string[]; continued: Uint8Array } {
  let text = input;
  if (text.length > MAX_INPUT_CHARS) text = `${text.slice(0, HEAD_KEEP_CHARS)}\n${text.slice(text.length - (MAX_INPUT_CHARS - HEAD_KEEP_CHARS))}`;
  if (text.indexOf('\u001b') >= 0) text = text.replace(ANSI, '');
  if (text.indexOf('[0m') >= 0 || text.indexOf('[39m') >= 0) text = text.replace(SGR_LEFTOVER, '');
  text = text.replace(CONTROL, ' ').replace(/(?:\r\n|\r|\n){3,}/g, '\n\n');
  const lines: string[] = [];
  const flags: number[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.length > 40 && line.indexOf('\\n') >= 0 && ESCAPED_TRACE.test(line)) {
      for (const part of line.replace(JSON_ESCAPE, unescapeJson).split('\n')) pushBounded(lines, flags, part);
    } else pushBounded(lines, flags, line);
  }
  return { lines, continued: Uint8Array.from(flags) };
}

const prepareLines = (input: string): string[] => prepareText(input).lines;

/** Lines longer than MAX_LINE_CHARS become windows; every window after the first is flagged as a continuation. */
function pushBounded(lines: string[], flags: number[], line: string): void {
  if (line.length <= MAX_LINE_CHARS) {
    pushInlineFrames(lines, flags, line, 0);
    return;
  }
  let start = 0;
  while (start < line.length) {
    let end = Math.min(line.length, start + WINDOW_CHARS);
    if (end < line.length) end = bestCut(line, start, end);
    pushInlineFrames(lines, flags, line.slice(start, end), start === 0 ? 0 : 1, 0);
    start = end;
  }
}

/** Prefers to cut a window at a run of spaces (frame separators in flattened traces), then at a single space. */
function bestCut(line: string, start: number, end: number): number {
  const floor = start + WINDOW_CHARS / 2;
  for (let i = end; i > floor; i--) {
    if (line.charCodeAt(i) === 32 && line.charCodeAt(i - 1) === 32) return i - 1;
  }
  for (let i = end; i > floor; i--) {
    if (line.charCodeAt(i) === 32) return i;
  }
  return end;
}

/** Single-line stack traces keep their frames separated by runs of spaces in front of `at `; those become separate lines. */
function pushInlineFrames(lines: string[], flags: number[], text: string, flag: number, minLength = 160): void {
  if (text.length < minLength || text.indexOf('  at ') < 0) {
    lines.push(text);
    flags.push(flag);
    return;
  }
  let cut = 0;
  let from = 0;
  for (;;) {
    const i = text.indexOf('  at ', from);
    if (i < 0) break;
    from = i + 5;
    if (text.charCodeAt(i + 5) === 32 || isBlankBetween(text, cut, i)) continue;
    lines.push(text.slice(cut, i));
    flags.push(cut === 0 ? flag : 1);
    cut = i;
  }
  lines.push(text.slice(cut));
  flags.push(cut === 0 ? flag : 1);
}

function isBlankBetween(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

const TIMESTAMP_PREFIXES: RegExp[] = [
  /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}(?::?\d{2})?)?\]?[ \t]+/,
  /^\[\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?\][ \t]+/,
  /^\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?[ \t]+/,
  /^\[\d{9,13}(?:\.\d+)?\][ \t]+/,
];
const COMPOSE_PREFIX = /^[\w.-]{1,50}[ \t]{0,3}\|[ \t]/;
const XDIST_PREFIX = /^\[gw\d+\][ \t]*/;
const PERCENT_PREFIX = /^\[ {0,2}\d{1,3}%\][ \t]*/;
const SANITIZER_PREFIX = /^(?:==|--)\d+(?:==|--)[ \t]?/;
const BRACKET_LEVEL_PREFIX = /^\[(?:ERROR|WARNING|WARN|INFO|DEBUG)\][ \t]*/;
const ACTIONS_PREFIX = /^##\[(?:error|warning|notice|group|debug)\][ \t]*/;

/** Removes log decoration that precedes the payload: timestamps, quote markers, list bullets, CI prefixes. */
function stripLinePrefix(input: string): string {
  let s = input;
  for (let round = 0; round < 4; round++) {
    const before = s;
    const c = s.charCodeAt(0);
    if (c === 62 || c === 124) s = s.slice(1).trimStart();
    else if ((c === 45 || c === 42 || c === 43 || c === 0x276f || c === 0x2192 || c === 0x2022) && isSpace(s.charCodeAt(1))) s = s.slice(2).trimStart();
    else if (c === 35 && (s.startsWith('# ./') || s.startsWith('# /'))) s = s.slice(2);
    else if (c === 35) s = dropFirst(s, [ACTIONS_PREFIX]);
    else if (c === 91 || isDigit(c)) {
      s = dropFirst(s, TIMESTAMP_PREFIXES);
      if (s === before && c === 91) s = dropFirst(s, [XDIST_PREFIX, PERCENT_PREFIX, BRACKET_LEVEL_PREFIX]);
    } else if (c === 61 || c === 45) s = dropFirst(s, [SANITIZER_PREFIX]);
    else if (isAlpha(c)) {
      const bar = s.indexOf('|');
      if (bar > 0 && bar < 60) s = dropFirst(s, [COMPOSE_PREFIX]);
    }
    if (s === before) break;
  }
  return s;
}

function dropFirst(s: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const m = pattern.exec(s);
    if (m) return s.slice(m[0].length).trimStart();
  }
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Path helpers

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function extensionOf(path: string): string {
  const base = baseName(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function languageOfPath(path: string): FrameLanguage {
  return EXTENSION_LANGUAGE[extensionOf(path)] ?? 'unknown';
}

/** Normalises a printed path: no URL scheme or bundler prefix, no query string, forward slashes. */
export function normalizeFramePath(input: string): string {
  let p = input.trim();
  if (p.startsWith('file://')) {
    p = p.slice(7);
    if (p.startsWith('localhost/')) p = p.slice(9);
    if (p.length > 2 && p.charCodeAt(0) === 47 && isAlpha(p.charCodeAt(1)) && p.charCodeAt(2) === 58) p = p.slice(1);
  } else if (p.startsWith('webpack-internal:///')) p = p.slice(20);
  else if (p.startsWith('webpack:///')) p = p.slice(11);
  else if (p.startsWith('webpack://')) {
    const rest = p.slice(10);
    const slash = rest.indexOf('/');
    p = slash >= 0 ? rest.slice(slash + 1) : rest;
  } else if (p.startsWith('app:///')) p = p.slice(6);
  else if (p.startsWith('/@fs/')) p = p.slice(4);
  else if (/^https?:\/\//i.test(p)) {
    const slash = p.indexOf('/', p.indexOf('//') + 2);
    if (slash > 0) p = p.slice(slash);
  }
  const query = p.indexOf('?');
  if (query >= 0) p = p.slice(0, query);
  const anchor = p.indexOf('#L');
  if (anchor >= 0) p = p.slice(0, anchor);
  if (p.indexOf('\\') >= 0) p = p.replace(/\\/g, '/');
  if (p.indexOf('//') > 0) p = p.replace(/(?<=.)\/{2,}/g, '/');
  return p;
}

function isPseudoPath(path: string): boolean {
  return !path || path.charCodeAt(0) === 60 || path === 'native' || path === 'unknown' || path.startsWith('[native');
}

function hasLetter(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (isAlpha(text.charCodeAt(i)) || text.charCodeAt(i) > 127) return true;
  return false;
}

/** True when `path` looks like a source or config file path worth reporting. */
function isPlausiblePath(path: string): boolean {
  if (path.length < 3 || path.length > 400) return false;
  const slash = path.lastIndexOf('/');
  const base = path.slice(slash + 1);
  if (!base || base.length > 120) return false;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (!ext) return KNOWN_FILE_NAMES.has(base);
  if (!SOURCE_EXTENSIONS.has(ext)) return false;
  if (slash >= 0) return hasLetter(base.slice(0, dot)) || base.startsWith('.');
  if (ext.length < 2 || BRAND_NAMES.has(base.toLowerCase())) return false;
  return hasLetter(base.slice(0, dot));
}

/** Frames come from a strong context, so any file-like token with an extension or a directory is acceptable. */
function isFramePath(path: string): boolean {
  if (path.length < 2 || path.length > 600 || isPseudoPath(path)) return false;
  if (path.indexOf('/') >= 0) return hasLetter(baseName(path));
  const dot = path.lastIndexOf('.');
  if (dot <= 0 || dot === path.length - 1) return KNOWN_FILE_NAMES.has(path);
  const ext = path.slice(dot + 1);
  return ext.length <= 8 && hasLetter(ext) && hasLetter(path.slice(0, dot));
}

interface Located {
  path: string;
  line?: number;
  column?: number;
  /** Index just after the location. */
  end: number;
}

function readInt(s: string, i: number): { value: number; end: number } | undefined {
  let j = i;
  while (j < s.length && j - i < 9 && isDigit(s.charCodeAt(j))) j++;
  if (j === i || (j < s.length && isDigit(s.charCodeAt(j)))) return undefined;
  return { value: parseInt(s.slice(i, j), 10), end: j };
}

function skipPath(s: string, i: number): number {
  let j = i;
  if (isAlpha(s.charCodeAt(j)) && s.charCodeAt(j + 1) === 58 && (s.charCodeAt(j + 2) === 92 || s.charCodeAt(j + 2) === 47)) j += 2;
  while (j < s.length && isPathCode(s.charCodeAt(j))) j++;
  return j;
}

/** Reads `path[:line[:col]]`, `path(line[,col])` or `path:[line,col]` starting exactly at `start`. */
function readLocation(s: string, start: number): Located | undefined {
  const end = skipPath(s, start);
  if (end === start) return undefined;
  let path = s.slice(start, end);
  while (path.length > 1 && path.charCodeAt(path.length - 1) === 93 && path.indexOf('[') < 0) path = path.slice(0, -1);
  let k = start + path.length;
  let line: number | undefined;
  let column: number | undefined;
  const c = s.charCodeAt(k);
  if (c === 58) {
    if (s.charCodeAt(k + 1) === 91) {
      const a = readInt(s, k + 2);
      if (a && s.charCodeAt(a.end) === 44) {
        const b = readInt(s, a.end + 1);
        if (b && s.charCodeAt(b.end) === 93) { line = a.value; column = b.value; k = b.end + 1; }
      }
    } else {
      const a = readInt(s, k + 1);
      if (a) {
        line = a.value;
        k = a.end;
        if (s.charCodeAt(k) === 58) {
          const b = readInt(s, k + 1);
          if (b) { column = b.value; k = b.end; }
        }
      }
    }
  } else if (c === 40) {
    const a = readInt(s, k + 1);
    if (a) {
      let e = a.end;
      let col: number | undefined;
      if (s.charCodeAt(e) === 44) {
        const b = readInt(s, e + 1);
        if (b) { col = b.value; e = b.end; }
      }
      if (s.charCodeAt(e) === 41) { line = a.value; column = col; k = e + 1; }
    }
  }
  return { path, line, column, end: k };
}

function trailingDigits(s: string, end: number): { value: number; colon: number } | undefined {
  let j = end;
  while (j > 0 && isDigit(s.charCodeAt(j - 1))) j--;
  if (j === end || end - j > 9 || j === 0 || s.charCodeAt(j - 1) !== 58) return undefined;
  return { value: parseInt(s.slice(j, end), 10), colon: j - 1 };
}

/** Splits `path:line:col` from the right, so URLs and drive letters in the path survive. */
function splitTrailingPosition(loc: string): { path: string; line?: number; column?: number } {
  const first = trailingDigits(loc, loc.length);
  if (!first) return { path: loc };
  const second = trailingDigits(loc, first.colon);
  if (second) return { path: loc.slice(0, second.colon), line: second.value, column: first.value };
  return { path: loc.slice(0, first.colon), line: first.value };
}

// ---------------------------------------------------------------------------------------------------------------
// Frame matchers

interface Match {
  path: string;
  line?: number;
  column?: number;
  func?: string;
  qualifier?: string;
  language: FrameLanguage;
  order: Order;
  /** Error text that shares the line: compiler diagnostics, Ruby messages. */
  error?: string;
  /** The previous line belongs to this frame (Go function line, Rust `N: name` line). */
  consumedPrev?: boolean;
  /** The line number is printed on a later line (Django `41.  code`, IPython `---> 41`). */
  awaitsLine?: boolean;
}

interface ParseState {
  prevRaw: string;
  pendingRust?: string;
  eslintPath?: string;
}

function findOpenParen(s: string, close: number): number {
  let depth = 0;
  for (let i = close - 1; i >= 0; i--) {
    const c = s.charCodeAt(i);
    if (c === 41) depth++;
    else if (c === 40) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

function stripArguments(name: string): string {
  const open = name.indexOf('(');
  return (open > 0 ? name.slice(0, open) : name).trim();
}

/** Container part of a function name: `Foo.bar` -> `Foo`, `a::b::c` -> `a::b`; Java and C# give the package. */
function qualifierOf(func: string | undefined, language: FrameLanguage): string | undefined {
  if (!func) return undefined;
  if (language === 'java' || language === 'kotlin') {
    const parts = func.split('.');
    const cls = parts.findIndex((part, i) => i < parts.length - 1 && isUpper(part.charCodeAt(0)));
    return cls > 0 ? parts.slice(0, cls).join('.') : undefined;
  }
  if (language === 'csharp') {
    const parts = func.split('.');
    return parts.length > 2 ? parts.slice(0, parts.length - 2).join('.') : undefined;
  }
  const cut = Math.max(func.lastIndexOf('::'), func.lastIndexOf('->'), func.lastIndexOf('#'), func.lastIndexOf('.'));
  return cut > 0 ? func.slice(0, cut) : undefined;
}

function makeMatch(path: string, line: number | undefined, column: number | undefined, func: string | undefined, language: FrameLanguage, order: Order): Match {
  const cleaned = func?.trim() || undefined;
  return { path, line, column, func: cleaned, qualifier: qualifierOf(cleaned, language), language, order };
}

function matchPythonFile(t: string): Match | null | undefined {
  let path: string;
  let line: number | undefined;
  let i: number;
  if (t.charCodeAt(5) === 34) {
    const close = t.indexOf('"', 6);
    if (close < 0) return undefined;
    path = t.slice(6, close);
    i = close + 1;
    if (t.startsWith(', line ', i)) {
      const n = readInt(t, i + 7);
      if (n) { line = n.value; i = n.end; }
    }
  } else {
    const loc = readLocation(t, 5);
    if (!loc || loc.line === undefined) return undefined;
    path = loc.path;
    line = loc.line;
    i = loc.end;
  }
  let func: string | undefined;
  let awaitsLine = false;
  if (t.startsWith(', in ', i)) func = stripArguments(t.slice(i + 5));
  else if (t.startsWith(' in ', i)) { func = stripArguments(t.slice(i + 4)); awaitsLine = line === undefined; }
  path = normalizeFramePath(path);
  if (isPseudoPath(path)) return null;
  const match = makeMatch(path, line, undefined, func, 'python', 'last');
  match.awaitsLine = awaitsLine;
  return match;
}

function matchCsharp(rest: string): Match | null | undefined {
  const mono = rest.indexOf(' [0x');
  const inAt = rest.indexOf(') in ');
  if (inAt < 0 && mono < 0) return undefined;
  let signature: string;
  let location: string;
  if (inAt >= 0 && rest.lastIndexOf(':line ') > inAt) {
    const lineAt = rest.lastIndexOf(':line ');
    signature = rest.slice(0, inAt + 1);
    location = `${rest.slice(inAt + 5, lineAt)}:${rest.slice(lineAt + 6).trim()}`;
  } else if (mono > 0 && rest.indexOf(' in ', mono) > 0) {
    signature = rest.slice(0, mono);
    location = rest.slice(rest.indexOf(' in ', mono) + 4);
  } else return undefined;
  const pos = splitTrailingPosition(location.trim());
  const path = normalizeFramePath(pos.path);
  if (isPseudoPath(path) || path.startsWith('<') || !isFramePath(path)) return null;
  const open = signature.indexOf('(');
  const func = (open > 0 ? signature.slice(0, open) : signature).trim();
  return makeMatch(path, pos.line, undefined, func, 'csharp', 'first');
}

function parseJsLocation(loc: string, depth = 0): { path: string; line?: number; column?: number } | undefined {
  const text = loc.trim();
  if (text.startsWith('eval at ') && depth < 3) {
    const open = text.indexOf('(');
    const close = open >= 0 ? text.lastIndexOf(')') : -1;
    if (open < 0 || close <= open) return undefined;
    const inner = text.slice(open + 1, close);
    const comma = inner.lastIndexOf('), ');
    return parseJsLocation(comma > 0 ? inner.slice(0, comma) : inner, depth + 1);
  }
  const pos = splitTrailingPosition(text);
  const path = normalizeFramePath(pos.path);
  if (!isFramePath(path)) return undefined;
  return { path, line: pos.line, column: pos.column };
}

const PLACEHOLDER_LOCATION = /^(?:<anonymous>|native|native code|\[native code\]|index \d+|unknown location|<unknown>|eval|<eval>)$/;

/** `Ns.Type.Method(args)`: a frame without source information (C#, Java). */
function looksLikeQualifiedCall(rest: string): boolean {
  if (rest.charCodeAt(rest.length - 1) !== 41) return false;
  let dots = 0;
  for (let i = 0; i < rest.length && i < 200; i++) {
    const c = rest.charCodeAt(i);
    if (c === 40) return dots > 0 && i >= 3;
    if (c === 46) dots++;
    else if (!(isIdentChar(c) || c === 60 || c === 62 || c === 91 || c === 93 || c === 96 || c === 44 || c === 43)) return false;
  }
  return false;
}

/** Drops closing JSON or prose punctuation that follows a location at the end of a line. */
function trimTrailingJunk(s: string): string {
  let end = s.length;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c === 34 || c === 39 || c === 125 || c === 93 || c === 44 || c === 59 || c === 32) end--;
    else break;
  }
  return end === s.length ? s : s.slice(0, end);
}

/** `at` lines: Node/V8, Java/Kotlin/Scala, C#, Rust backtraces and Valgrind. */
function matchAt(input: string, st: ParseState): Match | null | undefined {
  let rest = input.trim();
  if (rest.startsWith('0x')) {
    const colon = rest.indexOf(': ');
    if (colon > 0 && colon < 24) rest = rest.slice(colon + 2);
  }
  const csharp = matchCsharp(rest);
  if (csharp !== undefined) return csharp;
  let func = '';
  let loc = rest;
  const close = rest.lastIndexOf(')');
  if (close > 0) {
    const tail = rest.slice(close + 1).trim();
    if (tail === '' || tail.charCodeAt(0) === 91 || tail.charCodeAt(0) === 126) {
      const open = findOpenParen(rest, close);
      if (open >= 0) {
        loc = rest.slice(open + 1, close);
        func = rest.slice(0, open).trim();
      }
    }
  }
  if (loc === rest) loc = trimTrailingJunk(rest);
  const jvm = /^[^\s:()]+\.(?:java|kt|kts|scala|groovy|clj|cljc)(?::\d+)?$/.exec(loc);
  if (jvm) {
    const pos = splitTrailingPosition(loc);
    const slash = func.lastIndexOf('/');
    if (slash >= 0) func = func.slice(slash + 1);
    const language: FrameLanguage = extensionOf(pos.path) === 'kt' || extensionOf(pos.path) === 'kts' ? 'kotlin' : 'java';
    return makeMatch(pos.path, pos.line, undefined, func, language, 'first');
  }
  if (loc === 'Native Method' || loc.startsWith('Unknown Source') || loc === 'SourceFile') return null;
  const parsed = parseJsLocation(loc);
  if (!parsed) return PLACEHOLDER_LOCATION.test(loc) || looksLikeQualifiedCall(rest) ? null : undefined;
  if (func.startsWith('async ')) func = func.slice(6);
  const language = languageOfPath(parsed.path);
  let name = func;
  let consumedPrev = false;
  if (!name && st.pendingRust) {
    name = st.pendingRust;
    consumedPrev = true;
  }
  const match = makeMatch(parsed.path, parsed.line, parsed.column, name, language === 'unknown' ? 'javascript' : language, 'first');
  match.consumedPrev = consumedPrev;
  return match;
}

/** Firefox and Safari: `func@https://host/app.js:12:34`. */
function matchAtSign(t: string): Match | undefined {
  const at = t.indexOf('@');
  if (at < 0 || at > 60 || at > t.length - 5) return undefined;
  const pos = splitTrailingPosition(t.slice(at + 1));
  if (pos.line === undefined || pos.column === undefined) return undefined;
  const path = normalizeFramePath(pos.path);
  if (!isFramePath(path) || /\s/.test(path)) return undefined;
  const func = t.slice(0, at).trim();
  if (/[\s]{2}/.test(func)) return undefined;
  const language = languageOfPath(path);
  return makeMatch(path, pos.line, pos.column, func, language === 'unknown' ? 'javascript' : language, 'first');
}

/** `#N ...` lines: PHP, gdb, lldb and the address sanitizers. */
function matchHash(t: string): Match | null | undefined {
  let i = 1;
  while (i < t.length && isDigit(t.charCodeAt(i))) i++;
  if (i === 1 || i > 6 || !isSpace(t.charCodeAt(i))) return undefined;
  let rest = t.slice(i).trim();
  if (rest.startsWith('[internal function]') || rest.startsWith('{main}')) return null;
  const paren = rest.indexOf('(');
  if (paren > 0 && rest.charCodeAt(0) !== 48) {
    const n = readInt(rest, paren + 1);
    if (n && rest.startsWith('): ', n.end)) {
      const path = normalizeFramePath(rest.slice(0, paren));
      if (isFramePath(path)) {
        const call = rest.slice(n.end + 3);
        const open = call.indexOf('(');
        return makeMatch(path, n.value, undefined, open > 0 ? call.slice(0, open) : call, 'php', 'first');
      }
    }
  }
  if (rest.startsWith('0x')) {
    const inAt = rest.indexOf(' in ');
    if (inAt > 0 && inAt < 24) rest = rest.slice(inAt + 4);
    else return undefined;
  }
  let location: string;
  let signature: string;
  const atIdx = rest.lastIndexOf(' at ');
  if (atIdx > 0) {
    location = rest.slice(atIdx + 4);
    signature = rest.slice(0, atIdx);
  } else {
    const space = rest.lastIndexOf(' ');
    if (space <= 0) return undefined;
    location = rest.slice(space + 1);
    signature = rest.slice(0, space);
  }
  if (location.charCodeAt(0) === 40 && location.charCodeAt(location.length - 1) === 41) location = location.slice(1, -1);
  const pos = splitTrailingPosition(location);
  if (pos.line === undefined) return undefined;
  const path = normalizeFramePath(pos.path);
  if (!isFramePath(path)) return undefined;
  const open = signature.indexOf(' (');
  const func = (open > 0 ? signature.slice(0, open) : signature).trim();
  const language = languageOfPath(path);
  return makeMatch(path, pos.line, pos.column, func, language === 'unknown' ? 'c' : language, 'first');
}

function splitGoName(name: string): { func: string; qualifier?: string } {
  const slash = name.lastIndexOf('/');
  let dot = name.indexOf('.', slash + 1);
  if (dot < 0) return { func: name };
  while (/^\.v\d+\./.test(name.slice(dot, dot + 8))) dot = name.indexOf('.', dot + 1);
  if (dot < 0) return { func: name };
  const func = name.slice(dot + 1).replace(/\(\*?([\w$]+)(?:\[[^\]]*\])?\)/g, '$1').replace(/\[\.\.\.\]/g, '');
  return { func, qualifier: name.slice(0, dot) };
}

function parseGoFuncLine(prevRaw: string): { func: string; qualifier?: string } | undefined {
  if (!prevRaw || isSpace(prevRaw.charCodeAt(0))) return undefined;
  let s = prevRaw.trim();
  if (s.startsWith('created by ')) {
    s = s.slice(11);
    const goroutine = s.indexOf(' in goroutine');
    return splitGoName(goroutine > 0 ? s.slice(0, goroutine) : s);
  }
  if (s.charCodeAt(s.length - 1) !== 41) return undefined;
  const open = findOpenParen(s, s.length - 1);
  if (open <= 0) return undefined;
  const name = s.slice(0, open);
  return name.indexOf(' ') >= 0 ? undefined : splitGoName(name);
}

function cleanRubyFunc(name: string): string {
  return name.replace(/^(?:(?:block|rescue|ensure)(?: \(\d+ levels\))? in )+/, '');
}

function parseInClause(rest: string): { func?: string; message?: string } {
  let text = rest.trim();
  if (text.startsWith('function ') || text.startsWith('local ') || text.startsWith('method ') || text.startsWith('field ') || text.startsWith('upvalue ')) {
    text = text.slice(text.indexOf(' ') + 1);
  }
  const quote = text.charCodeAt(0);
  if (quote === 39 || quote === 96 || quote === 34) {
    const close = text.indexOf(quote === 34 ? '"' : "'", 1);
    if (close > 0) {
      const after = text.slice(close + 1);
      return { func: text.slice(1, close), message: after.startsWith(': ') ? after.slice(2).trim() : undefined };
    }
  }
  return { func: text.trim() || undefined };
}

const DIAGNOSTIC = /^(?:fatal error|runtime error|error|warning|note|info|hint|remark|Error|Warning|Fatal)\b/;
const TOOL_CODE = /^[A-Z]{1,4}\d{2,5}\b/;

function matchGoLocation(path: string, loc: Located, raw: string, rest: string, st: ParseState): Match | undefined {
  if (!(rest.startsWith(' +0x') || (rest === '' && languageOfPath(path) === 'go' && isSpace(raw.charCodeAt(0))))) return undefined;
  const parsed = parseGoFuncLine(st.prevRaw);
  const match = makeMatch(path, loc.line, undefined, parsed?.func, 'go', 'first');
  if (parsed?.qualifier) match.qualifier = parsed.qualifier;
  match.consumedPrev = parsed !== undefined;
  return match;
}

function matchLocationWithoutLine(path: string, s: string, loc: Located, rest: string): Match | undefined {
  if (rest.startsWith(':(.text') || rest.startsWith(':(.data')) {
    if (!isFramePath(path)) return undefined;
    const match = makeMatch(path, undefined, undefined, undefined, languageOfPath(path), 'first');
    match.error = s;
    return match;
  }
  if (rest.startsWith(' in ') && extensionOf(path) === 'py' && path.indexOf('/') >= 0) {
    const match = makeMatch(path, undefined, undefined, stripArguments(rest.slice(4)), 'python', 'last');
    match.awaitsLine = true;
    return match;
  }
  if (rest.startsWith(': (')) {
    const a = readInt(rest, 3);
    const comma = a ? rest.charCodeAt(a.end) === 44 : false;
    if (a && comma) {
      const b = readInt(rest, a.end + 2);
      if (b && rest.charCodeAt(b.end) === 41) {
        const message = rest.slice(b.end + 1).replace(/^:\s*/, '');
        const match = makeMatch(path, a.value, b.value, undefined, languageOfPath(path), 'first');
        match.error = message || undefined;
        return isFramePath(path) ? match : undefined;
      }
    }
  }
  if (loc.end === s.length) return undefined;
  // Vitest: `fn path:line:col`
  if (rest.charCodeAt(0) === 32 && /^[\w$.<>]+$/.test(path) && !path.includes('/') && !STOP_WORDS.has(path.toLowerCase())) {
    const inner = readLocation(rest, 1);
    if (inner && inner.line !== undefined && inner.end === rest.length) {
      const innerPath = normalizeFramePath(inner.path);
      if (isFramePath(innerPath) && innerPath.indexOf('/') >= 0) return makeMatch(innerPath, inner.line, inner.column, path, languageOfPath(innerPath), 'first');
    }
  }
  return undefined;
}

/** Lines that start with `path:line`: compilers, pytest, Ruby, Go, Node source pointers, grep-style output. */
function matchLocationLine(t: string, raw: string, st: ParseState): Match | null | undefined {
  let s = t;
  if ((s.startsWith('e: ') || s.startsWith('w: ')) && s.length > 6) s = s.slice(3);
  if (s.startsWith('file://')) {
    const space = s.indexOf(' ');
    s = space > 0 ? normalizeFramePath(s.slice(0, space)) + s.slice(space) : normalizeFramePath(s);
  }
  const c0 = s.charCodeAt(0);
  if (!isPathCode(c0) || c0 === 91) return undefined;
  const loc = readLocation(s, 0);
  if (!loc) return undefined;
  const path = normalizeFramePath(loc.path);
  const rest = s.slice(loc.end);
  if (loc.line === undefined) return matchLocationWithoutLine(path, s, loc, rest);
  if (!isFramePath(path)) return undefined;
  const go = matchGoLocation(path, loc, raw, rest, st);
  if (go) return go;
  const language = languageOfPath(path);
  const defaultOrder: Order = language === 'python' ? 'last' : 'first';
  if (rest.startsWith(':in ')) {
    const clause = parseInClause(rest.slice(4));
    const match = makeMatch(path, loc.line, loc.column, clause.func ? cleanRubyFunc(clause.func) : undefined, language === 'unknown' ? 'ruby' : language, 'first');
    match.error = clause.message;
    return match;
  }
  let tail = rest;
  if (tail.charCodeAt(0) === 58) tail = tail.slice(1);
  else if (tail.startsWith(' - ')) tail = tail.slice(3);
  else if (tail !== '' && !isSpace(tail.charCodeAt(0))) return undefined;
  tail = tail.trim();
  if (tail === '') return path.indexOf('/') >= 0 || isPlausiblePath(path) ? makeMatch(path, loc.line, loc.column, undefined, language, defaultOrder) : undefined;
  if (tail.startsWith('in ') && tail.length > 3) {
    const clause = parseInClause(tail.slice(3));
    return makeMatch(path, loc.line, loc.column, clause.func, language, language === 'python' ? 'last' : 'first');
  }
  const match = makeMatch(path, loc.line, loc.column, undefined, language, defaultOrder);
  const diagnostic = DIAGNOSTIC.test(tail);
  if (loc.line !== undefined && s.charCodeAt(loc.end - 1) === 93) {
    match.error = tail;
  } else if (diagnostic) {
    if (!/^(?:warning|note|info|hint|remark|Warning)\b/.test(tail)) match.error = tail;
  } else {
    const header = exceptionHeader(tail);
    if (header) match.error = header;
    else if (language === 'go' && loc.column !== undefined && !path.endsWith('_test.go')) match.error = tail;
    else if (!TOOL_CODE.test(tail) && language === 'go' && path.endsWith('_test.go')) match.error = tail;
  }
  return diagnostic || path.indexOf('/') >= 0 || isPlausiblePath(path) ? match : undefined;
}

/** `Fatal error: ... in /x.php on line 12`, `Died at x.pl line 3.`, `... file F.swift, line 9`, Django `Exception Location:`. */
function matchLineSuffix(t: string): Match | undefined {
  if (t.length > 800) return undefined;
  const idx = t.lastIndexOf('line ');
  if (idx >= 2) {
    const before = t.charCodeAt(idx - 1);
    const n = before === 32 || before === 44 ? readInt(t, idx + 5) : undefined;
    if (n) {
      let head = t.slice(0, idx).trimEnd();
      if (head.endsWith(' on')) head = head.slice(0, -3);
      if (head.endsWith(',')) head = head.slice(0, -1);
      const path = normalizeFramePath(head.slice(head.lastIndexOf(' ') + 1));
      if (isPlausiblePath(path)) {
        const after = t.slice(n.end);
        const func = after.startsWith(', in ') ? stripArguments(after.slice(5)) : undefined;
        const language = languageOfPath(path);
        const match = makeMatch(path, n.value, undefined, func, language, language === 'python' ? 'last' : 'first');
        if (/(?:error|exception|warning|died|fatal)/i.test(head)) match.error = t;
        return match;
      }
    }
  }
  const inAt = t.lastIndexOf(' in ');
  if (inAt > 0 && (t.indexOf('Uncaught ') >= 0 || t.startsWith('PHP '))) {
    const loc = readLocation(t, inAt + 4);
    const path = loc ? normalizeFramePath(loc.path) : '';
    if (loc && loc.line !== undefined && isPlausiblePath(path)) {
      const match = makeMatch(path, loc.line, undefined, undefined, languageOfPath(path), 'first');
      match.error = t.slice(0, inAt);
      return match;
    }
  }
  return undefined;
}

function matchRust(t: string): Match | undefined {
  if (t.startsWith('--> ') || t.startsWith('::: ')) {
    const loc = readLocation(t, 4);
    if (!loc || loc.line === undefined) return undefined;
    const path = normalizeFramePath(loc.path);
    return isFramePath(path) ? makeMatch(path, loc.line, loc.column, undefined, 'rust', 'first') : undefined;
  }
  const idx = t.indexOf(' panicked at ');
  if (idx < 0) return undefined;
  const thread = t.slice(0, idx);
  const rest = t.slice(idx + 13);
  let location = rest;
  let message = '';
  const quote = rest.charAt(0);
  if (quote === "'" || quote === '"') {
    const sep = rest.lastIndexOf(`${quote}, `);
    if (sep <= 0) return undefined;
    message = rest.slice(1, sep);
    location = rest.slice(sep + 3);
  } else if (location.endsWith(':')) location = location.slice(0, -1);
  const pos = splitTrailingPosition(location.trim());
  const path = normalizeFramePath(pos.path);
  if (pos.line === undefined || !isFramePath(path)) return undefined;
  const match = makeMatch(path, pos.line, pos.column, undefined, 'rust', 'first');
  match.error = `${thread} panicked at ${path}:${pos.line}${pos.column === undefined ? '' : `:${pos.column}`}${message ? `: ${message}` : ''}`;
  return match;
}

/** `::error file=a.py,line=3,col=5::message` workflow commands. */
function matchAnnotation(t: string): Match | undefined {
  const kind = t.startsWith('::error ') ? 8 : t.startsWith('::warning ') ? 10 : t.startsWith('::notice ') ? 9 : 0;
  if (!kind) return undefined;
  const end = t.indexOf('::', kind);
  if (end < 0) return undefined;
  const attrs = new Map<string, string>();
  for (const part of t.slice(kind, end).split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) attrs.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const path = normalizeFramePath(attrs.get('file') ?? '');
  if (!isFramePath(path)) return undefined;
  const line = parseInt(attrs.get('line') ?? '', 10);
  const column = parseInt(attrs.get('col') ?? '', 10);
  const match = makeMatch(path, Number.isFinite(line) ? line : undefined, Number.isFinite(column) ? column : undefined, undefined, languageOfPath(path), 'first');
  if (kind === 8) match.error = t.slice(end + 2).trim() || undefined;
  return match;
}

/** ESLint stylish output: a path line followed by `12:5  error  message  rule` rows. */
function matchEslintRow(t: string, st: ParseState): Match | undefined {
  if (!st.eslintPath) return undefined;
  const a = readInt(t, 0);
  if (!a || t.charCodeAt(a.end) !== 58) return undefined;
  const b = readInt(t, a.end + 1);
  if (!b || !/^ {2,}(?:error|warning) {2,}/.test(t.slice(b.end))) return undefined;
  const match = makeMatch(st.eslintPath, a.value, b.value, undefined, languageOfPath(st.eslintPath), 'first');
  if (/^ {2,}error/.test(t.slice(b.end))) match.error = t.slice(b.end).trim();
  return match;
}

function matchFrame(t: string, raw: string, st: ParseState): Match | null | undefined {
  const c = t.charCodeAt(0);
  if (c === 70 && t.startsWith('File ')) {
    const py = matchPythonFile(t);
    if (py !== undefined) return py;
  } else if (c === 97 && t.startsWith('at ')) {
    return matchAt(t.slice(3), st);
  } else if (c === 98 && t.startsWith('by 0x')) {
    return matchAt(t.slice(3), st);
  } else if (c === 35) {
    const hash = matchHash(t);
    if (hash !== undefined) return hash;
  } else if (c === 102 && t.startsWith('from ')) {
    const ruby = matchLocationLine(t.slice(5).trimStart(), raw, st);
    if (ruby) return { ...ruby, order: 'first' };
  } else if (c === 58 && t.startsWith('::')) {
    const annotation = matchAnnotation(t);
    if (annotation) return annotation;
  } else if (isDigit(c)) {
    const reversed = /^\d+: from (.+)$/.exec(t);
    if (reversed) {
      const ruby = matchLocationLine(reversed[1], raw, st);
      if (ruby) return { ...ruby, order: 'last' };
    }
    const row = matchEslintRow(t, st);
    if (row) return row;
  }
  const rust = matchRust(t);
  if (rust) return rust;
  const loc = matchLocationLine(t, raw, st);
  if (loc !== undefined) return loc;
  const sign = t.indexOf('@') > 0 ? matchAtSign(t) : undefined;
  if (sign) return sign;
  return matchLineSuffix(t);
}

// ---------------------------------------------------------------------------------------------------------------
// Error lines and failing tests

const EXCEPTION_SUFFIX = /(?:Error|Exception|Failure|Fault|Panic|Warning|Interrupt|Exit|Timeout|Abort|Violation|Exhausted)$/;
const HEADER_PREFIXES = ['Uncaught (in promise) ', 'Uncaught ', 'Unhandled exception. ', 'Unhandled Exception: ', 'Unhandled ', 'Caused by: ',
  'Suppressed: ', 'Fatal error: ', '---> '];

/** Returns the line when it starts like an exception report (`pkg.FooError: message`), otherwise undefined. */
function exceptionHeader(s: string): string | undefined {
  let i = 0;
  if (s.startsWith('Exception in thread "')) {
    const quote = s.indexOf('" ', 21);
    if (quote < 0) return undefined;
    i = quote + 2;
  } else {
    for (const prefix of HEADER_PREFIXES) {
      if (s.startsWith(prefix)) { i = prefix.length; break; }
    }
  }
  let j = i;
  while (j < s.length && j - i < 160) {
    const c = s.charCodeAt(j);
    if (isIdentChar(c) || c === 46 || c === 92) j++;
    else if (c === 58 && s.charCodeAt(j + 1) === 58 && isIdentStart(s.charCodeAt(j + 2))) j += 2;
    else break;
  }
  if (j === i) return undefined;
  if (j < s.length) {
    const next = s.charCodeAt(j);
    const after = s.charCodeAt(j + 1);
    if (!(next === 58 || (next === 32 && (after === 40 || after === 91)))) return undefined;
  }
  const name = s.slice(i, j);
  const cut = Math.max(name.lastIndexOf('.'), name.lastIndexOf(':'), name.lastIndexOf('\\'));
  const last = name.slice(cut + 1);
  if (!isUpper(last.charCodeAt(0)) || !EXCEPTION_SUFFIX.test(last)) return undefined;
  if (last === 'Warning' && cut < 0) return undefined;
  const message = s.slice(j).replace(/^:\s*/, '').trim();
  if (cut < 0 && !message && (last === 'Error' || last === 'Failure' || last === 'Exception') && i === 0) return undefined;
  return s;
}

interface ErrorEntry { text: string; priority: number; lineIndex: number }

interface Sink {
  errors: ErrorEntry[];
  errorSet: Set<string>;
  tests: string[];
  testSet: Set<string>;
  numbered: string[];
  failMarker: boolean;
  traceback: boolean;
  /** Index into `errors` of a Rust panic whose message is printed on the next line. */
  panicEntry: number;
  pendingNumbered?: { title: string; lines: number };
  cargoList: boolean;
  prevWasE: boolean;
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

function addError(sink: Sink, text: string, priority: number, lineIndex: number): number {
  const clean = squash(text).slice(0, RAW_CHARS);
  if (clean.length < 3 || sink.errorSet.has(clean) || sink.errors.length >= 2000) return -1;
  sink.errorSet.add(clean);
  sink.errors.push({ text: clean, priority, lineIndex });
  return sink.errors.length - 1;
}

function addTest(sink: Sink, name: string): void {
  const clean = squash(name).slice(0, 200);
  if (clean.length < 2 || sink.testSet.has(clean) || sink.tests.length >= 500) return;
  sink.testSet.add(clean);
  sink.tests.push(clean);
}

function firstToken(s: string): string {
  let i = 0;
  while (i < s.length && !isSpace(s.charCodeAt(i))) i++;
  return s.slice(0, i);
}

function trimUnderscores(s: string): string {
  let i = 0;
  let j = s.length;
  while (i < j && (s.charCodeAt(i) === 95 || isSpace(s.charCodeAt(i)))) i++;
  while (j > i && (s.charCodeAt(j - 1) === 95 || isSpace(s.charCodeAt(j - 1)))) j--;
  return s.slice(i, j);
}

function isIdentifier(s: string): boolean {
  if (!s || !isIdentStart(s.charCodeAt(0))) return false;
  for (let i = 1; i < s.length; i++) if (!isIdentChar(s.charCodeAt(i))) return false;
  return true;
}

function isDotted(s: string): boolean {
  return s.length > 0 && s.split('.').every(isIdentifier);
}

function isFailMarker(t: string): boolean {
  if (t.length < 4 || t.length > 400) return false;
  const c = t.charCodeAt(0);
  if (c === 61 && t.startsWith('=== FAILURES')) return true;
  if (c === 70 && (t.startsWith('FAILURES!') || t === 'Failures:' || t.startsWith('FAIL ') || t === 'FAIL' || t.startsWith('FAILED') || t.startsWith('FAIL\t'))) return true;
  if (c === 45 && t.startsWith('--- FAIL')) return true;
  if (c === 116 && t.startsWith('test result: FAILED')) return true;
  if (c === 84 && t.startsWith('Tests run:')) return (t.includes('Failures: ') && !t.includes('Failures: 0')) || (t.includes('Errors: ') && !t.includes('Errors: 0'));
  if (c === 84 && (t.startsWith('Tests:') || t.startsWith('Test Suites:'))) return t.includes('failed');
  if (c === 84 && t.startsWith('There w')) return t.includes(' failure') || t.includes(' error');
  if (t.includes('<<< FAILURE') || t.includes('<<< ERROR')) return true;
  return t.endsWith(' failing') || t.includes('FAILED (') || t.includes(' tests failed');
}

/** Recognises one test-failure line. Returns true when the line was consumed as a test line. */
function detectTest(t: string, raw: string, sink: Sink): boolean {
  const c = t.charCodeAt(0);
  if (c === 45 && t.startsWith('--- FAIL: ')) {
    addTest(sink, firstToken(t.slice(10)));
    return true;
  }
  if ((c === 70 && t.startsWith('FAILED ')) || (c === 69 && t.startsWith('ERROR '))) {
    const body = t.slice(t.indexOf(' ') + 1);
    const id = firstToken(body);
    if (id.indexOf('::') > 0 || (id.indexOf('/') >= 0 && id.indexOf('.') > 0)) {
      addTest(sink, id);
      const dash = body.indexOf(' - ');
      if (dash > 0) addError(sink, body.slice(dash + 3), 2, -1);
      return true;
    }
  }
  if (c === 95 && t.startsWith('___') && t.endsWith('___')) {
    let name = trimUnderscores(t);
    if (name.startsWith('ERROR at setup of ')) name = name.slice(18);
    else if (name.startsWith('ERROR at teardown of ')) name = name.slice(21);
    else if (name.startsWith('[doctest] ')) name = name.slice(10);
    else if (name.startsWith('ERROR collecting ')) return true;
    if (name && name.length < 160 && name.split(' ').length <= 4) addTest(sink, name);
    return true;
  }
  if (t.startsWith('FAIL: ') || t.startsWith('ERROR: ')) {
    const body = t.slice(t.indexOf(': ') + 2);
    const open = body.indexOf(' (');
    if (open > 0 && body.endsWith(')') && isIdentifier(body.slice(0, open)) && isDotted(body.slice(open + 2, -1))) {
      addTest(sink, body);
      return true;
    }
  }
  if (c === 0x25cf) {
    const name = t.slice(1).trim();
    if (name && !/^(?:Console|Test suite failed|Validation|Deprecation)/.test(name) && name.length < 200) addTest(sink, name);
    return true;
  }
  if (c === 0x2715 || c === 0x2717 || c === 0xd7) {
    const name = t.slice(1).replace(/\s*\(?\d+(?:\.\d+)? ?m?s\)?\s*$/, '').trim();
    if (name && name.length < 200) addTest(sink, name);
    return true;
  }
  if (c === 70 && t.startsWith('FAIL ') && t.indexOf(' > ') > 0) {
    addTest(sink, t.slice(t.indexOf(' > ') + 3));
    return true;
  }
  if (c === 84 && t.startsWith('Tests run:')) {
    const cls = t.indexOf(' - in ');
    if (cls > 0 && (t.includes('<<< FAILURE') || t.includes('<<< ERROR'))) {
      addTest(sink, t.slice(cls + 6).trim());
      return true;
    }
    return false;
  }
  const timeIdx = t.indexOf('Time elapsed:');
  if (timeIdx > 0 && (t.includes('<<< FAILURE') || t.includes('<<< ERROR'))) {
    let name = t.slice(0, timeIdx).trim();
    if (name.endsWith(' --')) name = name.slice(0, -3).trim();
    if (name && name.length < 200) addTest(sink, name);
    return true;
  }
  if (c === 116 && t.startsWith('test ') && t.endsWith(' ... FAILED')) {
    addTest(sink, t.slice(5, -11).trim());
    return true;
  }
  if (c === 45 && t.startsWith('---- ') && t.endsWith(' ----')) {
    const name = t.slice(5, -5).replace(/ stdout$| stderr$/, '').trim();
    if (name && name.indexOf(' ') < 0) addTest(sink, name);
    return true;
  }
  if (c === 114 && t.startsWith('rspec ') && t.indexOf(' # ') > 0) {
    addTest(sink, t.slice(t.indexOf(' # ') + 3));
    return true;
  }
  if (c === 84 && t.startsWith("Test Case '-[") && t.indexOf("' failed") > 0) {
    const inner = t.slice(13, t.indexOf("]'"));
    addTest(sink, inner.replace(' ', '.'));
    return true;
  }
  if (c === 110 && t.startsWith('not ok ')) {
    const dash = t.indexOf(' - ');
    if (dash > 0) addTest(sink, t.slice(dash + 3));
    return true;
  }
  if ((c === 70 && t.startsWith('Failed ')) || (c === 88 && t.startsWith('X '))) {
    const body = t.slice(t.indexOf(' ') + 1);
    const name = firstToken(body);
    const rest = body.slice(name.length);
    if (name && (rest === '' || (rest.startsWith(' [') && /\d ?m?s\]/.test(rest))) && /^[\w.<>`+-]+$/.test(name) && (rest !== '' || name.indexOf('.') > 0)) {
      addTest(sink, name);
      return true;
    }
  }
  if (c === 91 && t.startsWith('[xUnit.net') && t.endsWith(' [FAIL]')) {
    const close = t.indexOf(']');
    addTest(sink, t.slice(close + 1, -7).trim());
    return true;
  }
  if (t.endsWith(' FAILED') && t.indexOf(' > ') > 0 && t.length < 240) {
    addTest(sink, t.slice(0, -7));
    return true;
  }
  if (t.endsWith(' [FAIL]') && !t.startsWith('[')) {
    addTest(sink, t.slice(0, -7).trim());
    return true;
  }
  const sp = t.indexOf(' ');
  if (sp > 3 && t.indexOf('::') > 0 && t.indexOf('::') < sp && /^(?:FAILED|ERROR)\b/.test(t.slice(sp + 1))) {
    addTest(sink, t.slice(0, sp));
    return true;
  }
  if (c === 70 && t.startsWith('Failed tests:')) {
    const body = t.slice(13).trim();
    if (body) detectTest(body, raw, sink);
    return true;
  }
  if (c === 77 && t.startsWith('MethodSource [className = ')) {
    const cls = /className = '([^']+)'/.exec(t);
    const method = /methodName = '([^']+)'/.exec(t);
    if (cls) addTest(sink, method ? `${cls[1]}.${method[1]}` : cls[1]);
    return true;
  }
  const hash = t.indexOf('#test');
  if (hash > 0 && hash < 80 && /^[A-Z][\w:]*#test_?\w*:?(?: \[[^\]]+\]:)?$/.test(t)) {
    addTest(sink, t.replace(/ \[.*$/, '').replace(/:$/, ''));
    return true;
  }
  if (isUpper(c) || isLower(c)) {
    const junit3 = /^(\w[\w$]*)\(([\w$.]+)\)(?::| |$)/.exec(t);
    if (junit3 && /^test|^should/i.test(junit3[1])) {
      addTest(sink, `${junit3[1]}(${junit3[2]})`);
      return true;
    }
    const surefire = /^([A-Z][\w$]*(?:\.[\w$]+)*\.[A-Za-z_$][\w$]*):\d+(?:[ ,-]|$)/.exec(t);
    if (surefire && !SOURCE_EXTENSIONS.has(surefire[1].slice(surefire[1].lastIndexOf('.') + 1).toLowerCase())) {
      addTest(sink, surefire[1]);
      return true;
    }
  }
  return false;
}

const ERROR_PREFIXES: [string, number][] = [
  ['panic: ', 3], ['fatal error: ', 3], ['FATAL: ', 3], ['Fatal error: ', 3], ['PHP Fatal error: ', 3], ['PHP Parse error: ', 3],
  ['Parse error: ', 3], ['assertion `', 3], ['Failed asserting that ', 3], ['Failure/Error: ', 3], ['SUMMARY: ', 3],
  ['Exception Type: ', 3], ['Exception Value: ', 3], ['Program received signal ', 2],
  ['error: ', 2], ['error[', 2], ['error TS', 2], ['error CS', 2], ['ERROR: ', 2], ['Segmentation fault', 2], ['Bus error', 2],
  ['Illegal instruction', 2], ['Invalid read of size', 2], ['Invalid write of size', 2], ['Conditional jump or move', 2],
  ['Process terminating with default action', 2], ['expect(received)', 2], ['symbol:', 1], ['location:', 1],
];
const NOISE_ERRORS = ['error: could not compile', 'error: aborting due to', 'error: test failed', 'error: Recipe', 'error: build failed'];

function detectError(t: string, lineIndex: number, sink: Sink): boolean {
  if (t.charCodeAt(0) === 69 && t.charCodeAt(1) === 32 && t.charCodeAt(2) === 32) {
    const content = t.slice(1).trim();
    if (content && (!sink.prevWasE || exceptionHeader(content))) addError(sink, content, 3, lineIndex);
    sink.prevWasE = true;
    return true;
  }
  sink.prevWasE = false;
  const header = exceptionHeader(t);
  if (header) {
    addError(sink, header, t.indexOf('Warning') > 0 && t.indexOf('Warning') < 60 ? 1 : 3, lineIndex);
    return true;
  }
  for (const [prefix, priority] of ERROR_PREFIXES) {
    if (t.startsWith(prefix)) {
      if (priority === 2 && NOISE_ERRORS.some(noise => t.startsWith(noise))) return false;
      addError(sink, t, priority, lineIndex);
      return true;
    }
  }
  const assertion = t.indexOf(' Assertion `');
  if (assertion > 0 && t.endsWith(' failed.')) {
    addError(sink, t.slice(assertion + 1), 3, lineIndex);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Line-by-line analysis

const K_PROSE = 0;
const K_FRAME = 1;
const K_CONSUMED = 2;
const K_FENCE = 3;
const K_ERROR = 4;
const K_TEST = 5;
const K_BLANK = 6;

interface FrameMeta { order: Order; lineIndex: number }

interface Analysis {
  lines: string[];
  /** 1 for windows that continue an over-long source line. */
  continued: Uint8Array;
  kinds: Uint8Array;
  fenced: Uint8Array;
  frames: StackFrame[];
  meta: FrameMeta[];
  sink: Sink;
  innermostFirst: boolean;
}

function isRule(t: string): boolean {
  if (t.length < 5) return false;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (!(c === 61 || c === 95 || c === 45 || c === 42 || c === 126 || c === 35 || c === 43 || c === 32 || c === 9 || c === 124 || c === 46)) return false;
  }
  return true;
}

/** 1: starts a new trace segment, 2: carries no information. Both are dropped from condensed text. */
function structuralKind(t: string): number {
  const c = t.charCodeAt(0);
  if (c === 84 && (t.startsWith('Traceback (most recent call last)') || t.startsWith('The above exception was the direct cause'))) return 1;
  if (c === 68 && t.startsWith('During handling of the above exception')) return 1;
  if (c === 103 && t.startsWith('goroutine ') && t.endsWith(':')) return 1;
  if ((c === 115 || c === 83) && (t.startsWith('stack backtrace:') || t.startsWith('Stack backtrace:') || t.startsWith('Stack trace:') || t.startsWith('Stack Trace:') || t.startsWith('Stacktrace:'))) return 1;
  if (c === 45 && t.startsWith('--- End of ')) return 1;
  if (c === 43 && t.startsWith('+ Exception Group Traceback')) return 1;
  if (c === 46 && /^\.\.\. \d+ (?:more|common frames omitted)/.test(t)) return 2;
  if (c === 91 && t.startsWith('[Previous line repeated')) return 2;
  return 0;
}

function parseRustNumbered(t: string): string | undefined {
  let i = 0;
  while (i < t.length && i < 6 && isDigit(t.charCodeAt(i))) i++;
  if (i === 0 || t.charCodeAt(i) !== 58 || !isSpace(t.charCodeAt(i + 1))) return undefined;
  let name = t.slice(i + 1).trim();
  const dash = name.indexOf(' - ');
  if (name.startsWith('0x') && dash > 0 && dash < 24) name = name.slice(dash + 3);
  if (!name || name.length > 300 || (name.indexOf('::') < 0 && !isIdentifier(name))) return undefined;
  return name.replace(/::h[0-9a-f]{16}$/, '');
}

function finishNumbered(sink: Sink): void {
  const pending = sink.pendingNumbered;
  if (!pending) return;
  sink.pendingNumbered = undefined;
  let title = squash(pending.title);
  if (title.startsWith('Failed : ')) title = title.slice(9);
  if (title.length < 3 || title.length > 160 || /^(?:Failure|Error|Failed)\b:?$/.test(title)) return;
  sink.numbered.push(title);
}

function trackNumbered(t: string, raw: string, sink: Sink): void {
  let i = 0;
  while (i < t.length && i < 4 && isDigit(t.charCodeAt(i))) i++;
  const isStart = i > 0 && t.charCodeAt(i) === 41 && t.charCodeAt(i + 1) === 32 && t.length > i + 2;
  const pending = sink.pendingNumbered;
  if (isStart) {
    finishNumbered(sink);
    sink.pendingNumbered = { title: t.slice(i + 2), lines: 0 };
    return;
  }
  if (!pending) return;
  if (!isSpace(raw.charCodeAt(0)) || pending.lines >= 5 || t.startsWith('Failure') || exceptionHeader(t) || pending.title.length > 140) {
    finishNumbered(sink);
    return;
  }
  if (t.endsWith(':')) {
    pending.title += ` ${t.slice(0, -1)}`;
    finishNumbered(sink);
  } else {
    pending.title += ` ${t}`;
    pending.lines++;
  }
}

function sameFrame(a: StackFrame, b: StackFrame): boolean {
  return a.path === b.path && a.line === b.line && a.column === b.column && a.func === b.func;
}

/** `ObjectDoesNotExist: message`, `KeyboardInterrupt`: the unindented line that ends a Python traceback. */
function isPythonExceptionLine(t: string): boolean {
  let j = 0;
  while (j < t.length && j < 160 && (isIdentChar(t.charCodeAt(j)) || t.charCodeAt(j) === 46)) j++;
  if (j < 2 || !isIdentStart(t.charCodeAt(0))) return false;
  return j === t.length || (t.charCodeAt(j) === 58 && (j + 1 === t.length || isSpace(t.charCodeAt(j + 1))));
}

function analyze(text: string): Analysis {
  const { lines, continued } = prepareText(text);
  const kinds = new Uint8Array(lines.length);
  const fenced = new Uint8Array(lines.length);
  const sink: Sink = { errors: [], errorSet: new Set(), tests: [], testSet: new Set(), numbered: [], failMarker: false, traceback: false,
    panicEntry: -1, cargoList: false, prevWasE: false };
  const st: ParseState = { prevRaw: '' };
  const frames: StackFrame[] = [];
  const meta: FrameMeta[] = [];
  let segment = 0;
  let segmentFrames = 0;
  let inFence = false;
  let awaiting: StackFrame | undefined;
  let awaitingFor = 0;
  let pyIndent = -1;
  const bump = (): void => {
    if (segmentFrames > 0) { segment++; segmentFrames = 0; }
  };

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const trimmed = raw.trim();
    if (!trimmed) {
      kinds[li] = K_BLANK;
      sink.prevWasE = false;
      sink.cargoList = false;
      st.eslintPath = undefined;
      st.pendingRust = undefined;
      finishNumbered(sink);
      continue;
    }
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      kinds[li] = K_FENCE;
      continue;
    }
    fenced[li] = inFence ? 1 : 0;
    if (trimmed.length < 3) { st.prevRaw = raw; continue; }
    const t = stripLinePrefix(trimmed);
    if (!t) continue;
    const indent = raw.length - raw.trimStart().length + (trimmed.length - t.length);
    const isPyFile = t.charCodeAt(0) === 70 && t.startsWith('File ');
    if (pyIndent >= 0 && !isPyFile && indent < pyIndent) {
      pyIndent = -1;
      if (isPythonExceptionLine(t)) {
        addError(sink, t, 3, li);
        kinds[li] = K_ERROR;
        bump();
        st.prevRaw = raw;
        continue;
      }
    }

    if (sink.panicEntry >= 0) {
      const entry = sink.errors[sink.panicEntry];
      sink.panicEntry = -1;
      if (entry && !t.startsWith('note:') && !t.startsWith('stack backtrace')) {
        sink.errorSet.delete(entry.text);
        entry.text = squash(`${entry.text}: ${t}`).slice(0, RAW_CHARS);
        sink.errorSet.add(entry.text);
        kinds[li] = K_ERROR;
        st.prevRaw = raw;
        continue;
      }
    }

    if (awaiting) {
      const django = /^(\d{1,7})\.\s/.exec(t);
      const ipython = /^-{2,}> ?(\d{1,7})\b/.exec(t);
      const found = django ?? ipython;
      if (found) { awaiting.line = parseInt(found[1], 10); awaiting = undefined; } else if (++awaitingFor > 3) awaiting = undefined;
    }

    const structure = structuralKind(t);
    if (structure) {
      if (structure === 1) bump();
      if (t.startsWith('Traceback')) sink.traceback = true;
      kinds[li] = K_CONSUMED;
      st.prevRaw = raw;
      continue;
    }
    if (t.charCodeAt(0) === 61 && t.endsWith('==') && t.startsWith('===')) {
      if (/FAILURES|ERRORS|failed|error/.test(t)) sink.failMarker = true;
      kinds[li] = K_CONSUMED;
      continue;
    }
    if (isRule(t)) {
      kinds[li] = K_CONSUMED;
      continue;
    }
    if (isFailMarker(t)) sink.failMarker = true;
    if (t === 'failures:') sink.cargoList = true;
    else if (sink.cargoList && /^\s{4}[\w:]+$/.test(raw)) {
      addTest(sink, t);
      kinds[li] = K_TEST;
      continue;
    }
    trackNumbered(t, raw, sink);

    const match = t.startsWith('rspec ') ? undefined : matchFrame(t, raw, st);
    if (isPyFile) pyIndent = indent;
    if (match !== undefined) sink.prevWasE = false;
    if (match) {
      const frame: StackFrame = { path: match.path, language: match.language, raw: trimmed.slice(0, RAW_CHARS), index: 0 };
      if (match.line !== undefined) frame.line = match.line;
      if (match.column !== undefined) frame.column = match.column;
      if (match.func) frame.func = match.func;
      if (match.qualifier) frame.qualifier = match.qualifier;
      frame.segment = segment;
      kinds[li] = K_FRAME;
      const previous = frames[frames.length - 1];
      if (!previous || !sameFrame(previous, frame)) {
        if (frames.length >= MAX_FRAMES_HEAD + MAX_FRAMES_TAIL) {
          frames.splice(MAX_FRAMES_HEAD, 1);
          meta.splice(MAX_FRAMES_HEAD, 1);
        }
        frames.push(frame);
        meta.push({ order: match.order, lineIndex: li });
        segmentFrames++;
      }
      if (match.awaitsLine) { awaiting = frame; awaitingFor = 0; }
      if (match.consumedPrev && li > 0 && kinds[li - 1] === K_PROSE) kinds[li - 1] = K_CONSUMED;
      if (match.error) {
        const entry = addError(sink, match.error, match.error.indexOf(' panicked at ') > 0 ? 3 : 2, li);
        if (entry >= 0 && match.error.indexOf(' panicked at ') > 0 && /panicked at [^:]+:\d+:\d+$/.test(match.error)) sink.panicEntry = entry;
        if (match.error.indexOf(' panicked at ') > 0) sink.failMarker = true;
      }
    } else if (match === null) {
      kinds[li] = K_CONSUMED;
    } else if (detectTest(t, raw, sink)) {
      kinds[li] = K_TEST;
      sink.failMarker = true;
      sink.prevWasE = false;
      bump();
    } else if (detectError(t, li, sink)) {
      kinds[li] = K_ERROR;
      if (!sink.prevWasE) bump();
    } else {
      sink.prevWasE = false;
      if (t.length < 400 && !t.includes(' ') && t.indexOf('/') >= 0) {
        const bare = normalizeFramePath(t.replace(/[:,;]$/, ''));
        st.eslintPath = isPlausiblePath(bare) ? bare : undefined;
      } else if (!/^\d+:\d+ /.test(t)) st.eslintPath = undefined;
    }
    st.pendingRust = parseRustNumbered(t);
    st.prevRaw = raw;
  }
  finishNumbered(sink);
  if (sink.failMarker) for (const title of sink.numbered) addTest(sink, title);
  for (let i = 0; i < frames.length; i++) frames[i].index = i;
  let first = 0;
  let last = 0;
  for (const m of meta) { if (m.order === 'first') first++; else last++; }
  return { lines, continued, kinds, fenced, frames, meta, sink, innermostFirst: first >= last };
}

// ---------------------------------------------------------------------------------------------------------------
// Frame classification

const RUNTIME_FUNC_PREFIXES = ['java.', 'javax.', 'jdk.', 'sun.', 'com.sun.', 'org.junit.', 'junit.', 'org.apache.maven.surefire.', 'org.gradle.',
  'worker.org.gradle.', 'org.testng.', 'kotlin.', 'kotlinx.coroutines.', 'scala.', 'System.', 'Microsoft.', 'Xunit.', 'NUnit.', 'runtime.', 'testing.', 'reflect.'];

/** `runtime` frames belong to the language runtime or test harness, `dependency` frames to installed packages. */
export function frameKind(frame: StackFrame): FrameKind {
  const path = frame.path;
  const func = frame.func ?? '';
  if (path.startsWith('node:') || path.startsWith('internal/') || path.startsWith('webpack/') || func === '__webpack_require__') return 'runtime';
  if (/\/lib\/python\d/.test(path) && path.indexOf('-packages') < 0) return 'runtime';
  if (/(?:^|\/)Lib\/(?!site-packages)/.test(path) && /python/i.test(path)) return 'runtime';
  if (path.startsWith('/rustc/') || /\/library\/(?:core|std|alloc)\//.test(path) || path.indexOf('/.rustup/') >= 0) return 'runtime';
  if (path.startsWith('/usr/local/go/') || path.indexOf('/go/src/runtime/') >= 0 || path.indexOf('/golang/') >= 0 && frame.language === 'go') return 'runtime';
  if (/\/lib\/ruby\/\d/.test(path) && path.indexOf('/gems/') < 0) return 'runtime';
  if (path.startsWith('/usr/include/') || path.startsWith('/usr/lib/') || path.indexOf('/sysdeps/') >= 0 || path.indexOf('/lib/x86_64-linux-gnu/') >= 0) return 'runtime';
  if ((frame.language === 'java' || frame.language === 'kotlin' || frame.language === 'csharp' || frame.language === 'go')
    && RUNTIME_FUNC_PREFIXES.some(prefix => func.startsWith(prefix))) return 'runtime';
  if (/\/(?:site|dist)-packages\//.test(path) || path.indexOf('node_modules/') >= 0 || path.indexOf('/vendor/') >= 0 || path.indexOf('/gems/') >= 0
    || path.indexOf('/.cargo/registry/') >= 0 || path.indexOf('/go/pkg/mod/') >= 0 || path.indexOf('/.m2/') >= 0 || path.indexOf('/bower_components/') >= 0) return 'dependency';
  return 'app';
}

// ---------------------------------------------------------------------------------------------------------------
// Symbols, quoted strings and paths

const WORDS = (list: string): Set<string> => new Set(list.split(/\s+/).filter(Boolean));

const STOP_WORDS = WORDS(`the and for are but not you all any can had her was one our out day get has him his how its may new now old see two way who boy did
  let put say she too use able about above after again against also always among another because been before being below between both
  cannot could does doing done down during each either else even ever every first from further have having here hence however into just
  last like many maybe more most much must never next only onto other others over perhaps please quite really same should since some
  still such than that their them then there these they this those though through thus under until upon very want were what when where
  which while whom whose will with within without would your yours actual expected result results behavior behaviour output input
  issue bug error errors problem problems steps reproduce reproduction example examples following version versions system please thanks
  thank hello code works work working worked seems seem appears appear look looks need needs try tried trying call calls called calling
  return returns returned returning give gives given take takes taken make makes made show shows shown think thought know known says said
  using used uses instead already currently previously recently actually basically simply probably sometimes often usually certain
  different similar possible possibly simple should shouldn would wouldn couldn doesn didn isn aren wasn weren hasn haven hadn won
  def class import from return const let var function public private protected static final void int long float double bool boolean string char
  true false null none nil self this super async await yield lambda try except catch finally raise throw throws new delete typeof
  instanceof extends implements interface enum struct impl trait type func package module export default switch case break continue
  pass assert print println printf echo foreach elif elsif unless begin end loop global nonlocal elseif where select table value values
  name names data list dict file files line lines text test tests case cases item items key keys index object objects type types
  user users info debug warn warning true false the in is it of to on at by as an or if be do no so up we us me my`);

const CAPS_STOP = WORDS(`TRUE FALSE NULL NONE TODO FIXME NOTE WARNING ERROR FAIL PASS FAILED PASSED INFO DEBUG HTTP HTTPS JSON HTML XML YAML
  GET POST PUT DELETE PATCH HEAD OPTIONS NOTE IMPORTANT EDIT UPDATE CONSOLE`);

const COMMON_DUNDERS = WORDS('__init__ __main__ __name__ __file__ __all__ __doc__ __class__ __dict__ __module__ __version__ __repr__ __str__');

const BUILTIN_TYPES = WORDS('Object Array String Number Boolean Promise Map Set Date Math JSON Symbol Function RegExp Buffer WeakMap WeakSet BigInt Int8Array Uint8Array');

const FRAME_RECEIVERS = WORDS('Object Module Function Array Promise Context Generator Reflect Proxy Map Set Router Layer Immediate Timeout Process');

const BUILTIN_ERRORS = WORDS(`Error Exception BaseException TypeError ValueError KeyError IndexError AttributeError NameError ImportError ModuleNotFoundError
  RuntimeError AssertionError NotImplementedError StopIteration OSError IOError EOFError FileNotFoundError PermissionError ZeroDivisionError
  OverflowError UnicodeDecodeError UnicodeEncodeError SyntaxError IndentationError RecursionError KeyboardInterrupt SystemExit LookupError
  ReferenceError RangeError URIError EvalError NullPointerException IllegalArgumentException IllegalStateException RuntimeException
  ArrayIndexOutOfBoundsException IndexOutOfBoundsException ClassCastException NumberFormatException UnsupportedOperationException
  ConcurrentModificationException IOException FileNotFoundException OutOfMemoryError StackOverflowError AssertionFailedError
  NullReferenceException InvalidOperationException ArgumentException ArgumentNullException NoMethodError ArgumentError StandardError
  FrozenError NoMatchingPatternError ArithmeticException InterruptedException TimeoutException SQLException UnsupportedEncodingException`);

const isCamel = (part: string): boolean => /[a-z0-9][A-Z]/.test(part);
const isPascal = (part: string): boolean => /^[A-Z]+[a-z][A-Za-z0-9]*[A-Z]/.test(part) || /^[A-Z][a-z0-9]+[A-Z]/.test(part);
const isSnake = (part: string): boolean => /[A-Za-z0-9]_[A-Za-z0-9]/.test(part);
const isConstant = (part: string): boolean => /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(part);
const isCodeLike = (part: string): boolean => isCamel(part) || isPascal(part) || isSnake(part) || isConstant(part);

type Mode = 'prose' | 'code' | 'error' | 'backtick';

interface SymbolEntry { score: number; count: number; first: number; parts: number }

class SymbolBag {
  readonly entries = new Map<string, SymbolEntry>();
  private order = 0;

  add(token: string, score: number): void {
    if (score <= 0 || token.length < 3 || token.length > 120) return;
    const entry = this.entries.get(token);
    if (entry) {
      entry.count++;
      if (score > entry.score) entry.score = score;
      return;
    }
    if (this.entries.size >= 30000) return;
    this.entries.set(token, { score, count: 1, first: this.order++, parts: token.split(/::|->|[.#]/).length });
  }

  ranked(limit: number): { token: string; score: number; base: number }[] {
    return [...this.entries]
      .map(([token, e]) => ({ token, e, score: e.score + Math.min(2, 0.5 * (e.count - 1)) }))
      .sort((a, b) => b.score - a.score || b.e.parts - a.e.parts || a.e.first - b.e.first)
      .slice(0, limit)
      .map(({ token, e, score }) => ({ token, score, base: e.score }));
  }
}

const LITERALS = WORDS('true false none null nil self this undefined void');

function tokenScore(token: string, call: boolean, mode: Mode): number {
  const parts = token.split(/::|->|[.#]/);
  const boost = mode === 'backtick' ? 2 : mode === 'error' ? 1.5 : 0;
  if (/^[A-Z]{1,4}\d{2,5}$/.test(token) || BUILTIN_ERRORS.has(parts[parts.length - 1]) || (parts.length === 1 && BUILTIN_TYPES.has(token))) return 0;
  if (parts.length > 1) {
    // `engine.rb#L12`, `foo.py`: a file reference, not a symbol.
    if (parts.some(p => p.length < 2) || STOP_WORDS.has(token.toLowerCase()) || parts.slice(1).some(p => SOURCE_EXTENSIONS.has(p.toLowerCase()))) return 0;
    const codeLike = parts.some(isCodeLike) || parts.some(p => /^[A-Z][a-z]{2,}/.test(p) && p.length > 4);
    if (!codeLike && parts.length < 3 && !call && mode === 'prose') return 0;
    return 5 + 0.4 * Math.min(parts.length - 2, 3) + boost;
  }
  if (/^__\w+__$/.test(token)) return COMMON_DUNDERS.has(token) ? 0 : 4 + boost;
  if (isSnake(token) || isCamel(token) || isPascal(token)) return 4.5 + boost;
  if (isConstant(token)) return 4 + boost;
  if (/^[A-Z][A-Z0-9]{3,}$/.test(token)) return CAPS_STOP.has(token) ? 0 : 2 + boost;
  const lower = token.toLowerCase();
  if (STOP_WORDS.has(lower) && !(call && mode !== 'prose' && token.length > 4)) return mode === 'backtick' && token.length > 3 && !LITERALS.has(lower) ? 2 : 0;
  if (mode === 'error') return call ? 3 + boost : 0;
  if (call) return 3 + boost;
  if (/^[A-Z][a-z0-9]+$/.test(token)) return (mode === 'code' || mode === 'backtick') && token.length >= 4 ? 1.5 + boost : 0;
  return mode === 'backtick' ? 2.5 + boost : 0;
}

const IDENT = /[A-Za-z_$][\w$]*(?:(?:\.|::|#|->)[A-Za-z_$][\w$]*)*/g;
const DEFINITION = /\b(?:def|class|function|fn|func|struct|interface|trait|enum|impl|type|module|namespace|object|sub|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const SELF_PREFIX = /^(?:self|this|cls|super)(?:\.|->)/;

function scanTokens(line: string, mode: Mode, bag: SymbolBag, extra = 0): void {
  IDENT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IDENT.exec(line))) {
    let token = m[0];
    if (token.charCodeAt(0) === 36 && token.length > 1) token = token.slice(1);
    while (SELF_PREFIX.test(token)) token = token.replace(SELF_PREFIX, '');
    if (token.length < 3) continue;
    const call = line.charCodeAt(m.index + m[0].length) === 40;
    const score = tokenScore(token, call, mode);
    if (score <= 0) continue;
    bag.add(token, score + extra);
    const parts = token.split(/::|->|[.#]/);
    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      if (last.length >= 3 && (isCodeLike(last) || call || mode === 'backtick' || mode === 'code')) bag.add(last, score - 0.8 + extra);
      const head = parts[0];
      if ((isCodeLike(head) || /^[A-Z][a-z]{2,}/.test(head)) && !BUILTIN_TYPES.has(head)) bag.add(head, score - 1.2 + extra);
    }
  }
  if (mode === 'code' || mode === 'prose') {
    DEFINITION.lastIndex = 0;
    while ((m = DEFINITION.exec(line))) bag.add(m[1], 6 + extra);
  }
}

/** Method names and classes that deserve an exact match, derived from a printed frame function. */
function frameSymbols(frame: StackFrame): string[] {
  let func = frame.func;
  if (!func) return [];
  func = func.replace(/ \[as ([^\]]+)\]/, ' $1').replace(/^(?:async |new )+/, '').replace(/\.?<(?:anonymous|computed)>/g, '')
    .replace(/\{\{closure\}\}/g, '').replace(/\.func\d+(?:\.\d+)*$/, '').replace(/\$\$Lambda\S*/, '');
  func = func.replace(/lambda\$([\w$]+?)\$\d+/, '$1').replace(/\.<(?:init|clinit)>$/, '');
  if (!func || /^<.*>$/.test(func) || func === 'anonymous') return [];
  const sep = func.indexOf('::') >= 0 ? '::' : func.indexOf('->') >= 0 ? '->' : func.indexOf('#') >= 0 ? '#' : '.';
  const parts = func.split(/::|->|[.#/]/).filter(part => part && !FRAME_RECEIVERS.has(part) && !/^<.*>$/.test(part));
  const out: string[] = [];
  if (parts.length > 1) out.push(func);
  const method = parts[parts.length - 1];
  if (method && (parts.length === 1 || !STOP_WORDS.has(method.toLowerCase()))) out.push(method);
  if (parts.length > 1) {
    const cls = parts[parts.length - 2];
    if (cls.length >= 3 && !STOP_WORDS.has(cls.toLowerCase())) out.push(`${cls}${sep}${method}`, cls.split('$')[0]);
  }
  return out;
}

/** Class and function names of a failing test id; the file part of a pytest node id is a path, not a symbol. */
function testSymbols(name: string): string[] {
  if (name.indexOf('::') > 0 && /[./]/.test(name.slice(0, name.indexOf('::')))) {
    const parts = name.split('::').slice(1).map(part => part.replace(/\[.*$/, '')).filter(Boolean);
    const out = parts.length > 1 ? [`${parts[parts.length - 2]}.${parts[parts.length - 1]}`] : [];
    return [...out, ...parts];
  }
  const generic = name.replace(/\[.*$/, '');
  return isIdentifier(generic.replace(/[.:#/]/g, '_')) ? [generic, ...generic.split(/[.:#/]/)] : [];
}

const QUOTED = /"([^"\n]{8,200})"|(?<![\w'])'([^'\n]{8,200})'(?![\w'])|\u201c([^\u201d\n]{8,200})\u201d|`([^`\n]{8,200})`/g;
const BACKTICK = /`([^`\n]{1,120})`/g;
const QUOTED_IDENTIFIER = /(['"])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\1|`([A-Za-z_$][\w$]*[?!]?)'/g;

function isLiteralCandidate(text: string, backtick: boolean): boolean {
  if (text.length < 8 || text.indexOf('://') >= 0) return false;
  let letters = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isAlpha(c) || c > 127) letters++;
  }
  if (letters < text.length * 0.4) return false;
  if (backtick && (text.indexOf(' ') < 0 || /[(){};=]|->/.test(text))) return false;
  return !isPlausiblePath(normalizeFramePath(text)) || text.indexOf(' ') > 0;
}

/** Static fragments of an error message: runtime values (quoted, numeric, bracketed) are cut out. */
function messageFragments(line: string): string[] {
  let body = line;
  for (const prefix of HEADER_PREFIXES) {
    if (body.startsWith(prefix)) { body = body.slice(prefix.length); break; }
  }
  const colon = body.indexOf(': ');
  const message = colon > 0 && colon < 120 ? body.slice(colon + 2) : body;
  const cleaned = message.replace(/(['"`])(?:(?!\1).){0,80}\1|\b0x[0-9a-fA-F]+\b|\b\d[\d.:,-]*\b|<[^<>]{0,80}>|\([^()]{0,80}\)|\[[^[\]]{0,80}\]|\{[^{}]{0,80}\}/g, '\u0000');
  const out: string[] = [];
  for (const piece of cleaned.split('\u0000')) {
    const fragment = piece.replace(/^[\s:;,.\-]+|[\s:;,.\-]+$/g, '');
    if (fragment.length >= 8 && fragment.indexOf(' ') > 0) out.push(fragment);
  }
  return out;
}

const PATH_BOUNDARY = (() => {
  const table = new Uint8Array(128);
  for (const ch of ' \t\r\n"\'`<>(){}|,;=*') table[ch.charCodeAt(0)] = 1;
  return table;
})();

function isPathBoundary(c: number): boolean {
  if (c < 128) return PATH_BOUNDARY[c] === 1;
  return c === 0xa0 || c === 0x3000 || (c >= 0x2000 && c <= 0x206f) || c === 0xab || c === 0xbb;
}

const BLOB_URL = /github\.com\/[^/]+\/[^/]+\/(?:blob|tree|blame)\/[^/]+\/(.+)$/;

function candidatePath(input: string): string | undefined {
  let token = input;
  while (token.length > 0 && (token.charCodeAt(0) === 91 || token.charCodeAt(0) === 45 || token.charCodeAt(0) === 43)) token = token.slice(1);
  while (token.length > 0 && /[.,;:!?\]]/.test(token.charAt(token.length - 1))) token = token.slice(0, -1);
  if (token.length < 3) return undefined;
  if (token.indexOf('://') > 0) {
    const blob = BLOB_URL.exec(token);
    if (!blob) return undefined;
    token = blob[1];
  }
  let cut = token.indexOf(':');
  if (cut === 1 && isAlpha(token.charCodeAt(0)) && (token.charCodeAt(2) === 92 || token.charCodeAt(2) === 47)) cut = token.indexOf(':', 2);
  if (cut > 0) token = token.slice(0, cut);
  const hash = token.indexOf('#');
  if (hash > 0) token = token.slice(0, hash);
  let path = normalizeFramePath(token);
  while (path.startsWith('./')) path = path.slice(2);
  if (path.startsWith('node:') || !isPlausiblePath(path)) return undefined;
  return path;
}

function collectPaths(line: string, out: string[], seen: Set<string>): void {
  let i = 0;
  while (i < line.length && out.length < MAX_PATHS) {
    while (i < line.length && isPathBoundary(line.charCodeAt(i))) i++;
    let j = i;
    while (j < line.length && !isPathBoundary(line.charCodeAt(j))) j++;
    if (j - i >= 3 && j - i <= 400) {
      const path = candidatePath(line.slice(i, j));
      if (path && !seen.has(path)) {
        seen.add(path);
        out.push(path);
      }
    }
    i = j;
  }
}

interface Extracted {
  symbols: { token: string; score: number; base: number }[];
  quoted: string[];
  paths: string[];
}

function extract(a: Analysis, symbolLimit: number, texts?: Map<number, string>): Extracted {
  const bag = new SymbolBag();
  const quoted: string[] = [];
  const quotedSeen = new Set<string>();
  const paths: string[] = [];
  const pathSeen = new Set<string>();
  const addQuoted = (text: string, backtick = false): void => {
    const clean = squash(text).slice(0, 200);
    if (quoted.length < MAX_QUOTED && !quotedSeen.has(clean) && isLiteralCandidate(clean, backtick)) {
      quotedSeen.add(clean);
      quoted.push(clean);
    }
  };
  const frameAt = new Map<number, number>();
  a.meta.forEach((m, i) => frameAt.set(m.lineIndex, i));
  const depths = frameDepths(a);
  for (let i = 0; i < a.frames.length; i++) {
    const frame = a.frames[i];
    const kind = frameKind(frame);
    if (kind === 'runtime') continue;
    const base = (kind === 'app' ? 10 : 5.5) - Math.min(depths[i], 6) * 0.35;
    frameSymbols(frame).forEach((symbol, k) => bag.add(symbol, base - (k === 0 ? 0 : k === 1 ? 0.5 : 1.5)));
  }
  for (const test of a.sink.tests) {
    bag.add(test, 8.5);
    testSymbols(test).forEach(symbol => bag.add(symbol, 8));
    if (!/^[\w.:/#[\]-]+$/.test(test)) scanTokens(test.replace(/[[\]()]/g, ' '), 'error', bag, 3);
  }
  for (const error of a.sink.errors) {
    scanTokens(error.text, 'error', bag, 1.5);
    QUOTED_IDENTIFIER.lastIndex = 0;
    let q: RegExpExecArray | null;
    while ((q = QUOTED_IDENTIFIER.exec(error.text))) bag.add(q[2] ?? q[3], 7);
    for (const fragment of messageFragments(error.text)) addQuoted(fragment);
  }
  for (let li = 0; li < a.lines.length; li++) {
    const kind = a.kinds[li];
    if (kind === K_BLANK || kind === K_FENCE || kind === K_CONSUMED) continue;
    const line = texts ? texts.get(li) : a.lines[li];
    if (line === undefined || line.length < 3) continue;
    const frameIndex = frameAt.get(li);
    if (frameIndex !== undefined) {
      const p = candidatePath(a.frames[frameIndex].path);
      if (p && !pathSeen.has(p)) { pathSeen.add(p); paths.push(p); }
    }
    if (paths.length < MAX_PATHS) collectPaths(line, paths, pathSeen);
    if (kind === K_FRAME || kind === K_ERROR || kind === K_TEST) continue;
    const mode: Mode = a.fenced[li] ? 'code' : 'prose';
    const scan = line.indexOf('://') >= 0 ? line.replace(URL_TOKEN, ' ') : line;
    BACKTICK.lastIndex = 0;
    let b: RegExpExecArray | null;
    while ((b = BACKTICK.exec(scan))) scanTokens(b[1], 'backtick', bag);
    QUOTED_IDENTIFIER.lastIndex = 0;
    let q: RegExpExecArray | null;
    while ((q = QUOTED_IDENTIFIER.exec(scan))) {
      const name = q[2] ?? q[3];
      if (name.length >= 4) bag.add(name, isCodeLike(name) || name.indexOf('.') > 0 ? 5.5 : 3);
    }
    scanTokens(scan, mode, bag);
    QUOTED.lastIndex = 0;
    let lit: RegExpExecArray | null;
    while ((lit = QUOTED.exec(scan))) addQuoted(lit[1] ?? lit[2] ?? lit[3] ?? lit[4], lit[4] !== undefined);
  }
  return { symbols: bag.ranked(symbolLimit), quoted, paths };
}

/** Distance from the innermost call, per frame, within its trace segment. */
function frameDepths(a: Analysis): number[] {
  const depths = new Array<number>(a.frames.length).fill(0);
  let start = 0;
  while (start < a.frames.length) {
    let end = start;
    while (end + 1 < a.frames.length && a.frames[end + 1].segment === a.frames[start].segment) end++;
    for (let i = start; i <= end; i++) depths[i] = a.meta[i].order === 'first' ? i - start : end - i;
    start = end + 1;
  }
  return depths;
}

// ---------------------------------------------------------------------------------------------------------------
// parseQuery

function selectErrors(entries: ErrorEntry[]): string[] {
  if (entries.length <= MAX_ERROR_LINES) return entries.map(e => e.text);
  const keep = entries.map((entry, order) => ({ entry, order })).sort((x, y) => y.entry.priority - x.entry.priority || x.order - y.order)
    .slice(0, MAX_ERROR_LINES).sort((x, y) => x.order - y.order);
  return keep.map(k => k.entry.text);
}

function buildParsed(a: Analysis): ParsedQuery {
  const { symbols, quoted, paths } = extract(a, MAX_SYMBOLS);
  const errorLines = selectErrors(a.sink.errors);
  const testNames = a.sink.tests.slice(0, MAX_TEST_NAMES);
  const isTrace = a.frames.length > 0 || (errorLines.length > 0 && (testNames.length > 0 || a.sink.failMarker || a.sink.traceback));
  return { frames: a.frames, innermostFirst: a.innermostFirst, errorLines, testNames, symbols: symbols.map(s => s.token), quoted, paths, isTrace };
}

function emptyParsed(): ParsedQuery {
  return { frames: [], innermostFirst: true, errorLines: [], testNames: [], symbols: [], quoted: [], paths: [], isTrace: false };
}

/** Understands failure traces, test output, compiler errors and issue prose. Never throws. */
export function parseQuery(text: string): ParsedQuery {
  if (typeof text !== 'string' || text.length === 0) return emptyParsed();
  try {
    return buildParsed(analyze(text));
  } catch {
    return emptyParsed();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// resolveFrame

const MAX_RESOLVED = 8;
const ALIAS_GROUPS: string[][] = [['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'], ['py', 'pyc', 'pyi'], ['c', 'h'], ['cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'h']];

function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function extensionsCompatible(a: string, b: string): number {
  if (a === b) return 0;
  return ALIAS_GROUPS.some(group => group.includes(a) && group.includes(b)) ? 0.5 : -1;
}

/** Class path components for JVM frames: `a.b.C.m` printed with `C.java` maps to `a/b/C.java`. */
function jvmComponents(frame: StackFrame): string[] | undefined {
  if (frame.language !== 'java' && frame.language !== 'kotlin') return undefined;
  const file = baseName(frame.path);
  const stem = stemOf(file);
  const parts = (frame.func ?? '').split('.');
  for (let i = parts.length - 2; i >= 0; i--) {
    const cls = parts[i].split('$')[0];
    if (cls === stem || cls === `${stem}Kt`) return [...parts.slice(0, i), file];
  }
  return frame.qualifier ? [...frame.qualifier.split('.'), file] : undefined;
}

function printedComponents(frame: StackFrame): string[] {
  const jvm = jvmComponents(frame);
  if (jvm) return jvm;
  const comps = normalizeFramePath(frame.path).split('/').filter(part => part && part !== '.' && part !== '..');
  if (comps.length > 1 && /^[A-Za-z]:$/.test(comps[0])) comps.shift();
  const last = comps.length - 1;
  // Versioned directories (`pkg@1.2.3`, `gem-6.1.4`) rarely exist in the repository.
  return comps.map((part, i) => (i === last ? part : part.replace(/^(.+?)[-@]v?\d+(?:\.\d+)+[\w.+-]*$/, '$1')));
}

function scoreCandidates(frame: StackFrame, comps: string[], candidates: Iterable<string>): string[] {
  const target = comps[comps.length - 1];
  const targetExt = extensionOf(target);
  const targetStem = stemOf(target);
  const minimum = frameKind(frame) === 'runtime' && comps.length >= 3 ? 2 : 1;
  const scored: { path: string; score: number; full: boolean; extra: number }[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const repo = candidate.indexOf('\\') >= 0 ? candidate.replace(/\\/g, '/') : candidate;
    const parts = repo.split('/').filter(part => part && part !== '.');
    if (parts.length === 0) continue;
    const name = parts[parts.length - 1];
    const compat = targetExt || extensionOf(name) ? extensionsCompatible(targetExt, extensionOf(name)) : 0;
    if (compat < 0 || stemOf(name).toLowerCase() !== targetStem.toLowerCase()) continue;
    let k = 1;
    let exact = stemOf(name) === targetStem;
    while (k < comps.length && k < parts.length) {
      const a = comps[comps.length - 1 - k];
      const b = parts[parts.length - 1 - k];
      if (a !== b) {
        if (a.toLowerCase() !== b.toLowerCase()) break;
        exact = false;
      }
      k++;
    }
    if (k < minimum) continue;
    scored.push({ path: candidate, score: k - compat - (exact ? 0 : 0.25), full: k === comps.length, extra: parts.length - k });
  }
  scored.sort((x, y) => y.score - x.score || Number(y.full) - Number(x.full) || x.extra - y.extra || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return scored.slice(0, MAX_RESOLVED).map(s => s.path);
}

/**
 * Maps a printed frame to repository paths by longest path-suffix match, best first. Absolute, Docker, site-packages,
 * Windows, Go-module and bundler paths all reduce to a repo-relative suffix. Only elements of `repoPaths` are returned.
 */
export function resolveFrame(frame: StackFrame, repoPaths: readonly string[]): string[] {
  try {
    const comps = printedComponents(frame);
    if (comps.length === 0 || isPseudoPath(frame.path) || frame.path.startsWith('node:')) return [];
    const stem = stemOf(comps[comps.length - 1]).toLowerCase();
    const matches: string[] = [];
    for (const path of repoPaths) {
      const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
      if (stemOf(path.slice(slash + 1)).toLowerCase() === stem) matches.push(path);
    }
    return scoreCandidates(frame, comps, matches);
  } catch {
    return [];
  }
}

/** Indexes `repoPaths` once for resolving many frames. Equivalent to calling `resolveFrame` per frame. */
export function createFrameResolver(repoPaths: readonly string[]): (frame: StackFrame) => string[] {
  const index = new Map<string, string[]>();
  for (const path of repoPaths) {
    const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    const key = stemOf(path.slice(slash + 1)).toLowerCase();
    const bucket = index.get(key);
    if (bucket) bucket.push(path);
    else index.set(key, [path]);
  }
  return frame => {
    try {
      const comps = printedComponents(frame);
      if (comps.length === 0 || isPseudoPath(frame.path) || frame.path.startsWith('node:')) return [];
      return scoreCandidates(frame, comps, index.get(stemOf(comps[comps.length - 1]).toLowerCase()) ?? []);
    } catch {
      return [];
    }
  };
}

/** Frames ordered innermost first. Application frames come before dependencies, runtime frames last. */
export function orderFrames(parsed: ParsedQuery): StackFrame[] {
  const rank: Record<FrameKind, number> = { app: 0, dependency: 1, runtime: 2 };
  const depth = new Map<StackFrame, number>();
  let start = 0;
  const frames = parsed.frames;
  while (start < frames.length) {
    let end = start;
    while (end + 1 < frames.length && frames[end + 1].segment === frames[start].segment) end++;
    for (let i = start; i <= end; i++) depth.set(frames[i], parsed.innermostFirst ? i - start : end - i);
    start = end + 1;
  }
  return frames.map((frame, i) => ({ frame, i, kind: rank[frameKind(frame)] }))
    .sort((a, b) => a.kind - b.kind || (depth.get(a.frame) ?? 0) - (depth.get(b.frame) ?? 0) || (a.frame.segment ?? 0) - (b.frame.segment ?? 0) || a.i - b.i)
    .map(entry => entry.frame);
}

// ---------------------------------------------------------------------------------------------------------------
// condenseQuery: cleaning

const DEFAULT_MAX_CHARS = 6000;

const TEMPLATE_HEADINGS = new Set(`describe the bug|bug description|bug report|bug|description|issue description|summary|steps to reproduce|steps to reproduce the behavior|
  to reproduce|how to reproduce|reproduction|reproduction steps|reproducer|minimal reproducible example|minimal reproduction|minimal example|minimal working example|
  minimal complete verifiable example|code to reproduce|code sample|code example|reproducing code example|expected behavior|expected behaviour|expected result|
  expected results|expected output|actual behavior|actual behaviour|actual result|actual results|actual output|what happened|what did you expect to happen|
  what you expected to happen|what actually happened|current behavior|current behaviour|desired behavior|screenshots|screenshot|additional context|
  additional information|additional info|other information|environment|your environment|system information|system info|system details|versions|version info|
  version information|desktop|smartphone|logs|log output|error log|error logs|stack trace|stacktrace|traceback|error message|error messages|output|context|
  background|is your feature request related to a problem|describe the solution you d like|describe alternatives you ve considered|feature request|proposal|
  motivation|checklist|prerequisites|before submitting|possible solution|suggest a fix|problem description|the problem|problem|issue|steps|workaround|notes|note|
  related issues|references|additional details|debug info|issue type|affected versions|installed packages|installed versions|pip list|
  pip freeze|pip list output|conda list|show versions|sys info|relevant log output|anything else|other|example|examples|usage|test case|test cases|code|
  problem statement|current situation|proposed solution|solution|alternatives|tl dr|tldr|details|extra information|comments|impact|expected|actual|what is the problem|
  what should happen|what happens|how to reproduce the issue|repro|repro steps|reproduce|reproduction code|traceback and error message|logs and tracebacks|system|python dependencies|
  built with openmp|python deps|self service|prerequisites checklist|have you read the contributing guidelines on issues|my environment|environment info|environment details|
  is your feature request related to a problem please describe|expected behaviour and actual behaviour|description of the problem|what version are you using|version of the library`.split('|').map(s => s.replace(/\s+/g, ' ').trim()));

const normalizeHeading = (text: string): string => text.toLowerCase().replace(/[^a-z]+/g, ' ').trim();

// Placeholder sentences that issue templates leave behind.
const TEMPLATE_PHRASES = /^(?:a clear and concise description|add any other context|if applicable, add screenshots|please complete the following information|go to '\.\.\.'|click on '\.\.\.\.?'|scroll down to '\.\.\.\.?'|see error$|_no response_$|no response$|n\/a$|none$|please describe\.?$|steps to reproduce the behavior:?$)/i;

/** '' for a bare template heading, the remainder for `Heading: text`, undefined when the line is not template boilerplate. */
function templateRemainder(line: string): string | undefined {
  const marked = /^(?:#{1,6}\s|\*\*|__)/.test(line);
  const t = line.replace(/^#{1,6}\s*/, '').replace(/^(?:\*\*|__)/, '').trim();
  const colon = t.indexOf(':');
  if (colon > 0 && colon < 60) {
    const heading = normalizeHeading(t.slice(0, colon).replace(/\*\*|__/g, ''));
    // `Expected: 5` in test output is data; `Expected behavior: ...` and `**Expected**: ...` are template headings.
    if (TEMPLATE_HEADINGS.has(heading) && (marked || heading.indexOf(' ') > 0)) return t.slice(colon + 1).replace(/^(?:\*\*|__)/, '').trim();
  }
  if (t.length <= 90 && TEMPLATE_HEADINGS.has(normalizeHeading(t.replace(/\*\*|__/g, '')))) return '';
  return undefined;
}

const ENV_KEYS = new Set(`os|operating system|platform|python|python version|node|node.js|node version|nodejs|npm|yarn|pnpm|java|java version|jdk|jre|go|go version|golang|rust|
  rustc|cargo|ruby|php|dotnet|.net|browser|browser version|version|device|kernel|architecture|arch|cpu|gpu|ram|docker|compiler|gcc|clang|pip|conda|cuda|machine|executable|
  implementation|release|build|commit|branch|sha|numpy|pandas|scipy|matplotlib|sympy|django|flask|requests|sklearn|scikit-learn|torch|pytorch|tensorflow|pytest|setuptools|
  cython|joblib|threadpoolctl|ipython|jupyter|notebook|astropy|xarray|dask|numba|pillow|pyarrow|sqlalchemy|pydantic|openssl|libc|blas|lapack|openblas|main|python executable|
  system|pip version|setuptools version`.split('|').map(s => s.replace(/\s+/g, ' ').trim()));

function isEnvironmentLine(s: string): boolean {
  if (s.length > 120) return false;
  const keyed = /^([A-Za-z][\w .+-]{0,30}?)\s*[:=]\s*(\S.*)$/.exec(s);
  if (keyed) {
    const key = keyed[1].toLowerCase().trim();
    if ((ENV_KEYS.has(key) || key.endsWith(' version')) && /\d|none|linux|windows|darwin|ubuntu|macos|debian|centos/i.test(keyed[2])) return true;
  }
  const versioned = /^([A-Za-z][\w.+-]{1,20})\s+v?\d+(?:\.\d+)+[\w.+-]*\s*(?:\(.*\))?$/.exec(s);
  return versioned !== null && ENV_KEYS.has(versioned[1].toLowerCase());
}

const DEPENDENCY_LINES: RegExp[] = [
  /^[A-Za-z][\w.-]*(?:\[[\w,.-]+\])?\s*(?:===?|>=|<=|~=|!=)\s*v?\d+(?:\.\d+)+[\w.+-]*(?:\s*;.*)?$/,
  /^[A-Za-z][\w.-]*(?:\[[\w,.-]+\])?\s*@\s*(?:git\+|file:|https?:)\S*$/,
  /^[A-Za-z][\w.-]*\s{2,}v?\d+(?:\.\d+)+[\w.+-]*(?:\s+\S+)?$/,
  /^[A-Za-z][\w.-]*\s+\(\d+(?:\.\d+)+[\w.+-]*\)$/,
  /^[\w.-]{1,40}:\s+(?:None|v?\d+\.\d+[\w.+-]*)$/,
  /^[-+|\\`├└│─ ]{0,8}[\w@./-]+@\d+\.\d+[\w.+-]*$/,
  /^Package\s+Version\b/,
];

const isDependencyLine = (s: string): boolean => s.length < 160 && DEPENDENCY_LINES.some(re => re.test(s));

const HTML_TAGS = /<\/?(?:details|summary|br|hr|p|div|span|img|a|b|i|strong|em|code|pre|sub|sup|ul|ol|li|table|tr|td|th|thead|tbody|h[1-6]|kbd|blockquote|font|center)(?:\s[^<>]{0,200})?\/?>/gi;
const UNCLOSED_TAG = /<\/?(?:img|a|div|span|p|table|td|tr|font|center)\b[^<>]*$/i;
const MD_IMAGE = /!\[[^[\]\n]{0,200}\]\([^)[\]\n]{0,500}\)/g;
const MD_LINK = /\[([^[\]\n]{1,200})\]\(([^)[\]\n]{0,500})\)/g;
const URL_TOKEN = /\bhttps?:\/\/[^\s)>\]"'`]+/g;
const FRAGMENT_NOISE = /#(?:L\d+(?:-L?\d+)?|issuecomment-\d+|issue-\d+|diff-[0-9a-f]+|r\d+|discussion_r\d+|[0-9a-f]{8,}.*)$/;

function cleanUrl(url: string): string {
  const blob = BLOB_URL.exec(url);
  if (blob) return blob[1].replace(/[?#].*$/, '');
  let u = url;
  const query = u.indexOf('?');
  if (query >= 0) u = u.slice(0, query);
  u = u.replace(FRAGMENT_NOISE, '');
  return u.replace(/[.,;:]+$/, '');
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const CLOCK = /^\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?$/;
const PROGRESS = /^[[(]?[=#>.\-█▓▒░■]{5,}[\])]?$/;

const isHex = (s: string): boolean => /^[0-9a-fA-F]+$/.test(s);

/** Words that carry no retrieval signal: hashes, addresses, timestamps, blobs. Returns true when the word should be dropped. */
function isNoiseWord(word: string): boolean {
  const n = word.length;
  if (n > 200 || (n > 120 && /^[A-Za-z0-9+/=_;,.-]+$/.test(word))) return true;
  if (n >= 32 && isHex(word)) return true;
  if (n >= 7 && n <= 40 && isHex(word) && /\d/.test(word) && /[a-fA-F]/.test(word)) return true;
  if (n >= 8 && word.charCodeAt(0) === 48 && (word.charCodeAt(1) === 120 || word.charCodeAt(1) === 88) && isHex(word.slice(2))) return true;
  if (n === 36 && word.charCodeAt(8) === 45 && word.charCodeAt(13) === 45 && word.charCodeAt(18) === 45 && isHex(word.replace(/-/g, ''))) return true;
  if (n <= 40 && (ISO_TIMESTAMP.test(word) || CLOCK.test(word))) return true;
  if (n > 40 && word.startsWith('data:')) return true;
  if (n >= 2 && n <= 9 && word.charCodeAt(0) === 35 && /^#\d+$/.test(word)) return true;
  return n >= 5 && PROGRESS.test(word);
}

/** The word without leading and trailing punctuation. */
function coreOf(word: string): string {
  let i = 0;
  let j = word.length;
  while (i < j && !isIdentChar(word.charCodeAt(i))) i++;
  while (j > i && !isIdentChar(word.charCodeAt(j - 1))) j--;
  return word.slice(i, j);
}

function cleanWords(line: string): string {
  return line.replace(/\S+/g, word => {
    if (isNoiseWord(word)) return '';
    const core = coreOf(word);
    return core.length >= 7 && core !== word && isNoiseWord(core) ? '' : word;
  });
}

interface CleanLine {
  /** Index of the source line. */
  li: number;
  text: string;
  kind: 'frame' | 'error' | 'test' | 'prose';
  fenced: boolean;
  dependency: boolean;
  /** A blank line preceded this line in the source. */
  paragraph: boolean;
}

function linkTarget(text: string, target: string): string {
  const t = target.trim();
  if (BLOB_URL.test(t)) return `${text} ${cleanUrl(t)}`;
  if (/^https?:\/\//i.test(t)) {
    const url = cleanUrl(t);
    return text.indexOf(url) >= 0 || url.indexOf(text.trim()) >= 0 ? text : `${text} ${url}`;
  }
  const path = candidatePath(t);
  return path && text.indexOf(path) < 0 ? `${text} ${path}` : text;
}

function cleanProseLine(raw: string, fenced: boolean): string {
  let s = raw.trim();
  if (!s) return '';
  if (!fenced) {
    if (/^[-*+]\s*\[[ xX]\]\s*(?:I\b|I'|My\b|This\b|Please\b|The\b)/.test(s)) return '';
    for (let round = 0; round < 3; round++) {
      const before = s;
      s = s.replace(/^>+\s*/, '').replace(/^[-*+]\s+(?:\[[ xX]\]\s*)?/, '').replace(/^\d{1,3}[.)]\s+(?=\S)/, '');
      if (s === before) break;
    }
    const remainder = templateRemainder(s);
    if (remainder !== undefined) s = remainder;
    if (TEMPLATE_PHRASES.test(s)) return '';
    s = s.replace(/^#{1,6}\s+/, '');
    if (/^(?:[-*_]\s*){3,}$/.test(s)) return '';
    s = s.replace(/\*\*/g, '');
  }
  if (s.indexOf('<') >= 0) s = s.replace(HTML_TAGS, ' ').replace(/&nbsp;/g, ' ');
  if (s.indexOf('![') >= 0) s = s.replace(MD_IMAGE, ' ');
  if (s.indexOf('](') >= 0) s = s.replace(MD_LINK, (_m, text: string, target: string) => linkTarget(text, target));
  if (s.indexOf('://') >= 0) s = s.replace(URL_TOKEN, cleanUrl);
  s = cleanWords(s).replace(/\s+/g, ' ').trim().replace(/^##\[[a-z]+\]\s*/, '');
  if (s.indexOf('<') >= 0) s = s.replace(UNCLOSED_TAG, '').trim();
  if (!/[\p{L}\p{N}]/u.test(s)) return '';
  return s;
}

const SIGNATURE = /^(?:(?:export|public|private|protected|static|final|abstract|async|override|pub|unsafe|extern|default|open|internal|data|sealed|suspend|inline)\s+)*(?:def|class|function|fn|func|struct|interface|trait|enum|impl|type|module|namespace|object|sub|fun|record|protocol)\s+[A-Za-z_$]/;
const IMPORT = /^(?:import\s|from\s+[\w.]+\s+import\s|using\s|require\(|const\s+\w+\s*=\s*require\(|#include\s|use\s+[\w:]+)/;

function isSignature(text: string): boolean {
  return SIGNATURE.test(text) || /^(?:const|let|var|export)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(text);
}

// ---------------------------------------------------------------------------------------------------------------
// condenseQuery: frame display

const ROOT_PREFIXES = [/^[A-Za-z]:\/Users\/[^/]+\//, /^\/home\/[^/]+\//, /^\/Users\/[^/]+\//, /^\/root\//, /^\/tmp\/[^/]+\//,
  /^\/(?:app|testbed|workspace|code|build|builds|usr\/src\/app|github\/workspace|opt\/app|srv\/app|var\/www(?:\/html)?|go\/src\/[^/]+\/[^/]+\/[^/]+)\//,
  /^work\/[^/]+\/[^/]+\//];

function displayPath(frame: StackFrame): string {
  const jvm = jvmComponents(frame);
  if (jvm) return jvm.join('/');
  let path = frame.path;
  const marker = /(?:^|\/)(?:(?:site|dist)-packages\/|node_modules\/(?!.*\/node_modules\/)|\.cargo\/registry\/src\/[^/]+\/)|\/go\/pkg\/mod\//.exec(path);
  if (marker) {
    path = path.slice(marker.index + marker[0].length).replace(/^([^/]+?)@v?\d[^/]*\//, '$1/').replace(/^([^/]+?)-\d+(?:\.\d+)+[^/]*\//, '$1/');
  } else {
    for (let round = 0; round < 2; round++) {
      for (const prefix of ROOT_PREFIXES) {
        const m = prefix.exec(path);
        if (m) { path = path.slice(m[0].length); break; }
      }
    }
  }
  return path.replace(/^\.\//, '').replace(/^~\//, '');
}

function displayFunction(frame: StackFrame): string {
  const symbols = frameSymbols(frame);
  if (symbols.length === 0) return '';
  const full = symbols[0];
  return full.length > 80 ? symbols[symbols.length > 1 ? 1 : 0] : full;
}

function displayFrame(frame: StackFrame): string {
  const location = frame.line === undefined ? displayPath(frame) : `${displayPath(frame)}:${frame.line}`;
  const func = displayFunction(frame);
  return func ? `${location}: in ${func}` : location;
}

// ---------------------------------------------------------------------------------------------------------------
// condenseQuery: assembly

function stripHtmlComments(raw: string, state: { open: boolean }): string {
  let i = 0;
  if (state.open) {
    const end = raw.indexOf('-->');
    if (end < 0) return '';
    i = end + 3;
    state.open = false;
  }
  let out = '';
  for (;;) {
    const start = raw.indexOf('<!--', i);
    if (start < 0) return out + raw.slice(i);
    out += `${raw.slice(i, start)} `;
    const end = raw.indexOf('-->', start + 4);
    if (end < 0) {
      state.open = true;
      return out;
    }
    i = end + 3;
  }
}

function buildCleanLines(a: Analysis): CleanLine[] {
  const frameAt = new Map<number, number>();
  a.meta.forEach((m, i) => frameAt.set(m.lineIndex, i));
  const items: CleanLine[] = [];
  const comment = { open: false };
  let paragraph = false;
  for (let li = 0; li < a.lines.length; li++) {
    const kind = a.kinds[li];
    if (kind === K_BLANK) { paragraph = true; continue; }
    if (kind === K_CONSUMED || kind === K_FENCE) continue;
    let text: string;
    let lineKind: CleanLine['kind'] = 'prose';
    let dependency = false;
    if (kind === K_FRAME) {
      const index = frameAt.get(li);
      if (index === undefined) continue;
      text = cleanWords(displayFrame(a.frames[index])).replace(/\s+/g, ' ').trim();
      lineKind = 'frame';
    } else {
      const raw = a.lines[li].indexOf('<!--') >= 0 || comment.open ? stripHtmlComments(a.lines[li], comment) : a.lines[li];
      if (kind === K_ERROR || kind === K_TEST) lineKind = kind === K_ERROR ? 'error' : 'test';
      text = cleanProseLine(raw, a.fenced[li] === 1 || lineKind !== 'prose');
      if (text.length > 1200) text = shorten(text, 1200);
      else if (text.length > 400 && text.split(' ').length < text.length / 14) text = a.continued[li] ? '' : shorten(text, 200);
      else if (a.continued[li] && text.split(' ').length < text.length / 10) text = '';
      if (lineKind === 'prose') {
        if (isEnvironmentLine(text)) text = '';
        dependency = isDependencyLine(raw.trim().replace(/^[-*+]\s+/, ''));
      }
    }
    if (!text) continue;
    items.push({ li, text, kind: lineKind, fenced: a.fenced[li] === 1, dependency, paragraph });
    paragraph = false;
  }
  const out: CleanLine[] = [];
  const seen = new Set<string>();
  let carry = false;
  for (const item of dropDependencyRuns(items)) {
    const key = item.text.toLowerCase();
    const loose = item.text.length >= 12 && item.kind !== 'frame' ? key.replace(/\d+/g, '#') : key;
    const paragraphBreak: boolean = item.paragraph || carry;
    carry = false;
    if (seen.has(key) || seen.has(loose)) { carry = paragraphBreak; continue; }
    seen.add(key);
    seen.add(loose);
    out.push({ ...item, paragraph: paragraphBreak });
  }
  return out;
}

function dropDependencyRuns(lines: CleanLine[]): CleanLine[] {
  const keep = new Array<boolean>(lines.length).fill(true);
  let start = 0;
  while (start < lines.length) {
    if (!lines[start].dependency) { start++; continue; }
    let end = start;
    while (end + 1 < lines.length && lines[end + 1].dependency) end++;
    if (end - start + 1 >= 3) for (let i = start; i <= end; i++) keep[i] = false;
    start = end + 1;
  }
  return lines.filter((_line, i) => keep[i]);
}

function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const space = text.lastIndexOf(' ', limit);
  return text.slice(0, space > limit * 0.6 ? space : limit).trimEnd();
}

const IDENTIFIER_TOKEN = /^[A-Za-z_$][\w$]*(?:(?:\.|::|#|->)[A-Za-z_$][\w$]*)*$/;

function identifierTokens(text: string): string[] {
  const out: string[] = [];
  IDENT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IDENT.exec(text))) out.push(m[0].toLowerCase());
  return out;
}

function tokenWeight(token: string): number {
  const parts = token.split(/::|->|[.#]/);
  if (parts.length > 1 && parts.every(p => p.length >= 2)) return 3;
  if (isCodeLike(token) || /^__\w+__$/.test(token)) return 3;
  if (token.length < 4 || STOP_WORDS.has(token.toLowerCase())) return 0;
  return /^[A-Z][a-z]+$/.test(token) ? 1.5 : 1;
}

interface Candidate { order: number; line: number; text: string; cost: number; keys: string[]; density: number }

interface Selection { lines: Set<number>; tokens: string[] }

/**
 * Greedy selection of lines and bare identifiers by new-token gain per character (lazy evaluation: stale densities are upper
 * bounds because covering a token can only reduce the gain of other candidates).
 */
function selectFill(lines: CleanLine[], used: Set<number>, covered: Set<string>, budget: number, weights: Map<string, number>, display: Map<string, string>): Selection {
  const gainOf = (keys: string[]): number => keys.reduce((sum, key) => sum + (covered.has(key) ? 0 : weights.get(key) ?? 0), 0);
  const pool: Candidate[] = [];
  const lineCandidates: Candidate[] = [];
  lines.forEach((line, index) => {
    if (used.has(index) || line.kind === 'frame') return;
    const text = shorten(line.text, 240);
    const keys = [...new Set(identifierTokens(text))].filter(key => (weights.get(key) ?? 0) > 0);
    if (keys.length > 0) lineCandidates.push({ order: index, line: index, text, cost: text.length + 1, keys, density: gainOf(keys) / (text.length + 1) });
  });
  lineCandidates.sort((x, y) => y.density - x.density || x.order - y.order);
  pool.push(...lineCandidates.slice(0, 2000));
  const tokenCandidates = [...weights]
    .filter(([key, weight]) => weight >= 2 && !covered.has(key))
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .slice(0, 1500);
  tokenCandidates.forEach(([key, weight], rank) => {
    const text = display.get(key) ?? key;
    pool.push({ order: lines.length + rank, line: -1, text, cost: text.length + 1, keys: [key], density: weight / (text.length + 1) });
  });
  const before = (x: Candidate, y: Candidate): boolean => x.density > y.density || (x.density === y.density && x.order < y.order);
  pool.sort((x, y) => (before(x, y) ? -1 : before(y, x) ? 1 : 0));
  const insert = (candidate: Candidate): void => {
    let lo = 0;
    let hi = pool.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (before(pool[mid], candidate)) lo = mid + 1;
      else hi = mid;
    }
    pool.splice(lo, 0, candidate);
  };
  const chosen: Selection = { lines: new Set(), tokens: [] };
  while (pool.length > 0 && budget > 8) {
    const top = pool.shift()!;
    const density = gainOf(top.keys) / top.cost;
    if (density < 0.004) continue;
    if (pool.length > 0 && density < pool[0].density) {
      top.density = density;
      insert(top);
      continue;
    }
    if (top.cost > budget) continue;
    budget -= top.cost;
    if (top.line >= 0) {
      chosen.lines.add(top.line);
      lines[top.line] = { ...lines[top.line], text: top.text };
    } else chosen.tokens.push(top.text);
    for (const key of top.keys) covered.add(key);
  }
  return chosen;
}

function buildDigest(a: Analysis, lines: CleanLine[], limit: number): string {
  const used = new Set<number>();
  const covered = new Set<string>();
  const cover = (text: string): void => identifierTokens(text).forEach(token => covered.add(token));
  let budget = limit;
  const spend = (text: string): boolean => {
    if (text.length + 1 > budget) return false;
    budget -= text.length + 1;
    return true;
  };

  // 1. Title and first paragraph.
  const head: string[] = [];
  const headCap = Math.max(32, Math.min(1400, Math.floor(limit * 0.22)));
  let headUsed = 0;
  const firstProse = lines.findIndex(line => line.kind === 'prose');
  for (let i = firstProse; i >= 0 && i < lines.length; i++) {
    const line = lines[i];
    if (line.kind !== 'prose' || (i > firstProse && line.paragraph)) break;
    const room = headCap - headUsed - 1;
    if (room < 16) break;
    const text = shorten(line.text, room);
    head.push(text);
    headUsed += text.length + 1;
    used.add(i);
    if (text.length < line.text.length) break;
  }
  head.forEach(line => { spend(line); cover(line); });

  // 2. Error lines and failing tests.
  const errors: string[] = [];
  const errorCap = Math.max(Math.floor(limit * 0.2), Math.min(120, Math.floor(limit * 0.5)));
  let errorUsed = 0;
  const ranked = a.sink.errors.map((entry, order) => ({ entry, order })).sort((x, y) => y.entry.priority - x.entry.priority || x.order - y.order);
  const chosenErrors: { text: string; order: number }[] = [];
  for (const { entry, order } of ranked) {
    const text = shorten(cleanWords(entry.text).replace(/\s+/g, ' ').trim(), 300);
    if (!text) continue;
    if (errorUsed + text.length + 1 > errorCap) {
      if (chosenErrors.length > 0) continue;
      const clipped = shorten(text, errorCap - 1);
      errorUsed += clipped.length + 1;
      chosenErrors.push({ text: clipped, order });
      continue;
    }
    errorUsed += text.length + 1;
    chosenErrors.push({ text, order });
  }
  chosenErrors.sort((x, y) => x.order - y.order).forEach(({ text }) => { if (spend(text)) { errors.push(text); cover(text); } });
  const errorKeys = new Set([...errors, ...a.sink.errors.map(e => e.text)].map(text => text.toLowerCase()));
  lines.forEach((line, i) => { if (line.kind === 'error' && errorKeys.has(line.text.toLowerCase())) used.add(i); });
  const tests: string[] = [];
  for (const name of a.sink.tests.slice(0, 10)) if (spend(name)) { tests.push(name); cover(name); }
  lines.forEach((line, i) => { if (line.kind === 'test') used.add(i); });

  // 3. Frames, innermost application frames first.
  const frames: string[] = [];
  const frameCap = Math.floor(limit * 0.22);
  let frameUsed = 0;
  const depths = frameDepths(a);
  const kindRank: Record<FrameKind, number> = { app: 0, dependency: 1, runtime: 2 };
  const order = a.frames.map((_f, i) => i).sort((x, y) => kindRank[frameKind(a.frames[x])] - kindRank[frameKind(a.frames[y])]
    || depths[x] - depths[y] || (a.frames[x].segment ?? 0) - (a.frames[y].segment ?? 0) || x - y);
  const useful = order.filter(i => frameKind(a.frames[i]) !== 'runtime');
  const seenFrames = new Set<string>();
  for (const i of useful.length >= 3 ? useful : order) {
    const text = cleanWords(displayFrame(a.frames[i])).replace(/\s+/g, ' ').trim();
    if (!text || seenFrames.has(text)) continue;
    if (frameUsed + text.length + 1 > frameCap) break;
    seenFrames.add(text);
    if (!spend(text)) break;
    frameUsed += text.length + 1;
    frames.push(text);
    cover(text);
  }
  lines.forEach((line, i) => { if (line.kind === 'frame') used.add(i); });

  // 4. Code-block signatures.
  const signatures: { index: number; text: string }[] = [];
  const signatureCap = Math.floor(limit * 0.12);
  let signatureUsed = 0;
  lines.forEach((line, index) => {
    if (used.has(index) || line.kind !== 'prose' || !(isSignature(line.text) || (line.fenced && IMPORT.test(line.text)))) return;
    const text = shorten(line.text, 160);
    if (signatureUsed + text.length + 1 > signatureCap || !spend(text)) return;
    signatureUsed += text.length + 1;
    signatures.push({ index, text });
    used.add(index);
    cover(text);
  });

  // 5. Identifiers and the remaining lines compete by new-token gain per character.
  const proseTexts = new Map<number, string>();
  for (const line of lines) if (line.kind === 'prose') proseTexts.set(line.li, line.text);
  const symbolList = extract(a, 800, proseTexts).symbols.filter(s => s.base >= 3 && IDENTIFIER_TOKEN.test(s.token));
  const weights = new Map<string, number>();
  const df = new Map<string, number>();
  const originals = new Map<string, string>();
  const context = new Map<string, number>();
  for (const line of lines) {
    IDENT.lastIndex = 0;
    let m: RegExpExecArray | null;
    const inLine = new Set<string>();
    const base = line.fenced ? 0.8 : 1;
    while ((m = IDENT.exec(line.text))) {
      const key = m[0].toLowerCase();
      if (!originals.has(key)) originals.set(key, m[0]);
      inLine.add(key);
      if (base > (context.get(key) ?? 0)) context.set(key, base);
    }
    inLine.forEach(key => df.set(key, (df.get(key) ?? 0) + 1));
    if (line.text.indexOf('`') >= 0) {
      BACKTICK.lastIndex = 0;
      let b: RegExpExecArray | null;
      while ((b = BACKTICK.exec(line.text))) for (const key of identifierTokens(b[1])) context.set(key, 1.4);
    }
  }
  for (const [key, original] of originals) {
    const w = tokenWeight(original);
    if (w > 0) weights.set(key, (w * (context.get(key) ?? 1)) / (1 + Math.log(df.get(key) ?? 1)));
  }
  const display = new Map(originals);
  for (const symbol of symbolList) {
    const key = symbol.token.toLowerCase();
    display.set(key, symbol.token);
    weights.set(key, Math.max(weights.get(key) ?? 0, Math.min(5, symbol.base * 0.45)));
  }
  const fillLines = lines.map(line => ({ ...line }));
  const selection = selectFill(fillLines, used, covered, budget, weights, display);
  const fill: string[] = [];
  fillLines.forEach((line, index) => {
    if (selection.lines.has(index)) fill.push(line.text);
  });
  const identifiers = selection.tokens;

  const parts: string[] = [...head, ...errors, ...tests, ...frames];
  if (identifiers.length) parts.push(identifiers.join(' '));
  parts.push(...signatures.map(s => s.text), ...fill);
  let result = parts.join('\n');
  if (result.length > limit) result = shorten(result, limit);
  return result;
}

function fallbackText(text: string, limit: number): string {
  const lines = prepareLines(text).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const joined = lines.join('\n').slice(0, limit);
  return joined || text.slice(0, limit);
}

/**
 * Reduces issue or log text to at most `maxChars` characters. Text that fits after cleaning is returned whole; longer text becomes
 * title, error lines, failing tests, frames (innermost application frames first), identifiers, signatures and the most
 * informative remaining lines. Deterministic; never throws; never returns an empty string for non-empty input.
 */
export function condenseQuery(text: string, maxChars: number = DEFAULT_MAX_CHARS): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  const limit = Number.isFinite(maxChars) ? Math.min(200_000, Math.max(32, Math.floor(maxChars))) : DEFAULT_MAX_CHARS;
  try {
    const analysis = analyze(text);
    const lines = buildCleanLines(analysis);
    const whole = lines.map(line => line.text).join('\n');
    if (whole.length > 0 && whole.length <= limit) return whole;
    const digest = whole.length > 0 ? buildDigest(analysis, lines, limit) : '';
    if (digest) return digest;
  } catch {
    // fall through to plain truncation
  }
  return fallbackText(text, limit);
}
