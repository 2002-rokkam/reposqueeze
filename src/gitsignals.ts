/**
 * Version-history signals for ranking: how recently a file changed, how often it changed, which files
 * change together, and what the developer is editing right now.
 *
 * Everything comes from one streaming `git log` pass plus one `git status`, both strictly read-only:
 *  - git runs with --no-optional-locks / GIT_OPTIONAL_LOCKS=0, so no index refresh is ever written;
 *  - the repository's own config is neutralised where it could execute code (core.fsmonitor,
 *    core.hooksPath, textconv / external diff, signature verification) or reach the network
 *    (protocol.allow=never, GIT_NO_LAZY_FETCH). The user's and system config stay in effect because
 *    they are trusted and may carry safe.directory entries;
 *  - GIT_DIR, GIT_WORK_TREE and friends are removed from the environment so `root` alone decides which
 *    repository is read.
 * One residual: like any `git status`, a clean filter that the repository's own config defines may run for
 * tracked files whose stat data changed. Do not point this at repositories you do not trust.
 *
 * Determinism: results depend only on the commit graph and the working tree. All times are commit
 * timestamps (epoch seconds), and ages are measured from HEAD's commit date, never from the wall clock.
 * The only clock in this file is the monotonic one that enforces `timeoutMs`; it can only truncate.
 *
 * Signals ignore commits that are not informative: merge commits, empty commits, commits touching more than
 * `maxFilesPerCommit` files (mass renames, formatting, dependency bumps) and, in shallow clones, the
 * boundary commits whose diff is reported against an empty tree.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

export interface GitSignalsOptions {
  /** Most recent non-merge commits read from HEAD (one more is peeked to detect truncation). Default 2000. */
  maxCommits?: number;
  /** Commits touching more files than this are ignored by every signal. Default 40. */
  maxFilesPerCommit?: number;
  /** Total time budget for all git processes in milliseconds. Default 15000. */
  timeoutMs?: number;
  /** Directory for a persisted history index keyed by HEAD, root prefix and options. Nothing is cached without it. */
  cacheDir?: string;
  /** git executable. Default `git` from PATH. */
  gitBinary?: string;
  /** @internal Lowers the built-in safety caps so tests can reach them cheaply. */
  limits?: { logBytes?: number; incidences?: number; dirtyPaths?: number };
}

export interface CoChange {
  path: string;
  /** support / (churn(a) + churn(b) - support), in (0, 1]. */
  weight: number;
  /** Number of analysed commits that touched both files. */
  support: number;
}

export type GitTruncation = 'maxCommits' | 'timeout' | 'limit' | 'error';

export interface GitSignals {
  /** False for non-git directories, empty and bare repositories, a missing git and any error. Never throws. */
  available: boolean;
  /** Why the signals are unavailable. */
  reason?: string;
  /** Full object name of HEAD. */
  head?: string;
  /** The repository is a shallow clone: older history is missing, boundary commits are ignored. */
  shallow: boolean;
  /** Older history or part of the results was not analysed; see `truncatedBy`. */
  truncated: boolean;
  /** Commits that contributed to the signals (excludes ignored mass, empty, merge and boundary commits). */
  commitsAnalysed: number;
  /** Days from HEAD's commit date to the newest analysed commit touching `path`; Infinity when unknown. */
  ageDays(path: string): number;
  /** Number of analysed commits touching `path`. */
  churn(path: string): number;
  /** Modified, staged, deleted, renamed or untracked-and-not-ignored paths, relative to `root`. */
  dirty: ReadonlySet<string>;
  /**
   * Top-k files most often changed together with `path` (default k = 10), strongest first, ties by path.
   * Files whose newest analysed commit deleted them are left out.
   */
  coChanged(path: string, k?: number): CoChange[];

  truncatedBy?: GitTruncation;
  /** Commits read but ignored: mass, empty and shallow-boundary commits. */
  commitsIgnored?: number;
  /** Committer date of HEAD in epoch seconds, the reference point of `ageDays`. */
  headTime?: number;
  /** Non-fatal problems such as a timed-out `git status`. */
  warnings?: readonly string[];
  /** The history came from `cacheDir` instead of `git log`. */
  fromCache?: boolean;
}

const DEFAULT_MAX_COMMITS = 2000;
const MAX_MAX_COMMITS = 1_000_000;
const DEFAULT_MAX_FILES_PER_COMMIT = 40;
const MAX_MAX_FILES_PER_COMMIT = 10_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_PARTNERS = 10;
const SECONDS_PER_DAY = 86_400;

/** A path longer than this cannot exist in a working tree; the token is skipped and parsing stays in sync. */
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_STATUS_BYTES = 128 * 1024 * 1024;
const MAX_SMALL_OUTPUT_BYTES = 1024 * 1024;

interface SafetyLimits {
  /** Bytes of `git log` output read before giving up. */
  logBytes: number;
  /** (commit, file) pairs kept in memory; bounds both memory and the cost of one coChanged() query. */
  incidences: number;
  /** Paths kept in the dirty set. */
  dirtyPaths: number;
}

const DEFAULT_LIMITS: SafetyLimits = { logBytes: 512 * 1024 * 1024, incidences: 8_000_000, dirtyPaths: 100_000 };

const CACHE_VERSION = 1;
const CACHE_FORMAT = 'reposqueeze-gitsignals';
const CACHE_FILE = /^gitsig-[0-9a-f]{32}\.json\.gz$/;
const CACHE_MAX_FILES = 64;
const CACHE_MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const CACHE_MAX_JSON_BYTES = 64 * 1024 * 1024;
const CACHE_MAX_INCIDENCES = 2_000_000;

const HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9]{1,20})$/;
const STATUS_LETTER = /^[A-Z][0-9]{0,3}$/;
const OBJECT_NAME = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// ---------------------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------------------

/** Per-commit file lists in compressed-sparse-row form plus per-path facts; the whole cached/in-memory index. */
interface HistoryData {
  paths: string[];
  /** Newest committer time per path, epoch seconds. */
  newest: Float64Array;
  churn: Uint32Array;
  /** 1 when the newest analysed commit touching the path deleted it. */
  dead: Uint8Array;
  /** Commit c touched items[starts[c] .. starts[c + 1]). */
  starts: Uint32Array;
  items: Uint32Array;
}

const EMPTY_HISTORY: HistoryData = {
  paths: [],
  newest: new Float64Array(0),
  churn: new Uint32Array(0),
  dead: new Uint8Array(0),
  starts: new Uint32Array(1),
  items: new Uint32Array(0),
};

class HistoryIndex {
  private readonly ids: Map<string, number>;
  private inverted?: { offsets: Uint32Array; commits: Uint32Array };
  private tally?: Uint32Array;

  constructor(readonly data: HistoryData, ids?: Map<string, number>) {
    this.ids = ids ?? new Map(data.paths.map((path, id) => [path, id]));
  }

  get commitCount(): number {
    return this.data.starts.length - 1;
  }

  newest(path: string): number | undefined {
    const id = this.ids.get(path);
    return id === undefined ? undefined : this.data.newest[id];
  }

  churn(path: string): number {
    const id = this.ids.get(path);
    return id === undefined ? 0 : this.data.churn[id];
  }

  latest(): number {
    let latest = 0;
    for (const time of this.data.newest) if (time > latest) latest = time;
    return latest;
  }

  /** Co-change is computed on demand from the commit lists, so no pair table ever has to be stored. */
  coChanged(path: string, limit: number): CoChange[] {
    const id = this.ids.get(path);
    if (id === undefined || limit <= 0) return [];
    const { data } = this;
    const { offsets, commits } = this.invertedIndex();
    const tally = (this.tally ??= new Uint32Array(data.paths.length));
    const touched: number[] = [];
    for (let at = offsets[id]; at < offsets[id + 1]; at++) {
      const commit = commits[at];
      for (let item = data.starts[commit]; item < data.starts[commit + 1]; item++) {
        const other = data.items[item];
        if (other !== id && tally[other]++ === 0) touched.push(other);
      }
    }
    const result: CoChange[] = [];
    for (const other of touched) {
      const support = tally[other];
      tally[other] = 0;
      if (data.dead[other]) continue;
      const weight = support / (data.churn[id] + data.churn[other] - support);
      result.push({ path: data.paths[other], weight, support });
    }
    result.sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return result.length > limit ? result.slice(0, limit) : result;
  }

  /** path -> commits touching it, built once by counting sort. */
  private invertedIndex(): { offsets: Uint32Array; commits: Uint32Array } {
    if (this.inverted) return this.inverted;
    const { paths, starts, items } = this.data;
    const offsets = new Uint32Array(paths.length + 1);
    for (const id of items) offsets[id + 1]++;
    for (let id = 0; id < paths.length; id++) offsets[id + 1] += offsets[id];
    const cursor = offsets.slice(0, paths.length);
    const commits = new Uint32Array(items.length);
    for (let commit = 0; commit + 1 < starts.length; commit++) {
      for (let item = starts[commit]; item < starts[commit + 1]; item++) commits[cursor[items[item]]++] = commit;
    }
    return (this.inverted = { offsets, commits });
  }
}

interface SignalParts {
  available: boolean;
  reason?: string;
  head?: string;
  headTime?: number;
  shallow: boolean;
  truncatedBy?: GitTruncation;
  ignored: number;
  index: HistoryIndex;
  dirty: ReadonlySet<string>;
  warnings: string[];
  fromCache: boolean;
}

class GitSignalsResult implements GitSignals {
  readonly available: boolean;
  readonly reason?: string;
  readonly head?: string;
  readonly shallow: boolean;
  readonly truncated: boolean;
  readonly truncatedBy?: GitTruncation;
  readonly commitsAnalysed: number;
  readonly commitsIgnored: number;
  readonly headTime?: number;
  readonly dirty: ReadonlySet<string>;
  readonly warnings: readonly string[];
  readonly fromCache: boolean;
  private readonly index: HistoryIndex;
  private readonly reference: number;

  constructor(parts: SignalParts) {
    this.available = parts.available;
    this.reason = parts.reason;
    this.head = parts.head;
    this.headTime = parts.headTime;
    this.shallow = parts.shallow;
    this.truncated = parts.truncatedBy !== undefined;
    this.truncatedBy = parts.truncatedBy;
    this.commitsAnalysed = parts.index.commitCount;
    this.commitsIgnored = parts.ignored;
    this.dirty = parts.dirty;
    this.warnings = parts.warnings;
    this.fromCache = parts.fromCache;
    this.index = parts.index;
    this.reference = parts.headTime !== undefined ? parts.headTime : parts.index.latest();
  }

  ageDays(path: string): number {
    const newest = this.index.newest(path);
    if (newest === undefined) return Infinity;
    return Math.max(0, (this.reference - newest) / SECONDS_PER_DAY);
  }

  churn(path: string): number {
    return this.index.churn(path);
  }

  coChanged(path: string, k: number = DEFAULT_PARTNERS): CoChange[] {
    const limit = typeof k === 'number' && !Number.isNaN(k) ? Math.floor(k) : DEFAULT_PARTNERS;
    return this.index.coChanged(path, limit);
  }
}

function unavailable(reason: string): GitSignals {
  return new GitSignalsResult({
    available: false,
    reason,
    shallow: false,
    ignored: 0,
    index: new HistoryIndex(EMPTY_HISTORY),
    dirty: new Set(),
    warnings: [],
    fromCache: false,
  });
}

// ---------------------------------------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------------------------------------

/** Variables that would redirect git to another repository, change pathspec semantics or write trace files. */
const STRIPPED_VARIABLES = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_QUARANTINE_PATH', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS',
  'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS', 'GIT_PAGER',
]);

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const stripped = STRIPPED_VARIABLES.has(name) || name.startsWith('GIT_TRACE');
    if (value !== undefined && !stripped) env[name] = value;
  }
  return Object.assign(env, {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
  });
}

/**
 * Command-line config outranks the repository's own config. Each override either removes a way for the
 * repository to execute code or reach the network, or pins output-shaping options the parser relies on.
 */
const GIT_PREAMBLE = [
  '--no-pager',
  '--no-optional-locks',
  '--no-replace-objects',
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${devNull}`,
  '-c', 'core.quotepath=off',
  '-c', 'protocol.allow=never',
  '-c', 'log.showSignature=false',
  '-c', 'log.showRoot=true',
  '-c', 'log.follow=false',
  '-c', 'diff.relative=false',
  '-c', 'diff.renames=false',
  '-c', 'status.renames=false',
  '-c', 'color.ui=false',
];

interface GitContext {
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** performance.now() value after which every process is killed. */
  deadline: number;
}

interface GitRun {
  code: number | null;
  stderr: string;
  error?: NodeJS.ErrnoException;
  timedOut: boolean;
  /** The data callback asked to stop and git was killed on purpose. */
  stopped: boolean;
}

/** Runs git, feeding stdout to `onData` (return false to stop). Never rejects; always reaps the process. */
function runGit(git: GitContext, args: readonly string[], onData: (chunk: Buffer) => boolean): Promise<GitRun> {
  return new Promise(finish => {
    const budget = git.deadline - performance.now();
    if (budget <= 0) {
      finish({ code: null, stderr: '', timedOut: true, stopped: false });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(git.binary, [...GIT_PREAMBLE, ...args], {
        cwd: git.cwd,
        env: git.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish({ code: null, stderr: '', error: error as NodeJS.ErrnoException, timedOut: false, stopped: false });
      return;
    }

    let stderr = '';
    let timedOut = false;
    let stopped = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const settle = (code: number | null, error?: NodeJS.ErrnoException): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ code, stderr, error, timedOut, stopped });
    };
    const kill = (): void => {
      child.kill('SIGKILL');
      // A grandchild may keep the pipes open after git died; do not wait for it.
      killTimer = setTimeout(() => settle(null), 250);
      killTimer.unref();
    };
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      kill();
    }, budget);
    deadlineTimer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stopped || timedOut) return;
      let proceed = false;
      try {
        proceed = onData(chunk);
      } catch {
        proceed = false;
      }
      if (!proceed) {
        stopped = true;
        kill();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);
    child.on('error', error => settle(null, error));
    child.on('exit', code => {
      if (stopped || timedOut) settle(code);
    });
    child.on('close', code => settle(code));
  });
}

async function collect(git: GitContext, args: readonly string[]): Promise<{ run: GitRun; stdout: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  const run = await runGit(git, args, chunk => {
    size += chunk.length;
    if (size > MAX_SMALL_OUTPUT_BYTES) return false;
    chunks.push(chunk);
    return true;
  });
  return { run, stdout: Buffer.concat(chunks).toString('utf8') };
}

function describeFailure(git: GitContext, run: GitRun): string {
  if (run.error) {
    if (run.error.code === 'ENOENT') return `git executable not found: ${git.binary}`;
    return `cannot run git: ${run.error.message}`;
  }
  if (run.timedOut) return 'timed out waiting for git';
  const detail = firstLine(run.stderr).replace(/^fatal: /, '');
  if (/not a git repository/i.test(detail)) return 'not a git repository';
  return `git exited with code ${run.code}${detail ? `: ${detail}` : ''}`;
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim().slice(0, 200);
}

// ---------------------------------------------------------------------------------------------------------
// Streaming parsers
// ---------------------------------------------------------------------------------------------------------

/**
 * Splits a byte stream on NUL without ever holding more than one token. Multi-byte characters are decoded
 * only after the whole token arrived, so chunk boundaries cannot corrupt them. A token longer than
 * MAX_TOKEN_BYTES is delivered as `null` so that parsers stay in sync.
 */
class NulTokenizer {
  private pending: Buffer | null = null;
  private skipping = false;

  constructor(private readonly sink: (token: string | null) => boolean) {}

  write(chunk: Buffer): boolean {
    const data = this.pending ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = null;
    let start = 0;
    for (;;) {
      const end = data.indexOf(0, start);
      if (end === -1) break;
      const oversized = this.skipping || end - start > MAX_TOKEN_BYTES;
      this.skipping = false;
      if (!this.sink(oversized ? null : data.toString('utf8', start, end))) return false;
      start = end + 1;
    }
    const rest = data.length - start;
    if (this.skipping || rest > MAX_TOKEN_BYTES) this.skipping = true;
    else if (rest > 0) this.pending = Buffer.from(data.subarray(start));
    return true;
  }

  /** The unterminated token at end of input: undefined when none. */
  tail(): string | null | undefined {
    if (this.skipping) return null;
    return this.pending ? this.pending.toString('utf8') : undefined;
  }
}

function relativeTo(prefix: string, path: string): string | null {
  if (prefix === '') return path;
  return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : null;
}

interface RawCommit {
  oid: string;
  time: number;
  paths: string[];
  deleted: boolean[];
  /** Number of files the commit touched, counted beyond the stored ones. */
  total: number;
}

/**
 * `git log -z --name-status --pretty=format:'%H %ct'` frames each commit as
 *   header '\n' (STATUS NUL PATH NUL)*     and separates commits by NUL;
 * a commit without changes is just the header. Split on NUL this becomes: the header token (possibly
 * carrying the first status letter after its newline), then path/status tokens, and an empty token that
 * ends a commit. Structure is decided by position only, so no file name can be mistaken for a header.
 */
class LogParser {
  private state: 'header' | 'status' | 'path' | 'origin' = 'header';
  private commit: RawCommit | null = null;
  private status = '';
  private started = 0;
  windowExceeded = false;
  failure: string | null = null;

  constructor(
    private readonly history: HistoryBuilder,
    private readonly prefix: string,
    private readonly maxCommits: number,
    private readonly boundary: ReadonlySet<string>,
  ) {}

  /** Consumes one token; false stops the stream. */
  token(token: string | null): boolean {
    switch (this.state) {
      case 'header':
        return this.header(token);
      case 'status':
        if (token === '') {
          this.state = 'header';
          return this.close();
        }
        return this.statusLetter(token);
      case 'origin':
        this.state = 'path';
        return true;
      case 'path':
        this.entry(token);
        this.state = 'status';
        return true;
    }
  }

  /** Ends the stream. `clean` means git exited normally, so a trailing complete record is valid. */
  finish(clean: boolean, tail: string | null | undefined): void {
    if (clean && this.state === 'header' && typeof tail === 'string' && tail !== '') {
      this.header(tail);
    } else if (clean && this.state === 'status' && tail === undefined) {
      this.close();
    }
    this.commit = null;
  }

  private header(token: string | null): boolean {
    if (token === null) return this.fail('oversized log header');
    const newline = token.indexOf('\n');
    const text = newline === -1 ? token : token.slice(0, newline);
    const match = text.length <= 130 ? HEADER.exec(text) : null;
    if (!match) return this.fail('unrecognised git log output');
    if (this.started === this.maxCommits) {
      this.windowExceeded = true;
      return false;
    }
    this.started++;
    const time = Number(match[2]);
    this.commit = { oid: match[1], time: Number.isSafeInteger(time) ? time : 0, paths: [], deleted: [], total: 0 };
    if (newline === -1) return this.close();
    const first = token.slice(newline + 1);
    if (first === '') return this.close();
    return this.statusLetter(first);
  }

  private statusLetter(token: string | null): boolean {
    if (token === null || !STATUS_LETTER.test(token)) return this.fail('unrecognised git log output');
    this.status = token;
    this.state = token[0] === 'R' || token[0] === 'C' ? 'origin' : 'path';
    return true;
  }

  private entry(path: string | null): void {
    const commit = this.commit;
    if (!commit || path === null) return;
    const relative = relativeTo(this.prefix, path);
    if (relative === null) return;
    commit.total++;
    if (commit.paths.length < this.history.maxFiles) {
      commit.paths.push(relative);
      commit.deleted.push(this.status[0] === 'D');
    }
  }

  private close(): boolean {
    const commit = this.commit;
    this.commit = null;
    return commit ? this.history.add(commit, this.boundary.has(commit.oid)) : true;
  }

  private fail(message: string): boolean {
    this.failure ??= message;
    return false;
  }
}

/** Accumulates analysed commits into the structures of HistoryData. */
class HistoryBuilder {
  readonly ids = new Map<string, number>();
  private readonly paths: string[] = [];
  private readonly newest: number[] = [];
  private readonly churn: number[] = [];
  private readonly dead: number[] = [];
  private readonly lastCommit: number[] = [];
  private readonly starts: number[] = [0];
  private items = new Uint32Array(1024);
  private itemCount = 0;
  ignored = 0;
  capped = false;

  constructor(readonly maxFiles: number, private readonly maxIncidences: number) {}

  /** Returns false once the incidence cap is hit. */
  add(commit: RawCommit, boundary: boolean): boolean {
    if (boundary || commit.total === 0 || commit.total > this.maxFiles) {
      this.ignored++;
      return true;
    }
    if (this.itemCount + commit.paths.length > this.maxIncidences) {
      this.capped = true;
      return false;
    }
    const commitIndex = this.starts.length - 1;
    for (let i = 0; i < commit.paths.length; i++) {
      const path = commit.paths[i];
      let id = this.ids.get(path);
      if (id === undefined) {
        id = this.paths.length;
        this.ids.set(path, id);
        this.paths.push(path);
        this.newest.push(-1);
        this.churn.push(0);
        // Commits arrive newest first, so the first sighting says whether the file survives.
        this.dead.push(commit.deleted[i] ? 1 : 0);
        this.lastCommit.push(-1);
      }
      if (this.lastCommit[id] === commitIndex) continue;
      this.lastCommit[id] = commitIndex;
      this.churn[id]++;
      if (commit.time > this.newest[id]) this.newest[id] = commit.time;
      this.push(id);
    }
    this.starts.push(this.itemCount);
    return true;
  }

  build(): HistoryData {
    return {
      paths: this.paths,
      newest: Float64Array.from(this.newest),
      churn: Uint32Array.from(this.churn),
      dead: Uint8Array.from(this.dead),
      starts: Uint32Array.from(this.starts),
      items: this.items.slice(0, this.itemCount),
    };
  }

  private push(id: number): void {
    if (this.itemCount === this.items.length) {
      const grown = new Uint32Array(this.items.length * 2);
      grown.set(this.items);
      this.items = grown;
    }
    this.items[this.itemCount++] = id;
  }
}

/** `git status --porcelain=v1 -z`: `XY path` entries; renames and copies are followed by the origin path. */
class StatusParser {
  private expectOrigin = false;
  overflowed = false;

  constructor(
    private readonly prefix: string,
    private readonly dirty: Set<string>,
    private readonly maxPaths: number,
  ) {}

  token(token: string | null): boolean {
    if (token === null) {
      this.expectOrigin = false;
      return true;
    }
    if (this.expectOrigin) {
      this.expectOrigin = false;
      return this.add(token);
    }
    if (token.length < 4 || token[2] !== ' ' || token[0] === '!') return true;
    if ('RC'.includes(token[0]) || 'RC'.includes(token[1])) this.expectOrigin = true;
    return this.add(token.slice(3));
  }

  private add(path: string): boolean {
    // A trailing slash marks a nested repository or collapsed directory, never a file.
    if (path.endsWith('/')) return true;
    const relative = relativeTo(this.prefix, path);
    if (relative === null) return true;
    if (this.dirty.size >= this.maxPaths) {
      this.overflowed = true;
      return false;
    }
    this.dirty.add(relative);
    return true;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Reading the repository
// ---------------------------------------------------------------------------------------------------------

type Step<T> = { ok: true; value: T } | { ok: false; reason: string };

interface Layout {
  shallow: boolean;
  /** Path of `root` below the repository's top level, with trailing slash; empty at the top. */
  prefix: string;
}

interface Head {
  oid: string;
  time: number;
}

async function readLayout(git: GitContext): Promise<Step<Layout>> {
  const { run, stdout } = await collect(git, [
    'rev-parse', '--is-inside-work-tree', '--is-bare-repository', '--is-shallow-repository', '--show-prefix',
  ]);
  if (run.error || run.timedOut || run.code !== 0) return { ok: false, reason: describeFailure(git, run) };
  // The prefix is last because it is the only value that may itself contain line breaks.
  const lines = stdout.split('\n');
  const [inside, bare, shallow] = lines;
  const isFlag = (value: string | undefined): boolean => value === 'true' || value === 'false';
  if (lines.length < 5 || !isFlag(inside) || !isFlag(bare) || !isFlag(shallow)) {
    return { ok: false, reason: 'unexpected git rev-parse output (git 2.15 or newer is required)' };
  }
  if (inside !== 'true') {
    const reason = bare === 'true' ? 'bare repository has no working tree' : 'root is not inside a git working tree';
    return { ok: false, reason };
  }
  return { ok: true, value: { shallow: shallow === 'true', prefix: lines.slice(3).join('\n').replace(/\n$/, '') } };
}

async function readHead(git: GitContext): Promise<Step<Head>> {
  const { run, stdout } = await collect(git, ['log', '-n', '1', '--format=%H %ct', 'HEAD', '--']);
  if (run.error || run.timedOut) return { ok: false, reason: describeFailure(git, run) };
  const match = run.code === 0 ? HEADER.exec(stdout.trim()) : null;
  if (!match) return { ok: false, reason: 'repository has no commits' };
  const time = Number(match[2]);
  return { ok: true, value: { oid: match[1], time: Number.isSafeInteger(time) ? time : 0 } };
}

/** Commits listed in `.git/shallow`: their parents were cut off, so their diff is against an empty tree. */
async function readShallowBoundary(git: GitContext): Promise<string[] | null> {
  const { run, stdout } = await collect(git, ['rev-parse', '--git-path', 'shallow']);
  const location = stdout.replace(/\n$/, '');
  if (run.error || run.timedOut || run.code !== 0 || location === '') return null;
  try {
    const file = resolve(git.cwd, location);
    if ((await stat(file)).size > 16 * 1024 * 1024) return null;
    return (await readFile(file, 'utf8')).split('\n').map(line => line.trim()).filter(line => OBJECT_NAME.test(line));
  } catch {
    return null;
  }
}

interface HistoryResult {
  data: HistoryData;
  ids: Map<string, number>;
  ignored: number;
  truncatedBy?: GitTruncation;
  warnings: string[];
}

async function readHistory(
  git: GitContext,
  prefix: string,
  maxCommits: number,
  maxFiles: number,
  boundary: ReadonlySet<string>,
  limits: SafetyLimits,
): Promise<HistoryResult> {
  const history = new HistoryBuilder(maxFiles, limits.incidences);
  const parser = new LogParser(history, prefix, maxCommits, boundary);
  const tokens = new NulTokenizer(token => parser.token(token));
  let bytes = 0;
  let oversizedOutput = false;
  const args = [
    'log', '-z', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-merges', '--name-status',
    '--pretty=format:%H %ct', `--max-count=${maxCommits + 1}`,
    // Without full history a pathspec lets git prune side branches, which would make subtree results
    // differ from whole-repository ones.
    ...(prefix === '' ? [] : ['--full-history']),
    'HEAD', '--', ...(prefix === '' ? [] : ['.']),
  ];
  const run = await runGit(git, args, chunk => {
    bytes += chunk.length;
    if (bytes > limits.logBytes) {
      oversizedOutput = true;
      return false;
    }
    return tokens.write(chunk);
  });

  const clean = run.code === 0 && !run.timedOut && !run.stopped && !run.error;
  parser.finish(clean, tokens.tail());

  const warnings: string[] = [];
  let truncatedBy: GitTruncation | undefined;
  if (parser.windowExceeded) {
    truncatedBy = 'maxCommits';
  } else if (run.timedOut) {
    truncatedBy = 'timeout';
    warnings.push('git log timed out; history is partial');
  } else if (history.capped || oversizedOutput) {
    truncatedBy = 'limit';
    warnings.push('history size limit reached; history is partial');
  } else if (parser.failure) {
    truncatedBy = 'error';
    warnings.push(`git log: ${parser.failure}`);
  } else if (!clean) {
    truncatedBy = 'error';
    warnings.push(`git log failed: ${describeFailure(git, run)}`);
  }
  return { data: history.build(), ids: history.ids, ignored: history.ignored, truncatedBy, warnings };
}

async function readDirty(
  git: GitContext,
  prefix: string,
  maxPaths: number,
): Promise<{ dirty: Set<string>; warnings: string[] }> {
  const dirty = new Set<string>();
  const parser = new StatusParser(prefix, dirty, maxPaths);
  const tokens = new NulTokenizer(token => parser.token(token));
  let bytes = 0;
  const run = await runGit(
    git,
    [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all',
      ...(prefix === '' ? [] : ['--', '.']),
    ],
    chunk => {
      bytes += chunk.length;
      return bytes <= MAX_STATUS_BYTES && tokens.write(chunk);
    },
  );
  const warnings: string[] = [];
  if (parser.overflowed || bytes > MAX_STATUS_BYTES) {
    warnings.push('dirty set size limit reached; dirty set is partial');
  } else if (run.timedOut) {
    warnings.push('git status timed out; dirty set is partial');
  } else if (run.error || run.code !== 0) {
    warnings.push(`git status failed: ${describeFailure(git, run)}`);
  }
  return { dirty, warnings };
}

// ---------------------------------------------------------------------------------------------------------
// Persisted index
// ---------------------------------------------------------------------------------------------------------

interface CacheFile {
  format: typeof CACHE_FORMAT;
  version: number;
  key: string;
  head: string;
  windowExceeded: boolean;
  ignored: number;
  paths: string[];
  newest: number[];
  dead: number[];
  starts: number[];
  items: number[];
}

function cacheKey(
  head: string,
  prefix: string,
  maxCommits: number,
  maxFiles: number,
  boundary: readonly string[],
): string {
  const canonical = JSON.stringify([CACHE_VERSION, head, prefix, maxCommits, maxFiles, [...boundary].sort()]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function isCount(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

/** Returns null for anything that is not exactly what writeCache produced for this key. */
function validateCache(value: unknown, key: string, head: string): HistoryResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const file = value as Partial<CacheFile>;
  const sameEntry = file.format === CACHE_FORMAT && file.version === CACHE_VERSION && file.key === key && file.head === head;
  if (!sameEntry) return null;
  const { paths, newest, dead, starts, items } = file;
  if (
    !Array.isArray(paths) || !Array.isArray(newest) || !Array.isArray(dead) ||
    !Array.isArray(starts) || !Array.isArray(items)
  ) {
    return null;
  }
  if (typeof file.windowExceeded !== 'boolean' || !isCount(file.ignored)) return null;
  if (newest.length !== paths.length || starts.length < 1 || items.length > CACHE_MAX_INCIDENCES) return null;
  if (starts[0] !== 0 || starts[starts.length - 1] !== items.length) return null;

  const ids = new Map<string, number>();
  for (let id = 0; id < paths.length; id++) {
    const path = paths[id];
    const validPath = typeof path === 'string' && path !== '' && path.length <= MAX_TOKEN_BYTES && !ids.has(path);
    if (!validPath || !isCount(newest[id])) return null;
    ids.set(path, id);
  }
  for (let commit = 1; commit < starts.length; commit++) {
    if (!isCount(starts[commit], items.length) || starts[commit] < starts[commit - 1]) return null;
  }
  const churn = new Uint32Array(paths.length);
  for (const id of items) {
    if (!isCount(id, paths.length - 1)) return null;
    churn[id]++;
  }
  const deadFlags = new Uint8Array(paths.length);
  for (const id of dead) {
    if (!isCount(id, paths.length - 1)) return null;
    deadFlags[id] = 1;
  }
  const data: HistoryData = {
    paths,
    newest: Float64Array.from(newest),
    churn,
    dead: deadFlags,
    starts: Uint32Array.from(starts),
    items: Uint32Array.from(items),
  };
  const truncatedBy = file.windowExceeded ? 'maxCommits' : undefined;
  return { data, ids, ignored: file.ignored, truncatedBy, warnings: [] };
}

/** Best effort: a missing, foreign, symlinked, oversized or corrupt cache file is simply a miss. */
async function readCache(dir: string, key: string, head: string): Promise<HistoryResult | null> {
  const path = join(dir, `gitsig-${key}.json.gz`);
  let handle: FileHandle | undefined;
  try {
    // O_NOFOLLOW makes a symlink in place of the cache file fail with ELOOP instead of being followed.
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    const uid = process.getuid?.();
    const foreign = uid !== undefined && info.uid !== uid;
    if (!info.isFile() || info.size > CACHE_MAX_COMPRESSED_BYTES || foreign) return null;
    const compressed = await handle.readFile();
    const json = await gunzipAsync(compressed, { maxOutputLength: CACHE_MAX_JSON_BYTES });
    return validateCache(JSON.parse(json.toString('utf8')), key, head);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Atomic (temp file + rename), private (0600) and never writes through an existing symlink. */
async function writeCache(dir: string, key: string, head: string, result: HistoryResult): Promise<void> {
  const { data } = result;
  if (data.items.length > CACHE_MAX_INCIDENCES) return;
  const deadIds: number[] = [];
  data.dead.forEach((flag, id) => {
    if (flag) deadIds.push(id);
  });
  const file: CacheFile = {
    format: CACHE_FORMAT,
    version: CACHE_VERSION,
    key,
    head,
    windowExceeded: result.truncatedBy === 'maxCommits',
    ignored: result.ignored,
    paths: data.paths,
    newest: Array.from(data.newest),
    dead: deadIds,
    starts: Array.from(data.starts),
    items: Array.from(data.items),
  };
  const bytes = await gzipAsync(Buffer.from(JSON.stringify(file), 'utf8'));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `gitsig-${key}.json.gz`);
  const temporary = join(dir, `.gitsig-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  let handle: FileHandle | undefined;
  try {
    // 'wx' is O_CREAT | O_EXCL, which refuses to open anything that already exists, symlinks included.
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await pruneCache(dir);
}

async function pruneCache(dir: string): Promise<void> {
  const names = (await readdir(dir)).filter(name => CACHE_FILE.test(name));
  if (names.length <= CACHE_MAX_FILES) return;
  const entries: { name: string; mtime: number }[] = [];
  for (const name of names) {
    const info = await lstat(join(dir, name)).catch(() => null);
    if (info?.isFile()) entries.push({ name, mtime: info.mtimeMs });
  }
  entries.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : 1));
  for (const { name } of entries.slice(CACHE_MAX_FILES)) await unlink(join(dir, name)).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------

/** Non-numeric and non-positive values fall back to the default; huge ones are clamped. */
function limitOption(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 1) return fallback;
  return Math.min(max, Math.trunc(value));
}

/**
 * Loads history and working-tree signals for the repository containing `root`. All paths in the result are
 * relative to `root` and use forward slashes, and only files below `root` are considered. Never throws.
 */
export async function loadGitSignals(root: string, options: GitSignalsOptions = {}): Promise<GitSignals> {
  try {
    return await collectSignals(root, options ?? {});
  } catch (error) {
    return unavailable(`unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function collectSignals(root: string, options: GitSignalsOptions): Promise<GitSignals> {
  const maxCommits = limitOption(options.maxCommits, DEFAULT_MAX_COMMITS, MAX_MAX_COMMITS);
  const maxFiles = limitOption(options.maxFilesPerCommit, DEFAULT_MAX_FILES_PER_COMMIT, MAX_MAX_FILES_PER_COMMIT);
  const timeoutMs = limitOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const limits: SafetyLimits = {
    logBytes: limitOption(options.limits?.logBytes, DEFAULT_LIMITS.logBytes, DEFAULT_LIMITS.logBytes),
    incidences: limitOption(options.limits?.incidences, DEFAULT_LIMITS.incidences, DEFAULT_LIMITS.incidences),
    dirtyPaths: limitOption(options.limits?.dirtyPaths, DEFAULT_LIMITS.dirtyPaths, DEFAULT_LIMITS.dirtyPaths),
  };
  const binary = typeof options.gitBinary === 'string' && options.gitBinary !== '' ? options.gitBinary : 'git';
  const cacheDir = typeof options.cacheDir === 'string' && options.cacheDir !== '' ? resolve(options.cacheDir) : null;
  const deadline = performance.now() + timeoutMs;

  if (typeof root !== 'string' || root === '' || root.includes('\0') || binary.includes('\0')) {
    return unavailable('root is not a valid path');
  }
  const cwd = resolve(root);
  const info = await stat(cwd).catch(() => null);
  if (!info?.isDirectory()) return unavailable('root is not a directory');

  const git: GitContext = { binary, cwd, env: gitEnvironment(), deadline };
  const [layout, head] = await Promise.all([readLayout(git), readHead(git)]);
  if (!layout.ok) return unavailable(layout.reason);
  if (!head.ok) return unavailable(head.reason);
  const { shallow, prefix } = layout.value;
  const warnings: string[] = [];

  let boundary: string[] = [];
  if (shallow) {
    const listed = await readShallowBoundary(git);
    if (listed) boundary = listed;
    else warnings.push('shallow boundary commits could not be read; the oldest analysed commit may be inflated');
  }

  const key = cacheKey(head.value.oid, prefix, maxCommits, maxFiles, boundary);
  const cached = cacheDir ? await readCache(cacheDir, key, head.value.oid) : null;
  const [history, status] = await Promise.all([
    cached ?? readHistory(git, prefix, maxCommits, maxFiles, new Set(boundary), limits),
    readDirty(git, prefix, limits.dirtyPaths),
  ]);
  warnings.push(...history.warnings, ...status.warnings);

  const cacheable = history.truncatedBy === undefined || history.truncatedBy === 'maxCommits';
  if (cacheDir && !cached && cacheable) {
    await writeCache(cacheDir, key, head.value.oid, history).catch(() => undefined);
  }

  return new GitSignalsResult({
    available: true,
    head: head.value.oid,
    headTime: head.value.time,
    shallow,
    truncatedBy: history.truncatedBy,
    ignored: history.ignored,
    index: new HistoryIndex(history.data, history.ids),
    dirty: status.dirty,
    warnings,
    fromCache: cached !== null,
  });
}
