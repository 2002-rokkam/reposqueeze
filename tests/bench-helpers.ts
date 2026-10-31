import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { SCRATCH_DIR } from '../bench/lib/paths.js';

/** A fresh directory inside the project's self-ignoring scratch area, removed when the test ends. */
export async function scratch(t: TestContext, name: string): Promise<string> {
  await mkdir(SCRATCH_DIR, { recursive: true });
  await writeFile(join(SCRATCH_DIR, '.gitignore'), '*\n');
  const dir = await mkdtemp(join(SCRATCH_DIR, `${name}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

const HERMETIC = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: HERMETIC, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Creates a small git repository with the given commits (each a map of path -> content); returns the commit SHAs. */
export async function makeRepo(root: string, commits: Record<string, string>[]): Promise<string[]> {
  await mkdir(root, { recursive: true });
  git(root, 'init', '--quiet', '-b', 'main');
  git(root, 'config', 'user.email', 'bench@example.invalid');
  git(root, 'config', 'user.name', 'bench');
  git(root, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const shas: string[] = [];
  for (const [index, files] of commits.entries()) {
    await writeFiles(root, files);
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', `commit ${index + 1}`);
    shas.push(git(root, 'rev-parse', 'HEAD'));
  }
  return shas;
}
