import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { computeShownMetrics } from './metrics.js';
import type { RunRow } from './report.js';

/** Text the engines print above one-line pointers; its absence proves a pack contains no pointer entries. */
export const POINTER_MARKER = 'Also relevant (not shown)';

async function packText(out: string, row: RunRow): Promise<string | undefined> {
  try {
    return gunzipSync(await readFile(join(out, 'packs', row.variant, `${row.instance_id}.txt.gz`))).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Rows written before evidence carried `kind` have no `shownMetrics`. Recover them when that is provable:
 *  - the evidence has kinds: recompute from the evidence;
 *  - otherwise the saved pack text has no pointer section: every entry was shown, so the metrics are the existing ones;
 *  - otherwise `null`: the split is unknown and shown-only metrics are not reported for that variant.
 */
export async function backfillShownMetrics(out: string, rows: RunRow[]): Promise<RunRow[]> {
  const result: RunRow[] = [];
  for (const row of rows) {
    if (row.status !== 'ok' || row.shownMetrics !== undefined) {
      result.push(row);
      continue;
    }
    if (row.evidence.some(item => item.kind !== undefined)) {
      const gold = Object.entries(row.goldRanges).map(([path, ranges]) => ({ path, ranges }));
      result.push({ ...row, shownMetrics: computeShownMetrics(row.evidence, gold) });
      continue;
    }
    const text = await packText(out, row);
    result.push({ ...row, shownMetrics: text !== undefined && !text.includes(POINTER_MARKER) ? row.metrics : null });
  }
  return result;
}
