import { describe, expect, it } from 'vitest';
import {
  bindingAccelerator,
  bindingFromKeyEvent,
  bindingFromMouseEvent,
  bindingKeycaps,
  bindingToHelper,
  codeToVk,
  DEFAULT_BINDING,
  formatBinding,
  sanitizeBinding,
  validateBinding,
  type SummonBinding,
} from '../src/shared/binding';
import { mergeSettings } from '../src/shared/settings';

const key = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) =>
  bindingFromKeyEvent({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe('binding parsing', () => {
  it('maps KeyboardEvent.code to Windows virtual keys', () => {
    expect(codeToVk('Backquote')).toBe(0xc0);
    expect(codeToVk('KeyK')).toBe(0x4b);
    expect(codeToVk('Digit7')).toBe(0x37);
    expect(codeToVk('F13')).toBe(0x7c);
    expect(codeToVk('F24')).toBe(0x87);
    expect(codeToVk('Space')).toBe(0x20);
    expect(codeToVk('Fn')).toBeNull();
  });
  it('builds bindings from recorder events and ignores lone modifiers', () => {
    expect(key('ControlLeft', { ctrlKey: true })).toBeNull();
    expect(key('KeyJ', { ctrlKey: true, altKey: true })).toEqual({ kind: 'key', ctrl: true, alt: true, shift: false, win: false, vk: 0x4a, key: 'J' });
    expect(bindingFromMouseEvent({ button: 2, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toEqual({ kind: 'mouse', ctrl: true, alt: false, shift: false, win: false, button: 'right' });
    expect(bindingFromMouseEvent({ button: 0, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBeNull();
  });
  it('formats the default as Ctrl+~', () => {
    expect(formatBinding(DEFAULT_BINDING)).toBe('Ctrl+~');
    expect(bindingKeycaps(DEFAULT_BINDING)).toEqual(['Ctrl', '~']);
    expect(bindingAccelerator(DEFAULT_BINDING)).toBe('Ctrl+`');
    expect(formatBinding({ kind: 'mouse', ctrl: true, alt: false, shift: false, win: false, button: 'right' })).toBe('Ctrl+Right-click');
    expect(bindingToHelper(DEFAULT_BINDING)).toEqual({ kind: 'key', vk: 0xc0, scan: 0x29, button: null, ctrl: true, alt: false, shift: false, win: false, anyShift: true });
  });
});

describe('binding validation', () => {
  const v = (b: SummonBinding | null) => validateBinding(b!);
  it('accepts the default with a VS Code conflict warning', () => {
    const r = validateBinding(DEFAULT_BINDING);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/VS Code/);
  });
  it('requires a modifier, except F13–F24', () => {
    expect(v(key('KeyA')).ok).toBe(false);
    expect(v(key('KeyA', { shiftKey: true })).error).toMatch(/Shift alone/);
    expect(v(key('F5')).ok).toBe(false);
    expect(v(key('F13')).ok).toBe(true);
    expect(v(key('F24')).ok).toBe(true);
  });
  it('rejects Win-key combos and reserved system shortcuts', () => {
    expect(v(key('Backquote', { metaKey: true })).error).toMatch(/Win-key/);
    expect(v(key('Delete', { ctrlKey: true, altKey: true })).error).toMatch(/Ctrl\+Alt\+Del/);
    expect(v(key('Tab', { altKey: true })).ok).toBe(false);
    expect(v(key('F4', { altKey: true })).ok).toBe(false);
    expect(v(key('Escape', { ctrlKey: true, shiftKey: true })).ok).toBe(false);
  });
  it('warns about known conflicts', () => {
    expect(v(key('Backquote', { ctrlKey: true, shiftKey: true })).warnings.join(' ')).toMatch(/new terminal/);
    expect(v(key('Space', { ctrlKey: true })).warnings.join(' ')).toMatch(/input methods/);
    expect(v(key('KeyC', { ctrlKey: true })).warnings.join(' ')).toMatch(/standard editing/);
    expect(v(key('KeyJ', { ctrlKey: true, altKey: true })).warnings).toEqual([]);
  });
  it('validates mouse bindings', () => {
    const m = (button: number, mods = {}) => bindingFromMouseEvent({ button, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
    expect(v(m(2)).ok).toBe(false);
    expect(v(m(2, { ctrlKey: true })).ok).toBe(true);
    expect(v(m(1, { altKey: true })).ok).toBe(true);
    expect(v(m(3)).ok).toBe(true); // a side button alone is fine
    expect(v(m(2, { metaKey: true })).ok).toBe(false);
  });
});

describe('binding persistence', () => {
  it('defaults to Ctrl+~ and drops invalid stored bindings', () => {
    expect(mergeSettings({}).summon).toEqual(DEFAULT_BINDING);
    expect(mergeSettings({ summon: { kind: 'key', vk: 0x41 } }).summon).toEqual(DEFAULT_BINDING); // "A" alone is invalid
    expect(mergeSettings({ summon: { kind: 'mouse', ctrl: true, button: 'right' } }).summon).toMatchObject({ kind: 'mouse', button: 'right', ctrl: true });
    expect(sanitizeBinding({ kind: 'key', vk: 0x4a, ctrl: true, alt: true })).toMatchObject({ key: 'J' });
  });
});

describe('C1: layout-independent default binding', () => {
  it('records the key below Esc by physical position and migrates old settings', () => {
    expect(bindingFromKeyEvent({ code: 'Backquote', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })?.scan).toBe(0x29);
    expect(bindingFromKeyEvent({ code: 'KeyJ', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })?.scan).toBeUndefined();
    expect(sanitizeBinding({ kind: 'key', ctrl: true, vk: 0xc0, anyShift: true })?.scan).toBe(0x29);
  });
});
