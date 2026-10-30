import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { Repository } from './repository.js';
import { Engine } from './engine.js';
import { compactJson } from './structured.js';
import { contextPack, expand, repositoryMap } from './context.js';
import { compactLog } from './compact.js';
import { serve } from './mcp.js';
import { INSTRUCTIONS } from './instructions.js';

async function main() {
  const {values,positionals} = parseArgs({allowPositionals:true,options:{root:{type:'string',default:'.'},query:{type:'string',short:'q'},budget:{type:'string',short:'b',default:'3000'},'semantic-model':{type:'string'},json:{type:'boolean'},path:{type:'string'},start:{type:'string',default:'1'},end:{type:'string',default:'100'},help:{type:'boolean',short:'h'}}});
  const command = positionals[0];
  if (values.help || !command) {
    console.log(`RepoSqueeze V2 2.1.0 — local context, measurable budgets

reposqueeze-v2 context --root REPO --query "task or identifiers" --budget 3000 [--json]
reposqueeze-v2 map --root REPO [--budget 1500]
reposqueeze-v2 expand --root REPO --path src/file.ts --start 1 --end 100
reposqueeze-v2 compact --budget 2000 < test-output.log
reposqueeze-v2 json < data.json
reposqueeze-v2 mcp --root REPO
reposqueeze-v2 init --root REPO

Add --semantic-model all-minilm to context/mcp for local Ollama embeddings (opt-in, localhost).
Token counts use o200k_base, not provider billing. Default mode makes no network calls. Excerpts may omit relevant code.
init creates .github/instructions/reposqueeze-v2.instructions.md without overwriting existing files.`); return;
  }
  const root = resolve(values.root!);
  if (command === 'mcp') { await serve(root,values['semantic-model']); return; }
  if (command === 'init') {
    const path = join(root,'.github/instructions/reposqueeze-v2.instructions.md');
    await mkdir(dirname(path),{recursive:true});
    await writeFile(path,`---\napplyTo: "**"\n---\n${INSTRUCTIONS}`,{flag:'wx'});
    console.log(`Created ${path}`); return;
  }
  const budget = Number(values.budget);
  if (command === 'compact' || command === 'json') {
    // Bound stdin while reading rather than accepting unbounded memory use.
    let input = '', bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += Buffer.byteLength(chunk); if (bytes > 2*1024*1024) throw new Error('stdin exceeds 2 MiB'); input += chunk;
    }
    const out = command === 'json' ? compactJson(input) : compactLog(input,budget);
    console.log(values.json ? JSON.stringify(out,null,2) : out.text); return;
  }
  const repo = new Engine(root,values['semantic-model']);
  if (!['context','map','expand'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if(command==='context') {
    const pack=await repo.context(values.query ?? '',budget);
    console.log(values.json ? JSON.stringify(pack,null,2) : pack.text);
    if (!values.json) console.error(JSON.stringify(pack.stats));
    return;
  }
  const s = await repo.snapshot(command==='expand'?(values.path??''):'__repository_map__');
  if (command === 'map') console.log(repositoryMap(s,budget));
  if (command === 'expand') console.log(expand(s,values.path ?? '',Number(values.start),Number(values.end),budget));
}
main().catch(error => {console.error(`RepoSqueeze V2: ${error instanceof Error ? error.message : String(error)}`);process.exitCode=1;});
