// 0.9.12: "If I ask her to open Notepad and type something, she types garbled
// letters." type_text now sends real keystrokes for characters on the target's
// keyboard layout (Settings → Advanced → Typing method), reads the focused
// control back after typing, reports a mismatch honestly (naming the KVM tool),
// retries at most once with the other method, then stops.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolHost } from '../src/main/tools';
import { SafetyGate } from '../src/main/safety-gate';
import { DEFAULT_SAFETY } from '../src/shared/safety';
import { checkTyped, insertedText, otherMethod } from '../src/main/typing-verify';
import { applyPatch, DEFAULT_SETTINGS, mergeSettings, sanitizeRendererPatch } from '../src/shared/settings';

describe('0.9.12 read-back comparison', () => {
  it('typed text that arrived is ok (empty doc, middle of a doc, CRLF, replace-all, autocomplete, auto-capitalisation)', () => {
    expect(checkTyped('', 'Hello, World!', 'Hello, World!')).toBe('ok');
    expect(checkTyped('abc def', 'abc Hello def', 'Hello ')).toBe('ok');
    expect(checkTyped('', 'line one\r\nline two', 'line one\nline two')).toBe('ok');
    expect(checkTyped('old text', 'new text', 'new text')).toBe('ok');
    expect(checkTyped('', 'github.com/tezzgod74', 'github.c')).toBe('ok');
    expect(checkTyped('', 'Hello there', 'hello there')).toBe('ok');
    expect(checkTyped('x', 'x hello x', 'x')).toBe('ok'); // one more occurrence than before
  });
  it('garbled or missing text is a mismatch', () => {
    expect(checkTyped('', 'Ifmmp-!Xpsme"', 'Hello, World!')).toBe('mismatch');
    expect(checkTyped('', '', 'Hello')).toBe('mismatch'); // nothing arrived
    expect(checkTyped('Hello', 'Hello', 'Hello')).toBe('mismatch'); // already there, but no new copy
  });
  it('unreadable controls or whitespace-only text are unknown (never a false alarm)', () => {
    expect(checkTyped(null, 'x', 'x')).toBe('unknown');
    expect(checkTyped('', null, 'x')).toBe('unknown');
    expect(checkTyped('', '   ', '   ')).toBe('unknown');
  });
  it('insertedText and the alternate method', () => {
    expect(insertedText('abc def', 'abc XYZ def')).toBe('XYZ ');
    expect(otherMethod('auto')).toBe('unicode');
    expect(otherMethod('keys')).toBe('unicode');
    expect(otherMethod('unicode')).toBe('keys');
  });
});

describe('0.9.12 type_text verifies, reports honestly, retries once with the other method, then stops', () => {
  const fx = { ghostMoveTo: async () => {}, ghostClick: () => {}, ghostHide: () => {}, highlight: () => {}, clearPoint: async () => () => {}, status: () => {} };
  const target = { hwnd: 7, title: 'Untitled - Notepad', process: 'Notepad.exe', pid: 42, elevated: false, rect: { x: 0, y: 0, width: 400, height: 300 } };

  /** A Notepad whose document text is readable; `garble` decides what a method actually produces. */
  function notepad(garble: (t: string, method: string) => string, opts: { readable?: boolean } = {}) {
    const doc = { text: '' };
    const calls: { text: string; method?: string; hwnd?: number }[] = [];
    const helper: any = {
      foreground: async () => ({ ok: true, foreground: 7 }),
      focusedElement: async () => ({ role: 'document', name: 'Text editor', aid: '', className: 'RichEditD2DPT', framework: 'Win32', pid: 42 }),
      focusedText: async () => ({ text: opts.readable === false ? null : doc.text, source: 'text', info: { role: 'document', className: 'RichEditD2DPT', pid: 42 } }),
      typeText: async (t: string, o: { method?: string; hwnd?: number } = {}) => {
        calls.push({ text: t, ...o });
        doc.text += garble(t, o.method ?? 'auto');
        return { typed: t.length, method: o.method, keystrokes: 0, unicode: 0, layout: '04090409' };
      },
      pressKeys: async () => {},
      inputState: async () => ({ cursorShowing: true, idleMs: 10 }),
      windowInfo: async () => ({}),
    };
    const host = new ToolHost(helper, new SafetyGate(() => DEFAULT_SAFETY, { confirm: async () => false }), fx as any);
    host.kvmProbe = async () => ['Input Director'];
    host.verifyDelayMs = 1;
    host.readBackDelayMs = 1;
    host.run = { target, signal: new AbortController().signal, frame: null, nodes: new Map(), prompt: 'open notepad and type hello world' };
    return { host, calls, doc };
  }
  const shift = (t: string) => [...t].map((c) => String.fromCharCode(c.charCodeAt(0) + 1)).join('');

  it('text that arrives: ok, sent with the configured method and the target window', async () => {
    const { host, calls } = notepad((t) => t);
    host.typingMethod = () => 'auto';
    const res = await host.typeText({ text: 'hello world' });
    expect(res.isError).toBeFalsy();
    expect((res.content[0] as any).text).toMatch(/^Typed 11 characters\./);
    expect(calls).toEqual([{ text: 'hello world', method: 'auto', hwnd: 7 }]);
  });

  it('garbled text: ok:false, says it didn’t come out right, names Input Director, offers ONE retry with the other method', async () => {
    const { host, calls } = notepad((t, m) => (m === 'unicode' ? shift(t) : t));
    host.typingMethod = () => 'unicode';
    const res = await host.typeText({ text: 'hello world' });
    expect(res.isError).toBe(true);
    const msg = (res.content[0] as any).text as string;
    expect(msg).toMatch(/didn't come out right/);
    expect(msg).toMatch(/Input Director is running on this PC/);
    expect(msg).toMatch(/Don't claim it was typed/);
    expect(msg).toMatch(/ifmmp!xpsme/); // what arrived, fenced as screen data
    expect(msg).toMatch(/real keystrokes/);
    expect(host.run!.typeMismatches).toBe(1);
    // The retry uses the other method automatically and works.
    const again = await host.typeText({ text: 'hello world' });
    expect(again.isError).toBeFalsy();
    expect(calls.map((c) => c.method)).toEqual(['unicode', 'keys']);
    expect(host.run!.typeMismatches).toBe(0);
  });

  it('both methods garbled: the second failure says stop; a third call types nothing', async () => {
    const { host, calls } = notepad((t) => shift(t));
    host.typingMethod = () => 'auto';
    expect((await host.typeText({ text: 'hello world' })).isError).toBe(true);
    const second = await host.typeText({ text: 'hello world' });
    expect(second.isError).toBe(true);
    expect((second.content[0] as any).text).toMatch(/still didn't come out right.*with both typing methods.*Stop typing.*Input Director is the likely cause/s);
    expect(calls.map((c) => c.method)).toEqual(['auto', 'unicode']);
    const third = await host.typeText({ text: 'hello world' });
    expect(third.isError).toBe(true);
    expect(calls.length).toBe(2); // nothing typed again: no clear-and-retype loop
  });

  it('a control that can’t be read is not judged (no false alarm)', async () => {
    const { host } = notepad((t) => shift(t), { readable: false });
    const res = await host.typeText({ text: 'hello world' });
    expect(res.isError).toBeFalsy();
  });

  it('the honesty check sees the failed type_text', async () => {
    const { host } = notepad((t) => shift(t));
    host.run!.toolResults = [];
    const def = host.definitions().find((d) => d.name === 'type_text')!;
    await def.handler({ text: 'hello world' });
    expect(host.run!.toolResults).toEqual([{ name: 'type_text', ok: false, code: 'typing-mismatch' }]);
    await def.handler({ text: 'hello world' });
    await def.handler({ text: 'hello world' });
    expect(host.run!.toolResults!.map((t) => t.code)).toEqual(['typing-mismatch', 'typing-mismatch', 'typing-stopped']);
  });
});

describe('0.9.12 setting and wiring', () => {
  it('Typing method: default auto, validated, renderer may set it', () => {
    expect(DEFAULT_SETTINGS.typingMethod).toBe('auto');
    expect(mergeSettings({ typingMethod: 'keys' }).typingMethod).toBe('keys');
    expect(mergeSettings({ typingMethod: 'telepathy' }).typingMethod).toBe('auto');
    expect(applyPatch(DEFAULT_SETTINGS, { typingMethod: 'unicode' }).typingMethod).toBe('unicode');
    expect(sanitizeRendererPatch({ typingMethod: 'keys' })).toEqual({ typingMethod: 'keys' });
  });
  it('app, helper, composition and panel are wired', () => {
    const app = fs.readFileSync('src/main/app.ts', 'utf8');
    expect(app).toMatch(/this\.tools\.typingMethod = \(\) => this\.settings\.get\(\)\.typingMethod;/);
    const helper = fs.readFileSync('src/main/helper.ts', 'utf8');
    expect(helper).toMatch(/this\.call<[^>]*>\('type_text', \{ text, epoch: this\.inputEpoch, \.\.\.o \}, 60000\)/);
    expect(helper).toMatch(/focusedText = \(\) => this\.call<[^(]*>\('focused_text'/);
    const comp = fs.readFileSync('src/main/composition.ts', 'utf8');
    expect(comp).toMatch(/typeText: \(t, o\) => h\(\)\.typeText\(t, o\)/);
    expect(comp).toMatch(/focusedText: \(\) => h\(\)\.focusedText\(\)/);
    const panel = fs.readFileSync('src/renderer/panel/main.ts', 'utf8');
    expect(panel).toMatch(/<option value="auto">Auto \(recommended\)<\/option><option value="keys">Real keystrokes only<\/option><option value="unicode">Unicode only<\/option>/);
    expect(panel).toMatch(/api\.setSettings\(\{ typingMethod: typingSel\.value \}\)/);
    const rust = fs.readFileSync('native/cadabra-helper/src/main.rs', 'utf8');
    expect(rust).toMatch(/"focused_text" => uia::focused_text\(\)/);
  });
});
