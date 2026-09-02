import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Store } from '../core/store.js';
import { registerNexplanTools } from './tools.js';

/**
 * NexPlan MCP server. Launched over stdio by any MCP-capable coding agent
 * (Claude Code, Codex, OpenCode, dsh). The board root comes from the
 * NEXPLAN_BOARD env var, falling back to `<cwd>/.nexplan`.
 */
async function main(): Promise<void> {
  const board = process.env.NEXPLAN_BOARD || path.join(process.cwd(), '.nexplan');
  const store = new Store({ root: board, agentName: process.env.NEXPLAN_AGENT || 'agent', autoCommit: true });

  try {
    await store.init();
  } catch (err) {
    console.error(`[nexplan] failed to initialise board at ${board}: ${(err as Error).message}`);
    process.exit(1);
  }

  const server = new McpServer({ name: 'nexplan', version: '0.1.0' });
  registerNexplanTools(server, store);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive until stdin closes.
  process.on('SIGINT', () => {
    server.close().then(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error(`[nexplan] fatal: ${err?.stack || err}`);
  process.exit(1);
});
