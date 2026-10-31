// Structural folding of a classified log into segments: exact duplicate runs, similar-line runs (templates), passing-test
// runs, collapsed library stack frames, CI boilerplate and "repeats of lines already shown" (template saturation).
// Every segment covers an exact, contiguous range of original lines, so line arithmetic stays checkable.
import { DrainMiner, type Cluster } from './drain.js';
import { Kind, Tier, type Classification } from './patterns.js';
import { looseKey, strictKey } from './normalize.js';

export type SegType = 'line' | 'dup' | 'run' | 'hidden' | 'pass' | 'frames' | 'noise' | 'block';

export interface Seg {
  /** Zero-based inclusive line range. */
  a: number;
  b: number;
  type: SegType;
  /** Rendered line, or the whole marker line for folds. */
  text: string;
  tier: number;
  /** Failure-signal lines covered by this segment. */
  signals: number;
  warns: number;
  /** True when the fold is exactly reversible (identical lines with an exact count). */
  exact: boolean;
  /** For a repeated failure line: index of the first segment with the same text (that segment carries a repeat note). */
  dupOf?: number;
  /** For a failure line: how many similar failure lines (same template) precede it; selection shows distinct templates first. */
  rank?: number;
}

export interface FoldResult {
  segs: Seg[];
  /** Template id per line (strict-key ids for protected lines, Drain clusters otherwise); -1 for blanks. */
  fid: Int32Array;
  clusters: readonly Cluster[];
  /** Human-readable template for a fold id. */
  describe(id: number): string;
  /** Number of distinct occurrences per id over the whole log. */
  frequency: Map<number, number>;
}

const STRICT_BASE = 0, CLUSTER_BASE = 1 << 24, LOOSE_BASE = 1 << 25;
const PROTECTED_MAX_TIER = Tier.Summary;
const HIDE_AFTER_PROTECTED = 2, HIDE_AFTER_OTHER = 2;
const MIN_RUN = 4, MIN_DUP = 3;
const MEMO_LIMIT = 250000;
const BLOCK_WINDOW = 6, MIN_BLOCK_LINES = 8, MIN_BLOCK_CHARS = 160;
const EDGE_HEAD = 3, EDGE_TAIL = 6;

const marker = (a: number, b: number, body: string) => `[... L${a + 1}-L${b + 1} (${b - a + 1} line${b > a ? 's' : ''}) ${body}]`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

const FRAME_LABELS: readonly (readonly [RegExp, number])[] = [
  [/node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/, 1], [/site-packages[\\/]([^\\/]+)/, 1], [/[\\/]gems[\\/]([A-Za-z0-9_.]+?)-\d/, 1],
  [/[\\/]vendor[\\/]([^\\/]+[\\/][^\\/]+)/, 1], [/\bat ((?:java|jdk|sun|javax|jakarta|org|com|io|net|kotlinx?|scala)\.[a-z0-9_]+(?:\.[a-z0-9_]+)?)/i, 1],
  [/\bat (System|Microsoft|Xunit|NUnit|MSTest)\b/, 1], [/^\s*(runtime|testing|reflect|sync|syscall|net\/http)\b/, 1], [/\b(java\.base)\//, 1]
];

function frameLabels(lines: readonly string[], a: number, b: number): string {
  const labels: string[] = [];
  for (let i = a; i <= b && labels.length < 3; i++) {
    for (const [re, group] of FRAME_LABELS) {
      const m = re.exec(lines[i]);
      if (m) { if (!labels.includes(m[group])) labels.push(m[group]); break; }
    }
  }
  return labels.length ? labels.join(', ') : 'framework internals';
}

function dotCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 46) count++;
  return count;
}

interface Repeat { source: number; length: number }

/**
 * Find multi-line blocks (stack traces, retry cycles, repeated test output) that repeat text seen earlier.
 * Windows of BLOCK_WINDOW strict-key ids are hashed; a verified match is extended as far as it goes (LZ77 style, so a
 * periodic pattern repeated many times is a single match). Runs of one repeated line are left to the duplicate/run folds.
 */
function findRepeats(sid: Int32Array, lines: readonly string[]): Map<number, Repeat> {
  const n = sid.length;
  const repeats = new Map<number, Repeat>();
  if (n < BLOCK_WINDOW * 2) return repeats;
  const firstSeen = new Map<number, number>();
  for (let i = 0; i + BLOCK_WINDOW <= n; ) {
    let hash = 17, distinct = false, nonBlank = 0;
    for (let t = 0; t < BLOCK_WINDOW; t++) {
      const id = sid[i + t];
      hash = (Math.imul(hash, 1000003) + id + 2) | 0;
      if (id !== sid[i]) distinct = true;
      if (id >= 0) nonBlank++;
    }
    if (!distinct || nonBlank < 3) { i++; continue; }
    const source = firstSeen.get(hash);
    if (source === undefined) { firstSeen.set(hash, i); i++; continue; }
    let equal = source + BLOCK_WINDOW <= i;
    for (let t = 0; equal && t < BLOCK_WINDOW; t++) if (sid[source + t] !== sid[i + t]) equal = false;
    if (!equal) { i++; continue; }
    let length = BLOCK_WINDOW;
    while (i + length < n && sid[i + length] === sid[source + length]) length++;
    let chars = 0, meaningful = 0;
    for (let t = 0; t < length; t++) { chars += lines[i + t].length + 1; if (sid[i + t] >= 0) meaningful++; }
    if (length >= MIN_BLOCK_LINES && chars >= MIN_BLOCK_CHARS && meaningful >= 4) {
      repeats.set(i, { source, length });
      i += length;
    } else i++;
  }
  return repeats;
}

/** Number each failure line by how many similar ones came before it, so that breadth (distinct templates) can be preferred. */
function rankFailureTemplates(segs: Seg[], sid: Int32Array, strictText: readonly string[]): void {
  const miner = new DrainMiner();
  const seen = new Map<number, number>();
  for (const seg of segs) {
    if (seg.type !== 'line' || seg.signals === 0 || seg.tier > Tier.Assertion || seg.dupOf !== undefined) continue;
    const key = looseKey(strictText[sid[seg.a] - STRICT_BASE]);
    const cluster = key === '' ? null : miner.add(key.split(' '));
    if (!cluster) continue;
    const rank = seen.get(cluster.id) ?? 0;
    seen.set(cluster.id, rank + 1);
    seg.rank = Math.min(rank, 60);
  }
}

/** Later copies of a failure line (same text up to volatile fields) point at the first copy, which gains a repeat note. */
function noteRepeatedFailures(segs: Seg[], fid: Int32Array): void {
  const first = new Map<number, number>();
  const later = new Map<number, number[]>();
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    if (seg.type !== 'line' || seg.signals === 0 || seg.tier > PROTECTED_MAX_TIER || seg.tier === Tier.AppFrame) continue;
    const id = fid[seg.a];
    const head = first.get(id);
    if (head === undefined) { first.set(id, s); continue; }
    seg.dupOf = head;
    const list = later.get(head);
    if (list) list.push(seg.a + 1); else later.set(head, [seg.a + 1]);
  }
  for (const [head, lines] of later) {
    const shown = lines.slice(0, 3).map(n => `L${n}`).join(', ');
    segs[head].text += `  [x${lines.length + 1} total; also ${shown}${lines.length > 3 ? `, +${lines.length - 3} more` : ''}]`;
  }
}

export function buildSegments(lines: readonly string[], cls: Classification): FoldResult {
  const n = lines.length;
  const { tier, kind, signal, warn } = cls;
  const fid = new Int32Array(n);
  const drain = new DrainMiner();
  const strictIds = new Map<string, number>(), looseIds = new Map<string, number>();
  const strictText: string[] = [], looseText: string[] = [];
  const frequency = new Map<number, number>();

  // Pass 1: a fold id per line, plus a strict-key id (equal up to timestamps, hashes, durations...) used for block repeats.
  const sid = new Int32Array(n);
  // Repeated lines are common (and adversarial inputs are mostly repeats), so ids are memoized by text and by strict id.
  const textToStrict = new Map<string, number>();
  const strictToCluster = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (kind[i] === Kind.Blank) { fid[i] = -1; sid[i] = -1; continue; }
    const text = lines[i];
    let known = textToStrict.get(text);
    if (known === undefined) {
      const strict = strictKey(text);
      known = strictIds.get(strict);
      if (known === undefined) { known = STRICT_BASE + strictIds.size; strictIds.set(strict, known); strictText.push(strict); }
      if (textToStrict.size < MEMO_LIMIT) textToStrict.set(text, known);
    }
    sid[i] = known;
    let id: number;
    if (tier[i] <= PROTECTED_MAX_TIER) {
      id = known;
    } else {
      let memo = strictToCluster.get(known);
      if (memo === undefined) {
        const key = looseKey(strictText[known - STRICT_BASE]);
        const cluster = key === '' ? null : drain.add(key.split(' '));
        if (cluster) memo = CLUSTER_BASE + cluster.id;
        else {
          let loose = looseIds.get(key);
          if (loose === undefined) { loose = LOOSE_BASE + looseIds.size; looseIds.set(key, loose); looseText.push(key); }
          memo = loose;
        }
        if (strictToCluster.size < MEMO_LIMIT) strictToCluster.set(known, memo);
      }
      id = memo;
    }
    fid[i] = id;
    frequency.set(id, (frequency.get(id) ?? 0) + 1);
  }
  const describe = (id: number): string => {
    if (id >= LOOSE_BASE) return looseText[id - LOOSE_BASE] ?? '';
    if (id >= CLUSTER_BASE) return drain.clusters[id - CLUSTER_BASE]?.template.join(' ') ?? '';
    return strictText[id - STRICT_BASE] ?? '';
  };

  // Edge lines (first and last few meaningful lines) are never hidden by saturation.
  const edge = new Uint8Array(n);
  for (let i = 0, seen = 0; i < n && seen < EDGE_HEAD; i++) if (kind[i] !== Kind.Blank && kind[i] !== Kind.Noise) { edge[i] = 1; seen++; }
  for (let i = n - 1, seen = 0; i >= 0 && seen < EDGE_TAIL; i--) if (kind[i] !== Kind.Blank && kind[i] !== Kind.Noise) { edge[i] = 1; seen++; }

  const repeats = findRepeats(sid, lines);
  const segs: Seg[] = [];
  const seen = new Map<number, number>();
  const note = (id: number, count: number) => { if (id >= 0) seen.set(id, (seen.get(id) ?? 0) + count); };

  const line = (i: number) => segs.push({ a: i, b: i, type: 'line', text: lines[i], tier: tier[i], signals: signal[i], warns: warn[i], exact: true });
  const sumOf = (arr: Uint8Array, a: number, b: number) => { let s = 0; for (let i = a; i <= b; i++) s += arr[i]; return s; };
  const foldTier = (i: number) => (tier[i] <= PROTECTED_MAX_TIER ? tier[i] : Tier.Fold);

  // Pending run of lines hidden because their template was already shown enough times.
  let hidA = -1, hidB = -1;
  const hidCounts = new Map<number, number>();
  const flushHidden = () => {
    if (hidA < 0) return;
    const count = hidB - hidA + 1;
    if (count >= MIN_RUN) {
      const top = [...hidCounts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3)
        .map(([id, c]) => `${c}x "${clip(describe(id), 64)}"`);
      const rest = hidCounts.size - top.length;
      const signals = sumOf(signal, hidA, hidB);
      segs.push({
        a: hidA, b: hidB, type: 'hidden', exact: false, signals, warns: sumOf(warn, hidA, hidB),
        text: marker(hidA, hidB, `repeats of lines shown earlier: ${top.join('; ')}${rest > 0 ? `; +${rest} more templates` : ''}`),
        tier: signals > 0 ? Tier.Assertion : Tier.Fold
      });
    } else for (let i = hidA; i <= hidB; i++) line(i);
    hidA = hidB = -1; hidCounts.clear();
  };
  const hide = (i: number) => {
    if (hidA < 0) hidA = i;
    hidB = i;
    hidCounts.set(fid[i], (hidCounts.get(fid[i]) ?? 0) + 1);
  };

  let i = 0;
  while (i < n) {
    const k = kind[i];
    if (k === Kind.Blank && !(i + 2 < n && lines[i + 1] === '' && lines[i + 2] === '')) { flushHidden(); line(i); i++; continue; }

    // 0. Repeated multi-line block (identical up to volatile fields) seen earlier.
    const repeat = repeats.get(i);
    if (repeat) {
      flushHidden();
      const end = i + repeat.length - 1, period = i - repeat.source;
      let exact = true;
      for (let t = 0; exact && t < repeat.length; t++) if (lines[i + t] !== lines[repeat.source + t]) exact = false;
      const body = period < repeat.length
        ? `repeat the ${period}-line pattern shown above ${Math.floor(repeat.length / period)} more time${repeat.length >= 2 * period ? 's' : ''}`
        : `repeat L${repeat.source + 1}-L${repeat.source + repeat.length}${exact ? ' exactly' : ' (same text up to timestamps/ids)'}`;
      const signals = sumOf(signal, i, end);
      segs.push({ a: i, b: end, type: 'block', exact, signals, warns: sumOf(warn, i, end), text: marker(i, end, body), tier: signals > 0 ? Tier.Assertion : Tier.Fold });
      for (let t = i; t <= end; t++) note(fid[t], 1);
      i = end + 1;
      continue;
    }

    // 1. Exact duplicate run: reversible, so it is folded even for protected lines.
    let j = i + 1;
    while (j < n && lines[j] === lines[i]) j++;
    const dup = j - i;
    if (dup >= MIN_DUP && (dup - 1) * (lines[i].length + 1) >= 48) {
      flushHidden();
      line(i);
      segs.push({
        a: i + 1, b: j - 1, type: 'dup', exact: true, signals: sumOf(signal, i + 1, j - 1), warns: sumOf(warn, i + 1, j - 1),
        text: marker(i + 1, j - 1, `identical to the line above, repeated ${dup} times total`),
        tier: k === Kind.Blank || k === Kind.Noise ? Tier.Dead : foldTier(i)
      });
      note(fid[i], dup);
      i = j;
      continue;
    }

    // 2. Kind-based runs: passing tests, library frames, CI boilerplate.
    if (k === Kind.Pass || k === Kind.SuitePass || k === Kind.Skip || k === Kind.PassNoise) {
      let e = i, passes = 0, suites = 0, skips = 0, counted = 0;
      for (let p = i; p < n; p++) {
        const pk = kind[p];
        if (pk === Kind.Pass) { passes += /^[.sxXpP\s]+|^[\w./\\-]+\.(?:py|rb)\s+[.sxXpP]+/.test(lines[p]) && !/[A-Za-z]{3,}/.test(lines[p].replace(/\.(?:py|rb)\b/, '').replace(/\[.*$/, '')) ? Math.max(1, dotCount(lines[p])) : 1; counted++; e = p; }
        else if (pk === Kind.SuitePass) { suites++; counted++; e = p; }
        else if (pk === Kind.Skip) { skips++; counted++; e = p; }
        else if (pk === Kind.PassNoise) e = p;
        else if (pk === Kind.Blank && p + 1 < n && (kind[p + 1] === Kind.Pass || kind[p + 1] === Kind.SuitePass || kind[p + 1] === Kind.Skip || kind[p + 1] === Kind.PassNoise)) e = p;
        else break;
      }
      if (counted >= 2 && e - i + 1 >= 3) {
        flushHidden();
        const parts: string[] = [];
        if (passes) parts.push(`${passes} tests passed`);
        if (suites) parts.push(`${suites} suites passed`);
        if (skips) parts.push(`${skips} skipped`);
        segs.push({ a: i, b: e, type: 'pass', exact: false, signals: 0, warns: 0, text: marker(i, e, parts.join(', ')), tier: Tier.Fold });
        for (let p = i; p <= e; p++) note(fid[p], 1);
        i = e + 1;
        continue;
      }
    }
    if (k === Kind.FrameLib || k === Kind.Noise) {
      let e = i;
      while (e + 1 < n && kind[e + 1] === k) e++;
      if (e - i + 1 >= 3) {
        flushHidden();
        const frames = k === Kind.FrameLib;
        segs.push({
          a: i, b: e, type: frames ? 'frames' : 'noise', exact: false, signals: 0, warns: sumOf(warn, i, e),
          text: marker(i, e, frames ? `library/framework frames: ${frameLabels(lines, i, e)}` : 'CI runner boilerplate'),
          tier: frames ? Tier.AppFrame : Tier.Dead
        });
        for (let p = i; p <= e; p++) note(fid[p], 1);
        i = e + 1;
        continue;
      }
    }

    // 3. Run of lines sharing a template id (similar lines, or protected lines equal up to volatile fields).
    const id = fid[i];
    if (id >= 0) {
      let e = i;
      while (e + 1 < n && fid[e + 1] === id && kind[e + 1] === k) e++;
      const len = e - i + 1;
      if (len >= MIN_RUN) {
        const total = seen.get(id) ?? 0;
        const limit = tier[i] <= PROTECTED_MAX_TIER ? HIDE_AFTER_PROTECTED : HIDE_AFTER_OTHER;
        if (total >= limit && !edge[i] && !edge[e]) {
          for (let p = i; p <= e; p++) hide(p);
        } else {
          flushHidden();
          line(i);
          segs.push({
            a: i + 1, b: e - 1, type: 'run', exact: false, signals: sumOf(signal, i + 1, e - 1), warns: sumOf(warn, i + 1, e - 1),
            text: marker(i + 1, e - 1, `similar lines folded; template: ${clip(describe(id), 120)}`), tier: foldTier(i)
          });
          line(e);
        }
        note(id, len);
        i = e + 1;
        continue;
      }
    }

    // 4. Single line: hide it when its template has been shown often enough, otherwise keep it.
    if (id >= 0) {
      const limit = tier[i] <= PROTECTED_MAX_TIER ? HIDE_AFTER_PROTECTED : HIDE_AFTER_OTHER;
      if ((seen.get(id) ?? 0) >= limit && !edge[i]) hide(i);
      else { flushHidden(); line(i); }
      note(id, 1);
    } else { flushHidden(); line(i); }
    i++;
  }
  flushHidden();
  noteRepeatedFailures(segs, fid);
  rankFailureTemplates(segs, sid, strictText);
  return { segs, fid, clusters: drain.clusters, describe, frequency };
}
