import { tokens } from '../tokens.js';

// js-tiktoken needs quadratic (or worse) time for one very long homogeneous run (e.g. 4,000 "=" or letters takes seconds).
// Runs this long are counted in short chunks instead, which slightly over-estimates and is reported as `estimated`.
const LONG_RUN = /(?<![\p{L}\p{M}])[\p{L}\p{M}]{96,}|(?<![^\s\p{L}\p{M}\p{N}])[^\s\p{L}\p{M}\p{N}]{96,}|(?<!\s)\s{96,}/gu;
const CHUNK = 48;
/** Inputs up to this many UTF-16 units are counted exactly; larger ones are estimated from a deterministic sample. */
export const EXACT_INPUT_LIMIT = 256 * 1024;

export interface TokenCount { tokens: number; estimated: boolean }

export function countTokens(text: string): TokenCount {
  if (text.length < 96) return { tokens: tokens(text), estimated: false };
  let estimated = false, extra = 0;
  const chunks = new Map<string, number>(); // homogeneous runs consist of many identical chunks
  const rest = text.replace(LONG_RUN, run => {
    estimated = true;
    for (let i = 0; i < run.length; i += CHUNK) {
      const chunk = run.slice(i, i + CHUNK);
      let count = chunks.get(chunk);
      if (count === undefined) { count = tokens(chunk); chunks.set(chunk, count); }
      extra += count;
    }
    return '';
  });
  return { tokens: tokens(rest) + extra, estimated };
}

/** Token count of a possibly huge input: exact when small, otherwise scaled from every k-th line (deterministic). */
export function countInputTokens(text: string, lines: readonly string[]): TokenCount {
  if (text.length <= EXACT_INPUT_LIMIT) return countTokens(text);
  const stride = Math.ceil(text.length / (EXACT_INPUT_LIMIT / 3));
  const sample: string[] = [];
  let sampleChars = 0;
  for (let i = 0; i < lines.length; i += stride) {
    const line = lines[i].length > 2000 ? lines[i].slice(0, 2000) : lines[i];
    sample.push(line);
    sampleChars += line.length + 1;
  }
  if (sampleChars === 0) return { tokens: 0, estimated: true };
  const counted = countTokens(sample.join('\n'));
  return { tokens: Math.round(counted.tokens * (text.length / sampleChars)), estimated: true };
}
