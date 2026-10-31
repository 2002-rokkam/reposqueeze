import type { DatasetInstance } from './dataset.js';
import { goldFromDiff, parseUnifiedDiff, type GoldFile, type SkipReason } from './gitdiff.js';
import { instanceLanguage, kindOfPath } from './lang.js';
import { goldMentions, type Mentions } from './mentions.js';
import { splitOf, type Split } from './split.js';

export type InstanceSkipReason =
  | 'row_truncated'
  | 'empty_patch'
  | 'only_new_files'
  | 'only_test_files'
  | 'no_content_change'
  | 'no_gold_files';

export interface PreparedInstance {
  instanceId: string;
  repo: string;
  baseCommit: string;
  createdAt: string;
  datasets: string[];
  split: Split;
  statement: string;
  gold: GoldFile[];
  goldLines: number;
  language: string;
  /** At least one gold file is source code (not docs/config). */
  hasCodeGold: boolean;
  mentions: Mentions;
  /** Files of the patch that were not used as gold, with the reason (diagnostics only). */
  ignoredFiles: { path: string; reason: SkipReason }[];
}

export type PrepareResult = { ok: true; instance: PreparedInstance } | { ok: false; reason: InstanceSkipReason; detail: string };

function emptyGoldReason(ignored: { reason: SkipReason }[]): InstanceSkipReason {
  if (!ignored.length) return 'empty_patch';
  const reasons = new Set(ignored.map(f => f.reason));
  if (reasons.size === 1) {
    const [only] = reasons;
    if (only === 'new_file') return 'only_new_files';
    if (only === 'test_file') return 'only_test_files';
    if (only === 'no_content_change') return 'no_content_change';
  }
  return 'no_gold_files';
}

export function prepareInstance(instance: DatasetInstance): PrepareResult {
  if (instance.truncatedCells.some(cell => cell === 'patch' || cell === 'problem_statement')) {
    return { ok: false, reason: 'row_truncated', detail: instance.truncatedCells.join(',') };
  }
  const files = parseUnifiedDiff(instance.patch);
  const { gold, skipped } = goldFromDiff(files);
  if (!gold.length) {
    return { ok: false, reason: emptyGoldReason(skipped), detail: skipped.map(s => `${s.reason}:${s.path}`).join(' ').slice(0, 300) };
  }
  const goldPaths = gold.map(g => g.path);
  return {
    ok: true,
    instance: {
      instanceId: instance.instanceId,
      repo: instance.repo,
      baseCommit: instance.baseCommit,
      createdAt: instance.createdAt,
      datasets: instance.datasets,
      split: splitOf(instance.instanceId),
      statement: instance.problemStatement,
      gold,
      goldLines: gold.reduce((sum, g) => sum + g.lineCount, 0),
      language: instanceLanguage(goldPaths, instance.repo),
      hasCodeGold: goldPaths.some(path => kindOfPath(path) === 'code'),
      mentions: goldMentions(instance.problemStatement, goldPaths),
      ignoredFiles: skipped,
    },
  };
}

export interface SelectionStats {
  total: number;
  selected: number;
  skipped: Partial<Record<InstanceSkipReason, number>>;
}

/** Prepares every instance of the requested split only; held-out instances are never parsed. */
export function prepareSplit(instances: DatasetInstance[], split: Split | 'all') {
  const prepared: PreparedInstance[] = [];
  const skipped: { instanceId: string; reason: InstanceSkipReason; detail: string }[] = [];
  let considered = 0;
  for (const instance of instances) {
    if (split !== 'all' && splitOf(instance.instanceId) !== split) continue;
    considered++;
    const result = prepareInstance(instance);
    if (result.ok) prepared.push(result.instance);
    else skipped.push({ instanceId: instance.instanceId, reason: result.reason, detail: result.detail });
  }
  const counts: Partial<Record<InstanceSkipReason, number>> = {};
  for (const item of skipped) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  return { prepared, skipped, stats: { total: considered, selected: prepared.length, skipped: counts } as SelectionStats };
}
