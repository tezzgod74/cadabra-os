// Round 10.5 (hands-on): "After a greeting, the AI continues to listen. If I
// have a video running, it tries to respond to the video." Wake-free windows
// (the post-greeting banter window and the follow-up after replies) must not
// treat a video as the user. The helper reports other apps' audio sessions and
// their peak meters (WASAPI, read-only); this module decides "media is
// playing" from a short history. Polling runs only around those windows.

export interface AudioSession {
  exe: string;
  peak: number;
}

/** A session counts as playing above this peak (0..1); quiet UI blips stay below. */
export const MEDIA_PEAK = 0.02;
/** …for at least this long within the recent window. */
export const MEDIA_SUSTAIN_MS = 300;
export const MEDIA_WINDOW_MS = 2000;
export const MEDIA_POLL_MS = 150;

/** Pure: given loud-sample timestamps per app, which app (if any) is playing now. */
export function mediaVerdict(samples: readonly { t: number; exe: string }[], now: number, pollMs = MEDIA_POLL_MS): string | null {
  const recent = samples.filter((s) => now - s.t <= MEDIA_WINDOW_MS);
  const per = new Map<string, number>();
  for (const s of recent) per.set(s.exe, (per.get(s.exe) ?? 0) + 1);
  let best: string | null = null;
  let most = 0;
  for (const [exe, n] of per) {
    if (n * pollMs >= MEDIA_SUSTAIN_MS && n > most) {
      best = exe;
      most = n;
    }
  }
  return best;
}

export class MediaWatch {
  private loud: { t: number; exe: string }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private until = 0;
  private busy = false;

  constructor(
    private readonly sample: () => Promise<AudioSession[]>,
    private readonly now: () => number = Date.now,
    private readonly pollMs = MEDIA_POLL_MS,
  ) {}

  /** Poll for the next `ms` (extends a running watch). Cheap: one RPC every 150 ms. */
  watchFor(ms: number) {
    this.until = Math.max(this.until, this.now() + ms);
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.now() > this.until) return this.stop();
    if (this.busy) return;
    this.busy = true;
    try {
      const t = this.now();
      for (const s of await this.sample()) if (s.peak >= MEDIA_PEAK && !/^cadabra os\.exe$/i.test(s.exe)) this.loud.push({ t, exe: s.exe || 'an app' });
      this.loud = this.loud.filter((s) => t - s.t <= MEDIA_WINDOW_MS);
    } catch {
      /* no verdict from a failed sample */
    } finally {
      this.busy = false;
    }
  }

  /** The app playing sound right now (process name), or null. */
  playing(): string | null {
    return mediaVerdict(this.loud, this.now(), this.pollMs);
  }
}

/**
 * Round 10.5: what may count as a reply in the post-greeting banter window —
 * a short utterance (≤ 8 words) that started soon after the window opened.
 * Anything else is ignored silently (never answered, never opens the panel).
 */
export function acceptGreetingReply(o: { text: string; startLagMs: number }): boolean {
  const words = o.text.trim().split(/\s+/).filter(Boolean).length;
  return words > 0 && words <= 8 && o.startLagMs <= 1500;
}

/**
 * Round 10.5: a follow-up (no wake word) that looks like media rather than the
 * user — long continuous speech, or long speech that started late in the
 * window — is ignored unless it contains the assistant's name.
 */
export function followUpLooksLikeMedia(o: { text: string; audioMs: number; startLagMs: number; name: string }): boolean {
  if (o.name && new RegExp(`\\b${o.name.replace(/[^a-z]/gi, '')}\\b`, 'i').test(o.text)) return false;
  if (o.audioMs > 8000) return true;
  return o.startLagMs > 3000 && o.audioMs > 5000;
}
