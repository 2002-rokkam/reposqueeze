import { parseArgs } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { Engine } from './engine.js';
import { compactJson } from './structured.js';
import { repositoryMap } from './context.js';
import { compactLog } from './compact.js';
import { serve, VERSION } from './mcp.js';
import { INSTRUCTIONS } from './instructions.js';
import { findSymbols, renderOutline, renderSymbols } from './symbols.js';

const HELP = `RepoSqueeze V2 ${VERSION} — local, deterministic, token-budgeted repository context

reposqueeze-v2 context --root REPO --query "task, error or identifiers" [--budget 3000] [--json]
reposqueeze-v2 context --root REPO --query - < trace.txt     read the query from stdin
reposqueeze-v2 map --root REPO [--budget 1500]               repository map
reposqueeze-v2 map --root REPO --path src/file.ts            outline of one file (definitions with line ranges)
reposqueeze-v2 map --root REPO --query ParseArgs             definitions whose names match
reposqueeze-v2 expand --root REPO --path src/file.ts --start 1 --end 100
reposqueeze-v2 compact --budget 2000 < test-output.log       fold repeated log lines, keep diagnostics
reposqueeze-v2 json < data.json                              smallest verified lossless JSON form
reposqueeze-v2 mcp --root REPO [--tools core|all]            stdio MCP server (core = context, expand, map)
reposqueeze-v2 init --root REPO                              write .github/instructions/reposqueeze-v2.instructions.md

Options: --semantic-model all-minilm (opt-in local Ollama embeddings, localhost only)
         --features "-prf,-git" | none   switch retrieval features off for ablations (also RSQ_FEATURES)
Token counts use o200k_base, not provider billing. Default mode makes no network calls. Excerpts may omit relevant code.`;

async function readStdin(limit = 2 * 1024 * 1024): Promise<string> {
  // Bound stdin while reading rather than accepting unbounded memory use.
  let input = '';
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > limit) throw new Error('stdin exceeds 2 MiB');
    input += chunk;
  }
  return input;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string', default: '.' },
      query: { type: 'string', short: 'q' },
      budget: { type: 'string', short: 'b', default: '3000' },
      'semantic-model': { type: 'string' },
      features: { type: 'string' },
      tools: { type: 'string', default: 'core' },
      json: { type: 'boolean' },
      path: { type: 'string' },
      start: { type: 'string', default: '1' },
      end: { type: 'string', default: '100' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0];
  if (values.version) {
    console.log(VERSION);
    return;
  }
  if (values.help || !command) {
    console.log(HELP);
    return;
  }
  const root = resolve(values.root!);
  const options = { semanticModel: values['semantic-model'], features: values.features };
  if (command === 'mcp') {
    if (values.tools !== 'core' && values.tools !== 'all') throw new Error('--tools must be core or all');
    await serve(root, { ...options, tools: values.tools });
    return;
  }
  if (command === 'init') {
    const path = join(root, '.github/instructions/reposqueeze-v2.instructions.md');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `---\napplyTo: "**"\n---\n${INSTRUCTIONS}`, { flag: 'wx' });
    console.log(`Created ${path}`);
    return;
  }
  const budget = Number(values.budget);
  if (command === 'compact' || command === 'json') {
    const input = await readStdin();
    const out = command === 'json' ? compactJson(input) : compactLog(input, budget);
    console.log(values.json ? JSON.stringify(out, null, 2) : out.text);
    return;
  }
  if (!['context', 'map', 'expand'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const repo = new Engine(root, options);
  if (command === 'context') {
    const query = values.query === '-' ? await readStdin() : values.query ?? '';
    const pack = await repo.context(query, budget);
    console.log(values.json ? JSON.stringify(pack, null, 2) : pack.text);
    if (!values.json) console.error(JSON.stringify(pack.stats));
    return;
  }
  if (command === 'expand') {
    console.log(await repo.expandRange(values.path ?? '', Number(values.start), Number(values.end), budget));
    return;
  }
  if (values.path) {
    const snapshot = await repo.snapshot(values.path);
    const file = snapshot.files.find(candidate => candidate.path === values.path);
    if (!file) throw new Error('Path is excluded, absent, outside repository, or beyond scan limits');
    console.log(renderOutline(file.path, file.chunks, file.text.split('\n').length, budget));
    return;
  }
  const snapshot = await repo.snapshot(values.query ?? '__repository_map__');
  console.log(values.query ? renderSymbols(findSymbols(snapshot, values.query), budget) : repositoryMap(snapshot, budget));
}

main().catch(error => {
  console.error(`RepoSqueeze V2: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
