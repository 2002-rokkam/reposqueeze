import { symlink, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { args } from '../lib/cli.js';
import { git, gitInit } from '../lib/fixtures.js';
import { Rng } from '../lib/prng.js';
import { fail, pass, type Check, type Ctx, type Group, type Verdict } from './types.js';

interface Hostile {
  id: string;
  /** Path as given to expand. ROOT and OUTSIDE are substituted. */
  path: string;
  /** Normalises to the allowed file src/ok.ts: serving it is fine, serving anything else is not. */
  alias?: boolean;
  /** Also exercised through the CLI (NUL bytes cannot be passed on a command line). */
  cli: boolean;
  note: string;
}

const HOSTILE: Hostile[] = [
  { id: 'dotdot-outside-file', path: '../outside/secret-outside.txt', cli: true, note: 'relative traversal to a file outside the root' },
  { id: 'dotdot-etc-passwd', path: '../../../../../../../../etc/passwd', cli: false, note: 'deep relative traversal to /etc/passwd' },
  { id: 'absolute-etc-passwd', path: '/etc/passwd', cli: true, note: 'absolute path outside the root' },
  { id: 'absolute-inside-root', path: 'ROOT/src/ok.ts', cli: true, alias: true, note: 'absolute path of an allowed file inside the root' },
  { id: 'dot-segment-alias', path: 'src/../src/ok.ts', cli: true, alias: true, note: '"src/../src/ok.ts" (normalises to an allowed file)' },
  { id: 'file-as-directory-dotdot', path: 'src/ok.ts/../ok.ts', cli: false, alias: true, note: '"a.ts/../x" (file used as a directory)' },
  { id: 'leading-dot-slash', path: './src/ok.ts', cli: true, alias: true, note: '"./src/ok.ts"' },
  { id: 'double-slash', path: 'src//ok.ts', cli: false, alias: true, note: '"src//ok.ts"' },
  { id: 'trailing-slash', path: 'src/ok.ts/', cli: false, alias: true, note: '"src/ok.ts/"' },
  { id: 'windows-separators', path: 'src\\ok.ts', cli: true, alias: true, note: 'backslash separators' },
  { id: 'windows-traversal', path: '..\\outside\\secret-outside.txt', cli: false, note: 'backslash traversal' },
  { id: 'windows-drive', path: 'C:\\Windows\\win.ini', cli: false, note: 'Windows drive path' },
  { id: 'symlink-to-passwd', path: 'link-to-passwd', cli: true, note: 'tracked symlink to /etc/passwd' },
  { id: 'symlink-to-outside-relative', path: 'link-to-outside', cli: true, note: 'tracked symlink to a file outside the root (relative target)' },
  { id: 'symlink-to-outside-absolute', path: 'link-to-outside-abs', cli: false, note: 'tracked symlink to a file outside the root (absolute target)' },
  { id: 'symlinked-directory', path: 'linkdir/secret-outside.txt', cli: true, note: 'path through a directory symlink that leaves the root' },
  { id: 'symlink-loop', path: 'loop-a', cli: true, note: 'symlink loop a -> b -> a' },
  { id: 'symlink-loop-dir', path: 'selfdir/selfdir/src/ok.ts', cli: false, alias: true, note: 'directory symlink pointing at its parent' },
  { id: 'git-config', path: '.git/config', cli: true, note: '.git/config (holds a canary user name)' },
  { id: 'git-head', path: '.git/HEAD', cli: false, note: '.git/HEAD' },
  { id: 'dotenv', path: '.env', cli: true, note: '.env file' },
  { id: 'node-modules', path: 'node_modules/pkg/index.js', cli: true, note: 'excluded directory' },
  { id: 'cache-dir', path: '.reposqueeze-v2/file-sketch-v1.json.gz', cli: false, note: 'the tool\'s own cache directory' },
  { id: 'percent-encoded-dotdot', path: '%2e%2e/outside/secret-outside.txt', cli: false, note: 'percent-encoded traversal' },
  { id: 'double-dot-slash-variants', path: '....//....//etc/passwd', cli: false, note: '"....//" traversal variant' },
  { id: 'fullwidth-dots', path: '\uff0e\uff0e/outside/secret-outside.txt', cli: false, note: 'fullwidth dots' },
  { id: 'tilde-home', path: '~/.ssh/id_rsa', cli: false, note: '"~" is not expanded' },
  { id: 'env-var', path: '$HOME/.zshrc', cli: false, note: '"$HOME" is not expanded' },
  { id: 'newline-in-path', path: 'src/ok.ts\n/etc/passwd', cli: false, note: 'newline injection' },
  { id: 'nul-byte-suffix', path: 'src/ok.ts\u0000.png', cli: false, note: 'NUL byte truncation (MCP only; impossible on argv)' },
  { id: 'nul-byte-only', path: '\u0000', cli: false, note: 'path consisting of a NUL byte (MCP only)' },
  { id: 'very-long-path', path: `${'a/'.repeat(2500)}x.ts`, cli: false, note: '5 KB path' },
  { id: 'whitespace-path', path: '   ', cli: false, note: 'whitespace only' },
];

interface State {
  root: string;
  nogit: string;
  forbidden: { name: string; test: (text: string) => boolean }[];
  mcp: Map<string, { refused: boolean; text: string; error?: string }>;
  cli: Map<string, { refused: boolean; text: string; exitCode: number | null; detail: string }>;
  context: string;
  map: string;
  nogitContext: string;
  nogitMap: string;
  symlinkRoot: { exitCode: number | null; text: string };
}

async function build(ctx: Ctx, name: string, outsideFile: string, withGit: boolean): Promise<string> {
  const rng = Rng.from('paths-fixture');
  const root = await ctx.makeRepo(name, {
    'README.md': '# Traversal fixture\n',
    'src/ok.ts': "export const okMarker = 'PATHOK-MARKER';\n",
    '.env': `ENV_CANARY=ENVCANARY-${rng.string(12)}\n`,
    'node_modules/pkg/index.js': `module.exports = 'NODEMODCANARY-${rng.string(12)}';\n`,
  });
  await symlink('/etc/passwd', join(root, 'link-to-passwd'));
  await symlink('../outside/secret-outside.txt', join(root, 'link-to-outside'));
  await symlink(outsideFile, join(root, 'link-to-outside-abs'));
  await symlink('../outside', join(root, 'linkdir'));
  await symlink('loop-b', join(root, 'loop-a'));
  await symlink('loop-a', join(root, 'loop-b'));
  await symlink('.', join(root, 'selfdir'));
  if (withGit) {
    await gitInit(root);
    await git(root, ['config', '--local', 'user.name', `GITCONFIGCANARY-${rng.string(12)}`]);
  }
  return root;
}

async function setup(ctx: Ctx): Promise<State> {
  const rng = Rng.from('paths-fixture');
  const outside = join(ctx.dir, 'outside');
  await mkdir(outside, { recursive: true });
  const outsideFile = join(outside, 'secret-outside.txt');
  const canary = `OUTSIDECANARY-${rng.string(16)}`;
  await writeFile(outsideFile, `${canary}\n`);
  const root = await build(ctx, 'traversal', outsideFile, true);
  const nogit = await build(ctx, 'traversal-nogit', outsideFile, false);
  const envCanary = (await readFile(join(root, '.env'), 'utf8')).split('=')[1].trim();
  const forbidden = [
    { name: 'outside-file content', test: (text: string) => text.includes(canary) },
    { name: '/etc/passwd content', test: (text: string) => /^root:[^:\n]*:0:0:/m.test(text) || text.includes('nobody:*:-2:-2') },
    { name: '.env content', test: (text: string) => text.includes(envCanary) },
    { name: 'node_modules content', test: (text: string) => text.includes('NODEMODCANARY-') },
    { name: '.git/config content', test: (text: string) => text.includes('GITCONFIGCANARY-') },
  ];
  const state: State = { root, nogit, forbidden, mcp: new Map(), cli: new Map(), context: '', map: '', nogitContext: '', nogitMap: '', symlinkRoot: { exitCode: null, text: '' } };
  const resolvePath = (path: string) => path.replace('ROOT', root);

  const session = await ctx.mcp(root);
  try {
    for (const item of HOSTILE) {
      try {
        const result = await session.call('reposqueeze_v2_expand', { path: resolvePath(item.path), start: 1, end: 50, budget: 2000 });
        state.mcp.set(item.id, { refused: result.isError, text: result.text });
      } catch (error) {
        state.mcp.set(item.id, { refused: true, text: '', error: error instanceof Error ? error.message.slice(0, 120) : String(error) });
      }
    }
  } finally {
    await session.close();
  }

  for (const item of HOSTILE.filter(entry => entry.cli)) {
    const run = await ctx.cli(args.expand(root, resolvePath(item.path), 1, 50, 2000));
    state.cli.set(item.id, { refused: run.exitCode !== 0, text: run.stdoutText + run.stderrText, exitCode: run.exitCode, detail: run.detail });
  }

  const query = 'outside secret canary passwd root link target loop';
  state.context = (await ctx.cli(args.context(root, query, 4000))).stdoutText;
  state.map = (await ctx.cli(args.map(root, 4000))).stdoutText;
  state.nogitContext = (await ctx.cli(args.context(nogit, query, 4000))).stdoutText;
  state.nogitMap = (await ctx.cli(args.map(nogit, 4000))).stdoutText;

  const linkedRoot = join(ctx.dir, 'root-link');
  await symlink(root, linkedRoot);
  const run = await ctx.cli(args.context(linkedRoot, 'okMarker', 1000));
  state.symlinkRoot = { exitCode: run.exitCode, text: run.stdoutText };
  return state;
}

function hostileCheck(item: Hostile): Check<State> {
  return {
    id: `paths/${item.id}`,
    title: `expand refuses or safely serves: ${item.note}`,
    severity: item.id.includes('passwd') || item.id.includes('outside') || item.id.includes('symlink') ? 'critical' : 'high',
    run(state): Verdict {
      const channels: [string, { refused: boolean; text: string }][] = [['mcp', state.mcp.get(item.id)!]];
      const cli = state.cli.get(item.id);
      if (cli) channels.push(['cli', cli]);
      const problems: string[] = [];
      for (const [channel, result] of channels) {
        const leaked = state.forbidden.filter(rule => rule.test(result.text)).map(rule => rule.name);
        if (leaked.length) problems.push(`${channel}: served ${leaked.join(', ')}`);
        else if (!result.refused && !(item.alias && result.text.includes('PATHOK-MARKER'))) problems.push(`${channel}: accepted a hostile path and returned unexpected content`);
      }
      return problems.length ? fail(problems.join('; ')) : pass(channels.map(([channel, result]) => `${channel} ${result.refused ? 'refused' : 'served inside file'}`).join(', '));
    },
  };
}

const outputsClean = (text: string, state: State): string[] => state.forbidden.filter(rule => rule.test(text)).map(rule => rule.name);

export const pathsGroup: Group<State> = {
  id: 'paths',
  category: 'path-traversal',
  title: 'Path traversal, symlinks and special paths through expand (CLI and MCP)',
  setup,
  checks: [
    ...HOSTILE.map(hostileCheck),
    {
      id: 'paths/context-does-not-follow-symlinks',
      title: 'context and map never emit content or targets reachable only through symlinks (git checkout)',
      severity: 'critical',
      run: state => {
        const leaked = [...outputsClean(state.context, state), ...outputsClean(state.map, state)];
        const targets = /\/etc\/passwd|outside\/secret-outside/.test(state.context + state.map);
        return leaked.length || targets ? fail(`leaked ${leaked.join(', ') || 'symlink targets'}`) : pass();
      },
    },
    {
      id: 'paths/context-does-not-follow-symlinks-nongit',
      title: 'same as above for a non-git directory (filesystem walker)',
      severity: 'critical',
      run: state => {
        const leaked = [...outputsClean(state.nogitContext, state), ...outputsClean(state.nogitMap, state)];
        const targets = /\/etc\/passwd|outside\/secret-outside/.test(state.nogitContext + state.nogitMap);
        return leaked.length || targets ? fail(`leaked ${leaked.join(', ') || 'symlink targets'}`) : pass();
      },
    },
    {
      id: 'paths/symlinked-root-works',
      title: '--root given as a symlink to the repository works and exposes nothing outside it',
      severity: 'low',
      run: state => (state.symlinkRoot.exitCode === 0 && state.symlinkRoot.text.includes('PATHOK-MARKER') && !outputsClean(state.symlinkRoot.text, state).length ? pass() : fail(`exit ${state.symlinkRoot.exitCode}`)),
    },
  ],
};
