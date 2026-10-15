// Minimal types for mailparser@3.9.39 (it ships none); only what Cadabra uses.
declare module 'mailparser' {
  export interface ParsedMail {
    text?: string;
    html?: string | false;
    attachments?: { filename?: string }[];
  }
  export function simpleParser(
    source: Buffer | string,
    options?: { skipHtmlToText?: boolean; skipTextToHtml?: boolean; skipImageLinks?: boolean },
  ): Promise<ParsedMail>;
}
