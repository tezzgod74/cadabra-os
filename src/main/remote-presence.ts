// 0.9.8 (user bug: "Cadabra cannot wake my computer when I'm away. This stops
// me from doing actions via WhatsApp."). Before a remote request can see or use
// the screen: the PC must not be locked (it's never unlocked), and a dark
// display is woken and kept on for the turn. Pure logic with injected deps;
// tested in test/round0_9_8.test.ts.

export interface DesktopState {
  /** null = couldn't tell. */
  locked: boolean | null;
  inputDesktop?: string | null;
  display?: 'on' | 'off' | 'dimmed' | 'unknown';
  foreground?: boolean;
  /** Monitors on the desktop (0 when a sleeping DisplayPort monitor dropped off). */
  monitors?: number;
}

export interface PresenceDeps {
  desktopState(): Promise<DesktopState | null>;
  /** Display-required + one zero-distance mouse move (helper `wake_display`). */
  wakeDisplay(): Promise<void>;
  /** Keep the display on (Electron powerSaveBlocker); returns the release. */
  holdDisplay(): () => void;
  /** "Wake the display for remote requests" (Settings → WhatsApp; default on). */
  wakeEnabled(): boolean;
  log(line: string): void;
  sleep?(ms: number): Promise<void>;
}

/** What WhatsApp is told when the PC is locked (never an unlock attempt). */
export const LOCKED_REPLY =
  'Your PC is locked, so I can’t see or use the screen. I can still make announcements. To let me work while you’re away, Windows must stay unlocked (see “Using Cadabra while you’re away” in the guide).';

export type ScreenReady = { ok: true; woke: boolean } | { ok: false; code: 'desktop-locked' | 'display-off'; message: string };

export class RemotePresence {
  private release: (() => void) | null = null;

  constructor(private readonly d: PresenceDeps) {}

  private sleep(ms: number) {
    return this.d.sleep ? this.d.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  /** The display is dark (off or dimmed) or there's nothing in front to work with. */
  private needsWake(s: DesktopState | null): boolean {
    return !!s && (s.display === 'off' || s.display === 'dimmed' || s.foreground === false || s.monitors === 0);
  }

  /**
   * Can a remote request use the screen right now? Locked → no (and nothing is
   * tried). Dark display → wake it, then wait up to `waitMs` for it to report on
   * and a foreground window to appear.
   */
  async ensureScreen(waitMs = 3000): Promise<ScreenReady> {
    let s = await this.d.desktopState().catch(() => null);
    if (s?.locked) return { ok: false, code: 'desktop-locked', message: LOCKED_REPLY };
    if (!this.needsWake(s)) return { ok: true, woke: false };
    if (!this.d.wakeEnabled()) return { ok: false, code: 'display-off', message: 'The PC’s display is off and “Wake the display for remote requests” is turned off, so I can’t see the screen.' };
    this.d.log(`[remote] waking the display (${s?.display ?? 'unknown'}${s?.monitors === 0 ? ', no monitors on the desktop' : ''}${s?.foreground === false ? ', no foreground window' : ''})`);
    await this.d.wakeDisplay().catch((e) => this.d.log(`[remote] wake failed: ${(e as Error).message}`));
    const step = 250;
    for (let waited = 0; waited < waitMs; waited += step) {
      await this.sleep(step);
      s = await this.d.desktopState().catch(() => null);
      // Waking can reveal the lock screen ("require sign-in after the display turns off").
      if (s?.locked) return { ok: false, code: 'desktop-locked', message: LOCKED_REPLY };
      if (!this.needsWake(s)) {
        this.d.log(`[remote] display on after ${waited + step} ms`);
        return { ok: true, woke: true };
      }
    }
    this.d.log(`[remote] display didn't report on within ${waitMs} ms; continuing`);
    return { ok: true, woke: true };
  }

  /** Remote turn start: check / wake, then keep the display on until endTurn(). */
  async beginTurn(): Promise<ScreenReady> {
    const r = await this.ensureScreen();
    if (r.ok && !this.release) this.release = this.d.holdDisplay();
    return r;
  }

  /** Remote turn end (success, error or stop): let the display sleep again. */
  endTurn(): void {
    const rel = this.release;
    this.release = null;
    rel?.();
  }

  get holding(): boolean {
    return !!this.release;
  }
}

/**
 * 0.9.8: a plain reason code for a failed tool (the log said only "error").
 * Uses the desktop state when it's available.
 */
export function toolFailureCode(tool: string, message: string, s: DesktopState | null): string {
  if (s?.locked) return 'desktop-locked';
  if (s?.monitors === 0 || /empty capture rect/i.test(message)) return /screen|capture|screenshot|read_ui/.test(tool) || /capture/i.test(message) ? 'capture-failed:no-display' : 'no-display';
  const capture = /screen|capture|screenshot|read_ui/.test(tool) || /capture|BitBlt|DXGI|PrintWindow/i.test(message);
  if (s && (s.display === 'off' || s.display === 'dimmed')) return capture ? 'capture-failed:display-off' : 'display-off';
  if (s && s.foreground === false) return 'no-foreground-window';
  if (/helper (is )?(not running|unavailable|restarting|exited|died)|timed out|ECONNRESET|EPIPE/i.test(message)) return 'helper-error';
  return capture ? 'capture-failed' : 'error';
}
