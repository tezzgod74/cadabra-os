/* global process, setTimeout */
// Fake `codex app-server` for tests: speaks just enough JSON-RPC (one JSON
// object per line) to exercise Cadabra's sign-in flow. Logs every message it
// receives, plus its CODEX_HOME, to FAKE_LOG.
import fs from 'node:fs';
import { createInterface } from 'node:readline';

const log = (o) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n');
log({ argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME ?? null, hasToken: !!process.env.CADABRA_MCP_TOKEN });
let account = null;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  log({ in: msg });
  if (msg.id == null) return;
  switch (msg.method) {
    case 'initialize':
      return send({ id: msg.id, result: { userAgent: 'fake-codex/0' } });
    case 'account/read':
      return send({ id: msg.id, result: { account, requiresOpenaiAuth: true } });
    case 'account/login/start':
      if (msg.params?.type === 'apiKey') {
        account = { type: 'apiKey' };
        return send({ id: msg.id, result: { type: 'apiKey' } });
      }
      send({ id: msg.id, result: { type: 'chatgpt', loginId: 'L1', authUrl: 'https://auth.openai.com/oauth/authorize?fake=1' } });
      setTimeout(() => {
        account = { type: 'chatgpt', email: 'me@example.com', planType: 'plus' };
        send({ method: 'account/login/completed', params: { loginId: 'L1', success: true, error: null } });
      }, 100);
      return;
    case 'thread/start':
      return send({ id: msg.id, result: { thread: { id: 'th1', ...(process.env.FAKE_TOOLS ? { tools: process.env.FAKE_TOOLS.split(',') } : {}) } } });
    case 'turn/start':
      // Slow to hand out the turn id, so an early Esc happens before it is known (P2).
      setTimeout(() => {
        send({ id: msg.id, result: { turn: { id: 'tu1' } } });
        send({ method: 'turn/started', params: { threadId: 'th1', turn: { id: 'tu1' } } });
      }, 300);
      return;
    case 'turn/interrupt':
      send({ id: msg.id, result: {} });
      send({ method: 'turn/completed', params: { threadId: 'th1', turn: { id: 'tu1', status: 'interrupted' } } });
      return;
    case 'account/logout':
      account = null;
      return send({ id: msg.id, result: {} });
    default:
      return send({ id: msg.id, result: {} });
  }
});
