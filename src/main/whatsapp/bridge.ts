// Round 12: "Chat with Cadabra on WhatsApp". The long-poll loop, owner lock and
// pairing, remote confirmations ("Reply YES …"), the remote kill ("stop"),
// voice notes and images. Everything outside WhatsApp (the conversation, the
// PC, speech-to-text, the panel) comes in through RemoteDeps, so the bridge is
// tested against a fake Agent Platform server.
import { parseRemoteAnnouncement } from '../../shared/announce';
import { createHash, randomInt } from 'node:crypto';
import { RateLimiter, WaError, type WaMessage, type WhatsAppClient } from './client';
import { isSecretLike } from '../../shared/safety';

export interface RemoteState {
  /** next_offset from the last poll (null = start with new traffic only). */
  offset: number | null;
  /** The owner's participant id, set by pairing ('' = not paired). */
  pairedFrom: string;
}

export interface RemoteDeps {
  client: WhatsAppClient;
  /** Remote access is on, a token is stored, and Cadabra isn't paused. */
  active(): boolean;
  state(): RemoteState;
  saveState(s: Partial<RemoteState>): void;
  log(msg: string): void;
  /** Show the pairing code on the PC (panel notice / tray balloon). Never sent to WhatsApp. */
  showPairingCode(code: string): void;
  /** The PC is locked: say so and don't act. */
  locked(): boolean;
  /** The assistant is busy with the person at the PC. */
  busyLocal(): boolean;
  /** Run one remote turn; resolves with the reply text. */
  handle(text: string, ctx: { image?: { data: string; mimeType: string }; voice?: boolean; signal: AbortSignal }): Promise<string>;
  /** 0.9.6: speak an announcement on the PC (no AI). Returns the reply for the chat. */
  announce?(text: string, signal: AbortSignal): Promise<string>;
  /** The remote kill: stop whatever the assistant is doing for WhatsApp. */
  stop(): void;
  /** Voice note → text (null = can't decode / transcribe). */
  transcribe(bytes: Buffer, mime: string): Promise<string | null>;
  now?(): number;
  /** The assistant's configured name (default "Cadabra"). */
  name?(): string;
}

export type RemoteStatus = 'off' | 'connecting' | 'ok' | 'token-invalid' | 'offline';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  });

/** For logs: a short hash of a participant id (never the id itself). */
export function idHash(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 8);
}

export const CONFIRM_TTL_MS = 2 * 60_000;
/** Round 12.5: messages older than this (PC was off / asleep) aren't acted on. */
export const STALE_MS = 10 * 60_000;

/**
 * Round 12.5: what a confirmation shows of the exact action in the chat — a
 * short, masked preview (digit runs hidden, length capped), never the full
 * typed text and never anything secret-looking.
 */
export function maskedPreview(text: string, max = 40): string {
  const t = text.replace(/\s+/g, ' ').trim().replace(/\d{3,}/g, '•••');
  const raw = t.split(' ');
  // Round 12.6 (REVIEW-12.5 S1): also short secrets — the word after "password", "pin",
  // "passcode", "code", "secret", "key", and anything the secret detector flags.
  const words = raw.map((w, i) => {
    const prev = (raw[i - 1] ?? '').toLowerCase().replace(/[:=]$/, '');
    const prev2 = (raw[i - 2] ?? '').toLowerCase();
    const afterKeyword = /^(password|passcode|passwd|pwd|pin|code|secret|key|token)$/.test(prev) || (/^(is|:|=)$/.test(prev) && /^(password|passcode|pin|code|secret|key|token)$/.test(prev2));
    if ((afterKeyword && !/^(is|was|:|=)$/i.test(w)) || isSecretLike(w) || (w.length >= 16 && /[A-Za-z]/.test(w) && /\d|[_-]/.test(w))) return '•••';
    return w.replace(/^(password|passcode|pin|pwd)[:=].+$/i, '$1:•••');
  });
  const out = words.join(' ');
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/**
 * Round 12.6 (REVIEW-12.5 S1): what a WhatsApp confirmation shows of the action.
 * Terminal commands, programs and web addresses: in FULL (the owner must see
 * exactly what runs / opens). Typed text: a short masked preview. Password /
 * secret fields: nothing.
 */
export function confirmDetail(card: { title: string; mono?: string; risk?: string; kind?: string }): string {
  if (!card.mono) return '';
  if (/password|passcode|\bpin\b|secret|credential|card number|cvv|one-time code/i.test(`${card.title} ${card.risk ?? ''}`)) return '(hidden: a password or secret field)';
  if (card.kind === 'terminal' || card.kind === 'launch' || card.kind === 'open_url' || card.kind === 'web_fetch' || card.kind === 'web_search' || card.kind === 'press_keys') return card.mono.slice(0, 3800);
  return `“${maskedPreview(card.mono)}”`;
}
export const PAIRING_TTL_MS = 5 * 60_000;

/** Split a reply into WhatsApp-sized messages (≤ 4096 chars, on paragraph / sentence edges). */
export function chunkReply(text: string, max = 4000): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const cut = Math.max(rest.lastIndexOf('\n\n', max), rest.lastIndexOf('. ', max) + 1, rest.lastIndexOf(' ', max));
    const at = cut > max / 2 ? cut : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export class RemoteBridge {
  status: RemoteStatus = 'off';
  private loop: AbortController | null = null;
  private pairing: { code: string; until: number } | null = null;
  /** A risky action waiting for its one-time code ("Reply 4821 to …"). */
  private pendingYes: { resolve: (ok: boolean) => void; until: number; code: string } | null = null;
  private run: AbortController | null = null;
  /** The owner's last message (replies go to `from` exactly as received). */
  private replyTo = '';
  /** Remote turns per minute (remote actions are rate-limited). */
  private readonly turns = new RateLimiter(6);
  /** Round 12.5: recently handled message ids (a re-delivered message is handled once). */
  private seen = new Set<string>();

  constructor(private readonly d: RemoteDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  get running(): boolean {
    return !!this.loop;
  }

  get busy(): boolean {
    return !!this.run;
  }

  start(): void {
    if (this.loop) return;
    this.loop = new AbortController();
    void this.pollLoop(this.loop.signal);
  }

  stopLoop(): void {
    this.loop?.abort();
    this.loop = null;
    this.status = 'off';
  }

  /** Start pairing: a fresh 6-digit code, shown on the PC only, valid 10 minutes. */
  beginPairing(): string {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.pairing = { code, until: this.now() + PAIRING_TTL_MS };
    this.d.showPairingCode(code);
    this.d.log('[whatsapp] pairing started');
    return code;
  }

  unpair(): void {
    this.d.saveState({ pairedFrom: '' });
    this.d.log('[whatsapp] unpaired');
  }

  private async pollLoop(signal: AbortSignal) {
    let backoff = 2000;
    while (!signal.aborted) {
      if (!this.d.active()) {
        this.status = 'off';
        await sleep(3000, signal);
        continue;
      }
      if (this.status === 'off') this.status = 'connecting';
      try {
        const st = this.d.state();
        const r = await this.d.client.poll(st.offset ?? undefined, 25, signal);
        this.status = 'ok';
        backoff = 2000;
        if (r.nextOffset != null) this.d.saveState({ offset: r.nextOffset });
        // Round 12.5: messages that waited while the PC was off / asleep aren't acted on.
        const fresh = r.messages.filter((m) => !this.isStale(m));
        const stale = r.messages.filter((m) => this.isStale(m));
        if (stale.length) await this.onStale(stale);
        for (const m of fresh) await this.onMessage(m);
      } catch (e) {
        if (signal.aborted) break;
        const w = e as WaError;
        if (w instanceof WaError && (w.status === 401 || (w.status === 400 && w.code === 100) || w.status === 0 && /token/i.test(w.message))) {
          this.status = 'token-invalid';
          this.d.log('[whatsapp] the API token was refused; waiting 5 min (check Settings → WhatsApp)');
          await sleep(5 * 60_000, signal);
          continue;
        }
        if (w instanceof WaError && w.status === 409) continue; // a newer poll replaced this one
        this.status = 'offline';
        this.d.log(`[whatsapp] poll failed (${w instanceof WaError ? w.status || 'network' : 'network'}); retrying in ${Math.round(backoff / 1000)} s`);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  isStale(m: WaMessage): boolean {
    const t = Number(m.timestamp) * 1000;
    return Number.isFinite(t) && t > 0 && this.now() - t > STALE_MS;
  }

  private async onStale(ms: WaMessage[]) {
    this.d.log(`[whatsapp] ${ms.length} old message(s) not acted on (sent while the PC was off or asleep)`);
    const owner = this.d.state().pairedFrom;
    const fromOwner = ms.filter((m) => m.from === owner && !this.seen.has(m.id));
    for (const m of ms) this.remember(m.id);
    if (!owner || !fromOwner.length) return;
    this.replyTo = owner;
    await this.reply('I missed this while your PC was off or asleep. Send it again if you still want it.');
  }

  private remember(id: string) {
    this.seen.add(id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
  }

  private async reply(text: string) {
    if (!this.replyTo) return;
    for (const part of chunkReply(text)) {
      try {
        await this.d.client.send(this.replyTo, { type: 'text', text: part });
      } catch (e) {
        this.d.log(`[whatsapp] reply not sent (${(e as WaError).unknown ? 'unknown outcome; not re-sent' : (e as Error).message})`);
        return;
      }
    }
  }

  /** One inbound message (exported for tests through the poll loop). */
  async onMessage(m: WaMessage): Promise<void> {
    // Round 12.5: dedupe (an LRU of recent message ids).
    if (this.seen.has(m.id)) return;
    this.remember(m.id);
    const st = this.d.state();
    const body = m.type === 'text' ? (m.text?.body ?? '').trim() : '';
    // ---- Owner lock + pairing.
    if (!st.pairedFrom || st.pairedFrom !== m.from) {
      const p = this.pairing;
      if (p && this.now() < p.until && body.replace(/\s+/g, '') === p.code) {
        this.pairing = null;
        this.d.saveState({ pairedFrom: m.from });
        this.replyTo = m.from;
        this.d.log(`[whatsapp] paired (${idHash(m.from)})`);
        await this.reply('Paired. Hi! I’m Cadabra, an AI agent running on your PC. Ask me anything, or tell me what to do there. I ask before anything risky. Say “stop” any time to stop me. Note: this chat isn’t end-to-end encrypted.');
        return;
      }
      this.d.log(`[whatsapp] ignored a message from an unpaired sender (${idHash(m.from)})`);
      // The platform only delivers the agent creator's messages (and only lets the agent message its
      // creator), so an unknown id here is the owner before pairing or with a changed id: the
      // pairing hint goes to them. The code itself is shown only on the PC.
      this.replyTo = m.from;
      if (!p || this.now() >= p.until) this.beginPairing();
      await this.reply(st.pairedFrom ? 'This chat isn’t paired with your PC any more (WhatsApp may have changed your id). Send the 6-digit code shown in Cadabra on your PC.' : 'To connect, send the 6-digit code Cadabra is showing on your PC (Settings → WhatsApp).');
      return;
    }
    this.replyTo = m.from;
    // Read receipt now, unless this message starts a turn (that one carries the typing indicator).
    const startsTurn = !/^(stop|cancel|halt|abort)[.!]*$/i.test(body) && !this.pendingYes && !this.run && ['text', 'audio', 'image'].includes(m.type);
    if (!startsTurn) await this.d.client.markRead(m.id, false);
    // ---- Remote kill and confirmations.
    if (/^(stop|cancel|halt|abort)[.!]*$/i.test(body)) {
      this.d.log('[whatsapp] remote stop');
      this.pendingYes?.resolve(false);
      this.pendingYes = null;
      this.run?.abort();
      this.d.stop();
      await this.reply('Stopped.');
      return;
    }
    if (this.pendingYes) {
      // Research §11.6: a short one-time code, not a bare "yes" (no accidental confirmations).
      const ok = new RegExp(`^(yes\\s*)?${this.pendingYes.code}[.!]*$`, 'i').test(body) && this.now() < this.pendingYes.until;
      this.pendingYes.resolve(ok);
      this.pendingYes = null;
      if (!ok) await this.reply('Okay, I didn’t do it.');
      return;
    }
    if (this.run) {
      await this.reply('I’m still working on the last thing. Say “stop” to cancel it.');
      return;
    }
    // ---- Content.
    let text = body;
    let image: { data: string; mimeType: string } | undefined;
    let voice = false;
    if (m.type === 'audio' && m.audio) {
      voice = !!m.audio.voice;
      try {
        const media = await this.d.client.download(m.audio.id);
        text = (await this.d.transcribe(media.bytes, media.mime)) ?? '';
      } catch {
        text = '';
      }
      if (!text.trim()) {
        await this.reply('I can’t hear that voice note yet. Could you type it?');
        return;
      }
    } else if (m.type === 'image' && m.image) {
      try {
        const media = await this.d.client.download(m.image.id, 5 * 1024 * 1024);
        image = { data: media.bytes.toString('base64'), mimeType: media.mime };
      } catch {
        await this.reply('I couldn’t download that picture.');
        return;
      }
      text = m.image.caption?.trim() || 'What’s in this picture?';
    } else if (m.type !== 'text') {
      if (m.type !== 'reaction') await this.reply('For now I can read text, voice notes and pictures.');
      return;
    }
    if (!text) return;
    // 0.9.6: "Announcement: …" is spoken on the PC as written: a local fast path
    // (no AI), allowed while the PC is locked (it never touches the screen).
    const ann = this.d.announce ? parseRemoteAnnouncement(text) : null;
    if (ann != null) {
      await this.d.client.markRead(m.id, false);
      void this.runAnnouncement(ann);
      return;
    }
    if (this.d.locked()) {
      await this.reply('Your PC is locked, so I can’t do anything on it right now. Unlock it and ask again.');
      return;
    }
    if (this.d.busyLocal()) {
      await this.reply('I’m busy with something at the PC right now. Try again in a moment.');
      return;
    }
    if (this.turns.waitMs() > 0) {
      await this.reply('That’s a lot of requests in a minute. Give me a moment and try again.');
      return;
    }
    this.turns.take();
    void this.runTurn(m.id, text, { image, voice });
  }

  private async runAnnouncement(text: string) {
    const ac = new AbortController();
    this.run = ac; // "stop" from the phone (and Esc at the PC) cut it short
    this.d.log('[whatsapp] announcement');
    try {
      const out = await this.d.announce!(text, ac.signal);
      if (!ac.signal.aborted) await this.reply(out);
    } catch (e) {
      await this.reply(`📢 Not announced: ${(e as Error).message.slice(0, 200)}`);
    } finally {
      if (this.run === ac) this.run = null;
    }
  }

  private async runTurn(messageId: string, text: string, ctx: { image?: { data: string; mimeType: string }; voice?: boolean }) {
    const ac = new AbortController();
    this.run = ac;
    // Typing indicator now and every 20 s while working (it fades after 25 s).
    await this.d.client.markRead(messageId, true);
    const typing = setInterval(() => void this.d.client.markRead(messageId, true), 20_000);
    typing.unref?.();
    this.d.log(`[whatsapp] remote turn (${ctx.voice ? 'voice note' : ctx.image ? 'picture' : 'text'})`);
    try {
      const out = await this.d.handle(text, { ...ctx, signal: ac.signal });
      if (!ac.signal.aborted && out.trim()) await this.reply(out);
    } catch (e) {
      if (!ac.signal.aborted) await this.reply(`Something went wrong: ${(e as Error).message.slice(0, 200)}`);
    } finally {
      clearInterval(typing);
      if (this.run === ac) this.run = null;
    }
  }

  /** Round 12.6: the person at the PC took over: stop the WhatsApp request and tell the phone. */
  async takeOver(): Promise<void> {
    if (!this.run) return;
    this.d.log('[whatsapp] stopped: taken over at the PC');
    this.pendingYes?.resolve(false);
    this.pendingYes = null;
    this.run.abort();
    this.d.stop();
    await this.reply('Stopped — you took over at the PC.');
  }

  /**
   * A risky action during a remote turn: ask IN WhatsApp. "YES" within two
   * minutes approves it once; anything else (or nothing) declines.
   */
  async confirm(card: { title: string; mono?: string; risk?: string; kind?: string }): Promise<boolean> {
    if (!this.replyTo) return false;
    this.pendingYes?.resolve(false);
    const code = String(randomInt(1000, 10_000));
    // Round 12.5: a short masked preview of the exact action, never the full text.
    const lines = [`${this.d.name?.() ?? 'Cadabra'} wants to: ${card.title}`, confirmDetail(card), card.risk ? `(${maskedPreview(card.risk, 120)})` : '', `Reply ${code} within 2 minutes to allow this once. Anything else cancels it.`].filter(Boolean);
    const answer = new Promise<boolean>((resolve) => {
      const until = this.now() + CONFIRM_TTL_MS;
      this.pendingYes = { resolve, until, code };
      setTimeout(() => {
        if (this.pendingYes?.until === until) {
          this.pendingYes = null;
          resolve(false);
        }
      }, CONFIRM_TTL_MS).unref?.();
    });
    await this.reply(lines.join('\n'));
    const ok = await answer;
    this.d.log(`[whatsapp] remote confirmation: ${ok ? 'yes' : 'no'}`);
    return ok;
  }

  /**
   * Send a picture (a compressed screenshot preview the owner asked for). The
   * uploaded copy is deleted right after sending (research §11.1.3: media would
   * otherwise stay on the agent service for 30 days).
   */
  async sendImage(jpeg: Buffer, caption: string): Promise<void> {
    if (!this.replyTo) throw new Error('No WhatsApp chat to send to.');
    const id = await this.d.client.upload(jpeg, 'image/jpeg', 'screen.jpg');
    try {
      await this.d.client.send(this.replyTo, { type: 'image', id, caption: caption.slice(0, 1024) });
    } finally {
      await this.d.client.deleteMedia(id).catch(() => this.d.log('[whatsapp] could not delete an uploaded picture'));
    }
  }
}
