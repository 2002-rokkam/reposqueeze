import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Same enumeration the variants use: tracked plus untracked-but-not-ignored files, sorted. */
export async function listRepoFiles(root: string): Promise<string[]> {
  const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], {
    cwd: root,
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 180_000,
  });
  return [...new Set(stdout.split('\0').filter(Boolean))].sort();
}

export async function headSha(root: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  return stdout.trim();
}

export function topExtensions(files: readonly string[], n = 4): { ext: string; files: number }[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const ext = extname(file).toLowerCase() || '(none)';
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([ext, count]) => ({ ext, files: count }));
}

export interface TreeStats {
  bytes: number;
  maxFileBytes: number;
  filesOver2MiB: number;
  symlinks: number;
  missing: number;
}

export async function treeStats(root: string, files: readonly string[]): Promise<TreeStats> {
  const stats: TreeStats = { bytes: 0, maxFileBytes: 0, filesOver2MiB: 0, symlinks: 0, missing: 0 };
  for (let offset = 0; offset < files.length; offset += 128) {
    await Promise.all(
      files.slice(offset, offset + 128).map(async file => {
        try {
          const stat = await lstat(join(root, file));
          if (stat.isSymbolicLink()) stats.symlinks++;
          if (!stat.isFile()) return;
          stats.bytes += stat.size;
          stats.maxFileBytes = Math.max(stats.maxFileBytes, stat.size);
          if (stat.size > 2 * 1024 * 1024) stats.filesOver2MiB++;
        } catch {
          stats.missing++;
        }
      }),
    );
  }
  return stats;
}

// Independent copy of the *path* rules RepoSqueeze 2.1 applies before reading a file. It is used only
// to estimate how many files a correct scan should consider; the variant's own numbers are what is reported.
const EXCLUDED_DIR = /(^|\/)(?:\.git|\.hg|\.svn|node_modules|vendor|\.venv|venv|__pycache__|\.next|\.cache|\.reposqueeze|\.reposqueeze-v2|\.bench-repos|\.vscode-test|dist|build|coverage|target)(\/|$)/;
const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|wasm|mp[34]|woff2?|ttf|exe|dll|so|dylib|sqlite|db|lock|map|vsix)$/i;
const LOCKFILE = /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const SECRET_NAMED = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|ed25519)|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|[^/]*\.(?:pem|key|p12|pfx|keystore))$/i;

export function eligibleByPath(path: string): boolean {
  return !EXCLUDED_DIR.test(path) && !BINARY_EXT.test(path) && !LOCKFILE.test(path) && !SECRET_NAMED.test(path) && !/[\r\n\x00-\x1f\\]/.test(path);
}
