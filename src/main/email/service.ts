// Round 8: the email service behind search_email / read_email / open_email.
// Picks the connected backend (own Google key, or IMAP app password), runs the
// "from Sam today" logic (Gmail search, then a fuzzy match over today's mail,
// then "SB Smith or SB Lee?"), and logs only counts and timings — never
// addresses, subjects, bodies or tokens.
import { buildGmailQuery, distinctSenders, fallbackQuery, gmailLink, MAX_RESULTS, senderMatches, type EmailMessage, type EmailQuery, type EmailSummary } from '../../shared/email';
import type { EmailSettings } from '../../shared/types';
import { GmailApiBackend, type GoogleEndpoints } from './gmail-api';
import { ImapBackend, type ImapFactory } from './imap';
import type { MailBackend } from './types';

export interface EmailSecrets {
  refreshToken?: string;
  clientSecret?: string;
  appPassword?: string;
}

export interface EmailServiceDeps {
  settings(): EmailSettings;
  secrets(): EmailSecrets;
  now(): Date;
  log(msg: string): void;
  /** Tests: a fake IMAP server / fake Google endpoints. */
  imapFactory?: ImapFactory;
  endpoints?: GoogleEndpoints;
}

export interface SearchOutcome {
  results: EmailSummary[];
  /** More than one sender matched the name: ask which one. */
  senders?: { name: string; address: string }[];
}

export class EmailService {
  private backend: MailBackend | null = null;
  private backendKey = '';

  constructor(private readonly d: EmailServiceDeps) {}

  /** Connected and has its secret. */
  connected(): boolean {
    const s = this.d.settings();
    const sec = this.d.secrets();
    if (s.mode === 'gmail-oauth') return !!(s.clientId && sec.refreshToken);
    if (s.mode === 'gmail-imap') return !!(s.address && sec.appPassword);
    return false;
  }

  private get(): MailBackend {
    const s = this.d.settings();
    const sec = this.d.secrets();
    const key = `${s.mode}|${s.clientId}|${s.address}|${sec.refreshToken ? 1 : 0}|${sec.appPassword ? 1 : 0}`;
    if (this.backend && key === this.backendKey) return this.backend;
    void this.backend?.close();
    this.backend = null;
    if (!this.connected()) throw new Error('Email isn’t connected. The user can connect Gmail in Settings → Email.');
    this.backend =
      s.mode === 'gmail-oauth'
        ? new GmailApiBackend({ clientId: s.clientId, clientSecret: sec.clientSecret }, sec.refreshToken!, this.d.endpoints)
        : new ImapBackend(s.address, sec.appPassword!, this.d.imapFactory);
    this.backendKey = key;
    return this.backend;
  }

  /** Forget the backend (settings changed / disconnected). */
  async reset(): Promise<void> {
    const b = this.backend;
    this.backend = null;
    this.backendKey = '';
    await b?.close().catch(() => undefined);
  }

  async search(q: EmailQuery): Promise<SearchOutcome> {
    const b = this.get();
    const t0 = Date.now();
    const now = this.d.now();
    let results: EmailSummary[];
    if (q.from?.trim()) {
      const who = q.from.trim();
      // 1) Gmail's own from: match, then keep the senders that really match the name.
      results = (await b.search(buildGmailQuery(q, now), MAX_RESULTS)).filter((m) => senderMatches(who, m.fromName, m.fromAddress));
      // 2) Nothing: Gmail doesn't know "SB" is Samuel Brooks. Look through
      //    the window's mail (≤50) and match names, initials and addresses.
      if (!results.length) results = (await b.search(fallbackQuery(q, now), 50)).filter((m) => senderMatches(who, m.fromName, m.fromAddress)).slice(0, MAX_RESULTS);
    } else {
      results = await b.search(buildGmailQuery(q, now) || 'in:inbox', MAX_RESULTS);
    }
    const senders = q.from?.trim() ? distinctSenders(results) : [];
    this.d.log(`[email] search: ${results.length} result(s)${senders.length > 1 ? `, ${senders.length} senders` : ''} in ${Date.now() - t0} ms`);
    return senders.length > 1 ? { results, senders } : { results };
  }

  async read(id: string): Promise<EmailMessage> {
    const t0 = Date.now();
    const m = await this.get().read(id);
    this.d.log(`[email] read 1 message (${m.text.length} chars) in ${Date.now() - t0} ms`);
    return m;
  }

  link(id: string): string {
    return gmailLink(id, this.d.settings().address);
  }
}
