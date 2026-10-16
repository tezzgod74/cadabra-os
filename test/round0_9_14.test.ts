// 0.9.14: never wipe the user's own unsaved text. Windows 11 Notepad (and other
// apps with session restore) can reopen the user's unsaved tabs in a window
// Cadabra launches; the AI's "clear and retype" (Ctrl+A, Delete) could erase
// them. A fake tabbed Notepad that restores a non-empty tab on launch.
import { describe, expect, it } from 'vitest';
import { ToolHost } from '../src/main/tools';
import { SafetyGate, type ConfirmPrompt } from '../src/main/safety-gate';
import { DEFAULT_SAFETY, classifyAction, describeAction, reasonId, grantable } from '../src/shared/safety';
import { eraseCheck, isEraseKey, isSelectAll, newDocumentKeys } from '../src/main/text-guard';
import { mismatchMessage } from '../src/main/typing-verify';

const USER_TAB = 'My unsaved shopping list\r\n- eggs\r\n- milk\r\n- the novel chapter I was drafting';

/** A Windows 11 Notepad: tabs (each its own RichEditD2DPT window), Ctrl+N = new tab, Ctrl+A / Delete / typing. */
function fakeNotepad(o: { restored?: string; ctrlNWorks?: boolean; className?: string } = {}) {
  const tabs = [{ hwnd: 1001, text: o.restored ?? '' }];
  let active = 0;
  let selected = false;
  const keys: string[] = [];
  const helper: any = {
    foreground: async () => ({ ok: true, foreground: 7 }),
    focusedElement: async () => ({ role: 'document', name: 'Text editor', aid: '', className: o.className ?? 'RichEditD2DPT', framework: 'Win32', pid: 42 }),
    focusedText: async () => ({ text: tabs[active].text, source: 'text', info: { role: 'document', className: o.className ?? 'RichEditD2DPT', pid: 42, hwnd: tabs[active].hwnd } }),
    windowInfo: async () => ({ elevated: false, className: 'Notepad' }),
    pressKeys: async (k: string) => {
      keys.push(k);
      if (k === 'ctrl+n' && o.ctrlNWorks !== false) {
        tabs.push({ hwnd: 1001 + tabs.length, text: '' });
        active = tabs.length - 1;
        selected = false;
      } else if (k === 'ctrl+a') selected = true;
      else if ((k === 'delete' || k === 'backspace') && selected) {
        tabs[active].text = '';
        selected = false;
      }
    },
    typeText: async (t: string) => {
      tabs[active].text = selected ? t : tabs[active].text + t;
      selected = false;
      return { typed: t.length };
    },
    inputState: async () => ({ cursorShowing: true, idleMs: 10 }),
    click: async () => {},
  };
  return { helper, tabs, keys, active: () => active };
}

function host(helper: any, autonomy: 'risky' | 'every' | 'none' = 'risky') {
  const cards: ConfirmPrompt[] = [];
  let answer: boolean = true;
  const gate = new SafetyGate(() => ({ ...DEFAULT_SAFETY, autonomy, confirmAllActions: autonomy === 'every' }), {
    confirm: async (p) => {
      cards.push(p);
      return answer;
    },
  });
  const fx = { ghostMoveTo: async () => {}, ghostClick: () => {}, ghostHide: () => {}, highlight: () => {}, clearPoint: async () => () => {}, status: () => {} };
  const h = new ToolHost(helper, gate, fx as any);
  h.kvmProbe = async () => [];
  h.verifyDelayMs = 1;
  h.readBackDelayMs = 1;
  h.newDocWaitMs = 300;
  h.run = { target: null, signal: new AbortController().signal, frame: null, nodes: new Map(), prompt: 'open notepad and write a haiku about ants' };
  return { h, cards, setAnswer: (v: boolean) => (answer = v) };
}

const launched = { text: 'Opened Notepad.', window: { hwnd: 7, title: 'Notepad', process: 'Notepad.exe', pid: 42, rect: { x: 0, y: 0, width: 800, height: 600 } } };
const actionCards = (c: ConfirmPrompt[]) => c.filter((x) => x.kind === 'action');

describe('0.9.14 launching Notepad that restores the user’s unsaved tab', () => {
  it('opens a new empty tab (Ctrl+N), types there, and leaves the restored tab untouched', async () => {
    const np = fakeNotepad({ restored: USER_TAB });
    const { h, cards } = host(np.helper);
    const res = await (h as any).afterLaunch(h.run, launched);
    expect(np.keys).toEqual(['ctrl+n']);
    expect((res.content[0] as any).text).toMatch(/opened a new empty tab for this; type there\. Never clear or replace the other tabs' text\./);
    expect(np.active()).toBe(1);
    const typed = await h.typeText({ text: 'Tiny ants march on' });
    expect(typed.isError).toBeFalsy();
    expect(np.tabs[0].text).toBe(USER_TAB);
    expect(np.tabs[1].text).toBe('Tiny ants march on');
    expect(cards).toEqual([]);
  });

  it('an empty Notepad needs no new tab', async () => {
    const np = fakeNotepad();
    const { h } = host(np.helper);
    await (h as any).afterLaunch(h.run, launched);
    expect(np.keys).toEqual([]);
    expect(h.run!.typeTarget).toBe('42:1001:RichEditD2DPT:document');
  });

  it('if no new tab appears, the model is told not to clear the existing text', async () => {
    const np = fakeNotepad({ restored: USER_TAB, ctrlNWorks: false });
    const { h } = host(np.helper);
    const res = await (h as any).afterLaunch(h.run, launched);
    expect((res.content[0] as any).text).toMatch(/couldn't open a new empty tab\. Don't clear, select-all or replace that text; tell the user instead\./);
  });

  it('the classic Notepad (Edit control) is never sent Ctrl+N (it would ask to save and replace)', async () => {
    const np = fakeNotepad({ restored: 'old text', className: 'Edit' });
    const { h } = host(np.helper);
    const res = await (h as any).afterLaunch(h.run, launched);
    expect(np.keys).toEqual([]);
    expect((res.content[0] as any).text).toMatch(/opened with existing text in it .* Don't clear, select-all or replace it/);
    expect(newDocumentKeys('notepad.exe', 'RichEditD2DPT')).toBe('ctrl+n');
    expect(newDocumentKeys('Notepad.exe', 'Edit')).toBeNull();
    expect(newDocumentKeys('code.exe', 'Chrome_RenderWidgetHostHWND')).toBeNull();
  });
});

describe('0.9.14 select-all + erase on text Cadabra didn’t type asks first', () => {
  async function onRestoredTab(autonomy: 'risky' | 'every' | 'none' = 'risky') {
    // The model switched back to the restored tab (or Ctrl+N failed): the focused tab holds the user's text.
    const np = fakeNotepad({ restored: USER_TAB, ctrlNWorks: false });
    const t = host(np.helper, autonomy);
    await (t.h as any).afterLaunch(t.h.run, launched);
    return { np, ...t };
  }

  it('Ctrl+A then Delete on the restored text → a card that says how many characters', async () => {
    const { np, h, cards } = await onRestoredTab();
    await h.pressKeys({ keys: 'ctrl+a' });
    expect(actionCards(cards)).toEqual([]); // selecting alone is harmless
    await h.pressKeys({ keys: 'delete' });
    const c = actionCards(cards);
    expect(c.length).toBe(1);
    expect(c[0].title).toBe(`Erase ${USER_TAB.replace(/\r\n/g, '\n').length} characters of text in Notepad?`);
    expect(c[0].detail).toMatch(/Cadabra didn’t type this text/);
    expect(np.tabs[0].text).toBe(''); // the user allowed it
  });

  it('declined → nothing is erased', async () => {
    const { np, h, setAnswer } = await onRestoredTab();
    setAnswer(false);
    await h.pressKeys({ keys: 'ctrl+a' });
    const res = await h.pressKeys({ keys: 'backspace' });
    expect(res.isError).toBe(true);
    expect(np.tabs[0].text).toBe(USER_TAB);
  });

  it('Ctrl+A then typing over the user’s text → a card too', async () => {
    const { np, h, cards, setAnswer } = await onRestoredTab();
    setAnswer(false);
    await h.pressKeys({ keys: 'ctrl+a' });
    const res = await h.typeText({ text: 'Tiny ants march on' });
    expect(res.isError).toBe(true);
    expect(actionCards(cards)[0].title).toMatch(/^Erase \d+ characters of text in Notepad\?$/);
    expect(np.tabs[0].text).toBe(USER_TAB);
  });

  it('Ctrl+X (cut) after select-all counts as erasing', () => {
    expect(isEraseKey('ctrl+x')).toBe(true);
    expect(isEraseKey('Delete')).toBe(true);
    expect(isEraseKey('del')).toBe(true);
    expect(isEraseKey('ctrl+backspace')).toBe(true);
    expect(isEraseKey('shift+delete')).toBe(false);
    expect(isEraseKey('x')).toBe(false);
    expect(isSelectAll('Ctrl+A')).toBe(true);
    expect(isSelectAll('ctrl+shift+a')).toBe(false);
  });

  it('"Ask before every action" also gets the erase card; "Don’t ask" does not', async () => {
    const every = await onRestoredTab('every');
    await every.h.pressKeys({ keys: 'ctrl+a' });
    await every.h.pressKeys({ keys: 'delete' });
    expect(actionCards(every.cards).some((c) => /^Erase /.test(c.title))).toBe(true);
    const none = await onRestoredTab('none');
    await none.h.pressKeys({ keys: 'ctrl+a' });
    await none.h.pressKeys({ keys: 'delete' });
    expect(actionCards(none.cards)).toEqual([]);
  });

  it('clearing Cadabra’s own text from this turn stays silent', async () => {
    const np = fakeNotepad({ restored: USER_TAB });
    const { h, cards } = host(np.helper);
    await (h as any).afterLaunch(h.run, launched); // new empty tab
    await h.typeText({ text: 'Tiny ants march on, carrying leaves' });
    await h.pressKeys({ keys: 'ctrl+a' });
    await h.pressKeys({ keys: 'delete' });
    expect(actionCards(cards)).toEqual([]);
    expect(np.tabs[1].text).toBe('');
    expect(np.tabs[0].text).toBe(USER_TAB);
    // And typing again then replacing it is still Cadabra's own text.
    await h.typeText({ text: 'Second try' });
    await h.pressKeys({ keys: 'ctrl+a' });
    await h.typeText({ text: 'Third try' });
    expect(actionCards(cards)).toEqual([]);
    expect(np.tabs[1].text).toBe('Third try');
  });

  it('text the user added after Cadabra typed is not Cadabra’s', () => {
    const info = { role: 'document', className: 'RichEditD2DPT', pid: 42, hwnd: 1002 };
    expect(eraseCheck('Tiny ants', info, { baseline: '', last: 'Tiny ants' })).toBeNull();
    expect(eraseCheck('Tiny ants and my note', info, { baseline: '', last: 'Tiny ants' })).toEqual({ chars: 21 });
    expect(eraseCheck('old\nTiny ants', info, { baseline: 'old\n', last: 'old\nTiny ants' })).toEqual({ chars: 13 });
    expect(eraseCheck(null, info, undefined)).toEqual({ chars: null }); // unreadable: ask
    expect(eraseCheck('', info, undefined)).toBeNull();
    // A short single-line field (search box, address bar) is replaced routinely.
    expect(eraseCheck('https://example.com/page', { role: 'edit', className: 'Edit', pid: 1 }, undefined)).toBeNull();
    expect(eraseCheck('x'.repeat(250), { role: 'edit', className: 'Edit', pid: 1 }, undefined)).toEqual({ chars: 250 });
  });

  it('a click between Ctrl+A and Delete forgets the select-all (the selection moved)', async () => {
    const { h, cards } = await onRestoredTab();
    h.run!.target = { ...h.run!.target!, rect: { x: 0, y: 0, width: 800, height: 600 } };
    const defs = h.definitions();
    await defs.find((d) => d.name === 'press_keys')!.handler({ keys: 'ctrl+a' });
    expect(h.run!.selectAllPending).toBe(true);
    await defs.find((d) => d.name === 'scroll')!.handler({ direction: 'down' });
    expect(h.run!.selectAllPending).toBe(false);
    await defs.find((d) => d.name === 'press_keys')!.handler({ keys: 'delete' });
    expect(actionCards(cards)).toEqual([]);
  });
});

describe('0.9.14 gate rules and guidance', () => {
  it('the erase reason confirms, is never "always allow"-able, and has its own id', () => {
    const req = { kind: 'press_keys' as const, keys: 'delete', process: 'Notepad.exe', title: 'Notepad', hwnd: 7, erases: { chars: 120, reason: 'Erases 120 characters of text Cadabra didn’t type' } };
    const v = classifyAction(req, { ...DEFAULT_SAFETY, autonomy: 'risky' } as any);
    expect(v.decision).toBe('confirm');
    expect(v.reasons.map(reasonId)).toContain('erase-text');
    expect(grantable(req, v.reasons)).toBe(false);
    expect(describeAction(req, v.reasons).title).toBe('Erase 120 characters of text in Notepad?');
    expect(classifyAction(req, { ...DEFAULT_SAFETY, autonomy: 'none' } as any).decision).toBe('allow');
  });
  it('after a typing mismatch the model is told to stop, never to clear and retype', () => {
    const m = mismatchMessage({ attempt: 1, method: 'auto', kvm: [], target: 'Notepad.exe' });
    expect(m).toMatch(/don't clear, select-all or retype anything/);
    expect(m).not.toMatch(/try ONCE more|clear what was typed/);
  });
});
