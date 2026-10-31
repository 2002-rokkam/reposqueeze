import { args } from '../lib/cli.js';
import { filesContaining, readCacheFiles, git } from '../lib/fixtures.js';
import { buildCanaries, controlFiles, type Canary } from './canaries.js';
import { fail, pass, type Check, type Ctx, type Group, type Verdict } from './types.js';

interface Output {
  channel: string;
  text: string;
}

interface State {
  canaries: Canary[];
  outputs: Output[];
  cacheHits: Map<string, string[]>;
  controlRetrieved: boolean;
  controlExpanded: boolean;
  problems: string[];
}

const CONTROL_ANCHOR = 'canaryanchorcontrol';

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function setup(ctx: Ctx): Promise<State> {
  const canaries = buildCanaries();
  const files: Record<string, string> = { ...controlFiles() };
  for (const canary of canaries) files[canary.path] = canary.content;
  const repo = await ctx.makeRepo('canaries', files, { git: true });
  const state: State = { canaries, outputs: [], cacheHits: new Map(), controlRetrieved: false, controlExpanded: false, problems: [] };
  const record = (channel: string, text: string) => state.outputs.push({ channel, text });

  const anchors = canaries.map(canary => canary.anchor);
  const groups = chunk(anchors, 6);
  groups[0].unshift(CONTROL_ANCHOR);
  for (const [index, group] of groups.entries()) {
    const run = await ctx.cli(args.context(repo, group.join(' '), 32000));
    if (run.outcome !== 'ok') state.problems.push(`context q${index}: ${run.outcome} ${run.detail}`);
    record(`context:q${index}`, run.stdoutText);
  }
  const generic = await ctx.cli(args.context(repo, 'password secret token key credentials private connection string', 32000));
  record('context:generic', generic.stdoutText);
  const json = await ctx.cli(args.context(repo, groups[1].join(' '), 32000, true));
  record('context:json', json.stdoutText);
  const map = await ctx.cli(args.map(repo, 32000));
  record('map', map.stdoutText);
  if (map.outcome !== 'ok') state.problems.push(`map: ${map.outcome} ${map.detail}`);

  // Persistent-index mode (forced by a low threshold) so that cache files exist and can be inspected.
  const { env, cacheDirs } = ctx.cacheEnv('secrets-cache');
  const cascadeEnv = { ...env, REPOSQUEEZE_LARGE_THRESHOLD: '10' };
  for (const [index, group] of groups.slice(0, 2).entries()) {
    const run = await ctx.cli(args.context(repo, group.join(' '), 32000), { env: cascadeEnv });
    if (run.outcome !== 'ok') state.problems.push(`cascade context q${index}: ${run.outcome} ${run.detail}`);
    record(`context:cascade:q${index}`, run.stdoutText);
  }
  const listed = (await git(repo, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  const cacheFiles = await readCacheFiles([...cacheDirs, ...listed.map(file => `${repo}/${file}`)]);
  for (const canary of canaries) {
    const found = filesContaining(cacheFiles, canary.needles);
    if (found.length) state.cacheHits.set(canary.id, [...new Set(found.map(hit => hit.path.split('/').slice(-2).join('/')))]);
  }

  // One MCP session: expand every canary file by explicit path, then a context and map call.
  const session = await ctx.mcp(repo);
  try {
    for (const canary of canaries) {
      const result = await session.call('reposqueeze_v2_expand', { path: canary.path, start: 1, end: 400, budget: 32000 }).catch(error => ({ isError: true, text: String(error), raw: null }));
      record(`mcp-expand:${canary.id}`, result.text);
    }
    const control = await session.call('reposqueeze_v2_expand', { path: 'src/control.py', start: 1, end: 10, budget: 1000 });
    state.controlExpanded = !control.isError && control.text.includes(CONTROL_ANCHOR);
    for (const [index, group] of groups.entries()) record(`mcp-context:q${index}`, (await session.call('reposqueeze_v2_context', { query: group.join(' '), budget: 32000 })).text);
    record('mcp-map', (await session.call('reposqueeze_v2_map', { budget: 32000 })).text);
  } finally {
    await session.close();
  }

  // CLI expand for the highest-severity canaries (the same code path as MCP in 2.1, separate entry point).
  for (const canary of canaries.filter(item => item.severity === 'critical' && !item.inFileName).slice(0, 4)) {
    const run = await ctx.cli(args.expand(repo, canary.path, 1, 400, 32000));
    record(`cli-expand:${canary.id}`, run.stdoutText + run.stderrText);
  }
  state.controlRetrieved = state.outputs.some(output => output.channel.startsWith('context:') && output.text.includes(CONTROL_ANCHOR));
  return state;
}

function checkFor(canary: Canary): Check<State> {
  const label = (channel: string) => (channel.startsWith('context:cascade') ? 'context(cascade)' : channel.split(':')[0]);
  return {
    id: `secrets/${canary.id}`,
    title: `${canary.format} never appears in any output or cache file`,
    severity: canary.severity,
    run(state): Verdict {
      if (!state.controlRetrieved) return { status: 'error', note: `control retrieval failed (${state.problems.join('; ') || 'no control excerpt in any context output'})` };
      const leaks = new Set<string>();
      for (const output of state.outputs) if (canary.needles.some(needle => output.text.includes(needle))) leaks.add(label(output.channel));
      const cache = state.cacheHits.get(canary.id);
      if (cache) leaks.add(`cache file ${cache.join(',')}`);
      return leaks.size ? fail(`leaked via ${[...leaks].sort().join(', ')}`) : pass();
    },
  };
}

export const secretsGroup: Group<State> = {
  id: 'secrets',
  category: 'secrets',
  title: 'Planted canary secrets (context, map, expand, MCP, cache files)',
  setup,
  checks: [
    {
      id: 'secrets/control-retrieval',
      title: 'control: a benign file with a rare anchor is retrievable and expandable (the leak checks are not vacuous)',
      severity: 'high',
      run: state => (state.controlRetrieved && state.controlExpanded ? pass() : fail(`context control ${state.controlRetrieved ? 'ok' : 'missing'}, expand control ${state.controlExpanded ? 'ok' : 'missing'}; ${state.problems.join('; ')}`)),
    },
    ...buildCanaries().map(checkFor),
  ],
};
