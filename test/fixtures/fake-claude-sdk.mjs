/* global process */
// Fake Claude runtime driven by the real Agent SDK (stream-json over stdio).
// Records argv and the auth-relevant environment to FAKE_LOG, answers the
// SDK's control requests, and on a user message reports `apiKeySource`
// (FAKE_AUTH_SOURCE, default "ANTHROPIC_API_KEY") in system/init.
import fs from 'node:fs';
import { createInterface } from 'node:readline';

const log = (o) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const authVars = Object.keys(process.env).filter((k) => /OAUTH|AUTH_TOKEN|ANTHROPIC|CLAUDE_CODE_USE|CLAUDE_CONFIG_DIR/i.test(k));
log({
  argv: process.argv.slice(2),
  authVars,
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  hasKey: !!process.env.ANTHROPIC_API_KEY,
});
createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [], models: [], agents: [], account: { apiKeySource: process.env.FAKE_ACCOUNT_SOURCE ?? process.env.FAKE_AUTH_SOURCE ?? 'ANTHROPIC_API_KEY', tokenSource: process.env.FAKE_TOKEN_SOURCE } } } });
    return;
  }
  if (m.type !== 'user') return;
  log({ userMessage: true });
  out({ type: 'system', subtype: 'init', session_id: 's1', apiKeySource: process.env.FAKE_AUTH_SOURCE ?? 'ANTHROPIC_API_KEY', tools: [], mcp_servers: [], model: 'x', permissionMode: 'dontAsk', cwd: '.', slash_commands: [], claude_code_version: '9.9.9', output_style: 'default', skills: [], plugins: [], uuid: 'u1' });
  out({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Ready.' }] }, parent_tool_use_id: null, session_id: 's1', uuid: 'u2' });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Ready.', session_id: 's1', total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, num_turns: 1, usage: {}, uuid: 'u3' });
});
