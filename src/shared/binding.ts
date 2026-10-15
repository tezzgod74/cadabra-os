// Summon shortcut binding: model, validation, conflict warnings, formatting.
// The helper enforces it in its low-level hooks (set_binding RPC).

export interface SummonBinding {
  kind: 'key' | 'mouse';
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
  /** Keyboard: Windows virtual-key code. */
  vk?: number;
  /** Keyboard: physical key (set-1 scan code) for layout-independent matching (C1). */
  scan?: number;
  /** Keyboard: display name of the key ("`", "Space", "F13", "K"). */
  key?: string;
  /** Mouse: which button. */
  button?: 'right' | 'middle' | 'x1' | 'x2';
  /** Match whether or not Shift is held (default binding: Ctrl+` and Ctrl+Shift+` = "Ctrl+~"). */
  anyShift?: boolean;
}

export const VK_OEM_3 = 0xc0; // ` ~ on US layouts

/** C1: physical key below Esc (set-1 scan code), whatever character the layout puts on it. */
export const SCAN_BELOW_ESC = 0x29;
export const DEFAULT_BINDING: SummonBinding = { kind: 'key', ctrl: true, alt: false, shift: false, win: false, vk: VK_OEM_3, scan: SCAN_BELOW_ESC, key: '`', anyShift: true };

const VK_NAMES: Record<number, string> = {
  0x08: 'Backspace',
  0x09: 'Tab',
  0x0d: 'Enter',
  0x1b: 'Esc',
  0x20: 'Space',
  0x21: 'PageUp',
  0x22: 'PageDown',
  0x23: 'End',
  0x24: 'Home',
  0x25: 'Left',
  0x26: 'Up',
  0x27: 'Right',
  0x28: 'Down',
  0x2d: 'Insert',
  0x2e: 'Delete',
  0xba: ';',
  0xbb: '=',
  0xbc: ',',
  0xbd: '-',
  0xbe: '.',
  0xbf: '/',
  0xc0: '`',
  0xdb: '[',
  0xdc: '\\',
  0xdd: ']',
  0xde: "'",
};

export function vkName(vk: number): string {
  if (VK_NAMES[vk]) return VK_NAMES[vk];
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);
  if (vk >= 0x70 && vk <= 0x87) return `F${vk - 0x6f}`;
  if (vk >= 0x60 && vk <= 0x69) return `Num${vk - 0x60}`;
  return `0x${vk.toString(16)}`;
}

/** KeyboardEvent.code → Windows VK (layout-independent physical key). */
export function codeToVk(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  const f = /^F(\d{1,2})$/.exec(code);
  if (f && +f[1] >= 1 && +f[1] <= 24) return 0x6f + +f[1];
  const n = /^Numpad([0-9])$/.exec(code);
  if (n) return 0x60 + +n[1];
  const map: Record<string, number> = {
    Backquote: 0xc0,
    Minus: 0xbd,
    Equal: 0xbb,
    BracketLeft: 0xdb,
    BracketRight: 0xdd,
    Backslash: 0xdc,
    Semicolon: 0xba,
    Quote: 0xde,
    Comma: 0xbc,
    Period: 0xbe,
    Slash: 0xbf,
    Space: 0x20,
    Enter: 0x0d,
    Tab: 0x09,
    Backspace: 0x08,
    Escape: 0x1b,
    Insert: 0x2d,
    Delete: 0x2e,
    Home: 0x24,
    End: 0x23,
    PageUp: 0x21,
    PageDown: 0x22,
    ArrowLeft: 0x25,
    ArrowUp: 0x26,
    ArrowRight: 0x27,
    ArrowDown: 0x28,
  };
  return map[code] ?? null;
}

const MOD_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

/** Build a binding from a recorder keydown. Returns null for a lone modifier. */
export function bindingFromKeyEvent(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): SummonBinding | null {
  if (MOD_CODES.test(e.code)) return null;
  const vk = codeToVk(e.code);
  if (vk == null) return null;
  const b: SummonBinding = { kind: 'key', ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, win: e.metaKey, vk, key: vkName(vk) };
  // KeyboardEvent.code is positional; keep the key below Esc physical on every layout (C1).
  if (e.code === 'Backquote') b.scan = SCAN_BELOW_ESC;
  return b;
}

export function bindingFromMouseEvent(e: { button: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): SummonBinding | null {
  const button = ({ 1: 'middle', 2: 'right', 3: 'x1', 4: 'x2' } as const)[e.button as 1 | 2 | 3 | 4];
  if (!button) return null;
  return { kind: 'mouse', ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, win: e.metaKey, button };
}

const isFKeyHigh = (vk?: number) => vk != null && vk >= 0x7c && vk <= 0x87; // F13–F24

export interface BindingCheck {
  ok: boolean;
  error?: string;
  warnings: string[];
}

export function sameCombo(a: SummonBinding, b: Partial<SummonBinding>): boolean {
  return a.kind === (b.kind ?? 'key') && a.vk === b.vk && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift && !!a.win === !!b.win;
}

const CONFLICTS: { combo: Partial<SummonBinding>; note: string }[] = [
  { combo: { ctrl: true, vk: 0xc0 }, note: 'VS Code and many editors use Ctrl+` to toggle the terminal — Cadabra will take it over everywhere.' },
  { combo: { ctrl: true, shift: true, vk: 0xc0 }, note: 'VS Code uses Ctrl+Shift+` to open a new terminal.' },
  { combo: { win: true, vk: 0xc0 }, note: 'Windows Terminal uses Win+` for its quake window.' },
  { combo: { ctrl: true, vk: 0x20 }, note: 'Ctrl+Space switches input methods and triggers autocomplete in many apps.' },
  { combo: { alt: true, vk: 0x20 }, note: 'Alt+Space opens the window menu (and PowerToys Run).' },
  { combo: { ctrl: true, shift: true, vk: 0x50 }, note: 'Ctrl+Shift+P is the command palette in VS Code and browsers (private window).' },
  { combo: { ctrl: true, vk: 0x4b }, note: 'Ctrl+K is widely used (links, command menus).' },
  { combo: { ctrl: true, alt: true, vk: 0x54 }, note: 'Ctrl+Alt+T opens a terminal in some setups.' },
  { combo: { ctrl: true, shift: true, vk: 0x53 }, note: 'Ctrl+Shift+S is "Save As" in most apps.' },
];

const RESERVED: { combo: Partial<SummonBinding>; why: string }[] = [
  { combo: { ctrl: true, alt: true, vk: 0x2e }, why: 'Ctrl+Alt+Del is reserved by Windows.' },
  { combo: { ctrl: true, shift: true, vk: 0x1b }, why: 'Ctrl+Shift+Esc opens Task Manager.' },
  { combo: { ctrl: true, vk: 0x1b }, why: 'Ctrl+Esc opens the Start menu.' },
  { combo: { alt: true, vk: 0x09 }, why: 'Alt+Tab is reserved by Windows.' },
  { combo: { alt: true, vk: 0x1b }, why: 'Alt+Esc is reserved by Windows.' },
  { combo: { alt: true, vk: 0x73 }, why: 'Alt+F4 closes windows.' },
];

/** Validate a binding and collect conflict warnings. */
export function validateBinding(b: SummonBinding): BindingCheck {
  const warnings: string[] = [];
  if (b.kind === 'mouse') {
    if (!b.button) return { ok: false, error: 'Pick a mouse button.', warnings };
    if (b.win) return { ok: false, error: 'Win-key combinations are reserved by Windows.', warnings };
    if (!b.ctrl && !b.alt && !b.shift && (b.button === 'right' || b.button === 'middle')) {
      return { ok: false, error: `A plain ${b.button}-click would break normal clicking — hold Ctrl, Alt or Shift too.`, warnings };
    }
    if (b.button === 'right' && b.shift && !b.ctrl && !b.alt) warnings.push('Shift+right-click opens the extended context menu in Explorer.');
    return { ok: true, warnings };
  }
  if (b.vk == null) return { ok: false, error: 'Press a key.', warnings };
  if (b.win) return { ok: false, error: 'Win-key shortcuts are reserved by Windows — use Ctrl or Alt instead.', warnings };
  for (const r of RESERVED) if (sameCombo(b, { kind: 'key', ...r.combo })) return { ok: false, error: r.why, warnings };
  const hasMod = b.ctrl || b.alt;
  if (!hasMod && !isFKeyHigh(b.vk)) {
    return { ok: false, error: b.shift ? 'Shift alone just types a character — add Ctrl or Alt.' : 'Add a modifier (Ctrl or Alt) — F13–F24 are the only keys allowed alone.', warnings };
  }
  if (b.alt && !b.ctrl && b.vk >= 0x41 && b.vk <= 0x5a) warnings.push('Alt+letter opens menus in many apps.');
  if (b.ctrl && !b.alt && !b.shift && [0x43, 0x56, 0x58, 0x5a, 0x59, 0x41, 0x53, 0x4f, 0x4e, 0x57, 0x54, 0x46, 0x50].includes(b.vk)) {
    warnings.push(`Ctrl+${vkName(b.vk)} is a standard editing shortcut in almost every app.`);
  }
  for (const c of CONFLICTS) {
    if (sameCombo(b, { kind: 'key', ctrl: false, alt: false, shift: false, win: false, ...c.combo })) warnings.push(c.note);
    else if (b.anyShift && !b.shift && sameCombo({ ...b, shift: true }, { kind: 'key', ctrl: false, alt: false, shift: false, win: false, ...c.combo })) warnings.push(c.note);
  }
  return { ok: true, warnings };
}

/** Keycap labels, e.g. ["Ctrl", "~"] for the default. */
export function bindingKeycaps(b: SummonBinding): string[] {
  const caps: string[] = [];
  if (b.ctrl) caps.push('Ctrl');
  if (b.alt) caps.push('Alt');
  if (b.shift) caps.push('Shift');
  if (b.win) caps.push('Win');
  if (b.kind === 'mouse') caps.push({ right: 'Right-click', middle: 'Middle-click', x1: 'Back button', x2: 'Forward button' }[b.button ?? 'right']);
  else caps.push(b.vk === VK_OEM_3 && b.anyShift && !b.shift ? '~' : (b.key ?? vkName(b.vk ?? 0)));
  return caps;
}

export function formatBinding(b: SummonBinding): string {
  return bindingKeycaps(b).join('+');
}

/** Electron accelerator string for display in menus (keyboard bindings only). */
export function bindingAccelerator(b: SummonBinding): string | null {
  if (b.kind !== 'key' || b.vk == null) return null;
  const parts: string[] = [];
  if (b.ctrl) parts.push('Ctrl');
  if (b.alt) parts.push('Alt');
  if (b.shift) parts.push('Shift');
  const k = b.vk === VK_OEM_3 ? '`' : vkName(b.vk);
  if (k.startsWith('0x')) return null;
  parts.push(k === 'Esc' ? 'Escape' : k);
  return parts.join('+');
}

/** Wire format for the helper's set_binding RPC. */
export function bindingToHelper(b: SummonBinding) {
  return {
    kind: b.kind,
    vk: b.vk ?? 0,
    scan: b.scan ?? 0,
    button: b.button ?? null,
    ctrl: !!b.ctrl,
    alt: !!b.alt,
    shift: !!b.shift,
    win: !!b.win,
    anyShift: !!b.anyShift,
  };
}

export function sanitizeBinding(raw: unknown): SummonBinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'key' && r.kind !== 'mouse') return null;
  const b: SummonBinding = { kind: r.kind, ctrl: !!r.ctrl, alt: !!r.alt, shift: !!r.shift, win: !!r.win };
  if (r.anyShift) b.anyShift = true;
  if (r.kind === 'key') {
    if (typeof r.vk !== 'number' || r.vk <= 0 || r.vk > 0xfe) return null;
    b.vk = r.vk;
    b.key = typeof r.key === 'string' ? r.key : vkName(r.vk);
    if (typeof r.scan === 'number' && r.scan > 0 && r.scan < 0x80) b.scan = r.scan;
    // The recorder always captured the physical key below Esc for VK_OEM_3 (C1 migration).
    else if (r.vk === VK_OEM_3) b.scan = SCAN_BELOW_ESC;
  } else {
    if (r.button !== 'right' && r.button !== 'middle' && r.button !== 'x1' && r.button !== 'x2') return null;
    b.button = r.button;
  }
  return validateBinding(b).ok ? b : null;
}
