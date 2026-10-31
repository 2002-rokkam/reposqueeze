// Runs the 40-question development suite (benchmarks/tasks.json, eight pinned repositories from
// benchmarks/lock.json) against any RepoSqueeze checkout and prints one JSON line per budget and query form.
//
//   npm run bench:fetch                                  # clones the pinned repositories into .bench-repos
//   node --import tsx scripts/bench-devsuite.ts <checkout> # e.g. . or a worktree of an older version
//
// "complete" means every gold needle of a task appears in the returned pack text.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const checkout = resolve(process.argv[2] ?? '.');
const { Repository } = await import(`${checkout}/src/repository.ts`);
const { contextPackV2 } = await import(`${checkout}/src/v2.ts`);
interface Task { repo: string; query: string; gold: { path: string; needle: string }[] }
const tasks = (JSON.parse(await readFile('benchmarks/tasks.json', 'utf8')) as Task[]).slice(0, 40);
const lock = JSON.parse(await readFile('benchmarks/lock.json', 'utf8')) as { name: string; split: string }[];

function perturb(query: string, kind: string): string {
  const words = query.split(/\s+/);
  if (kind === 'dropout') return words.filter((_, i) => i % 5 !== 1).join(' ');
  if (kind === 'telegraphic') return query.replace(/\b(?:how|does|where|which|what|when|is|are|the|a|an|to|of|in|with)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (kind === 'reordered') return [words.slice(Math.ceil(words.length / 2)).join(' '), words.slice(0, Math.ceil(words.length / 2)).join(' ')].join('\n');
  return query;
}

const kinds = ['original', 'dropout', 'telegraphic', 'reordered'];
const rows: { kind: string; budget: number; complete: boolean; recall: number; tokens: number }[] = [];
for (const repo of lock.filter(entry => entry.split === 'development')) {
  const snapshot = await new Repository(`.bench-repos/${repo.name}`).snapshot();
  for (const task of tasks.filter(candidate => candidate.repo === repo.name)) {
    for (const kind of kinds) for (const budget of [1500, 3000]) {
      const pack = contextPackV2(snapshot, perturb(task.query, kind), budget);
      const found = task.gold.filter(g => pack.text.includes(g.needle)).length;
      rows.push({ kind, budget, complete: found === task.gold.length, recall: found / task.gold.length, tokens: pack.stats.outputTokens });
    }
  }
}
for (const budget of [1500, 3000]) for (const kind of [...kinds, 'all']) {
  const subset = rows.filter(r => r.budget === budget && (kind === 'all' || r.kind === kind));
  const pct = (n: number) => +((100 * n) / subset.length).toFixed(2);
  console.log(JSON.stringify({ budget, kind, n: subset.length, complete: pct(subset.filter(r => r.complete).length), recall: pct(subset.reduce((a, r) => a + r.recall, 0)), meanTokens: Math.round(subset.reduce((a, r) => a + r.tokens, 0) / subset.length) }));
}
