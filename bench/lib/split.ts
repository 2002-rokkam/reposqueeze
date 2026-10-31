import { createHash } from 'node:crypto';
import type { LoadedDataset } from './dataset.js';
import { cmp } from './util.js';

export type Split = 'dev' | 'test';

/** Shared across every benchmark lane: DEV iff the first byte of SHA-256("rsq-v3:" + id) is even. */
export const SPLIT_SALT = 'rsq-v3:';
export const SPLIT_RULE = 'dev iff the first byte of SHA-256("rsq-v3:" + instance_id) is even; otherwise held-out test';

export function splitOf(instanceId: string): Split {
  const firstByte = createHash('sha256').update(SPLIT_SALT + instanceId).digest()[0];
  return firstByte % 2 === 0 ? 'dev' : 'test';
}

export interface SplitsFile {
  version: 1;
  rule: string;
  salt: string;
  datasets: Record<string, {
    hfId: string;
    revision: string | null;
    contentSha256: string;
    counts: { total: number; dev: number; test: number };
    dev: string[];
    test: string[];
  }>;
}

export function buildSplitsFile(datasets: LoadedDataset[]): SplitsFile {
  const out: SplitsFile = { version: 1, rule: SPLIT_RULE, salt: SPLIT_SALT, datasets: {} };
  for (const dataset of [...datasets].sort((a, b) => cmp(a.key, b.key))) {
    const ids = [...new Set(dataset.instances.map(i => i.instanceId))].sort();
    const dev = ids.filter(id => splitOf(id) === 'dev');
    const test = ids.filter(id => splitOf(id) === 'test');
    out.datasets[dataset.key] = {
      hfId: dataset.hfId,
      revision: dataset.revision,
      contentSha256: dataset.contentSha256,
      counts: { total: ids.length, dev: dev.length, test: test.length },
      dev,
      test,
    };
  }
  return out;
}

/** Returns a list of human-readable problems; empty when the file agrees with the rule. */
export function verifySplitsFile(file: SplitsFile): string[] {
  const problems: string[] = [];
  if (file.salt !== SPLIT_SALT) problems.push(`salt is "${file.salt}", expected "${SPLIT_SALT}"`);
  for (const [key, entry] of Object.entries(file.datasets)) {
    for (const id of entry.dev) if (splitOf(id) !== 'dev') problems.push(`${key}: ${id} listed as dev but the rule says test`);
    for (const id of entry.test) if (splitOf(id) !== 'test') problems.push(`${key}: ${id} listed as test but the rule says dev`);
    if (entry.counts.dev !== entry.dev.length || entry.counts.test !== entry.test.length) problems.push(`${key}: counts do not match the lists`);
  }
  return problems;
}
