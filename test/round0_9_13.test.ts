// 0.9.13: the real cause of "she types garbled letters", reproduced live on
// Windows 11 Notepad: Unicode packets sent < ~15 ms apart turn into repeats of
// one character while Notepad pauses to autocorrect a word; real keystrokes are
// fine. And 0.9.12's read-back called Notepad's own autocorrect a mismatch, so
// the AI cleared correct text and retried with Unicode, which garbled. The
// strings below are the exact read-backs from those live runs.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ToolHost } from '../src/main/tools';
import { SafetyGate } from '../src/main/safety-gate';
import { DEFAULT_SAFETY } from '../src/shared/safety';
import { autocorrectLike, checkTyped, checkTypedDetail, editDistance } from '../src/main/typing-verify';
import { detectKvm } from '../src/main/kvm';

const TYPED = 'Ants live in highly organised colonies that can contain millions of individuals, divided into castes with queens and workers.';
const AUTOCORRECTED = 'Ants live in highly organized colonies that can contain millions of individuals, divided into castes with queens and workers.';
const GARBLED_4MS = 'Ants live in highly organized          that can contain millions of individuals, divided into castes with queens and workers.';
const GARBLED_SYNCED = 'Ants live in highly organized nnnnnies aaat cccccontain ssssssss nnnnndividuals,iiided ccccccastes uuuuuuueens eeeeeeeeers.';
const GARBLED_0MS = 'Ants live in ooooooooooooooooooooooooooooooooooooooooooooooooooooof ..................................';

describe('0.9.13 read-back: the app’s autocorrect is not a typing error, garbling is', () => {
  it('Notepad autocorrecting organised → organized is "corrected", with the word listed', () => {
    expect(checkTypedDetail('', AUTOCORRECTED, TYPED)).toEqual({ check: 'corrected', corrections: [['organised', 'organized']] });
    // Inside existing text too.
    expect(checkTyped('Notes:\n\nEnd.', `Notes:\n${AUTOCORRECTED}\nEnd.`, TYPED)).toBe('corrected');
  });
  it('the live garbled read-backs are mismatches', () => {
    for (const g of [GARBLED_4MS, GARBLED_SYNCED, GARBLED_0MS]) expect(checkTyped('', g, TYPED)).toBe('mismatch');
  });
  it('autocorrect-like word changes vs garbling', () => {
    expect(autocorrectLike('organised', 'organized')).toBe(true);
    expect(autocorrectLike('teh', 'the')).toBe(true);
    expect(autocorrectLike('colour', 'color')).toBe(true);
    expect(autocorrectLike('colonies', 'nnnnnies')).toBe(false); // repeated-character run
    expect(autocorrectLike('queens', 'uuuuuuueens')).toBe(false);
    expect(autocorrectLike('workers', 'banana')).toBe(false);
    expect(autocorrectLike('12', '13')).toBe(false); // numbers are never "autocorrected"
    expect(editDistance('organised', 'organized')).toBe(1);
  });
  it('more than a few changed words is a mismatch, not autocorrect', () => {
    expect(checkTyped('', 'Ants lave on haghly organized colinies', 'Ants live in highly organised colonies')).toBe('mismatch');
  });
  it('the exact old text with no new copy is still a mismatch', () => {
    expect(checkTyped(AUTOCORRECTED, AUTOCORRECTED, TYPED)).toBe('mismatch');
  });
});

describe('0.9.13 type_text with an autocorrecting Notepad', () => {
  const fx = { ghostMoveTo: async () => {}, ghostClick: () => {}, ghostHide: () => {}, highlight: () => {}, clearPoint: async () => () => {}, status: () => {} };
  const target = { hwnd: 7, title: 'Untitled - Notepad', process: 'Notepad.exe', pid: 42, elevated: false, rect: { x: 0, y: 0, width: 400, height: 300 } };
  function notepad(produce: (t: string, o: { method?: string; delayMs?: number }) => string) {
    const doc = { text: '' };
    const calls: { method?: string; delayMs?: number }[] = [];
    const helper: any = {
      foreground: async () => ({ ok: true, foreground: 7 }),
      focusedElement: async () => ({ role: 'document', name: 'Text editor', aid: '', className: 'RichEditD2DPT', framework: 'Win32', pid: 42 }),
      focusedText: async () => ({ text: doc.text, source: 'text', info: { role: 'document', className: 'RichEditD2DPT', pid: 42 } }),
      typeText: async (t: string, o: { method?: string; delayMs?: number } = {}) => {
        calls.push({ method: o.method, delayMs: o.delayMs });
        doc.text += produce(t, o);
        return { typed: t.length };
      },
      pressKeys: async () => {},
      inputState: async () => ({ cursorShowing: true, idleMs: 10 }),
      windowInfo: async () => ({}),
    };
    const host = new ToolHost(helper, new SafetyGate(() => DEFAULT_SAFETY, { confirm: async () => false }), fx as any);
    host.kvmProbe = async () => [];
    host.verifyDelayMs = 1;
    host.readBackDelayMs = 1;
    host.run = { target, signal: new AbortController().signal, frame: null, nodes: new Map(), prompt: 'open notepad and write about ants' };
    return { host, calls };
  }

  it('autocorrected text is a success with an honest note, and no retry', async () => {
    const { host, calls } = notepad((t) => t.replace('organised', 'organized'));
    const res = await host.typeText({ text: TYPED });
    expect(res.isError).toBeFalsy();
    const msg = (res.content[0] as any).text as string;
    expect(msg).toMatch(/^Typed \d+ characters\. "Text editor"|^Typed \d+ characters\. Notepad\.exe auto-corrected a word/);
    expect(msg).toMatch(/“organised” → “organized”/);
    expect(msg).toMatch(/don't clear and retype it/);
    expect(calls.length).toBe(1);
    expect(host.run!.typeMismatches ?? 0).toBe(0);
  });

  it('a garbled first attempt retries with real keystrokes, slower; never Unicode', async () => {
    const { host, calls } = notepad((t, o) => (o.delayMs ? t : GARBLED_4MS));
    host.typingMethod = () => 'auto';
    expect((await host.typeText({ text: TYPED })).isError).toBe(true);
    const again = await host.typeText({ text: TYPED });
    expect(again.isError).toBeFalsy();
    expect(calls).toEqual([
      { method: 'auto', delayMs: undefined },
      { method: 'auto', delayMs: 15 },
    ]);
  });
});

describe('0.9.13 Input Director detection', () => {
  it('the session helper alone (left running after Input Director is shut down) is not an active KVM', () => {
    expect(detectKvm(['InputDirectorSessionHelper.exe', 'explorer.exe'])).toEqual([]);
    expect(detectKvm(['InputDirector.exe', 'InputDirectorSessionHelper.exe'])).toEqual(['Input Director']);
  });
});

describe('0.9.13 helper pacing (source)', () => {
  it('Unicode packets are paced at >= 30 ms; the WM_NULL sync that didn’t help is gone', () => {
    const rs = fs.readFileSync('native/cadabra-helper/src/input.rs', 'utf8');
    expect(rs).toMatch(/pub const UNICODE_MIN_DELAY_MS: u64 = 30;/);
    expect(rs).toMatch(/type_with_paced\(&plan, \|st\| step_delay\(st, delay\)/);
    expect(rs).not.toMatch(/SendMessageTimeoutW/);
  });
});
