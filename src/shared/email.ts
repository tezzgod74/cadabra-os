// Round 8: read-only email (Gmail) — the pure, testable parts: date windows,
// Gmail query building, fuzzy sender matching ("from SB"), cleaning untrusted
// email text, and the <untrusted_email> fence. research.md §10.3 / §10.6.
// Nothing here logs anything (subjects, bodies, addresses never hit the log).

export interface EmailSummary {
  /** Gmail message id (hex; the same id works in the API, IMAP X-GM-MSGID and the web link). */
  id: string;
  /** Display name ('' when the sender has none). */
  fromName: string;
  fromAddress: string;
  subject: string;
  /** ISO date. */
  date: string;
  /** ~200-char preview, cleaned. */
  snippet: string;
  unread: boolean;
}

export interface EmailMessage extends EmailSummary {
  /** Cleaned plain text, capped. */
  text: string;
  /** Attachment file names only (never contents). */
  attachments: string[];
}

export type EmailSince = 'today' | 'yesterday' | '24h' | 'week' | 'any';

export interface EmailQuery {
  /** Who it's from, as the user said it ("Sam", "SB", "amazon"). */
  from?: string;
  /** Free words (subject / content), e.g. "invoice". */
  query?: string;
  since?: EmailSince | string;
  unread?: boolean;
}

export const MAX_RESULTS = 10;
export const BODY_CAP = 8000;

/** Unix seconds of local midnight (today, or `daysBack` days ago). */
export function localMidnightEpoch(now: Date, daysBack = 0): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, 0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** The window start (unix seconds) for a `since` value, or null for "any time". */
export function sinceEpoch(since: string | undefined, now: Date): number | null {
  const s = (since ?? 'any').trim().toLowerCase();
  if (s === 'today') return localMidnightEpoch(now);
  if (s === 'yesterday') return localMidnightEpoch(now, 1);
  if (s === '24h') return Math.floor(now.getTime() / 1000) - 86_400;
  if (s === 'week') return localMidnightEpoch(now, 7);
  if (s === 'any' || !s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/** Strip characters that could break out of a Gmail query term. */
function term(x: string): string {
  return x
    .replace(/["(){}\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Gmail search syntax (works for the API's `q` and IMAP X-GM-RAW). Dates use
 * epoch seconds: Gmail reads `after:2026/10/14` as midnight PACIFIC time.
 */
export function buildGmailQuery(q: EmailQuery, now: Date): string {
  const parts: string[] = [];
  if (q.from && term(q.from)) parts.push(`from:(${term(q.from)})`);
  if (q.query && term(q.query)) parts.push(`(${term(q.query)})`);
  const after = sinceEpoch(q.since, now);
  if (after != null) parts.push(`after:${after}`);
  if (q.unread) parts.push('is:unread');
  return parts.join(' ');
}

/** The "everything in the window" fallback used for fuzzy sender matching. */
export function fallbackQuery(q: EmailQuery, now: Date): string {
  return buildGmailQuery({ ...q, from: undefined }, now) || 'in:inbox';
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/[^a-z0-9@. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Does this sender match what the user said? Matches whole names ("Dana"),
 * initials ("SB" ⇢ "Samuel Brooks" / "S.B. Smith" / "sb@…" / "sbennett@…")
 * and the address local part.
 */
export function senderMatches(who: string, fromName: string, fromAddress: string): boolean {
  const w = norm(who).replace(/\./g, '');
  if (!w) return false;
  const name = norm(fromName).replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  const local = norm(fromAddress.split('@')[0] ?? '').replace(/[._-]/g, ' ');
  const domain = norm(fromAddress.split('@')[1] ?? '');
  const words = name.split(' ').filter(Boolean);
  const wWords = w.split(' ').filter(Boolean);
  // Every word the user said appears as a word in the name or address.
  if (wWords.every((x) => words.includes(x) || local.split(' ').includes(x))) return true;
  // Company / domain ("amazon").
  if (wWords.length === 1 && domain.split('.').includes(w)) return true;
  // Initials: "sb" ⇢ first letters of the name's words, or "S B" / "S.B." written out.
  if (/^[a-z]{2,3}$/.test(w)) {
    const initials = words.map((x) => x[0]).join('');
    if (initials === w || initials.startsWith(w)) return true;
    if (words.slice(0, w.length).join('') === w) return true; // "S B Smith", "S.B. Smith"
    if (words.length && words[0] === w) return true; // "SB Smith"
    // Address local part: "sb@…", "sb.smith@…", "sbennett@…" (initial + surname).
    const loc = (fromAddress.split('@')[0] ?? '').toLowerCase();
    if (loc === w || loc.split(/[._-]/)[0] === w || (/^[a-z]+$/.test(loc) && loc.startsWith(w) && loc.length >= w.length + 3)) return true;
  }
  // A first-name prefix ("Sam" for "Samuel").
  if (wWords.length === 1 && w.length >= 3 && words.some((x) => x.startsWith(w))) return true;
  return false;
}

/** Distinct senders (by address) among matches: >1 means "SB Smith or SB Lee?". */
export function distinctSenders(ms: EmailSummary[]): { name: string; address: string }[] {
  const seen = new Map<string, { name: string; address: string }>();
  for (const m of ms) if (!seen.has(m.fromAddress.toLowerCase())) seen.set(m.fromAddress.toLowerCase(), { name: m.fromName || m.fromAddress, address: m.fromAddress });
  return [...seen.values()];
}

const ZERO_WIDTH = /[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\u00AD]/g;

/** HTML → plain text, dropping hidden elements, styles, scripts, comments and link targets. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title|template|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<([a-z0-9]+)\b[^>]*\b(hidden|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0|max-height\s*:\s*0|width\s*:\s*0|height\s*:\s*0)[^"']*["'])[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return c > 31 && c < 0x10ffff ? String.fromCodePoint(c) : ' ';
    });
}

/**
 * Clean untrusted email text for the AI: no links (Cadabra never opens links
 * from email), no zero-width / hidden characters, collapsed whitespace,
 * capped. `[link]` marks where a link was.
 */
export function cleanEmailText(text: string, cap = BODY_CAP): string {
  let t = text
    .replace(ZERO_WIDTH, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\[([^\]\n]{0,200})\]\((?:https?|mailto):[^)\s]*\)/gi, '$1') // markdown links → their text
    .replace(/<?\b(?:https?:\/\/|www\.)[^\s<>"')\]]+>?/gi, '[link]')
    .replace(/\bmailto:[^\s<>"')]+/gi, '[link]')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length > cap) t = `${t.slice(0, cap)}\n… (truncated)`;
  return t;
}

/** A field value for the fence header: quotes and angle brackets neutralised. */
const attr = (s: string) => cleanEmailText(s, 200).replace(/\[link\]/g, '').replace(/["<>\n]/g, ' ').trim();

/**
 * Email text as DATA for the model. The tag carries the per-request nonce, and
 * anything inside that looks like the closing tag is defused.
 */
export function fenceEmail(m: Pick<EmailSummary, 'fromName' | 'fromAddress' | 'subject' | 'date'> & { body: string }, nonce: string): string {
  const tag = `untrusted_email-${nonce}`;
  const body = m.body.replace(/<\/?\s*untrusted_email[^>]*>/gi, '[tag removed]');
  return `<${tag} from="${attr(m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress)}" subject="${attr(m.subject)}" date="${attr(m.date)}">\n${body}\n</${tag}>`;
}

/** Spoken-friendly time ("9:14 AM") for a result. */
export function shortTime(iso: string, now: Date): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return sameDay ? t : `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ${t}`;
}

/** The Gmail web link for one message (opens it in the signed-in browser). */
export function gmailLink(id: string, address: string): string {
  const safeId = /^[0-9a-f]{6,24}$/i.test(id) ? id : '';
  const who = address && /^[^\s@<>"]+@[^\s@<>"]+$/.test(address) ? `?authuser=${encodeURIComponent(address)}` : '';
  return `https://mail.google.com/mail/${who}#all/${safeId}`;
}

/** Personal Gmail address (app passwords don't work for Workspace accounts since May 2025). */
export function isPersonalGmail(address: string): boolean {
  return /^[^\s@]+@(gmail|googlemail)\.com$/i.test(address.trim());
}
