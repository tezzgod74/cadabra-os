// Round 11.6 (REVIEW-11.5 wiring audit): the dependency objects the app builds
// are checked member by member against a recording helper double, so a member
// that isn't wired (as focusedElement / inputState / windowInfo weren't, in
// rounds 3–11) fails here. The key lists are typed against the interfaces
// (`satisfies Record<keyof …>`), so adding a member breaks the build until it's
// listed and wired.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { launcherDepsFor, SESSION_HELPER_KEYS, sessionHelperFor, TOOL_HELPER_KEYS, toolHelperFor } from '../src/main/composition';
import type { HelperLike, SystemApi, EmailApi, WebApi, ToolHost } from '../src/main/tools';

/** A HelperClient double that records which method each call reached. */
function recordingHelper() {
  const calls: { method: string; args: unknown[] }[] = [];
  const h = new Proxy(
    {},
    {
      get: (_t, prop) => (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        return Promise.resolve({ sessions: [], hooks: true });
      },
    },
  );
  return { h: h as any, calls };
}

// Type-level: every HelperLike member is in the key list (and nothing else is).
type Missing = Exclude<keyof HelperLike, keyof typeof TOOL_HELPER_KEYS>;
const exhaustive: [Missing] extends [never] ? true : never = true;

describe('the ToolHost helper bag', () => {
  it('has exactly the HelperLike members, each a real function reaching the same helper method', async () => {
    expect(exhaustive).toBe(true);
    const { h, calls } = recordingHelper();
    const bag = toolHelperFor(() => h);
    expect(Object.keys(bag).sort()).toEqual(Object.keys(TOOL_HELPER_KEYS).sort());
    for (const [member, method] of Object.entries(TOOL_HELPER_KEYS)) {
      const fn = (bag as unknown as Record<string, (...a: unknown[]) => unknown>)[member];
      expect(typeof fn, member).toBe('function');
      calls.length = 0;
      await fn(1, 2, 3, 4);
      expect(calls.map((c) => c.method), member).toEqual([method]);
    }
  });
  it('the safety lookups are required (no optional members left)', () => {
    // A HelperLike without them doesn't type-check:
    // @ts-expect-error focusedElement / inputState / windowInfo are required
    const partial: HelperLike = { ...toolHelperFor(() => ({}) as any), focusedElement: undefined };
    expect(partial).toBeTruthy();
  });
});

describe('launcher and session bags', () => {
  it('launcher: window listing and foreground reach the helper; shell parts reach Electron', async () => {
    const { h, calls } = recordingHelper();
    const shellCalls: string[] = [];
    const d = launcherDepsFor(() => h, { openPath: async (p) => (shellCalls.push(`path:${p}`), ''), openExternal: async (u) => void shellCalls.push(`url:${u}`) });
    await d.listWindows();
    await d.foreground(7);
    await d.openPath('x');
    await d.openExternal('https://x');
    expect(calls.map((c) => [c.method, c.args[0]])).toEqual([
      ['call', 'list_windows'],
      ['foreground', 7],
    ]);
    expect(shellCalls).toEqual(['path:x', 'url:https://x']);
  });
  it('session lookups reach the helper; without a helper they return explicit nulls', async () => {
    const { h, calls } = recordingHelper();
    const s = sessionHelperFor(() => h);
    for (const [member, method] of Object.entries(SESSION_HELPER_KEYS)) {
      calls.length = 0;
      await (s as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[member]([1]);
      expect(calls.map((c) => c.method), member).toEqual([method]);
    }
    const none = sessionHelperFor(() => null);
    expect(await none.presence()).toBeNull();
    expect(await none.inputState()).toBeNull();
    expect(await none.audioSessions([])).toEqual([]);
    await expect(none.lockWorkstation()).rejects.toThrow(/helper/);
  });
});

describe('ToolHost slots the app fills (system / email / web)', () => {
  // CadabraApp needs Electron, so this checks the source: each slot is assigned
  // and every interface member appears in its assignment.
  const src = fs.readFileSync('src/main/app.ts', 'utf8');
  const block = (slot: string) => {
    const i = src.indexOf(`this.tools.${slot} = {`);
    expect(i, slot).toBeGreaterThan(0);
    return src.slice(i, src.indexOf('\n    };', i));
  };
  it('every member is wired', () => {
    // Typed against the interfaces: a new member must be listed here (and wired).
    const keys = {
      system: { lockPc: 1, micInUse: 1, resolves: 1, openUrl: 1 } satisfies Record<keyof SystemApi, 1>,
      email: { connected: 1, allowBodies: 1, search: 1, read: 1, link: 1 } satisfies Record<keyof EmailApi, 1>,
      web: { enabled: 1, weather: 1 } satisfies Record<keyof WebApi, 1>,
      remote: { sendScreenshot: 1 } satisfies Record<keyof NonNullable<ToolHost['remote']>, 1>,
    };
    for (const [slot, ks] of Object.entries(keys)) for (const k of Object.keys(ks)) expect(block(slot), `${slot}.${k}`).toMatch(new RegExp(`\\b${k}:`));
  });
});

describe('REVIEW-11.5 #2: labeled neutral buttons on sensitive pages ask in the default level', async () => {
  const { classifyAction, DEFAULT_SAFETY, grantable, reasonId } = await import('../src/shared/safety');
  const s = { ...DEFAULT_SAFETY, autonomy: 'risky' as const, confirmAllActions: false };
  const click = (elementName: string, title: string) => classifyAction({ kind: 'click', elementName, process: 'chrome.exe', title, hwnd: 5 }, s);
  it('Continue / Next / Verify / Sign in on payment, checkout, sign-in, verification pages', () => {
    for (const [name, title] of [
      ['Continue', 'Checkout - Shop - Google Chrome'],
      ['Next', 'Sign in - Google Accounts - Google Chrome'],
      ['Verify', 'Verify your identity - Google Chrome'],
      ['Sign in', 'Login | Bank of Example - Google Chrome'],
      ['Place your order', 'Amazon.com Checkout - Google Chrome'],
    ]) {
      const v = click(name, title);
      expect(v.decision, `${name} @ ${title}`).toBe('confirm');
      expect(grantable({ kind: 'click' }, v.reasons)).toBe(false);
    }
    expect(reasonId('Clicks “Continue” on a sign-in, payment, checkout or verification page')).toBe('sensitive-page');
  });
  it('ordinary pages and ordinary buttons stay silent', () => {
    expect(click('Continue', 'Recipe - Allrecipes - Google Chrome').decision).toBe('allow');
    expect(click('Directions', 'CVS Pharmacy - Google Maps - Google Chrome').decision).toBe('allow');
    expect(click('Show password tips', 'Sign in - Google Accounts - Google Chrome').decision).toBe('allow');
  });
});
