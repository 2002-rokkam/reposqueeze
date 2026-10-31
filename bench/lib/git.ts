import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class GitError extends Error {
  constructor(message: string, readonly code: number | null, readonly stderr: string) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Hermetic git configuration for every command the benchmark runs: no user/system config
 * (credential helpers, LFS filters, URL rewrites), no hooks, no auto-gc, no prompts.
 * Nothing from a benchmark repository is ever executed.
 */
const BENCH_GIT_CONFIG = `[core]
	hooksPath = /dev/null
	fsmonitor = false
	autocrlf = false
	logAllRefUpdates = false
	quotePath = false
[gc]
	auto = 0
[fetch]
	unpackLimit = 1
[transfer]
	unpackLimit = 1
[advice]
	detachedHead = false
[http]
	version = HTTP/1.1
	lowSpeedLimit = 0
	lowSpeedTime = 999999
[pack]
	threads = 0
[filter "lfs"]
	clean =
	smudge =
	process =
	required = false
[safe]
	directory = *
`;

export async function ensureGitConfig(path: string): Promise<void> {
  const current = await readFile(path, 'utf8').catch(() => '');
  if (current === BENCH_GIT_CONFIG) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, BENCH_GIT_CONFIG);
  await rename(temporary, path);
}

export function gitEnv(configPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
  };
}

export interface GitOptions {
  cwd?: string;
  timeoutMs?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

/** Runs git without a shell and resolves with stdout; rejects with GitError (including stderr) on failure. */
export function runGit(args: string[], options: GitOptions & { configPath: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: options.cwd, env: options.env ?? gitEnv(options.configPath), stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let errBytes = 0;
    const timer = options.timeoutMs
      ? setTimeout(() => {
        child.kill('SIGKILL');
        reject(new GitError(`git ${args.slice(0, 3).join(' ')} timed out after ${options.timeoutMs} ms`, null, ''));
      }, options.timeoutMs)
      : undefined;
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => {
      if (errBytes < 64 * 1024) {
        err.push(chunk);
        errBytes += chunk.length;
      }
    });
    child.on('error', error => {
      if (timer) clearTimeout(timer);
      reject(new GitError(`failed to start git: ${error.message}`, null, ''));
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new GitError(`git ${args.slice(0, 3).join(' ')} exited with ${code}: ${stderr.trim().slice(0, 500)}`, code, stderr));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
}

export async function retry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 2000, onRetry?: (error: unknown, attempt: number) => void): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      onRetry?.(error, attempt);
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
