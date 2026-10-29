import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
test('built MCP server: handshake, discovery, context, expansion, JSON and errors',async t=>{
  const client=new Client({name:'reposqueeze-integration',version:'1.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/cli.cjs'),'mcp','--root',process.cwd()],stderr:'pipe'});
  t.after(()=>client.close());await client.connect(transport);
  const list=await client.listTools();assert.equal(list.tools.length,5);
  const pack=await client.callTool({name:'reposqueeze_context',arguments:{query:'contextPack budget',budget:512}});
  assert(!pack.isError);assert.match(JSON.stringify(pack.content),/REPOSQUEEZE/);
  const read=await client.callTool({name:'reposqueeze_expand',arguments:{path:'src/tokens.ts',start:1,end:3}});assert(!read.isError);assert.match(JSON.stringify(read.content),/getEncoding/);
  const bad=await client.callTool({name:'reposqueeze_expand',arguments:{path:'../outside',start:1,end:2}});assert.equal(bad.isError,true);
  const json=await client.callTool({name:'reposqueeze_json',arguments:{text:'{ "x": 1 }'}});assert(!json.isError);
});
