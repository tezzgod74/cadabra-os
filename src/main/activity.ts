// 0.9.4: per-channel progress captions. Tool progress ("On it", the ghost
// cursor's caption, "Checking your email…") belongs to the run that produced
// it: PC runs update the PC panel; WhatsApp runs update only the on-screen
// WhatsApp pill (the phone gets its own replies). Every run end clears its own
// caption. Pure routing, unit-tested (test/round0_9_4.test.ts).

import type { PanelStatusMsg } from '../shared/panel-status';

export type ActivityChannel = 'pc' | 'whatsapp';

export interface ActivityDeps {
  /** Send a status / acting message to the PC panel. */
  panel(msg: Exclude<PanelStatusMsg, { type: 'summon' }>): void;
  /** Update the WhatsApp pill's text (null = back to its default). */
  remotePill(caption: string | null): void;
}

export class ActivityRouter {
  /** Whether a PC acting caption was sent and not yet cleared. */
  private pcActing = false;

  constructor(private readonly d: ActivityDeps) {}

  /** The ghost cursor's caption for a step. */
  caption(channel: ActivityChannel, run: number | undefined, caption: string): void {
    if (channel === 'whatsapp') {
      this.d.remotePill(caption);
      return;
    }
    this.pcActing = true;
    this.d.panel({ type: 'acting', on: true, caption, run });
  }

  /** A short status line ("On it", "Reading the window…"). */
  status(channel: ActivityChannel, run: number | undefined, text: string): void {
    if (channel === 'whatsapp') return; // the pill already says it's working; the phone gets the reply
    this.d.panel({ type: 'status', text, run });
  }

  /** The PC HUD collapses back (answer, confirm card) without the run ending. */
  clearPcCaption(run?: number): void {
    if (!this.pcActing) return;
    this.pcActing = false;
    this.d.panel({ type: 'acting', on: false, run });
  }

  /** Any run ended (success, error or abort): clear that channel's captions. */
  runEnd(channel: ActivityChannel, run?: number): void {
    if (channel === 'whatsapp') {
      this.d.remotePill(null);
      return;
    }
    this.clearPcCaption(run);
  }
}
