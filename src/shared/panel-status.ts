// 0.9.4: the PC panel's status line and "acting" HUD caption, as a pure
// reducer (the renderer applies it to the DOM; tests drive it directly).
//
// Bug it fixes: a WhatsApp run's ghost caption ("Checking the note was saved")
// was sent into the PC panel's HUD, and nothing ever cleared it, so every later
// summon showed the stale line. Rules:
//  - only PC runs write here (main routes other channels elsewhere: activity.ts);
//  - the end of a run (busy → false) clears its status and caption;
//  - a summon while idle shows no status or caption;
//  - a status or caption tagged with an older run than the current one is dropped,
//    and none is accepted while no run is active.

export interface PanelStatusState {
  /** The newest PC run the panel has seen (0 = none yet). */
  run: number;
  busy: boolean;
  acting: boolean;
  caption: string;
  status: string | null;
}

export type PanelStatusMsg =
  | { type: 'busy'; busy: boolean; run?: number }
  | { type: 'acting'; on: boolean; caption?: string; run?: number }
  | { type: 'status'; text: string; run?: number }
  | { type: 'summon' };

export function initialPanelStatus(): PanelStatusState {
  return { run: 0, busy: false, acting: false, caption: '', status: null };
}

const idle = (s: PanelStatusState): PanelStatusState => ({ ...s, busy: false, acting: false, caption: '', status: null });

/** Is a message tagged with `run` older than the panel's current run? */
export function isStale(s: PanelStatusState, run: number | undefined): boolean {
  return run != null && run < s.run;
}

export function reducePanelStatus(s: PanelStatusState, m: PanelStatusMsg): PanelStatusState {
  switch (m.type) {
    case 'busy':
      if (m.busy) return { ...s, busy: true, run: Math.max(s.run, m.run ?? s.run), status: 'Looking…', acting: false, caption: '' };
      if (isStale(s, m.run)) return s; // an older run ending doesn't end the current one
      return idle(s);
    case 'acting':
      if (!m.on) return isStale(s, m.run) ? s : { ...s, acting: false, caption: '' };
      if (!s.busy || isStale(s, m.run)) return s;
      return { ...s, acting: true, caption: m.caption || 'Working…' };
    case 'status':
      if (!s.busy || isStale(s, m.run)) return s;
      return { ...s, status: m.text };
    case 'summon':
      return s.busy ? s : idle(s);
  }
}
