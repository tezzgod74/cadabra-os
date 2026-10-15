// Cadabra's tools as a Streamable-HTTP MCP server on 127.0.0.1:<random port>,
// protected by a random bearer token. Used by backends that can only attach
// external MCP servers (Codex app-server; also usable for `claude -p` /
// `copilot --additional-mcp-config`).

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ToolDef } from './tools';

export interface McpHttpHandle {
  url: string;
  token: string;
  close(): Promise<void>;
}

/** Header a backend session sends so its calls can be tied to (and revoked with) that session. */
export const SESSION_HEADER = 'x-cadabra-session';

function buildServer(defs: ToolDef[], version: string, refuse: () => string | null): McpServer {
  const server = new McpServer({ name: 'cadabra', version });
  for (const d of defs) {
    server.registerTool(
      d.name,
      { description: d.description, inputSchema: d.shape as any, annotations: { readOnlyHint: d.readOnly, destructiveHint: !d.readOnly } },
      (async (args: any) => {
        // REVIEW-2 N4: calls from an orphaned / replaced backend session are refused.
        const why = refuse();
        if (why) return { content: [{ type: 'text', text: why }], isError: true };
        return d.handler(args);
      }) as any,
    );
  }
  return server;
}

function tokenOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Round 7: Claude Code's PreToolUse HTTP hook for its web tools. The hook input
 * (tool_name, tool_input) comes in; the PreToolUse decision goes out. Web tools
 * are NOT in Claude Code's allow-list, so if this hook fails the call is denied.
 */
export type WebHook = (toolName: string, toolInput: any) => Promise<{ allow: boolean; reason?: string }>;

/**
 * 0.9.4 (REVIEW-0.9.3 W1): Cadabra always answers the hook with an explicit
 * decision well before Claude Code's own hook timeout (120 s, claude-cli.ts).
 * With no decision, Claude Code falls back to its own rules, which pre-approve
 * WebFetch to ~70 documentation hosts. A slow guard (e.g. a confirm card left
 * unanswered) therefore becomes an explicit deny at this deadline.
 */
export const WEB_HOOK_DEADLINE_MS = 100_000;

export function hookResponse(d: { allow: boolean; reason?: string }) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.allow ? 'allow' : 'deny', permissionDecisionReason: d.reason ?? (d.allow ? 'Allowed by Cadabra' : 'Not allowed by Cadabra') } };
}

export async function startMcpHttp(defs: () => ToolDef[], version: string, checkSession: (key: string | undefined) => string | null = () => null, webHook?: WebHook, hookDeadlineMs = WEB_HOOK_DEADLINE_MS): Promise<McpHttpHandle> {
  const token = randomBytes(24).toString('base64url');
  const srv = http.createServer(async (req, res) => {
    try {
      // Only loopback clients, only our path, only with the token. Reject
      // browser-originated requests (DNS-rebinding / CSRF) outright.
      if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') {
        res.writeHead(403).end();
        return;
      }
      if (req.headers.origin) {
        res.writeHead(403).end();
        return;
      }
      if (req.url === '/hook/web' && req.method === 'POST') {
        if (!tokenOk(req.headers.authorization, token)) {
          res.writeHead(401).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        let decision: { allow: boolean; reason?: string } = { allow: false, reason: 'Not allowed by Cadabra' };
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8').slice(0, 1_000_000) || '{}');
          const sessionKey = typeof req.headers[SESSION_HEADER] === 'string' ? (req.headers[SESSION_HEADER] as string) : undefined;
          const bad = checkSession(sessionKey);
          if (bad) decision = { allow: false, reason: bad };
          else if (webHook) {
            let timer: NodeJS.Timeout | undefined;
            const late = new Promise<{ allow: boolean; reason: string }>((resolve) => {
              timer = setTimeout(() => resolve({ allow: false, reason: 'Cadabra didn’t approve this in time, so it was not allowed.' }), hookDeadlineMs);
            });
            try {
              decision = await Promise.race([webHook(String(body?.tool_name ?? ''), body?.tool_input ?? {}), late]);
            } finally {
              clearTimeout(timer);
            }
            if (typeof decision?.allow !== 'boolean') decision = { allow: false, reason: 'Not allowed by Cadabra' };
          }
        } catch {
          /* deny */
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(hookResponse(decision)));
        return;
      }
      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(404).end();
        return;
      }
      if (!tokenOk(req.headers.authorization, token)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
        return;
      }
      if (req.method !== 'POST') {
        // Stateless server: no standalone SSE stream / session deletion.
        res.writeHead(405, { Allow: 'POST' }).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 4 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(c as Buffer);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      const sessionKey = typeof req.headers[SESSION_HEADER] === 'string' ? (req.headers[SESSION_HEADER] as string) : undefined;
      const server = buildServer(defs(), version, () => checkSession(sessionKey));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
      });
      await server.connect(transport);
      await transport.handleRequest(req as any, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null }));
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}
