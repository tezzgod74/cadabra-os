// REVIEW-3 (round 4) regression tests: auth boundary, session allowlist,
// shell targets, short secrets, key buffering helpers, TTS fallback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { accountAllowed, authSourceAllowed, AUTH_ENV_VARS, ClaudeProvider, claudeApiEnv, NoApiKeyError } from '../src/main/providers/claude';
import { claudeCliArgs, claudeCodeEnv } from '../src/main/providers/claude-cli';
import type { ProviderEvent } from '../src/shared/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadabra-r4-'));
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 500));
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* a child may still hold the folder briefly */
  }
});

const DIRTY = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-should-not-pass',
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'r',
  ANTHROPIC_AUTH_TOKEN: 'bearer-should-not-pass',
  ANTHROPIC_BASE_URL: 'https://proxy.example',
  ANTHROPIC_API_KEY: 'inherited-key-should-not-pass',
  CLAUDE_CONFIG_DIR: 'C:/Users/me/.claude',
  CLAUDE_CODE_USE_BEDROCK: '1',
};

/** A `.cmd` wrapper so the fake Claude Code app runs like the real claude.exe. */
function fakeClaude(): string {
  const cmd = path.join(tmp, 'claude.cmd');
  if (!fs.existsSync(cmd)) fs.writeFileSync(cmd, `@"${process.execPath}" "${path.resolve('test/fixtures/fake-claude.mjs')}" %*\r\n`);
  return cmd;
}
const mcp = async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'T' });
function apiProvider(dir: string, key: string | undefined, extra: Record<string, unknown> = {}) {
  return new ClaudeProvider({ tools: () => [], apiKey: () => key, exePath: () => fakeClaude(), workDir: path.join(tmp, dir), configDir: path.join(tmp, `${dir}-cfg`), version: '1', route: () => 'api-key', mcp, ...extra });
}
async function collect(p: ClaudeProvider): Promise<ProviderEvent[]> {
  const evs: ProviderEvent[] = [];
  for await (const ev of p.send({ prompt: 'hi', contextText: '', model: 'claude-haiku-5-5', signal: new AbortController().signal })) evs.push(ev);
  return evs;
}
const readLog = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe('AUTH-1: API-key mode (via the user’s Claude Code app) can never fall back to a subscription login', () => {
  it('layer 1: no key → refuses (throws), nothing to spawn', () => {
    expect(() => claudeApiEnv(DIRTY, { route: 'api-key', key: '', configDir: 'X', version: '1' })).toThrow(NoApiKeyError);
  });
  it('layer 2 + 3: scrubs every OAuth / alternative-auth variable and uses a private config dir', () => {
    const env = claudeApiEnv(DIRTY, { route: 'api-key', key: 'sk-ant-mine', configDir: path.join(tmp, 'cfg'), version: '1' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-mine'); // ours, not the inherited one
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(tmp, 'cfg'));
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK']) expect(env[k], k).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    const bedrock = claudeApiEnv(DIRTY, { route: 'bedrock', configDir: 'X', version: '1' });
    expect(bedrock.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(bedrock.ANTHROPIC_API_KEY).toBeUndefined();
    expect(AUTH_ENV_VARS).toContain('CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR');
  });
  it('the API-key command line keeps --bare, no built-in tools, only Cadabra MCP, and never carries the key', () => {
    const a = claudeCliArgs({ model: 'm', mcpConfigFile: 'm.json', systemPromptFile: 'p.txt', bare: true });
    expect(a).toContain('--bare');
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    expect(a[a.indexOf('--allowedTools') + 1]).toBe('mcp__cadabra__*');
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('');
    expect(a).toContain('--strict-mcp-config');
    expect(a).toContain('--max-budget-usd');
    expect(a).toContain('--max-turns');
    expect(a.join(' ')).not.toMatch(/sk-ant/);
    expect(claudeCliArgs({ mcpConfigFile: 'm', systemPromptFile: 'p' })).not.toContain('--bare'); // subscription mode
  });
  it('layer 4 backstop: only our API key is an acceptable credential source', () => {
    expect(authSourceAllowed('api-key', { apiKeySource: 'ANTHROPIC_API_KEY' })).toBe(true);
    for (const src of ['none', 'oauth', '/login managed key', 'apiKeyHelper', undefined]) expect(authSourceAllowed('api-key', { apiKeySource: src as any }), String(src)).toBe(false);
  });
  it('end to end: no key → error and no spawn', async () => {
    const logFile = path.join(tmp, 'nokey.log');
    process.env.FAKE_LOG = logFile;
    const evs = await collect(apiProvider('w1', undefined));
    expect(evs).toEqual([{ type: 'error', message: new NoApiKeyError().message }]);
    expect(fs.existsSync(logFile)).toBe(false); // Claude Code was never started
  });
  it('end to end: the key reaches only the child’s environment; --bare, private config dir, no OAuth variables', async () => {
    const logFile = path.join(tmp, 'ok.log');
    process.env.FAKE_LOG = logFile;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'leak-test';
    const p = apiProvider('w0', 'sk-ant-test');
    try {
      const evs = await collect(p);
      expect(evs.filter((e) => e.type === 'text').map((e: any) => e.delta).join('')).toBe('Ready.');
      const log = readLog(logFile)[0];
      expect(log.argv).toContain('--bare');
      expect(log.argv.join(' ')).not.toContain('sk-ant-test');
      expect(log.apiKey).toBe('sk-ant-test');
      expect(log.configDir).toBe(path.join(tmp, 'w0-cfg'));
      expect(log.authVars.filter((k: string) => /OAUTH|AUTH_TOKEN/.test(k))).toEqual([]);
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      p.reset();
    }
  }, 30_000);
  it('end to end (backstop): a turn whose init reports another credential ends the session', async () => {
    const logFile = path.join(tmp, 'oauth.log');
    process.env.FAKE_LOG = logFile;
    process.env.FAKE_AUTH_SOURCE = 'none'; // e.g. a claude.ai login
    const p = apiProvider('w2', 'sk-ant-test'); // initialize says ANTHROPIC_API_KEY (stale / lying): init still catches it
    try {
      const evs = await collect(p);
      expect(evs.some((e) => e.type === 'error' && /wasn’t using your API key/.test(e.message))).toBe(true);
      expect(evs.some((e) => e.type === 'text')).toBe(false);
    } finally {
      delete process.env.FAKE_AUTH_SOURCE;
      p.reset();
    }
  }, 30_000);
  it('preventive: Claude Code’s initialize answer reporting another credential → nothing is sent at all', async () => {
    const logFile = path.join(tmp, 'pre.log');
    process.env.FAKE_LOG = logFile;
    process.env.FAKE_ACCOUNT_SOURCE = 'none';
    process.env.FAKE_TOKEN_SOURCE = 'claude.ai';
    const p = apiProvider('w3', 'sk-ant-test');
    try {
      const evs = await collect(p);
      expect(evs.some((e) => e.type === 'error' && /didn’t send anything/.test(e.message))).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(readLog(logFile).some((l) => l.userMessage)).toBe(false);
    } finally {
      delete process.env.FAKE_ACCOUNT_SOURCE;
      delete process.env.FAKE_TOKEN_SOURCE;
      p.reset();
    }
  }, 30_000);
  it('preventive, fail closed: no initialize answer → nothing is sent at all', async () => {
    const logFile = path.join(tmp, 'noinit.log');
    process.env.FAKE_LOG = logFile;
    process.env.FAKE_NO_INIT = '1';
    try {
      const { ClaudeCliSession } = await import('../src/main/providers/claude-cli');
      const s = new ClaudeCliSession({ exe: fakeClaude(), workDir: path.join(tmp, 'w4'), mcp, systemPrompt: 'S', route: 'api-key', apiKey: 'sk-ant-test', configDir: path.join(tmp, 'w4-cfg'), version: '1', initTimeoutMs: 400 }, 'm');
      await expect(s.start()).rejects.toThrow(/didn’t send anything/);
      expect(s.dead).toBe(true);
      expect(readLog(logFile).some((l) => l.userMessage)).toBe(false);
    } finally {
      delete process.env.FAKE_NO_INIT;
    }
  }, 30_000);
  it('accountAllowed: only the route’s own credential; unknown fails closed', () => {
    expect(accountAllowed('api-key', { apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'none', apiProvider: 'firstParty' })).toBe(true);
    expect(accountAllowed('api-key', { apiKeySource: 'none', tokenSource: 'claude.ai' })).toBe(false);
    expect(accountAllowed('api-key', { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' })).toBe(false);
    expect(accountAllowed('api-key', { apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'gateway' })).toBe(false);
    expect(accountAllowed('api-key', { tokenSource: 'none', apiProvider: 'firstParty' })).toBe(false); // no key source reported
    expect(accountAllowed('api-key', undefined)).toBe(false); // no answer → no
    expect(accountAllowed('bedrock', { apiProvider: 'firstParty' })).toBe(false);
    expect(accountAllowed('bedrock', { apiProvider: 'bedrock', tokenSource: 'none' })).toBe(true);
    expect(accountAllowed('claude-code', undefined)).toBe(true); // the user's own login
  });
  it('subscription mode never receives Cadabra’s API key (status and session use the same env)', () => {
    const env = claudeCodeEnv({ ...DIRTY });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
  it('0.9.2 L2: the API-key route drops every other provider credential and ANTHROPIC_* setting', () => {
    const env = claudeApiEnv({ ...DIRTY, ANTHROPIC_FOUNDRY_API_KEY: 'f', AWS_BEARER_TOKEN_BEDROCK: 'b', ANTHROPIC_VERTEX_PROJECT_ID: 'p', CLOUD_ML_REGION: 'r', ANTHROPIC_MODEL: 'x', ANTHROPIC_SOMETHING_NEW: 'y' }, { route: 'api-key', key: 'sk-ant-mine', configDir: 'X', version: '1' });
    for (const k of ['ANTHROPIC_FOUNDRY_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'ANTHROPIC_MODEL', 'ANTHROPIC_SOMETHING_NEW']) expect(env[k], k).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-mine');
    const bedrock = claudeApiEnv({ ...DIRTY, AWS_BEARER_TOKEN_BEDROCK: 'b', ANTHROPIC_FOUNDRY_API_KEY: 'f' }, { route: 'bedrock', configDir: 'X', version: '1' });
    expect(bedrock.AWS_BEARER_TOKEN_BEDROCK).toBe('b'); // Bedrock's own credential stays
    expect(bedrock.ANTHROPIC_FOUNDRY_API_KEY).toBeUndefined();
    const vertex = claudeApiEnv({ ...DIRTY, AWS_BEARER_TOKEN_BEDROCK: 'b', ANTHROPIC_VERTEX_PROJECT_ID: 'p' }, { route: 'vertex', configDir: 'X', version: '1' });
    expect(vertex.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(vertex.ANTHROPIC_VERTEX_PROJECT_ID).toBe('p');
  });
  it('0.9.2 M1 / 0.9.3 toggle OFF: --bare, no web tools, no hook settings (hooks don’t run under --bare)', async () => {
    const a = claudeCliArgs({ mcpConfigFile: 'm', systemPromptFile: 'p', webSettingsFile: 's.json', bare: true });
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    expect(a).not.toContain('--settings');
    const logFile = path.join(tmp, 'web.log');
    process.env.FAKE_LOG = logFile;
    const p = apiProvider('w6', 'sk-ant-test', { webAccess: () => true, apiWeb: () => false });
    try {
      expect(p.webAvailable()).toBe(false);
      await collect(p);
      const argv: string[] = readLog(logFile)[0].argv;
      expect(argv).toContain('--bare');
      expect(argv[argv.indexOf('--tools') + 1]).toBe('');
      expect(argv).not.toContain('--settings');
    } finally {
      p.reset();
    }
  }, 30_000);
  it('0.9.3 toggle ON: no --bare, only web tools + Cadabra MCP, hook-only --settings, every other lock kept', async () => {
    const logFile = path.join(tmp, 'web-on.log');
    process.env.FAKE_LOG = logFile;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'leak-test';
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'leak-test';
    const p = apiProvider('w7', 'sk-ant-test', { webAccess: () => true, apiWeb: () => true });
    try {
      expect(p.webAvailable()).toBe(true);
      const evs = await collect(p);
      expect(evs.filter((e) => e.type === 'text').map((e: any) => e.delta).join('')).toBe('Ready.');
      const log = readLog(logFile)[0];
      const argv: string[] = log.argv;
      expect(argv).not.toContain('--bare');
      expect(argv[argv.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch');
      expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('mcp__cadabra__*'); // web tools are NOT allow-listed: the hook decides
      expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('');
      expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk');
      expect(argv).toContain('--strict-mcp-config');
      const settings = JSON.parse(fs.readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8'));
      expect(Object.keys(settings)).toEqual(['hooks']);
      expect(Object.keys(settings.hooks)).toEqual(['PreToolUse']);
      expect(settings.hooks.PreToolUse[0].matcher).toBe('WebSearch|WebFetch');
      expect(settings.hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: 'http', url: 'http://127.0.0.1:1/hook/web' });
      expect(argv.join(' ')).not.toContain('sk-ant-test');
      expect(log.apiKey).toBe('sk-ant-test');
      expect(log.configDir).toBe(path.join(tmp, 'w7-cfg'));
      expect(log.authVars.filter((k: string) => /OAUTH|AUTH_TOKEN|BEDROCK/.test(k))).toEqual([]);
      expect(path.basename(log.cwd)).toBe('claude-cwd');
      expect(fs.readdirSync(log.cwd)).toEqual([]); // an empty private working folder
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      p.reset();
    }
  }, 30_000);
  it('0.9.3 toggle ON: the preventive auth check still refuses another credential (nothing sent)', async () => {
    const logFile = path.join(tmp, 'web-on-pre.log');
    process.env.FAKE_LOG = logFile;
    process.env.FAKE_ACCOUNT_SOURCE = 'none';
    process.env.FAKE_TOKEN_SOURCE = 'claude.ai';
    const p = apiProvider('w8', 'sk-ant-test', { webAccess: () => true, apiWeb: () => true });
    try {
      const evs = await collect(p);
      expect(evs.some((e) => e.type === 'error' && /didn’t send anything/.test(e.message))).toBe(true);
      const lines = readLog(logFile);
      expect(lines[0].argv).not.toContain('--bare');
      expect(lines.some((l) => l.userMessage)).toBe(false);
    } finally {
      delete process.env.FAKE_ACCOUNT_SOURCE;
      delete process.env.FAKE_TOKEN_SOURCE;
      p.reset();
    }
  }, 30_000);
  it('0.9.3: web access off overrides the toggle; flipping the toggle replaces a warm process', async () => {
    const logFile = path.join(tmp, 'web-flip.log');
    process.env.FAKE_LOG = logFile;
    let apiWeb = false;
    const p = apiProvider('w9', 'sk-ant-test', { webAccess: () => true, apiWeb: () => apiWeb });
    const off = apiProvider('w10', 'sk-ant-test', { webAccess: () => false, apiWeb: () => true });
    try {
      await p.prewarm('m');
      apiWeb = true;
      await collect(p);
      const runs = readLog(logFile).filter((l) => l.argv).map((l) => l.argv.includes('--bare'));
      expect(runs).toEqual([true, false]);
      const offLog = path.join(tmp, 'web-off.log');
      process.env.FAKE_LOG = offLog;
      await collect(off);
      const argv: string[] = readLog(offLog)[0].argv;
      expect(argv).toContain('--bare');
      expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    } finally {
      p.reset();
      off.reset();
    }
  }, 30_000);
  it('0.9.3 settings: claudeApiWeb defaults on, merges booleans only, and is a renderer preference', async () => {
    const { DEFAULT_SETTINGS, mergeSettings, sanitizeRendererPatch } = await import('../src/shared/settings');
    expect(DEFAULT_SETTINGS.claudeApiWeb).toBe(true);
    expect(mergeSettings({ claudeApiWeb: false }).claudeApiWeb).toBe(false);
    expect(mergeSettings({ claudeApiWeb: 'no' }).claudeApiWeb).toBe(true);
    expect(sanitizeRendererPatch({ claudeApiWeb: false })).toEqual({ claudeApiWeb: false });
  });
  it('changing the saved key replaces a warm process (never reused with the old key)', async () => {
    const logFile = path.join(tmp, 'swap.log');
    process.env.FAKE_LOG = logFile;
    let key = 'sk-ant-one';
    const p = apiProvider('w5', undefined, { apiKey: () => key });
    try {
      await p.prewarm('m');
      key = 'sk-ant-two';
      await collect(p);
      const keys = readLog(logFile).filter((l) => l.argv).map((l) => l.apiKey);
      expect(keys).toEqual(['sk-ant-one', 'sk-ant-two']);
    } finally {
      p.reset();
    }
  }, 30_000);
});

import { classifyAction, DEFAULT_SAFETY, isShellTarget } from '../src/shared/safety';

describe('S3-R: IDE terminals and WSL shells', () => {
  const d = (r: any) => classifyAction({ title: 'proj', hwnd: 1, prompt: 'fix my build', ...r }, DEFAULT_SAFETY);
  it('focus that is not inside the target (e.g. Cadabra’s own panel) fails closed for IDEs', () => {
    for (const p of ['Code.exe', 'Cursor.exe', 'Windsurf.exe', 'idea64.exe', 'devenv.exe']) {
      expect(d({ kind: 'type_text', text: 'rm -rf ~', process: p, focus: { role: 'edit', name: 'Ask about this window…', verified: false } }).decision, p).toBe('confirm');
      expect(d({ kind: 'type_text', text: 'rm -rf ~', process: p }).decision, `${p} no focus`).toBe('confirm');
      expect(d({ kind: 'press_keys', keys: 'enter', process: p }).decision, `${p} enter`).toBe('confirm');
      expect(d({ kind: 'press_keys', keys: 'ctrl+v', process: p, focus: { verified: false } }).decision).toBe('confirm');
    }
    // Verified editor focus, no terminal: ordinary typing is fine.
    expect(d({ kind: 'type_text', text: 'const x = 1;', process: 'Code.exe', focus: { role: 'edit', name: 'Editor', verified: true } }).decision).toBe('allow');
  });
  it('WSL distro launchers and other shells are shells', () => {
    for (const p of ['wsl.exe', 'ubuntu.exe', 'ubuntu2204.exe', 'debian.exe', 'kali.exe', 'opensuse-leap-15.5.exe', 'fedoraremix.exe', 'bash.exe', 'mintty.exe', 'cmder.exe', 'ConEmu64.exe', 'Tabby.exe', 'alacritty.exe', 'wezterm-gui.exe', 'Hyper.exe', 'warp.exe']) {
      expect(isShellTarget(p), p).toBe(true);
      expect(d({ kind: 'type_text', text: 'ls', process: p }).decision, p).toBe('confirm');
    }
    expect(isShellTarget('notepad.exe')).toBe(false);
  });
});

import { isSecretLike } from '../src/shared/safety';

describe('S7-R: short secrets copied from the screen', () => {
  const d = (text: string, prompt = 'fill in the form') => classifyAction({ kind: 'type_text', text, process: 'chrome.exe', title: 'Sign in', hwnd: 1, prompt }, DEFAULT_SAFETY);
  it('a 6-digit code, card number, IBAN or key the user didn’t say needs a card', () => {
    expect(isSecretLike('482913')).toBe(true);
    expect(isSecretLike('4111 1111 1111 1111')).toBe(true);
    expect(isSecretLike('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(isSecretLike('sk-ant-abcdef0123456789')).toBe(true);
    expect(isSecretLike('Thanks, see you soon')).toBe(false);
    expect(d('482913').decision).toBe('confirm');
    expect(d('4111 1111 1111 1111').reasons.join(' ')).toMatch(/one-time code, PIN or card number/);
    // The user dictated it: fine.
    expect(d('482913', 'type the code 482913').decision).toBe('allow');
  });
});

import { diagnosticsText, redact } from '../src/main/diagnostics';
import { describeAction } from '../src/shared/safety';

describe('Export diagnostics: redaction', () => {
  it('removes e-mails, keys, tokens, long secrets, the user and display names', () => {
    const t = redact(`me ${'someone'}@example.com key sk-ant-abc123def456ghi Bearer abcdefghijklmnopqrstuv AIzaSyA1234567890abcdefghijk ${os.userInfo().username} 0123456789abcdef0123456789abcdef`);
    expect(t).not.toMatch(/@example\.com|sk-ant-|AIza|abcdefghijklmnopqrstuv|0123456789abcdef0123/);
    if (os.userInfo().username.length >= 3) expect(t).not.toContain(os.userInfo().username);
    expect(redact(os.homedir())).not.toContain(path.basename(os.homedir()));
    const bundle = diagnosticsText({ version: '0.9.7', settings: { displayName: 'Alex', provider: 'claude' }, providers: [{ id: 'codex', auth: { ok: true, detail: 'Signed in to ChatGPT (Plus)' } }], helper: 'ok', voice: 'idle', displayName: 'Alex' });
    expect(bundle).not.toContain('Alex');
    expect(bundle).toContain('Signed in to ChatGPT (Plus)');
  });
});

describe('Export diagnostics: REVIEW-4 redaction gaps', async () => {
  const { rememberWindowTitle } = await import('../src/main/diagnostics');
  const mixCase = (x: string) => [...x].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('');
  it('user and profile names in any case', () => {
    for (const n of [os.userInfo().username, path.basename(os.homedir())].filter((x) => x.length >= 3)) {
      const t = redact(`C:\\Users\\${mixCase(n)}\\AppData and ${n.toUpperCase()}`);
      expect(t.toLowerCase()).not.toContain(n.toLowerCase());
    }
  });
  it('machine name and Windows domain', () => {
    const t = redact(`host ${os.hostname()} / ${os.hostname().toLowerCase()} domain ${process.env.USERDOMAIN ?? ''}`);
    expect(t.toLowerCase()).not.toContain(os.hostname().toLowerCase());
    if ((process.env.USERDOMAIN ?? '').length >= 3) expect(t.toLowerCase()).not.toContain(process.env.USERDOMAIN!.toLowerCase());
    expect(t).toContain('[machine]');
  });
  it('URL-encoded e-mails', () => {
    expect(redact('mailto:jane%40contoso.com?x=1')).not.toMatch(/jane|contoso/);
    expect(redact('jane%2540contoso.com and JANE%40CONTOSO.COM')).not.toMatch(/jane|contoso/i);
  });
  it('token/secret/key/password fields of any shape', () => {
    const t = redact(`refresh_token: abcdefghijklmnopqrst {"apiKey":"abcdefghijklmnopqrstuvwxyzabcdef"} password=hunter2hunter client_secret='QwErTyUiOp' x-api-key: zyxwvutsrq`);
    expect(t).not.toMatch(/abcdefghijklmnopqrst|abcdefghijklmnopqrstuvwxyzabcdef|hunter2|QwErTyUiOp|zyxwvutsrq/);
    // Ordinary fields stay readable.
    expect(redact('keys: ctrl+enter hotkey=ctrl+`')).toBe('keys: ctrl+enter hotkey=ctrl+`');
  });
  it('AWS access keys and secrets', () => {
    const t = redact('AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(t).not.toMatch(/AKIAIOSFODNN7EXAMPLE|wJalrXUtnFEMI/);
  });
  it('window titles become the app name only', () => {
    rememberWindowTitle('Chat with Priya Sharma - WhatsApp', 'WhatsApp.exe');
    const t = redact('target "Chat with Priya Sharma - WhatsApp" focused');
    expect(t).not.toContain('Priya');
    expect(t).toContain('[WhatsApp window]');
  });
});

describe('UX-R / N10: the send card states the consequence and shows the message', () => {
  it('ctrl+enter in Outlook', () => {
    const req = { kind: 'press_keys' as const, keys: 'ctrl+enter', process: 'olk.exe', title: 'Inbox — Mail', hwnd: 1, composeText: 'Hi Dana' };
    const card = describeAction(req, classifyAction(req, DEFAULT_SAFETY).reasons);
    expect(card.title).toBe('Send this message in Outlook?');
    expect(card.detail).toBe('Message: “Hi Dana”');
  });
});

// ---------------------------------------------------------------------------
// Round 4 follow-up: software KVMs (Input Director, Mouse Without Borders…)
// can capture or redirect injected input. Detect them and say so plainly.
describe('software KVM detection', async () => {
  const { detectKvm, parseTasklist, kvmMessage, likelyRemote } = await import('../src/main/kvm');
  const { diagnosticsText } = await import('../src/main/diagnostics');
  const { ToolHost } = await import('../src/main/tools');
  const { SafetyGate } = await import('../src/main/safety-gate');
  const { DEFAULT_SAFETY } = await import('../src/shared/safety');

  it('recognises the common tools by process name', () => {
    const out = '"System Idle Process","0","Services","0","8 K"\r\n"InputDirector.exe","1234","Console","1","20,000 K"\r\n"PowerToys.MouseWithoutBorders.exe","99","Console","1","1 K"\r\n"deskflow-server.exe","5","Console","1","1 K"\r\n"notepad.exe","7","Console","1","1 K"\r\n';
    expect(detectKvm(parseTasklist(out))).toEqual(['Input Director', 'Mouse Without Borders', 'Deskflow']);
    expect(detectKvm(['ShareMouse.exe', 'barrierc.exe', 'input-leaps.exe', 'synergy-core.exe'])).toEqual(['Synergy', 'Barrier', 'Input Leap', 'ShareMouse']);
    expect(detectKvm(['explorer.exe', 'code.exe'])).toEqual([]);
  });

  it('message names the tool; a hidden cursor makes it firmer', () => {
    expect(kvmMessage(['Input Director'])).toBe('Your keyboard/mouse may be controlling another PC via Input Director. Switch back and try again.');
    expect(kvmMessage(['Input Director'], likelyRemote(['Input Director'], { cursorShowing: false }))).toMatch(/seem to be controlling another PC via Input Director/);
    expect(likelyRemote([], { cursorShowing: false })).toBeUndefined();
  });

  const fx = { ghostMoveTo: async () => {}, ghostClick: () => {}, ghostHide: () => {}, highlight: () => {}, clearPoint: async () => () => {}, status: () => {} };
  const target = { hwnd: 1, title: 'Untitled - Notepad', process: 'notepad.exe', pid: 42, elevated: false, rect: { x: 0, y: 0, width: 400, height: 300 } };
  function makeHost(over: Record<string, unknown>, kvm: string[]) {
    let typed = '';
    const helper: any = {
      foreground: async () => ({ ok: true, foreground: 1 }),
      focusedElement: async () => ({ role: 'edit', name: 'Text editor', aid: '', className: 'Edit', framework: 'Win32', pid: 42 }),
      elementInfo: async (id: number) => ({ id, depth: 0, role: 'edit', name: 'Text editor', rect: [10, 10, 100, 20], value: typed }),
      focusElement: async () => {},
      typeText: async (t: string) => {
        typed += t;
      },
      pressKeys: async () => {},
      inputState: async () => ({ cursorShowing: false, idleMs: 10 }),
      ...over,
    };
    const host = new ToolHost(helper, new SafetyGate(() => DEFAULT_SAFETY, { confirm: async () => false }), fx as any);
    host.kvmProbe = async () => kvm;
    host.run = { target, signal: new AbortController().signal, frame: null, nodes: new Map([[3, { id: 3, depth: 0, role: 'edit', name: 'Text editor', rect: [10, 10, 100, 20] as [number, number, number, number] }]]), prompt: 'type hello world' };
    return host;
  }

  it('R4-1: typing that never arrives gives a non-blocking note (no blind retype), after a re-read', async () => {
    let reads = 0;
    let typedYet = false;
    const host = makeHost({ typeText: async () => void (typedYet = true), elementInfo: async (id: number) => (typedYet && reads++, { id, depth: 0, role: 'edit', name: 'Text editor', rect: [10, 10, 100, 20], value: '' }) }, ['Input Director']);
    host.verifyDelayMs = 5;
    const res = await host.typeText({ text: 'hello world', element: 3 });
    expect(res.isError).toBeFalsy();
    const t = (res.content[0] as any).text as string;
    expect(t).toMatch(/^Typed 11 characters\. Note: Cadabra couldn't confirm/);
    expect(t).toMatch(/do NOT retype it blindly/);
    expect(t).toMatch(/controlling another PC via Input Director/);
    expect(reads).toBe(2);
  });

  it('R4-1: a field that catches up within the delay gets no note', async () => {
    let reads = 0;
    let typedYet = false;
    const host = makeHost({ typeText: async () => void (typedYet = true), elementInfo: async (id: number) => ({ id, depth: 0, role: 'edit', name: 'Text editor', rect: [10, 10, 100, 20], value: typedYet && reads++ ? 'hello world' : '' }) }, ['Input Director']);
    host.verifyDelayMs = 5;
    const res = await host.typeText({ text: 'hello world', element: 3 });
    expect((res.content[0] as any).text).toBe('Typed 11 characters.');
  });

  it('R4-1: masked/formatted fields are never compared', async () => {
    const { maskedField } = await import('../src/main/tools');
    expect(maskedField({ role: 'edit', name: 'Password' })).toBe(true);
    expect(maskedField({ role: 'edit', name: 'Card number' })).toBe(true);
    expect(maskedField({ role: 'edit', name: 'Phone' })).toBe(true);
    expect(maskedField({ role: 'edit', name: 'Code', value: '••••' })).toBe(true);
    expect(maskedField({ role: 'edit', name: 'Text editor', value: 'hi' })).toBe(false);
  });

  it('typing that arrives is fine even with a KVM running', async () => {
    const res = await makeHost({}, ['Input Director']).typeText({ text: 'hello world', element: 3 });
    expect(res.isError).toBeFalsy();
  });

  it('SendInput refusals and foreground failures name the KVM', async () => {
    const r1 = await makeHost({ pressKeys: async () => { throw new Error('SendInput inserted 0/2 events (blocked by UIPI or another input desktop?)'); } }, ['Mouse Without Borders']).pressKeys({ keys: 'end' });
    expect((r1.content[0] as any).text).toMatch(/Mouse Without Borders\. Switch back to this PC and try again/);
    const r2 = await makeHost({ foreground: async () => ({ ok: false, foreground: 99 }) }, ['Input Director']).typeText({ text: 'hello world' });
    expect((r2.content[0] as any).text).toMatch(/via Input Director.*couldn't bring/);
    // Without a KVM, the generic message stays.
    const r3 = await makeHost({ foreground: async () => ({ ok: false, foreground: 99 }) }, []).typeText({ text: 'hello world' });
    expect((r3.content[0] as any).text).toMatch(/Windows didn't let Cadabra bring/);
  });

  it('diagnostics bundle lists KVM tools', () => {
    expect(diagnosticsText({ version: '0', settings: {}, providers: [], helper: 'ok', voice: 'off', kvm: ['Input Director'] })).toMatch(/Keyboard\/mouse sharing: Input Director running/);
    expect(diagnosticsText({ version: '0', settings: {}, providers: [], helper: 'ok', voice: 'off', kvm: [] })).toMatch(/Keyboard\/mouse sharing: none detected/);
  });
});

describe('REVIEW-4: TTS speed verdict', async () => {
  const { speedVerdict, SpeedStore, SLOW_COOLDOWN_MS } = await import('../src/main/voice/tts-speed');
  const s = (synthSec: number, audioSec: number) => ({ synthSec, audioSec });
  it('one slow sentence (a busy moment) does not flip the voice', () => {
    expect(speedVerdict([s(0.4, 2), s(0.4, 2), s(6, 2)]).tooSlow).toBe(false);
    expect(speedVerdict([s(6, 2)]).tooSlow).toBeNull(); // not enough audio to decide
  });
  it('consistently slow sentences do', () => {
    expect(speedVerdict([s(3, 2), s(3, 2), s(3, 2)]).tooSlow).toBe(true);
  });
  it('the verdict is persisted per machine and expires after the cool-down', () => {
    let now = 1_000_000;
    const file = path.join(tmp, 'speed', 'tts-speed.json');
    const st = new SpeedStore(file, () => now);
    st.save(1.9, true);
    expect(st.load()).toEqual({ rtf: 1.9, tooSlow: true });
    now += SLOW_COOLDOWN_MS + 1;
    expect(st.load().tooSlow).toBe(false); // re-test later
    const other = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...other, machine: 'another PC', at: now }));
    expect(st.load().tooSlow).toBe(false);
  });
});
