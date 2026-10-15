// Round 8 (user request): spoken welcome quips — no panel — on sign-in, on
// unlock, and when the user comes back after being away. Never when it would
// be rude: another app is using the mic (a call), a full-screen app / game /
// presentation is in front, Focus / Do-not-disturb is on, the speakers are
// muted, quiet hours, or the user is already talking to Cadabra. At most once
// per return. Testable: everything external comes in through GreeterDeps.
import { pickGreeting, timeOfDay, type GreetTrigger } from '../shared/greetings';
import type { GreetingSettings } from '../shared/types';

export interface GreeterDeps {
  now(): number;
  settings(): GreetingSettings;
  /** First name for greetings ('' = none). */
  name(): string;
  dialect(): 'british' | 'southern' | null;
  /** Voice output is set up and Cadabra isn't paused. */
  voiceReady(): boolean;
  /** The panel is open, a run is busy, or voice is capturing. */
  userBusy(): boolean;
  presence(): Promise<{ notificationState: string; speakerMuted: boolean | null } | null>;
  micUsers(): Promise<string[]>;
  speak(text: string): Promise<void>;
  /** Round 10: render this line's audio now so it can play instantly later (best effort). */
  prerender?(text: string): Promise<unknown>;
  /** Round 10: be told about the FIRST input once the user is away (helper hooks). */
  armActivity?(on: boolean): void;
  /** Short wake-free listening window after the greeting (voice-only, no panel). */
  openWindow(ms: number): void;
  saveRecent(ids: string[]): void;
  log(msg: string): void;
}

/** Inside "HH:MM"–"HH:MM" (may wrap midnight)? */
export function inQuietHours(now: Date, start: string, end: string): boolean {
  if (!start || !end) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  const [a, b] = [start, end].map((x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3)));
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

/** Round 9 (R8-5): ~4 s, and only speech near the user's own level counts. */
export const GREETING_WINDOW_MS = 4000;

export class Greeter {
  private awaySince: number | null = null;
  private locked = false;
  private greeting = false;
  private lastGreetAt = -Infinity;
  /** Round 10: the next line, chosen (and pre-rendered) while the user is away. */
  private next: { trigger: GreetTrigger; id: string; text: string; tod: string; day: string } | null = null;

  constructor(private readonly d: GreeterDeps) {}

  /** Why not to greet now ('' = go ahead). Round 10: the slower checks run in parallel. */
  async whyNot(): Promise<string> {
    const s = this.d.settings();
    if (!s.enabled) return 'greetings are off';
    if (!this.d.voiceReady()) return 'voice is off or paused';
    if (inQuietHours(new Date(this.d.now()), s.quietStart, s.quietEnd)) return 'quiet hours';
    if (this.d.userBusy()) return 'already talking to Cadabra';
    const [p, mic] = await Promise.all([this.d.presence().catch(() => null), this.d.micUsers().catch(() => [] as string[])]);
    if (p && p.notificationState !== 'accepts-notifications' && p.notificationState !== 'unknown') return `not a good moment (${p.notificationState})`;
    if (p?.speakerMuted) return 'speakers are muted';
    if (mic.length) return `another app is using the microphone (${mic.map((x) => (x.split(/[\\/]/).pop() ?? x).toLowerCase()).join(', ')})`;
    return '';
  }

  /**
   * Round 10: choose the next line now (while locked / away) and pre-render its
   * audio. A choice from another time of day or day is stale and is re-picked.
   */
  prepare(trigger: GreetTrigger): void {
    if (!this.d.settings().enabled) return;
    const now = new Date(this.d.now());
    const g = pickGreeting({ trigger, now, name: this.d.name(), recent: this.d.settings().recent, dialect: this.d.dialect() });
    this.next = { trigger, id: g.id, text: g.text, tod: timeOfDay(now), day: now.toDateString() };
    // A real reply may cancel a queued pre-render; try once more a little later.
    const render = (retry: boolean) =>
      void this.d
        .prerender?.(g.text)
        ?.then((ok) => {
          if (ok === false && retry && this.next?.text === g.text) setTimeout(() => this.next?.text === g.text && render(false), 3000).unref?.();
        })
        .catch(() => undefined);
    render(true);
  }

  private pick(trigger: GreetTrigger): { id: string; text: string } {
    const now = new Date(this.d.now());
    const n = this.next;
    this.next = null;
    if (n && n.trigger === trigger && n.tod === timeOfDay(now) && n.day === now.toDateString()) return n;
    return pickGreeting({ trigger, now, name: this.d.name(), recent: this.d.settings().recent, dialect: this.d.dialect() });
  }

  async greet(trigger: GreetTrigger, eventAt = this.d.now()): Promise<boolean> {
    // Once per return: never twice within a few minutes (sign-in + logon event, unlock + input).
    if (this.greeting || this.d.now() - this.lastGreetAt < 5 * 60_000) return false;
    this.greeting = true;
    try {
      const why = await this.whyNot();
      if (why) {
        this.d.log(`[greet] skipped ${trigger}: ${why}`);
        return false;
      }
      const s = this.d.settings();
      const g = this.pick(trigger);
      this.d.saveRecent([...s.recent.filter((x) => x !== g.id), g.id].slice(-80));
      this.lastGreetAt = this.d.now();
      this.d.log(`[greet] ${trigger} (${g.id}), decided ${this.d.now() - eventAt} ms after the event`);
      await this.d.speak(g.text);
      this.d.openWindow(GREETING_WINDOW_MS);
      return true;
    } finally {
      this.greeting = false;
    }
  }

  /** Cadabra started at sign-in (launch at login) or a logon event. */
  onLogin(): Promise<boolean> {
    this.awaySince = null;
    return this.greet('login');
  }

  onSession(kind: string, eventAt = this.d.now()): Promise<boolean> | void {
    if (kind === 'lock') {
      this.locked = true;
      this.awaySince ??= this.d.now();
      this.d.armActivity?.(false); // the unlock event covers this return
      this.prepare('unlock');
      return;
    }
    if (kind === 'unlock') {
      this.locked = false;
      this.awaySince = null; // one greeting per return: the unlock one
      return this.greet('unlock', eventAt);
    }
    if (kind === 'logon') return this.onLogin();
  }

  /**
   * Every ~30 s with the input idle time. Away = no input for the configured
   * minutes (with Input Director, using another PC counts as away from this
   * one, which is right). Back = input again.
   */
  tick(idleMs: number): Promise<boolean> | void {
    if (this.locked) return;
    const awayMs = this.d.settings().awayMinutes * 60_000;
    if (idleMs >= awayMs) {
      if (this.awaySince == null) {
        this.awaySince = this.d.now() - idleMs;
        // Round 10: be told about the very first input, and have the line ready.
        this.prepare('return');
        this.d.armActivity?.(true);
      }
      return;
    }
    if (this.awaySince != null && idleMs < 60_000) {
      this.awaySince = null;
      return this.greet('return');
    }
  }

  /** Round 10: the helper saw the first keyboard / mouse input since the user went away. */
  onActivity(eventAt = this.d.now()): Promise<boolean> | void {
    if (this.locked || this.awaySince == null) return;
    this.awaySince = null;
    return this.greet('return', eventAt);
  }

  get isAway(): boolean {
    return this.awaySince != null;
  }

  get isLocked(): boolean {
    return this.locked;
  }
}
