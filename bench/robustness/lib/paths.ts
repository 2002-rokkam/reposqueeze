import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locations used by the robustness suite. Nothing here ever points at the
 * system temporary directory: every scratch file lives below the lab.
 */
export const LAB = resolve(process.env.RSQ_LAB ?? join(homedir(), 'reposqueeze-lab'));
export const labPath = (...parts: string[]): string => join(LAB, ...parts);

export const HARNESS_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const REPO_ROOT = resolve(HARNESS_DIR, '..', '..');

export const DEFAULT_BASELINE = labPath('baseline');
export const DEFAULT_CORPUS_DIR = labPath('corpus', 'shallow');
export const DEFAULT_RESULTS_DIR = labPath('results', 'bench-robust');
export const PRIVATE_RESULTS_DIR = labPath('results', 'private');
export const SCRATCH_ROOT = labPath('tmp', 'bench-robust');
export const CORPUS_FILE = join(HARNESS_DIR, 'corpus.json');
export const LOCK_FILE = join(HARNESS_DIR, 'corpus.lock.json');
export const REPORT_DIR = join(REPO_ROOT, 'benchmarks', 'v3');
