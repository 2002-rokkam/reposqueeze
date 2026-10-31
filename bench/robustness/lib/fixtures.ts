import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { SCRATCH_ROOT } from './paths.js';

const exec = promisify(execFile);

export type FileSpec = Record<string, string | Uint8Array>;

/** Recreates an empty directory below the lab scratch area (never the system temp dir). */
export async function freshDir(...parts: string[]): Promise<string> {
  const dir = join(SCRATCH_ROOT, 'fixtures', ...parts);
  await makeWritable(dir);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Restores write permission below `dir` so a tree built with chmod 000 / read-only entries can be deleted. */
export async function makeWritable(dir: string): Promise<void> {
  try {
    await chmod(dir, 0o755);
  } catch {
    return;
  }
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await makeWritable(path);
    else await chmod(path, 0o644).catch(() => undefined);
  }
}

export async function writeTree(root: string, files: FileSpec): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

const GIT_IDENTITY = ['-c', 'user.name=Robustness', '-c', 'user.email=robustness@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const GIT_DATES = { GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' };

export async function gitInit(root: string, options: { commit?: boolean } = {}): Promise<void> {
  const env = { ...process.env, ...GIT_DATES, TMPDIR: SCRATCH_ROOT };
  await exec('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root, env });
  if (options.commit === false) return;
  await exec('git', ['add', '-A'], { cwd: root, env, maxBuffer: 256 * 1024 * 1024 });
  await exec('git', [...GIT_IDENTITY, 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: root, env, maxBuffer: 256 * 1024 * 1024 });
}

export async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', [...GIT_IDENTITY, ...args], { cwd: root, env: { ...process.env, ...GIT_DATES, TMPDIR: SCRATCH_ROOT }, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

/** Creates `count` tiny files spread over directories of `perDir` entries each. */
export async function makeManyFiles(root: string, count: number, perDir = 500, prefix = 'm'): Promise<void> {
  const concurrency = 64;
  for (let start = 0; start < count; start += concurrency) {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, count - start) }, async (_, offset) => {
        const index = start + offset;
        const dir = join(root, `${prefix}${String(Math.floor(index / perDir)).padStart(4, '0')}`);
        if (index % perDir === 0) await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `f${index}.txt`), `value ${index} token${index % 997}\n`);
      }),
    );
  }
}

export async function pathKind(path: string): Promise<'missing' | 'file' | 'dir' | 'symlink' | 'other'> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'dir';
    return stat.isFile() ? 'file' : 'other';
  } catch {
    return 'missing';
  }
}

export { symlink, chmod, constants };

export interface CachedFile {
  path: string;
  /** Raw bytes, plus the gunzipped bytes for *.gz files. */
  views: Buffer[];
}

/** Every regular file below `paths` (files or directories), with decompressed views of gzip files, for canary scans of caches. */
export async function readCacheFiles(paths: readonly string[]): Promise<CachedFile[]> {
  const out: CachedFile[] = [];
  const addFile = async (path: string): Promise<void> => {
    let raw: Buffer;
    try {
      raw = await readFile(path);
    } catch {
      return;
    }
    const views = [raw];
    if (path.endsWith('.gz') || (raw[0] === 0x1f && raw[1] === 0x8b)) {
      try {
        views.push(gunzipSync(raw));
      } catch {
        /* not valid gzip: raw bytes are still scanned */
      }
    }
    out.push({ path, views });
  };
  const visit = async (path: string): Promise<void> => {
    let info;
    try {
      info = await lstat(path);
    } catch {
      return;
    }
    if (info.isFile()) return addFile(path);
    if (!info.isDirectory()) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) await visit(join(path, entry.name));
  };
  for (const path of paths) await visit(path);
  return out;
}

export function filesContaining(files: readonly CachedFile[], needles: readonly string[]): { path: string; needle: string }[] {
  const hits: { path: string; needle: string }[] = [];
  for (const file of files) {
    for (const needle of needles) {
      if (file.views.some(view => view.includes(needle))) hits.push({ path: file.path, needle });
    }
  }
  return hits;
}
