// Priority 2 (subscription sign-in, docs/research.md §8): the vendor's own
// flow runs the login; Cadabra only opens the vendor's URL. Exercised against
// fake Codex app-server / Gemini ACP processes speaking the real protocols.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CodexProvider } from '../src/main/providers/codex';
import { acpPermissionDecision, GEMINI_EXCLUDED_TOOLS, GeminiProvider, mapAcpUpdate, newAcpMapState } from '../src/main/providers/gemini';
import { ClaudeProvider } from '../src/main/providers/claude';
import { CLAUDE_SESSION_BUDGET_USD, mapClaudeMessage, newClaudeMapState } from '../src/main/providers/claude-events';
import { looksLikeHandle, tidyName } from '../src/shared/names';
import type { ProviderEvent } from '../src/shared/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadabra-acct-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeCmd(name: string, script: string): string {
  const cmd = path.join(tmp, `${name}.cmd`);
  fs.writeFileSync(cmd, `@"${process.execPath}" "${path.resolve('test/fixtures', script)}" %*\r\n`);
  return cmd;
}
const readLog = (f: string) =>
  fs.existsSync(f)
    ? fs
        .readFileSync(f, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
const mcp = async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'tok' });

describe('Codex: Sign in with ChatGPT (via Codex)', () => {
  it('runs account/login/start, opens only the vendor URL, and keeps state in a private CODEX_HOME', async () => {
    const logFile = path.join(tmp, 'codex.log');
    process.env.FAKE_LOG = logFile;
    const home = path.join(tmp, 'codex-home');
    const p = new CodexProvider({ exePath: () => fakeCmd('codex', 'fake-codex.mjs'), mcp, workDir: path.join(tmp, 'work'), homeDir: home, version: '9.9.9' });
    try {
      expect((await p.checkAuth()).ok).toBe(false);
      const opened: string[] = [];
      const status: string[] = [];
      const labels = p.signInOptions().map((o) => o.label);
      expect(labels).toContain('Sign in with ChatGPT (via Codex)');
      expect(labels).toContain('Use an OpenAI API key');
      const auth = await p.signIn('chatgpt', { openUrl: (u) => opened.push(u), status: (t) => status.push(t) });
      expect(auth.ok).toBe(true);
      expect(auth.detail).toBe('Signed in to ChatGPT (Plus)');
      expect(auth.detail).not.toMatch(/@/); // AUTH-3: never the account email
      expect(opened).toEqual(['https://auth.openai.com/oauth/authorize?fake=1']);
      expect(status.join(' ')).toMatch(/browser/);
      const log = readLog(logFile);
      // Private CODEX_HOME (never the user's ~/.codex) with our config; identifies as cadabra-os.
      expect(log[0].codexHome).toBe(home);
      expect(log[0].argv).toEqual(['app-server']);
      expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toMatch(/shell_tool = false/);
      const init = log.find((l) => l.in?.method === 'initialize');
      expect(init.in.params.clientInfo.name).toBe('cadabra-os');
      expect(log.find((l) => l.in?.method === 'account/login/start').in.params).toEqual({ type: 'chatgpt' });
      // Nothing under the user's real Codex home was touched or read.
      expect(log.some((l) => JSON.stringify(l).includes(path.join(os.homedir(), '.codex')))).toBe(false);
      await p.signOut();
      expect((await p.checkAuth()).ok).toBe(false);
    } finally {
      await p.dispose();
    }
  }, 20_000);
});

describe('Codex turns (P1/P2/S14)', () => {
  it('an Esc before the turn id is known still interrupts the turn; the MCP token never enters thread config', async () => {
    const logFile = path.join(tmp, 'codex-turn.log');
    process.env.FAKE_LOG = logFile;
    const secretMcp = async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'SECRET-BEARER-42' });
    const p = new CodexProvider({ exePath: () => fakeCmd('codex2', 'fake-codex.mjs'), mcp: secretMcp, workDir: path.join(tmp, 'work2'), homeDir: path.join(tmp, 'codex-home2'), version: '9.9.9' });
    try {
      const ac = new AbortController();
      const evs: ProviderEvent[] = [];
      const t0 = Date.now();
      for await (const ev of p.send({ prompt: 'hi', contextText: '', model: '', signal: ac.signal })) {
        evs.push(ev);
        if (ev.type === 'session') ac.abort(); // before turn/start has returned a turn id
      }
      expect(Date.now() - t0).toBeLessThan(1400); // ended by the real interrupt, not the 1.5 s fallback
      const log = readLog(logFile);
      expect(log.find((l) => l.in?.method === 'turn/interrupt')?.in.params).toEqual({ threadId: 'th1', turnId: 'tu1' });
      const start = log.find((l) => l.in?.method === 'thread/start').in.params;
      expect(start.ephemeral).toBe(true);
      expect(start.sandbox).toBe('read-only');
      expect(start.config.mcp_servers.cadabra.bearer_token_env_var).toBe('CADABRA_MCP_TOKEN');
      expect(JSON.stringify(log)).not.toContain('SECRET-BEARER-42');
      expect(log[0].hasToken).toBe(true);
    } finally {
      await p.dispose();
    }
  }, 20_000);

  it('P1: a thread that reports tools beyond Cadabra’s is refused', async () => {
    process.env.FAKE_LOG = path.join(tmp, 'codex-tools.log');
    process.env.FAKE_TOOLS = 'mcp__cadabra__click,shell';
    const p = new CodexProvider({ exePath: () => fakeCmd('codex3', 'fake-codex.mjs'), mcp, workDir: path.join(tmp, 'work3'), homeDir: path.join(tmp, 'codex-home3'), version: '9.9.9' });
    try {
      const evs: ProviderEvent[] = [];
      for await (const ev of p.send({ prompt: 'hi', contextText: '', model: '', signal: new AbortController().signal })) evs.push(ev);
      expect(evs[0]).toMatchObject({ type: 'error' });
      expect((evs[0] as any).message).toMatch(/shell/);
    } finally {
      delete process.env.FAKE_TOOLS;
      await p.dispose();
    }
  }, 20_000);
});

describe('Gemini via ACP (gemini --acp)', () => {
  it('maps agent_message_chunk and tool calls', () => {
    const st = newAcpMapState();
    const evs: ProviderEvent[] = [
      ...mapAcpUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } } }, st),
      ...mapAcpUpdate({ update: { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'click (cadabra MCP Server)' } }, st),
      ...mapAcpUpdate({ update: { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' } }, st),
      ...mapAcpUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } } }, st),
    ];
    expect(evs).toEqual([
      { type: 'text', delta: 'Hi' },
      { type: 'tool', id: 'a', name: 'click', phase: 'start' },
      { type: 'tool', id: 'a', name: 'click', phase: 'end', ok: true, summary: undefined },
      { type: 'text', delta: '\n\n' },
      { type: 'text', delta: 'Done' },
    ]);
  });

  it('approves only Cadabra tools; rejects built-in shell/file/web and look-alikes', () => {
    const options = [
      { optionId: 'y', kind: 'allow_once' },
      { optionId: 'a', kind: 'allow_always' },
      { optionId: 'n', kind: 'reject_once' },
    ];
    const pick = (toolCall: any) => (acpPermissionDecision({ toolCall, options }).outcome as any).optionId;
    expect(pick({ title: 'see_screen (cadabra MCP Server)', kind: 'other' })).toBe('y'); // once, never "always"
    expect(pick({ title: 'mcp__cadabra__click', kind: 'other' })).toBe('y');
    expect(pick({ title: 'run_shell_command', kind: 'execute' })).toBe('n');
    expect(pick({ title: 'WriteFile', kind: 'edit' })).toBe('n');
    expect(pick({ title: 'echo cadabra (shell)', kind: 'other' })).toBe('n');
    expect(pick({ title: 'click (cadabra-evil MCP Server)', kind: 'other' })).toBe('n');
    expect(pick({ title: 'mcp__cadabra__click', kind: 'execute' })).toBe('n');
    expect(acpPermissionDecision({ toolCall: { title: 'x' }, options: [] }).outcome).toEqual({ outcome: 'cancelled' });
    expect(GEMINI_EXCLUDED_TOOLS).toEqual(expect.arrayContaining(['run_shell_command', 'write_file', 'read_file', 'web_fetch']));
  });

  it('signs in through the CLI, gives each session Cadabra’s MCP server, streams, and refuses fs/shell', async () => {
    const logFile = path.join(tmp, 'gemini.log');
    process.env.FAKE_LOG = logFile;
    const work = path.join(tmp, 'gwork');
    const p = new GeminiProvider({ exePath: () => fakeCmd('gemini', 'fake-gemini.mjs'), mcp, workDir: work, apiKey: () => undefined, version: '9.9.9' });
    try {
      const before = await p.checkAuth();
      expect(before.ok).toBe(false);
      expect(p.signInOptions().map((o) => o.label)).toEqual(['Sign in with Google (via Gemini CLI)', 'Use a Gemini API key']); // only what the CLI advertises
      const auth = await p.signIn('oauth-personal', { openUrl: () => undefined });
      expect(auth.ok).toBe(true);
      expect((await p.listModels()).map((m) => m.id)).toEqual(['gemini-3-pro', 'gemini-3-flash']);
      const ac = new AbortController();
      let text = '';
      const tools: string[] = [];
      for await (const ev of p.send({ prompt: 'what is on screen', contextText: '', model: '', signal: ac.signal })) {
        if (ev.type === 'text') text += ev.delta;
        if (ev.type === 'tool' && ev.phase === 'start') tools.push(ev.name);
        if (ev.type === 'error') throw new Error(ev.message);
      }
      expect(text).toBe('Hello \n\nworld');
      expect(tools).toEqual(['see_screen']);
      const log = readLog(logFile);
      expect(log[0].argv).toEqual(['--acp', '--approval-mode', 'default']);
      expect(log[0].cwd).toBe(path.join(work, 'gemini-workspace'));
      const settings = JSON.parse(fs.readFileSync(path.join(work, 'gemini-workspace', '.gemini', 'settings.json'), 'utf8'));
      expect(settings.tools.exclude).toContain('run_shell_command');
      const init = log.find((l) => l.in?.method === 'initialize').in.params;
      expect(init.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
      expect(init.clientInfo.name).toBe('cadabra-os');
      expect(log.find((l) => l.in?.method === 'authenticate').in.params).toEqual({ methodId: 'oauth-personal' });
      const sess = log.filter((l) => l.in?.method === 'session/new').pop().in.params;
      expect(sess.mcpServers).toHaveLength(1);
      expect(sess.mcpServers[0]).toMatchObject({ type: 'http', name: 'cadabra', url: 'http://127.0.0.1:1/mcp' });
      expect(sess.mcpServers[0].headers[0]).toEqual({ name: 'Authorization', value: 'Bearer tok' });
      expect(sess.mcpServers[0].headers[1].name).toBe('x-cadabra-session'); // N4: revocable per-session key
      const answers = log.find((l) => l.answers).answers;
      expect(answers.cadabra).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
      expect(answers.shell).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
      expect(answers.fs.code).toBe(-32601);
    } finally {
      await p.dispose();
    }
  }, 30_000);
});

describe('Claude: API key only, honest note, per-chat budget', () => {
  it('offers the Claude Code subscription and an API key as equal choices, with honest trade-offs (round 3)', () => {
    const p = new ClaudeProvider({ tools: () => [], apiKey: () => undefined, exePath: () => undefined, workDir: tmp, version: '0' });
    const opts = p.signInOptions();
    expect(opts.map((o) => o.id)).toEqual(['claude-code', 'api-key', 'bedrock', 'vertex']);
    expect(opts[0].label).toBe('Use my Claude subscription (via Claude Code)');
    expect(opts[0].note).toMatch(/Pro\/Max limits/);
    expect(opts[0].note).toMatch(/terms may restrict use of subscriptions by third-party apps — use at your own risk/);
    expect(opts[1].note).toMatch(/Billed per use by Anthropic, separately from any Claude subscription/);
  });

  it('maps max-budget and max-turns results to clear messages', () => {
    const b = mapClaudeMessage({ type: 'result', subtype: 'error_max_budget_usd', is_error: true }, newClaudeMapState());
    expect(b[0]).toMatchObject({ type: 'error' });
    expect((b[0] as any).message).toContain(`$${CLAUDE_SESSION_BUDGET_USD}`);
    const t = mapClaudeMessage({ type: 'result', subtype: 'error_max_turns', is_error: true }, newClaudeMapState());
    expect((t[0] as any).message).toMatch(/more steps/);
  });
});

describe('names (#7 onboarding)', () => {
  it('flags handle-like names', () => {
    for (const n of ['jdoe42', 'dev_2024', 'mike99', 'x.y', 'me@home']) expect(looksLikeHandle(n), n).toBe(true);
    expect(looksLikeHandle('jdoe', 'jdoe')).toBe(true); // exactly the Windows login
    // REVIEW-2 N7: real names in any script pass.
    for (const n of ['Alex', 'Lloyd', 'Llewellyn', 'Dmitri', 'Kwame', 'Gwen', 'Nnamdi', 'Mbali', 'Zbigniew', 'Bjorn', 'Ng', '王芳', 'Дмитрий', 'محمد', 'प्रिया', 'Anne-Marie', "O'Neil", 'Mary Jane']) {
      expect(looksLikeHandle(n), n).toBe(false);
    }
  });
  it('tidies names', () => {
    expect(tidyName('  alex  ')).toBe('Alex');
    expect(tidyName('mary   jane')).toBe('Mary jane');
  });
});
