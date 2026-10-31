import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { args, type CliRun } from '../lib/cli.js';
import { parseContextHeader, parseMapHeader } from '../lib/analyze.js';
import { Rng } from '../lib/prng.js';
import { ensureSynthetic } from '../lib/synthetic.js';
import { CONTROL, processVerdict, rssGiB } from './common.js';
import { describeRun, fail, pass, single, warn, type Ctx, type Group, type Verdict } from './types.js';

const MIB = 1024 * 1024;
// A hang is detected at 2 minutes: every scenario below costs milliseconds to seconds when it works.
const HANG_LIMIT_MS = 120_000;

/** Minified-looking single line of roughly `bytes` bytes (varied tokens, so tokenisation is ordinary). */
function minified(bytes: number, seed: string): string {
  const rng = Rng.from('minified', seed);
  const parts: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const part = `function f${i}(a,b){var c=${rng.between(1, 9999)};return a+b*c+"${rng.string(6)}"}`;
    parts.push(part);
    size += part.length + 1;
  }
  return parts.join(';');
}

interface Scenario {
  repo: string;
  context: CliRun;
  map: CliRun;
}

/** Builds a repository with the control file plus `files`, then runs context (control anchor) and map. */
async function scenario(ctx: Ctx, name: string, files: Record<string, string | Uint8Array>, options: { git?: boolean; env?: Record<string, string>; query?: string } = {}): Promise<Scenario> {
  const repo = await ctx.makeRepo(name, { ...CONTROL, ...files }, { git: options.git ?? true });
  const timeoutMs = Math.min(ctx.timeoutMs, HANG_LIMIT_MS);
  const context = await ctx.cli(args.context(repo, options.query ?? 'limitsanchorcontrol', 1000), { env: options.env, timeoutMs });
  const map = await ctx.cli(args.map(repo, 1500), { env: options.env, timeoutMs });
  return { repo, context, map };
}

/** Both commands finished, memory stayed bounded and the control file was still retrievable. */
function bounded(result: Scenario, maxRssGiB = 2): Verdict {
  const problem = processVerdict([['context', result.context], ['map', result.map]], maxRssGiB);
  if (problem) return problem;
  if (result.context.outcome !== 'ok') return fail(`context ${describeRun(result.context)}`);
  if (!result.context.stdoutText.includes('limitsanchorcontrol')) return fail('context finished but the control file was not retrieved');
  return pass(`context ${(result.context.wallMs / 1000).toFixed(1)}s, map ${(result.map.wallMs / 1000).toFixed(1)}s`);
}

const hang = (name: string, title: string, make: () => Record<string, string | Uint8Array>): Group<Verdict> =>
  single(`limits/${name}`, 'limits', title, 'high', async ctx => bounded(await scenario(ctx, name, make())));

const deepGroup = (git: boolean): Group<Verdict> =>
  single(`limits/deep-nesting-200-${git ? 'git' : 'nongit'}`, 'limits', `200-level directory nesting (${git ? 'git checkout' : 'plain directory'}) is indexed or reported incomplete`, 'medium', async ctx => {
    const result = await scenario(ctx, `deep-${git ? 'git' : 'nongit'}`, { [`${'d/'.repeat(200)}deep.txt`]: 'deepanchorqq lives at the bottom of a very deep tree\n' }, { git, query: 'deepanchorqq limitsanchorcontrol' });
    const base = bounded(result);
    if (base.status !== 'pass') return base;
    const header = parseContextHeader(result.context.stdoutText);
    const found = result.context.stdoutText.includes('deepanchorqq');
    if (found || header.incomplete) return pass(found ? 'deep file indexed' : 'deep file dropped but scan flagged incomplete=true');
    return fail('deep file silently dropped: incomplete=false and no excerpt');
  });

async function manyFiles(ctx: Ctx, git: boolean): Promise<Verdict> {
  const dir = await ensureSynthetic({ kind: 'tiny', files: 100_050 }, line => ctx.log(line));
  const parked = join(dir, '.git.off');
  // Recover from an earlier interrupted run that left the repository parked.
  await rename(parked, join(dir, '.git')).catch(() => undefined);
  if (!git) await rename(join(dir, '.git'), parked);
  try {
    const { env } = ctx.cacheEnv(`many-${git ? 'git' : 'nongit'}`);
    const timeoutMs = ctx.timeoutMs;
    const context = await ctx.cli(args.context(dir, 'token5 value', 1000), { env, timeoutMs });
    const map = await ctx.cli(args.map(dir, 1500), { env, timeoutMs });
    const problem = processVerdict([['context', context], ['map', map]], 4);
    if (problem) return problem;
    if (context.outcome !== 'ok') return fail(`context ${describeRun(context)}`);
    const header = parseContextHeader(context.stdoutText);
    const mapHeader = parseMapHeader(map.stdoutText);
    if ((header.files ?? 0) > 100_000) return fail(`indexed ${header.files} files, above the documented 100,000 limit`);
    if (!header.incomplete || mapHeader.incomplete === false) {
      return fail(`100,050 files but the scan was reported complete (files=${header.files}, incomplete=${header.incomplete}, map incomplete=${mapHeader.incomplete})`);
    }
    const cpu = (context.userSec ?? 0) + (context.sysSec ?? 0);
    return pass(`files=${header.files}, incomplete=true; context ${(context.wallMs / 1000).toFixed(0)}s wall / ${cpu.toFixed(0)}s cpu, rss ${rssGiB(context).toFixed(1)} GiB, load ${context.load1.toFixed(0)}`);
  } finally {
    if (!git) await rename(parked, join(dir, '.git')).catch(() => undefined);
    await rm(join(dir, '.reposqueeze-v2'), { recursive: true, force: true });
  }
}

const manyGroup = (git: boolean): Group<Verdict> => ({
  id: `limits/many-files-${git ? 'git' : 'nongit'}`,
  category: 'limits',
  title: `100,050 tiny files (${git ? 'git checkout' : 'plain directory walker'})`,
  slow: true,
  setup: ctx => manyFiles(ctx, git),
  checks: [
    {
      id: `limits/many-files-${git ? 'git' : 'nongit'}`,
      title: `100,050 tiny files (${git ? 'git checkout' : 'plain directory'}): completes, stays bounded, reports incomplete=true`,
      severity: 'high',
      run: verdict => verdict,
    },
  ],
});

export const limitsGroups: Group<Verdict>[] = [
  single('limits/giant-single-line-50mib', 'limits', '50 MiB single-line minified file is skipped quickly and bounded in memory', 'high', async ctx => {
    const result = await scenario(ctx, 'giant', { 'static/bundle.min.js': Buffer.from(minified(50 * MIB, 'giant')) });
    const verdict = bounded(result, 1.5);
    if (verdict.status !== 'pass') return verdict;
    const header = parseContextHeader(result.context.stdoutText);
    return (header.excluded ?? 0) >= 1 ? verdict : warn('file was skipped but the excluded-files count does not show it');
  }),
  single('limits/two-mib-boundary', 'limits', 'files at the 2 MiB limit are indexed, 1 byte above is excluded and counted', 'medium', async ctx => {
    const line = 'ordinary prose about the quarterly report and its totals for the region\n';
    const filler = (anchor: string, size: number) => Buffer.from(`${anchor}\n${line.repeat(Math.ceil(size / line.length))}`.slice(0, size));
    const result = await scenario(ctx, 'boundary', { 'data/exact.txt': filler('exactanchorqq', 2 * MIB), 'data/over.txt': filler('overanchorqq', 2 * MIB + 1) }, { query: 'limitsanchorcontrol exactanchorqq overanchorqq' });
    const verdict = bounded(result);
    if (verdict.status !== 'pass') return verdict;
    const text = result.context.stdoutText;
    const header = parseContextHeader(text);
    if (text.includes('overanchorqq')) return fail('a file 1 byte above the 2 MiB limit was indexed');
    if ((header.excluded ?? 0) < 1) return fail('oversize file not counted in the excluded-files header');
    return pass(`over-limit file excluded (excluded=${header.excluded}); exact-limit file ${text.includes('exactanchorqq') ? 'indexed' : 'not retrieved'}`);
  }),
  hang('long-letter-run-64kib', 'a 64 KiB run of one letter (tokenizer worst case) does not hang context/map', () => ({ 'data/run.txt': Buffer.alloc(64 * 1024, 'a') })),
  hang('dna-sequence-single-line', 'a 64 KiB single-line uppercase sequence (FASTA-style data) does not hang context/map', () => ({ 'data/genome.txt': Buffer.from('ACGT'.repeat(16 * 1024)) })),
  hang('separator-line-64kib', 'a 64 KiB line of "-" characters does not hang context/map', () => ({ 'docs/rule.md': Buffer.alloc(64 * 1024, '-') })),
  hang('minified-bundle-1.9mib', 'a 1.9 MiB single-line minified bundle (realistic content) is handled', () => ({ 'static/vendor.min.js': Buffer.from(minified(Math.floor(1.9 * MIB), 'vendor')) })),
  hang('tree-sitter-nesting', 'pathologically nested source (400 KB of brackets) does not hang the parser', () => ({
    'src/nest-brackets.js': `const x = ${'['.repeat(200_000)}${']'.repeat(200_000)};\n`,
    'src/nest-parens.ts': `export const y = ${'('.repeat(100_000)}1${')'.repeat(100_000)};\n`,
  })),
  hang('binary-noise-source-files', 'random bytes with source extensions (invalid UTF-8, no NUL) are survived', () => {
    const rng = Rng.from('noise');
    const noise = (n: number) => Buffer.from(Array.from({ length: n }, () => 1 + rng.int(255)));
    return { 'src/noise.py': noise(300_000), 'src/noise.js': noise(300_000), 'src/noise.go': noise(300_000) };
  }),
  hang('million-short-lines', 'a 2 MiB file with a million one-character lines is handled', () => ({ 'data/lines.txt': Buffer.from('x\n'.repeat(MIB)) })),
  hang('very-long-file-names', 'file names of 245 characters at depth 3 are handled', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`a/b/${'n'.repeat(235)}${String(i).padStart(10, '0')}.txt`] = `long name ${i}\n`;
    return files;
  }),
  single('limits/crlf-verbatim', 'limits', 'CRLF, lone CR and U+2028 are returned verbatim by expand', 'low', async ctx => {
    const content = 'first line\r\nsecond line\rthird\u2028fourth\r\nlast\r\n';
    const repo = await ctx.makeRepo('crlf', { ...CONTROL, 'src/crlf.txt': content }, { git: true });
    const run = await ctx.cli(args.expand(repo, 'src/crlf.txt', 1, 10, 1000));
    if (run.outcome !== 'ok') return fail(describeRun(run));
    return run.stdoutText.includes('first line\r\nsecond line\rthird\u2028fourth\r\nlast\r') ? pass() : fail('line terminators were altered');
  }),
  deepGroup(true),
  deepGroup(false),
  manyGroup(true),
  manyGroup(false),
];
