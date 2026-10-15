// Round 4.5 (hands-on bug): is voice actually hearing anything?
//
// The user's capture ended without any error (Windows recorded the mic being
// released 21 s after a restart) and voice stayed "on" but deaf: no wake word,
// push-to-talk opened an empty panel, nothing logged. MicWatch turns the mic
// window's reports into a health state and asks for restarts with backoff.
// Pure (clock injected) so it is unit-tested.
//
// Round 6 (REVIEW-5 D1–D5): an engine heartbeat (frames actually processed),
// "muted" as its own state, one restart per silence episode (no loops), a
// capture restart when the Windows default input changes, and bookkeeping for
// Settings → Voice status (device, last restart reason, counts).

export type VoiceHealth = 'off' | 'starting' | 'ok' | 'no-mic-access' | 'no-mic' | 'mic-lost' | 'mic-muted' | 'silent' | 'engine-error' | 'restarting';

export const HEALTH_TEXT: Record<VoiceHealth, string> = {
  off: 'Voice is off',
  starting: 'Voice is starting…',
  ok: 'Voice: listening',
  'no-mic-access': 'Microphone access is blocked (Windows Settings → Privacy & security → Microphone)',
  'no-mic': 'No microphone found',
  'mic-lost': 'The microphone stopped; reconnecting…',
  'mic-muted': 'The microphone is muted (in Windows or on the device)',
  silent: 'The microphone is sending silence (muted, or the wrong input?)',
  'engine-error': 'The speech engine stopped; restarting…',
  restarting: 'Restarting voice…',
};

/** Voice is on but not working: show a notice / tray state. */
export function healthIsProblem(h: VoiceHealth): boolean {
  return h !== 'ok' && h !== 'off' && h !== 'starting';
}

/** Backoff for automatic restarts: 1 s, 2 s, 4 s … capped at 30 s. */
export function restartDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}

/** No new frames for this long while capturing means the capture is dead. */
export const STALL_MS = 6000;
/** Mic frames keep coming but the engine processed none for this long: engine hung. */
export const ENGINE_STALL_MS = 8000;
/** Digital silence (peak exactly 0) for this long means a dead or muted input. */
export const SILENT_MS = 20_000;
/** A silence episode gets ONE capture restart, at least this long after the last one. */
export const SILENT_RESTART_GAP_MS = 60_000;
/** After this many failed mic restarts in a row, restart the whole pipeline. */
export const MIC_RETRIES_BEFORE_ENGINE = 3;

export interface MicReport {
  state: string;
  frames?: number;
  peak?: number;
  track?: string;
  name?: string;
  message?: string;
  live?: boolean;
  /** Label of the Windows default input (devicechange reports). */
  defaultInput?: string;
  /** All input labels (devicechange reports). */
  inputs?: string[];
}

/** Bluetooth hands-free / headset inputs: opening one switches the headset into call mode. */
export function isHandsFree(label: string): boolean {
  return /hands-?free|bluetooth|(^|[^a-z])bt([^a-z]|$)|airpods|buds|headset/i.test(label);
}

export interface VoiceStatus {
  health: VoiceHealth;
  text: string;
  detail: string;
  /** The input actually being captured (track label). */
  device: string;
  lastRestartReason: string;
  lastRestartAt: number | null;
  restarts: { mic: number; engine: number };
  /** REVIEW-6 N6-2: a new default microphone Cadabra did NOT switch to (offered as "Use it"). */
  pendingDefault: string;
}

export class MicWatch {
  health: VoiceHealth = 'off';
  detail = '';
  device = '';
  lastRestartReason = '';
  lastRestartAt: number | null = null;
  restarts = { mic: 0, engine: 0 };
  pendingDefault = '';
  private engineUp = false;
  private micUp = false;
  private lastFrames = -1;
  private lastFrameAt = 0;
  private engineFrames = -1;
  private engineFrameAt = 0;
  private silentSince = 0;
  private silentEpisodeRestarted = false;
  private lastSilentRestartAt = -Infinity;
  private defaultInput: string | null = null;
  private attempt = 0;
  private healthySince = 0;
  private on = false;

  constructor(
    private readonly cb: { health: (h: VoiceHealth, detail: string) => void; restart: (kind: 'mic' | 'engine', delayMs: number) => void },
    private readonly now: () => number = Date.now,
  ) {}

  status(): VoiceStatus {
    return { health: this.health, text: HEALTH_TEXT[this.health], detail: this.detail, device: this.device, lastRestartReason: this.lastRestartReason, lastRestartAt: this.lastRestartAt, restarts: { ...this.restarts }, pendingDefault: this.pendingDefault };
  }

  private set(h: VoiceHealth, detail = '') {
    if (h === this.health && detail === this.detail) return;
    this.health = h;
    this.detail = detail;
    if (h === 'ok') this.healthySince = this.now();
    this.cb.health(h, detail);
  }

  private restart(kind: 'mic' | 'engine', reason: string, fixed?: number) {
    const delay = fixed ?? restartDelay(this.attempt);
    this.attempt++;
    const what = kind === 'mic' && this.attempt > MIC_RETRIES_BEFORE_ENGINE ? 'engine' : kind;
    this.restarts[what]++;
    this.lastRestartReason = reason;
    this.lastRestartAt = this.now();
    this.cb.restart(what, delay);
  }

  private maybeOk() {
    if (this.on && this.engineUp && this.micUp) this.set('ok');
  }

  starting() {
    this.on = true;
    if (this.health === 'off') this.set('starting');
  }

  restarting(what: string) {
    this.on = true;
    this.set('restarting', what);
  }

  /** User pressed "Restart voice". */
  manualRestart() {
    this.lastRestartReason = 'restarted by you';
    this.lastRestartAt = this.now();
  }

  stopped() {
    this.on = false;
    this.engineUp = false;
    this.micUp = false;
    this.engineFrames = -1;
    this.set('off');
  }

  engineReady() {
    this.engineUp = true;
    this.engineFrames = -1;
    this.engineFrameAt = this.now();
    this.maybeOk();
  }

  /** D1: the engine reports how many frames it has processed (every ~2 s). */
  engineHeartbeat(frames: number) {
    if (frames !== this.engineFrames) {
      this.engineFrames = frames;
      this.engineFrameAt = this.now();
    }
  }

  /** The voice engine (or mic window) died, or couldn't start. `retry` = restart with backoff. */
  engineGone(detail: string, retry = true) {
    this.engineUp = false;
    if (!this.on) return;
    this.set('engine-error', detail);
    if (retry) this.restart('engine', detail);
  }

  onMic(m: MicReport) {
    if (!this.on) return;
    switch (m.state) {
      case 'started':
        this.micUp = true;
        this.lastFrames = -1;
        this.lastFrameAt = this.now();
        this.engineFrameAt = this.now();
        this.silentSince = 0;
        if (m.track != null) this.device = m.track;
        if (m.defaultInput) this.defaultInput = m.defaultInput;
        this.maybeOk();
        break;
      case 'error':
        this.micUp = false;
        if (m.name === 'NotAllowedError' || m.name === 'SecurityError') {
          this.set('no-mic-access', m.message ?? '');
          this.restart('mic', 'microphone access blocked', 30_000);
        } else {
          const why = `${m.name ?? ''} ${m.message ?? ''}`.trim();
          this.set(m.name === 'NotFoundError' || m.name === 'OverconstrainedError' ? 'no-mic' : 'mic-lost', why);
          this.restart('mic', why || 'microphone error');
        }
        break;
      case 'ended':
        this.micUp = false;
        this.set('mic-lost', 'capture ended');
        this.restart('mic', 'the capture ended (device lost or changed)');
        break;
      case 'muted':
        // D5: Windows / the device muted the input: say so straight away.
        if (this.micUp) this.set('mic-muted');
        break;
      case 'unmuted':
        if (this.health === 'mic-muted') this.maybeOk();
        break;
      case 'devicechange': {
        // D4: the default input changed (headset plugged in, Bluetooth hands-free…):
        // follow it, once. A capture that ended is handled the same way.
        const changed = !!m.defaultInput && this.defaultInput != null && m.defaultInput !== this.defaultInput;
        if (m.defaultInput) this.defaultInput = m.defaultInput;
        // REVIEW-6 N6-2: don't jump to a Bluetooth hands-free mic (it puts the
        // headset into call mode) while the current microphone is still there;
        // offer it instead ("Default microphone changed to … · Use it").
        if (changed && this.micUp && m.live !== false && isHandsFree(m.defaultInput!) && (m.inputs ?? []).includes(this.device)) {
          this.pendingDefault = m.defaultInput!;
          this.cb.health(this.health, this.detail);
          break;
        }
        if (changed) this.pendingDefault = '';
        if (this.micUp && (m.live === false || changed)) {
          this.micUp = false;
          this.set('restarting', changed ? 'the default microphone changed' : 'device change');
          this.restart('mic', changed ? 'the default microphone changed' : 'device change', 500);
        }
        break;
      }
      case 'stats':
        this.stats(m);
        break;
    }
  }

  private stats(m: MicReport) {
    if (!this.micUp) return;
    const now = this.now();
    if (m.frames != null && m.frames !== this.lastFrames) {
      this.lastFrames = m.frames;
      this.lastFrameAt = now;
    }
    if (m.track === 'ended' || now - this.lastFrameAt >= STALL_MS) {
      this.micUp = false;
      const why = m.track === 'ended' ? 'capture ended' : `no audio for ${Math.round((now - this.lastFrameAt) / 1000)} s`;
      this.set('mic-lost', why);
      this.restart('mic', why);
      return;
    }
    // D1: frames reach the mic window but the engine isn't processing them.
    if (this.engineUp && now - this.lastFrameAt < STALL_MS && now - this.engineFrameAt >= ENGINE_STALL_MS) {
      this.engineUp = false;
      this.set('engine-error', 'the speech engine stopped processing audio');
      this.restart('engine', 'the speech engine stopped processing audio');
      return;
    }
    if (this.health === 'mic-muted') return;
    if (m.peak === 0) {
      this.silentSince ||= now;
      if (now - this.silentSince >= SILENT_MS && this.health !== 'silent') {
        this.set('silent');
        // D3: ONE fresh capture per silence episode (a stuck driver), spaced out;
        // after that just keep saying so (no restart loop, no deaf windows).
        if (!this.silentEpisodeRestarted && now - this.lastSilentRestartAt >= SILENT_RESTART_GAP_MS) {
          this.silentEpisodeRestarted = true;
          this.lastSilentRestartAt = now;
          this.restart('mic', 'the microphone sent only silence', 2000);
        }
      }
    } else {
      this.silentSince = 0;
      this.silentEpisodeRestarted = false;
      if (this.health === 'silent') this.set('ok');
    }
    if (this.health === 'ok' && now - this.healthySince > 60_000) this.attempt = 0;
  }

  /** Called every ~2 s: if the mic window stops reporting altogether, that's a stall too. */
  tick() {
    if (this.on && this.micUp && this.now() - this.lastFrameAt >= STALL_MS + 4000) this.stats({ state: 'stats' });
  }
}
