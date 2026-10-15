/* global process */
// Fake `gemini --acp` agent for tests (Agent Client Protocol, JSON-RPC 2.0 per
// line). It asks the client for permission for one Cadabra tool and one
// built-in shell call, and tries a client fs read, then logs the answers.
import fs from 'node:fs';
import { createInterface } from 'node:readline';

const log = (o) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n');
log({ argv: process.argv.slice(2), cwd: process.cwd(), apiKey: process.env.GEMINI_API_KEY ?? null });
let authed = !!process.env.GEMINI_API_KEY;
let nextId = 900;
const waiting = new Map();
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });

createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  log({ in: msg });
  if (msg.id != null && !msg.method) {
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
    return;
  }
  if (msg.id == null) return; // notifications (session/cancel)
  switch (msg.method) {
    case 'initialize':
      return send({
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          authMethods: [
            { id: 'oauth-personal', name: 'Log in with Google' },
            { id: 'gemini-api-key', name: 'Use Gemini API key' },
          ],
        },
      });
    case 'authenticate':
      authed = true;
      return send({ id: msg.id, result: {} });
    case 'session/new':
      if (!authed) return send({ id: msg.id, error: { code: -32000, message: 'Authentication required' } });
      return send({ id: msg.id, result: { sessionId: 'S1', models: { currentModelId: 'gemini-3-pro', availableModels: [{ modelId: 'gemini-3-pro', name: 'Gemini 3 Pro' }, { modelId: 'gemini-3-flash', name: 'Gemini 3 Flash' }] } } });
    case 'session/set_model':
      return send({ id: msg.id, result: {} });
    case 'session/prompt': {
      const sid = msg.params.sessionId;
      const opts = [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ];
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
      update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'mcp__cadabra__see_screen', kind: 'other', status: 'pending' });
      const a = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 't1', title: 'see_screen (cadabra MCP Server)', kind: 'other' }, options: opts });
      const b = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 't2', title: 'run_shell_command', kind: 'execute' }, options: opts });
      const c = await ask('fs/read_text_file', { sessionId: sid, path: 'C:/Users/me/secret.txt' });
      log({ answers: { cadabra: a.result ?? a.error, shell: b.result ?? b.error, fs: c.result ?? c.error } });
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Saw Notepad' } }] });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } });
      return send({ id: msg.id, result: { stopReason: 'end_turn' } });
    }
    default:
      return send({ id: msg.id, result: {} });
  }
});
