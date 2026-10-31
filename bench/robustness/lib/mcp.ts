import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { cliPath, type Variant } from './variants.js';

export interface McpToolResult {
  isError: boolean;
  text: string;
  raw: unknown;
}

export interface McpSession {
  pid: number | null;
  listTools(): Promise<{ name: string }[]>;
  call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult>;
  /** Resident set size of the server process in KiB, or null when unavailable. */
  rssKb(): number | null;
  stderr(): string;
  /** Closes the session and reports whether the server process terminated. */
  close(): Promise<{ exited: boolean }>;
}

interface SdkClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: { name: string }[] }>;
  callTool(params: unknown, schema?: unknown, options?: { timeout?: number }): Promise<{ isError?: boolean; content?: unknown }>;
  close(): Promise<void>;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts `cli.cjs mcp --root <root>` and talks to it with the MCP SDK shipped in the variant's own
 * node_modules (so client and server agree on the protocol revision).
 */
export async function openMcpSession(variant: Variant, root: string, options: { env?: Record<string, string>; scratchDir: string; timeoutMs?: number }): Promise<McpSession> {
  const requireFrom = createRequire(join(variant.root, 'package.json'));
  const { Client } = requireFrom('@modelcontextprotocol/sdk/client/index.js') as { Client: new (info: { name: string; version: string }) => SdkClient };
  const { StdioClientTransport, getDefaultEnvironment } = requireFrom('@modelcontextprotocol/sdk/client/stdio.js') as {
    StdioClientTransport: new (params: Record<string, unknown>) => { pid: number | null; stderr: NodeJS.ReadableStream | null };
    getDefaultEnvironment(): Record<string, string>;
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath(variant), 'mcp', `--root=${root}`],
    env: { ...getDefaultEnvironment(), ...variant.env, ...options.env, TMPDIR: options.scratchDir },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
  });
  const client = new Client({ name: 'reposqueeze-robustness', version: '1.0.0' });
  await client.connect(transport);
  const defaultTimeout = options.timeoutMs ?? 300_000;
  const pid = transport.pid;
  return {
    pid,
    stderr: () => stderr,
    async listTools() {
      return (await client.listTools()).tools;
    },
    async call(name, args, timeoutMs = defaultTimeout) {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
      const content = Array.isArray(result.content) ? (result.content as { type?: string; text?: string }[]) : [];
      return {
        isError: result.isError === true,
        text: content.map(part => (part.type === 'text' ? (part.text ?? '') : '')).join('\n'),
        raw: result,
      };
    },
    rssKb() {
      if (pid === null) return null;
      try {
        const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
        return out ? Number(out) : null;
      } catch {
        return null;
      }
    },
    async close() {
      try {
        await client.close();
      } catch {
        /* transport already gone */
      }
      if (pid === null) return { exited: true };
      for (let i = 0; i < 50; i++) {
        if (!alive(pid)) return { exited: true };
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
      return { exited: false };
    },
  };
}
