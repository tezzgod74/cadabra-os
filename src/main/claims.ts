// Round 12.7 (user bug: the assistant sent the screenshot, then "corrected" herself with
// "I didn't actually send it"): the honesty check's claim → tool mapping comes
// from ONE registry. Every tool declares which kinds of first-person claim its
// success can back. `test/round12_7.test.ts` fails if a tool Cadabra exposes
// has no entry, so a new tool can't silently break the honesty check again.

export type ClaimKind = 'type' | 'click' | 'press' | 'send' | 'open' | 'run' | 'lock' | 'screenshot' | 'check' | 'scroll' | 'point' | 'settings' | 'announce';

/** The verbs that make a sentence a claim of each kind (inside the first-person pattern). */
export const CLAIM_VERBS: Record<ClaimKind, { verbs: string; verb: string }> = {
  type: { verbs: 'typed|entered|wrote|filled (?:it |that )?in|pasted|put (?:it|that) in', verb: 'type it' },
  click: { verbs: 'clicked|selected|tapped|chose|picked', verb: 'click it' },
  press: { verbs: 'pressed|hit (?:enter|the)', verb: 'press that' },
  send: { verbs: 'sent|submitted|posted|shared|attached', verb: 'send it' },
  open: { verbs: 'opened|launched|started|brought .{1,30} to the front|pulled up', verb: 'open it' },
  run: { verbs: 'ran|executed', verb: 'run it' },
  lock: { verbs: 'locked (?:the|your) (?:pc|computer|screen)', verb: 'lock the PC' },
  screenshot: { verbs: '(?:took|taken|captured|grabbed|snapped) (?:a |the |your )?(?:screenshot|screen ?shot|picture of (?:the|your) screen|screen)', verb: 'take a screenshot' },
  check: { verbs: 'checked|looked (?:it )?up|searched', verb: 'check that' },
  scroll: { verbs: 'scrolled', verb: 'scroll' },
  point: { verbs: 'highlighted|pointed (?:it |that )?out|circled', verb: 'point it out' },
  settings: { verbs: 'switched|paused', verb: 'change that setting' },
  announce: { verbs: 'announced|made (?:an|the) announcement', verb: 'announce it' },
};

/**
 * Which claims each tool's SUCCESS backs. Cadabra's own tools plus the
 * backends' built-in web tools. Tools that back no action claim map to [].
 */
export const TOOL_CLAIMS: Record<string, ClaimKind[]> = {
  // Seeing and pointing
  see_screen: ['screenshot', 'check'],
  read_ui: ['check'],
  highlight: ['point'],
  // Acting
  click: ['click', 'press', 'send'],
  type_text: ['type'],
  press_keys: ['press', 'send'],
  scroll: ['scroll'],
  confirm_with_user: [],
  // Apps, terminal
  find_apps: ['check'],
  launch_app: ['open'],
  focus_app: ['open'],
  run_in_terminal: ['run'],
  // Cadabra's settings
  set_provider: ['settings'],
  set_model: ['settings'],
  set_voice: ['settings'],
  change_shortcut: ['settings'],
  pause_cadabra: ['settings'],
  end_conversation: [],
  // Web, weather, email
  get_weather: ['check'],
  search_email: ['check'],
  read_email: ['check'],
  open_email: ['open'],
  open_url: ['open'],
  // System, WhatsApp
  lock_pc: ['lock'],
  send_screenshot: ['send', 'screenshot'],
  // Announcements (0.9.6)
  announce: ['announce'],
  // Skills (0.9.5): loading instructions backs no action claim
  list_skills: [],
  use_skill: [],
  // Backends' own web tools (provider tool events)
  WebSearch: ['check'],
  WebFetch: ['check', 'open'],
  web_fetch: ['check', 'open'],
  google_web_search: ['check'],
  web_search: ['check'],
};

/** The tools whose success backs a claim kind. */
export function toolsBacking(kind: ClaimKind): string[] {
  return Object.entries(TOOL_CLAIMS)
    .filter(([, ks]) => ks.includes(kind))
    .map(([name]) => name);
}

/** App-side actions done in the turn (e.g. a spoken-URL open) count like a successful tool. */
export const LOCAL_ACTION = (kind: ClaimKind) => ({ name: `local:${kind}`, ok: true, code: 'ok' });
