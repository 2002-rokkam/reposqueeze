import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CORPUS_FILE, DEFAULT_CORPUS_DIR, LOCK_FILE, SCRATCH_ROOT } from './paths.js';
import { withHeavy } from './throttle.js';

const exec = promisify(execFile);

export interface CorpusEntry {
  /** GitHub owner/name. */
  repo: string;
  /** Directory name below the corpus dir (owner__name). */
  name: string;
  url: string;
  ecosystem: string;
  category: string;
  wave: 1 | 2;
}

export interface LockEntry {
  url: string;
  sha: string;
  ecosystem: string;
  category: string;
  /** Files listed by `git ls-files --cached --others --exclude-standard` at the pinned commit. */
  gitFiles?: number;
  /** Files that pass RepoSqueeze 2.1's path rules (estimate, see repo-stats.ts). */
  eligibleEstimate?: number;
  /** Sum of regular-file sizes in the work tree (excluding .git). */
  workTreeBytes?: number;
  topExtensions?: { ext: string; files: number }[];
}

export interface Lock {
  version: 1;
  repos: Record<string, LockEntry>;
}

export const repoDirName = (repo: string): string => repo.replace('/', '__');

export function loadCorpus(file = CORPUS_FILE): CorpusEntry[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { repos: { repo: string; ecosystem: string; category: string; wave: 1 | 2 }[] };
  return raw.repos.map(item => ({
    ...item,
    name: repoDirName(item.repo),
    url: `https://github.com/${item.repo}`,
  }));
}

export function loadLock(file = LOCK_FILE): Lock {
  if (!existsSync(file)) return { version: 1, repos: {} };
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Lock;
  return { version: 1, repos: parsed.repos ?? {} };
}

let writeChain: Promise<void> = Promise.resolve();

/** Serialised, key-sorted write so parallel workers cannot interleave and diffs stay stable. */
export function saveLock(lock: Lock, file = LOCK_FILE): Promise<void> {
  const sorted: Lock = { version: 1, repos: Object.fromEntries(Object.entries(lock.repos).sort(([a], [b]) => a.localeCompare(b))) };
  const body = `${JSON.stringify(sorted, null, 2)}\n`;
  writeChain = writeChain.then(async () => {
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, body);
    await rename(temporary, file);
  });
  return writeChain;
}

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', TMPDIR: SCRATCH_ROOT };

async function git(cwd: string, args: string[], timeout = 1_800_000): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, env: gitEnv, timeout, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** Network/disk-heavy git operations take a throttle slot (see throttle.ts). */
const heavyGit = (cwd: string, args: string[]): Promise<string> => withHeavy(() => git(cwd, args));

export interface CloneResult {
  dir: string;
  sha: string;
  /** True when this call had to download the repository. */
  fetched: boolean;
}

/**
 * Makes sure the repository exists at the pinned commit (or at the current default-branch head when no
 * pin exists yet). Shallow only; submodules and LFS objects are never fetched.
 */
export async function ensureClone(entry: CorpusEntry, lock: Lock, corpusDir = DEFAULT_CORPUS_DIR): Promise<CloneResult> {
  const dir = join(corpusDir, entry.name);
  const pinned = lock.repos[entry.name]?.sha;
  await mkdir(corpusDir, { recursive: true });
  if (existsSync(join(dir, '.git'))) {
    const head = await git(dir, ['rev-parse', 'HEAD']);
    if (!pinned || head === pinned) return { dir, sha: head, fetched: false };
    await heavyGit(dir, ['fetch', '--depth', '1', '--no-tags', 'origin', pinned]);
    await heavyGit(dir, ['-c', 'advice.detachedHead=false', 'checkout', '--force', pinned]);
    return { dir, sha: pinned, fetched: true };
  }
  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true });
  if (pinned) {
    await mkdir(partial, { recursive: true });
    await git(partial, ['init', '--quiet']);
    await git(partial, ['remote', 'add', 'origin', entry.url]);
    await heavyGit(partial, ['fetch', '--depth', '1', '--no-tags', 'origin', pinned]);
    await heavyGit(partial, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD']);
  } else {
    await withHeavy(() => exec('git', ['clone', '--depth', '1', '--no-tags', '--single-branch', '--quiet', entry.url, partial], { env: gitEnv, timeout: 3_600_000 }));
  }
  await rename(partial, dir);
  return { dir, sha: await git(dir, ['rev-parse', 'HEAD']), fetched: true };
}

export async function pruneClone(entry: CorpusEntry, corpusDir = DEFAULT_CORPUS_DIR): Promise<void> {
  await rm(join(corpusDir, entry.name), { recursive: true, force: true });
}
