// Round 8: open_url — open a web page in the user's browser (the default one,
// or a named one: "open it in Chrome"). https only, never a LAN / localhost
// address. A page the user didn't ask for by name (an address that came from
// the screen, a web page or an email) needs their OK on a card first.
import { execFile, spawn } from 'node:child_process';
import { cameFromScreen } from '../shared/fence';
import { hostProblem } from '../shared/web-guard';
import { hostNamedByUser, registrableDomain, urlNamedByUser } from '../shared/domains';
import { looksLikeFileName } from '../shared/spoken-url';

export type BrowserName = 'chrome' | 'edge' | 'firefox' | 'brave' | 'opera' | 'vivaldi';

const EXE: Record<BrowserName, string> = {
  chrome: 'chrome.exe',
  edge: 'msedge.exe',
  firefox: 'firefox.exe',
  brave: 'brave.exe',
  opera: 'opera.exe',
  vivaldi: 'vivaldi.exe',
};

/** "Chrome", "google chrome", "Microsoft Edge" → a known browser (or null = default). */
export function browserName(s: string | undefined): BrowserName | null {
  const t = (s ?? '').toLowerCase();
  if (!t || /default/.test(t)) return null;
  if (/chrome/.test(t)) return 'chrome';
  if (/edge/.test(t)) return 'edge';
  if (/firefox|mozilla/.test(t)) return 'firefox';
  if (/brave/.test(t)) return 'brave';
  if (/opera/.test(t)) return 'opera';
  if (/vivaldi/.test(t)) return 'vivaldi';
  return null;
}

export interface OpenUrlCheck {
  url: string;
  /** The user's own words this turn. */
  prompt?: string;
  /** Screen text read this turn. */
  screen?: readonly string[];
  /** URLs from this turn's web searches. */
  webUrls?: readonly string[];
  /** An email's content entered this turn. */
  emailTainted?: boolean;
}

/**
 * allow: the user named this site; confirm: it came from somewhere else
 * (screen / web / email) or the user's words don't name it; deny: not https,
 * or a local / private address.
 */
function safeDecode(x: string): string {
  try {
    return decodeURIComponent(x);
  } catch {
    return x;
  }
}

export function checkOpenUrl(c: OpenUrlCheck): { decision: 'allow' | 'confirm' | 'deny'; reason: string; url: string } {
  let u: URL;
  try {
    u = new URL(c.url.trim());
  } catch {
    return { decision: 'deny', reason: 'That isn’t a valid web address.', url: c.url };
  }
  if (u.protocol !== 'https:') return { decision: 'deny', reason: 'Only https:// web addresses can be opened.', url: c.url };
  const problem = hostProblem(u.href);
  if (problem) return { decision: 'deny', reason: problem, url: u.href };
  if (c.emailTainted) return { decision: 'confirm', reason: 'An email was read in this request, and links from email are never opened without asking.', url: u.href };
  // REVIEW-10 #1: "notes.zip" / "clip.mov" are probably files, not websites (.zip / .mov are TLDs too).
  if (looksLikeFileName(u.hostname) && !/\b(website|site|www|https?|dot)\b/i.test(c.prompt ?? '')) return { decision: 'confirm', reason: `${u.hostname} looks like a file name. Open it as a website?`, url: u.href };
  const host = u.hostname.toLowerCase();
  const prompt = (c.prompt ?? '').toLowerCase();
  // Round 11.7 (risky tier): only genuinely risky addresses ask —
  // an address or host that came from the screen and the user didn't name…
  const fromScreen = cameFromScreen(u.href, c.screen ?? []) || (c.screen ?? []).some((x) => x.toLowerCase().includes(host));
  if (fromScreen && !prompt.includes(host.replace(/^www\./, ''))) return { decision: 'confirm', reason: 'This address came from your screen.', url: u.href };
  // …or one carrying text read off the screen (in the path or query) that the user didn't say.
  const carried = safeDecode(`${u.pathname} ${u.search}`.replace(/\+/g, ' '))
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !prompt.includes(w));
  const hay = (c.screen ?? []).join(' ').toLowerCase();
  if (hay && carried.some((w) => hay.includes(w))) return { decision: 'confirm', reason: 'This address carries text from your screen.', url: u.href };
  // R8-1: the site the user named (exact registrable domain or a well-known name) opens.
  if (urlNamedByUser(u.href, c.prompt) || hostNamedByUser(host, c.prompt)) return { decision: 'allow', reason: '', url: u.href };
  // The site's own name said as a word ("cvs.com" for "the CVS website"): google.evil.com
  // (registrable evil.com) doesn't qualify.
  const sld = registrableDomain(host).split('.')[0];
  if (sld && sld.length >= 2 && new RegExp(`\\b${sld.replace(/[^a-z0-9-]/g, '')}\\b`).test(prompt)) return { decision: 'allow', reason: '', url: u.href };
  const fromWeb = (c.webUrls ?? []).some((w) => w.replace(/\/$/, '') === u.href.replace(/\/$/, ''));
  return { decision: 'confirm', reason: fromWeb ? 'This address came from a web search, on a site you didn’t name.' : 'You didn’t name this site.', url: u.href };
}

/** Where a browser is installed, from App Paths (HKCU, then HKLM). */
export function browserPath(name: BrowserName): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const key = (root: string) => `${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${EXE[name]}`;
  const q = (root: string) =>
    new Promise<string | null>((res) =>
      execFile('reg', ['query', key(root), '/ve'], { windowsHide: true, timeout: 3000 }, (err, out) => {
        if (err) return res(null);
        const m = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(String(out));
        res(m ? m[1].trim().replace(/^"|"$/g, '') : null);
      }),
    );
  return q('HKCU').then((p) => p ?? q('HKLM'));
}

/** Open `url` in the named browser (or the default one through `openDefault`). */
export async function openInBrowser(url: string, browser: BrowserName | null, openDefault: (url: string) => Promise<void>): Promise<string> {
  if (browser) {
    const exe = await browserPath(browser);
    if (exe) {
      const p = spawn(exe, [url], { detached: true, stdio: 'ignore', windowsHide: false });
      p.on('error', () => undefined);
      p.unref();
      return `Opened in ${browser[0].toUpperCase()}${browser.slice(1)}.`;
    }
    await openDefault(url);
    return `${browser[0].toUpperCase()}${browser.slice(1)} isn’t installed, so I opened it in your default browser.`;
  }
  await openDefault(url);
  return 'Opened in your browser.';
}
