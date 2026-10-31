import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoResult } from './lib/bench-repo.js';
import { DEFAULT_RESULTS_DIR, PRIVATE_RESULTS_DIR, REPORT_DIR } from './lib/paths.js';
import { buildReport, renderMarkdown, renderPrivateMarkdown, type AdversarialDocument } from './lib/report.js';

const { values } = parseArgs({
  options: {
    variant: { type: 'string', multiple: true },
    results: { type: 'string', default: DEFAULT_RESULTS_DIR },
    out: { type: 'string', default: REPORT_DIR },
    private: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`Generate robustness reports from raw results.

  --variant NAME     variant to report (repeatable; default: every directory below --results that has results)
  --results DIR      raw results (default ~/reposqueeze-lab/results/bench-robust)
  --out DIR          where robustness-<variant>.{json,md} are written (default benchmarks/v3)
  --private LABEL    aggregate-only report for a private target from results/private/<LABEL>-<variant>.json
                     (written next to it as <LABEL>-<variant>.md; nothing else is written)`);
  process.exit(0);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  return existsSync(path) ? (JSON.parse(await readFile(path, 'utf8')) as T) : undefined;
}

async function variantsWithResults(): Promise<string[]> {
  if (values.variant?.length) return values.variant;
  const entries = await readdir(values.results!, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isDirectory() && (existsSync(join(values.results!, entry.name, 'corpus')) || existsSync(join(values.results!, entry.name, 'adversarial.json')))).map(entry => entry.name);
}

async function corpusResults(variant: string): Promise<RepoResult[]> {
  const dir = join(values.results!, variant, 'corpus');
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith('.json')).sort();
  const results: RepoResult[] = [];
  for (const name of names) results.push(JSON.parse(await readFile(join(dir, name), 'utf8')) as RepoResult);
  return results;
}

if (values.private) {
  const label = values.private;
  for (const variant of values.variant?.length ? values.variant : ['baseline']) {
    const raw = await readJson<RepoResult>(join(PRIVATE_RESULTS_DIR, `${label}-${variant}.json`));
    if (!raw) {
      console.error(`no private results for ${label}/${variant}`);
      process.exitCode = 1;
      continue;
    }
    await writeFile(join(PRIVATE_RESULTS_DIR, `${label}-${variant}.md`), renderPrivateMarkdown(label, variant, [raw]));
    console.log(`wrote ${label}-${variant}.md (aggregate only)`);
  }
} else {
  await mkdir(values.out!, { recursive: true });
  const variants = await variantsWithResults();
  if (!variants.length) console.error(`no results found below ${values.results}`);
  for (const variant of variants) {
    const corpus = await corpusResults(variant);
    const adversarial = await readJson<AdversarialDocument>(join(values.results!, variant, 'adversarial.json'));
    const report = buildReport(variant, corpus, adversarial);
    await writeFile(join(values.out!, `robustness-${variant}.json`), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(values.out!, `robustness-${variant}.md`), renderMarkdown(report));
    console.log(`wrote robustness-${variant}.{json,md}: ${corpus.length} repository runs, ${adversarial?.results.length ?? 0} adversarial checks`);
  }
}
