import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureClone, loadCorpus, loadLock, pruneClone, saveLock, type CorpusEntry, type Lock } from './lib/corpus.js';
import { DEFAULT_CORPUS_DIR } from './lib/paths.js';
import { runPool } from './lib/pool.js';
import { eligibleByPath, listRepoFiles, topExtensions, treeStats } from './lib/repo-stats.js';
import { configureThrottle } from './lib/throttle.js';

const { values } = parseArgs({
  options: {
    wave: { type: 'string', default: '1' },
    repos: { type: 'string' },
    corpus: { type: 'string', default: DEFAULT_CORPUS_DIR },
    concurrency: { type: 'string', default: '1' },
    'lock-only': { type: 'boolean', default: false },
    prune: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`Fetch the pinned shallow corpus and record commit SHAs + stats in bench/robustness/corpus.lock.json.

  --wave 1|2|all        which waves to process (default 1; wave 2 = very large repositories, opt-in)
  --repos a,b           only repositories whose owner/name or directory name contains one of these
  --corpus DIR          clone directory (default ~/reposqueeze-lab/corpus/shallow)
  --concurrency N       parallel clones (default 1; the lab throttle caps heavy processes at 2)
  --lock-only           do not download; record SHA/stats of clones that already exist
  --prune               delete each clone after its stats are recorded (disk guard)`);
  process.exit(0);
}

function selected(): CorpusEntry[] {
  const filters = values.repos?.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  return loadCorpus().filter(entry => {
    if (values.wave !== 'all' && String(entry.wave) !== values.wave) return false;
    return !filters?.length || filters.some(filter => entry.repo.toLowerCase().includes(filter) || entry.name.toLowerCase().includes(filter));
  });
}

async function recordStats(entry: CorpusEntry, lock: Lock, dir: string, sha: string): Promise<void> {
  const files = await listRepoFiles(dir);
  const tree = await treeStats(dir, files);
  lock.repos[entry.name] = {
    url: entry.url,
    sha,
    ecosystem: entry.ecosystem,
    category: entry.category,
    gitFiles: files.length,
    eligibleEstimate: files.filter(eligibleByPath).length,
    workTreeBytes: tree.bytes,
    topExtensions: topExtensions(files, 4),
  };
  await saveLock(lock);
}

const lock = loadLock();
configureThrottle({ log: line => console.log(`[throttle] ${line}`) });
const entries = selected();
console.log(`corpus: ${entries.length} repositories${values['lock-only'] ? ' (lock-only)' : ''}`);
await runPool(entries, Number(values.concurrency), async entry => {
  const started = Date.now();
  try {
    if (values['lock-only'] && !existsSync(join(values.corpus!, entry.name, '.git'))) {
      console.log(`skip   ${entry.repo} (not cloned)`);
      return;
    }
    const clone = await ensureClone(entry, lock, values.corpus);
    await recordStats(entry, lock, clone.dir, clone.sha);
    const info = lock.repos[entry.name];
    console.log(`ok     ${entry.repo.padEnd(42)} ${clone.sha.slice(0, 10)} ${String(info.gitFiles).padStart(7)} files ${(info.workTreeBytes! / 1048576).toFixed(0).padStart(6)} MiB ${((Date.now() - started) / 1000).toFixed(0)}s`);
    if (values.prune) await pruneClone(entry, values.corpus);
  } catch (error) {
    console.error(`FAILED ${entry.repo}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
});
