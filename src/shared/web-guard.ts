// Round 7: the AI may search and read the web (read-only). Web results are
// untrusted data, and the web is also a way OUT: a prompt-injected model could
// put something private it read on the screen into a search query or a URL.
// This guard runs before every web search / fetch the backend makes (Claude via
// a permission callback or an HTTP hook, Gemini via ACP permission requests).
//
// Round 8 (REVIEW-7 W7-1): a fetch is the dangerous one — it goes to ANY host,
// and Claude Code fetches from this PC. So:
//  - private / loopback / link-local / .local hosts, IP literals (any notation)
//    and non-default ports are refused (no LAN / localhost access);
//  - a page is fetched without asking only if the user said that address, or
//    this turn's web search returned it; anything else gets a card showing the
//    exact address (paraphrased or encoded screen text can't be detected
//    reliably, so we don't try to: we ask).
// Pure; unit-tested.
import { cameFromScreen } from './fence';
import { urlNamedByUser } from './domains';
import { isSecretLike, payloadInUtterance } from './safety';

export type WebTool = 'search' | 'fetch';

export interface WebCheck {
  tool: WebTool;
  /** The search query, or the URL to fetch. */
  text: string;
  /** Text Cadabra read off the screen this request. */
  screen: readonly string[];
  /** The user's own words this turn. */
  prompt?: string;
  enabled: boolean;
  /** URLs this turn's web search returned (fetching them needs no card). */
  searchUrls?: readonly string[];
  /** The fetch host's resolved IP addresses, when known. */
  resolved?: readonly string[];
  /** R8-3: the DNS lookup failed or timed out (fails closed: a card, never silent). */
  resolveFailed?: boolean;
  /** The run was stopped (Esc / "stop"). */
  stopped?: boolean;
}

export interface WebVerdict {
  decision: 'allow' | 'deny' | 'confirm';
  reason?: string;
  /** For logs: the domain only (never the query). */
  domain?: string;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** Is this IPv4 / IPv6 address private, loopback, link-local or otherwise not public? */
export function isPrivateIp(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const m4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v.replace(/^::(ffff:)?/, ''));
  if (m4) {
    const [a, b, c] = [Number(m4[1]), Number(m4[2]), Number(m4[3])];
    // RFC 6890 special-purpose IPv4 ranges (round 9, REVIEW-8 R8-3).
    return (
      a === 0 || // this network
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
      (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      (a === 198 && b === 51 && c === 100) || // TEST-NET-2
      (a === 203 && b === 0 && c === 113) || // TEST-NET-3
      a >= 224 // multicast, reserved, broadcast
    );
  }
  if (v.includes(':')) {
    return (
      v === '::' ||
      v === '::1' ||
      /^f[cd]/.test(v) || // unique local
      /^fe[89ab]/.test(v) || // link-local
      /^fe[c-f]/.test(v) || // site-local (deprecated)
      /^ff/.test(v) || // multicast
      v.startsWith('::ffff:') || // IPv4-mapped
      /^::[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v) || // IPv4-compatible (hex form)
      /^64:ff9b:(0{0,4}:){0,5}/.test(v) || // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
      /^100:(0{0,4}:){0,3}/.test(v) || // discard 100::/64
      /^2001:(0{0,3}[0-9a-f]?|1[0-9a-f]{0,2}):/.test(v) || // 2001::/23 IETF special (Teredo, ORCHID…)
      /^2001:0?db8:/.test(v) || // documentation
      /^2002:/.test(v) || // 6to4 (embeds an IPv4 address)
      /^3fff:/.test(v) || // documentation 3fff::/20
      /^5f00:/.test(v) // SRv6 SIDs
    );
  }
  return false;
}

/** Why a URL's host must never be fetched (or '' when it's an ordinary public web address). */
export function hostProblem(url: string, resolved: readonly string[] = []): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return 'That isn’t a valid web address.';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Only http(s) web pages can be read.';
  if (u.username || u.password) return 'Web addresses with a user name or password aren’t allowed.';
  if (u.port && !((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80'))) return 'Web addresses with a special port aren’t allowed.';
  // The WHATWG URL parser already turns 2130706433 / 0x7f.1 / 0177.0.0.1 into 127.0.0.1.
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[') || host.includes(':')) return isPrivateIp(host) ? 'That address is on this PC or your local network.' : 'Web addresses that are bare IP numbers aren’t allowed.';
  if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.') || /\.(local|lan|internal|intranet|home|corp|localdomain|home\.arpa|test|invalid|example)$/.test(host)) return 'That address is on this PC or your local network.';
  if (resolved.some(isPrivateIp)) return 'That address points to this PC or your local network.';
  return '';
}

/** Same page? (scheme + host + path, ignoring a trailing slash and the fragment.) */
function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const norm = (u: URL) => `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    return norm(x) === norm(y);
  } catch {
    return false;
  }
}

export function checkWeb(c: WebCheck): WebVerdict {
  const domain = c.tool === 'fetch' ? domainOf(c.text) : undefined;
  if (c.stopped) return { decision: 'deny', reason: 'The request was stopped.', domain };
  if (!c.enabled) return { decision: 'deny', reason: 'Web access is off (Settings → Web access).', domain };
  const text = decode(c.text);
  let hayCache: string | null = null;
  const hay = () => (hayCache ??= c.screen.join(' ').toLowerCase());
  // 1. Anything secret-looking (a one-time code, card number, IBAN, API key)
  //    that is on the screen and that the user didn't say never goes to the web.
  //    (A year or a score is fine: the live run found "2026" being refused.)
  const tokens = text.split(/[\s/?&=#:;,|()[\]{}"'<>]+/).filter(Boolean);
  const secret = tokens.find((t) => isSecretLike(t) && !payloadInUtterance(t, c.prompt, false) && (hay().includes(t.toLowerCase()) || !/^\d{4}$/.test(t)));
  if (secret) return { decision: 'deny', reason: 'This would send something that looks private (a code, card number or key) to the web.', domain };

  if (c.tool === 'fetch') {
    const problem = hostProblem(c.text, c.resolved);
    if (problem) return { decision: 'deny', reason: problem, domain };
    // R8-2: the exact registrable domain the user said (no substrings), and no
    // path / query words they didn't say (screen or email text can't ride along).
    const fromUser = !!c.prompt && urlNamedByUser(c.text.trim(), c.prompt);
    const fromSearch = (c.searchUrls ?? []).some((u) => samePage(u, c.text));
    if (c.resolveFailed) return { decision: 'confirm', reason: 'Cadabra couldn’t check where this address points.', domain };
    if (fromUser || fromSearch) return { decision: 'allow', domain };
    return { decision: 'confirm', reason: 'Cadabra wants to open a web address that didn’t come from you or from this search.', domain };
  }

  // Searches go to the search provider (not an arbitrary host). Text copied
  // from the screen that the user didn't say needs their OK.
  const fromScreen = c.screen.length > 0 && !payloadInUtterance(text, c.prompt, true) && (cameFromScreen(text, c.screen) || tokens.some((t) => t.length >= 10 && /\d/.test(t) && !payloadInUtterance(t, c.prompt, false) && hay().includes(t.toLowerCase())));
  if (fromScreen) return { decision: 'confirm', reason: 'This web search includes text from your screen.', domain };
  return { decision: 'allow', domain };
}
