import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Workspace } from '../core/workspace.js';
import { registerNexplanTools } from './tools.js';

/**
 * NexPlan MCP server over the network (HTTP / SSE), so a coding agent on another
 * machine (e.g. ZCode) can connect to the same git-backed board.
 *
 * One McpServer instance is created **per session/transport**: the MCP SDK only
 * allows a single protocol instance to be connected to one transport at a time.
 * The Workspace (and therefore the git-backed board) is shared by all sessions.
 *
 * Env:
 *   NEXPLAN_BOARD      workspace root (default <cwd>/.nexplan)
 *   NEXPLAN_AGENT      default author attribution for writes (default 'agent')
 *   NEXPLAN_MCP_TOKEN  optional bearer token; when set every request must send
 *                      `Authorization: Bearer <token>` (ZCode can set request headers)
 *   MCP_HOST / MCP_PORT  bind address/port (default 0.0.0.0 / 3345)
 *
 * Endpoints:
 *   POST|GET|DELETE /mcp        MCP Streamable HTTP transport
 *   GET  /sse  + POST /sse/message   legacy MCP SSE transport
 */
async function main(): Promise<void> {
  const board = process.env.NEXPLAN_BOARD || path.join(process.cwd(), '.nexplan');
  const agentName = process.env.NEXPLAN_AGENT || 'agent';
  const token = process.env.NEXPLAN_MCP_TOKEN?.trim() || '';
  const host = process.env.MCP_HOST || '0.0.0.0';
  const port = Number(process.env.MCP_PORT ?? 3345);

  const workspace = new Workspace({ root: board, agentName, autoCommit: true });
  await workspace.init();

  const newMcpServer = (): McpServer => {
    const server = new McpServer({ name: 'nexplan', version: '0.4.0' });
    registerNexplanTools(server, workspace);
    return server;
  };

  const app = express();

  // Optional shared-secret gate: protects the board when the endpoint is exposed
  // on a LAN. ZCode lets you add per-server request headers.
  if (token) {
    app.use((req, res, next) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    });
  }

  app.get('/', (_req, res) => {
    res.type('text/plain').send(
      `NexPlan MCP over HTTP\n` +
        `workspace: ${board}\n` +
        `streamable HTTP: POST/GET/DELETE /mcp (MCP session header: mcp-session-id)\n` +
        `legacy SSE:      GET /sse  (messages → POST /sse/message?sessionId=…)\n`,
    );
  });

  // ---------------- MCP Streamable HTTP (/mcp) ----------------
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  async function handleStreamable(req: express.Request, res: express.Response, parsedBody?: unknown) {
    const sessionId = (req.headers['mcp-session-id'] as string | undefined) || undefined;
    if (sessionId && !sessions.has(sessionId)) {
      // Server restarts wipe in-memory sessions, and a long-idle GET stream can
      // close the transport on our side — either way the client must re-run
      // initialize. Log so these are diagnosable.
      process.stderr.write(`[nexplan] reject ${req.method} /mcp unknown session ${sessionId}\n`);
      res.status(404).json({ error: `unknown session: ${sessionId}` });
      return;
    }
    let entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      const server = newMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { server, transport });
          process.stderr.write(`[nexplan] session created ${id}\n`);
        },
        onsessionclosed: (id) => {
          // Cleanup only. NEVER call server.close() here: the transport is
          // already closing and closing the protocol would re-close the same
          // transport → infinite recursion (RangeError: call stack exceeded).
          sessions.delete(id);
          process.stderr.write(`[nexplan] session closed ${id}\n`);
        },
      });
      await server.connect(transport);
      entry = { server, transport };
    }
    await entry.transport.handleRequest(req, res, parsedBody);
  }

  // Note: the JSON body parser is scoped to the /mcp POST route on purpose —
  // /sse/message needs its raw request stream, which a global body-parser would
  // consume first.
  app.post('/mcp', express.json({ limit: '2mb' }), (req, res) => {
    handleStreamable(req, res, req.body).catch((err) => {
      res.status(500).json({ error: (err as Error).message });
    });
  });
  app.get('/mcp', (req, res) => {
    handleStreamable(req, res).catch((err) => {
      res.status(500).json({ error: (err as Error).message });
    });
  });
  app.delete('/mcp', (req, res) => {
    const sessionId = (req.headers['mcp-session-id'] as string | undefined) || '';
    const entry = sessions.get(sessionId);
    if (entry) {
      entry.transport.close();
      entry.server.close().catch(() => {});
      sessions.delete(sessionId);
      res.status(200).end();
    } else {
      res.status(404).json({ error: `unknown session: ${sessionId}` });
    }
  });

  // ---------------- legacy MCP SSE (/sse) ----------------
  const sseSessions = new Map<string, { server: McpServer; transport: SSEServerTransport }>();
  app.get('/sse', async (req, res) => {
    const server = newMcpServer();
    const transport = new SSEServerTransport('/sse/message', res);
    sseSessions.set(transport.sessionId, { server, transport });
    transport.onclose = () => {
      // Cleanup only — closing the protocol here re-closes this transport and
      // recurses infinitely (see onsessionclosed above).
      sseSessions.delete(transport.sessionId);
      process.stderr.write(`[nexplan] sse session closed ${transport.sessionId}\n`);
    };
    try {
      await server.connect(transport);
    } catch (err) {
      process.stderr.write(`[nexplan] /sse connect failed: ${(err as Error)?.stack || err}\n`);
      sseSessions.delete(transport.sessionId);
      server.close().catch(() => {});
      res.status(500).end();
    }
  });
  app.post('/sse/message', async (req, res) => {
    const id = String(req.query.sessionId || '');
    const entry = sseSessions.get(id);
    if (!entry) {
      res.status(400).end();
      return;
    }
    await entry.transport.handlePostMessage(req, res);
  });

  const httpServer = app.listen(port, host, () => {
    process.stdout.write(`\n  NexPlan MCP (HTTP/SSE) → http://${host}:${port}/mcp\n`);
    process.stdout.write(`  workspace: ${board}\n`);
    process.stdout.write(`  agent attribution: ${agentName}${token ? ' · auth: bearer token' : ' · auth: none (LAN only!)'}\n\n`);
  });

  const shutdown = () => {
    for (const { transport, server } of sessions.values()) {
      transport.close();
      server.close().catch(() => {});
    }
    for (const { transport, server } of sseSessions.values()) {
      transport.close();
      server.close().catch(() => {});
    }
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`[nexplan] mcp http server failed: ${err?.stack || err}\n`);
  process.exit(1);
});
