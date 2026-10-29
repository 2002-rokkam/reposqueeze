import { readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, dirname, posix } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ignore, { type Ignore } from 'ignore';
import { hash, languageFor, parseSource } from './parser.js';
import type { Snapshot, SourceFile } from './types.js';

const exec = promisify(execFile);
const excluded = /(^|\/)(?:\.git|\.hg|\.svn|node_modules|vendor|\.venv|venv|__pycache__|\.next|\.cache|\.reposqueeze|\.bench-repos|\.vscode-test|dist|build|coverage|target)(\/|$)/;
const secrets = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|ed25519)|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|[^/]*\.(?:pem|key|p12|pfx|keystore))$/i;
const binary = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|wasm|mp[34]|woff2?|ttf|exe|dll|so|dylib|sqlite|db|lock|map|vsix)$/i;
const secretContent = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bAKIA[0-9A-Z]{16}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}|(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[:=]\s*["'][^"'\s]{20,}["']/i;
export function allowedPath(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.split(/[\\/]/).includes('..') && !path.includes('\0') && !path.includes('\\') && !/[\r\n\x00-\x1f]/.test(path) && !excluded.test(path) && !secrets.test(path) && !binary.test(path) && !/(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path);
}

export class Repository {
  readonly root: string;
  private cache = new Map<string, SourceFile>();
  constructor(root: string) { this.root = resolve(root); }

  async snapshot(): Promise<Snapshot> {
    const start = performance.now();
    const root = await realpath(this.root);
    const warnings: string[] = [];
    let paths: string[];
    const ignoreRules = new Map<string, Ignore>();
    const custom = ignore();
    try { custom.add(await readFile(resolve(root, '.reposqueezeignore'), 'utf8')); } catch {}
    const ignored = async (path: string) => {
      if (custom.ignores(path)) return true;
      const dirs = [''];
      const parts = path.replace(/\/$/,'').split('/');
      for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join('/'));
      for (const dir of dirs) {
        if (!ignoreRules.has(dir)) {
          const rule = ignore();
          try { rule.add(await readFile(resolve(root, dir, '.gitignore'), 'utf8')); } catch {}
          ignoreRules.set(dir, rule);
        }
        if (ignoreRules.get(dir)!.ignores(dir ? path.slice(dir.length + 1) : path)) return true;
      }
      return false;
    };
    let truncated = false;
    try {
      const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], {cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 10000});
      paths = [...new Set(stdout.split('\0').filter(Boolean))].sort();
    } catch {
      paths = [];
      const walk = async (dir: string, depth = 0): Promise<void> => {
        if (depth > 40 || paths.length >= 12000) { truncated = true; return; }
        const entries = (await readdir(resolve(root, dir), {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          const path = posix.join(dir, entry.name);
          if (!allowedPath(path) || entry.isSymbolicLink() || await ignored(path + (entry.isDirectory() ? '/' : ''))) continue;
          if (entry.isDirectory()) await walk(path, depth + 1); else if (entry.isFile()) paths.push(path);
          if (paths.length >= 12000) { truncated = true; break; }
        }
      };
      await walk('');
      warnings.push('Non-Git enumeration; nested .gitignore and .reposqueezeignore applied.');
    }
    const files: SourceFile[] = [];
    let skipped = 0, bytes = 0;
    if (paths.length > 12000) truncated = true;
    for (const path of paths.slice(0, 12000)) {
      if (!allowedPath(path) || await ignored(path)) { skipped++; continue; }
      const abs = resolve(root, path);
      try {
        const actual = await realpath(abs);
        if (actual !== abs || relative(root, actual).startsWith('..' + sep)) { skipped++; continue; }
        const stat = await lstat(abs);
        if (!stat.isFile() || stat.size > 1024 * 1024) { skipped++; continue; }
        bytes += stat.size;
        if (bytes > 64 * 1024 * 1024) { truncated = true; break; }
        const buf = await readFile(abs);
        if (buf.includes(0)) { skipped++; continue; }
        const text = buf.toString('utf8');
        if (secretContent.test(text)) { skipped++; continue; }
        const digest = hash(text);
        const cached = this.cache.get(path);
        const file = cached?.hash === digest ? cached : {path, text, hash: digest, language: languageFor(path), ...await parseSource(path, text)};
        files.push(file);
      } catch { skipped++; }
    }
    this.cache = new Map(files.map(f => [f.path, f]));
    if (truncated) warnings.push('Repository exceeds scan limits (12,000 files / 64 MiB / depth 40); index is incomplete.');
    const fallback = files.filter(f => f.language !== 'text' && !f.parsed).length;
    if (fallback) warnings.push(`${fallback} source files have parse errors or unavailable grammars; line-window search remains active.`);
    return {root, files, chunks: files.flatMap(f => f.chunks), revision: hash(files.map(f => `${f.path}:${f.hash}`).join('\n')).slice(0,16), warnings, skipped, truncated, elapsedMs: performance.now() - start};
  }
}
