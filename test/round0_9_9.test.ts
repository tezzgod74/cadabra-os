// 0.9.9: "Clear chat history". What's removed (Cadabra's own folders only),
// what's kept (sign-ins, settings, skills, keys, the user's own CLI folders),
// the startup / on-close / idle modes, the confirm step on every channel, and
// the production wiring.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { clearHistoryFiles, historyTargets, IDLE_CLEAR_MS, idleClearDue, ORPHAN_AGE_MS, startupSweep, type HistoryPaths } from '../src/main/history';
import { parseIntent } from '../src/shared/intents';
import { DEFAULT_SETTINGS, mergeSettings, sanitizeRendererPatch } from '../src/shared/settings';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadabra-hist-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function put(file: string, text = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** A fake %APPDATA%\Cadabra OS, temp folder and home, filled like a real install. */
function world(name: string) {
  const root = path.join(tmp, name);
  const ud = path.join(root, 'Cadabra OS');
  const home = path.join(root, 'home');
  const temp = path.join(root, 'temp');
  const p: HistoryPaths = {
    userData: ud,
    agentWork: path.join(ud, 'agent-work'),
    codexHome: path.join(ud, 'codex-home'),
    geminiHome: path.join(ud, 'gemini-home'),
    claudeConfig: path.join(ud, 'claude-api-config'),
    e2eReports: path.join(ud, 'e2e-live'),
    temp,
    home,
  };
  const content = {
    mcp: put(path.join(p.agentWork, 'claude-mcp-0a1b2c.json'), '{"Authorization":"Bearer t"}'),
    prompt: put(path.join(p.agentWork, 'claude-prompt-0a1b2c.txt')),
    hook: put(path.join(p.agentWork, 'claude-settings-0a1b2c.json')),
    shot: put(path.join(p.agentWork, 'screen-1760000000000.png')),
    cwdFile: put(path.join(p.agentWork, 'claude-cwd', 'scratch.txt')),
    codexSessions: put(path.join(p.codexHome, 'sessions', '2026', 'rollout-1.jsonl'), 'my private question'),
    codexHistory: put(path.join(p.codexHome, 'history.jsonl')),
    geminiChats: put(path.join(p.geminiHome, '.gemini', 'tmp', 'abc', 'chats', 'session.json'), 'my private question'),
    claudeProjects: put(path.join(p.claudeConfig, 'projects', 'x', 'session.jsonl'), 'my private question'),
    claudeJson: put(path.join(p.claudeConfig, '.claude.json')),
    e2e: put(path.join(p.e2eReports, 'report-claude.md')),
    term: put(path.join(temp, 'cadabra-term-deadbeef', 'out.txt'), 'command output'),
  };
  const keep = {
    settings: put(path.join(ud, 'settings.json'), '{}'),
    secrets: put(path.join(ud, 'secrets.json'), '{}'),
    codexAuth: put(path.join(p.codexHome, 'auth.json'), '{"signed":"in"}'),
    codexConfig: put(path.join(p.codexHome, 'config.toml')),
    geminiOauth: put(path.join(p.geminiHome, '.gemini', 'oauth_creds.json')),
    geminiSettings: put(path.join(p.geminiHome, 'cadabra-system-settings.json')),
    appIndex: put(path.join(ud, 'app-index.json')),
    models: put(path.join(ud, 'models', 'kokoro', 'model.onnx')),
    logs: put(path.join(ud, 'logs', 'cadabra.log')),
    otherAgentWork: put(path.join(p.agentWork, 'gemini-workspace', '.gemini', 'settings.json')),
    // The user's own CLI folders: never touched.
    userClaude: put(path.join(home, '.claude', 'projects', 'p', 'session.jsonl')),
    userCodex: put(path.join(home, '.codex', 'sessions', 'r.jsonl')),
    userGemini: put(path.join(home, '.gemini', 'tmp', 'chats.json')),
    otherTemp: put(path.join(temp, 'someone-else', 'file.txt')),
  };
  return { p, content, keep };
}

describe('0.9.9 clearing Cadabra’s own history files', () => {
  it('removes every content-bearing file in Cadabra’s folders; keeps sign-ins, settings, keys, models, logs and the user’s own CLI folders', () => {
    const w = world('a');
    const removed = clearHistoryFiles(w.p);
    for (const [k, f] of Object.entries(w.content)) expect(fs.existsSync(f), k).toBe(false);
    for (const [k, f] of Object.entries(w.keep)) expect(fs.existsSync(f), k).toBe(true);
    expect(removed.length).toBeGreaterThan(8);
    expect(historyTargets(w.p)).toEqual([]); // nothing left to clear
  });
  it('never touches the user’s own ~/.claude, ~/.codex or ~/.gemini, even if pointed there by mistake', () => {
    const w = world('b');
    const misconfigured: HistoryPaths = { ...w.p, codexHome: path.join(w.p.home!, '.codex'), geminiHome: path.join(w.p.home!), claudeConfig: path.join(w.p.home!, '.claude') };
    clearHistoryFiles(misconfigured);
    expect(fs.existsSync(w.keep.userClaude)).toBe(true);
    expect(fs.existsSync(w.keep.userCodex)).toBe(true);
    expect(fs.existsSync(w.keep.userGemini)).toBe(true);
  });
  it('startup clean-up ("until I clear it"): only orphaned temp files older than a day, never history (0.9.10 M1)', () => {
    const w = world('c');
    const old = (Date.now() - ORPHAN_AGE_MS - 60_000) / 1000;
    // Everything is old, yet only the orphaned temp/session files go.
    for (const f of [...Object.values(w.content), path.join(w.p.temp, 'cadabra-term-deadbeef'), path.join(w.p.codexHome, 'sessions'), path.join(w.p.claudeConfig, 'projects'), path.join(w.p.geminiHome, '.gemini', 'tmp')]) fs.utimesSync(f, old, old);
    put(path.join(w.p.agentWork, 'claude-prompt-ffff.txt')); // fresh: stays
    expect(startupSweep('until-cleared')).toEqual({ scope: 'orphans', olderThanMs: ORPHAN_AGE_MS });
    clearHistoryFiles(w.p, startupSweep('until-cleared'));
    for (const k of ['mcp', 'prompt', 'hook', 'shot', 'term'] as const) expect(fs.existsSync(w.content[k]), k).toBe(false);
    for (const k of ['codexSessions', 'codexHistory', 'geminiChats', 'claudeProjects', 'claudeJson', 'e2e', 'cwdFile'] as const) expect(fs.existsSync(w.content[k]), k).toBe(true);
    expect(fs.existsSync(path.join(w.p.agentWork, 'claude-prompt-ffff.txt'))).toBe(true);
    expect(historyTargets(w.p, 'orphans').map((t) => path.basename(t.path))).toEqual(['claude-prompt-ffff.txt']);
  });
  it('startup clean-up in the auto-clear modes', () => {
    expect(startupSweep('on-close')).toEqual({ scope: 'all' });
    expect(startupSweep('idle-1h')).toEqual({ scope: 'all', olderThanMs: IDLE_CLEAR_MS });
    const w = world('c2');
    clearHistoryFiles(w.p, startupSweep('on-close'));
    for (const [k, f] of Object.entries(w.content)) expect(fs.existsSync(f), k).toBe(false);
    for (const [k, f] of Object.entries(w.keep)) expect(fs.existsSync(f), k).toBe(true);
  });
  it('"Clear after 1 hour of inactivity"', () => {
    const now = 10 * IDLE_CLEAR_MS;
    expect(idleClearDue('idle-1h', now - IDLE_CLEAR_MS, now, false)).toBe(true);
    expect(idleClearDue('idle-1h', now - IDLE_CLEAR_MS + 1000, now, false)).toBe(false);
    expect(idleClearDue('idle-1h', now - 2 * IDLE_CLEAR_MS, now, true)).toBe(false); // not while working
    expect(idleClearDue('idle-1h', null, now, false)).toBe(false); // nothing to clear
    expect(idleClearDue('until-cleared', 0, now, false)).toBe(false);
    expect(idleClearDue('on-close', 0, now, false)).toBe(false);
  });
});

describe('0.9.9 asking, settings and wiring', () => {
  it('phrases that ask to clear (voice, typed and WhatsApp share the parser)', () => {
    for (const t of ['clear my history', 'Cadabra, delete our conversation', 'forget this conversation', 'clear chat history', 'erase my chats', 'delete all messages', 'clear the history please'])
      expect(parseIntent(t), t).toEqual({ kind: 'clear-history' });
    for (const t of ['clear the table', 'delete the file history.txt', 'what is in my history book'])
      expect(parseIntent(t)?.kind, t).not.toBe('clear-history');
  });
  it('settings: "Until I clear it" by default; validated; a renderer preference', () => {
    expect(DEFAULT_SETTINGS.privacy).toEqual({ keepHistory: 'until-cleared', showInRecordings: false });
    expect(mergeSettings({ privacy: { keepHistory: 'idle-1h' } }).privacy.keepHistory).toBe('idle-1h');
    expect(mergeSettings({ privacy: { keepHistory: 'forever' } }).privacy.keepHistory).toBe('until-cleared');
    expect(sanitizeRendererPatch({ privacy: { keepHistory: 'on-close' } })).toEqual({ privacy: { keepHistory: 'on-close' } });
  });
  it('production: always asks first (PC card / spoken yes-no / WhatsApp code), clears both channels and backends, keeps the rest', () => {
    const src = fs.readFileSync('src/main/app.ts', 'utf8');
    const ask = src.slice(src.indexOf('async askClearHistory('), src.indexOf('async askClearHistory(') + 1500);
    expect(ask.indexOf('await this.confirm(')).toBeGreaterThan(0);
    expect(ask.indexOf('await this.confirm(')).toBeLessThan(ask.indexOf('this.clearHistory('));
    expect(ask).toMatch(/if \(ok !== true && ok !== 'always'\) return 'Okay, I kept your history\.'/);
    expect(ask).toMatch(/Say yes to confirm/);
    const clear = src.slice(src.indexOf('async clearHistory('), src.indexOf('async clearHistory(') + 1500);
    for (const step of ['this.conv.newChat()', 'this.remoteConv.newChat()', 'p.dispose', 'clearHistoryFiles(this.historyPaths())', "type: 'reset'", 'History cleared.'])
      expect(clear, step).toContain(step);
    // Nothing that isn't chat history: no settings / secrets / skills / grants / pairing calls.
    expect(clear).not.toMatch(/setSecret|settings\.update|skills|grants|pairedFrom/);
    // Every entry point goes through askClearHistory (which asks first).
    expect(src).toMatch(/ipcMain\.handle\('history:clear', async \(e\) => \(fromPanel\(e\) \? this\.askClearHistory\('pc', false, false\) : null\)\)/);
    expect(src).toMatch(/label: 'Clear chat history…', click: \(\) => void this\.showPanelCentered\(\)\.then\(\(\) => this\.askClearHistory\('pc', false, false\)\)/);
    expect(src).toMatch(/case 'clear-history':\s*return this\.askClearHistory\('pc'/);
    expect(src).toMatch(/if \(intent\?\.kind === 'clear-history'\) return this\.askClearHistory\('whatsapp'\)/);
    // WhatsApp confirmations use the one-time code in the chat (channel routing in confirm()).
    expect(src).toMatch(/if \(p\.channel === 'whatsapp'\) return this\.remote\.confirm/);
    // Paths: Cadabra's own folders only.
    const hp = src.slice(src.indexOf('historyPaths(): HistoryPaths'), src.indexOf('historyPaths(): HistoryPaths') + 700);
    for (const d of ["'agent-work'", "'codex-home'", "'gemini-home'", "'claude-api-config'", "'e2e-live'"]) expect(hp).toContain(d);
    expect(hp).not.toMatch(/homedir/);
    // Startup / on-close modes.
    expect(src).toMatch(/clearHistoryFiles\(this\.historyPaths\(\), startupSweep\(mode\)\)/);
    expect(src).not.toMatch(/fs\.rmSync\([^)]*recursive/);
    expect(src).toMatch(/=== 'on-close'\) \{\s*const n = clearHistoryFiles\(this\.historyPaths\(\)\)\.length;/);
  });
  it('Claude’s backend session files are removed when its process is disposed (quit / clear)', async () => {
    const { ClaudeProvider } = await import('../src/main/providers/claude');
    const work = path.join(tmp, 'claude-work');
    const cmd = path.join(tmp, 'claude.cmd');
    fs.writeFileSync(cmd, `@"${process.execPath}" "${path.resolve('test/fixtures/fake-claude.mjs')}" %*\r\n`);
    const p = new ClaudeProvider({ tools: () => [], apiKey: () => undefined, exePath: () => cmd, workDir: work, version: '1', route: () => 'claude-code', mcp: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'T' }) });
    await p.prewarm('m');
    expect(fs.readdirSync(work).some((f) => /^claude-mcp-/.test(f))).toBe(true);
    await p.dispose();
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.readdirSync(work).filter((f) => /^claude-(mcp|prompt|settings)-/.test(f))).toEqual([]);
  }, 30_000);
});
