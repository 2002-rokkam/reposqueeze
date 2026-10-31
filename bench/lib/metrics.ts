import { mergeRanges, type LineRange } from './gitdiff.js';

export interface EvidenceItem {
  path: string;
  start: number;
  end: number;
  id?: string;
  /** 'excerpt' | 'window' | 'known' | 'pointer' | 'duplicate' (engines that do not report it: undefined). */
  kind?: string;
}

export interface GoldSpec {
  path: string;
  ranges: LineRange[];
}

export const HIT_KS = [1, 3, 5, 10] as const;

export interface RetrievalMetrics {
  /** 1 when any gold file has at least one excerpt in the pack. */
  packFileHit: number;
  /** Fraction of gold files that have at least one excerpt. */
  packFileRecall: number;
  /** Fraction of gold lines (pre-image edit sites) inside pack excerpts. */
  goldLineRecall: number;
  /** 1 when at least one gold line is inside an excerpt. */
  packLineHit: number;
  /** Reciprocal rank of the first gold file among distinct files in order of first appearance in the evidence. */
  mrr: number;
  hit1: number;
  hit3: number;
  hit5: number;
  hit10: number;
  /** One-based rank of the first gold file in that order, or null when no gold file is packed. */
  firstGoldRank: number | null;
}

export const ZERO_METRICS: RetrievalMetrics = {
  packFileHit: 0, packFileRecall: 0, goldLineRecall: 0, packLineHit: 0, mrr: 0, hit1: 0, hit3: 0, hit5: 0, hit10: 0, firstGoldRank: null,
};

export function normalizePath(path: string): string {
  let value = path.replace(/\\/g, '/');
  while (value.startsWith('./')) value = value.slice(2);
  return value;
}

/** Distinct files in order of first appearance in the evidence list. */
export function distinctFiles(evidence: { path: string }[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const item of evidence) {
    const path = normalizePath(item.path);
    if (!seen.has(path)) {
      seen.add(path);
      files.push(path);
    }
  }
  return files;
}

/** Number of lines shared by two sorted, merged range lists. */
export function overlapLines(a: LineRange[], b: LineRange[]): number {
  let total = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i][0], b[j][0]);
    const end = Math.min(a[i][1], b[j][1]);
    if (end >= start) total += end - start + 1;
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return total;
}

const validRange = (item: EvidenceItem) => Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 1 && item.end >= item.start;

export function computeMetrics(evidence: EvidenceItem[], gold: GoldSpec[]): RetrievalMetrics {
  const goldByPath = new Map<string, LineRange[]>();
  for (const file of gold) goldByPath.set(normalizePath(file.path), mergeRanges([...(goldByPath.get(normalizePath(file.path)) ?? []), ...file.ranges]));
  if (!goldByPath.size) return { ...ZERO_METRICS };

  const files = distinctFiles(evidence);
  const packed = new Set(files);
  const matchedFiles = [...goldByPath.keys()].filter(path => packed.has(path));
  const firstIndex = files.findIndex(path => goldByPath.has(path));
  const rank = firstIndex < 0 ? null : firstIndex + 1;

  const rangesByPath = new Map<string, LineRange[]>();
  for (const item of evidence) {
    if (!validRange(item)) continue;
    const path = normalizePath(item.path);
    if (goldByPath.has(path)) rangesByPath.set(path, [...(rangesByPath.get(path) ?? []), [item.start, item.end]]);
  }
  let goldLines = 0;
  let coveredLines = 0;
  for (const [path, ranges] of goldByPath) {
    goldLines += ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
    coveredLines += overlapLines(ranges, mergeRanges(rangesByPath.get(path) ?? []));
  }

  const hitAt = (k: number) => (rank !== null && rank <= k ? 1 : 0);
  return {
    packFileHit: matchedFiles.length ? 1 : 0,
    packFileRecall: matchedFiles.length / goldByPath.size,
    goldLineRecall: goldLines ? coveredLines / goldLines : 0,
    packLineHit: coveredLines > 0 ? 1 : 0,
    mrr: rank === null ? 0 : 1 / rank,
    hit1: hitAt(1),
    hit3: hitAt(3),
    hit5: hitAt(5),
    hit10: hitAt(10),
    firstGoldRank: rank,
  };
}

/** Evidence that shows code to the reader: everything except one-line pointers ("Also relevant (not shown)"). */
export const shownEvidence = <T extends { kind?: string }>(evidence: T[]): T[] => evidence.filter(item => item.kind !== 'pointer');

/** The same metrics computed on shown evidence only (pointers carry a path and range but no code). */
export function computeShownMetrics(evidence: EvidenceItem[], gold: GoldSpec[]): RetrievalMetrics {
  return computeMetrics(shownEvidence(evidence), gold);
}
