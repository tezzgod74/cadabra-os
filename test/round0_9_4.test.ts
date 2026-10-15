// 0.9.4 regression: a WhatsApp run's progress caption ("Checking the note was
// saved") showed up in the PC panel and stayed there on every later summon.
// Status / captions are now per channel, cleared at every run end, reset on an
// idle summon, and dropped when they belong to an older run.
import { describe, expect, it } from 'vitest';
import { claudeWebHookSettings } from '../src/main/providers/claude-cli';
import { startMcpHttp, WEB_HOOK_DEADLINE_MS } from '../src/main/mcp-http';
import { ActivityRouter } from '../src/main/activity';
import { initialPanelStatus, reducePanelStatus, type PanelStatusMsg, type PanelStatusState } from '../src/shared/panel-status';

/** The PC panel as the renderer sees it: main → panel messages folded through the reducer. */
function harness() {
  let panel: PanelStatusState = initialPanelStatus();
  const pill: (string | null)[] = [];
  const toPanel = (m: PanelStatusMsg) => (panel = reducePanelStatus(panel, m));
  const router = new ActivityRouter({ panel: toPanel, remotePill: (c) => pill.push(c) });
  return { router, toPanel, pill, get panel() { return panel; } };
}

describe('0.9.4: progress captions belong to their own channel', () => {
  it('the reported bug: a WhatsApp run’s caption never reaches the PC panel; a later PC summon shows nothing stale', () => {
    const h = harness();
    // A WhatsApp run (id 7) works: ghost caption + status lines.
    h.router.status('whatsapp', 7, 'On it');
    h.router.caption('whatsapp', 7, 'Checking the note was saved');
    expect(h.pill).toEqual(['Checking the note was saved']);
    expect(h.panel).toMatchObject({ acting: false, caption: '', status: null });
    h.router.runEnd('whatsapp', 7);
    expect(h.pill.at(-1)).toBeNull();
    // The user summons the PC panel (idle).
    h.toPanel({ type: 'summon' });
    expect(h.panel).toMatchObject({ busy: false, acting: false, caption: '', status: null });
  });

  it('even the old leak shape is healed: a caption sent while the panel was hidden is cleared by the run end and by an idle summon', () => {
    const h = harness();
    h.toPanel({ type: 'busy', busy: true, run: 3 });
    h.router.caption('pc', 3, 'Typing into Notepad');
    expect(h.panel).toMatchObject({ acting: true, caption: 'Typing into Notepad' });
    // The HUD never collapsed (panel hidden), but the run end clears its caption anyway.
    h.router.runEnd('pc', 3);
    h.toPanel({ type: 'busy', busy: false, run: 3 });
    expect(h.panel).toMatchObject({ acting: false, caption: '', status: null });
    // An acting message arriving with no run active is ignored; an idle summon resets everything.
    h.toPanel({ type: 'acting', on: true, caption: 'stray', run: 3 });
    h.toPanel({ type: 'status', text: 'stray', run: 3 });
    h.toPanel({ type: 'summon' });
    expect(h.panel).toMatchObject({ acting: false, caption: '', status: null });
  });

  it('a PC turn after a WhatsApp turn shows only its own status, and ends clean', () => {
    const h = harness();
    h.router.caption('whatsapp', 7, 'Checking the note was saved');
    h.router.runEnd('whatsapp', 7);
    h.toPanel({ type: 'busy', busy: true, run: 8 });
    expect(h.panel.status).toBe('Looking…');
    h.router.status('pc', 8, 'Checking the weather');
    expect(h.panel.status).toBe('Checking the weather');
    h.toPanel({ type: 'busy', busy: false, run: 8 });
    expect(h.panel).toMatchObject({ busy: false, status: null, acting: false });
  });

  it('sanity guard: a status or caption tagged with an older run is dropped', () => {
    const h = harness();
    h.toPanel({ type: 'busy', busy: true, run: 5 });
    h.toPanel({ type: 'busy', busy: true, run: 6 }); // a newer run took over
    h.toPanel({ type: 'status', text: 'old', run: 5 });
    h.toPanel({ type: 'acting', on: true, caption: 'old caption', run: 5 });
    expect(h.panel).toMatchObject({ status: 'Looking…', acting: false });
    // The old run ending doesn't end the new one.
    h.toPanel({ type: 'busy', busy: false, run: 5 });
    expect(h.panel.busy).toBe(true);
    h.toPanel({ type: 'status', text: 'new', run: 6 });
    expect(h.panel.status).toBe('new');
  });

  it('a WhatsApp status line is not shown anywhere on the PC (the pill already says it is working)', () => {
    const h = harness();
    h.toPanel({ type: 'busy', busy: true, run: 2 }); // even with a PC turn running at the same time
    h.router.status('whatsapp', 9, 'Reading the window…');
    expect(h.panel.status).toBe('Looking…');
    expect(h.pill).toEqual([]);
  });
});

describe('0.9.4 W1: the web-guard hook always answers explicitly, before Claude Code’s timeout', () => {
  const call = async (hook: Parameters<typeof startMcpHttp>[3], deadline: number) => {
    const h = await startMcpHttp(() => [], '1', () => null, hook, deadline);
    try {
      const t0 = Date.now();
      const r = await fetch(h.url.replace(/\/mcp$/, '/hook/web'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}`, 'x-cadabra-session': 'k' }, body: JSON.stringify({ tool_name: 'WebFetch', tool_input: { url: 'https://docs.python.org/3/' } }) });
      return { body: await r.json(), ms: Date.now() - t0 };
    } finally {
      await h.close();
    }
  };
  it('a guard that never decides (e.g. an unanswered confirm card) becomes an explicit deny at the deadline', async () => {
    const r = await call(() => new Promise(() => undefined), 300);
    expect(r.body.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(r.ms).toBeLessThan(3000);
  });
  it('a guard that throws or returns garbage is an explicit deny', async () => {
    expect((await call(async () => { throw new Error('boom'); }, 300)).body.hookSpecificOutput.permissionDecision).toBe('deny');
    expect((await call(async () => ({}) as any, 300)).body.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('a quick guard decision still goes through', async () => {
    expect((await call(async () => ({ allow: true }), 300)).body.hookSpecificOutput.permissionDecision).toBe('allow');
  });
  it('the production deadline is well inside Claude Code’s hook timeout', () => {
    const timeoutS = claudeWebHookSettings({ url: 'u', token: 't', sessionKey: 'k' }).hooks.PreToolUse[0].hooks[0].timeout;
    expect(WEB_HOOK_DEADLINE_MS).toBeLessThanOrEqual(timeoutS * 1000 - 10_000);
    // A confirm card's own 90 s timeout ends first, so the user's answer is never cut off.
    expect(WEB_HOOK_DEADLINE_MS).toBeGreaterThan(90_000);
  });
  it('the hook-only settings carry no permission rules (a deny rule would beat a user-approved "allow")', () => {
    const s = claudeWebHookSettings({ url: 'u', token: 't', sessionKey: 'k' });
    expect(Object.keys(s)).toEqual(['hooks']);
  });
});
