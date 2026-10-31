// Line-level text hygiene and volatile-token normalization for log compaction.
// Every regular expression here is anchored on a literal/class prefix or uses lookbehind guards so that a hostile
// line (very long runs, nested separators) cannot trigger super-linear backtracking; callers also cap line length.

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]|\u001b/g;
// Control characters except \t \n \r (carriage returns are resolved separately).
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f\ufeff]/g;
// Anything that needs more than trimming: carriage returns, escapes and the control characters above.
const NEEDS_CLEANING = /[\u0000-\u0008\u000b-\u001f\u007f\ufeff]/;

export interface CleanedLine { text: string; redraws: number }

/** Resolve terminal control sequences: only the text after the last carriage return survives a progress redraw. */
export function cleanLine(raw: string): CleanedLine {
  if (!NEEDS_CLEANING.test(raw)) return { text: raw.trimEnd(), redraws: 0 };
  let line = raw;
  let redraws = 0;
  if (line.includes('\r')) {
    const parts = line.split('\r');
    let last = parts.length - 1;
    while (last > 0 && parts[last].trim() === '') last--;
    redraws = parts.slice(0, last).filter(part => part.trim() !== '').length;
    line = parts[last];
  }
  if (line.includes('\u001b')) line = line.replace(ANSI, '');
  line = line.replace(CONTROL, '');
  return { text: line.trimEnd(), redraws };
}

const HOMOGENEOUS_RUN = /([^\n])\1{119,}/g;

/** Collapse absurdly long runs of one character (separators, padding) so they cannot dominate token counts. */
export function squashRuns(text: string): string {
  if (text.length < 120) return text;
  return text.replace(HOMOGENEOUS_RUN, (run, char: string) => `${char.repeat(24)}[x${run.length}]`);
}

/** Keep the head and tail of an over-long line; the elided length is stated explicitly. */
export function capLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.floor(max / 4), head = max - tail;
  return `${text.slice(0, head)} [...${text.length - max} chars omitted...] ${text.slice(text.length - tail)}`;
}

// --- volatile token normalization -------------------------------------------------------------------------------

const MONTH = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const DAY = 'Mon|Tue|Wed|Thu|Fri|Sat|Sun';
const HEX = '[0-9a-fA-F]';

// Applied to every line, including failure lines: these tokens never carry diagnostic meaning.
const STRICT: readonly (readonly [RegExp, string])[] = [
  [/\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:\s?(?:Z|UTC|GMT|[+-]\d{2}:?\d{2}))?/g, '<TS>'],
  [new RegExp(`(?:${DAY}),?\\s+\\d{1,2}\\s+(?:${MONTH})\\s+\\d{4}\\s+\\d{2}:\\d{2}:\\d{2}(?:\\s?[A-Z]{3}|\\s?[+-]\\d{4})?`, 'g'), '<TS>'],
  [new RegExp(`(?:${DAY})\\s+(?:${MONTH})\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}(?:\\s+\\d{4})?`, 'g'), '<TS>'],
  [new RegExp(`(?<![A-Za-z])(?:${MONTH})\\s{1,2}\\d{1,2}\\s\\d{2}:\\d{2}:\\d{2}`, 'g'), '<TS>'],
  [/(?<![\d-])\d{4}-\d{2}-\d{2}(?![\d-])/g, '<DATE>'],
  [/(?<![\d:.])\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?![\d:])/g, '<TIME>'],
  [new RegExp(`(?<![\\w-])${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12}(?![\\w-])`, 'g'), '<UUID>'],
  [/(?<![\w])0x[0-9a-fA-F]{2,}(?![\w])/g, '<HEX>'],
  // Git/Docker style digests: lowercase hex with at least one digit and one letter, so plain words never match.
  [/(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}(?![\w-])/g, '<HASH>'],
  [/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])(?::\d{1,5})?/g, '<IP>'],
  [/(?<![\w.])\d+(?:\.\d+)?\s?(?:ms|µs|us|ns|sec|secs|seconds?|min|mins|minutes?|hrs?|hours?|s|h)(?![\w])/g, '<DUR>'],
  [/(?<![\w.])\d+h\d+m(?:\d+s)?(?![\w])|(?<![\w.])\d+m\d+(?:\.\d+)?s(?![\w])/g, '<DUR>'],
  [/(?<![\w.])\d+(?:\.\d+)?\s?(?:[KMGTP]i?B|bytes?)(?![\w])/g, '<SIZE>'],
  [/(?<![\w.])\d+(?:\.\d+)?\s?%/g, '<PCT>'],
  [/\b(pid|PID|ppid|tid|TID)([ =:#]+)\d+/g, '$1$2<N>'],
  [/(?<=\/|\\)tmp[a-z0-9_]{6,}(?![\w])|(?<=go-build)\d+/g, '<RAND>'],
  [/[\u2800-\u28ff]/g, '']
];

// Applied only to lines that are safe to template: plain integers, ratios, locations and opaque identifiers.
const LOOSE: readonly (readonly [RegExp, string])[] = [
  [/(?<![\w.])\d+(?:\.\d+)?\/\d+(?:\.\d+)?(?![\w.])/g, '<N>/<N>'],
  [/(?<=[\w)\]]):\d+(?::\d+)?(?![\w])/g, ':<N>'],
  [/(?<![\w.<-])\d+(?:\.\d+)*(?![\w>])/g, '<N>'],
  [/\(\d+,\d+\)/g, '(<N>,<N>)']
];
const OPAQUE_ID = /(?<![\w-])[A-Za-z0-9_-]{20,}(?![\w-])/g;
const PROGRESS_BAR = /[[|(][=#>█▉▊▋▌▍▎▏░▒▓*_.\-\s]{10,}[\]|)]/g;

// One cheap scan decides which of the (comparatively slow) regular expressions can possibly match; the flags are a
// conservative superset, so gating never changes the result.
const F_DIGIT = 1, F_COLON = 2, F_DATESEP = 4, F_HEX0X = 8, F_HEXRUN = 16, F_DOTS3 = 32, F_UNIT = 64, F_PCT = 128, F_PID = 256,
  F_TMP = 512, F_BRAILLE = 1024, F_BAR = 2048, F_LONGID = 4096, F_SLASH = 8192, F_PAREN = 16384;

function scanFlags(text: string): number {
  let flags = 0, hexRun = 0, idRun = 0, dots = 0, afterDigit = 0, opener = false, barChar = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const digit = c >= 48 && c <= 57;
    const hex = digit || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
    const word = digit || (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 45;
    hexRun = hex ? hexRun + 1 : 0;
    idRun = word ? idRun + 1 : 0;
    if (hexRun === 7) flags |= F_HEXRUN;
    if (idRun === 20) flags |= F_LONGID;
    if (digit) { flags |= F_DIGIT; afterDigit = 2; continue; }
    if (c === 58) flags |= F_COLON;
    else if (c === 45 || c === 47) flags |= c === 47 ? F_DATESEP | F_SLASH : F_DATESEP;
    else if (c === 46) { if (++dots === 3) flags |= F_DOTS3; }
    else if (c === 37) flags |= F_PCT;
    else if (c === 40) flags |= F_PAREN;
    else if (c === 120 && i > 0 && text.charCodeAt(i - 1) === 48) flags |= F_HEX0X;
    else if (c >= 0x2800 && c <= 0x28ff) flags |= F_BRAILLE;
    if (afterDigit > 0 && (c === 37 || c > 64 || c === 32)) flags |= F_UNIT;
    afterDigit = c === 32 && afterDigit === 2 ? 1 : 0;
    if (c === 91 || c === 124 || c === 40) opener = true;
    else if (c === 61 || c === 35 || c === 62 || c === 42 || c === 95 || c === 46 || c === 45 || (c >= 0x2588 && c <= 0x2593)) barChar = true;
  }
  if (opener && barChar && text.length >= 12) flags |= F_BAR;
  if (text.includes('tmp') || text.includes('go-build')) flags |= F_TMP;
  if (flags & F_DIGIT && (text.includes('pid') || text.includes('PID') || text.includes('tid') || text.includes('TID'))) flags |= F_PID;
  return flags;
}

const STRICT_TS = STRICT.slice(0, 4), STRICT_DATE = STRICT[4], STRICT_TIME = STRICT[5], STRICT_UUID = STRICT[6], STRICT_HEX0X = STRICT[7],
  STRICT_HASH = STRICT[8], STRICT_IP = STRICT[9], STRICT_UNIT = STRICT.slice(10, 13), STRICT_PCT = STRICT[13], STRICT_PID = STRICT[14],
  STRICT_TMP = STRICT[15], STRICT_BRAILLE = STRICT[16];
const apply = (key: string, rule: readonly [RegExp, string]) => key.replace(rule[0], rule[1]);

/** Replace volatile fields that never carry diagnostic meaning (timestamps, ids, addresses, durations...). Plain integers stay. */
export function strictKey(text: string): string {
  const flags = scanFlags(text);
  let key = text;
  if (flags & F_DIGIT) {
    if (flags & F_COLON) for (const rule of STRICT_TS) key = apply(key, rule);
    if (flags & F_DATESEP) key = apply(key, STRICT_DATE);
    if (flags & F_COLON) key = apply(key, STRICT_TIME);
    if (flags & F_DATESEP && text.length >= 36) key = apply(key, STRICT_UUID);
    if (flags & F_HEX0X) key = apply(key, STRICT_HEX0X);
    if (flags & F_HEXRUN) key = apply(key, STRICT_HASH);
    if (flags & F_DOTS3) key = apply(key, STRICT_IP);
    if (flags & F_UNIT) for (const rule of STRICT_UNIT) key = apply(key, rule);
    if (flags & F_PCT) key = apply(key, STRICT_PCT);
    if (flags & F_PID) key = apply(key, STRICT_PID);
  }
  if (flags & F_TMP) key = apply(key, STRICT_TMP);
  if (flags & F_BRAILLE) key = apply(key, STRICT_BRAILLE);
  if (flags & F_BAR) key = key.replace(PROGRESS_BAR, '<BAR>');
  return key.replace(/\s+/g, ' ').trim();
}

/** Additionally fold plain integers, ratios, locations and opaque identifiers; takes a strict key. */
export function looseKey(strict: string): string {
  const flags = scanFlags(strict);
  let key = strict;
  if (flags & F_DIGIT) {
    if (flags & F_SLASH) key = apply(key, LOOSE[0]);
    if (flags & F_COLON) key = apply(key, LOOSE[1]);
    key = apply(key, LOOSE[2]);
    if (flags & F_PAREN) key = apply(key, LOOSE[3]);
  }
  if (flags & F_LONGID) key = key.replace(OPAQUE_ID, id => (id.replace(/\D/g, '').length >= 4 && /[a-z]/.test(id) && /[A-Z]/.test(id) ? '<ID>' : id));
  return key;
}

/** Normalize volatile fields so lines that differ only in noise share a key (`loose` also folds plain numbers). */
export function normalizeKey(text: string, level: 'strict' | 'loose'): string {
  const strict = strictKey(text);
  return level === 'strict' ? strict : looseKey(strict);
}

// --- line prefixes (timestamps, GitHub Actions job/step columns) ---------------------------------------------------

export interface Prefix { job?: string; step?: string; stamp?: string }
export interface PrefixPlan { kind: 'gha' | 'timestamp'; label: string; strip(line: string): { body: string; prefix: Prefix | null } }

const GHA = /^([^\t]{1,400})\t([^\t]{1,300})\t(?:(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?)?/;
const STAMP_FORMS: readonly { label: string; re: RegExp }[] = [
  { label: 'ISO-8601 timestamps', re: /^\[?(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?)\]?[ \t:-]*/ },
  { label: 'slash timestamps', re: /^\[?(\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d(?:[.,]\d+)?)\]?[ \t:-]*/ },
  { label: 'syslog timestamps', re: new RegExp(`^((?:${MONTH}) {1,2}\\d{1,2} \\d\\d:\\d\\d:\\d\\d) `) },
  { label: 'clock times', re: /^\[?(\d\d:\d\d:\d\d(?:[.,]\d+)?)\]?[ \t]+/ },
  { label: 'epoch offsets', re: /^\[\s*(\d+\.\d{3,6})\]\s/ }
];

/** Evenly spaced sample of non-empty lines, so detection stays O(1) in the input size. */
function sampleLines(lines: readonly string[], size = 400): string[] {
  const stride = Math.max(1, Math.floor(lines.length / size));
  const sample: string[] = [];
  for (let i = 0; i < lines.length && sample.length < size; i += stride) if (lines[i] !== '') sample.push(lines[i]);
  return sample;
}

export function detectPrefix(lines: readonly string[]): PrefixPlan | null {
  const sample = sampleLines(lines);
  if (sample.length < 3) return null;
  // Share of sampled lines whose prefix match defines the given capture group (the timestamp).
  const share = (re: RegExp, group: number) =>
    sample.filter(line => re.exec(line)?.[group] !== undefined).length / sample.length;
  if (share(GHA, 3) >= 0.6) {
    // Remember which job/step column pairs were seen with a timestamp so tab-separated data is never mistaken for a prefix.
    const known = new Set<string>();
    for (const line of lines) {
      const m = GHA.exec(line);
      if (m && m[3] !== undefined) known.add(`${m[1]}\t${m[2]}`);
      if (known.size > 4096) break;
    }
    return {
      kind: 'gha', label: 'job/step/timestamp prefixes',
      strip(line) {
        const m = GHA.exec(line);
        if (!m || !known.has(`${m[1]}\t${m[2]}`)) return { body: line, prefix: null };
        return { body: line.slice(m[0].length), prefix: { job: m[1], step: m[2], stamp: m[3] } };
      }
    };
  }
  let best: { label: string; re: RegExp; ratio: number } | null = null;
  for (const form of STAMP_FORMS) {
    const ratio = share(form.re, 1);
    if (ratio >= 0.6 && (!best || ratio > best.ratio)) best = { ...form, ratio };
  }
  if (!best) return null;
  const { re, label } = best;
  return {
    kind: 'timestamp', label,
    strip(line) {
      const m = re.exec(line);
      return m ? { body: line.slice(m[0].length), prefix: { stamp: m[1] } } : { body: line, prefix: null };
    }
  };
}

// --- CI workspace paths -------------------------------------------------------------------------------------------------

const WORKSPACE_FORMS: readonly RegExp[] = [
  /\/home\/runner\/work\/([^/\s]+)\/\1\//g, /\/Users\/runner\/work\/([^/\s]+)\/\1\//g, /\/__w\/([^/\s]+)\/\1\//g,
  /[A-Za-z]:\\a\\([^\\\s]+)\\\1\\/g, /\/home\/vsts\/work\/\d+\/s\//g, /\/github\/workspace\//g
];

/** The most frequent CI checkout directory (e.g. /home/runner/work/app/app/) mentioned in the log, if it is mentioned often enough. */
export function detectWorkspacePrefix(lines: readonly string[]): string | null {
  const counts = new Map<string, number>();
  const limit = Math.min(lines.length, 6000);
  for (let i = 0; i < limit; i++) {
    const line = lines[i < 3000 ? i : lines.length - (limit - i)];
    if (line.length < 12 || (!line.includes('/') && !line.includes('\\'))) continue;
    for (const re of WORKSPACE_FORMS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    }
  }
  let best: string | null = null, bestCount = 3;
  for (const [prefix, count] of counts) if (count > bestCount || (count === bestCount && best !== null && prefix < best)) { best = prefix; bestCount = count; }
  return best;
}

export function shortenPrefix(line: string, prefix: string): string {
  return line.includes(prefix) ? line.split(prefix).join(prefix.includes('\\') ? '.\\' : './') : line;
}

// --- go test -json -------------------------------------------------------------------------------------------------------

interface GoTestEvent { Action?: unknown; Package?: unknown; Test?: unknown; Output?: unknown; Elapsed?: unknown }

/**
 * Convert one `go test -json` event line into the equivalent `go test -v` text line, so that the usual pass folding and
 * failure detection apply (a JSON wrapper costs ~40 tokens per event). Returns null for anything else.
 */
export function goTestEventToText(line: string): string | null {
  if (line.charCodeAt(0) !== 123 || !(line.startsWith('{"Time":') || line.startsWith('{"Action":')) || !line.includes('"Action"')) return null;
  let event: GoTestEvent;
  try { event = JSON.parse(line) as GoTestEvent; } catch { return null; }
  if (typeof event.Action !== 'string') return null;
  const test = typeof event.Test === 'string' ? event.Test : '';
  const pkg = typeof event.Package === 'string' ? event.Package : '';
  const elapsed = typeof event.Elapsed === 'number' ? event.Elapsed.toFixed(2) : '0.00';
  switch (event.Action) {
    case 'output': return typeof event.Output === 'string' ? event.Output.replace(/\r?\n$/, '') : null;
    case 'run': case 'start': return `=== RUN   ${test || pkg}`;
    case 'pause': return `=== PAUSE ${test}`;
    case 'cont': return `=== CONT  ${test}`;
    case 'pass': return test ? `--- PASS: ${test} (${elapsed}s)` : `ok  \t${pkg}\t${elapsed}s`;
    case 'fail': return test ? `--- FAIL: ${test} (${elapsed}s)` : `FAIL\t${pkg}\t${elapsed}s`;
    case 'skip': return test ? `--- SKIP: ${test} (${elapsed}s)` : `?   \t${pkg}\t[no test files]`;
    default: return null;
  }
}
