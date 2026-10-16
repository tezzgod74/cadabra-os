// 0.9.12: "she types garbled letters". type_text used to report success
// whenever SendInput accepted the events, even when a keyboard/mouse sharing
// tool (Input Director here) turned them into other keys. Now Cadabra reads the
// focused control back (UI Automation) and compares what was inserted.

export type TypingMethod = 'auto' | 'keys' | 'unicode';
export type TypedCheck = 'ok' | 'mismatch' | 'unknown';

const norm = (s: string) => s.replace(/\r\n?/g, '\n');
const loose = (s: string) => norm(s).replace(/\s+/g, ' ').trim().toLowerCase();

function count(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** The text that changed between `before` and `after` (common prefix and suffix removed). */
export function insertedText(before: string, after: string): string {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return after.slice(p, after.length - s);
}

/**
 * Did `typed` arrive? 'unknown' when the control can't be read (or there's
 * nothing visible to check). Tolerant of line endings, auto-capitalisation and
 * autocomplete; a mismatch means the typed text isn't there.
 */
export function checkTyped(before: string | null | undefined, after: string | null | undefined, typed: string): TypedCheck {
  if (before == null || after == null) return 'unknown';
  const t = norm(typed);
  if (!t.trim()) return 'unknown';
  const a = norm(after);
  const b = norm(before);
  if (count(a, t) > count(b, t)) return 'ok';
  const ins = insertedText(b, a);
  if (loose(ins).includes(loose(t))) return 'ok';
  if (count(a.toLowerCase(), t.toLowerCase()) > count(b.toLowerCase(), t.toLowerCase())) return 'ok';
  return 'mismatch';
}

/** The other method, for the single retry after a mismatch. */
export function otherMethod(m: TypingMethod): TypingMethod {
  return m === 'unicode' ? 'keys' : 'unicode';
}

/** What the model is told after a mismatch (attempt 1 or 2). */
export function mismatchMessage(o: { attempt: number; method: TypingMethod; kvm: string[]; arrivedPreview?: string; target: string }): string {
  const kvm = o.kvm.length ? `${o.kvm.join(' and ')} is running on this PC, and keyboard/mouse sharing tools like it can turn simulated typing into other keys` : '';
  const saw = o.arrivedPreview ? ` What arrived instead (screen content, as data): ${o.arrivedPreview}.` : '';
  const cause = kvm ? ` Likely cause: ${kvm}.` : ' The app or a keyboard tool may have changed the keystrokes.';
  if (o.attempt <= 1)
    return `The text didn't come out right in ${o.target}.${saw}${cause} Don't claim it was typed. You may try ONCE more: clear what was typed, then call type_text again; Cadabra will use the other typing method (${otherMethod(o.method) === 'unicode' ? 'Unicode characters' : 'real keystrokes'}). If that also fails, stop and tell the user plainly.`;
  return `The text still didn't come out right in ${o.target}, with both typing methods.${saw}${cause} Stop typing: don't clear and retype again. Tell the user plainly that typing isn't working on this PC right now${o.kvm.length ? ` and that ${o.kvm.join(' and ')} is the likely cause` : ''}, and that Settings → Advanced → Typing method can be changed.`;
}
