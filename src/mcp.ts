#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildContext } from './context.js';
import { buildTools } from './tools.js';

/**
 * gmail-mcp — the MCP server entrypoint. Speaks JSON-RPC over stdio, so it is
 * launched as a child process by an MCP host (Claude Desktop, Claude Code,
 * Cursor, …). Registers the Gmail + Calendar tools and delegates each call to
 * the shared handlers in tools.ts.
 */
async function main(): Promise<void> {
  // buildContext() throws with a clear message if no OAuth client id is set.
  // Fail before connecting so the host surfaces the error instead of a silent
  // dead server.
  const ctx = buildContext();

  const server = new McpServer({ name: 'gmail-mcp', version: '0.1.0' });

  for (const tool of buildTools()) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.shape },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(ctx, args);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [{ type: 'text', text: `Error: ${message}` }],
          };
        }
      },
    );
  }

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  // stderr only — stdout is the JSON-RPC channel and must not be polluted.
  process.stderr.write(`gmail-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
