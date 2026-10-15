// Round 8, path A (recommended): the user's OWN Google OAuth Desktop client
// (research.md §10.1). Loopback redirect on 127.0.0.1 + PKCE S256, scope
// gmail.readonly only. The refresh token is stored by the caller with
// safeStorage; nothing here logs tokens, addresses, subjects or bodies.
//
// Round 9 (REVIEW-8 #10): a small fetch-based client for the five endpoints
// Cadabra uses (authorize, token, revoke, users.getProfile, messages.list/get)
// replaces google-auth-library + @googleapis/gmail (~4 MB and ~20 transitive
// packages). Endpoints are injectable so the tests run against a fake Google.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { cleanEmailText, htmlToText, type EmailMessage, type EmailSummary, MAX_RESULTS } from '../../shared/email';
import type { MailBackend } from './types';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export interface GoogleEndpoints {
  oauth2TokenUrl?: string;
  oauth2AuthBaseUrl?: string;
  oauth2RevokeUrl?: string;
  /** Gmail API root (default https://gmail.googleapis.com/). */
  gmailRoot?: string;
}

const GOOGLE: Required<GoogleEndpoints> = {
  oauth2AuthBaseUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  oauth2TokenUrl: 'https://oauth2.googleapis.com/token',
  oauth2RevokeUrl: 'https://oauth2.googleapis.com/revoke',
  gmailRoot: 'https://gmail.googleapis.com/',
};

export interface OAuthClientInfo {
  clientId: string;
  /** Desktop clients' "secret" isn't confidential (installed apps can't keep secrets); optional. */
  clientSecret?: string;
}

const TIMEOUT_MS = 20_000;
/** Concurrent metadata requests per search. */
export const METADATA_PARALLEL = 4;
const b64url = (b: Buffer) => b.toString('base64url');

/** PKCE S256 pair. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

/** A Desktop client id looks like "1234-abc.apps.googleusercontent.com". */
export function looksLikeClientId(s: string): boolean {
  return /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(s.trim());
}

/** Parse the client JSON Google lets you download ({"installed": {client_id, client_secret}}). */
export function parseClientJson(raw: string): OAuthClientInfo | null {
  try {
    const j = JSON.parse(raw);
    const c = j.installed ?? j.web ?? j;
    if (typeof c.client_id === 'string' && looksLikeClientId(c.client_id)) return { clientId: c.client_id, clientSecret: typeof c.client_secret === 'string' ? c.client_secret : undefined };
  } catch {
    /* not JSON */
  }
  return null;
}

/** POST a form to a Google OAuth endpoint; errors carry only Google's error code (never tokens). */
async function postForm(url: string, form: Record<string, string | undefined>): Promise<any> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v) body.set(k, v);
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof j.error === 'string' ? j.error : `HTTP ${res.status}`;
    throw new Error(code === 'invalid_grant' ? 'Google no longer accepts Cadabra’s sign-in (it was removed, expired or the password changed). Connect Gmail again in Settings → Email.' : `Google refused the request (${code}).`);
  }
  return j;
}

/** Access tokens from a refresh token, cached until shortly before they expire. */
export class GoogleAuth {
  private access: { token: string; until: number } | null = null;
  /** R9-5: one refresh in flight at a time; parallel callers share it. */
  private refreshing: Promise<string> | null = null;
  /** Number of token requests made (tests). */
  refreshes = 0;

  constructor(
    private readonly client: OAuthClientInfo,
    private readonly refreshToken: string,
    private readonly ep: GoogleEndpoints = {},
  ) {}

  async token(force = false): Promise<string> {
    if (!force && this.access && Date.now() < this.access.until) return this.access.token;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    this.refreshes++;
    const j = await postForm(this.ep.oauth2TokenUrl ?? GOOGLE.oauth2TokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
    });
    if (typeof j.access_token !== 'string') throw new Error('Google sent no access token.');
    this.access = { token: j.access_token, until: Date.now() + Math.max(60, Number(j.expires_in) || 3600) * 1000 - 60_000 };
    return this.access.token;
  }
}

/** GET a Gmail API path (relative to gmail/v1/users/me/), refreshing the access token once on 401. */
async function gmailGet(auth: GoogleAuth | { token(force?: boolean): Promise<string> }, ep: GoogleEndpoints, path: string, params: [string, string][] = []): Promise<any> {
  const url = new URL(`gmail/v1/users/me/${path}`, ep.gmailRoot ?? GOOGLE.gmailRoot);
  for (const [k, v] of params) url.searchParams.append(k, v);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${await auth.token(attempt > 0)}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok) throw new Error(res.status === 404 ? 'That email is no longer there.' : res.status === 403 ? 'Gmail refused (is the Gmail API turned on in your Google project?).' : `Gmail error (HTTP ${res.status}).`);
    return res.json();
  }
  throw new Error('Gmail refused the sign-in.');
}

const DONE_PAGE = (ok: boolean) =>
  `<!doctype html><meta charset="utf-8"><title>Cadabra OS</title><body style="font:16px system-ui;padding:40px;background:#111;color:#eee">${ok ? '<h2>Gmail connected.</h2><p>You can close this tab and go back to Cadabra.</p>' : '<h2>Not connected.</h2><p>You can close this tab. Cadabra has the details.</p>'}</body>`;

/**
 * Run the sign-in: opens Google's consent page in the user's browser, catches
 * the code on a one-shot 127.0.0.1 listener, exchanges it (PKCE), and returns
 * the refresh token and the account address. R8-6: hits with a wrong or
 * missing `state` (a prefetch, another local process) are answered 400 and
 * ignored; only the real redirect (or the timeout) ends the wait.
 */
export async function connectGmailOAuth(o: {
  client: OAuthClientInfo;
  openBrowser: (url: string) => void | Promise<void>;
  endpoints?: GoogleEndpoints;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ refreshToken: string; address: string }> {
  const ep = o.endpoints ?? {};
  const server = http.createServer();
  await new Promise<void>((res, rej) => server.once('error', rej).listen(0, '127.0.0.1', () => res()));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  try {
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString('hex');
    const auth = new URL(ep.oauth2AuthBaseUrl ?? GOOGLE.oauth2AuthBaseUrl);
    for (const [k, v] of Object.entries({
      client_id: o.client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }))
      auth.searchParams.set(k, v);
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for Google sign-in.')), o.timeoutMs ?? 10 * 60_000);
      o.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Cancelled.'));
      });
      server.on('request', (req, res) => {
        const u = new URL(req.url ?? '/', redirectUri);
        if (u.pathname !== '/' || u.searchParams.get('state') !== state) {
          // Not the redirect we're waiting for: ignore it, keep listening.
          res.writeHead(u.pathname === '/' ? 400 : 404, { 'content-type': 'text/plain' }).end('Not this one.');
          return;
        }
        const err = u.searchParams.get('error');
        const c = u.searchParams.get('code');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_PAGE(!err && !!c));
        clearTimeout(timer);
        if (err || !c) reject(new Error(err === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google refused the sign-in.'));
        else resolve(c);
      });
      void Promise.resolve(o.openBrowser(auth.href)).catch(reject);
    });
    const tokens = await postForm(ep.oauth2TokenUrl ?? GOOGLE.oauth2TokenUrl, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: o.client.clientId,
      client_secret: o.client.clientSecret,
    });
    if (typeof tokens.refresh_token !== 'string') throw new Error('Google did not return a long-lived token. Remove Cadabra at myaccount.google.com/permissions and connect again.');
    const access = String(tokens.access_token ?? '');
    const profile = await gmailGet({ token: async () => access }, ep, 'profile');
    return { refreshToken: tokens.refresh_token, address: typeof profile.emailAddress === 'string' ? profile.emailAddress : '' };
  } finally {
    server.close();
  }
}

/** "Disconnect": revoke the refresh token at Google (best effort). */
export async function revokeGmailToken(_client: OAuthClientInfo, refreshToken: string, ep: GoogleEndpoints = {}): Promise<boolean> {
  try {
    await postForm(ep.oauth2RevokeUrl ?? GOOGLE.oauth2RevokeUrl, { token: refreshToken });
    return true;
  } catch {
    return false;
  }
}

/** Parse "Name <addr>" / "addr". */
export function parseFrom(v: string): { name: string; address: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(v);
  if (m) return { name: m[1].trim(), address: m[2].trim() };
  return { name: '', address: v.trim() };
}

type GPart = { mimeType?: string | null; filename?: string | null; body?: { data?: string | null } | null; parts?: GPart[] | null };
type GMessage = { id?: string; internalDate?: string; snippet?: string; labelIds?: string[]; payload?: GPart & { headers?: { name?: string; value?: string }[] } };

function fromB64url(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

/** Pull text/plain (else text/html → text) and attachment names out of a Gmail payload. */
export function payloadText(p: GPart): { text: string; attachments: string[] } {
  let plain = '';
  let html = '';
  const attachments: string[] = [];
  const walk = (x: GPart) => {
    if (x.filename) attachments.push(x.filename);
    else if (x.mimeType === 'text/plain' && x.body?.data && !plain) plain = fromB64url(x.body.data);
    else if (x.mimeType === 'text/html' && x.body?.data && !html) html = fromB64url(x.body.data);
    for (const c of x.parts ?? []) walk(c);
  };
  walk(p);
  return { text: plain || htmlToText(html), attachments };
}

function summaryOf(id: string, m: GMessage): EmailSummary {
  const h = (n: string) => m.payload?.headers?.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value ?? '';
  const from = parseFrom(h('From'));
  const ms = Number(m.internalDate);
  const d = Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date(h('Date'));
  return {
    id,
    fromName: from.name,
    fromAddress: from.address,
    subject: h('Subject'),
    date: Number.isFinite(d.getTime()) ? d.toISOString() : '',
    snippet: cleanEmailText(htmlToText(m.snippet ?? ''), 220),
    unread: (m.labelIds ?? []).includes('UNREAD'),
  };
}

export class GmailApiBackend implements MailBackend {
  readonly kind = 'gmail-oauth' as const;
  private readonly auth: GoogleAuth;

  constructor(
    client: OAuthClientInfo,
    refreshToken: string,
    private readonly ep: GoogleEndpoints = {},
  ) {
    this.auth = new GoogleAuth(client, refreshToken, ep);
  }

  async search(q: string, max = MAX_RESULTS): Promise<EmailSummary[]> {
    const list = await gmailGet(this.auth, this.ep, 'messages', [
      ['q', q],
      ['maxResults', String(Math.min(max, 50))],
    ]);
    const ids: string[] = (list.messages ?? []).map((m: { id?: string }) => m.id).filter((x: unknown): x is string => typeof x === 'string' && /^[0-9a-z]+$/i.test(x));
    // R9-5: metadata for up to 4 messages at a time (order kept). Headers +
    // snippet only (no body), and never marks anything read.
    const out: EmailSummary[] = new Array(ids.length);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const i = next++;
        const m: GMessage = await gmailGet(this.auth, this.ep, `messages/${ids[i]}`, [
          ['format', 'metadata'],
          ['metadataHeaders', 'From'],
          ['metadataHeaders', 'Subject'],
          ['metadataHeaders', 'Date'],
        ]);
        out[i] = summaryOf(ids[i], m);
      }
    };
    await Promise.all(Array.from({ length: Math.min(METADATA_PARALLEL, ids.length) }, worker));
    return out;
  }

  async read(id: string): Promise<EmailMessage> {
    if (!/^[0-9a-z]+$/i.test(id)) throw new Error('Use an id from search_email.');
    const m: GMessage = await gmailGet(this.auth, this.ep, `messages/${id}`, [['format', 'full']]);
    const body = payloadText(m.payload ?? {});
    return { ...summaryOf(id, m), text: cleanEmailText(body.text), attachments: body.attachments.slice(0, 20) };
  }

  async close(): Promise<void> {
    /* stateless */
  }
}
