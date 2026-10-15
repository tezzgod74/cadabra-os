/* global process */
// Fake `claude` (Claude Code app) for tests. Speaks `auth status`, `--version`
// and print mode with --input-format/--output-format stream-json, including the
// `initialize` control request (account source fields). Logs argv, env facts
// and stdin lines to FAKE_LOG. Never touches the network.
//   FAKE_ACCOUNT_SOURCE  apiKeySource reported by initialize (default: from the env)
//   FAKE_TOKEN_SOURCE    tokenSource reported by initialize
//   FAKE_NO_INIT=1       never answer initialize
//   FAKE_AUTH_SOURCE     apiKeySource reported in each turn's system/init
import fs from 'node:fs';
import { createInterface } from 'node:readline';

const log = (o) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n');
const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (argv[0] === '--version') {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? '2.1.300'} (Claude Code)\n`);
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  const st = process.env.FAKE_CLAUDE_AUTH ?? 'in';
  if (st === 'out') {
    process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: 'none' }) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: st === 'apikey' ? 'api_key' : 'claude.ai', email: 'me@example.com', subscriptionType: 'max' }) + '\n');
  process.exit(0);
}
// Print mode.
const mcpIdx = argv.indexOf('--mcp-config');
const authVars = Object.keys(process.env).filter((k) => /OAUTH|AUTH_TOKEN|ANTHROPIC|CLAUDE_CODE_USE|CLAUDE_CONFIG_DIR/i.test(k));
log({ argv, hasApiKeyEnv: !!process.env.ANTHROPIC_API_KEY, apiKey: process.env.ANTHROPIC_API_KEY ?? null, authVars, configDir: process.env.CLAUDE_CONFIG_DIR ?? null, mcpConfig: mcpIdx > 0 ? JSON.parse(fs.readFileSync(argv[mcpIdx + 1], 'utf8')) : null });
const keySource = process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : undefined;
let turn = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  log({ in: msg });
  if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
    if (process.env.FAKE_NO_INIT === '1') return;
    const account = { tokenSource: process.env.FAKE_TOKEN_SOURCE ?? (keySource ? 'none' : 'claude.ai'), apiKeySource: process.env.FAKE_ACCOUNT_SOURCE ?? keySource, apiProvider: 'firstParty' };
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { commands: [], agents: [], models: [{ value: 'default', displayName: 'Default' }], account } } });
    return;
  }
  if (msg.type === 'control_request') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'cc-1', errors: ['interrupted'] });
    return;
  }
  if (msg.type !== 'user') return;
  turn++;
  log({ userMessage: true });
  if (turn === 1) out({ type: 'system', subtype: 'init', session_id: 'cc-1', apiKeySource: process.env.FAKE_AUTH_SOURCE ?? keySource ?? 'none', mcp_servers: [{ name: 'cadabra', status: 'connected' }] });
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: `m${turn}` } }, parent_tool_use_id: null, session_id: 'cc-1' });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ready' } }, parent_tool_use_id: null, session_id: 'cc-1' });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '.' } }, parent_tool_use_id: null, session_id: 'cc-1' });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Ready.', session_id: 'cc-1', total_cost_usd: 0 });
});
