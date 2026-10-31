import { Tiktoken } from 'js-tiktoken/lite';
import o200k_base from 'js-tiktoken/ranks/o200k_base';
export const TOKENIZER = 'o200k_base';

// The encoder costs a few hundred milliseconds and ~250 MB to build, so it is created on first use. Callers that
// are certain to need it can start the work early with warmTokenizer() while file I/O is in flight.
let encoder: Tiktoken | undefined;
const encoderInstance = () => encoder ??= new Tiktoken(o200k_base);
export function warmTokenizer(): void { encoderInstance(); }
export function tokens(text: string): number { return encoderInstance().encode(text, [], []).length; }
export function checkBudget(n: number): number {
  if (!Number.isInteger(n) || n < 256 || n > 32000) throw new Error('budget must be an integer from 256 to 32000');
  return n;
}
export function fit(text: string, budget: number, suffix = '\n[truncated]'): string {
  if (tokens(text) <= budget) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (tokens(text.slice(0, mid) + suffix) <= budget) low = mid; else high = mid - 1;
  }
  return text.slice(0, low) + suffix;
}

// ---------------------------------------------------------------------------------------------------------------
// Repository-size statistic ("inputTokens"): counting every file with a BPE encoder costs seconds per 10 MB, so by
// default the total is an estimate: bytes times the tokens-per-byte ratio of a deterministic sample of files.
// ---------------------------------------------------------------------------------------------------------------
export const SAMPLE_MAX_FILES = 200;
export const SAMPLE_MAX_BYTES = 1_000_000;

/** The text the baseline counted for a file: a header line followed by the file. */
export const fileHeader = (path: string) => `--- ${path} ---\n`;

/** Deterministic pseudo-random sort key of a path (FNV-1a followed by a murmur3 finalizer). */
export function sampleKey(path: string): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) { h ^= path.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

/** Files to measure: lowest sample keys first, until the file or byte budget is used (oversized files are skipped). */
export function chooseSample<T extends { path: string; size: number }>(files: readonly T[], maxFiles = SAMPLE_MAX_FILES, maxBytes = SAMPLE_MAX_BYTES): T[] {
  const ordered = files.map(file => ({ file, key: sampleKey(file.path) })).sort((a, b) => a.key - b.key || (a.file.path < b.file.path ? -1 : 1));
  const chosen: T[] = [];
  let bytes = 0;
  for (const { file } of ordered) {
    if (chosen.length >= maxFiles) break;
    if (file.size === 0 || bytes + file.size > maxBytes) continue;
    chosen.push(file);
    bytes += file.size;
  }
  return chosen;
}

/** Estimated token count of a repository: (file bytes + header bytes) * tokens-per-byte ratio. */
export function estimateTokens(files: readonly { path: string; size: number }[], tokensPerByte: number): number {
  let bytes = 0;
  for (const file of files) bytes += file.size + file.path.length + 9;
  return Math.round(bytes * tokensPerByte);
}

/** Exact count for one file as the baseline defined it. */
export const fileTokens = (path: string, text: string) => tokens(fileHeader(path) + text);
