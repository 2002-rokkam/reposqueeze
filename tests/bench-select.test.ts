import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleStratified, selectInstances, SelectionError, sortInstances } from '../bench/lib/select.js';
import { waitForLoad } from '../bench/lib/load.js';
import type { PreparedInstance } from '../bench/lib/gold.js';

function instance(repo: string, n: number, createdAt = `2021-01-${String((n % 28) + 1).padStart(2, '0')} 00:00:00`): PreparedInstance {
  return {
    instanceId: `${repo.replace('/', '__')}-${n}`, repo, baseCommit: `c${n}`, createdAt, datasets: ['lite'], split: 'dev', statement: 's',
    gold: [], goldLines: 0, language: 'Python', hasCodeGold: true, mentions: { path: false, basename: false, stem: false, any: false }, ignoredFiles: [],
  };
}

const pool = [
  ...Array.from({ length: 20 }, (_, i) => instance('big/repo', i)),
  ...Array.from({ length: 6 }, (_, i) => instance('mid/repo', i)),
  ...Array.from({ length: 3 }, (_, i) => instance('small/repo', i)),
  instance('tiny/one', 0),
];

const countByRepo = (items: PreparedInstance[]) => Object.fromEntries([...new Set(items.map(i => i.repo))].sort().map(r => [r, items.filter(i => i.repo === r).length]));

test('sortInstances orders by repo, then base-commit time, then id', () => {
  const shuffled = [instance('b/x', 1, '2020-02-01 00:00:00'), instance('a/y', 2, '2020-03-01T00:00:00Z'), instance('b/x', 3, '2020-01-01 00:00:00'), instance('a/y', 0, '2020-03-01T00:00:00Z')];
  assert.deepEqual(sortInstances(shuffled).map(i => i.instanceId), ['a__y-0', 'a__y-2', 'b__x-3', 'b__x-1']);
  const times = new Map([['c1', 100], ['c3', 200]]);
  assert.deepEqual(sortInstances(shuffled.filter(i => i.repo === 'b/x'), times).map(i => i.instanceId), ['b__x-1', 'b__x-3']);
});

test('even sampling spreads picks across repositories and is deterministic', () => {
  const a = sampleStratified(pool, 8, 7, 'even');
  const b = sampleStratified([...pool].reverse(), 8, 7, 'even');
  assert.deepEqual(a.map(i => i.instanceId), b.map(i => i.instanceId));
  assert.equal(a.length, 8);
  const counts = countByRepo(a);
  assert.equal(counts['tiny/one'], 1);
  assert.deepEqual([counts['big/repo'], counts['mid/repo'], counts['small/repo']].sort(), [2, 2, 3]);
  const other = sampleStratified(pool, 8, 8, 'even');
  assert.notDeepEqual(a.map(i => i.instanceId), other.map(i => i.instanceId));
});

test('even sampling never exceeds what a repository has', () => {
  const picked = sampleStratified(pool, 20, 1, 'even');
  assert.equal(picked.length, 20);
  assert.deepEqual(countByRepo(picked), { 'big/repo': 10, 'mid/repo': 6, 'small/repo': 3, 'tiny/one': 1 });
});

test('proportional sampling gives every repository a slot and follows repository size', () => {
  const picked = sampleStratified(pool, 10, 3, 'proportional');
  assert.equal(picked.length, 10);
  const counts = countByRepo(picked);
  assert.ok(Object.values(counts).every(n => n >= 1));
  assert.ok(counts['big/repo'] > counts['mid/repo'] && counts['mid/repo'] >= counts['small/repo']);
  assert.deepEqual(picked.map(i => i.instanceId), sampleStratified([...pool].reverse(), 10, 3, 'proportional').map(i => i.instanceId));
});

test('proportional sampling with fewer slots than repositories keeps the biggest repositories', () => {
  const picked = sampleStratified(pool, 2, 3, 'proportional');
  assert.deepEqual(countByRepo(picked), { 'big/repo': 1, 'mid/repo': 1 });
});

test('asking for more than available returns everything', () => {
  assert.equal(sampleStratified(pool, 1000, 1).length, pool.length);
});

test('selectInstances applies repos, instances, sample and limit in order and guards the held-out split', () => {
  const repos = selectInstances(pool, { repos: ['Mid/Repo'] }, 1);
  assert.equal(repos.length, 6);
  assert.throws(() => selectInstances(pool, { repos: ['nope/repo'] }, 1), SelectionError);
  const ids = selectInstances(pool, { instances: ['mid__repo-2', 'tiny__one-0'] }, 1).map(i => i.instanceId);
  assert.deepEqual(ids, ['mid__repo-2', 'tiny__one-0']);
  const allIds = new Set([...pool.map(i => i.instanceId), 'held__out-1']);
  assert.throws(() => selectInstances(pool, { instances: ['held__out-1'] }, 1, allIds), /held-out/);
  assert.throws(() => selectInstances(pool, { instances: ['does-not-exist'] }, 1, allIds), /unknown or unusable/);
  assert.equal(selectInstances(pool, { sample: 8, limit: 3 }, 1).length, 3);
});

test('the load guard waits while the load is high and returns the time waited', async () => {
  const loads = [90, 70, 45, 41, 39];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const waited = await waitForLoad({ maxLoad: 40, pollMs: 1000, readLoad: () => loads.shift() ?? 0, sleep: async ms => { sleeps.push(ms); }, log: m => logs.push(m) });
  assert.equal(waited, 4);
  assert.equal(sleeps.length, 4);
  assert.equal(logs.length, 1, 'logs once, not on every poll');
});

test('the load guard is off for 0 and stops early when asked', async () => {
  assert.equal(await waitForLoad({ maxLoad: 0, readLoad: () => 1000 }), 0);
  let polls = 0;
  const waited = await waitForLoad({ maxLoad: 10, pollMs: 1, readLoad: () => 99, sleep: async () => { polls++; }, shouldStop: () => polls >= 3 });
  assert.ok(waited <= 0.003 + 1e-9 && polls === 3);
});
