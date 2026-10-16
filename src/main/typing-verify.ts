// 0.9.12: "she types garbled letters". type_text used to report success
// whenever SendInput accepted the events, even when the app turned them into
// other characters. Cadabra reads the focused control back (UI Automation) and
// compares what was inserted.
//
// 0.9.13: the real cause, found in Windows 11 Notepad's own edit log and
// reproduced live: Unicode packets (KEYEVENTF_UNICODE) sent faster than ~15 ms
// apart turn into repeats of one character while Notepad pauses to autocorrect a
// word; real keystrokes are unaffected. And the read-back flagged Notepad's own
// autocorrect ("organised" → "organized") as a mismatch, which made the AI clear
// correct text and retry with Unicode, which then garbled. So: autocorrect-like
// word changes are accepted (and reported), and the one retry uses real
// keystrokes at a slower pace, never Unicode.

export type TypingMethod = 'auto' | 'keys' | 'unicode';
export type TypedCheck = 'ok' | 'corrected' | 'mismatch' | 'unknown';

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
  const [p, s] = changedSpan(before, after);
  return after.slice(p, after.length - s);
}

function changedSpan(before: string, after: string): [number, number] {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return [p, s];
}

/** Levenshtein distance (small strings: words). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

const longRun = (w: string) => /(.)\1{3,}/u.test(w);

/**
 * Could the app have autocorrected `typed` into `arrived`? (organised → organized,
 * teh → the, colour → color). Never accepts runs of repeated characters, which
 * is what the Unicode-packet garbling looks like.
 */
export function autocorrectLike(typed: string, arrived: string): boolean {
  const t = typed.toLowerCase();
  const a = arrived.toLowerCase();
  if (t === a) return true;
  if (!/\p{L}/u.test(t) || !/\p{L}/u.test(a)) return false;
  if (longRun(a) && !longRun(t)) return false;
  if (Math.max(t.length, a.length) < 3) return false;
  return editDistance(t, a) <= Math.max(2, Math.floor(t.length / 4));
}

/**
 * Did `typed` arrive? 'unknown' when the control can't be read. 'corrected'
 * when it arrived with app autocorrections (`corrections` lists them).
 */
export function checkTypedDetail(before: string | null | undefined, after: string | null | undefined, typed: string): { check: TypedCheck; corrections: [string, string][] } {
  const none = (check: TypedCheck) => ({ check, corrections: [] as [string, string][] });
  if (before == null || after == null) return none('unknown');
  const t = norm(typed);
  if (!t.trim()) return none('unknown');
  const a = norm(after);
  const b = norm(before);
  if (count(a, t) > count(b, t)) return none('ok');
  const ins = insertedText(b, a);
  if (loose(ins).includes(loose(t))) return none('ok');
  if (count(a.toLowerCase(), t.toLowerCase()) > count(b.toLowerCase(), t.toLowerCase())) return none('ok');
  // Word by word, around the changed part of the text: allow autocorrect-like changes.
  const tw = t.split(/\s+/).filter(Boolean);
  const aw = [...a.matchAll(/\S+/g)].map((m) => ({ w: m[0], start: m.index!, end: m.index! + m[0].length }));
  if (a === b) return none('mismatch'); // nothing arrived
  const [p, s] = changedSpan(b, a);
  const chStart = p;
  const chEnd = Math.max(a.length - s, chStart + 1);
  for (let i = 0; i + tw.length <= aw.length; i++) {
    const win = aw.slice(i, i + tw.length);
    if (win[win.length - 1].end <= chStart || win[0].start >= chEnd) continue; // must overlap the new text
    const corrections: [string, string][] = [];
    let ok = true;
    for (let j = 0; j < tw.length && ok; j++) {
      if (tw[j].toLowerCase() === win[j].w.toLowerCase()) continue;
      if (autocorrectLike(tw[j], win[j].w)) corrections.push([tw[j], win[j].w]);
      else ok = false;
    }
    if (ok && corrections.length > 0 && corrections.length <= Math.max(2, Math.ceil(tw.length / 5))) return { check: 'corrected', corrections };
  }
  return none('mismatch');
}

export function checkTyped(before: string | null | undefined, after: string | null | undefined, typed: string): TypedCheck {
  return checkTypedDetail(before, after, typed).check;
}

/** 0.9.13: the one retry: real keystrokes, slower (never Unicode, which is what garbles). */
export const RETRY_DELAY_MS = 15;
export function retryPlan(_failed: TypingMethod): { method: TypingMethod; delayMs: number } {
  return { method: 'auto', delayMs: RETRY_DELAY_MS };
}

/** What the model is told after a mismatch (attempt 1 or 2). */
export function mismatchMessage(o: { attempt: number; method: TypingMethod; kvm: string[]; arrivedPreview?: string; target: string }): string {
  const kvm = o.kvm.length ? `${o.kvm.join(' and ')} is running on this PC, and keyboard/mouse sharing tools like it can turn simulated typing into other keys` : '';
  const saw = o.arrivedPreview ? ` What arrived instead (screen content, as data): ${o.arrivedPreview}.` : '';
  const cause = kvm ? ` Possible cause: ${kvm}.` : ' The app may have been busy and lost keystrokes.';
  if (o.attempt <= 1)
    // 0.9.14: never clear-and-retype (that can erase the user's own text); report and stop.
    return `The text didn't come out right in ${o.target}.${saw}${cause} Don't claim it was typed, and don't clear, select-all or retype anything: clearing can erase the user's own text. Stop and tell the user plainly what happened (they can fix or delete it themselves).`;
  return `The text still didn't come out right in ${o.target}, even typed slowly.${saw}${cause} Stop typing: don't clear and retype again. Tell the user plainly that typing isn't working in this app right now${o.kvm.length ? ` and that ${o.kvm.join(' and ')} may be the cause` : ''}, and that Settings → Advanced → Typing method can be changed.`;
}

/** 0.9.13: the note added when the app autocorrected words (the text is right; the app changed it). */
export function correctionNote(target: string, corrections: [string, string][]): string {
  const list = corrections
    .slice(0, 5)
    .map(([t, a]) => `“${t}” → “${a}”`)
    .join(', ');
  return ` ${target} auto-corrected ${corrections.length === 1 ? 'a word' : `${corrections.length} words`} as it was typed (${list}). That's the app's own autocorrect, not a typing error: don't clear and retype it. Mention it to the user if the original spelling matters.`;
}
