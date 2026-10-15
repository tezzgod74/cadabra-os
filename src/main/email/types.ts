import type { EmailMessage, EmailSummary } from '../../shared/email';

/** One way of reading the user's mailbox. Read-only by construction: no send / delete / modify. */
export interface MailBackend {
  readonly kind: 'gmail-oauth' | 'gmail-imap';
  /** Gmail search syntax (API `q` / IMAP X-GM-RAW). Newest first, at most `max`. */
  search(q: string, max?: number): Promise<EmailSummary[]>;
  read(id: string): Promise<EmailMessage>;
  close(): Promise<void>;
}
