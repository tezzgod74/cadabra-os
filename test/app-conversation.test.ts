// Drives the REAL conversation state machine (src/main/conversation.ts) with a
// fake backend, fake voice and fake panel: scenarios A and B end to end, plus
// REVIEW-1 B2 (abort watchdog), B3 (stop / yes / queue while busy), V1
// (continue across windows), V2 (echo guard), V4 (blur), V6 (bare "no").
import { describe, expect, it } from 'vitest';
import { ConversationController, type ConvHost } from '../src/main/conversation';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
import type { ProviderEvent, Settings } from '../src/shared/types';
import type { ProviderAdapter, SendRequest } from '../src/main/providers/types';

type Script = (req: SendRequest) => AsyncGenerator<ProviderEvent>;

function harness(opts: { scripts?: Script[]; settings?: Partial<Settings>; now?: () => number } = {}) {
  const log: string[] = [];
  const spoken: string[] = [];
  const armed: number[] = [];
  const events: ProviderEvent[] = [];
  const notices: string[] = [];
  const requests: SendRequest[] = [];
  let busy = false;
  let panelVisible = true;
  let pendingConfirm = false;
  let confirmAnswer: boolean | null = null;
  let resets = 0;
  let gateStopped = false;
  let dismissed = 0;
  let t = new Date(2026, 9, 11, 10, 21).getTime();
  const scripts = [...(opts.scripts ?? [])];
  const settings: Settings = { ...structuredClone(DEFAULT_SETTINGS), displayName: 'Alex', ...opts.settings };
  settings.voice = { ...settings.voice, enabled: true };
  const provider: ProviderAdapter = {
    id: 'demo',
    label: 'Fake',
    listModels: async () => [],
    checkAuth: async () => ({ ok: true, detail: '' }),
    send: (req) => {
      requests.push(req);
      const s = scripts.shift();
      if (!s) throw new Error('no scripted turn left');
      return s(req);
    },
    reset: () => {
      resets++;
    },
  };
  const host: ConvHost = {
    settings: () => settings,
    provider: () => provider,
    ui: {
      event: (ev) => events.push(ev),
      busy: (b) => {
        busy = b;
        log.push(`busy:${b}`);
      },
      userEcho: (text) => log.push(`echo:${text}`),
      notice: (text) => notices.push(text),
      dismiss: () => {
        dismissed++;
        panelVisible = false;
      },
      panelVisible: () => panelVisible,
    },
    voice: {
      enabled: () => true,
      speak: async (text) => {
        spoken.push(text);
        await new Promise((r) => setTimeout(r, 5));
      },
      stopSpeaking: () => log.push('tts:stop'),
      armFollowUp: (ms) => armed.push(ms),
    },
    gate: {
      beginRun: () => {
        gateStopped = false;
      },
      stop: () => {
        gateStopped = true;
      },
    },
    setRun: () => undefined,
    buildTurn: (text, signal) => ({ run: { target: null, signal, frame: null, nodes: new Map(), prompt: text }, request: { contextText: '' } }),
    model: () => 'fake',
    localLaunch: async () => null,
    localIntent: async () => null,
    hasPendingConfirm: () => pendingConfirm,
    resolveConfirm: (a) => {
      confirmAnswer = a;
      pendingConfirm = false;
    },
    rejectConfirms: () => {
      pendingConfirm = false;
    },
    afterRun: () => undefined,
    now: opts.now ?? (() => t),
  };
  const c = new ConversationController(host);
  return {
    c,
    spoken,
    armed,
    events,
    notices,
    requests,
    log,
    text: () => events.filter((e) => e.type === 'text').map((e: any) => e.delta).join(''),
    get busy() {
      return busy;
    },
    get resets() {
      return resets;
    },
    get gateStopped() {
      return gateStopped;
    },
    get dismissed() {
      return dismissed;
    },
    get confirmAnswer() {
      return confirmAnswer;
    },
    setPendingConfirm: (v: boolean) => (pendingConfirm = v),
    setPanelVisible: (v: boolean) => (panelVisible = v),
    advance: (ms: number) => (t += ms),
  };
}

async function* reply(...evs: ProviderEvent[]) {
  for (const e of evs) yield e;
}

describe('Scenario A (through the controller)', () => {
  it('"Cadabra, are you there? What time is it." → spoken greeting + time, follow-up armed; "No. Thanks." → spoken goodbye, dissolve', async () => {
    const h = harness();
    h.c.summon(1, { voice: true });
    await h.c.onVoice('are you there? What time is it.', false);
    expect(h.text()).toBe("Good morning, Alex. It's 10:21 AM. Anything I can help you with?");
    expect(h.spoken).toEqual(["Good morning, Alex. It's 10:21 AM. Anything I can help you with?"]);
    expect(h.armed.at(-1)).toBe(8000); // follow-up window opened AFTER speech ended
    expect(h.requests).toHaveLength(0); // answered locally
    expect(await h.c.onVoice('No. Thanks.', true)).toBe(true);
    expect(h.spoken.at(-1)).toBe('Anytime.');
    expect(h.dismissed).toBe(1);
  });
  it('greets without a name when none is set (never a handle)', async () => {
    const h = harness({ settings: { displayName: '' } });
    h.c.summon(1, { voice: true });
    await h.c.onVoice('are you there', false);
    expect(h.text()).toBe("Good morning. I'm here. Anything I can help you with?");
  });
});

describe('Scenario B (fake backend through the controller)', () => {
  it('terminal + nslookup, then "what\'s the output" after >8 s via the wake word over another window continues the same session', async () => {
    const h = harness({
      scripts: [
        () =>
          reply(
            { type: 'session', sessionId: 'sess-1' },
            { type: 'tool', id: 't1', name: 'run_in_terminal', phase: 'start' },
            { type: 'tool', id: 't1', name: '', phase: 'end', ok: true, summary: 'Name: dns.google' },
            { type: 'text', delta: 'Here you go.' },
            { type: 'done', sessionId: 'sess-1' },
          ),
        (req) => {
          expect(req.resumeId).toBe('sess-1'); // same backend session → it remembers the output
          return reply({ type: 'text', delta: '**8.8.8.8** resolves to `dns.google`. Anything else?\n\n```\nName: dns.google\n```' }, { type: 'done', sessionId: 'sess-1' });
        },
      ],
    });
    h.c.summon(1, { voice: true });
    await h.c.onVoice('open a terminal and do an nslookup for 8.8.8.8', false);
    expect(h.spoken).toEqual(['Here you go.']);
    expect(h.armed.at(-1)).toBe(8000);
    // The 8 s window lapses; the user says "Cadabra, what's the output?" with the cursor over the new terminal.
    h.c.followUpEnded();
    h.advance(30_000);
    expect(h.c.summon(2, { voice: true })).toBe(false); // V1: continues, not fresh
    await h.c.onVoice("I'm not looking at the screen. What's the output?", false);
    expect(h.spoken.at(-1)).toBe('8.8.8.8 resolves to dns.google. Anything else?'); // voice-formatted
    await h.c.onVoice('Nope. Thanks.', true);
    expect(h.spoken.at(-1)).toBe('Anytime.');
    expect(h.dismissed).toBe(1);
    expect(h.resets).toBe(1); // only the initial fresh summon reset the backend
  });
});

describe('V1: when does a summon continue the conversation?', () => {
  it('typed: other window within 2 min continues; after 2 min starts fresh; same window continues 15 min', () => {
    const h = harness();
    h.c.summon(1);
    h.c.conversation!.turns = 1;
    h.advance(60_000);
    expect(h.c.shouldStartFresh(2)).toBe(false);
    h.advance(90_000);
    expect(h.c.shouldStartFresh(2)).toBe(true);
    expect(h.c.shouldStartFresh(1)).toBe(false);
    h.advance(15 * 60_000);
    expect(h.c.shouldStartFresh(1)).toBe(true);
  });
  it('a voice conversation continues for 3 min regardless of window', () => {
    const h = harness();
    h.c.summon(1, { voice: true });
    h.advance(170_000);
    expect(h.c.shouldStartFresh(99, { voice: true })).toBe(false);
    h.advance(20_000);
    expect(h.c.shouldStartFresh(99, { voice: true })).toBe(true);
  });
});

describe('V2: echo guard on follow-ups', () => {
  it("ignores the mic hearing Cadabra's own reply, and stray one-word noise", async () => {
    const h = harness({ scripts: [() => reply({ type: 'text', delta: '8.8.8.8 resolves to dns.google. Want me to look up another?' }, { type: 'done' })] });
    h.c.summon(1, { voice: true });
    await h.c.onVoice('what is 8.8.8.8', false);
    expect(await h.c.onVoice('resolves to dns google want me to look up another', true)).toBe(false);
    expect(await h.c.onVoice('uh', true)).toBe(false);
    expect(h.requests).toHaveLength(1);
  });
});

describe('B2/B3: the kill switch while busy', () => {
  it('"stop" while a run is in flight cancels it, stops speech and clears busy', async () => {
    let aborted = false;
    const h = harness({
      scripts: [
        async function* (req) {
          yield { type: 'text', delta: 'Working…' };
          await new Promise((r) => req.signal.addEventListener('abort', r));
          aborted = true;
          yield { type: 'done' };
        },
      ],
    });
    h.c.summon(1, { voice: true });
    const run = h.c.send('do a long task', 'voice');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.busy).toBe(true);
    await h.c.send('Cadabra, stop', 'voice');
    await run;
    expect(aborted).toBe(true);
    expect(h.gateStopped).toBe(true);
    expect(h.log).toContain('tts:stop');
    expect(h.busy).toBe(false);
    expect(h.notices).toContain('Stopped.');
  });
  it('a backend that never answers after abort is reset within the watchdog and busy clears', async () => {
    const h = harness({
      scripts: [
        async function* () {
          yield { type: 'text', delta: 'Working…' };
          await new Promise(() => undefined); // hangs forever, ignores abort
        },
      ],
    });
    h.c.summon(1);
    const run = h.c.send('do a long task', 'typed');
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    h.c.cancel();
    await run;
    expect(Date.now() - t0).toBeLessThan(3200);
    expect(h.busy).toBe(false);
    expect(h.resets).toBeGreaterThanOrEqual(2); // summon + watchdog reset
  });
  it('"yes"/"no" while busy answer the open confirm card; other speech is queued and runs next', async () => {
    let release!: () => void;
    const h = harness({
      scripts: [
        async function* () {
          await new Promise<void>((r) => (release = r));
          yield { type: 'text', delta: 'Sent.' };
          yield { type: 'done' };
        },
        () => reply({ type: 'text', delta: 'Done with the second thing.' }, { type: 'done' }),
      ],
    });
    h.c.summon(1);
    const run = h.c.send('reply to Dana and send it', 'typed');
    await new Promise((r) => setTimeout(r, 10));
    h.setPendingConfirm(true);
    await h.c.send('yes', 'voice');
    expect(h.confirmAnswer).toBe(true);
    await h.c.send('then archive it', 'typed');
    expect(h.notices.some((n) => /do that next/.test(n))).toBe(true);
    release();
    await run;
    expect(h.requests.map((r) => r.prompt)).toEqual(['reply to Dana and send it', 'then archive it']);
  });
});

describe('V4: blur does not end a voice conversation', () => {
  it('blur may dismiss a typed, idle panel but not during voice / speech / follow-up / busy', async () => {
    const typed = harness();
    typed.c.summon(1);
    expect(typed.c.blurMayDismiss()).toBe(true);
    const voiced = harness();
    voiced.c.summon(1, { voice: true });
    await voiced.c.onVoice('what time is it', false);
    expect(voiced.c.blurMayDismiss()).toBe(false);
  });
  it('the follow-up window is still armed when the panel was hidden during a voice conversation', async () => {
    const h = harness();
    h.c.summon(1, { voice: true });
    h.setPanelVisible(false);
    await h.c.onVoice('what time is it', false);
    expect(h.armed.at(-1)).toBe(8000);
  });
});

describe('V6: a bare typed "no" only closes after an open question', () => {
  it('declines an offer locally ("Okay.") and stays open when Cadabra had asked something specific (REVIEW-10 #4)', async () => {
    const h = harness({
      scripts: [
        () => reply({ type: 'text', delta: 'Should I also archive it?' }, { type: 'done' }),
        () => reply({ type: 'text', delta: 'Okay, I left it in the inbox.' }, { type: 'done' }),
      ],
    });
    h.c.summon(1);
    await h.c.send('reply to Dana', 'typed');
    await h.c.send('no', 'typed');
    expect(h.requests).toHaveLength(1);
    expect(h.dismissed).toBe(0);
  });
  it('closes after "Anything else?"', async () => {
    const h = harness({ scripts: [() => reply({ type: 'text', delta: 'Done. Anything else?' }, { type: 'done' })] });
    h.c.summon(1);
    await h.c.send('reply to Dana', 'typed');
    await h.c.send('no', 'typed');
    expect(h.dismissed).toBe(1);
  });
});

describe('REVIEW-2 round 3: conversation polish', () => {
  it('N3: two sends at once start ONE backend run; the second is queued', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      scripts: [
        async function* () {
          await gate;
          yield { type: 'text', delta: 'one' } as ProviderEvent;
          yield { type: 'done' } as ProviderEvent;
        },
        () => reply({ type: 'text', delta: 'two' }, { type: 'done' }),
      ],
    });
    const a = h.c.send('first question please', 'typed');
    const b = h.c.send('second question please', 'typed'); // arrives before the first reached the backend
    await new Promise((r) => setTimeout(r, 20));
    expect(h.requests).toHaveLength(1);
    expect(h.notices.join(' ')).toMatch(/do that next/);
    release();
    await Promise.all([a, b]);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.requests.map((r) => r.prompt)).toEqual(['first question please', 'second question please']);
  });

  it('#9: click-away works again once the follow-up window has expired', async () => {
    const h = harness();
    h.c.summon(1, { voice: true });
    await h.c.onVoice('what time is it', false);
    expect(h.c.blurMayDismiss()).toBe(false); // listening for a follow-up
    h.c.followUpEnded();
    expect(h.c.blurMayDismiss()).toBe(true); // the 3-minute continuation stays, the stickiness doesn't
    expect(h.c.shouldStartFresh(2, { voice: true })).toBe(false);
  });

  it('#9: the echo guard drops Cadabra’s own words but keeps a real reply that shares them', async () => {
    const h = harness();
    h.c.summon(1, { voice: true });
    await h.c.onVoice('Cadabra, are you there? What time is it.', false); // "Good morning, Alex. It's 10:21 AM. Anything I can help you with?"
    expect(h.c.acceptVoice('anything I can help you with', true)).toBe(false); // the speaker tail
    expect(h.c.acceptVoice('can you help me with it', true)).toBe(true); // a real reply (round-2 guard dropped this)
    h.advance(5000);
    expect(h.c.acceptVoice('anything I can help you with', true)).toBe(true); // long after TTS: the user really said it
  });

  it('#5: a confirm card in a voice conversation is spoken and opens a wake-free yes/no window', async () => {
    const h = harness();
    h.c.summon(1, { voice: true });
    await h.c.onVoice('what time is it', false);
    h.setPendingConfirm(true);
    const spoke = await h.c.speakConfirm('Should I run this command: nslookup 8.8.8.8? Say yes or no.');
    expect(spoke).toBe(true);
    expect(h.spoken.at(-1)).toMatch(/nslookup 8\.8\.8\.8/);
    expect(h.armed.at(-1)).toBeGreaterThanOrEqual(8000);
    // A typed conversation never speaks cards.
    const t = harness();
    t.c.summon(1);
    await t.c.send('hello there friend', 'typed').catch(() => undefined);
    expect(await t.c.speakConfirm('x')).toBe(false);
  });
});
