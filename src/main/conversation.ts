// The conversation state machine, free of Electron so it can be driven by
// tests with a fake backend, fake voice and fake panel (test/app-conversation).
//
// Owns: when a summon continues vs. starts a conversation (V1), local fast
// paths and closers (V6), the busy run and its kill switch with an abort
// watchdog (B2), what speech means while busy — stop / yes / no / queue (B3),
// speaking replies and only then opening the follow-up window, with an echo
// guard (V2, V3), and whether a blur may dismiss the panel (V4).

import { CLAIM_VERBS, LOCAL_ACTION, toolsBacking, type ClaimKind } from './claims';
import { farewellFor, isPureFarewell } from '../shared/smalltalk';
import { classifyBusyUtterance, endsWithOpenQuestion, isBareNo, isGenericCloser, stripGenericCloser, invitesClose, asksToConfirm, offersSomething, answerLocally, isClosing, isSignOff, isSoftClose, looksLikeGoodbye } from '../shared/smalltalk';
import { looksLikeHandle } from '../shared/names';
import { isEchoOf, SentenceStreamer, toSpeech } from '../shared/speech';
import type { ProviderEvent, ProviderId, Settings } from '../shared/types';
import type { ProviderAdapter, SendRequest } from './providers/types';
import type { RunState } from './tools';
import type { WeatherDay } from './weather';

export interface Conversation {
  provider: ProviderId;
  sessionId?: string;
  targetHwnd: number | null;
  lastActivity: number;
  turns: number;
  /** Started by voice → speak replies (default mode) and listen for follow-ups. */
  voice: boolean;
  /** Last thing Cadabra said, for the echo guard and "closer" context. */
  lastReply?: string;
}

export interface ConvHost {
  settings(): Settings;
  provider(id: ProviderId): ProviderAdapter;
  ui: {
    event(ev: ProviderEvent): void;
    busy(b: boolean): void;
    userEcho(text: string, via: 'voice' | 'typed'): void;
    notice(text: string, tone?: 'info' | 'warn'): void;
    dismiss(): void;
    panelVisible(): boolean;
    /** Round 10.5: the user clicked into the panel (typing) — silence doesn't dismiss it then. */
    panelFocused?(): boolean;
  };
  voice: {
    /** Voice engine is running (wake word / follow-ups possible). */
    enabled(): boolean;
    /** Speak and resolve when the speech has ENDED (or a length-based timeout). */
    speak(text: string): Promise<void>;
    stopSpeaking(): void;
    /** Listen for a follow-up without the wake word for `ms`; 0 disarms. */
    armFollowUp(ms: number): void;
    /**
     * Round 5: open a speech stream: sentences are spoken as they are pushed
     * (the first plays while the model is still writing); end() resolves when
     * the speech has finished.
     */
    openStream?(): Promise<{ push(sentences: string[]): void; end(): Promise<void>; cancel?(): void }>;
  };
  gate: { beginRun(): void; stop(): void };
  /** Round 12.5: why a backend run can't start now (another channel is working), or null. */
  blocked?(): string | null;
  /** Round 12.6: offer to stop the other channel's run and continue (true = proceed). */
  takeOver?(): Promise<boolean>;
  setRun(run: RunState | null): void;
  /** Build the per-turn run state and context the backend sees. */
  buildTurn(text: string, signal: AbortSignal, conv: Conversation, voiceTurn: boolean): { run: RunState; request: Omit<SendRequest, 'signal' | 'prompt' | 'resumeId' | 'model'> };
  /** Round 7: the weather fast path (null = not a weather question). */
  localWeather?(text: string): Promise<{ text: string; askCity?: WeatherDay } | null>;
  /** Round 7: save "Your location" (returns the saved city). */
  rememberLocation?(city: string): string;
  /** Round 5: voice turns may use the backend's fast model. */
  model(id: ProviderId, opts?: { voice?: boolean }): string;
  /** "open spotify" etc. Returns the reply if handled locally. */
  localLaunch(text: string): Promise<string | null>;
  /** Settings intents ("switch to copilot"). Returns the reply if handled. */
  localIntent(text: string): Promise<string | null>;
  hasPendingConfirm(): boolean;
  resolveConfirm(allowed: boolean): void;
  rejectConfirms(): void;
  afterRun(): void;
  now(): number;
}

export const CONTINUE_VOICE_MS = 3 * 60_000;
export const CONTINUE_SAME_WINDOW_MS = 15 * 60_000;
export const CONTINUE_OTHER_WINDOW_MS = 2 * 60_000;
export const ABORT_WATCHDOG_MS = 2500;
export const FOLLOWUP_ARM_DELAY_MS = 450;
/** Round 5: say "One moment." only if a spoken backend reply hasn't started after this long… */
export const ACK_AFTER_MS = 1500;
/** …and at most once in this long (never for local fast paths). */
export const ACK_EVERY_MS = 60_000;
/** Round 11: say "Still on it." when a voice turn has only been using tools for this long. */
export const PROGRESS_AFTER_MS = 8000;

export interface ToolOutcome {
  name: string;
  ok: boolean;
  code: string;
}

/** Round 12.7: built from the tool registry (src/main/claims.ts); app-side actions count as "local:<kind>". */
const CLAIMS: { verbs: string; tools: string[]; verb: string }[] = (Object.keys(CLAIM_VERBS) as ClaimKind[]).map((k) => ({
  verbs: CLAIM_VERBS[k].verbs,
  tools: [...toolsBacking(k), `local:${k}`],
  verb: CLAIM_VERBS[k].verb,
}));

/**
 * Round 11.5 (REVIEW-11 #2): only the assistant's OWN first-person action claims count —
 * "I've typed …", "I clicked …", "I just opened …", "Done — sent.", "Typed it." —
 * never reported facts ("Microsoft opened a store", "he sent the invoice",
 * "your build ran", "I see the store opened").
 */
function claimRe(verbs: string): RegExp {
  const adv = String.raw`(?:(?:also|just|then|now|already|successfully|quickly|have|went ahead and|gone ahead and)\s+)*`;
  const subj = String.raw`(?:i|i'?ve|i have)\s+`;
  return new RegExp(
    [
      // "I've typed it", "…, and I clicked Directions"
      String.raw`(?:^|[,;:—–-]\s*|\band\s+)` + subj + adv + `(?:${verbs})` + String.raw`\b`,
      // "I've opened Notepad and typed 622322422"
      String.raw`\b` + subj + adv + String.raw`\w+(?:\s+\S+){0,6}?\s+and\s+` + adv + `(?:${verbs})` + String.raw`\b`,
      // "Done — sent.", "Typed it."
      String.raw`^(?:(?:done|okay|ok|all set|great|there you go)[\s,.!:—–-]+)?` + `(?:${verbs})` + String.raw`\b`,
    ].join('|'),
    'i',
  );
}

const WHY: Record<string, string> = {
  declined: 'you said no',
  blocked: 'it was blocked for safety',
  stopped: 'it was stopped',
  limit: 'it hit the action limit',
  confirm_required: 'it needed your OK',
  error: 'it failed',
  threw: 'it failed',
};

/**
 * Round 11: does the reply claim an action ("I typed …", "I've clicked …") that
 * no successful tool call backs up? Returns a short truthful correction, or
 * null. Negated sentences ("I couldn't type …") are not claims.
 */
export function honestyCorrection(reply: string, results: readonly ToolOutcome[]): string | null {
  // Round 12.7: curly apostrophes ("I’ve") read like straight ones.
  const sentences = reply.replace(/[‘’]/g, "'").split(/(?<=[.!?])\s+|\n+/).filter((x) => x.trim());
  const fixes: string[] = [];
  for (const c of CLAIMS) {
    const re = claimRe(c.verbs);
    const claimed = sentences.some((x) => re.test(x.trim()) && !/\b(couldn'?t|can'?t|cannot|wasn'?t|weren'?t|didn'?t|did not|not|unable|failed|won'?t|will|i'?ll|going to|want me to|should i|shall i|let me|if you)\b/i.test(x));
    if (!claimed) continue;
    if (results.some((r) => c.tools.includes(r.name) && r.ok)) continue;
    const failed = [...results].reverse().find((r) => c.tools.includes(r.name) && !r.ok);
    fixes.push(failed ? `I couldn't ${c.verb}: ${WHY[failed.code] ?? 'it failed'}.` : `I didn't actually ${c.verb}.`);
  }
  if (!fixes.length) return null;
  return `Correction: ${[...new Set(fixes)].join(' ')}`;
}

/** Round 10.6: after an acknowledgement alone ("okay"), wait this long for more speech before closing. */
export const ACK_CLOSE_WAIT_MS = 1000;

/**
 * Round 10.6: how long a reply stays readable after the follow-up window ends
 * with silence: 0 for short spoken answers (the panel goes away at once);
 * 10–30 s (by length) for replies with links / sources, lists or more than two
 * sentences.
 */
export function readingGraceMs(reply: string): number {
  const t = reply.trim();
  if (!t) return 0;
  const links = /https?:\/\/|\]\(|^sources?:/im.test(t);
  const list = /^\s*([-*•]|\d+[.)])\s/m.test(t);
  const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean).length;
  if (!links && !list && sentences <= 2) return 0;
  const words = t.split(/\s+/).length;
  return Math.min(30_000, Math.max(10_000, words * 300));
}

/** Round 8: "did I get an email from Sam today?", "any new mail?", "check my Gmail". */
export function looksLikeEmailQuestion(text: string): boolean {
  return /\b(e-?mails?|gmail|inbox)\b|\b(any|new|my) mail\b|\bmail from\b/i.test(text);
}

/**
 * Round 4.5 (hands-on: "it stopped responding"): a backend that goes silent
 * mid-turn (no event at all for this long) is given up on and reset, so
 * Cadabra can never stay "busy" forever without the user pressing Esc.
 */
export const BACKEND_IDLE_MS = 120_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ConversationController {
  conversation: Conversation | null = null;
  private abort: AbortController | null = null;
  private queue: { text: string; via: 'voice' | 'typed' }[] = [];
  private tts = false;
  private followUpArmed = false;
  /** When Cadabra last finished speaking (echo guard timing). */
  private ttsEndedAt = 0;
  private lastSpoken = '';

  /** Overridable in tests. */
  idleMs = BACKEND_IDLE_MS;
  ackAfterMs = ACK_AFTER_MS;
  private lastAckAt = -Infinity;

  constructor(private readonly h: ConvHost) {}

  get busy(): boolean {
    return !!this.abort;
  }

  get speaking(): boolean {
    return this.tts;
  }

  get listeningForFollowUp(): boolean {
    return this.followUpArmed;
  }

  /** The engine reports the follow-up window closed / heard speech. */
  followUpEnded(): void {
    this.followUpArmed = false;
  }

  /**
   * Round 10.5 (user: "it should stop listening and go away"): the wake-free
   * window after a spoken reply ran out with nothing said. The panel dissolves
   * and the mic is back to wake-word-only; the conversation's context is kept
   * for the 3-minute continuation ("<name>, …" picks up where it left off).
   */
  followUpExpired(force = false): void {
    const was = this.followUpArmed || force;
    this.followUpArmed = false;
    if (!was || this.busy || this.tts || this.h.hasPendingConfirm()) return;
    if (!this.h.ui.panelVisible() || this.h.ui.panelFocused?.()) return;
    if (this.conversation) this.conversation.lastActivity = this.h.now();
    // Round 10.6: a long or linked reply stays readable for a while (not listening;
    // click-away / Esc still close it), then goes away.
    const grace = readingGraceMs(this.conversation?.lastReply ?? '');
    if (grace > 0) {
      const seq = this.turnSeq;
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        if (seq !== this.turnSeq || this.busy || this.tts || this.followUpArmed || this.h.hasPendingConfirm()) return;
        if (!this.h.ui.panelVisible() || this.h.ui.panelFocused?.()) return;
        this.h.ui.dismiss();
      }, grace);
      (this.graceTimer as { unref?: () => void }).unref?.();
      return;
    }
    this.h.ui.dismiss();
  }

  /** Round 10.6: the follow-up capture started (the user is still talking): a pending acknowledgement-close waits. */
  followUpHeard(): void {
    this.followUpArmed = false;
    this.cancelPendingClose();
  }

  private cancelPendingClose() {
    if (this.pendingClose) clearTimeout(this.pendingClose);
    this.pendingClose = null;
  }

  /** Round 10.6: counts turns (stale timers check it). */
  private turnSeq = 0;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Round 10.6: "okay…" — closing in ~1 s unless the user keeps talking. */
  private pendingClose: ReturnType<typeof setTimeout> | null = null;

  /**
   * V1: does a summon continue the current conversation?
   * - a voice conversation continues for 3 min regardless of which window is under the cursor;
   * - the same window continues for 15 min;
   * - a different window starts fresh only after 2 min idle;
   * - a different backend always starts fresh.
   */
  shouldStartFresh(targetHwnd: number | null, opts: { voice?: boolean } = {}): boolean {
    const c = this.conversation;
    if (!c) return true;
    const s = this.h.settings();
    if (c.provider !== s.provider) return true;
    const idle = this.h.now() - c.lastActivity;
    if ((c.voice || opts.voice) && idle < CONTINUE_VOICE_MS) return false;
    if (c.targetHwnd === targetHwnd) return idle > CONTINUE_SAME_WINDOW_MS;
    return idle > CONTINUE_OTHER_WINDOW_MS;
  }

  /** Called on every summon. Returns whether a fresh conversation started. */
  summon(targetHwnd: number | null, opts: { voice?: boolean } = {}): boolean {
    const fresh = this.shouldStartFresh(targetHwnd, opts);
    if (fresh) {
      this.h.provider(this.h.settings().provider).reset?.();
      this.conversation = { provider: this.h.settings().provider, targetHwnd, lastActivity: this.h.now(), turns: 0, voice: !!opts.voice };
    } else if (this.conversation) {
      this.conversation.targetHwnd = targetHwnd ?? this.conversation.targetHwnd;
    }
    return fresh;
  }

  newChat(): void {
    this.h.provider(this.h.settings().provider).reset?.();
    this.conversation = null;
  }

  /**
   * V4 / REVIEW-2 #9: may a blur (click-away) dismiss the panel right now?
   * Not while working, asking, speaking or listening for a follow-up. Once the
   * follow-up window has expired, click-away works again (the 3-minute voice
   * *continuation* is kept, the stickiness is not).
   */
  blurMayDismiss(): boolean {
    return !(this.busy || this.h.hasPendingConfirm() || this.tts || this.followUpArmed);
  }

  /** Esc / "stop": abort the run, refuse further actions, stop talking. */
  cancel(note = 'Stopped.'): void {
    this.h.voice.stopSpeaking();
    if (!this.abort) return;
    this.h.gate.stop();
    this.abort.abort();
    // REVIEW-3 N4-R: late tool calls from the stopped turn must not land in the next run.
    this.h.provider(this.h.settings().provider).onAbort?.();
    this.h.rejectConfirms();
    this.queue = [];
    this.h.ui.notice(note, 'info');
  }

  private ensureConversation(via: 'voice' | 'typed'): Conversation {
    if (!this.conversation) this.conversation = { provider: this.h.settings().provider, targetHwnd: null, lastActivity: this.h.now(), turns: 0, voice: via === 'voice' };
    if (via === 'voice' && this.conversation.turns === 0) this.conversation.voice = true;
    return this.conversation;
  }

  /**
   * A transcript from the voice engine. `followUp` = heard in the follow-up
   * window without the wake word. Returns false when it was ignored.
   */
  async onVoice(request: string, followUp: boolean, startedAt?: number): Promise<boolean> {
    const req = request.trim();
    if (!this.acceptVoice(req, followUp, startedAt)) return false;
    await this.send(req, 'voice');
    return true;
  }

  /**
   * REVIEW-2 #9: filter echo and noise BEFORE anything is shown.
   * Echo = the heard words are a contiguous piece of what Cadabra just said,
   * and the speech started within 1.5 s of Cadabra finishing (or while it spoke).
   * A real reply that merely shares words ("can you help me with it") is kept.
   */
  acceptVoice(request: string, followUp: boolean, startedAt?: number): boolean {
    const req = request.trim();
    if (!req) return false;
    if (!followUp) return true;
    const spoken = this.lastSpoken || toSpeech(this.conversation?.lastReply ?? '');
    const start = startedAt ?? this.h.now();
    const nearTts = this.tts || (this.ttsEndedAt > 0 && start - this.ttsEndedAt < 1500);
    if (spoken && nearTts && isEchoOf(req, spoken)) return false;
    // "Which city should I use for weather?" → a one-word answer ("Seattle") is real.
    if (this.awaitingCity) return true;
    // Very short fragments (not closers / yes / no / stop) are noise.
    const words = req.split(/\s+/).filter(Boolean).length;
    if (words < 2 && classifyBusyUtterance(req) === 'other' && !answerLocally(req, { now: new Date(this.h.now()), firstTurn: false, voice: true })) return false;
    return true;
  }

  /**
   * REVIEW-2 #5: a confirm card during a voice conversation is spoken, then a
   * wake-free yes/no window opens. Returns false when it isn't a voice turn.
   */
  async speakConfirm(spoken: string): Promise<boolean> {
    const c = this.conversation;
    if (!c?.voice || !this.h.voice.enabled()) return false;
    this.tts = true;
    try {
      await this.h.voice.speak(spoken);
    } finally {
      this.tts = false;
      this.ttsEndedAt = this.h.now();
      this.lastSpoken = spoken;
    }
    await sleep(FOLLOWUP_ARM_DELAY_MS);
    if (this.h.hasPendingConfirm()) {
      this.followUpArmed = true;
      this.h.voice.armFollowUp(Math.max(8, this.h.settings().voice.followUpSeconds) * 1000);
    }
    return true;
  }

  async send(raw: string, via: 'voice' | 'typed' = 'typed'): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    this.turnSeq++;
    this.cancelPendingClose();

    if (!this.abort) {
      // REVIEW-2 N3: claim the conversation synchronously, before any await, so a
      // second send (typed + voice, or a queued item) can't start a second run.
      const claim = new AbortController();
      this.abort = claim;
      try {
        await this.handle(text, via, claim);
      } finally {
        if (this.abort === claim) this.abort = null;
      }
      const queued = this.queue.shift();
      if (queued) await this.send(queued.text, queued.via);
      return;
    }
    return this.handle(text, via, null);
  }

  private async handle(text: string, via: 'voice' | 'typed', claim: AbortController | null): Promise<void> {
    const s = this.h.settings();

    // B3: while busy, speech/typing is a command to the run, or queued.
    if (!claim) {
      const kind = classifyBusyUtterance(text, s.voice.wakeWord);
      if (kind === 'stop') return this.cancel('Stopped.');
      if ((kind === 'yes' || kind === 'no') && this.h.hasPendingConfirm()) {
        this.h.resolveConfirm(kind === 'yes');
        return;
      }
      this.queue.push({ text, via });
      this.h.ui.notice(`I'll do that next: “${text.length > 60 ? text.slice(0, 57) + '…' : text}”`, 'info');
      return;
    }

    if (via === 'voice') this.h.ui.userEcho(text, via);
    this.h.voice.armFollowUp(0);
    this.followUpArmed = false;
    const conv = this.ensureConversation(via);
    const voiceTurn = via === 'voice';

    // Local fast paths: presence, time/date, closers — no backend, sub-second.
    // Never greet with a handle-like name (seen live: "Good evening jdoe42").
    const name = s.displayName && !looksLikeHandle(s.displayName) ? s.displayName : undefined;
    const local = answerLocally(text, { now: new Date(this.h.now()), name, firstTurn: conv.turns === 0, voice: voiceTurn || conv.voice, wakeWord: s.voice.wakeWord });
    // V6: a bare "no" only closes after an open "anything else?" or in a voice conversation.
    // REVIEW-7 W7-4: "got it" / "understood" / "later" alone close only after an open question.
    const closes =
      local?.kind === 'close' &&
      (!isBareNo(text) || ((conv.voice || endsWithOpenQuestion(conv.lastReply ?? '')) && !asksToConfirm(conv.lastReply ?? ''))) &&
      (!isSoftClose(text, s.voice.wakeWord) || invitesClose(conv.lastReply ?? ''));
    // Local answers release the claim before speaking (the follow-up may arm).
    const release = () => {
      if (this.abort === claim) this.abort = null;
    };
    // REVIEW-10 #4: "Want me to open it?" → "no" declines the offer; the conversation stays open.
    if (isBareNo(text) && offersSomething(conv.lastReply ?? '')) {
      this.finishLocal(conv, 'Okay.');
      release();
      await this.replyOutLoud('Okay.', voiceTurn, 1);
      return;
    }
    if (closes) {
      release();
      // Round 10.6: "Okay… (pause) now open Spotify" is one turn: after an
      // acknowledgement alone, wait ~1 s (listening) before closing. Explicit
      // goodbyes ("thanks", "bye", "goodnight") close at once.
      if (voiceTurn && isSoftClose(text, s.voice.wakeWord) && this.h.voice.enabled()) {
        const bye = farewellFor(text, this.closes++, s.voice.wakeWord);
        this.followUpArmed = true;
        this.h.voice.armFollowUp(ACK_CLOSE_WAIT_MS + 400);
        this.pendingClose = setTimeout(() => {
          this.pendingClose = null;
          void this.closeGracefully(bye, voiceTurn);
        }, ACK_CLOSE_WAIT_MS);
        return;
      }
      return this.closeGracefully(farewellFor(text, this.closes++, s.voice.wakeWord), voiceTurn);
    }
    if (local?.kind === 'answer') {
      this.finishLocal(conv, local.text);
      release();
      // Local answers are Cadabra's own short lines: say all of them.
      await this.replyOutLoud(local.text, voiceTurn, 4);
      return;
    }
    // Round 7: "Which city should I use for weather?" → this utterance is the city.
    if (this.awaitingCity && this.h.now() - this.awaitingCity.at < 120_000 && text.split(/\s+/).length <= 6 && this.h.rememberLocation && this.h.localWeather) {
      const day = this.awaitingCity.day;
      this.awaitingCity = null;
      const city = this.h.rememberLocation(text);
      const w = await this.h.localWeather(`what's the weather ${day === 'today' ? 'today' : day === 'now' ? 'now' : day === 'weekend' ? 'this weekend' : day === 'week' ? 'next week' : day} in ${city}`);
      if (w) {
        this.finishLocal(conv, w.text);
        release();
        await this.replyOutLoud(w.text, voiceTurn, 3);
        return;
      }
    }
    this.awaitingCity = null;
    // Round 7: weather answers locally in about a second (Open-Meteo), no backend.
    const w = await this.h.localWeather?.(text);
    if (w) {
      if (w.askCity) this.awaitingCity = { day: w.askCity, at: this.h.now() };
      this.finishLocal(conv, w.text);
      release();
      await this.replyOutLoud(w.text, voiceTurn, 3);
      return;
    }
    const launched = await this.h.localLaunch(text);
    if (launched != null) {
      this.finishLocal(conv, launched);
      release();
      if (voiceTurn || conv.voice) await this.replyOutLoud(launched.replace(/\*\*/g, ''), voiceTurn);
      return;
    }
    const intent = await this.h.localIntent(text);
    if (intent != null) {
      this.finishLocal(conv, intent);
      return;
    }
    if (claim.signal.aborted) return; // "stop" arrived while we were checking local paths
    await this.runBackend(text, conv, voiceTurn, claim);
  }

  private finishLocal(conv: Conversation, reply: string) {
    conv.turns += 1;
    conv.lastActivity = this.h.now();
    conv.lastReply = reply;
    this.h.ui.event({ type: 'text', delta: reply });
    this.h.ui.event({ type: 'done' });
    this.h.ui.busy(false);
  }

  private async runBackend(text: string, conv: Conversation, voiceTurn: boolean, abort: AbortController) {
    const s = this.h.settings();
    const providerId = s.provider;
    const provider = this.h.provider(providerId);
    // Round 12.5: one backend run at a time across channels (PC / WhatsApp).
    const blocked = this.h.blocked?.();
    if (blocked && !(await this.h.takeOver?.().catch(() => false))) {
      this.h.ui.event({ type: 'text', delta: blocked });
      this.h.ui.event({ type: 'done' });
      return;
    }
    this.h.gate.beginRun();
    const { run, request } = this.h.buildTurn(text, abort.signal, conv, voiceTurn);
    this.h.setRun(run);
    this.h.ui.busy(true);
    let answer = '';
    let finished = false;
    // Round 5: speak while the reply streams in (voice conversations).
    // (CADABRA_NO_STREAM: the round-4 behaviour, for before/after measurements.)
    const live = this.shouldSpeak(voiceTurn) && !!this.h.voice.openStream && !process.env.CADABRA_NO_STREAM;
    // Round 7: up to 4 short lines (news / sports headlines); replies are still asked to be brief.
    const streamer = new SentenceStreamer(4, 480);
    let speech: Promise<{ push(sentences: string[]): void; end(): Promise<void>; cancel?(): void }> | null = null;
    let spokeAny = false;
    const say = (raw: string[]) => {
      // Round 10: a generic "Anything else?" is never spoken.
      const xs = raw.filter((x) => !isGenericCloser(x));
      if (!xs.length || abort.signal.aborted) return;
      if (!speech) {
        this.tts = true;
        speech = this.h.voice.openStream!();
      }
      spokeAny = true;
      void speech.then((sp) => sp.push(xs));
    };
    // Round 8: email questions get "One moment, I'll check." right away (the search takes a few seconds).
    if (live && voiceTurn && looksLikeEmailQuestion(text)) {
      this.lastAckAt = this.h.now();
      say(['One moment, I’ll check.']);
    }
    const ackTimer =
      live && voiceTurn
        ? setTimeout(() => {
            if (spokeAny || abort.signal.aborted || this.h.now() - this.lastAckAt < ACK_EVERY_MS) return;
            this.lastAckAt = this.h.now();
            say(['One moment.']);
          }, this.ackAfterMs)
        : null;
    const stream = provider.send({ ...request, prompt: text, model: this.h.model(providerId, { voice: voiceTurn }), resumeId: conv.provider === providerId ? conv.sessionId : undefined, signal: abort.signal });
    const it = stream[Symbol.asyncIterator]();
    // B2: once aborted, the backend gets ABORT_WATCHDOG_MS to wind down; then we
    // reset it, force "done" and clear busy, so Cadabra can never stay stuck.
    const watchdog = new Promise<'timeout'>((res) => abort.signal.addEventListener('abort', () => setTimeout(() => res('timeout'), ABORT_WATCHDOG_MS), { once: true }));
    const t0 = this.h.now();
    let events = 0;
    let saidProgress = false;
    // The backend's own tools (web fetch) also count as actions that happened.
    const providerTools: ToolOutcome[] = [];
    console.log(`[conv] run start: ${providerId}, ${voiceTurn ? 'voice' : 'typed'}, turn ${conv.turns + 1}`);
    try {
      while (true) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<'idle'>((res) => (idleTimer = setTimeout(() => res('idle'), this.idleMs)));
        const r = await Promise.race([it.next(), watchdog, idle]);
        clearTimeout(idleTimer);
        if (r === 'timeout') {
          console.warn(`[conv] ${providerId} did not stop within ${ABORT_WATCHDOG_MS} ms after Esc; reset`);
          provider.reset?.();
          void it.return?.();
          this.h.ui.event({ type: 'done' });
          finished = true;
          break;
        }
        if (r === 'idle') {
          console.warn(`[conv] ${providerId} sent nothing for ${Math.round(this.idleMs / 1000)} s (after ${events} events); giving up and resetting it`);
          provider.reset?.();
          void it.return?.();
          this.h.ui.event({ type: 'error', message: `No reply from the AI for ${Math.round(this.idleMs / 1000)} seconds, so I stopped waiting and restarted the connection. Please try again.` });
          finished = true;
          break;
        }
        events++;
        if (r.done) break;
        const ev = r.value;
        if (ev.type === 'session') conv.sessionId = ev.sessionId;
        if (ev.type === 'done' && ev.sessionId) conv.sessionId = ev.sessionId;
        // Round 8 (W7-1): remember what this turn's web search returned; fetching
        // those pages is fine, anything else needs a card.
        if (ev.type === 'web-results') {
          const rr = run as { webUrls?: string[]; webContent?: boolean };
          (rr.webUrls ??= []).push(...ev.urls);
          rr.webContent = true; // round 11.5: web content is in the turn
          continue;
        }
        if (ev.type === 'text') {
          answer += ev.delta;
          if (live) say(streamer.push(ev.delta));
        }
        if (ev.type === 'tool' && /web|fetch|search/i.test(ev.name) && !/^mcp__/.test(ev.name)) (run as { webContent?: boolean }).webContent = true;
        if (ev.type === 'tool' && ev.phase === 'end' && !/^mcp__/.test(ev.name)) providerTools.push({ name: ev.name, ok: ev.ok !== false, code: ev.ok === false ? 'error' : 'ok' });
        // Round 11: a long tool-only stretch on a voice turn gets one short progress line.
        if (ev.type === 'tool' && ev.phase === 'start' && voiceTurn && live && !answer.trim() && !saidProgress && this.h.now() - t0 > PROGRESS_AFTER_MS) {
          saidProgress = true;
          say(['Still on it.']);
        }
        // Round 11 (hands-on: "I've opened Notepad and typed 622322422" when nothing
        // was typed): a reply may only claim what the tools confirm.
        if (ev.type === 'done') {
          // Round 12.7: app-side actions in the turn (run.localActions) count as confirmations too.
          const local = ((run as { localActions?: ClaimKind[] }).localActions ?? []).map(LOCAL_ACTION);
          const fix = honestyCorrection(answer, [...((run as { toolResults?: ToolOutcome[] }).toolResults ?? []), ...providerTools, ...local]);
          if (fix) {
            console.log(`[conv] honesty: the reply claimed an action the tools didn't confirm; corrected`);
            answer += `\n\n${fix}`;
            this.h.ui.event({ type: 'text', delta: `\n\n${fix}` });
            if (live) say([fix]);
          }
        }
        this.h.ui.event(ev);
        if (ev.type === 'error') console.warn(`[conv] ${providerId} error: ${ev.message}`);
        if (ev.type === 'done' || ev.type === 'error') {
          finished = true;
          break;
        }
      }
      if (!finished) this.h.ui.event({ type: 'done' });
    } catch (e) {
      console.warn(`[conv] ${providerId} threw: ${(e as Error).message}`);
      this.h.ui.event({ type: 'error', message: (e as Error).message });
    } finally {
      console.log(`[conv] run end: ${providerId}, ${events} events, ${this.h.now() - t0} ms${abort.signal.aborted ? ', stopped' : ''}`);
      conv.lastActivity = this.h.now();
      conv.turns += 1;
      if (answer) conv.lastReply = answer;
      this.h.setRun(null);
      this.h.ui.busy(false);
      this.h.afterRun();
    }
    if (this.abort === abort) this.abort = null;
    if (ackTimer) clearTimeout(ackTimer);
    // The rest of the reply (a short reply may not have opened the stream yet).
    if (live && !abort.signal.aborted) say(streamer.flush());
    // Round 7: the user said goodbye and the AI just said goodbye back: close.
    // Round 10.5: also when the model called end_conversation, when its whole reply
    // is a farewell, or when the user's turn was a goodbye (a closing utterance
    // never gets a reply that reopens the listening window).
    const userBye = (isClosing(text, s.voice.wakeWord) && !isSoftClose(text, s.voice.wakeWord)) || looksLikeGoodbye(text);
    const signOff = !abort.signal.aborted && (!!(run as { endConversation?: boolean }).endConversation || userBye || isPureFarewell(answer) || (userBye && isSignOff(answer)));
    // (assigned inside say(), which TypeScript can't see)
    const opened = speech as Promise<{ push(sentences: string[]): void; end(): Promise<void>; cancel?(): void }> | null;
    if (opened) {
      const sp = await opened;
      try {
        // REVIEW-5 V5-1: after Esc / "stop" nothing more may be spoken.
        if (abort.signal.aborted) sp.cancel?.();
        else await sp.end();
      } finally {
        this.tts = false;
        this.ttsEndedAt = this.h.now();
        this.lastSpoken = toSpeech(answer, 2);
      }
      if (signOff) return this.closeGracefully(answer, voiceTurn, false);
      if (!abort.signal.aborted && (voiceTurn || !!this.conversation?.voice)) {
        // Let the speaker tail die away before listening (echo guard, part 1).
        await sleep(FOLLOWUP_ARM_DELAY_MS);
        this.armFollowUp();
      }
      return;
    }
    if (signOff) {
      if (this.shouldSpeak(voiceTurn)) await this.h.voice.speak(toSpeech(answer, 1));
      return this.closeGracefully(answer, voiceTurn, false);
    }
    if (!abort.signal.aborted) await this.replyOutLoud(answer, voiceTurn);
  }

  private shouldSpeak(voiceTurn: boolean): boolean {
    const mode = this.h.settings().voice.speakReplies;
    return mode === 'always' || (mode === 'voice' && (voiceTurn || !!this.conversation?.voice));
  }

  /** Speak (when appropriate), wait for the speech to END, then open the follow-up window (V2/V3). */
  private async replyOutLoud(text: string, voiceTurn: boolean, maxSentences = 2) {
    const voiceConv = voiceTurn || !!this.conversation?.voice;
    const said = toSpeech(stripGenericCloser(text), maxSentences);
    if (this.shouldSpeak(voiceTurn) && said) {
      this.tts = true;
      try {
        await this.h.voice.speak(said);
      } finally {
        this.tts = false;
        this.ttsEndedAt = this.h.now();
        this.lastSpoken = said;
      }
      if (voiceConv) {
        // Let the speaker tail die away before listening (echo guard, part 1).
        await sleep(FOLLOWUP_ARM_DELAY_MS);
        this.armFollowUp();
      }
    } else if (voiceConv) this.armFollowUp();
  }

  private armFollowUp() {
    const secs = this.h.settings().voice.followUpSeconds;
    if (secs <= 0 || !this.h.voice.enabled() || this.abort) return;
    // V4: the follow-up window outlives the panel for a voice conversation.
    if (!this.h.ui.panelVisible() && !this.conversation?.voice) return;
    this.followUpArmed = true;
    this.h.voice.armFollowUp(secs * 1000);
  }

  /** "No, thanks" / "That's all": say goodbye, then dissolve once the speech ends. */
  /**
   * Round 7 (user's spec): end the conversation NOW — a very short spoken
   * farewell while the panel dissolves, no follow-up window, and the mic goes
   * back to wake-word-only.
   */
  private async closeGracefully(text: string, voiceTurn: boolean, showText = true) {
    if (showText && text) this.h.ui.event({ type: 'text', delta: text });
    this.h.ui.event({ type: 'done' });
    this.h.ui.busy(false);
    this.h.voice.armFollowUp(0);
    this.followUpArmed = false;
    if (this.conversation) {
      this.conversation.voice = false;
      this.conversation.lastActivity = this.h.now();
    }
    this.h.ui.dismiss();
    if (showText && text && this.shouldSpeak(voiceTurn)) {
      this.tts = true;
      try {
        await this.h.voice.speak(text);
      } finally {
        this.tts = false;
        this.ttsEndedAt = this.h.now();
        this.lastSpoken = text;
      }
    }
  }

  /** Round 7: waiting for the user to name a city for weather. */
  private awaitingCity: { day: WeatherDay; at: number } | null = null;

  /** How many conversations have been closed (varies the farewell sparingly). */
  private closes = 0;
}
