// Budget-aware importance selection over folded segments.
// Priority tiers (lower first): root error, failing test, assertion, application frame, summary, first/last lines,
// failure context, warnings, fold markers, everything else (rarest templates first), dead weight (blanks, boilerplate).
import { Kind, Tier } from './patterns.js';
import type { Seg } from './fold.js';

export interface SelectionInput {
  segs: readonly Seg[];
  /** Per original line. */
  kind: Uint8Array;
  fid: Int32Array;
  costOf: (text: string) => number;
  /** First lines are only anchors in logs that do not start with CI runner boilerplate. */
  edgeHead: number;
}

export interface Selection {
  selected: Uint8Array;
  /** Selected segment indices from most to least important (used to trim when exact token counting disagrees). */
  order: number[];
}

// How many neighbouring segments become failure context: the cause usually precedes an exit/summary line,
// the detail follows a failing-test header.
const CONTEXT_BEFORE: Record<number, number> = { [Tier.RootError]: 2, [Tier.FailingTest]: 1, [Tier.Assertion]: 2, [Tier.Summary]: 5 };
const CONTEXT_AFTER: Record<number, number> = { [Tier.RootError]: 3, [Tier.FailingTest]: 8, [Tier.Assertion]: 2, [Tier.Summary]: 1 };
const EDGE_TAIL = 6;

export function segmentPriorities(input: SelectionInput): Int32Array {
  const { segs, kind, fid } = input;
  const m = segs.length;
  const prio = new Int32Array(m);

  // Distance (in segments) to the nearest failure line, or to the end of the log when nothing matched a failure pattern.
  const dist = new Int32Array(m).fill(1 << 20);
  let anchors = 0;
  for (let s = 0; s < m; s++) if (segs[s].signals > 0 && segs[s].tier <= Tier.Summary) { dist[s] = 0; anchors++; }
  if (anchors === 0 && m > 0) dist[m - 1] = 0;
  for (let s = 1; s < m; s++) dist[s] = Math.min(dist[s], dist[s - 1] + 1);
  for (let s = m - 2; s >= 0; s--) dist[s] = Math.min(dist[s], dist[s + 1] + 1);

  // Breadth-first inside the assertion and frame tiers so that every failure gets some detail before any failure gets all of it:
  // assertion lines rank by their position inside the current failure block, frames by distance to the nearest failure line.
  const failureDist = new Int32Array(m).fill(1 << 20);
  for (let s = 0; s < m; s++) if (segs[s].tier <= Tier.Assertion && segs[s].signals > 0) failureDist[s] = 0;
  for (let s = 1; s < m; s++) failureDist[s] = Math.min(failureDist[s], failureDist[s - 1] + 1);
  for (let s = m - 2; s >= 0; s--) failureDist[s] = Math.min(failureDist[s], failureDist[s + 1] + 1);
  let blockRank = 0;

  const seenTemplates = new Set<number>();
  for (let s = 0; s < m; s++) {
    const seg = segs[s];
    let tier: number = seg.tier;
    let sub = 0;
    if (tier <= Tier.FailingTest) { blockRank = 0; sub = seg.rank ?? 0; }
    else if (tier === Tier.Assertion) sub = Math.max(Math.min(blockRank++, 60), seg.rank ?? 0);
    else if (tier === Tier.AppFrame) sub = Math.min(failureDist[s], 60);
    if (seg.type === 'line' && tier >= Tier.Warning) {
      const id = fid[seg.a];
      const first = id >= 0 && !seenTemplates.has(id);
      if (id >= 0) seenTemplates.add(id);
      // Repeated warnings are deduplicated: later occurrences compete with ordinary lines.
      if (tier === Tier.Warning && !first) tier = Tier.Rest;
      if (tier === Tier.Rest) sub = first ? Math.min(55, dist[s]) : 60;
    }
    prio[s] = tier * 100 + sub;
  }

  const meaningful = (s: number) => kind[segs[s].a] !== Kind.Blank && kind[segs[s].a] !== Kind.Noise && /[A-Za-z0-9_]{3}/.test(segs[s].text);
  for (let s = 0, seen = 0; s < m && seen < input.edgeHead; s++) if (segs[s].type === 'line' && meaningful(s)) { prio[s] = Math.min(prio[s], Tier.Edge * 100); seen++; }
  for (let s = m - 1, seen = 0; s >= 0 && seen < EDGE_TAIL; s--) if (meaningful(s)) { prio[s] = Math.min(prio[s], Tier.Edge * 100 + 1); seen++; }

  for (let s = 0; s < m; s++) {
    const seg = segs[s];
    if (seg.signals === 0 || seg.tier > Tier.Summary) continue;
    const before = CONTEXT_BEFORE[seg.tier] ?? 0, after = CONTEXT_AFTER[seg.tier] ?? 0;
    for (let d = 1; d <= Math.max(before, after); d++) {
      const level = Tier.Context * 100 + d;
      if (d <= before && s - d >= 0 && prio[s - d] > level && segs[s - d].tier >= Tier.Warning) prio[s - d] = level;
      if (d <= after && s + d < m && prio[s + d] > level && segs[s + d].tier >= Tier.Warning) prio[s + d] = level;
    }
  }
  return prio;
}

/** Include small gaps whose content costs less than the omission marker that would replace them. */
function fillSmallGaps(input: SelectionInput, selected: Uint8Array, markerCost: number): void {
  const m = input.segs.length;
  let s = 0;
  while (s < m) {
    if (selected[s]) { s++; continue; }
    let e = s;
    while (e + 1 < m && !selected[e + 1]) e++;
    if (e - s < 3) {
      let total = 0;
      for (let t = s; t <= e; t++) total += input.costOf(input.segs[t].text);
      if (total <= markerCost - 6) for (let t = s; t <= e; t++) selected[t] = 1;
    }
    s = e + 1;
  }
}

/**
 * Greedy fill by priority until `tokenBudget` (net of header and section annotations) is used. Every gap of omitted
 * segments costs an omission marker, so the marginal cost of a segment includes the change in the number of gaps.
 * Ordinary filler lines (warnings, fold markers and everything below) are capped at `restCap` tokens: the budget is a
 * ceiling, not a target.
 */
export function chooseSegments(input: SelectionInput, tokenBudget: number, markerCost: number, restCap: number): Selection {
  const { segs, costOf } = input;
  const m = segs.length;
  const prio = segmentPriorities(input);
  const buckets = new Map<number, number[]>();
  for (let s = 0; s < m; s++) {
    // Repeated failure lines are represented by the repeat note on their first copy.
    if (segs[s].dupOf !== undefined) continue;
    const list = buckets.get(prio[s]);
    if (list) list.push(s); else buckets.set(prio[s], [s]);
  }
  const keys = [...buckets.keys()].sort((x, y) => x - y);

  const selected = new Uint8Array(m);
  let used = m > 0 ? markerCost : 0; // nothing selected yet: one gap covering everything
  const tryAdd = (s: number): boolean => {
    const left = s > 0 && !selected[s - 1], right = s < m - 1 && !selected[s + 1];
    const extra = costOf(segs[s].text) + ((left ? 1 : 0) + (right ? 1 : 0) - 1) * markerCost;
    if (used + extra > tokenBudget) return false;
    selected[s] = 1;
    used += extra;
    return true;
  };

  // The final outcome (exit code, summary counts) must not be crowded out by stack frames: reserve a small slice for it.
  const reserveCap = Math.floor(tokenBudget * 0.1);
  let reserved = 0;
  for (let s = m - 1, taken = 0; s >= 0 && taken < 6; s--) {
    if (segs[s].tier !== Tier.Summary || segs[s].type !== 'line') continue;
    const before = used;
    if (reserved + costOf(segs[s].text) > reserveCap || !tryAdd(s)) continue;
    reserved += used - before;
    taken++;
  }

  let restSpent = 0;
  outer: for (const key of keys) {
    const filler = key >= Tier.Warning * 100;
    let misses = 0;
    for (const s of buckets.get(key)!) {
      if (filler && restSpent >= restCap) break;
      if (selected[s]) continue;
      const before = used;
      if (tryAdd(s)) { if (filler) restSpent += used - before; misses = 0; }
      else if (tokenBudget - used < 3) break outer;
      else if (++misses > 64) break;
    }
  }
  fillSmallGaps(input, selected, markerCost);
  const order: number[] = [];
  for (let s = 0; s < m; s++) if (selected[s]) order.push(s);
  order.sort((x, y) => prio[x] - prio[y] || x - y);
  return { selected, order };
}
