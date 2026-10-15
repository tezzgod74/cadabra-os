// 0.9.6: Announcements — speak a message on the PC exactly as written. Used by
// the WhatsApp fast path ("Announcement: …"), the PC ("make an announcement: …")
// and the `announce` tool. Works while the PC is locked (it never touches the
// screen) and even when spoken replies are off. Logs events only, never the text.

import { AnnounceRateLimit, capAnnouncement, type AnnouncementSettings } from '../shared/announce';

export type AnnounceSource = 'whatsapp' | 'pc' | 'tool';

export interface AnnounceResult {
  ok: boolean;
  /** Plain-language reason when not announced. */
  reason?: string;
  truncated?: boolean;
  stopped?: boolean;
}

export interface AnnouncerDeps {
  settings(): AnnouncementSettings;
  /** The default speaker is muted (null = unknown). */
  muted(): Promise<boolean | null>;
  /** Inside the greeting quiet hours now. */
  inQuietHours(): boolean;
  /** Speak (chime first if asked, repeated), resolving when done; 'stopped' if cut short. */
  speak(text: string, o: { chime: boolean; repeat: number; boost: boolean; device: string; signal: AbortSignal }): Promise<'done' | 'stopped' | 'unavailable'>;
  /** Lower other apps' audio; returns the restore function. */
  duck(): Promise<() => Promise<void>>;
  log(line: string): void;
  now?(): number;
}

export class Announcer {
  private limit: AnnounceRateLimit;
  private current: AbortController | null = null;

  constructor(private readonly d: AnnouncerDeps) {
    this.limit = new AnnounceRateLimit(undefined, d.now);
  }

  get busy(): boolean {
    return !!this.current;
  }

  /** Esc, "stop" (PC or WhatsApp): cut the announcement short. */
  stop(): void {
    this.current?.abort();
  }

  async announce(raw: string, source: AnnounceSource, signal?: AbortSignal): Promise<AnnounceResult> {
    const { text, truncated } = capAnnouncement(raw);
    if (!text) return { ok: false, reason: 'There was nothing to announce. Put the message after “Announcement:”.' };
    const s = this.d.settings();
    if (s.respectQuietHours && this.d.inQuietHours()) {
      this.d.log(`[announce] ${source}: skipped (quiet hours)`);
      return { ok: false, reason: 'It’s quiet hours on your PC, so I didn’t announce it.' };
    }
    if ((await this.d.muted()) === true) {
      this.d.log(`[announce] ${source}: skipped (sound muted)`);
      return { ok: false, reason: 'Your PC’s sound is muted, so I didn’t announce it.' };
    }
    if (!this.limit.take()) {
      this.d.log(`[announce] ${source}: skipped (rate limit)`);
      return { ok: false, reason: 'That’s a lot of announcements in a minute. Wait a moment and try again.' };
    }
    this.current?.abort();
    const ac = new AbortController();
    this.current = ac;
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) ac.abort();
    let restore: (() => Promise<void>) | null = null;
    const t0 = this.d.now?.() ?? Date.now();
    try {
      if (s.duck) restore = await this.d.duck().catch(() => null);
      const r = await this.d.speak(text, { chime: s.chime, repeat: Math.min(3, Math.max(1, s.repeat)), boost: s.boost, device: s.device, signal: ac.signal });
      const stopped = r === 'stopped' || ac.signal.aborted;
      this.d.log(`[announce] ${source}: ${r === 'unavailable' ? 'no voice available' : stopped ? 'stopped' : 'spoken'} (${text.length} chars${truncated ? ', truncated' : ''}, ${(this.d.now?.() ?? Date.now()) - t0} ms)`);
      if (r === 'unavailable') return { ok: false, reason: 'Speech isn’t available on your PC right now.' };
      if (stopped) return { ok: false, stopped: true, reason: 'The announcement was stopped.', truncated };
      return { ok: true, truncated };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.current === ac) this.current = null;
      if (restore) await restore().catch(() => undefined);
    }
  }
}

/** The WhatsApp reply for a result. */
export function announceReply(r: AnnounceResult): string {
  if (r.ok) return `📢 Announced on your PC${r.truncated ? ' (shortened to the first 500 characters)' : ''}.`;
  return `📢 Not announced: ${r.reason ?? 'something went wrong.'}`;
}
