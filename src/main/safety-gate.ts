import { actionHash, autonomyOf, checkObservation, classifyAction, describeAction, grantable, grantClass, reasonId, spokenCard, type ActionRequest } from '../shared/safety';
import type { PermissionGrant, SafetySettings } from '../shared/types';

export class ActionBlockedError extends Error {
  constructor(
    message: string,
    readonly code: 'stopped' | 'blocked' | 'confirm_required' | 'limit' | 'declined',
  ) {
    super(message);
  }
}

/** Card content authored by the gate from the real action (never model prose). */
export interface ConfirmPrompt {
  title: string;
  detail: string;
  risk: string;
  /** Monospace exact payload (command / keys / text), shown verbatim. */
  mono?: string;
  /** The model's own words, shown only as a muted subtitle. */
  subtitle?: string;
  /** 'action' = gate card for a real action; 'question' = the model asking (styled differently, grants nothing). */
  kind?: 'action' | 'question';
  /** Gate-authored sentence to speak in a voice conversation. */
  spoken?: string;
  /** Auto-decline after this long without an answer. */
  timeoutMs?: number;
  /** The window the action targets (for automated harness approval: by handle, never by text). */
  hwnd?: number;
  actionKind?: string;
  /** Round 11: offer "Always allow this in <app/site>" with this label. */
  alwaysLabel?: string;
  /** Round 12.5: where the card goes — the PC panel, or the owner's WhatsApp chat (a code). */
  channel?: Channel;
}

/** Round 12.5 (REVIEW-12 H1): every run belongs to one channel. */
export type Channel = 'pc' | 'whatsapp';

const CLASS_LABEL = { click: 'clicks', type: 'typing', keys: 'key presses', scroll: 'scrolling', open: 'opening pages' } as const;

/** REVIEW-2 N1/N14: an unanswered card is a "no" after this long. */
export const CONFIRM_TIMEOUT_MS = 90_000;

export interface ConfirmUi {
  /** Shows a confirmation card; resolves true only on an explicit user "Allow" ('always' = "Always allow"). Default focus is "Not now". */
  confirm(p: ConfirmPrompt, signal: AbortSignal): Promise<boolean | 'always'>;
}

/** Round 11: where "Always allow" grants are stored. */
export interface GrantStore {
  add(g: PermissionGrant): void;
}

export interface GateRun {
  signal: AbortSignal;
  process?: string;
  title?: string;
  /** The user's own words this turn (risky payloads must trace to these). */
  prompt?: string;
  /** Round 8 taint: untrusted content (an email) entered this turn, so EVERY action needs the user's OK. */
  untrusted?: string;
  /** Round 12.5: the run's channel (its own stop state, action budget and confirm route). Default 'pc'. */
  channel?: Channel;
  /** Round 12.5: the run's autonomy level (a WhatsApp run uses the remote level), overriding settings. */
  autonomy?: 'risky' | 'every' | 'none';
}

/**
 * Code-enforced safety gate. Every action tool calls `authorize()` before it
 * touches the machine. The gate itself renders the confirm card from the real
 * action, and an approval is bound to a hash of {kind, payload, target} and is
 * single-use by default. The per-run action budget is enforced, and an aborted
 * run (Esc) refuses all further actions.
 */
export class SafetyGate {
  /** Round 12.5: per channel, so a PC summon can't clear a WhatsApp stop (or its budget). */
  private actionsUsedBy = new Map<Channel, number>();
  private stoppedBy = new Set<Channel>();
  /** Cards currently open, by action hash (an orphaned retry can't stack a second card). */
  private open = new Set<string>();

  constructor(
    private readonly settings: () => SafetySettings,
    private readonly ui: ConfirmUi,
    _now: () => number = Date.now,
    private readonly grants?: GrantStore,
  ) {}

  /** Reset this channel's per-run counters (call at the start of every user turn on it). */
  beginRun(channel: Channel = 'pc'): void {
    this.actionsUsedBy.set(channel, 0);
    this.stoppedBy.delete(channel);
  }

  /** Stop a channel's run (Esc / "stop"). Other channels are untouched. */
  stop(channel: Channel = 'pc'): void {
    this.stoppedBy.add(channel);
  }

  isStoppedFor(channel: Channel = 'pc'): boolean {
    return this.stoppedBy.has(channel);
  }

  get isStopped(): boolean {
    return this.stoppedBy.has('pc');
  }

  get used(): number {
    return this.actionsUsedBy.get('pc') ?? 0;
  }

  /** The settings for this run: its own autonomy level when it carries one (a WhatsApp run). */
  private settingsFor(run: GateRun): SafetySettings {
    const s = this.settings();
    return run.autonomy ? { ...s, autonomy: run.autonomy, confirmAllActions: run.autonomy === 'every', grants: run.channel === 'whatsapp' ? [] : s.grants } : s;
  }

  assertCanObserve(run: GateRun): void {
    if (this.stoppedBy.has(run.channel ?? 'pc') || run.signal.aborted) throw new ActionBlockedError('Stopped by the user (Esc).', 'stopped');
    const v = checkObservation(this.settings(), run.process, run.title);
    if (v.decision === 'block') throw new ActionBlockedError(v.reasons.join('; '), 'blocked');
  }

  private assertLive(run: GateRun) {
    if (this.stoppedBy.has(run.channel ?? 'pc') || run.signal.aborted) throw new ActionBlockedError('Stopped by the user (Esc). Do not retry.', 'stopped');
  }

  /**
   * Authorize one action. Blocks throw; risky actions prompt the user inline
   * with a gate-authored card and wait. Returns when the action may run.
   */
  async authorize(run: GateRun, req: ActionRequest): Promise<{ reasons: string[]; approved: boolean }> {
    this.assertLive(run);
    const s = this.settingsFor(run);
    const ch = run.channel ?? 'pc';
    if ((this.actionsUsedBy.get(ch) ?? 0) >= s.maxActionsPerRun) {
      throw new ActionBlockedError(`Action limit reached (${s.maxActionsPerRun} per request). Stop and tell the user what is left to do.`, 'limit');
    }
    const full: ActionRequest = { ...req, process: req.process ?? run.process, title: req.title ?? run.title, prompt: req.prompt ?? run.prompt };
    let v = classifyAction(full, s);
    // Email taint (round 8) stays in the default and cautious levels; "Don't ask" means don't ask.
    if (v.decision === 'allow' && run.untrusted && autonomyOf(s) !== 'none') v = { decision: 'confirm', reasons: [...v.reasons, run.untrusted] };
    const ids = [...new Set(v.reasons.map(reasonId))].join(',');
    if (v.decision === 'block') {
      console.log(`[gate] ${full.kind}: refused (${ids})`);
      throw new ActionBlockedError(`Blocked: ${v.reasons.join('; ')}`, 'blocked');
    }

    // Round 11: "Always allow this in <app/site>".
    const cls = grantClass(full.kind);
    let scope: { key: string; label: string } | null = null;
    if (v.decision === 'confirm' && cls && grantable(full, v.reasons) && !run.untrusted) {
      scope = (await full.scope?.().catch(() => null)) ?? null;
      if (scope && (s.grants ?? []).some((g) => g.cls === cls && g.scope === scope!.key)) {
        console.log(`[gate] ${full.kind}: allowed by an "always allow" grant (${ids})`);
        v = { decision: 'allow', reasons: v.reasons };
      }
    }

    let approved = false;
    if (v.decision === 'confirm') {
      // The card is rendered from THIS action and the OK is consumed by it: every
      // risky action (even an identical retry) gets its own confirmation.
      const card = describeAction(full, v.reasons);
      const hash = actionHash(full);
      if (this.open.has(hash)) throw new ActionBlockedError('Cadabra is already asking the user about this exact action. Wait for that answer; do not retry.', 'declined');
      this.open.add(hash);
      let res: 'yes' | 'no' | 'timeout' | 'always';
      try {
        res = await this.ask({ ...card, subtitle: req.description, kind: 'action', spoken: spokenCard(card, full), hwnd: full.hwnd, actionKind: full.kind, channel: ch, alwaysLabel: ch === 'whatsapp' ? undefined :  scope && cls ? (cls === 'open' ? `Always allow opening pages on ${scope.label}` : `Always allow ordinary ${CLASS_LABEL[cls]} in ${scope.label}`) : undefined }, run.signal);
      } finally {
        this.open.delete(hash);
      }
      console.log(`[gate] ${full.kind}: confirm (${ids}) → ${res}`);
      if (res === 'always' && scope && cls) {
        this.grants?.add({ cls, scope: scope.key, label: cls === 'open' ? `Opening pages on ${scope.label}` : `Ordinary ${CLASS_LABEL[cls]} in ${scope.label}`, at: Date.now() });
        res = 'yes';
      }
      this.assertLive(run);
      if (res === 'timeout') throw new ActionBlockedError(`No answer within ${Math.round(CONFIRM_TIMEOUT_MS / 1000)} s, so Cadabra did not do it: ${card.title} Tell the user briefly.`, 'declined');
      if (res === 'no') throw new ActionBlockedError(`The user declined: ${card.title} Do not perform this action; tell them it was not done.`, 'declined');
      approved = true;
    }
    this.actionsUsedBy.set(ch, (this.actionsUsedBy.get(ch) ?? 0) + 1);
    return { reasons: v.reasons, approved };
  }

  /**
   * A plain yes/no question the model can ask (e.g. "Should I send this?").
   * It grants NO action approval — risky actions are always gated by authorize().
   */
  async askUser(run: GateRun, p: { action: string; details?: string }): Promise<boolean> {
    this.assertLive(run);
    const v = checkObservation(this.settings(), run.process, run.title);
    if (v.decision === 'block') throw new ActionBlockedError(v.reasons.join('; '), 'blocked');
    const title = p.action.length > 160 ? `${p.action.slice(0, 160)}…` : p.action;
    return (await this.ask({ title, detail: p.details ?? '', risk: '', kind: 'question', channel: run.channel ?? 'pc', spoken: `${title.replace(/\?*$/, '')}? Say yes or no.` }, run.signal)) === 'yes';
  }

  /** Show a card with a timeout; a missing answer is never a yes. */
  private async ask(p: ConfirmPrompt, runSignal: AbortSignal): Promise<'yes' | 'no' | 'timeout' | 'always'> {
    const timeoutMs = p.timeoutMs ?? CONFIRM_TIMEOUT_MS;
    const ac = new AbortController();
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    const onRunAbort = () => ac.abort();
    runSignal.addEventListener('abort', onRunAbort, { once: true });
    try {
      const ok = await this.ui.confirm({ ...p, timeoutMs }, ac.signal);
      return ok === 'always' ? (p.alwaysLabel ? 'always' : 'yes') : ok ? 'yes' : timedOut ? 'timeout' : 'no';
    } finally {
      clearTimeout(t);
      runSignal.removeEventListener('abort', onRunAbort);
    }
  }
}
