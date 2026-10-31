import { copyFile, mkdir, readdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureGitConfig, retry, runGit, type GitOptions } from './git.js';
import { pidAlive, withLock } from './lock.js';
import { corpusDir } from './paths.js';

/** `Owner/Name` -> `owner__name` (lower-cased: GitHub is case-insensitive, APFS usually too). */
export function repoDirName(repo: string): string {
  return repo.toLowerCase().replace(/\//g, '__');
}

/**
 * Clone URL. `RSQ_BENCH_REPO_URL_TEMPLATE` (placeholders {repo}, {owner}, {name}, {dir}) lets tests
 * and offline mirrors replace GitHub.
 */
export function repoUrl(repo: string): string {
  const template = process.env.RSQ_BENCH_REPO_URL_TEMPLATE;
  if (!template) return `https://github.com/${repo}.git`;
  const [owner, name] = repo.split('/');
  return template.replace('{repo}', repo).replace('{owner}', owner).replace('{name}', name).replace('{dir}', repoDirName(repo));
}

export const gitConfigPath = () => join(corpusDir(), '.bench-gitconfig');
const markerOf = (dir: string) => join(dir, '.git', 'rsq-clone-complete');

let configReady: Promise<void> | undefined;
let configReadyFor = '';

async function git(args: string[], options: GitOptions = {}): Promise<string> {
  const path = gitConfigPath();
  if (configReadyFor !== path) {
    configReadyFor = path;
    configReady = ensureGitConfig(path);
  }
  await configReady;
  return runGit(args, { ...options, configPath: path });
}

async function isCloned(dir: string): Promise<boolean> {
  const entries = await readdir(join(dir, '.git')).catch(() => [] as string[]);
  return entries.includes('rsq-clone-complete');
}

export type CloneMode = 'full' | 'shallow';

export interface PrepareOptions {
  /** Never touch the network; anything not already in the corpus is reported missing. */
  offline?: boolean;
  /** Refuse to start a clone when less than this many GiB are free. */
  minFreeGiB?: number;
  /**
   * `full` (default): complete history, offline afterwards, supports history-based retrieval features.
   * `shallow`: no clone; only the requested base commits are fetched, one `--depth 1` snapshot each.
   * Much less data for repositories with few instances, but variants see no git history.
   */
  cloneMode?: CloneMode;
  log?: (message: string) => void;
}

export interface RepoState {
  repo: string;
  dir: string;
  /** How this repository entered the corpus (the first clone decides; later runs reuse it). */
  mode: CloneMode;
  /** Commits present locally, with their committer timestamps (seconds). */
  commitTimes: Map<string, number>;
  /** Requested commits that could not be obtained. */
  missing: string[];
  error?: string;
}

async function corpusMode(dir: string): Promise<CloneMode> {
  const marker = await readFile(markerOf(dir), 'utf8').catch(() => '');
  return marker.startsWith('shallow') ? 'shallow' : 'full';
}

async function freeGiB(path: string): Promise<number> {
  const stats = await statfs(path);
  return (Number(stats.bavail) * Number(stats.bsize)) / 2 ** 30;
}

async function cloneRepo(repo: string, dir: string, options: PrepareOptions): Promise<void> {
  const minFree = options.minFreeGiB ?? 8;
  await mkdir(corpusDir(), { recursive: true });
  const free = await freeGiB(corpusDir());
  if (free < minFree) throw new Error(`only ${free.toFixed(1)} GiB free in ${corpusDir()} (< ${minFree} GiB); refusing to clone ${repo}`);
  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true });
  const shallow = options.cloneMode === 'shallow';
  options.log?.(`${shallow ? 'initialising (shallow mode)' : 'cloning'} ${repo}`);
  await retry(async () => {
    await rm(partial, { recursive: true, force: true });
    if (shallow) {
      await git(['init', '--quiet', '--template=', partial]);
      await git(['remote', 'add', 'origin', repoUrl(repo)], { cwd: partial });
    } else {
      await git(['clone', '--quiet', '--no-checkout', repoUrl(repo), partial], { timeoutMs: 90 * 60_000 });
    }
  }, 3, 5000, (error, attempt) => options.log?.(`clone of ${repo} failed (attempt ${attempt}): ${(error as Error).message}`));
  // Defence in depth: nothing in the corpus can ever be pushed anywhere.
  await git(['config', 'remote.origin.pushurl', 'DISABLED_NO_PUSH'], { cwd: partial });
  await rm(dir, { recursive: true, force: true });
  await rename(partial, dir);
  await writeFile(markerOf(dir), `${options.cloneMode ?? 'full'} ${new Date().toISOString()}\n`);
}

/** Commits from `shas` that are not present as commit objects (offline check). */
export async function missingCommits(dir: string, shas: string[]): Promise<string[]> {
  if (!shas.length) return [];
  const output = await git(['cat-file', '--batch-check'], { cwd: dir, input: shas.map(sha => `${sha}^{commit}\n`).join('') });
  const lines = output.split('\n').filter(Boolean);
  return shas.filter((_, index) => lines[index]?.endsWith(' missing'));
}

async function fetchCommits(dir: string, shas: string[], shallow: boolean, log?: (message: string) => void): Promise<void> {
  const depth = shallow ? ['--depth', '1'] : [];
  const size = shallow ? 8 : 20;
  for (let offset = 0; offset < shas.length; offset += size) {
    const batch = shas.slice(offset, offset + size);
    try {
      await retry(() => git(['fetch', '--quiet', '--no-tags', ...depth, 'origin', ...batch], { cwd: dir, timeoutMs: 30 * 60_000 }), 2, 3000);
    } catch (error) {
      log?.(`batch fetch failed (${(error as Error).message}); retrying commits one by one`);
      for (const sha of batch) await git(['fetch', '--quiet', '--no-tags', ...depth, 'origin', sha], { cwd: dir, timeoutMs: 30 * 60_000 }).catch(() => undefined);
    }
  }
}

async function commitTimes(dir: string, shas: string[]): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  for (let offset = 0; offset < shas.length; offset += 200) {
    const batch = shas.slice(offset, offset + 200);
    const output = await git(['log', '--no-walk=unsorted', '--format=%H %ct', ...batch], { cwd: dir });
    for (const line of output.split('\n').filter(Boolean)) {
      const [sha, seconds] = line.split(' ');
      times.set(sha, Number(seconds));
    }
  }
  return times;
}

/** Makes sure the corpus clone exists and contains every requested base commit. Safe to run from several processes. */
export async function prepareRepo(repo: string, commits: string[], options: PrepareOptions = {}): Promise<RepoState> {
  const dir = join(corpusDir(), repoDirName(repo));
  const unique = [...new Set(commits)];
  try {
    return await withLock(`${dir}.lock`, async () => {
      if (!(await isCloned(dir))) {
        if (options.offline) return { repo, dir, mode: options.cloneMode ?? 'full', commitTimes: new Map(), missing: unique, error: 'repository not cloned (offline mode)' };
        await cloneRepo(repo, dir, options);
      }
      let missing = await missingCommits(dir, unique);
      if (missing.length && !options.offline) {
        options.log?.(`${repo}: fetching ${missing.length} base commit(s) not yet in the corpus`);
        await fetchCommits(dir, missing, options.cloneMode === 'shallow', options.log);
        missing = await missingCommits(dir, missing);
      }
      const present = unique.filter(sha => !missing.includes(sha));
      return { repo, dir, mode: await corpusMode(dir), commitTimes: await commitTimes(dir, present), missing };
    });
  } catch (error) {
    return { repo, dir, mode: options.cloneMode ?? 'full', commitTimes: new Map(), missing: unique, error: (error as Error).message };
  }
}

export function slotsRoot(): string {
  return join(corpusDir(), '_checkouts');
}

/** Removes checkout slots left behind by runners that no longer exist. */
export async function sweepStaleSlots(log?: (message: string) => void): Promise<void> {
  const root = slotsRoot();
  for (const repoDir of await readdir(root).catch(() => [] as string[])) {
    for (const slot of await readdir(join(root, repoDir)).catch(() => [] as string[])) {
      const pid = Number(/^p(\d+)-/.exec(slot)?.[1]);
      if (!pidAlive(pid)) {
        log?.(`removing stale checkout ${repoDir}/${slot}`);
        await rm(join(root, repoDir, slot), { recursive: true, force: true });
      }
    }
  }
}

/**
 * A private working copy for one worker: its own `.git` that borrows objects from the corpus clone
 * through `objects/info/alternates`. Unlike `git worktree`, it shares no refs, so a retriever
 * running `git log --all`, `git for-each-ref` or `git describe` can never see commits newer than
 * the base commit (the fix commit included), and parallel workers never contend for repo locks.
 */
export class CheckoutSlot {
  readonly dir: string;
  private initialised = false;

  constructor(readonly repo: string, readonly mainDir: string, slotName: string) {
    this.dir = join(slotsRoot(), repoDirName(repo), slotName);
  }

  private run(args: string[], timeoutMs = 20 * 60_000): Promise<string> {
    return git(args, { cwd: this.dir, timeoutMs });
  }

  async init(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
    await git(['init', '--quiet', '--template=', this.dir]);
    await mkdir(join(this.dir, '.git', 'objects', 'info'), { recursive: true });
    await writeFile(join(this.dir, '.git', 'objects', 'info', 'alternates'), `${join(this.mainDir, '.git', 'objects')}\n`);
    // Shallow corpus: tell this repository where history ends so `git log` stops cleanly instead of failing.
    await copyFile(join(this.mainDir, '.git', 'shallow'), join(this.dir, '.git', 'shallow')).catch(() => undefined);
    this.initialised = true;
  }

  /** Checks out `sha` detached and pristine (no untracked or ignored files). */
  async checkout(sha: string): Promise<void> {
    if (!this.initialised) await this.init();
    const attempt = async () => {
      await this.run(['checkout', '--quiet', '--force', '--detach', sha]);
      await this.run(['clean', '-ffdxq']);
      const head = (await this.run(['rev-parse', 'HEAD'])).trim();
      if (head !== sha) throw new Error(`HEAD is ${head}, expected ${sha}`);
    };
    try {
      await attempt();
    } catch {
      await this.init(); // a corrupt or interrupted checkout is cheaper to rebuild than to debug
      await attempt();
    }
  }

  /** Drops anything a previous variant wrote into the checkout. */
  async reset(): Promise<void> {
    await this.run(['reset', '--hard', '--quiet']);
    await this.run(['clean', '-ffdxq']);
  }

  async dispose(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
