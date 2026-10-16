// 0.9.14: never wipe the user's own unsaved text.
//
// Found during the 0.9.13 investigation: Windows 11 Notepad (and other apps
// with session restore, e.g. browsers and VS Code) can reopen the user's
// unsaved tabs in a window Cadabra launches. Then the AI's usual "clear and
// retype" (Ctrl+A, then Delete / Backspace / typing over it) erases the user's
// work. So:
// - after launching a tabbed Notepad that shows existing text, Cadabra opens a
//   new empty tab and types there;
// - select-all followed by an erase, in a control whose text Cadabra didn't
//   type this turn, needs the user's OK (every autonomy level except "Don't
//   ask"); clearing Cadabra's own text from this turn stays silent.

/** What the helper reports about the focused control (focused_text). */
export interface FocusedInfo {
  role: string;
  className: string;
  pid: number;
  /** The control's own window handle (0 for windowless controls). */
  hwnd?: number;
}

/** Identifies one text control (a Notepad tab has its own RichEdit window). */
export function controlKey(i: FocusedInfo): string {
  return `${i.pid}:${i.hwnd ?? 0}:${i.className}:${i.role}`;
}

/** What Cadabra knows about a control it typed into this turn. */
export interface LedgerEntry {
  /** The control's text before Cadabra first typed into it this turn (null = unreadable). */
  baseline: string | null;
  /** The control's text right after Cadabra's last edit (null = unreadable). */
  last: string | null;
}

const norm = (s: string) => s.replace(/\r\n?/g, '\n');

/** Short single-line fields (search boxes, address bars) are replaced routinely; not "your work". */
export const SMALL_FIELD_CHARS = 200;

/**
 * Would erasing all of this control's text remove text Cadabra didn't type
 * this turn? Returns how much (chars null = can't be read), or null when it's
 * fine (empty, Cadabra's own text, or a short single-line field).
 */
export function eraseCheck(current: string | null, info: FocusedInfo | null, entry?: LedgerEntry): { chars: number | null } | null {
  if (current != null && !current.trim()) return null;
  if (current != null && entry && entry.baseline != null && !entry.baseline.trim() && entry.last != null && norm(current) === norm(entry.last)) return null;
  if (current != null && info && info.role !== 'document' && !/\n/.test(current) && current.length < SMALL_FIELD_CHARS) return null;
  return { chars: current == null ? null : norm(current).length };
}

function chordParts(keys: string): string[] {
  return keys
    .toLowerCase()
    .replace(/\s+/g, '')
    .split('+')
    .map((k) => (k === 'control' ? 'ctrl' : k === 'del' ? 'delete' : k === 'back' || k === 'bksp' ? 'backspace' : k))
    .filter(Boolean);
}

/** Ctrl+A. */
export function isSelectAll(keys: string): boolean {
  const p = chordParts(keys);
  return p.length === 2 && p.includes('ctrl') && p.includes('a');
}

/** A key that removes the selection: Delete, Backspace (optionally with Ctrl), or Cut (Ctrl+X). */
export function isEraseKey(keys: string): boolean {
  const p = chordParts(keys);
  const mods = p.filter((k) => k === 'ctrl');
  const rest = p.filter((k) => k !== 'ctrl');
  if (rest.length !== 1 || p.length - mods.length !== 1) return false;
  if (rest[0] === 'x') return mods.length === 1;
  return rest[0] === 'delete' || rest[0] === 'backspace';
}

/**
 * Apps where a freshly launched window can show restored text, and the keys
 * that open a new empty document there. Windows 11 Notepad (RichEditD2DPT):
 * Ctrl+N opens a new tab (Ctrl+Shift+N a new window). The classic Notepad
 * ("Edit" control) is never sent Ctrl+N: it would ask to save and replace.
 */
export function newDocumentKeys(process: string | undefined, className: string | undefined): string | null {
  const p = (process ?? '').toLowerCase().replace(/\.exe$/, '');
  if (p === 'notepad' && className === 'RichEditD2DPT') return 'ctrl+n';
  return null;
}

/** The card reason (stable wording: reasonId maps it to 'erase-text'). */
export function eraseReason(chars: number | null): string {
  return chars == null ? 'Erases text Cadabra didn’t type (it can’t read how much)' : `Erases ${chars.toLocaleString('en-US')} character${chars === 1 ? '' : 's'} of text Cadabra didn’t type`;
}
