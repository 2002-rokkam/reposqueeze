// Single source of truth for turning text into searchable terms.
// Bump TOKENIZER_VERSION whenever terms() output changes: persisted indexes are keyed by it.
export const TOKENIZER_VERSION = 1;

const STOP_WORDS = new Set(
  'the a an is are of to for from in on at and or how what where when why does do can with this that it by be as return const let var def function class public private import export true false null none use implementation code'.split(' ')
);

/** Lower-cased words of a text; camelCase boundaries are split, one-letter words and stop words are dropped. */
export function terms(text: string): string[] {
  const split = text.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase();
  return (split.match(/[\p{L}\p{N}]+/gu) ?? []).filter(term => term.length > 1 && !STOP_WORDS.has(term));
}

export function isStopWord(term: string): boolean {
  return STOP_WORDS.has(term);
}
