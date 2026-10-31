import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory of this benchmark (`<repo>/bench`). */
export const BENCH_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
/** Root of the RepoSqueeze checkout that contains this benchmark. */
export const REPO_ROOT = resolve(BENCH_ROOT, '..');

/**
 * Lab layout. Every location can be overridden with an environment variable so
 * tests never touch the real lab and CI can relocate the corpora.
 */
export function labDir(): string {
  return resolve(process.env.RSQ_LAB_DIR ?? join(homedir(), 'reposqueeze-lab'));
}
export function dataDir(): string {
  return resolve(process.env.RSQ_BENCH_DATA_DIR ?? join(labDir(), 'data'));
}
export function corpusDir(): string {
  return resolve(process.env.RSQ_BENCH_CORPUS_DIR ?? join(labDir(), 'corpus', 'swe'));
}
export function resultsDir(): string {
  return resolve(process.env.RSQ_BENCH_RESULTS_DIR ?? join(labDir(), 'results', 'bench-swe'));
}

/** Scratch space for tests, kept inside the project (self-ignoring) instead of the OS temp dir. */
export const SCRATCH_DIR = join(BENCH_ROOT, '.scratch');

export const WORKER_PATH = join(BENCH_ROOT, 'lib', 'worker.ts');
export const BUILTIN_VARIANTS_DIR = join(BENCH_ROOT, 'variants');
