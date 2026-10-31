/**
 * ripgrep-naive: a deliberately simple reference retriever, "what an agent gets from plain grep".
 *
 * It takes the identifiers and words of the issue, lets ripgrep find the files that contain any of them,
 * ranks files by the IDF-weighted number of distinct terms they contain, and fills the token budget
 * with grep-style line windows (like `rg -C`), best file first. No syntax awareness, no symbol
 * boosting, no stemming, no fusion of query views. Deterministic: ties are broken by path.
 *
 * Exposes the same API as RepoSqueeze: `new Engine(root).context(query, budget)`.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getEncoding } from 'js-tiktoken';

const run = promisify(execFile);
const encoder = getEncoding('o200k_base');
const tokens = (text: string): number => encoder.encode(text, [], []).length;

const MAX_TERMS = 40;
const MAX_TERM_CHARS = 80;
const MAX_FILES = 12;
const WINDOWS_PER_FILE = 3;
const HALF_WINDOW = 6;
const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_CHARS = 400;
const READ_CONCURRENCY = 16;

const STOPWORDS = new Set(`
about above after again against all also and any are because been before being below between both but can cannot could did does doing down during each few
for from further had has have having her here him his how into its itself just more most not now off once only other our out over own same she should some such
than that the their them then there these they this those through too under until very was were what when where which while who whom why will with would you your
please thanks thank issue bug following expected actual seems seem able make makes made work works working
`.split(/\s+/).filter(Boolean));

export interface Pack {
  text: string;
  evidence: { path: string; start: number; end: number; id: string }[];
  stats: {
    tokenizer: string; inputTokens: number; outputTokens: number; reduction: number; selectedChunks: number; totalChunks: number;
    files: number; elapsedMs: number; revision: string; budget: number; terms: number;
  };
}

interface Term {
  text: string;
  caseSensitive: boolean;
  idf: number;
  files: Set<string>;
}

function isCodeLike(token: string): boolean {
  const core = token.replace(/^_+|_+$/g, '');
  return /_/.test(core) || /[a-z0-9][A-Z]/.test(core) || /[A-Z]{2,}[a-z]/.test(core) || /\d/.test(core) || (core.length >= 4 && core === core.toUpperCase() && /[A-Z]/.test(core));
}

export function extractTerms(query: string): { text: string; caseSensitive: boolean }[] {
  const counts = new Map<string, { text: string; caseSensitive: boolean; count: number; code: boolean }>();
  for (const token of query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (token.length > MAX_TERM_CHARS) continue; // base64 blobs, minified code: not something an agent would grep for
    const code = isCodeLike(token);
    if (code ? token.length < 3 : token.length < 4 || STOPWORDS.has(token.toLowerCase())) continue;
    const key = code ? `c:${token}` : `w:${token.toLowerCase()}`;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { text: code ? token : token.toLowerCase(), caseSensitive: code, count: 1, code });
  }
  return [...counts.values()]
    .sort((a, b) => Number(b.code) - Number(a.code) || b.count - a.count || b.text.length - a.text.length || (a.text < b.text ? -1 : 1))
    .slice(0, MAX_TERMS)
    .map(({ text, caseSensitive }) => ({ text, caseSensitive }));
}

const RG_BASE = ['--no-config', '--no-messages', '--no-ignore-parent', '--max-filesize', '2M', '--threads', '2'];

async function rg(root: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await run('rg', [...RG_BASE, ...args, '--', '.'], { cwd: root, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' });
    return stdout.split('\n').filter(Boolean).map(path => path.replace(/^\.\//, ''));
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string };
    if (failure.code === 'ENOENT') throw new Error('ripgrep-naive needs ripgrep (`rg`) on PATH');
    // exit 1 = no match; exit 2 = some files unreadable, matches found so far are still valid
    if (failure.code === 1 || failure.code === 2) return String(failure.stdout ?? '').split('\n').filter(Boolean).map(path => path.replace(/^\.\//, ''));
    throw error;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]);
  }));
  return results;
}

/** For each wanted term: does the content contain it (case-sensitive terms exactly, words ignoring case)? */
function termsPresent(content: string, wanted: { text: string; caseSensitive: boolean }[]): boolean[] {
  const lower = content.toLowerCase();
  return wanted.map(term => (term.caseSensitive ? content.includes(term.text) : lower.includes(term.text)));
}

interface Window {
  start: number;
  end: number;
  best: number;
  score: number;
}

function windowsFor(lines: string[], terms: Term[]): Window[] {
  const lineScores = lines.map(line => {
    let score = 0;
    const lower = line.length <= 4000 ? line.toLowerCase() : '';
    for (const term of terms) {
      if (term.caseSensitive ? line.includes(term.text) : lower.includes(term.text)) score += term.idf;
    }
    return score;
  });
  const order = lineScores.map((score, index) => ({ score, index })).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const taken: Window[] = [];
  for (const { index } of order) {
    if (taken.length >= WINDOWS_PER_FILE) break;
    const start = Math.max(1, index + 1 - HALF_WINDOW);
    const end = Math.min(lines.length, index + 1 + HALF_WINDOW);
    if (taken.some(w => start <= w.end && end >= w.start)) continue;
    let score = 0;
    for (let i = start - 1; i < end; i++) score += lineScores[i];
    taken.push({ start, end, best: index + 1, score });
  }
  return taken.sort((a, b) => b.score - a.score || a.start - b.start);
}

function block(path: string, lines: string[], start: number, end: number): { text: string; id: string } {
  const body = lines.slice(start - 1, end).map(line => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} …[line truncated]` : line)).join('\n');
  const id = createHash('sha256').update(`${path}:${start}:${end}:${body}`).digest('hex').slice(0, 16);
  return { id, text: `\n--- ${JSON.stringify(path)}:${start}-${end} id=${id} ---\n${body}\n--- END SOURCE ---\n` };
}

export class Engine {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async context(query: string, budget = 3000): Promise<Pack> {
    const started = performance.now();
    if (!Number.isInteger(budget) || budget < 256 || budget > 32000) throw new Error('budget must be an integer from 256 to 32000');
    if (!query.trim()) throw new Error('query must not be empty');

    const searchable = (await rg(this.root, ['--files'])).length;
    const wanted = extractTerms(query);
    // One ripgrep call lists every file that contains at least one term (case-insensitively, so a
    // superset); the exact per-term presence that defines the IDF is then decided by substring tests.
    const matching = wanted.length ? await rg(this.root, ['--files-with-matches', '--fixed-strings', '--ignore-case', ...wanted.flatMap(t => ['-e', t.text])]) : [];
    const presence = await mapLimit(matching, READ_CONCURRENCY, async path => {
      try {
        const content = await readFile(join(this.root, path), 'utf8');
        return { path, present: termsPresent(content, wanted) };
      } catch {
        return { path, present: [] as boolean[] };
      }
    });
    const terms: Term[] = [];
    wanted.forEach((term, index) => {
      const files = new Set(presence.filter(entry => entry.present[index]).map(entry => entry.path));
      if (files.size) terms.push({ ...term, idf: Math.log(1 + searchable / files.size), files });
    });

    const fileScore = new Map<string, number>();
    for (const term of terms) for (const file of term.files) fileScore.set(file, (fileScore.get(file) ?? 0) + term.idf);
    const ranked = [...fileScore].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, MAX_FILES);

    const header = `RIPGREP-NAIVE | ${searchable.toLocaleString('en-US')} searchable files | ${terms.length} matching terms from the issue\nGrep-style line windows, best file first. Evidence excerpts only, not complete repository knowledge.\n`;
    const tail = '\n[Other source omitted.]';
    let text = header;
    const evidence: Pack['evidence'] = [];

    const candidates = await Promise.all(ranked.map(async ([path]) => {
      try {
        const info = await stat(join(this.root, path));
        if (!info.isFile() || info.size > MAX_FILE_BYTES) return { path, lines: [] as string[], windows: [] as Window[] };
        const content = await readFile(join(this.root, path), 'utf8');
        if (content.includes('\0')) return { path, lines: [] as string[], windows: [] as Window[] };
        const lines = content.split('\n');
        return { path, lines, windows: windowsFor(lines, terms.filter(t => t.files.has(path))) };
      } catch {
        return { path, lines: [] as string[], windows: [] as Window[] };
      }
    }));

    const fits = (candidate: string) => tokens(text + candidate + tail) <= budget;
    for (let round = 0; round < WINDOWS_PER_FILE; round++) {
      for (const { path, lines, windows } of candidates) {
        const window = windows[round];
        if (!window) continue;
        // Shrink around the best line until the block fits; skip the window if even three lines do not.
        for (const half of [HALF_WINDOW, 3, 1]) {
          const start = Math.max(window.start, window.best - half);
          const end = Math.min(window.end, window.best + half);
          const candidate = block(path, lines, start, end);
          if (fits(candidate.text)) {
            text += candidate.text;
            evidence.push({ path, start, end, id: candidate.id });
            break;
          }
        }
      }
    }
    if (!evidence.length) text += '\nNo matching evidence found.\n';
    text += tail;
    const outputTokens = tokens(text);
    return {
      text,
      evidence,
      stats: {
        tokenizer: 'o200k_base', inputTokens: 0, outputTokens, reduction: 0, selectedChunks: evidence.length, totalChunks: 0,
        files: searchable, elapsedMs: performance.now() - started, revision: 'ripgrep-naive', budget, terms: terms.length,
      },
    };
  }
}
