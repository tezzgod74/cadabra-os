// Turn a (markdown) reply into something pleasant to SAY: no markdown, no
// URLs or code read verbatim, short. The panel still shows the full text.

export function toSpeech(markdown: string, maxSentences = 2, maxChars = 320): string {
  let t = markdown;
  // Round 7: a trailing "Sources:" line (links) is shown in the panel, never read out.
  t = t.replace(/(^|\n)\s*\**sources?\**:[\s\S]*$/i, '');
  t = t.replace(/```[\s\S]*?```/g, ' (details are in the panel) ');
  t = t.replace(/`([^`]{1,40})`/g, '$1').replace(/`[^`]*`/g, ' ');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  t = t.replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, '$1');
  t = t.replace(/https?:\/\/\S+/g, 'a link');
  t = t.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '');
  t = t.replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2');
  t = t.replace(/[|#*_>~]/g, ' ');
  // Line breaks end sentences, unless the line already ended with punctuation.
  t = t.replace(/([.!?:])?[ \t]*\n+\s*/g, (_m, p?: string) => (p ? `${p === ':' ? '.' : p} ` : '. '));
  t = t.replace(/\s+/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
  // Sentence ends need whitespace after them, so "8.8.8.8" / "dns.google" stay whole.
  const sentences = t.match(/.+?[.!?]+(?=\s|$)|.+$/g) ?? [t];
  let out = sentences
    .map((s) => s.trim())
    .filter((s) => s && !/^[.!?]+$/.test(s))
    .slice(0, maxSentences)
    .join(' ');
  if (out.length > maxChars) out = out.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
  return out;
}

/**
 * V2 echo guard: how much of `heard` is made of the words Cadabra just said
 * (0..1). A follow-up that mostly repeats the last spoken reply is our own
 * voice picked up by the mic, not the user.
 */
export function echoSimilarity(heard: string, spoken: string): number {
  const toks = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const h = toks(heard);
  if (!h.length) return 0;
  const said = new Set(toks(spoken));
  if (!said.size) return 0;
  return h.filter((w) => said.has(w)).length / h.length;
}

const DIGIT_WORDS: Record<string, string> = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

/**
 * ASR writes what it hears: "eight point eight point eight point eight",
 * "ns look up". Turn spoken digits/dots into their written form so checks
 * like "is this host in the user's own words?" see the same thing the user
 * meant ("8.8.8.8", "nslookup").
 */
export function normalizeSpoken(text: string): string {
  let t = text.toLowerCase();
  t = t.replace(/\b(?:ns|ets|n s|en es)\s*look\s*up\b/g, 'nslookup');
  // digit words -> digits, then "8 point 8" / "8 dot 8" -> "8.8"
  t = t.replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => DIGIT_WORDS[w]);
  for (let i = 0; i < 4; i++) t = t.replace(/(\d)\s+(?:point|dot)\s+(\d)/g, '$1.$2');
  // "1 9 2" spoken digit by digit inside an address -> "192"
  t = t.replace(/\b(\d)(?:\s(\d))+\b/g, (m) => (/\./.test(m) ? m : m.replace(/\s/g, '')));
  return t;
}

const echoTokens = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);

/**
 * REVIEW-2 #9 echo guard: is `heard` a contiguous piece (or the tail) of what
 * Cadabra said? Allows one ASR slip per 5 words. Shared vocabulary in a
 * different order is NOT an echo ("can you help me with it" vs "anything I
 * can help you with").
 */
export function isEchoOf(heard: string, spoken: string): boolean {
  const h = echoTokens(heard);
  const s = echoTokens(spoken);
  if (!h.length || !s.length) return false;
  const slips = Math.floor(h.length / 5);
  for (let i = 0; i + h.length <= s.length + slips; i++) {
    let miss = 0;
    for (let j = 0; j < h.length; j++) if (s[i + j] !== h[j]) miss++;
    if (miss <= slips) return true;
  }
  return false;
}

/** A long first sentence → [clause, rest] at a natural boundary (or null). */
export function splitFirstClause(s: string): string[] | null {
  if (s.length <= 70) return null;
  const re = /(,|;| —| –| -) /g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const at = m.index + m[1].length;
    if (at >= 25 && at <= 70 && s.length - at >= 20) return [s.slice(0, at).trim(), s.slice(at).trim()];
  }
  return null;
}

/**
 * Round 5: speak while the reply streams in. Text deltas go in; complete
 * spoken sentences come out as soon as they are stable (a sentence end
 * followed by whitespace, not inside an open code fence). Very short sentences
 * ("Sure.") ride with the next one so speech never comes out in fragments. At
 * most `maxSentences` / `maxChars` are spoken; the rest is in the panel.
 */
export class SentenceStreamer {
  private raw = '';
  private emitted = 0;
  private spokenChars = 0;
  private held = '';
  done = false;

  constructor(
    private readonly maxSentences = 3,
    private readonly maxChars = 420,
  ) {}

  private sentencesOf(text: string): string[] {
    const t = toSpeech(text, 99, 100_000);
    return (t.match(/.+?[.!?]+(?=\s|$)|.+$/g) ?? []).map((s) => s.trim()).filter((s) => s && !/^[.!?…]+$/.test(s));
  }

  private take(list: string[], final: boolean): string[] {
    const out: string[] = [];
    for (const s of list) {
      if (this.done) break;
      const cand = this.held ? `${this.held} ${s}` : s;
      // Only a short OPENING sentence waits for company ("Sure." + what follows).
      if (cand.length < 20 && !final && this.emittedOut === 0 && out.length === 0) {
        this.held = cand;
        continue;
      }
      this.held = '';
      // A long FIRST sentence starts sooner if split at a clause boundary
      // (comma / dash / semicolon): the voice pauses there naturally anyway.
      const first = this.emittedOut === 0 && out.length === 0 ? splitFirstClause(cand) : null;
      if (first) out.push(...first);
      else out.push(cand);
      this.spokenChars += cand.length;
      if (++this.sentCount >= this.maxSentences || this.spokenChars >= this.maxChars) this.done = true;
    }
    if (final && this.held && !this.done) {
      out.push(this.held);
      this.held = '';
    }
    this.emittedOut += out.length;
    return out;
  }

  private emittedOut = 0;
  private sentCount = 0;

  /** Feed a text delta; returns sentences ready to speak now. */
  push(delta: string): string[] {
    if (this.done) return [];
    this.raw += delta;
    // Stable prefix: up to the last sentence end followed by whitespace.
    let cut = -1;
    const re = /[.!?]["')\]]?\s/g;
    for (let m = re.exec(this.raw); m; m = re.exec(this.raw)) cut = m.index + m[0].length;
    if (cut < 0) return [];
    let prefix = this.raw.slice(0, cut);
    // Inside an unfinished code block: speak only what came before it.
    const fences = prefix.match(/```/g)?.length ?? 0;
    if (fences % 2 === 1) prefix = prefix.slice(0, prefix.lastIndexOf('```'));
    const all = this.sentencesOf(prefix);
    const fresh = all.slice(this.emitted);
    this.emitted = all.length;
    return this.take(fresh, false);
  }

  /** The reply is complete: the remaining sentences. */
  flush(): string[] {
    if (this.done) return [];
    const all = this.sentencesOf(this.raw);
    const fresh = all.slice(this.emitted);
    this.emitted = all.length;
    return this.take(fresh, true);
  }
}
