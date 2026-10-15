// Round 8, path B ("Simple setup, less secure"): IMAP with a Google app
// password (research.md §10.2). Personal @gmail.com only. The mailbox is
// opened with EXAMINE (read-only select) and searched with Gmail's X-GM-RAW,
// so the same query syntax as the API works. Nothing is ever written: no
// flags, no moves, no deletes. Nothing here logs addresses, subjects or bodies.
import { cleanEmailText, htmlToText, type EmailMessage, type EmailSummary, MAX_RESULTS } from '../../shared/email';
import type { MailBackend } from './types';

/** The subset of ImapFlow Cadabra uses (so tests can pass a fake). */
export interface ImapLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  list(): Promise<{ path: string; specialUse?: string }[]>;
  mailboxOpen(path: string, opts: { readOnly: boolean }): Promise<unknown>;
  search(q: Record<string, unknown>, opts: { uid: boolean }): Promise<number[] | false | undefined>;
  fetchAll(range: string, q: Record<string, unknown>, opts: { uid: boolean }): Promise<ImapMsg[]>;
  fetchOne(range: string, q: Record<string, unknown>, opts: { uid: boolean }): Promise<ImapMsg | false | undefined>;
  on?(ev: 'error', cb: (e: Error) => void): void;
}

export interface ImapMsg {
  uid: number;
  emailId?: string;
  flags?: Set<string>;
  internalDate?: Date | string;
  envelope?: { subject?: string; date?: Date; from?: { name?: string; address?: string }[] };
  source?: Buffer;
}

export type ImapFactory = (user: string, pass: string) => Promise<ImapLike>;

export const realImap: ImapFactory = async (user, pass) => {
  const { ImapFlow } = await import('imapflow');
  return new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false }) as unknown as ImapLike;
};

/** X-GM-MSGID (decimal) → the hex id Gmail uses in the API and the web link. */
export function gmIdToHex(id: string | undefined): string {
  if (!id || !/^\d+$/.test(id)) return '';
  return BigInt(id).toString(16);
}

async function parse(source: Buffer): Promise<{ text: string; attachments: string[] }> {
  const { simpleParser } = await import('mailparser');
  const m = await simpleParser(source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  const text = m.text || (typeof m.html === 'string' ? htmlToText(m.html) : '');
  return { text, attachments: (m.attachments ?? []).map((a: { filename?: string }) => a.filename || 'attachment') };
}

export class ImapBackend implements MailBackend {
  readonly kind = 'gmail-imap' as const;
  private client: ImapLike | null = null;
  private opening: Promise<ImapLike> | null = null;
  /** hex id → uid in the opened mailbox (memory only). */
  private uids = new Map<string, number>();

  constructor(
    private readonly user: string,
    private readonly pass: string,
    private readonly factory: ImapFactory = realImap,
  ) {}

  private async open(): Promise<ImapLike> {
    if (this.client) return this.client;
    this.opening ??= (async () => {
      const c = await this.factory(this.user, this.pass);
      c.on?.('error', () => {
        this.client = null;
      });
      await c.connect();
      // "All Mail" has a localised name ("[Google Mail]/All Mail"…): find it by its special use.
      let box = 'INBOX';
      try {
        box = (await c.list()).find((b) => b.specialUse === '\\All')?.path ?? 'INBOX';
      } catch {
        /* INBOX */
      }
      await c.mailboxOpen(box, { readOnly: true }); // EXAMINE: read-only
      this.client = c;
      return c;
    })().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  /** Sign in and open the mailbox read-only (used by "Connect" to check the app password). */
  async verify(): Promise<void> {
    await this.open();
  }

  private summary(m: ImapMsg, snippet: string): EmailSummary {
    const id = gmIdToHex(m.emailId) || `uid${m.uid}`;
    this.uids.set(id, m.uid);
    const from = m.envelope?.from?.[0] ?? {};
    const d = m.internalDate ? new Date(m.internalDate) : m.envelope?.date;
    return {
      id,
      fromName: from.name ?? '',
      fromAddress: from.address ?? '',
      subject: m.envelope?.subject ?? '',
      date: d && Number.isFinite(d.getTime()) ? d.toISOString() : '',
      snippet: cleanEmailText(snippet, 220),
      unread: !(m.flags?.has('\\Seen') ?? true),
    };
  }

  async search(q: string, max = MAX_RESULTS): Promise<EmailSummary[]> {
    const c = await this.open();
    const found = (await c.search({ gmraw: q }, { uid: true })) || [];
    const uids = [...found].sort((a, b) => b - a).slice(0, Math.min(max, 50));
    if (!uids.length) return [];
    // Headers + the first part of the source (for a preview); never flags changes.
    const msgs = await c.fetchAll(uids.join(','), { uid: true, envelope: true, flags: true, emailId: true, internalDate: true, source: { start: 0, maxLength: 24_000 } }, { uid: true });
    const out: EmailSummary[] = [];
    for (const m of msgs.sort((a, b) => b.uid - a.uid)) {
      let snippet = '';
      try {
        if (m.source) snippet = (await parse(m.source)).text.slice(0, 400);
      } catch {
        snippet = '';
      }
      out.push(this.summary(m, snippet));
    }
    return out;
  }

  async read(id: string): Promise<EmailMessage> {
    const c = await this.open();
    let uid = this.uids.get(id);
    if (uid == null && /^[0-9a-f]+$/i.test(id)) {
      const r = (await c.search({ emailId: BigInt(`0x${id}`).toString() }, { uid: true })) || [];
      uid = r[0];
    }
    if (uid == null) throw new Error('That email is no longer there.');
    const m = await c.fetchOne(String(uid), { uid: true, envelope: true, flags: true, emailId: true, internalDate: true, source: true }, { uid: true });
    if (!m) throw new Error('That email is no longer there.');
    const body = m.source ? await parse(m.source) : { text: '', attachments: [] };
    return { ...this.summary(m, body.text.slice(0, 400)), text: cleanEmailText(body.text), attachments: body.attachments.slice(0, 20) };
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    await c?.logout().catch(() => undefined);
  }
}
