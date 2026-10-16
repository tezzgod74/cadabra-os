// 0.9.8 (user bug: "Cadabra cannot wake my computer when I'm away", WhatsApp
// actions failing with bare "error" at night). The display is woken before
// screen tools, kept on for the remote turn and released after; a locked PC
// gets a clear reply and no tool attempts; failures carry reason codes.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOCKED_REPLY, RemotePresence, toolFailureCode, type DesktopState } from '../src/main/remote-presence';
import { DEFAULT_SAFETY } from '../src/shared/safety';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/shared/settings';

function presence(states: (DesktopState | null)[], o: { wake?: boolean } = {}) {
  const log: string[] = [];
  const calls: string[] = [];
  let i = 0;
  let held = 0;
  const p = new RemotePresence({
    desktopState: async () => {
      calls.push('state');
      return states[Math.min(i++, states.length - 1)];
    },
    wakeDisplay: async () => void calls.push('wake'),
    holdDisplay: () => {
      held++;
      calls.push('hold');
      return () => {
        held--;
        calls.push('release');
      };
    },
    wakeEnabled: () => o.wake !== false,
    log: (l) => log.push(l),
    sleep: async () => undefined,
  });
  return { p, log, calls, held: () => held };
}
const ON: DesktopState = { locked: false, display: 'on', foreground: true, monitors: 1 };
const OFF: DesktopState = { locked: false, display: 'off', foreground: false, monitors: 0 };

describe('0.9.8 remote presence: wake, hold, release', () => {
  it('display off: wakes it BEFORE anything else, waits until it reports on, then holds it for the turn', async () => {
    const x = presence([OFF, OFF, ON]);
    expect(await x.p.beginTurn()).toEqual({ ok: true, woke: true });
    expect(x.calls).toEqual(['state', 'wake', 'state', 'state', 'hold']);
    expect(x.held()).toBe(1);
    expect(x.log.join('\n')).toMatch(/waking the display \(off, no monitors on the desktop, no foreground window\)/);
    x.p.endTurn();
    expect(x.held()).toBe(0);
    x.p.endTurn(); // idempotent
    expect(x.held()).toBe(0);
  });
  it('display already on: no wake, still held for the turn and released after', async () => {
    const x = presence([ON]);
    expect(await x.p.beginTurn()).toEqual({ ok: true, woke: false });
    expect(x.calls).toEqual(['state', 'hold']);
    x.p.endTurn();
    expect(x.calls.at(-1)).toBe('release');
  });
  it('locked: a clear reply, no wake, nothing held, and never an unlock attempt', async () => {
    const x = presence([{ locked: true, display: 'off', inputDesktop: null }]);
    expect(await x.p.beginTurn()).toEqual({ ok: false, code: 'desktop-locked', message: LOCKED_REPLY });
    expect(x.calls).toEqual(['state']);
    expect(x.held()).toBe(0);
    expect(LOCKED_REPLY).toMatch(/Your PC is locked, so I can’t see or use the screen\. I can still make announcements\./);
  });
  it('waking reveals the lock screen ("sign in after the display turns off"): locked', async () => {
    const x = presence([OFF, { locked: true, display: 'on', inputDesktop: 'Winlogon' }]);
    expect(await x.p.ensureScreen()).toMatchObject({ ok: false, code: 'desktop-locked' });
    expect(x.calls).toEqual(['state', 'wake', 'state']);
  });
  it('the display never reports on within 3 s: carries on (and says so in the log)', async () => {
    const x = presence([OFF]);
    expect(await x.p.ensureScreen()).toEqual({ ok: true, woke: true });
    expect(x.calls.filter((c) => c === 'state')).toHaveLength(13); // first check + 12 × 250 ms
    expect(x.log.join('\n')).toMatch(/didn't report on within 3000 ms/);
  });
  it('wake turned off in Settings: a plain reason instead of a wake', async () => {
    const x = presence([OFF], { wake: false });
    expect(await x.p.ensureScreen()).toMatchObject({ ok: false, code: 'display-off' });
    expect(x.calls).toEqual(['state']);
  });
});

describe('0.9.8 tools: locked → no attempts; reason codes instead of "error"', async () => {
  const { ToolHost } = await import('../src/main/tools');
  const { SafetyGate } = await import('../src/main/safety-gate');
  function host(state: DesktopState, ready: any = { ok: true, woke: false }, channel = 'whatsapp') {
    const captures: number[] = [];
    const helper: any = { capture: async () => (captures.push(1), Promise.reject(new Error('empty capture rect'))) };
    const h = new ToolHost(helper, new SafetyGate(() => DEFAULT_SAFETY, { confirm: async () => false }), { status: () => {} } as any);
    h.presence = { screen: async () => ready, state: async () => state };
    h.setRunFor(channel as any, { target: null, signal: new AbortController().signal, frame: null, nodes: new Map(), prompt: 'show me my screen', screen: [] } as any);
    const tool = (n: string) => h.definitions().find((d) => d.name === n)!;
    return { h, tool, captures };
  }
  it('a locked PC: see_screen and read_ui answer "desktop-locked" without touching the helper', async () => {
    const x = host({ locked: true }, { ok: false, code: 'desktop-locked', message: LOCKED_REPLY });
    for (const n of ['see_screen', 'read_ui', 'send_screenshot']) {
      const r = await x.tool(n).handler({});
      expect(r.isError, n).toBe(true);
      expect((r._meta as any).code, n).toBe('desktop-locked');
      expect((r.content[0] as any).text).toMatch(/Your PC is locked/);
    }
    expect(x.captures).toEqual([]);
    // Non-screen tools still work (e.g. announcements, weather).
    expect(fs.readFileSync('src/main/tools.ts', 'utf8')).toMatch(/SCREEN_TOOLS = new Set\(\['see_screen', 'read_ui', 'highlight', 'click', 'type_text', 'press_keys', 'scroll', 'send_screenshot', 'focus_app', 'launch_app'\]\)/);
  });
  it('a capture with no display on the desktop is logged as capture-failed:no-display, not "error"', async () => {
    const x = host({ locked: false, display: 'off', monitors: 0 });
    const r = await x.tool('see_screen').handler({ scope: 'screen' });
    expect((r._meta as any).code).toBe('capture-failed:no-display');
  });
  it('reason codes', () => {
    expect(toolFailureCode('see_screen', 'x', { locked: true })).toBe('desktop-locked');
    expect(toolFailureCode('see_screen', 'empty capture rect', null)).toBe('capture-failed:no-display');
    expect(toolFailureCode('see_screen', 'GetDC failed', { locked: false, display: 'off', monitors: 1 })).toBe('capture-failed:display-off');
    expect(toolFailureCode('press_keys', 'x', { locked: false, display: 'on', foreground: false, monitors: 1 })).toBe('no-foreground-window');
    expect(toolFailureCode('click', 'helper not running', { locked: false, display: 'on', foreground: true, monitors: 1 })).toBe('helper-error');
    expect(toolFailureCode('click', 'something odd', { locked: false, display: 'on', foreground: true, monitors: 1 })).toBe('error');
  });
});

describe('0.9.8 settings and wiring', () => {
  it('wake on by default, keep-awake off; both validated', () => {
    expect(DEFAULT_SETTINGS.remote).toMatchObject({ wakeDisplay: true, keepAwake: false });
    expect(mergeSettings({ remote: { wakeDisplay: false, keepAwake: true } }).remote).toMatchObject({ wakeDisplay: false, keepAwake: true });
    expect(mergeSettings({ remote: { wakeDisplay: 'no' } }).remote.wakeDisplay).toBe(true);
  });
  it('production: the remote turn checks / wakes first, holds the display, and releases it at turn end; locked → LOCKED_REPLY', () => {
    const src = fs.readFileSync('src/main/app.ts', 'utf8');
    const start = src.indexOf('private async handleRemote(');
    const body = src.slice(start, start + 3000);
    expect(body.indexOf('this.presence.beginTurn()')).toBeGreaterThan(0);
    expect(body.indexOf('this.presence.beginTurn()')).toBeLessThan(body.indexOf('this.remoteConv.send('));
    expect(body).toMatch(/return LOCKED_REPLY;/);
    expect(body).toMatch(/finally \{[\s\S]*this\.presence\.endTurn\(\)/);
    expect(src).toMatch(/powerSaveBlocker\.start\('prevent-display-sleep'\)/);
    expect(src).toMatch(/powerSaveBlocker\.start\('prevent-app-suspension'\)/);
    // Waking the display mustn't trigger a "welcome back" greeting mid-request.
    expect(src).toMatch(/userBusy: \(\) => this\.panelVisible \|\| this\.conv\.busy \|\| !!this\.remote\?\.busy/);
  });
});
