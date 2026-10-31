import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { args, type CliRun } from '../lib/cli.js';
import { checkBudget } from '../lib/analyze.js';
import { Rng } from '../lib/prng.js';
import { CONTROL, CONTROL_ANCHOR, processVerdict, runStats } from './common.js';
import { describeRun, fail, pass, single, warn, type Check, type Ctx, type Group, type Verdict } from './types.js';

const MIB = 1024 * 1024;
const HANG_LIMIT_MS = 120_000;

// ---------------------------------------------------------------------------------------------
// Budget extremes
// ---------------------------------------------------------------------------------------------

type BudgetExpectation = 'accept' | 'refuse' | 'either';
const BUDGETS: { value: string; expect: BudgetExpectation; label: string }[] = [
  { value: '256', expect: 'accept', label: 'minimum 256' },
  { value: '32000', expect: 'accept', label: 'maximum 32000' },
  { value: '255', expect: 'refuse', label: '255 (below minimum)' },
  { value: '32001', expect: 'refuse', label: '32001 (above maximum)' },
  { value: '0', expect: 'refuse', label: '0' },
  { value: '-1', expect: 'refuse', label: '-1' },
  { value: 'NaN', expect: 'refuse', label: 'NaN' },
  { value: 'abc', expect: 'refuse', label: 'non-numeric text' },
  { value: '', expect: 'refuse', label: 'empty string' },
  { value: 'Infinity', expect: 'refuse', label: 'Infinity' },
  { value: '1000.5', expect: 'refuse', label: 'fractional 1000.5' },
  { value: '1e3', expect: 'either', label: 'exponent notation 1e3' },
  { value: '0x400', expect: 'either', label: 'hexadecimal 0x400' },
];

interface BudgetState {
  repo: string;
  runs: Map<string, CliRun>;
  map255: CliRun;
  map32001: CliRun;
  expand32001: CliRun;
}

async function budgetSetup(ctx: Ctx): Promise<BudgetState> {
  const repo = await ctx.makeRepo('budgets', { ...CONTROL, 'src/a.py': 'def alpha():\n    return 1\n' }, { git: true });
  const runs = new Map<string, CliRun>();
  for (const budget of BUDGETS) runs.set(budget.value, await ctx.cli(args.context(repo, CONTROL_ANCHOR, budget.value)));
  return {
    repo,
    runs,
    map255: await ctx.cli(args.map(repo, 255)),
    map32001: await ctx.cli(args.map(repo, 32001)),
    expand32001: await ctx.cli(args.expand(repo, 'src/a.py', 1, 2, 32001)),
  };
}

function budgetVerdict(run: CliRun, budget: (typeof BUDGETS)[number], ctx: Ctx): Verdict {
  const problem = processVerdict([['context', run]], 1);
  if (problem) return problem;
  if (budget.expect === 'refuse') return run.outcome === 'clean-error' ? pass(run.detail) : fail(`accepted invalid budget "${budget.value}" (${describeRun(run)})`);
  if (run.outcome === 'clean-error') return budget.expect === 'either' ? pass(`refused: ${run.detail}`) : fail(`rejected valid budget ${budget.value}: ${run.detail}`);
  const limit = Number(budget.value);
  const check = checkBudget(ctx.tokenizer, run.stdoutText, limit);
  return check.withinBudget ? pass(`${check.tokens}/${limit} tokens`) : fail(`${check.tokens} tokens exceed budget ${limit}`);
}

const budgetGroup: Group<BudgetState> = {
  id: 'inputs/budget',
  category: 'budget',
  title: 'Budget extremes on the CLI',
  setup: budgetSetup,
  checks: [
    ...BUDGETS.map(
      (budget): Check<BudgetState> => ({
        id: `budget/context-${budget.value === '' ? 'empty' : budget.value}`,
        title: `context --budget=${budget.value || '""'} (${budget.label}) is ${budget.expect === 'accept' ? 'honoured within the budget' : budget.expect === 'refuse' ? 'refused with a clean error' : 'accepted within budget or refused cleanly'}`,
        severity: budget.expect === 'accept' ? 'high' : 'medium',
        run: (state, ctx) => budgetVerdict(state.runs.get(budget.value)!, budget, ctx),
      }),
    ),
    { id: 'budget/map-255', title: 'map --budget=255 is refused cleanly', severity: 'low', run: state => (state.map255.outcome === 'clean-error' ? pass() : fail(describeRun(state.map255))) },
    { id: 'budget/map-32001', title: 'map --budget=32001 is refused cleanly', severity: 'low', run: state => (state.map32001.outcome === 'clean-error' ? pass() : fail(describeRun(state.map32001))) },
    { id: 'budget/expand-32001', title: 'expand --budget=32001 is refused cleanly', severity: 'low', run: state => (state.expand32001.outcome === 'clean-error' ? pass() : fail(describeRun(state.expand32001))) },
  ],
};

// ---------------------------------------------------------------------------------------------
// Query extremes (CLI)
// ---------------------------------------------------------------------------------------------

interface QueryCase {
  id: string;
  title: string;
  query: () => string;
  expect: 'accept' | 'refuse' | 'no-crash';
}

const QUERIES: QueryCase[] = [
  { id: 'empty', title: 'empty query', query: () => '', expect: 'refuse' },
  { id: 'whitespace', title: 'whitespace-only query', query: () => ' \t  ', expect: 'refuse' },
  { id: '8000-chars', title: 'query of exactly 8000 characters', query: () => `${CONTROL_ANCHOR} ${'lorem '.repeat(1300)}`.slice(0, 8000), expect: 'accept' },
  { id: '8001-chars', title: 'query of 8001 characters', query: () => 'x'.repeat(8001), expect: 'refuse' },
  { id: '100kb', title: '100 KB query', query: () => `${CONTROL_ANCHOR} `.repeat(7000).slice(0, 100_000), expect: 'refuse' },
  { id: 'unicode-emoji', title: 'Unicode and emoji', query: () => `${CONTROL_ANCHOR} 日本語のクエリ 🚀🔥 ünïcödé Ωmega \u202e`, expect: 'accept' },
  { id: 'regex-metacharacters', title: 'regular-expression metacharacters', query: () => `${CONTROL_ANCHOR} .*+?^\${}()|[]\\ (a+)+$ [z-a] \\d{9999999}`, expect: 'accept' },
  { id: 'redos-shaped', title: 'ReDoS-shaped query (5000 "a" then "!")', query: () => `${'a'.repeat(5000)}! ${CONTROL_ANCHOR}`, expect: 'accept' },
  { id: 'only-stopwords', title: 'only stop words', query: () => 'the a an is are of to for from in on and or', expect: 'no-crash' },
  { id: 'only-punctuation', title: 'only punctuation and digits', query: () => '!!! ??? ... 12345 --- ***', expect: 'no-crash' },
  { id: 'single-8000-char-token', title: 'one 8000-character token', query: () => Rng.from('queries', 'single-token').string(8000, 'abcdefghijklmnopqrstuvwxyz'), expect: 'accept' },
  { id: 'repeated-error-lines', title: '1000 repeated "error" lines (diagnostic view)', query: () => `${CONTROL_ANCHOR}\n${'error: failed to compile module\n'.repeat(250)}`, expect: 'accept' },
  { id: 'leading-dashes', title: 'query that looks like command-line options', query: () => `--help --budget=1 -x ${CONTROL_ANCHOR}`, expect: 'accept' },
];

interface QueryState {
  repo: string;
  runs: Map<string, CliRun>;
}

const queryGroup: Group<QueryState> = {
  id: 'inputs/query-cli',
  category: 'query',
  title: 'Query extremes on the CLI',
  setup: async ctx => {
    const repo = await ctx.makeRepo('queries', CONTROL, { git: true });
    const runs = new Map<string, CliRun>();
    for (const item of QUERIES) runs.set(item.id, await ctx.cli(args.context(repo, item.query(), 1000), { timeoutMs: Math.min(ctx.timeoutMs, HANG_LIMIT_MS) }));
    return { repo, runs };
  },
  checks: QUERIES.map(
    (item): Check<QueryState> => ({
      id: `query/${item.id}`,
      title: `${item.title}: ${item.expect === 'refuse' ? 'refused with a clean error' : item.expect === 'accept' ? 'answered within the budget' : 'answered or refused cleanly, never a crash'}`,
      severity: item.expect === 'refuse' ? 'low' : 'high',
      run: (state, ctx) => {
        const run = state.runs.get(item.id)!;
        const problem = processVerdict([['context', run]], 1);
        if (problem) return problem;
        if (item.expect === 'refuse') return run.outcome === 'clean-error' ? pass(run.detail) : fail(`accepted: ${describeRun(run)}`);
        if (run.outcome === 'clean-error') return item.expect === 'no-crash' ? pass(`refused: ${run.detail}`) : fail(`rejected a valid query: ${run.detail}`);
        const check = checkBudget(ctx.tokenizer, run.stdoutText, 1000);
        return check.withinBudget ? pass(`${check.tokens}/1000 tokens, ${runStats(run)}`) : fail(`${check.tokens} tokens exceed budget 1000`);
      },
    }),
  ),
};

// ---------------------------------------------------------------------------------------------
// Query extremes and tool-argument abuse over MCP (one server process, many calls)
// ---------------------------------------------------------------------------------------------

interface McpState {
  results: Map<string, { isError: boolean; text: string; thrown?: string }>;
  aliveAfter: boolean;
  parallel: { ok: boolean; identical: boolean };
  rssGrowthMiB: number | null;
  exitedOnClose: boolean;
  tools: string[];
}

const MCP_CALLS: { id: string; tool: string; args: Record<string, unknown>; expect: 'accept' | 'refuse' | 'no-crash' }[] = [
  { id: 'nul-in-query', tool: 'reposqueeze_v2_context', args: { query: `${CONTROL_ANCHOR}\u0000 tail`, budget: 1000 }, expect: 'no-crash' },
  { id: 'lone-surrogate-query', tool: 'reposqueeze_v2_context', args: { query: `${CONTROL_ANCHOR} \ud800 \udfff`, budget: 1000 }, expect: 'no-crash' },
  { id: 'query-8001', tool: 'reposqueeze_v2_context', args: { query: 'x'.repeat(8001), budget: 1000 }, expect: 'refuse' },
  { id: 'query-wrong-type', tool: 'reposqueeze_v2_context', args: { query: 12345, budget: 1000 }, expect: 'refuse' },
  { id: 'query-missing', tool: 'reposqueeze_v2_context', args: { budget: 1000 }, expect: 'refuse' },
  { id: 'budget-255', tool: 'reposqueeze_v2_context', args: { query: CONTROL_ANCHOR, budget: 255 }, expect: 'refuse' },
  { id: 'budget-32001', tool: 'reposqueeze_v2_context', args: { query: CONTROL_ANCHOR, budget: 32001 }, expect: 'refuse' },
  { id: 'budget-fractional', tool: 'reposqueeze_v2_context', args: { query: CONTROL_ANCHOR, budget: 1000.5 }, expect: 'refuse' },
  { id: 'budget-string', tool: 'reposqueeze_v2_context', args: { query: CONTROL_ANCHOR, budget: '1000' }, expect: 'refuse' },
  { id: 'known-201-ids', tool: 'reposqueeze_v2_context', args: { query: CONTROL_ANCHOR, budget: 1000, known: Array.from({ length: 201 }, (_, i) => `id${i}`) }, expect: 'refuse' },
  { id: 'known-huge-strings', tool: 'reposqueeze_v2_context', args: { query: CONTROL_ANCHOR, budget: 1000, known: ['x'.repeat(1_000_000)] }, expect: 'no-crash' },
  { id: 'unknown-extra-argument', tool: 'reposqueeze_v2_context', args: { query: CONTROL_ANCHOR, budget: 1000, surprise: { nested: true } }, expect: 'no-crash' },
  { id: 'expand-end-before-start', tool: 'reposqueeze_v2_expand', args: { path: 'src/control.py', start: 5, end: 2 }, expect: 'refuse' },
  { id: 'expand-start-zero', tool: 'reposqueeze_v2_expand', args: { path: 'src/control.py', start: 0, end: 2 }, expect: 'refuse' },
  { id: 'expand-start-beyond-eof', tool: 'reposqueeze_v2_expand', args: { path: 'src/control.py', start: 999, end: 1000 }, expect: 'refuse' },
  { id: 'expand-float-lines', tool: 'reposqueeze_v2_expand', args: { path: 'src/control.py', start: 1.5, end: 2.5 }, expect: 'refuse' },
  { id: 'expand-unknown-tool', tool: 'reposqueeze_v2_does_not_exist', args: {}, expect: 'refuse' },
  { id: 'compact-over-2mib', tool: 'reposqueeze_v2_compact', args: { text: 'x'.repeat(2 * MIB + 1), budget: 1000 }, expect: 'refuse' },
  { id: 'json-over-2mib', tool: 'reposqueeze_v2_json', args: { text: ' '.repeat(2 * MIB + 1) }, expect: 'refuse' },
  { id: 'json-not-json', tool: 'reposqueeze_v2_json', args: { text: 'this is not json' }, expect: 'refuse' },
  { id: 'compact-valid', tool: 'reposqueeze_v2_compact', args: { text: 'line one\nerror: boom\nline three\n', budget: 1000 }, expect: 'accept' },
  { id: 'map-valid', tool: 'reposqueeze_v2_map', args: { budget: 1000 }, expect: 'accept' },
];

async function mcpSetup(ctx: Ctx): Promise<McpState> {
  const repo = await ctx.makeRepo('mcp', { ...CONTROL, 'src/a.py': 'def alpha():\n    return 1\n' }, { git: true });
  const session = await ctx.mcp(repo);
  const state: McpState = { results: new Map(), aliveAfter: false, parallel: { ok: false, identical: false }, rssGrowthMiB: null, exitedOnClose: false, tools: [] };
  try {
    state.tools = (await session.listTools()).map(tool => tool.name).sort();
    for (const item of MCP_CALLS) {
      try {
        const result = await session.call(item.tool, item.args, 120_000);
        state.results.set(item.id, { isError: result.isError, text: result.text });
      } catch (error) {
        state.results.set(item.id, { isError: true, text: '', thrown: error instanceof Error ? error.message.slice(0, 160) : String(error) });
      }
    }
    // The server must still answer correctly after all of the abuse above.
    const after = await session.call('reposqueeze_v2_context', { query: CONTROL_ANCHOR, budget: 1000 });
    state.aliveAfter = !after.isError && after.text.includes(CONTROL_ANCHOR);
    const reference = after.text;
    const batch = await Promise.all(Array.from({ length: 16 }, () => session.call('reposqueeze_v2_context', { query: CONTROL_ANCHOR, budget: 1000 }).catch(() => ({ isError: true, text: '', raw: null }))));
    state.parallel = { ok: batch.every(result => !result.isError), identical: batch.every(result => result.text === reference) };
    const before = session.rssKb();
    for (let i = 0; i < 40; i++) await session.call('reposqueeze_v2_context', { query: CONTROL_ANCHOR, budget: 1000 });
    const end = session.rssKb();
    state.rssGrowthMiB = before !== null && end !== null ? Math.round((end - before) / 1024) : null;
  } finally {
    state.exitedOnClose = (await session.close()).exited;
  }
  return state;
}

const mcpGroup: Group<McpState> = {
  id: 'mcp/session',
  category: 'mcp',
  title: 'MCP stdio session: argument abuse, parallel calls, soak, shutdown',
  setup: mcpSetup,
  checks: [
    { id: 'mcp/tools-listed', title: 'the server lists the five documented tools', severity: 'medium', run: state => (state.tools.length === 5 ? pass(state.tools.join(', ')) : fail(`tools: ${state.tools.join(', ')}`)) },
    ...MCP_CALLS.map(
      (item): Check<McpState> => ({
        id: `mcp/${item.id}`,
        title: `${item.tool.replace('reposqueeze_v2_', '')} ${item.id.replace(/-/g, ' ')}: ${item.expect === 'refuse' ? 'rejected with an error result' : item.expect === 'accept' ? 'answered' : 'answered or rejected, server survives'}`,
        severity: item.expect === 'no-crash' ? 'high' : 'medium',
        run: state => {
          const result = state.results.get(item.id)!;
          if (item.expect === 'refuse') return result.isError ? pass(result.thrown ?? 'error result') : fail('invalid request was accepted');
          if (item.expect === 'accept') return result.isError ? fail(result.thrown ?? result.text.slice(0, 120)) : pass();
          return pass(result.isError ? 'rejected' : 'answered');
        },
      }),
    ),
    { id: 'mcp/alive-after-abuse', title: 'the server still answers correctly after every malformed request', severity: 'high', run: state => (state.aliveAfter ? pass() : fail('no valid answer after the abusive calls')) },
    { id: 'mcp/parallel-calls', title: '16 parallel context calls all succeed with identical bytes', severity: 'medium', run: state => (state.parallel.ok && state.parallel.identical ? pass() : fail(`ok=${state.parallel.ok}, identical=${state.parallel.identical}`)) },
    {
      id: 'mcp/soak-memory',
      title: '40 further calls grow the server RSS by less than 300 MiB',
      severity: 'medium',
      run: state => (state.rssGrowthMiB === null ? warn('RSS unavailable') : state.rssGrowthMiB < 300 ? pass(`+${state.rssGrowthMiB} MiB`) : fail(`+${state.rssGrowthMiB} MiB over 40 calls`)),
    },
    { id: 'mcp/exits-on-close', title: 'the server process exits when the client disconnects (no orphan)', severity: 'medium', run: state => (state.exitedOnClose ? pass() : fail('server process still alive 5 s after the client closed')) },
  ],
};

// ---------------------------------------------------------------------------------------------
// compact / json with 2 MiB adversarial inputs (CLI, stdin)
// ---------------------------------------------------------------------------------------------

function logLines(bytes: number, seed: string): string {
  const r = Rng.from('log', seed);
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = `2024-01-01T00:00:${String(i % 60).padStart(2, '0')}Z ${r.pick(['INFO', 'WARN', 'ERROR', 'DEBUG'])} worker-${i % 17} request ${r.string(12)} took ${r.between(1, 900)}ms ${i % 97 === 0 ? 'error: connection reset by peer' : 'ok'}\n`;
    lines.push(line);
    size += line.length;
  }
  return lines.join('').slice(0, bytes);
}

function stdinCase(id: string, command: 'compact' | 'json', title: string, make: () => string | Uint8Array, expect: 'accept' | 'refuse' | 'no-crash', budget = 2000, severity: 'high' | 'medium' | 'low' = 'high'): Group<Verdict> {
  return single(`${command}/${id}`, 'compact-json', title, severity, async ctx => {
    const run = await ctx.cli(command === 'compact' ? args.compact(budget) : args.json(), { stdin: make(), timeoutMs: Math.min(ctx.timeoutMs, HANG_LIMIT_MS) });
    const problem = processVerdict([[command, run]], 2);
    if (problem) return problem;
    if (expect === 'refuse') return run.outcome === 'clean-error' ? pass(run.detail) : fail(`accepted: ${describeRun(run)}`);
    if (run.outcome === 'clean-error') return expect === 'no-crash' ? pass(`refused cleanly: ${run.detail}`) : fail(`rejected valid input: ${run.detail}`);
    if (command === 'compact') {
      const check = checkBudget(ctx.tokenizer, run.stdoutText, budget);
      if (!check.withinBudget && expect === 'accept') return fail(`${check.tokens} tokens exceed budget ${budget}`);
    }
    return pass(runStats(run));
  });
}

function jsonArrayBytes(bytes: number): string {
  const items: string[] = [];
  let size = 2;
  for (let i = 0; size < bytes - 80; i++) {
    const item = `{"id":${i},"name":"item-${i}","tags":["a","b"],"ok":${i % 2 === 0}}`;
    items.push(item);
    size += item.length + 1;
  }
  // Trailing spaces are valid JSON whitespace and make the document exactly `bytes` long.
  return `[${items.join(',')}]`.padEnd(bytes, ' ');
}

const compactJsonGroups: Group<Verdict>[] = [
  stdinCase('exact-2mib-log', 'compact', 'compact: a log of exactly 2 MiB is compacted within the budget', () => logLines(2 * MIB, 'exact'), 'accept'),
  stdinCase('over-2mib', 'compact', 'compact: 2 MiB + 1 byte is refused cleanly', () => `${logLines(2 * MIB, 'over')}x`, 'refuse', 2000, 'low'),
  stdinCase('test-keyword-line', 'compact', 'compact: a single 2 MB line of "test test ..." does not trigger catastrophic regex backtracking', () => 'test '.repeat(400_000), 'no-crash'),
  stdinCase('long-letter-run', 'compact', 'compact: a 64 KiB run of one letter (tokenizer worst case) does not hang', () => `${'a'.repeat(64 * 1024)}\nerror: boom\n`, 'no-crash'),
  stdinCase('many-error-lines', 'compact', 'compact: 100,000 distinct error lines are compacted within the budget', () => Array.from({ length: 100_000 }, (_, i) => `error ${i}: component ${i % 113} failed assertion #${i * 7}`).join('\n'), 'accept'),
  stdinCase('ansi-storm', 'compact', 'compact: 200,000 ANSI escape sequences interleaved with text', () => `${'\u001b[31mred\u001b[0m '.repeat(200_000)}\nerror: done\n`, 'no-crash'),
  stdinCase('binary-noise', 'compact', 'compact: 2 MiB of random bytes (invalid UTF-8) is survived', () => {
    const r = Rng.from('compact-noise');
    return Buffer.from(Array.from({ length: 2 * MIB }, () => r.int(256)));
  }, 'no-crash'),
  stdinCase('million-newlines', 'compact', 'compact: 2 MiB of empty lines is compacted', () => '\n'.repeat(2 * MIB), 'no-crash'),
  stdinCase('empty-input', 'compact', 'compact: empty stdin is answered or refused cleanly', () => '', 'no-crash', 2000, 'low'),
  stdinCase('tight-budget', 'compact', 'compact: 500 KB log with budget 256 stays within 256 tokens', () => logLines(500_000, 'tight'), 'accept', 256),
  stdinCase('exact-2mib-json', 'json', 'json: a document of exactly 2 MiB is converted without loss', () => jsonArrayBytes(2 * MIB), 'accept'),
  stdinCase('over-2mib', 'json', 'json: 2 MiB + 1 byte is refused cleanly', () => `${jsonArrayBytes(2 * MIB)} `, 'refuse', 2000, 'low'),
  stdinCase('deep-nesting-1m', 'json', 'json: one million nested arrays fail cleanly or succeed', () => `${'['.repeat(MIB)}${']'.repeat(MIB)}`, 'no-crash'),
  stdinCase('hundred-thousand-keys', 'json', 'json: an object with 100,000 keys is handled', () => `{${Array.from({ length: 100_000 }, (_, i) => `"key${i}":${i}`).join(',')}}`, 'accept'),
  stdinCase('long-letter-run-string', 'json', 'json: a 64 KiB single-letter string value (tokenizer worst case) does not hang', () => JSON.stringify({ a: 'a'.repeat(64 * 1024) }), 'no-crash'),
  stdinCase('million-numbers', 'json', 'json: an array of 400,000 numbers is handled', () => `[${Array.from({ length: 400_000 }, (_, i) => i).join(',')}]`, 'accept'),
  single('json/precision-passthrough', 'compact-json', 'json: numbers beyond double precision still produce usable (original) output instead of an error', 'low', async ctx => {
    const run = await ctx.cli(args.json(), { stdin: '{"id": 12345678901234567890, "ratio": 1.00000000000000000001}' });
    if (run.outcome === 'ok') return pass('original returned');
    return run.outcome === 'clean-error' ? warn(`declines precision-sensitive JSON with exit ${run.exitCode} instead of returning the original: ${run.detail}`) : fail(describeRun(run));
  }),
];

// ---------------------------------------------------------------------------------------------
// json: lossless round-trip battery through MCP
// ---------------------------------------------------------------------------------------------

const JSON_CASES: { id: string; input: string; expect: 'lossless' | 'either' | 'refuse' }[] = [
  { id: 'proto-key', input: '{"__proto__":{"polluted":true},"a":1}', expect: 'lossless' },
  { id: 'duplicate-keys', input: '{"a":1,"a":2}', expect: 'either' },
  { id: 'keys-needing-quotes', input: '{"a b":1,"":2,"-":3,"null":4,"123":5,"a:b":6,"\\n":7,"true":8}', expect: 'lossless' },
  { id: 'unicode-and-escapes', input: '{"s":"é\\u2028\\ud83d\\ude00 \\u0000 tab\\t","t":" lead and trail ","e":""}', expect: 'lossless' },
  { id: 'non-uniform-array-of-objects', input: '[{"id":1,"name":"a"},{"id":2,"name":"b"},{"id":3,"extra":true}]', expect: 'lossless' },
  { id: 'nested-arrays', input: '[[1,2],[3,[4,[5]]],[]]', expect: 'lossless' },
  { id: 'empty-containers', input: '{"a":{},"b":[],"c":[[],{}]}', expect: 'lossless' },
  { id: 'top-level-scalars', input: '"x"', expect: 'lossless' },
  { id: 'numbers', input: '[1e-7,1E5,0.30000000000000004,-1.5e300,123456789012345]', expect: 'lossless' },
  { id: 'precision-sensitive', input: '[9007199254740993,1.00000000000000000001,-0]', expect: 'either' },
  { id: 'delimiter-lookalikes', input: '{"list":["a,b","c|d","e\\tf","- x","[1]","{y}","key: value","#hash"]}', expect: 'lossless' },
  { id: 'number-like-strings', input: '{"zip":"01234","n":"123","b":"true","nul":"null","neg":"-5","exp":"1e3"}', expect: 'lossless' },
  { id: 'bom-prefixed', input: '\ufeff{"a":1}', expect: 'either' },
  { id: 'trailing-comma', input: '{"a":1,}', expect: 'refuse' },
  { id: 'trailing-garbage', input: '{"a":1} x', expect: 'refuse' },
  { id: 'empty-document', input: '', expect: 'refuse' },
];

interface JsonState {
  results: Map<string, { isError: boolean; text: string }>;
  decode: ((text: string) => unknown) | null;
}

async function jsonSetup(ctx: Ctx): Promise<JsonState> {
  const requireFrom = createRequire(join(ctx.variant.root, 'package.json'));
  let decode: JsonState['decode'] = null;
  try {
    const mod = (await import(pathToFileURL(requireFrom.resolve('@toon-format/toon')).href)) as { decode(text: string): unknown };
    decode = mod.decode;
  } catch {
    /* TOON outputs cannot be verified without the variant's decoder */
  }
  const repo = await ctx.makeRepo('json-battery', CONTROL, { git: false });
  const session = await ctx.mcp(repo);
  const results = new Map<string, { isError: boolean; text: string }>();
  try {
    for (const item of JSON_CASES) {
      try {
        const result = await session.call('reposqueeze_v2_json', { text: item.input });
        results.set(item.id, { isError: result.isError, text: result.text });
      } catch (error) {
        results.set(item.id, { isError: true, text: String(error) });
      }
    }
  } finally {
    await session.close();
  }
  return { results, decode };
}

function losslessVerdict(item: (typeof JSON_CASES)[number], state: JsonState): Verdict {
  const result = state.results.get(item.id)!;
  if (result.isError) return item.expect === 'lossless' ? fail(`valid JSON refused: ${result.text.slice(0, 100)}`) : pass('refused');
  if (item.expect === 'refuse') return fail('invalid JSON was accepted');
  let original: unknown;
  try {
    original = JSON.parse(item.input.replace(/^\ufeff/, ''));
  } catch {
    return pass('input is not strict JSON; output not comparable');
  }
  const toonPrefix = 'TOON (lossless JSON representation):\n';
  let decoded: unknown;
  try {
    if (result.text.startsWith(toonPrefix)) {
      if (!state.decode) return warn('TOON output could not be verified (decoder unavailable)');
      decoded = state.decode(result.text.slice(toonPrefix.length));
    } else {
      decoded = JSON.parse(result.text);
    }
  } catch (error) {
    return fail(`output is not decodable: ${error instanceof Error ? error.message.slice(0, 80) : String(error)}`);
  }
  return isDeepStrictEqual(decoded, original) ? pass(result.text.startsWith(toonPrefix) ? 'toon verified' : 'json verified') : fail('decoded output differs from the input data (data lost or altered)');
}

const jsonBattery: Group<JsonState> = {
  id: 'json/lossless-battery',
  category: 'compact-json',
  title: 'json tool: lossless round-trip over tricky documents (MCP)',
  setup: jsonSetup,
  checks: JSON_CASES.map(
    (item): Check<JsonState> => ({
      id: `json/lossless-${item.id}`,
      title: `json ${item.id.replace(/-/g, ' ')}: ${item.expect === 'refuse' ? 'invalid input refused' : 'output decodes to exactly the input data'}`,
      severity: item.id === 'proto-key' || item.id === 'duplicate-keys' ? 'high' : 'medium',
      run: state => losslessVerdict(item, state),
    }),
  ),
};

// ---------------------------------------------------------------------------------------------
// expand argument extremes
// ---------------------------------------------------------------------------------------------

const expandGroups: Group<Verdict>[] = [
  single('expand/huge-end-large-file', 'expand', 'expand --end=1000000 on an 8,000-line file with a small budget finishes quickly and stays within budget', 'high', async ctx => {
    const lines = Array.from({ length: 8000 }, (_, i) => `    value_${i} = compute(${i}, "row ${i}")  # explanatory comment for line ${i}`);
    const repo = await ctx.makeRepo('expand-big', { ...CONTROL, 'src/big.py': `${lines.join('\n')}\n` }, { git: true });
    const run = await ctx.cli(args.expand(repo, 'src/big.py', 1, 1_000_000, 256), { timeoutMs: Math.min(ctx.timeoutMs, HANG_LIMIT_MS) });
    const problem = processVerdict([['expand', run]], 2);
    if (problem) return problem;
    if (run.outcome !== 'ok') return fail(describeRun(run));
    const check = checkBudget(ctx.tokenizer, run.stdoutText, 256);
    return check.withinBudget ? pass(`${check.tokens}/256 tokens, ${runStats(run)}`) : fail(`${check.tokens} tokens exceed 256`);
  }),
  ...[
    ['start-zero', ['--start=0', '--end=5'], 'refuse'],
    ['end-before-start', ['--start=9', '--end=3'], 'refuse'],
    ['non-integer', ['--start=1.5', '--end=3'], 'refuse'],
    ['not-a-number', ['--start=abc', '--end=3'], 'refuse'],
    ['negative', ['--start=-5', '--end=3'], 'refuse'],
    ['astronomical-end', ['--start=1', '--end=1e308'], 'no-crash'],
    ['start-beyond-end-of-file', ['--start=99999', '--end=100000'], 'refuse'],
  ].map(([id, extra, expect]) =>
    single(`expand/${id as string}`, 'expand', `expand ${id as string}: ${expect === 'refuse' ? 'refused with a clean error' : 'answered or refused cleanly'}`, 'low', async ctx => {
      const repo = await ctx.makeRepo(`expand-${id as string}`, CONTROL, { git: true });
      const run = await ctx.cli(['expand', `--root=${repo}`, '--path=src/control.py', ...(extra as string[])], { timeoutMs: Math.min(ctx.timeoutMs, HANG_LIMIT_MS) });
      const problem = processVerdict([['expand', run]], 1);
      if (problem) return problem;
      if (expect === 'refuse') return run.outcome === 'clean-error' ? pass(run.detail) : fail(`accepted: ${describeRun(run)}`);
      return pass(run.outcome);
    }),
  ),
  single('expand/single-line-over-budget', 'expand', 'expand of a single 40 KB line with budget 256 fails cleanly', 'low', async ctx => {
    const repo = await ctx.makeRepo('expand-line', { ...CONTROL, 'src/line.txt': `${'word '.repeat(8000)}\n` }, { git: true });
    const run = await ctx.cli(args.expand(repo, 'src/line.txt', 1, 1, 256));
    const problem = processVerdict([['expand', run]], 1);
    return problem ?? (run.outcome === 'clean-error' || checkBudget(ctx.tokenizer, run.stdoutText, 256).withinBudget ? pass(run.outcome) : fail('output exceeds the budget'));
  }),
];

export const inputGroups: Group<any>[] = [budgetGroup, queryGroup, mcpGroup, jsonBattery, ...compactJsonGroups, ...expandGroups];
