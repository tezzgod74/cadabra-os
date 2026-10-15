// Round 10 (hands-on bug): "Open up tv.youtube.com" opened "uptv.youtube.com".
// Speech-to-text writes web addresses its own way: it may glue the particle
// before a host onto it ("open uptv.youtube.com"), spell it out ("tv dot
// youtube dot com", "w w w", "h t t p s"), or run the verb together
// ("openup"). This module turns a spoken "open <address>" into an ordered list
// of candidate URLs; the app then keeps the first one whose registrable domain
// is real (public-suffix list) and whose host resolves, and asks "Did you mean
// …?" when it can't tell. Pure; unit-tested.
import { parse } from 'tldts';
import { KNOWN_SITES } from './domains';

/** Launch phrasing in front of the target, including STT run-togethers ("openup"). */
const LAUNCH =
  /^(?:(?:please|can you|could you|would you|will you|hey|ok|okay)\s+)*(?:open\s*up|open|pull\s*up|bring\s*up|go\s+to|goto|navigate\s+to|take\s+me\s+to|show\s+me|launch|visit|load(?:\s+up)?|browse\s+to|head\s+to|jump\s+to|get\s+me\s+to|start)\b\s*/i;

/** Words that can only be leftovers of the launch phrase when glued to a host ("up" in "uptv"). */
const PARTICLES = ['up', 'to', 'me', 'the', 'open', 'on'];
/** Only these get glued onto the next word by STT in practice ("open up tv…" → "uptv…", "go to tv…" → "totv…"). */
const GLUE = ['up', 'to'];

export interface SpokenTarget {
  /** What to open, launch phrasing removed. */
  target: string;
  /** "in chrome" / "on edge" (raw word), if said. */
  browser?: string;
}

/** Remove the wake word, politeness, launch verbs and trailing "in Chrome / for me / please". */
export function stripLaunchPhrase(text: string, wakeWord = 'cadabra'): SpokenTarget | null {
  let t = text
    .trim()
    .replace(/[“”"]/g, '')
    .replace(/[!?]+$/, '')
    .replace(/\.$/, '')
    .trim();
  const wake = wakeWord.toLowerCase().replace(/[^a-z]/g, '');
  t = t.replace(new RegExp(`^(?:hey\\s+|ok\\s+|okay\\s+)?(?:${wake}|c|k)a*\\s*d+[aeiou]*b+[aeiou]*r+[aeiou]*h?[\\s,.!?:;-]*`, 'i'), '').trim();
  t = t.replace(new RegExp(`^${wake}[\\s,.!?:;-]+`, 'i'), '').trim();
  const m = LAUNCH.exec(t);
  if (!m) return null;
  let target = t.slice(m[0].length).trim();
  let browser: string | undefined;
  const b = /\s+(?:in|on|with|using)\s+(?:the\s+)?(google\s+chrome|chrome|microsoft\s+edge|edge|firefox|brave|opera|vivaldi|my\s+default\s+browser|the\s+default\s+browser|default\s+browser)$/i.exec(target);
  if (b) {
    browser = b[1].toLowerCase();
    target = target.slice(0, b.index).trim();
  }
  target = target.replace(/\s+(?:for me|please|now|real quick)$/i, '').trim();
  return target ? { target, browser } : null;
}

const NUM: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

/**
 * Spoken address → written form, WITHOUT gluing ordinary words onto a host:
 * only tokens joined by "dot" / "." / "slash" become one address.
 * "up tv dot youtube dot com" → "up tv.youtube.com"; "w w w dot espn dot com" → "www.espn.com".
 */
export function normalizeSpokenUrl(s: string): string {
  let t = ` ${s.toLowerCase()} `
    .replace(/\bh\s*t\s*t\s*p\s*s\b\s*(?:colon\s*|:\s*)?(?:slash\s*slash|\/\/)?/g, ' https:// ')
    .replace(/\bh\s*t\s*t\s*p\b\s*(?:colon\s*|:\s*)?(?:slash\s*slash|\/\/)?/g, ' http:// ')
    .replace(/\bw\s+w\s+w\b/g, 'www')
    .replace(/\btriple\s+w\b/g, 'www')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s+(?:forward\s+)?slash\s*/g, '/')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+(?:dash|hyphen)\s+/g, '-')
    .replace(/:\/\/\s+/g, '://')
    .replace(/\s+/g, ' ')
    .trim();
  // "https:// www.x.com" → "https://www.x.com"
  t = t.replace(/(https?:\/\/)\s+/g, '$1');
  // Spelled digits inside a host label ("channel four") are left alone; single digits after a dot join.
  t = t.replace(/\.(zero|one|two|three|four|five|six|seven|eight|nine)\b/g, (_, w: string) => `.${NUM[w]}`);
  return t.replace(/\.$/, '');
}

/** The address-looking token in a normalized target (the LAST one that has a dot). */
function addressToken(t: string): { before: string[]; token: string } | null {
  const parts = t.split(' ');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/\S*)?$/.test(parts[i])) return { before: parts.slice(0, i), token: parts[i] };
  }
  return null;
}

/** REVIEW-10 #3: how long a "Did you mean …?" waits for yes / no. */
export const PENDING_URL_MS = 20_000;

/** Common file extensions (some, like .zip / .mov / .app, are also real TLDs). */
const FILE_EXT = /\.(md|markdown|txt|rtf|log|ini|cfg|conf|json|yaml|yml|toml|xml|csv|tsv|py|rs|ts|tsx|js|jsx|mjs|cjs|java|kt|c|h|cpp|hpp|cs|go|rb|php|swift|sh|ps1|bat|cmd|exe|msi|dll|zip|rar|7z|tar|gz|tgz|iso|mov|mp4|mkv|avi|wmv|webm|mp3|wav|flac|m4a|ogg|png|jpe?g|gif|bmp|webp|svg|ico|heic|pdf|docx?|xlsx?|pptx?|odt|ods|odp|epub|psd|sln|csproj|lock)$/i;

/** "readme.md", "setup.py", "notes.zip" — a file name rather than a web address. */
export function looksLikeFileName(token: string): boolean {
  return FILE_EXT.test(token.replace(/^https?:\/\//, '').split('/')[0]);
}

/** A real public suffix + registrable domain (tldts, ICANN section). */
export function realDomain(host: string): boolean {
  const r = parse(host);
  return !!(r.domain && r.isIcann && r.publicSuffix && !r.isIp);
}

function toUrl(token: string): string | null {
  const withScheme = /^https?:\/\//.test(token) ? token.replace(/^http:/, 'https:') : `https://${token}`;
  try {
    const u = new URL(withScheme);
    return realDomain(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

export interface UrlCandidates {
  /** Best first. */
  urls: string[];
  /** The first label may carry a glued launch particle ("uptv.youtube.com"). */
  suspectGlue: boolean;
  browser?: string;
}

/**
 * Spoken "open …" → candidate https URLs, or null when it isn't a web
 * address (an app name, a file menu…). Known site names ("my gmail") map
 * to their address only when `knownSites` is true (the caller decides,
 * after checking that no installed app matches).
 */
export function spokenUrlCandidates(text: string, o: { wakeWord?: string; knownSites?: boolean } = {}): UrlCandidates | null {
  const st = stripLaunchPhrase(text, o.wakeWord);
  if (!st) return null;
  const norm = normalizeSpokenUrl(st.target);
  const at = addressToken(norm);
  if (!at) {
    if (!o.knownSites) return null;
    const name = norm.replace(/^(?:my|the|our)\s+/, '').trim();
    const hosts = KNOWN_SITES[name];
    if (!hosts) return null;
    return { urls: [`https://${hosts[0].includes('.') && hosts[0].split('.').length === 2 ? `www.${hosts[0]}` : hosts[0]}/`], suspectGlue: false, browser: st.browser };
  }
  // Anything left before the address other than glue particles means this isn't "open <address>".
  if (at.before.some((w) => !PARTICLES.includes(w) && !/^(?:the|website|site|page|web)$/.test(w))) return null;
  // REVIEW-10 #1: "readme.md", "notes.zip", "clip.mov" are files (.zip / .mov are also
  // real TLDs) unless the user clearly means a site: a scheme, www., a path, or
  // the words "website" / "site". Round 10.6: "readme dot md" is a file too.
  if (looksLikeFileName(at.token) && !/^https?:\/\//.test(at.token) && !/^www\./.test(at.token) && !at.token.includes('/') && !at.before.some((w) => /^(website|site|web|page)$/.test(w)) && !/\b(website|site)$/i.test(st.target)) return null;
  const urls: string[] = [];
  const add = (tok: string) => {
    const u = toUrl(tok);
    if (u && !urls.includes(u)) urls.push(u);
  };
  const scheme = /^https?:\/\//.exec(at.token)?.[0] ?? '';
  const rest = at.token.slice(scheme.length);
  // A particle glued onto the first label ("uptv.youtube.com" → "tv.youtube.com").
  const glued = GLUE.find((p) => rest.startsWith(p) && rest.length > p.length + 1 && /^[a-z0-9]/.test(rest.slice(p.length)) && rest.slice(p.length).split('.').length >= 3);
  add(at.token);
  if (glued) add(scheme + rest.slice(glued.length));
  // A leading label that is itself only a particle ("up.tv.youtube.com").
  const labels = rest.split('/')[0].split('.');
  if (labels.length >= 3 && PARTICLES.includes(labels[0])) add(scheme + rest.slice(labels[0].length + 1));
  if (!urls.length) return null;
  return { urls, suspectGlue: !!glued || (labels.length >= 3 && PARTICLES.includes(labels[0])), browser: st.browser };
}

/**
 * Pick the URL to open: the first candidate whose host resolves. If the
 * as-heard parse might carry a glued particle and BOTH it and the cleaned-up
 * version resolve, ask instead of guessing.
 */
export async function chooseUrl(c: UrlCandidates, resolves: (host: string) => Promise<boolean>): Promise<{ open: string } | { ask: string } | { none: string }> {
  const ok: string[] = [];
  for (const u of c.urls) if (await resolves(new URL(u).hostname).catch(() => false)) ok.push(u);
  if (!ok.length) return { none: c.urls[c.urls.length - 1] };
  if (c.suspectGlue && c.urls.length > 1 && ok.includes(c.urls[0]) && ok.length > 1) return { ask: ok[1] };
  if (c.suspectGlue && ok[0] !== c.urls[0]) return { open: ok[0] }; // the glued form doesn't exist; the clean one does
  return { open: ok[0] };
}

/** "https://tv.youtube.com/" → "tv.youtube.com" (for the panel and speech). */
export function displayUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname}${x.pathname === '/' ? '' : x.pathname}${x.search}`;
  } catch {
    return u;
  }
}
