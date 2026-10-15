// Round 9 (REVIEW-8 R8-1 / R8-2): "did the USER name this site?" — by the
// registrable domain (eTLD+1, from the public-suffix list via tldts), never by
// substring. "open google" must not open google.evil.com; "open netflix.com"
// must not fetch lix.com; anything in the path or query that the user didn't
// say (screen text, email text…) means the user didn't name THIS address.
// Pure; unit-tested.
import { getDomain, parse } from 'tldts';

/** eTLD+1 of a host or URL ("news.bbc.co.uk" → "bbc.co.uk"); '' when there is none (IPs, single labels). */
export function registrableDomain(hostOrUrl: string): string {
  let host = hostOrUrl.trim().toLowerCase();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname;
  } catch {
    return '';
  }
  host = host.replace(/\.$/, '');
  const d = getDomain(host, { allowPrivateDomains: true });
  return d ?? '';
}

/**
 * Well-known sites by the name people say. A value with a subdomain
 * ("mail.google.com") matches only that exact host; a bare registrable
 * domain ("youtube.com") matches it and its own subdomains.
 */
export const KNOWN_SITES: Record<string, string[]> = {
  google: ['google.com'],
  gmail: ['mail.google.com'],
  'google maps': ['maps.google.com', 'www.google.com'],
  'google drive': ['drive.google.com'],
  'google docs': ['docs.google.com'],
  'google calendar': ['calendar.google.com'],
  youtube: ['youtube.com'],
  'youtube music': ['music.youtube.com'],
  facebook: ['facebook.com'],
  instagram: ['instagram.com'],
  twitter: ['x.com', 'twitter.com'],
  reddit: ['reddit.com'],
  amazon: ['amazon.com'],
  netflix: ['netflix.com'],
  wikipedia: ['wikipedia.org'],
  github: ['github.com'],
  linkedin: ['linkedin.com'],
  outlook: ['outlook.live.com', 'outlook.office.com'],
  bbc: ['bbc.co.uk', 'bbc.com'],
  cnn: ['cnn.com'],
  espn: ['espn.com'],
  'fox news': ['foxnews.com'],
  reuters: ['reuters.com'],
  'new york times': ['nytimes.com'],
  'the guardian': ['theguardian.com'],
  spotify: ['open.spotify.com', 'spotify.com'],
  twitch: ['twitch.tv'],
  tiktok: ['tiktok.com'],
  pinterest: ['pinterest.com'],
  ebay: ['ebay.com'],
  yahoo: ['yahoo.com'],
  bing: ['bing.com'],
  duckduckgo: ['duckduckgo.com'],
  imdb: ['imdb.com'],
  discord: ['discord.com'],
  whatsapp: ['web.whatsapp.com'],
  chatgpt: ['chatgpt.com'],
  claude: ['claude.ai'],
  microsoft: ['microsoft.com'],
  office: ['office.com'],
  apple: ['apple.com'],
  nba: ['nba.com'],
  nfl: ['nfl.com'],
  weather: ['weather.com'],
};

const lc = (s: string | undefined) => (s ?? '').toLowerCase();
const words = (s: string) => lc(s).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Registrable domains the user typed or said ("bbc.co.uk", "netflix dot com"). */
export function domainsInPrompt(prompt: string | undefined): string[] {
  const p = lc(prompt).replace(/\s+dot\s+/g, '.');
  const out = new Set<string>();
  for (const m of p.matchAll(/(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z][a-z0-9-]+)/g)) {
    const r = parse(m[1]);
    if (r.domain && r.isIcann) out.add(r.domain);
  }
  return [...out];
}

/** Hosts / domains the user named by a well-known site name ("open youtube"). */
export function sitesInPrompt(prompt: string | undefined): string[] {
  const w = ` ${words(prompt ?? '').join(' ')} `;
  const out: string[] = [];
  for (const [name, hosts] of Object.entries(KNOWN_SITES)) if (w.includes(` ${name} `)) out.push(...hosts);
  return out;
}

/** Does `host` belong to a site the user named? Exact registrable-domain / host equality only. */
export function hostNamedByUser(host: string, prompt: string | undefined): boolean {
  const h = lc(host).replace(/\.$/, '');
  const reg = registrableDomain(h);
  if (!reg) return false;
  if (domainsInPrompt(prompt).includes(reg)) return true;
  for (const v of sitesInPrompt(prompt)) {
    const isBare = registrableDomain(v) === v;
    if (isBare ? reg === v : h === v || h === `www.${v}`) return true;
  }
  return false;
}

/** Every word of `payload` is a whole word the user said (no substrings). */
export function allWordsSaid(payload: string, prompt: string | undefined): boolean {
  const said = new Set(words(prompt ?? ''));
  return words(payload).every((x) => said.has(x));
}

/**
 * The user named this exact address: its site, and nothing in the path or
 * query that they didn't say themselves (so screen or email text can't ride
 * along in `?q=` or the path).
 */
export function urlNamedByUser(url: string, prompt: string | undefined): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!hostNamedByUser(u.hostname, prompt)) return false;
  let path = u.pathname;
  let query = u.search.slice(1);
  try {
    path = decodeURIComponent(path);
    query = decodeURIComponent(query.replace(/\+/g, ' '));
  } catch {
    return false;
  }
  // Index-like file names don't count as words ("index.html").
  // Short path segments ("/s", "/en", "/us") are routing, not content; longer words must be the user's.
  const pathWords = path.replace(/(^|\/)[\p{L}\p{N}]{1,2}(?=\/|$)/gu, '$1').replace(/\b(index|default)\.(html?|php|aspx?)\b/gi, ' ').replace(/\.(html?|php|aspx?)\b/gi, ' ');
  const queryValues = query
    .split('&')
    .map((kv) => kv.split('=').slice(1).join('='))
    .join(' ');
  return allWordsSaid(pathWords, prompt) && allWordsSaid(queryValues, prompt) && !u.hash.slice(1).trim();
}
