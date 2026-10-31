// Single source of truth for turning text into searchable terms.
//
// Version 2 (default) splits identifiers on camelCase, ACRONYMWord, snake_case and `$` boundaries, keeps the
// joined identifier as an extra exact-match term, stems words with the Porter stemmer and drops hash-like blobs.
// Version 1 reproduces the 2.1.0 behaviour (RSQ_TOKENIZER=v1) so benchmarks can report the difference.
// Persisted indexes are keyed by TOKENIZER_VERSION.
import { stem } from './stem.js';

const V1 = process.env.RSQ_TOKENIZER === 'v1';
export const TOKENIZER_VERSION = V1 ? 1 : 2;

const STOP_V1 = 'the a an is are of to for from in on at and or how what where when why does do can with this that it by be as return const let var def function class public private import export true false null none use implementation code'.split(' ');
const STOP_V2 = [
  ...STOP_V1,
  ...'if else elif then but so also should would could will shall may might must have has had been being was were am i my me we our you your he she they them their its into than too very just about which who whom here there once again further nor via per etc eg ie please thanks thank hello hi'.split(' '),
];
const STOP_WORDS = new Set(V1 ? STOP_V1 : STOP_V2);

const WORD = /[\p{L}\p{N}_$]+/gu;
const BOUNDARY = /(?<=[a-z\d])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|[_$]+/;
const HEX_BLOB = /^[a-fA-F0-9]{16,}$/;
const MAX_WORD = 48;

const stemCache = new Map<string, string>();
function cachedStem(word: string): string {
  let stemmed = stemCache.get(word);
  if (stemmed === undefined) {
    if (stemCache.size > 200_000) stemCache.clear();
    stemCache.set(word, (stemmed = stem(word)));
  }
  return stemmed;
}

function termsV1(text: string): string[] {
  const split = text.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase();
  return (split.match(/[\p{L}\p{N}]+/gu) ?? []).filter(term => term.length > 1 && !STOP_WORDS.has(term));
}

/** Searchable terms of a text, in order of appearance (duplicates kept: term frequency matters for ranking). */
export function terms(text: string): string[] {
  if (V1) return termsV1(text);
  const out: string[] = [];
  WORD.lastIndex = 0;
  for (let match = WORD.exec(text); match; match = WORD.exec(text)) {
    const raw = match[0];
    if (raw.length > MAX_WORD || HEX_BLOB.test(raw)) continue;
    const parts = /[A-Z_$]/.test(raw) ? raw.split(BOUNDARY).filter(Boolean) : [raw];
    let joined = '';
    for (const part of parts) {
      const word = part.toLowerCase();
      joined += word;
      if (word.length > 1 && !STOP_WORDS.has(word)) out.push(cachedStem(word));
    }
    if (parts.length > 1 && joined.length >= 6) out.push(joined);
  }
  return out;
}

export function isStopWord(term: string): boolean {
  return STOP_WORDS.has(term);
}
