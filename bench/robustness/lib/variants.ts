import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_BASELINE } from './paths.js';

export interface Variant {
  /** Short label used in file names and report titles. */
  name: string;
  /** Source/build root of the variant (contains dist/cli.cjs and node_modules). */
  root: string;
  /** Extra environment variables applied to every process started for this variant. */
  env: Record<string, string>;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_KEY = '[A-Za-z_][A-Za-z0-9_]*';

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

/**
 * Parse `name=path[:ENV=VAL,ENV2=VAL2]`. The path ends at the first colon that is followed by `KEY=`,
 * so paths may contain colons. Env values may contain commas unless a comma is followed by `KEY=`.
 */
export function parseVariantSpec(spec: string): Variant {
  const named = /^([^=]+)=([\s\S]*)$/.exec(spec);
  if (!named) throw new Error(`Invalid --variant "${spec}": expected name=path[:ENV=VAL,...]`);
  const name = named[1].trim();
  if (!NAME_RE.test(name)) throw new Error(`Invalid variant name "${name}": use letters, digits, ".", "_" or "-"`);
  const rest = named[2];
  const envStart = rest.search(new RegExp(`:(?=${ENV_KEY}=)`));
  const rawPath = envStart === -1 ? rest : rest.slice(0, envStart);
  if (!rawPath.trim()) throw new Error(`Invalid --variant "${spec}": empty path`);
  const env: Record<string, string> = {};
  if (envStart !== -1) {
    for (const pair of rest.slice(envStart + 1).split(new RegExp(`,(?=${ENV_KEY}=)`))) {
      const eq = pair.indexOf('=');
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return { name, root: resolve(expandHome(rawPath.trim())), env };
}

export function cliPath(variant: Variant): string {
  return join(variant.root, 'dist', 'cli.cjs');
}

/** Returns a human-readable problem description, or undefined when the variant can be executed. */
export function variantProblem(variant: Variant): string | undefined {
  if (!existsSync(variant.root) || !statSync(variant.root).isDirectory()) {
    return `variant "${variant.name}": root ${variant.root} does not exist`;
  }
  if (!existsSync(cliPath(variant))) {
    return `variant "${variant.name}": ${cliPath(variant)} is missing — build it first (npm run build in ${variant.root})`;
  }
  return undefined;
}

export interface ResolvedVariants {
  variants: Variant[];
  skipped: { name: string; reason: string }[];
}

/** Defaults to the pristine baseline. Variants with a missing dist are skipped with a clear reason. */
export function resolveVariants(specs: readonly string[] | undefined): ResolvedVariants {
  const parsed = specs?.length
    ? specs.map(parseVariantSpec)
    : [{ name: 'baseline', root: DEFAULT_BASELINE, env: {} } satisfies Variant];
  const seen = new Set<string>();
  const variants: Variant[] = [];
  const skipped: ResolvedVariants['skipped'] = [];
  for (const variant of parsed) {
    if (seen.has(variant.name)) throw new Error(`Duplicate variant name "${variant.name}"`);
    seen.add(variant.name);
    const problem = variantProblem(variant);
    if (problem) skipped.push({ name: variant.name, reason: problem });
    else variants.push(variant);
  }
  return { variants, skipped };
}
