import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface Tokenizer {
  readonly name: 'o200k_base';
  /** Exact o200k_base token count (see the chunked fallback below for pathological runs). */
  count(text: string): number;
  /** True when the last count() used the chunked upper-bound path. */
  readonly approximated: boolean;
}

// js-tiktoken's BPE is quadratic in the length of a single regex piece: a run of 8,000 identical
// letters takes about 10 s. Runs this long are counted in chunks, which can only over-count
// (merges never cross a chunk boundary), so a budget check stays conservative.
const LONG_RUN = /\S{1500,}/;
const CHUNK = 1000;

interface Encoder {
  encode(text: string, allowed?: string[], disallowed?: string[]): number[];
}

/**
 * Loads js-tiktoken from the variant's own node_modules so that counts match the code under test.
 * Falls back to the harness's copy only when the variant has none.
 */
export function loadTokenizer(variantRoot?: string): Tokenizer {
  const requireFrom = (base: string) => createRequire(join(base, 'package.json'));
  let encoder: Encoder | undefined;
  const errors: string[] = [];
  for (const base of [variantRoot, process.cwd()].filter((x): x is string => !!x)) {
    try {
      const mod = requireFrom(base)('js-tiktoken') as { getEncoding(name: string): Encoder };
      encoder = mod.getEncoding('o200k_base');
      break;
    } catch (error) {
      errors.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!encoder) throw new Error(`js-tiktoken not found (${errors.join('; ')})`);
  const enc = encoder;
  const encode = (text: string) => enc.encode(text, [], []).length;
  const tokenizer = {
    name: 'o200k_base' as const,
    approximated: false,
    count(text: string): number {
      if (!LONG_RUN.test(text)) {
        tokenizer.approximated = false;
        return encode(text);
      }
      tokenizer.approximated = true;
      let total = 0;
      for (const piece of text.split(/(\S{1500,})/)) {
        if (/^\S{1500,}$/.test(piece)) {
          for (let i = 0; i < piece.length; i += CHUNK) total += encode(piece.slice(i, i + CHUNK));
        } else if (piece) {
          total += encode(piece);
        }
      }
      return total;
    },
  };
  return tokenizer;
}
