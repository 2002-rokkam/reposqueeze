import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { runGit } from './git.js';
import { BUILTIN_VARIANTS_DIR, labDir } from './paths.js';

export interface VariantSpec {
  name: string;
  /** Directory that contains `src/engine.ts`. */
  root: string;
  /** Extra environment for the worker process of this variant only. */
  env: Record<string, string>;
  /** Truncate the query to this many characters before calling the engine (null = pass through). */
  truncate: number | null;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A split point between options: a separator followed by `KEY=` or `@name=`. */
const OPTION_START = /[,:](?=(?:@[A-Za-z][A-Za-z0-9_-]*|[A-Za-z_][A-Za-z0-9_]*)=)/;

/**
 * Parses `name=/path/to/repo[:KEY=VALUE[,KEY=VALUE...]][:@truncate=N]`.
 * Options are separated by `:` or `,`; a separator only splits when `KEY=` or `@name=` follows,
 * so values that contain ':' or ',' (PATH-like lists) survive. Bare names select a built-in or lab variant.
 */
export function parseVariantSpec(argument: string): VariantSpec {
  const equals = argument.indexOf('=');
  if (equals < 0) return builtinVariant(argument.trim());
  const name = argument.slice(0, equals).trim();
  if (!NAME_RE.test(name)) throw new Error(`invalid variant name "${name}" (use letters, digits, ., _, -)`);
  const rest = argument.slice(equals + 1);
  const optionStart = /:(?=(?:@[A-Za-z][A-Za-z0-9_-]*|[A-Za-z_][A-Za-z0-9_]*)=)/.exec(rest);
  const path = optionStart ? rest.slice(0, optionStart.index) : rest;
  const optionText = optionStart ? rest.slice(optionStart.index + 1) : '';
  if (!path) throw new Error(`variant "${name}" has no path`);
  const spec: VariantSpec = { name, root: resolve(path.startsWith('~') ? join(homedir(), path.slice(1)) : path), env: {}, truncate: null };
  for (const option of optionText ? splitOptions(optionText) : []) applyOption(spec, option);
  return spec;
}

function splitOptions(text: string): string[] {
  const options: string[] = [];
  let remaining = text;
  for (;;) {
    const match = OPTION_START.exec(remaining);
    if (!match) {
      options.push(remaining);
      return options;
    }
    options.push(remaining.slice(0, match.index));
    remaining = remaining.slice(match.index + 1);
  }
}

function applyOption(spec: VariantSpec, option: string): void {
  const equals = option.indexOf('=');
  const key = option.slice(0, equals);
  const value = option.slice(equals + 1);
  if (key === '@truncate') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`@truncate must be a positive integer, got "${value}"`);
    spec.truncate = n;
  } else if (key.startsWith('@')) {
    throw new Error(`unknown variant option ${key}`);
  } else {
    if (!ENV_KEY_RE.test(key)) throw new Error(`invalid environment variable name "${key}"`);
    spec.env[key] = value;
  }
}

/** Bare variant names: `ripgrep-naive` (bundled), `baseline` (lab copy of upstream, 8000-char truncation), `current` (integration repo). */
function builtinVariant(name: string): VariantSpec {
  if (name === 'ripgrep-naive') return { name, root: join(BUILTIN_VARIANTS_DIR, 'ripgrep-naive'), env: {}, truncate: null };
  if (name === 'baseline') return { name, root: join(labDir(), 'baseline'), env: {}, truncate: 8000 };
  if (name === 'current') return { name, root: join(homedir(), 'Desktop', 'reposqueeze'), env: {}, truncate: null };
  throw new Error(`variant "${name}" needs a path: --variant ${name}=/path/to/repo`);
}

/** Query as handed to the engine: cut to `max` UTF-16 code units without splitting a surrogate pair. */
export function truncateQuery(query: string, max: number | null): string {
  if (max === null || query.length <= max) return query;
  let end = max;
  const last = query.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return query.slice(0, end);
}

export interface VariantInfo extends VariantSpec {
  gitSha: string | null;
  gitBranch: string | null;
  /** Uncommitted changes under the variant root (tracked or untracked, ignoring build output). */
  dirty: boolean | null;
  engineVersion: string | null;
  /** Hash of everything that can change retrieval results: src/**, package.json and the asset listing. */
  fingerprint: string;
}

async function walk(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(join(dir, entry.name), relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

export async function fingerprintVariant(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of await walk(join(root, 'src'))) {
    hash.update(`src/${file}\0`);
    hash.update(await readFile(join(root, 'src', file)));
  }
  hash.update(await readFile(join(root, 'package.json')).catch(() => ''));
  for (const file of await walk(join(root, 'assets'))) {
    hash.update(`assets/${file}:${(await stat(join(root, 'assets', file))).size}\0`);
  }
  return hash.digest('hex');
}

async function engineVersion(root: string): Promise<string | null> {
  for (const file of ['variant.json', 'package.json']) {
    try {
      const json = JSON.parse(await readFile(join(root, file), 'utf8')) as { version?: string };
      if (json.version) return json.version;
    } catch {
      // try the next manifest
    }
  }
  return null;
}

export async function describeVariant(spec: VariantSpec): Promise<VariantInfo> {
  await stat(join(spec.root, 'src', 'engine.ts')).catch(() => {
    throw new Error(`variant "${spec.name}": ${join(spec.root, 'src', 'engine.ts')} not found`);
  });
  const git = async (args: string[]) => (await runGit(args, { cwd: spec.root, configPath: '/dev/null', timeoutMs: 30_000 })).trim();
  let gitSha: string | null = null;
  let gitBranch: string | null = null;
  let dirty: boolean | null = null;
  try {
    gitSha = await git(['rev-parse', 'HEAD']);
    gitBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])) || null;
    dirty = (await git(['status', '--porcelain', '--untracked-files=normal', '--', '.'])).length > 0;
  } catch {
    // not a git checkout: leave the identity fields null, the fingerprint still pins the code
  }
  return { ...spec, gitSha, gitBranch, dirty, engineVersion: await engineVersion(spec.root), fingerprint: await fingerprintVariant(spec.root) };
}
