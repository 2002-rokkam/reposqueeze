import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Rng } from './prng.js';

export interface RepoQuery {
  kind: 'identifier' | 'comment' | 'trace';
  text: string;
  source: { path: string; line: number } | null;
}

export interface ExpandTarget {
  path: string;
  start: number;
  end: number;
}

export interface GeneratedQueries {
  queries: RepoQuery[];
  expand: ExpandTarget | null;
  scannedFiles: number;
}

const CODE_EXT = new Set(
  '.py .js .mjs .cjs .jsx .ts .tsx .go .rs .java .kt .kts .scala .c .h .cc .cpp .cxx .hpp .hh .cs .rb .php .swift .dart .zig .hs .ml .mli .clj .cljs .pl .pm .sh .lua .ex .exs .vue .svelte'.split(' '),
);
const PROSE_EXT = new Set(['.md', '.markdown', '.rst', '.txt', '.adoc']);
const SKIP_DIR = /(^|\/)(?:node_modules|vendor|third_party|\.git|dist|build|target|testdata|fixtures?|generated)(\/|$)/i;
const MAX_FILE_BYTES = 300 * 1024;

// Deliberately simple, line-based scans: this is a query generator, not a parser.
const FUNCTION_PATTERNS: RegExp[] = [
  /^\s*(?:async\s+)?def\s+(?:self\.)?([A-Za-z_][\w?!]{4,})\s*[(\n:]/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]{4,})\s*[(<]/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]{4,})\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w{4,})\s*[(\[]/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w{4,})/,
  /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|synchronized|suspend|inline|open)\s+)+(?:[\w<>[\],.?*& ]+?\s+)?([A-Za-z_]\w{4,})\s*\([^;]*$/,
  /^\s*(?:(?:public|private|internal|open|fileprivate|static|final|override|mutating)\s+)*(?:fun|func)\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w{4,})\s*[(<]/,
  /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?([A-Za-z_]\w{4,})\s*\(/,
  /^\s*(?:pub\s+)?(?:inline\s+)?(?:export\s+)?fn\s+([A-Za-z_]\w{4,})/,
  /^\s*(?:sub|proc|defp?|defn-?|defmacro|local\s+function)\s+([A-Za-z_][\w.:?!-]{4,})/,
  /^\s*(?:let\s+rec|let)\s+([a-z_]\w{4,})\s+[\w(]/,
  /^\s*(?:function\s+)?([A-Za-z_]\w{4,})\s*\(\)\s*\{/,
  /^[A-Za-z_][\w\s*&:<>,]*?[\s*&]([A-Za-z_]\w{4,})\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{?\s*$/,
];
const NOT_FUNCTIONS = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'catch', 'main', 'constructor', 'toString', 'equals', 'hashCode', 'setUp', 'tearDown']);
const LICENSE_WORDS = /licen[sc]e|copyright|warranty|permission|redistribut|all rights reserved|http|www\./i;

export interface Candidate {
  path: string;
  line: number;
  name: string;
}

export function findFunctionDefinitions(path: string, text: string, limit = 200): Candidate[] {
  const out: Candidate[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i];
    if (line.length > 300) continue;
    for (const pattern of FUNCTION_PATTERNS) {
      const name = pattern.exec(line)?.[1];
      if (name && !NOT_FUNCTIONS.has(name) && !/^__\w+__$/.test(name) && name.length <= 48) {
        out.push({ path, line: i + 1, name });
        break;
      }
    }
  }
  return out;
}

const COMMENT_LINE = /^\s*(?:#+|\/\/+!?|--|;+|\*|\/\*+!?|"""|'''|\/\/\/)\s?(.+?)\s*(?:\*\/|"""|''')?\s*$/;

export function findCommentSentences(path: string, text: string, limit = 100): { path: string; line: number; text: string }[] {
  const out: { path: string; line: number; text: string }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const body = COMMENT_LINE.exec(lines[i])?.[1];
    if (!body || body.length < 40 || body.length > 200) continue;
    if (LICENSE_WORDS.test(body) || /[{};=<>$]/.test(body)) continue;
    const words = body.split(/\s+/).filter(word => /^[A-Za-z][A-Za-z'-]{2,}[.,:;]?$/.test(word));
    if (words.length >= 7 && words.length >= body.split(/\s+/).length * 0.8) out.push({ path, line: i + 1, text: body });
  }
  return out;
}

export function buildTrace(candidate: Candidate, projectName: string, sourceLine: string): string {
  const ext = extname(candidate.path).toLowerCase();
  const abs = `/home/runner/work/${projectName}/${projectName}/${candidate.path}`;
  const base = candidate.path.split('/').pop() ?? candidate.path;
  const { name, line } = candidate;
  const snippet = sourceLine.trim().slice(0, 100);
  switch (ext) {
    case '.py':
      return `Traceback (most recent call last):\n  File "${abs}", line ${line}, in ${name}\n    ${snippet}\nValueError: unexpected state in ${name}`;
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.jsx':
    case '.ts':
    case '.tsx':
    case '.vue':
      return `Error: unexpected state in ${name}\n    at ${name} (${abs}:${line}:13)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;
    case '.go':
      return `panic: runtime error: invalid memory address or nil pointer dereference\n[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x4b2a1c]\n\ngoroutine 1 [running]:\n${name}(...)\n\t${abs}:${line} +0x1d`;
    case '.rs':
      return `thread 'main' panicked at ${candidate.path}:${line}:9:\ncalled \`Option::unwrap()\` on a \`None\` value in ${name}\nnote: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace`;
    case '.java':
    case '.kt':
    case '.kts':
    case '.scala':
      return `Exception in thread "main" java.lang.IllegalStateException: unexpected state\n\tat ${name}(${base}:${line})\n\tat java.base/java.lang.Thread.run(Thread.java:840)`;
    case '.rb':
      return `${abs}:${line}:in \`${name}': unexpected state (RuntimeError)\n\tfrom ${abs}:${line + 3}:in \`<main>'`;
    case '.php':
      return `PHP Fatal error:  Uncaught Exception: unexpected state in ${abs}:${line}\nStack trace:\n#0 ${abs}(${line + 2}): ${name}()`;
    default:
      return `${abs}:${line}:9: error: unexpected state in '${name}'\n${snippet}\n        ^\nmake: *** [all] Error 1`;
  }
}

async function readSmall(root: string, path: string): Promise<string | null> {
  try {
    const info = await stat(join(root, path));
    if (!info.isFile() || info.size > MAX_FILE_BYTES || info.size === 0) return null;
    const text = await readFile(join(root, path), 'utf8');
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

/**
 * Deterministic queries for one repository: same file list + same contents + same seed => same output.
 * Produces an identifier, a comment sentence and a stack-trace-like text that cites a real file:line,
 * plus a random file for the `expand` check. Never uses ambient randomness.
 */
export async function generateQueries(root: string, files: readonly string[], seed: string, projectName: string): Promise<GeneratedQueries> {
  const rng = Rng.from('queries', seed);
  const eligible = files.filter(file => !SKIP_DIR.test(file));
  const code = eligible.filter(file => CODE_EXT.has(extname(file).toLowerCase()));
  const prose = eligible.filter(file => PROSE_EXT.has(extname(file).toLowerCase()));
  const pool = code.length ? code : eligible;

  const functions: Candidate[] = [];
  const comments: { path: string; line: number; text: string }[] = [];
  const contents = new Map<string, string>();
  let scanned = 0;
  for (const path of rng.shuffle(pool).slice(0, 80)) {
    const text = await readSmall(root, path);
    if (text === null) continue;
    scanned++;
    contents.set(path, text);
    functions.push(...findFunctionDefinitions(path, text, 40));
    comments.push(...findCommentSentences(path, text, 20));
    if (scanned >= 40 && functions.length >= 20 && comments.length >= 10) break;
  }
  if (!comments.length) {
    for (const path of rng.shuffle(prose).slice(0, 30)) {
      const text = await readSmall(root, path);
      if (text === null) continue;
      scanned++;
      comments.push(...text.split('\n').flatMap((line, i) => (line.length >= 50 && line.length <= 200 && /^[A-Z][^#|`<>{}]*[a-z.]$/.test(line.trim()) ? [{ path, line: i + 1, text: line.trim() }] : [])).slice(0, 10));
      if (comments.length >= 5) break;
    }
  }

  const queries: RepoQuery[] = [];
  const fn = functions.length ? rng.pick(functions) : null;
  if (fn) queries.push({ kind: 'identifier', text: fn.name, source: { path: fn.path, line: fn.line } });
  else {
    const token = fallbackToken(rng, contents);
    queries.push({ kind: 'identifier', text: token.text, source: token.source });
  }
  const comment = comments.length ? rng.pick(comments) : null;
  queries.push(
    comment
      ? { kind: 'comment', text: comment.text, source: { path: comment.path, line: comment.line } }
      : { kind: 'comment', text: 'where is the main entry point of this project implemented', source: null },
  );

  const traceFn = functions.length ? rng.pick(functions) : fallbackTraceTarget(rng, eligible, contents);
  if (traceFn) {
    const text = contents.get(traceFn.path) ?? (await readSmall(root, traceFn.path)) ?? '';
    const lines = text.split('\n');
    const line = Math.min(lines.length, traceFn.line + rng.between(0, 5));
    queries.push({
      kind: 'trace',
      text: buildTrace({ ...traceFn, line }, projectName, lines[line - 1] ?? ''),
      source: { path: traceFn.path, line },
    });
  } else {
    queries.push({ kind: 'trace', text: `Error: unexpected failure\n    at main (/workspace/${projectName}/index:1:1)`, source: null });
  }

  return { queries, expand: await pickExpandTarget(root, rng, [...contents.keys()], eligible), scannedFiles: scanned };
}

function fallbackToken(rng: Rng, contents: Map<string, string>): { text: string; source: RepoQuery['source'] } {
  for (const [path, text] of rng.shuffle([...contents]) ) {
    const tokens = [...text.matchAll(/[A-Za-z][A-Za-z0-9_]{5,30}/g)].map(match => match[0]);
    if (tokens.length) return { text: rng.pick(tokens), source: { path, line: 1 } };
  }
  return { text: 'initialize configuration', source: null };
}

function fallbackTraceTarget(rng: Rng, eligible: readonly string[], contents: Map<string, string>): Candidate | null {
  const withText = [...contents.keys()];
  const path = withText.length ? rng.pick(withText) : eligible.length ? rng.pick(eligible) : null;
  if (!path) return null;
  const lines = (contents.get(path) ?? '').split('\n').length;
  return { path, line: rng.between(1, Math.max(1, lines)), name: 'handler' };
}

async function pickExpandTarget(root: string, rng: Rng, scanned: readonly string[], eligible: readonly string[]): Promise<ExpandTarget | null> {
  const preferred = rng.shuffle(scanned.length ? scanned : eligible).slice(0, 40);
  for (const path of preferred) {
    const text = await readSmall(root, path);
    if (text !== null && text.split('\n').length >= 80) return { path, start: 1, end: 80 };
  }
  for (const path of preferred) {
    if ((await readSmall(root, path)) !== null) return { path, start: 1, end: 80 };
  }
  return null;
}
