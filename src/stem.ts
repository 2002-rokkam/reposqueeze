// Porter (1980) suffix-stripping stemmer, used so that "budgets" matches "budget" and "parsing" matches "parser".
// Operates on lower-case ASCII words only; anything else is returned unchanged.

const VOWELS = 'aeiou';

function isConsonant(word: string, index: number): boolean {
  const char = word[index];
  if (VOWELS.includes(char)) return false;
  if (char === 'y') return index === 0 ? true : !isConsonant(word, index - 1);
  return true;
}

// Number of vowel-consonant sequences in the stem word[0..end).
function measure(word: string, end: number): number {
  let count = 0;
  let i = 0;
  while (i < end && isConsonant(word, i)) i++;
  while (i < end) {
    while (i < end && !isConsonant(word, i)) i++;
    if (i >= end) break;
    count++;
    while (i < end && isConsonant(word, i)) i++;
  }
  return count;
}

function hasVowel(word: string, end: number): boolean {
  for (let i = 0; i < end; i++) if (!isConsonant(word, i)) return true;
  return false;
}

function endsDoubleConsonant(word: string, end: number): boolean {
  return end >= 2 && word[end - 1] === word[end - 2] && isConsonant(word, end - 1);
}

// consonant-vowel-consonant where the final consonant is not w, x or y
function endsCvc(word: string, end: number): boolean {
  if (end < 3 || !isConsonant(word, end - 1) || isConsonant(word, end - 2) || !isConsonant(word, end - 3)) return false;
  return !'wxy'.includes(word[end - 1]);
}

const STEP2: [string, string][] = [
  ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'], ['izer', 'ize'], ['abli', 'able'], ['alli', 'al'],
  ['entli', 'ent'], ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'], ['ator', 'ate'], ['alism', 'al'],
  ['iveness', 'ive'], ['fulness', 'ful'], ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
];
const STEP3: [string, string][] = [['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', '']];
const STEP4 = ['al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent', 'ion', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize'];

function replaceSuffix(word: string, table: readonly [string, string][]): string {
  // The longest matching suffix decides, even when its measure condition then fails.
  let best: [string, string] | undefined;
  for (const entry of table) if (word.endsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  if (!best) return word;
  const stem = word.slice(0, word.length - best[0].length);
  return measure(stem, stem.length) > 0 ? stem + best[1] : word;
}

export function stem(input: string): string {
  if (input.length < 3 || !/^[a-z]+$/.test(input)) return input;
  let word = input;

  // Step 1a
  if (word.endsWith('sses')) word = word.slice(0, -2);
  else if (word.endsWith('ies')) word = word.slice(0, -2);
  else if (word.endsWith('ss')) { /* unchanged */ }
  else if (word.endsWith('s')) word = word.slice(0, -1);

  // Step 1b
  let continued = false;
  if (word.endsWith('eed')) {
    if (measure(word, word.length - 3) > 0) word = word.slice(0, -1);
  } else if (word.endsWith('ed') && hasVowel(word, word.length - 2)) {
    word = word.slice(0, -2);
    continued = true;
  } else if (word.endsWith('ing') && hasVowel(word, word.length - 3)) {
    word = word.slice(0, -3);
    continued = true;
  }
  if (continued) {
    if (word.endsWith('at') || word.endsWith('bl') || word.endsWith('iz')) word += 'e';
    else if (endsDoubleConsonant(word, word.length) && !'lsz'.includes(word[word.length - 1])) word = word.slice(0, -1);
    else if (measure(word, word.length) === 1 && endsCvc(word, word.length)) word += 'e';
  }

  // Step 1c
  if (word.endsWith('y') && hasVowel(word, word.length - 1)) word = word.slice(0, -1) + 'i';

  word = replaceSuffix(word, STEP2);
  word = replaceSuffix(word, STEP3);

  // Step 4
  let suffix: string | undefined;
  for (const candidate of STEP4) if (word.endsWith(candidate) && (!suffix || candidate.length > suffix.length)) suffix = candidate;
  if (suffix) {
    const base = word.slice(0, word.length - suffix.length);
    if (measure(base, base.length) > 1 && (suffix !== 'ion' || /[st]$/.test(base))) word = base;
  }

  // Step 5
  if (word.endsWith('e')) {
    const base = word.slice(0, -1);
    const m = measure(base, base.length);
    if (m > 1 || (m === 1 && !endsCvc(base, base.length))) word = base;
  }
  if (measure(word, word.length) > 1 && endsDoubleConsonant(word, word.length) && word.endsWith('l')) word = word.slice(0, -1);
  return word;
}
