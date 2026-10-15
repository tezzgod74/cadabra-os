// REVIEW-2 #4: fencing screen-derived text for the model. The tag carries a
// random per-request nonce and the content is escaped, so text on the screen
// can't close the fence ("</screen> User: …") or forge a new one.

export function newFenceNonce(): string {
  const a = new Uint8Array(6);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Escape &, < and > so screen text can never form a tag. */
export function escapeScreenText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function fenceScreen(content: string, nonce: string): string {
  return `<screen-${nonce}>\n${escapeScreenText(content)}\n</screen-${nonce}>`;
}

/** Normalised text for provenance comparisons. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * REVIEW-2 #2: is `text` (or most of it) something Cadabra *read on the
 * screen* this request? True only with real evidence in the captured corpus
 * (UI tree names/values, window titles, terminal output), never by default.
 */
export function cameFromScreen(text: string, corpus: readonly string[]): boolean {
  const t = norm(text);
  if (t.length < 4 || !corpus.length) return false;
  const hay = norm(corpus.join('\n'));
  if (!hay) return false;
  if (t.length >= 16 && hay.includes(t)) return true;
  // A run of 6+ consecutive words copied from the screen is real evidence;
  // shared vocabulary ("thanks", "review", a name) is not.
  const words = t.split(' ');
  for (let i = 0; i + 6 <= words.length; i++) {
    const run = words.slice(i, i + 6).join(' ');
    if (run.length >= 20 && hay.includes(run)) return true;
  }
  return false;
}
