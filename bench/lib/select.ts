import { createHash } from 'node:crypto';
import type { PreparedInstance } from './gold.js';
import { cmp } from './util.js';

export type SampleMode = 'even' | 'proportional';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export function instanceTime(instance: Pick<PreparedInstance, 'createdAt'>): number {
  const value = instance.createdAt.includes('T') ? instance.createdAt : instance.createdAt.replace(' ', 'T') + 'Z';
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

/** Deterministic execution order: repository, then base-commit age (PR creation time as a proxy), then id. */
export function sortInstances<T extends PreparedInstance>(instances: T[], commitTimes?: Map<string, number>): T[] {
  const time = (i: T) => (commitTimes?.get(i.baseCommit) !== undefined ? commitTimes.get(i.baseCommit)! * 1000 : instanceTime(i));
  return [...instances].sort((a, b) => cmp(a.repo, b.repo) || time(a) - time(b) || cmp(a.instanceId, b.instanceId));
}

/**
 * Deterministic repository-stratified sample of `count` instances.
 *  - `even`: round-robin over repositories (each gets an equal share, +1 for the first few), maximising breadth.
 *  - `proportional`: every repository gets at least one slot (when count allows), the rest in proportion to repository size.
 * Within a repository instances are taken in order of SHA-256(seed + id), so the result does not depend on input order.
 */
export function sampleStratified<T extends PreparedInstance>(instances: T[], count: number, seed: number, mode: SampleMode = 'even'): T[] {
  if (count >= instances.length) return [...instances];
  const byRepo = new Map<string, T[]>();
  for (const instance of instances) byRepo.set(instance.repo, [...(byRepo.get(instance.repo) ?? []), instance]);
  for (const list of byRepo.values()) list.sort((a, b) => cmp(digest(`${seed}:${a.instanceId}`), digest(`${seed}:${b.instanceId}`)));
  const repos = [...byRepo.keys()].sort((a, b) => cmp(digest(`${seed}:repo:${a}`), digest(`${seed}:repo:${b}`)));
  const take = new Map<string, number>(repos.map(repo => [repo, 0]));

  if (mode === 'even') {
    let remaining = count;
    while (remaining > 0) {
      let progressed = false;
      for (const repo of repos) {
        if (remaining === 0) break;
        if (take.get(repo)! < byRepo.get(repo)!.length) {
          take.set(repo, take.get(repo)! + 1);
          remaining--;
          progressed = true;
        }
      }
      if (!progressed) break;
    }
  } else if (count <= repos.length) {
    const largest = [...repos].sort((a, b) => byRepo.get(b)!.length - byRepo.get(a)!.length || repos.indexOf(a) - repos.indexOf(b));
    for (const repo of largest.slice(0, count)) take.set(repo, 1);
  } else {
    for (const repo of repos) take.set(repo, 1);
    let remaining = count - repos.length;
    const capacity = (repo: string) => byRepo.get(repo)!.length - take.get(repo)!;
    const spare = repos.reduce((sum, repo) => sum + capacity(repo), 0);
    const quotas = repos.map(repo => ({ repo, exact: (remaining * capacity(repo)) / Math.max(spare, 1) }));
    for (const quota of quotas) {
      const whole = Math.min(Math.floor(quota.exact), capacity(quota.repo));
      take.set(quota.repo, take.get(quota.repo)! + whole);
      remaining -= whole;
    }
    const byFraction = [...quotas].sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || repos.indexOf(a.repo) - repos.indexOf(b.repo));
    for (let pass = 0; remaining > 0 && pass < repos.length + 1; pass++) {
      for (const quota of byFraction) {
        if (remaining > 0 && capacity(quota.repo) > 0) {
          take.set(quota.repo, take.get(quota.repo)! + 1);
          remaining--;
        }
      }
    }
  }
  const chosen: T[] = [];
  for (const repo of repos) chosen.push(...byRepo.get(repo)!.slice(0, take.get(repo)!));
  return sortInstances(chosen);
}

export interface SelectionFilters {
  repos?: string[];
  instances?: string[];
  sample?: number;
  sampleMode?: SampleMode;
  limit?: number;
}

export class SelectionError extends Error {}

/** Applies --repos / --instances / --sample / --limit in that order to already split-filtered instances. */
export function selectInstances<T extends PreparedInstance>(instances: T[], filters: SelectionFilters, seed: number, allIds?: Set<string>): T[] {
  let selected = instances;
  if (filters.repos?.length) {
    const wanted = new Set(filters.repos.map(r => r.toLowerCase()));
    const known = new Set(instances.map(i => i.repo.toLowerCase()));
    const unknown = [...wanted].filter(r => !known.has(r));
    if (unknown.length) throw new SelectionError(`no instance of the selected split in repo(s): ${unknown.join(', ')}`);
    selected = selected.filter(i => wanted.has(i.repo.toLowerCase()));
  }
  if (filters.instances?.length) {
    const present = new Set(instances.map(i => i.instanceId));
    const missing = filters.instances.filter(id => !present.has(id));
    if (missing.length) {
      const heldOut = missing.filter(id => allIds?.has(id));
      throw new SelectionError(heldOut.length
        ? `refusing: ${heldOut.join(', ')} is not in the selected split (held-out test instances cannot be run without --i-am-the-orchestrator-final-run)`
        : `unknown or unusable instance id(s): ${missing.join(', ')}`);
    }
    const wanted = new Set(filters.instances);
    selected = selected.filter(i => wanted.has(i.instanceId));
  }
  selected = sortInstances(selected);
  if (filters.sample !== undefined) selected = sampleStratified(selected, filters.sample, seed, filters.sampleMode ?? 'even');
  if (filters.limit !== undefined) selected = selected.slice(0, filters.limit);
  return selected;
}
