// Round 11.5: REVIEW-11 top 5.
import { describe, expect, it } from 'vitest';
import { classifyAction, DEFAULT_SAFETY, grantable } from '../src/shared/safety';
import { honestyCorrection } from '../src/main/conversation';
import { isOmnibox } from '../src/main/tools';
import { AUTONOMY_OPTIONS } from '../src/renderer/panel/autonomy';
import type { SafetySettings } from '../src/shared/types';

const risky: SafetySettings = { ...DEFAULT_SAFETY, autonomy: 'risky', confirmAllActions: false, grants: [] };

describe('R11-1 (High): "Always allow" never applies to risky cards', async () => {
  const { SafetyGate } = await import('../src/main/safety-gate');
  it('not offered for send / pay / delete / messaging / banking / shells / secrets / sensitive pages / web taint', () => {
    const cases: [any, string][] = [
      [{ kind: 'click' }, 'Looks like it could send'],
      [{ kind: 'click' }, 'Looks like it could pay / purchase'],
      [{ kind: 'press_keys' }, 'Shift+Delete permanently deletes'],
      [{ kind: 'press_keys' }, 'This will send the message'],
      [{ kind: 'click' }, 'Clicks an unlabeled button where messages are sent (could be Send)'],
      [{ kind: 'click' }, 'Clicks an unlabeled control in a payments/banking window'],
      [{ kind: 'click' }, 'Banking (chase.exe)'],
      [{ kind: 'type_text' }, 'Command window: Cadabra will type exactly this'],
      [{ kind: 'type_text' }, 'Types text copied from the screen, not from your request'],
      [{ kind: 'click' }, 'Clicks an unlabeled control on a sign-in, payment, checkout or verification page'],
      [{ kind: 'click' }, 'Clicks an unlabeled control on a site you didn’t name, after reading web content'],
      [{ kind: 'click' }, 'An email was read in this request; email can’t tell Cadabra what to do, so every action needs your OK'],
    ];
    for (const [req, reason] of cases) expect(grantable(req, [reason]), reason).toBe(false);
    expect(grantable({ kind: 'click' }, ['Ask before every action is on'])).toBe(true);
    expect(grantable({ kind: 'click' }, ['Clicks an unlabeled button on a web page (could be Send / Pay)'])).toBe(true);
  });
  it('an existing grant (even from the old build) never suppresses a risky card', async () => {
    const st: SafetySettings = { ...risky, grants: [{ cls: 'click', scope: 'site:mail.google.com', label: 'Clicks in mail.google.com', at: 1 }] };
    const asked: string[] = [];
    const gate = new SafetyGate(() => st, { confirm: async (p) => (asked.push(p.title), false) });
    const send = { kind: 'click' as const, elementName: 'Send', process: 'chrome.exe', title: 'Inbox - Gmail', hwnd: 5, scope: async () => ({ key: 'site:mail.google.com', label: 'mail.google.com' }) };
    await expect(gate.authorize({ signal: new AbortController().signal }, send)).rejects.toThrow(/declined/);
    expect(asked).toHaveLength(1);
  });
  it('labels say "ordinary"', async () => {
    const st: SafetySettings = { ...DEFAULT_SAFETY, autonomy: 'every', confirmAllActions: true, grants: [] };
    const labels: (string | undefined)[] = [];
    const gate = new SafetyGate(() => st, { confirm: async (p) => (labels.push(p.alwaysLabel), false) });
    await expect(gate.authorize({ signal: new AbortController().signal }, { kind: 'click', elementName: 'Directions', process: 'chrome.exe', title: 'Maps', hwnd: 5, scope: async () => ({ key: 'site:maps.google.com', label: 'maps.google.com' }) })).rejects.toThrow();
    expect(labels).toEqual(['Always allow ordinary clicks in maps.google.com']);
  });
});

describe('R11-2: honesty checks only Ada’s own first-person claims', () => {
  it("the reviewer's false positives pass untouched", () => {
    for (const reply of [
      'Microsoft opened a new store in Seattle today.',
      'He sent the invoice yesterday afternoon.',
      'Your build ran successfully in 3 minutes.',
      'I see the store opened at 9.',
      'The email says Sam submitted the form and posted the photos.',
      'Dana typed up the notes.',
    ])
      expect(honestyCorrection(reply, []), reply).toBeNull();
  });
  it('real first-person claims are still checked', () => {
    expect(honestyCorrection("I've typed it into Notepad.", [])).toBe("Correction: I didn't actually type it.");
    expect(honestyCorrection('Done — sent.', [])).toBe("Correction: I didn't actually send it.");
    expect(honestyCorrection('I clicked Directions and opened the route.', [{ name: 'click', ok: true, code: 'ok' }])).toBe("Correction: I didn't actually open it.");
    expect(honestyCorrection("I've opened Notepad and typed 622322422.", [{ name: 'launch_app', ok: true, code: 'ok' }])).toBe("Correction: I didn't actually type it.");
  });
});

describe('R11-3: sensitive pages and web-content taint in the default level', () => {
  const blind = { kind: 'click' as const, blindClick: true, process: 'chrome.exe', hwnd: 5 };
  it('sign-in / payment / checkout / verification pages card unlabeled clicks', () => {
    expect(classifyAction({ ...blind, title: 'Sign in - Google Accounts - Google Chrome' }, risky).decision).toBe('confirm');
    expect(classifyAction({ ...blind, title: 'Shop - Google Chrome', pageUrl: 'https://shop.example.com/checkout' }, risky).decision).toBe('confirm');
    expect(classifyAction({ ...blind, title: 'Confirm your account - Google Chrome' }, risky).decision).toBe('confirm');
    expect(classifyAction({ ...blind, title: 'CVS Pharmacy - Google Maps - Google Chrome', pageUrl: 'https://www.google.com/maps/place/CVS' }, risky).decision).toBe('allow');
  });
  it('after web content: unlabeled clicks on a site the user didn’t name ask; the named site stays silent', () => {
    expect(classifyAction({ ...blind, title: 'Deals - Google Chrome', offSiteAfterWeb: true }, risky).decision).toBe('confirm');
    expect(classifyAction({ ...blind, title: 'Deals - Google Chrome', offSiteAfterWeb: true, elementName: 'Next page' }, risky).decision).toBe('allow');
    expect(classifyAction({ ...blind, title: 'Maps', offSiteAfterWeb: false }, risky).decision).toBe('allow');
  });
});

describe('R11-4: the "Don’t ask" warning is plain', () => {
  it('says what it will do without asking, and why that’s risky', () => {
    const t = AUTONOMY_OPTIONS.find((o) => o.id === 'none')!.blurb;
    expect(t).toMatch(/terminal commands/);
    expect(t).toMatch(/open programs/);
    expect(t).toMatch(/Send/);
    expect(t).toMatch(/emails/);
    expect(t).toMatch(/trick me/);
  });
});

describe('R11-5: real elevation and the real address bar', async () => {
  const { ToolHost } = await import('../src/main/tools');
  const { SafetyGate } = await import('../src/main/safety-gate');
  it('only the browser’s own omnibox counts, never a search box on the page', () => {
    expect(isOmnibox({ role: 'edit', name: 'Address and search bar', value: 'www.google.com/maps' })).toBe(true);
    expect(isOmnibox({ role: 'combobox', name: 'Search or enter address', aid: '', value: 'x.com' })).toBe(true);
    expect(isOmnibox({ role: 'edit', name: '', aid: 'urlbar-input', value: 'example.org' })).toBe(true); // Firefox
    expect(isOmnibox({ role: 'edit', name: 'Search Google Maps', value: 'cvs' })).toBe(false);
    expect(isOmnibox({ role: 'edit', name: 'Search', value: 'evil.com' })).toBe(false);
  });
  it('the grant scope is the host in the address bar, read right before acting', async () => {
    let url = 'https://maps.google.com/maps?q=cvs';
    const helper: any = { uiTree: async () => ({ window: {}, hit: null, truncated: false, nodes: [{ id: 1, depth: 0, role: 'edit', name: 'Search Google Maps', rect: [0, 0, 1, 1], value: 'evil.com' }, { id: 2, depth: 0, role: 'edit', name: 'Address and search bar', rect: [0, 0, 1, 1], value: url }] }) };
    const h = new ToolHost(helper, new SafetyGate(() => DEFAULT_SAFETY, { confirm: async () => false }), {} as any);
    const r: any = { target: { hwnd: 5, process: 'chrome.exe', title: 'Maps', rect: { x: 0, y: 0, width: 1, height: 1 } }, signal: new AbortController().signal, frame: null, nodes: new Map() };
    const scope = (h as any).scopeFor(r);
    expect(await scope()).toEqual({ key: 'site:maps.google.com', label: 'maps.google.com' });
    url = 'https://www.paypal.com/checkout';
    expect(await scope()).toEqual({ key: 'site:paypal.com', label: 'paypal.com' }); // re-read, not cached
  });
  it('a launched admin window is marked elevated (no typing into it)', async () => {
    const helper: any = { foreground: async (x: number) => ({ foreground: x }), windowInfo: async () => ({ elevated: true, className: 'X' }) };
    const apps: any = { launch: async () => ({ text: 'Opened **Admin Tool**.', window: { hwnd: 9, title: 'Admin Tool', pid: 1, process: 'admintool.exe', rect: { x: 0, y: 0, width: 400, height: 300 } } }) };
    const h = new ToolHost(helper, new SafetyGate(() => DEFAULT_SAFETY, { confirm: async () => false }), { status: () => {} } as any, undefined, apps);
    h.run = { target: null, signal: new AbortController().signal, frame: null, nodes: new Map(), prompt: 'open admin tool and type hi' };
    const res = await h.launchAppTool({ id: 'x' });
    expect((res.content[0] as any).text).toMatch(/runs as administrator/);
    expect(h.run!.target?.elevated).toBe(true);
    const t = await h.typeText({ text: 'hi' });
    expect(t.isError).toBe(true);
  });
});
