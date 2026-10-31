import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Repository } from './repository.js';
import { repositoryMap } from './context.js';
import { compactLog } from './compact.js';
import { compactJson } from './structured.js';
import { Engine } from './engine.js';

export async function serve(root: string, model?:string) {
  const repo = new Engine(root,model);
  const server = new McpServer({name:'reposqueeze-v2',version:'2.1.0'});
  const budget = z.number().int().min(256).max(32000).default(3000);
  const result = (text: string) => ({content:[{type:'text' as const,text}]});
  const annotations = {readOnlyHint:true,destructiveHint:false,openWorldHint:false};
  server.registerTool('reposqueeze_v2_context', {
    description:'Retrieve query-relevant source excerpts under a token budget using V2 perturbation consensus. Includes line citations, stable evidence IDs, stability diagnostics, and omissions. Consensus is not confidence; expand before editing.',
    inputSchema:{query:z.string().min(1).max(8000),budget,known:z.array(z.string()).max(200).default([]).describe('Only IDs whose exact full excerpt is still retained in the current model context; otherwise leave empty.')},annotations
  }, async ({query,budget,known}) => result((await repo.context(query,budget,known)).text));
  server.registerTool('reposqueeze_v2_expand', {
    description:'Read current exact source lines from an allowed repository path. Use for missing context or before edits. One-based ranges. Output reports any truncation.',
    inputSchema:{path:z.string().min(1),start:z.number().int().min(1),end:z.number().int().min(1),budget},annotations
  },async ({path,start,end,budget}) => result(await repo.expand(path,start,end,budget)));
  server.registerTool('reposqueeze_v2_map', {
    description:'Return a bounded repository file/symbol map. Map omissions are explicit; this is not complete semantic understanding.', inputSchema:{budget},annotations
  },async ({budget}) => result(repositoryMap(await repo.snapshot('__repository_map__'),budget)));
  server.registerTool('reposqueeze_v2_compact', {
    description:'Fold repeated log lines and prioritize diagnostics under a token budget. Lossy output is explicitly marked. This only reduces tokens when used BEFORE a log enters model context; do not resend already-seen logs for savings.',
    inputSchema:{text:z.string().max(2*1024*1024),budget},annotations
  },async ({text,budget}) => result(compactLog(text,budget).text));
  server.registerTool('reposqueeze_v2_json',{
    description:'Convert JSON to the smallest verified lossless representation among original JSON, minified JSON and TOON. Never truncate data. Use before data enters model context, not to recompress already-seen data.',
    inputSchema:{text:z.string().max(2*1024*1024)},annotations
  },async ({text})=>result(compactJson(text).text));
  await server.connect(new StdioServerTransport());
  return server;
}
