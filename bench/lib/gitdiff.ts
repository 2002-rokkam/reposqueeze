import { isTestPath } from './testfiles.js';

/** Inclusive one-based line range. */
export type LineRange = [number, number];

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /**
   * Pre-image lines this hunk edits: every removed line, plus (for pure insertions) the context
   * lines directly before and after the insertion point.
   */
  editRanges: LineRange[];
  removed: number;
  added: number;
}

export type FileChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied';

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  kind: FileChangeKind;
  binary: boolean;
  hunks: DiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const MAX_LINE = 2 ** 31;

const stripCr = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line);

/** Appends one line number (non-decreasing order) to a range list, extending the last range when adjacent. */
function addLine(ranges: LineRange[], line: number): void {
  const last = ranges[ranges.length - 1];
  if (last && line <= last[1] + 1 && line >= last[0]) {
    last[1] = Math.max(last[1], line);
  } else {
    ranges.push([line, line]);
  }
}

export function mergeRanges(input: LineRange[]): LineRange[] {
  const sorted = input.filter(([a, b]) => a >= 1 && b >= a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: LineRange[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function rangesLength(ranges: LineRange[]): number {
  return ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
}

/** Decodes a C-style quoted path as written by git for unusual file names. */
function unquoteC(quoted: string): string {
  const body = quoted.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = body[i + 1];
    if (next !== undefined && /[0-7]/.test(next)) {
      let digits = '';
      while (digits.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) digits += body[++i];
      bytes.push(parseInt(digits, 8) & 0xff);
    } else if (next !== undefined && next in simple) {
      bytes.push(simple[next]);
      i++;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Reads a quoted token starting at `start`; returns its decoded value and the index after it. */
function readQuoted(text: string, start: number): [string, number] | null {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return [unquoteC(text.slice(start, i + 1)), i + 1];
  }
  return null;
}

function stripPrefix(path: string, prefix: 'a/' | 'b/'): string {
  return path.startsWith(prefix) ? path.slice(2) : path;
}

/** Splits the remainder of a `diff --git` line into [old, new] paths (prefixes removed). */
function splitGitHeader(rest: string): [string, string] | null {
  let first: string;
  let after: number;
  if (rest.startsWith('"')) {
    const token = readQuoted(rest, 0);
    if (!token) return null;
    [first, after] = token;
    if (rest[after] === ' ') after++;
  } else if (rest.startsWith('a/')) {
    const half = (rest.length - 5) / 2; // 'a/' + p + ' b/' + p
    if (Number.isInteger(half) && half > 0 && rest.slice(2 + half, 5 + half) === ' b/' && rest.slice(2, 2 + half) === rest.slice(5 + half)) {
      return [rest.slice(2, 2 + half), rest.slice(5 + half)];
    }
    const split = rest.indexOf(' b/');
    if (split < 0) return null;
    first = rest.slice(0, split);
    after = split + 1;
  } else {
    return null;
  }
  const second = rest.slice(after);
  const secondPath = second.startsWith('"') ? (readQuoted(second, 0)?.[0] ?? second) : second;
  return [stripPrefix(first, 'a/'), stripPrefix(secondPath, 'b/')];
}

function parseHeaderPath(text: string, prefix: 'a/' | 'b/'): { path: string | null; devNull: boolean } {
  let value = text;
  if (value.startsWith('"')) value = readQuoted(value, 0)?.[0] ?? value;
  else value = value.replace(/\t.*$/, '').trimEnd(); // non-git diffs append "\t<timestamp>"
  if (value === '/dev/null') return { path: null, devNull: true };
  return { path: stripPrefix(value, prefix), devNull: false };
}

function parsePlainPath(text: string): string {
  return text.startsWith('"') ? (readQuoted(text, 0)?.[0] ?? text) : text.trimEnd();
}

function parseHunk(lines: string[], start: number): { hunk: DiffHunk; next: number } | null {
  const match = HUNK_RE.exec(stripCr(lines[start]));
  if (!match) return null;
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (![oldStart, oldCount, newStart, newCount].every(n => Number.isSafeInteger(n) && n < MAX_LINE)) return null;

  const ranges: LineRange[] = [];
  let removed = 0;
  let added = 0;
  let oldLine = oldCount === 0 ? oldStart + 1 : oldStart; // next pre-image line to be read
  let oldRemaining = oldCount;
  let newRemaining = newCount;
  // Pre-image line directly before the next change, when known (for "-a,0" hunks the header names it).
  let previousContext: number | null = oldCount === 0 && oldStart >= 1 ? oldStart : null;
  let blockOpen = false;
  let blockHasRemoval = false;
  let blockAnchorBefore: number | null = null;

  const closeBlock = (anchorAfter: number | null) => {
    if (!blockOpen) return;
    if (!blockHasRemoval) {
      if (blockAnchorBefore !== null) addLine(ranges, blockAnchorBefore);
      if (anchorAfter !== null) addLine(ranges, anchorAfter);
    }
    blockOpen = false;
    blockHasRemoval = false;
  };
  const openBlock = () => {
    if (blockOpen) return;
    blockOpen = true;
    blockAnchorBefore = previousContext;
  };

  let i = start + 1;
  for (; i < lines.length && (oldRemaining > 0 || newRemaining > 0); i++) {
    const raw = lines[i];
    const marker = raw[0];
    if (marker === '\\') continue; // "\ No newline at end of file"
    if (marker === ' ' || (raw === '' && i < lines.length - 1)) {
      closeBlock(oldLine);
      previousContext = oldLine;
      oldLine++;
      oldRemaining--;
      newRemaining--;
    } else if (marker === '-') {
      openBlock();
      blockHasRemoval = true;
      addLine(ranges, oldLine);
      oldLine++;
      oldRemaining--;
      removed++;
      previousContext = null;
    } else if (marker === '+') {
      openBlock();
      added++;
      newRemaining--;
      previousContext = null;
    } else {
      break; // not a hunk line: the counts in the header were wrong, resynchronise
    }
  }
  closeBlock(null);
  return { hunk: { oldStart, oldCount, newStart, newCount, editRanges: ranges, removed, added }, next: i };
}

/** Parses git-style (and plain) unified diffs. Never throws; unknown lines are ignored. */
export function parseUnifiedDiff(patch: string): FileDiff[] {
  const lines = patch.split('\n');
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let headerOpen = false;
  const fresh = (): FileDiff => {
    const file: FileDiff = { oldPath: null, newPath: null, kind: 'modified', binary: false, hunks: [] };
    files.push(file);
    return file;
  };

  let i = 0;
  while (i < lines.length) {
    const line = stripCr(lines[i]);
    if (line.startsWith('diff --git ')) {
      current = fresh();
      const paths = splitGitHeader(line.slice('diff --git '.length));
      if (paths) [current.oldPath, current.newPath] = paths;
      headerOpen = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && stripCr(lines[i + 1]).startsWith('+++ ')) {
      if (!current || !headerOpen || current.hunks.length) current = fresh();
      headerOpen = true;
      const oldHeader = parseHeaderPath(line.slice(4), 'a/');
      const newHeader = parseHeaderPath(stripCr(lines[i + 1]).slice(4), 'b/');
      current.oldPath = oldHeader.path;
      current.newPath = newHeader.path;
      if (oldHeader.devNull) current.kind = 'added';
      else if (newHeader.devNull) current.kind = 'deleted';
      i += 2;
      continue;
    }
    if (line.startsWith('@@ ') && current) {
      const parsed = parseHunk(lines, i);
      if (parsed) {
        current.hunks.push(parsed.hunk);
        headerOpen = false;
        i = parsed.next;
        continue;
      }
    } else if (current && headerOpen && !current.hunks.length) {
      if (line.startsWith('new file mode')) {
        current.kind = 'added';
        current.oldPath = null;
      } else if (line.startsWith('deleted file mode')) {
        current.kind = 'deleted';
        current.newPath = null;
      } else if (line.startsWith('rename from ')) {
        current.kind = 'renamed';
        current.oldPath = parsePlainPath(line.slice('rename from '.length));
      } else if (line.startsWith('rename to ')) {
        current.kind = 'renamed';
        current.newPath = parsePlainPath(line.slice('rename to '.length));
      } else if (line.startsWith('copy from ')) {
        current.kind = 'copied';
        current.oldPath = parsePlainPath(line.slice('copy from '.length));
      } else if (line.startsWith('copy to ')) {
        current.kind = 'copied';
        current.newPath = parsePlainPath(line.slice('copy to '.length));
      } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        current.binary = true;
      }
    }
    i++;
  }
  return files;
}

export type SkipReason = 'new_file' | 'test_file' | 'binary' | 'no_content_change';

export interface GoldFile {
  /** Path in the base commit (the pre-image); this is what a retriever must find. */
  path: string;
  /** Post-image path when the patch renames the file. */
  newPath: string | null;
  status: 'modified' | 'renamed' | 'deleted';
  /** Merged pre-image line ranges the patch edits (see DiffHunk.editRanges). */
  ranges: LineRange[];
  lineCount: number;
}

export interface GoldDerivation {
  gold: GoldFile[];
  skipped: { path: string; reason: SkipReason }[];
}

/**
 * Gold = files that exist in the base commit and whose content the patch edits, minus test files.
 * New files cannot be retrieved from the base commit and are skipped.
 */
export function goldFromDiff(files: FileDiff[], isTest: (path: string) => boolean = isTestPath): GoldDerivation {
  const byPath = new Map<string, GoldFile>();
  const skipped: GoldDerivation['skipped'] = [];
  for (const file of files) {
    const path = file.oldPath ?? file.newPath;
    if (!path) continue;
    if (file.kind === 'added' || file.kind === 'copied' || file.oldPath === null) {
      skipped.push({ path, reason: 'new_file' });
      continue;
    }
    if (isTest(file.oldPath)) {
      skipped.push({ path: file.oldPath, reason: 'test_file' });
      continue;
    }
    if (file.binary) {
      skipped.push({ path: file.oldPath, reason: 'binary' });
      continue;
    }
    const ranges = mergeRanges(file.hunks.flatMap(hunk => hunk.editRanges));
    if (!ranges.length) {
      skipped.push({ path: file.oldPath, reason: 'no_content_change' });
      continue;
    }
    const existing = byPath.get(file.oldPath);
    const merged = mergeRanges([...(existing?.ranges ?? []), ...ranges]);
    byPath.set(file.oldPath, {
      path: file.oldPath,
      newPath: file.kind === 'renamed' ? file.newPath : null,
      status: file.kind === 'renamed' ? 'renamed' : file.kind === 'deleted' ? 'deleted' : 'modified',
      ranges: merged,
      lineCount: rangesLength(merged),
    });
  }
  return { gold: [...byPath.values()], skipped };
}
