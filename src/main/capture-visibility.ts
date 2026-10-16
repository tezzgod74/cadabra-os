// 0.9.11: "Show Cadabra in screen recordings and screen sharing".
//
// By default every Cadabra window (panel, per-display overlay with the ghost
// cursor, highlight rings, the WhatsApp working pill and toasts, confirm cards
// in the panel) is content-protected (WDA_EXCLUDEFROMCAPTURE): OBS, Game Bar,
// the Snipping Tool, Teams/Zoom sharing and Cadabra's own screenshots all skip
// it, so private chats never end up on a shared screen. That's also why a demo
// recording doesn't show Cadabra.
//
// With the setting ON, protection is turned off on all windows, live. Cadabra's
// OWN captures must still never contain Cadabra, so every capture goes through
// `forCapture()`: protection is switched back on for the capture frame and off
// again afterwards. We chose this over hiding windows or masking pixels:
// - hiding the overlay/panel would flicker on the user's real screen;
// - masking can't work for the full-screen transparent overlay (it would blank
//   the whole display) and hides whatever is behind the panel from the AI.
// Re-protecting is invisible on the monitor (the windows stay on screen); a
// recording only misses Cadabra for the ~0.1 s of the capture. As a second
// layer for pictures that leave the PC to a person (WhatsApp screenshots), the
// panel's rectangle is also painted over by the helper (see app.ts).

/** What the controller needs from a window (BrowserWindow satisfies it). */
export interface ProtectableWindow {
  setContentProtection(on: boolean): void;
  isDestroyed(): boolean;
}

/** DWM applies a display-affinity change on its next composition: wait a few frames. */
export const PROTECT_SETTLE_MS = 60;

export class CaptureVisibility {
  private visible: boolean;
  private capturing = 0;
  private known = new Set<ProtectableWindow>();
  private exempt = new WeakSet<ProtectableWindow>();

  constructor(
    visible: boolean,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly settleMs = PROTECT_SETTLE_MS,
  ) {
    this.visible = visible;
  }

  /** The user's choice: Cadabra shows in recordings and screen sharing. */
  get visibleToRecordings(): boolean {
    return this.visible;
  }

  /** The protection state windows have right now (true while a capture is running). */
  get protectedNow(): boolean {
    return !this.visible || this.capturing > 0;
  }

  /**
   * Track a window and apply the current state to it at once. `exempt` windows
   * are never protected (the offline demo stage and the self-test, which must be
   * recordable / capturable by design).
   */
  register(win: ProtectableWindow, o: { exempt?: boolean } = {}): void {
    this.known.add(win);
    if (o.exempt) this.exempt.add(win);
    this.applyTo(win, this.protectedNow);
  }

  /** Change the setting; applied to every window live (no restart). */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.applyAll();
  }

  /**
   * Run one of Cadabra's own captures with every window protected for that
   * frame. Concurrent captures share one protect/unprotect cycle.
   */
  async forCapture<T>(fn: () => Promise<T>): Promise<T> {
    const wasProtected = this.protectedNow;
    this.capturing++;
    try {
      if (!wasProtected) {
        this.applyAll();
        await this.sleep(this.settleMs);
      }
      return await fn();
    } finally {
      this.capturing--;
      if (this.capturing === 0 && this.visible) this.applyAll();
    }
  }

  private applyAll(): void {
    const on = this.protectedNow;
    for (const w of this.known) {
      if (w.isDestroyed()) this.known.delete(w);
      else this.applyTo(w, on);
    }
  }

  private applyTo(w: ProtectableWindow, on: boolean): void {
    if (w.isDestroyed()) return;
    try {
      w.setContentProtection(this.exempt.has(w) ? false : on);
    } catch {
      /* window going away */
    }
  }
}
