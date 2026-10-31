import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { expand, repositoryMap } from './context.js';
import { compactLog } from './compact.js';
import { compactJson } from './structured.js';
import { Engine } from './engine.js';
import { findSymbols, renderOutline, renderSymbols } from './symbols.js';
import { checkBudget } from './tokens.js';

export interface ServeOptions {
  semanticModel?: string;
  /** 'core' (default): context, expand, map. 'all' adds compact and json, which only save tokens when the text has not yet entered the model's context. */
  tools?: 'core' | 'all';
  features?: string;
}

export const VERSION = '2.2.0';

export async function serve(root: string, options: ServeOptions | string = {}) {
  const { semanticModel, tools = 'core', features } = typeof options === 'string' ? { semanticModel: options } : options;
  const repo = new Engine(root, { semanticModel, features });
  const server = new McpServer({ name: 'reposqueeze-v2', version: VERSION });
  // Bounds are enforced by the handlers (checkBudget, expand) so the advertised schema stays small.
  const budget = z.number().optional();
  const limit = (value: number | undefined, fallback = 3000) => checkBudget(value ?? fallback);
  const result = (text: string) => ({ content: [{ type: 'text' as const, text }] });
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    'reposqueeze_v2_context',
    {
      description: 'Find the code for a task, error or question. Returns verbatim, line-cited source excerpts within a token budget. Local, read-only, not exhaustive: expand before editing.',
      inputSchema: {
        query: z.string(),
        budget,
        known: z.array(z.string()).optional().describe('Evidence ids still visible in your context; otherwise omit.'),
      },
      annotations,
    },
    async ({ query, budget, known }) => result((await repo.context(query, limit(budget), (known ?? []).slice(0, 200))).text),
  );
  server.registerTool(
    'reposqueeze_v2_expand',
    {
      description: 'Read exact current source lines (one-based, inclusive) of one repository file.',
      inputSchema: { path: z.string(), start: z.number(), end: z.number(), budget },
      annotations,
    },
    async ({ path, start, end, budget }) => result(await repo.expandRange(path, start, end, limit(budget))),
  );
  server.registerTool(
    'reposqueeze_v2_map',
    {
      description: 'Repository map; with path, the outline of that file; with query, definitions whose names match.',
      inputSchema: { budget, path: z.string().optional(), query: z.string().optional() },
      annotations,
    },
    async ({ budget, path, query }) => {
      const tokensAllowed = limit(budget, 1500);
      if (path) {
        const snapshot = await repo.snapshot(path);
        const file = snapshot.files.find(candidate => candidate.path === path);
        if (!file) throw new Error('Path is excluded, absent, outside repository, or beyond scan limits');
        return result(renderOutline(file.path, file.chunks, file.text.split('\n').length, tokensAllowed));
      }
      const snapshot = await repo.snapshot(query ?? '__repository_map__');
      return result(query ? renderSymbols(findSymbols(snapshot, query), tokensAllowed) : repositoryMap(snapshot, tokensAllowed));
    },
  );
  if (tools === 'all') {
    server.registerTool(
      'reposqueeze_v2_compact',
      {
        description: 'Fold repeated log lines and keep diagnostics within a budget. Lossy output is marked. Saves tokens only for text that has not entered the context yet.',
        inputSchema: { text: z.string(), budget },
        annotations,
      },
      async ({ text, budget }) => result(compactLog(text, limit(budget, 2000)).text),
    );
    server.registerTool(
      'reposqueeze_v2_json',
      {
        description: 'Convert JSON to the smallest verified lossless form (JSON, minified or TOON). Saves tokens only for data that has not entered the context yet.',
        inputSchema: { text: z.string() },
        annotations,
      },
      async ({ text }) => result(compactJson(text).text),
    );
  }
  await server.connect(new StdioServerTransport());
  return server;
}
