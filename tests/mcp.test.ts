import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

async function connect(t: test.TestContext, tools?: string) {
  const client = new Client({ name: 'reposqueeze-integration', version: '1.0' });
  const args = [resolve('dist/cli.cjs'), 'mcp', '--root', process.cwd(), ...(tools ? ['--tools', tools] : [])];
  const transport = new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

test('built MCP server (default tools): handshake, discovery, context, expansion, map modes and errors', async t => {
  const client = await connect(t);
  const names = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['reposqueeze_v2_context', 'reposqueeze_v2_expand', 'reposqueeze_v2_map']);
  const pack = await client.callTool({ name: 'reposqueeze_v2_context', arguments: { query: 'contextPack budget', budget: 512 } });
  assert(!pack.isError);
  assert.match(JSON.stringify(pack.content), /reposqueeze/i);
  const read = await client.callTool({ name: 'reposqueeze_v2_expand', arguments: { path: 'src/tokens.ts', start: 1, end: 3 } });
  assert(!read.isError);
  assert.match(JSON.stringify(read.content), /getEncoding|tiktoken/);
  const bad = await client.callTool({ name: 'reposqueeze_v2_expand', arguments: { path: '../outside', start: 1, end: 2 } });
  assert.equal(bad.isError, true);
  const outline = await client.callTool({ name: 'reposqueeze_v2_map', arguments: { path: 'src/tokens.ts' } });
  assert(!outline.isError);
  assert.match(JSON.stringify(outline.content), /checkBudget/);
  const symbols = await client.callTool({ name: 'reposqueeze_v2_map', arguments: { query: 'checkBudget' } });
  assert(!symbols.isError);
  assert.match(JSON.stringify(symbols.content), /src\/tokens\.ts/);
});

test('built MCP server (--tools all) also exposes the pre-context compactors', async t => {
  const client = await connect(t, 'all');
  assert.equal((await client.listTools()).tools.length, 5);
  const json = await client.callTool({ name: 'reposqueeze_v2_json', arguments: { text: '{ "x": 1 }' } });
  assert(!json.isError);
  const log = await client.callTool({ name: 'reposqueeze_v2_compact', arguments: { text: 'ok\n'.repeat(400) + 'ERROR boom\n', budget: 256 } });
  assert(!log.isError);
  assert.match(JSON.stringify(log.content), /ERROR boom/);
});
