// Round 10.6: REVIEW-10.5 items 2–5 (+ "readme dot md").
import { describe, expect, it, vi } from 'vitest';
import { isClosing, isPureFarewell, farewellFor } from '../src/shared/smalltalk';
import { readingGraceMs, ACK_CLOSE_WAIT_MS } from '../src/main/conversation';
import { spokenUrlCandidates } from '../src/shared/spoken-url';

function harness(replies: string[]) {
  const log: string[] = [];
  let i = 0;
  let visible = true;
  const settings = { provider: 'claude', voice: { speakReplies: 'voice', followUpSeconds: 8, wakeWord: 'nova' }, displayName: '' };
  const h: any = {
    settings: () => settings,
    now: () => Date.now(),
    provider: () => ({
      reset() {},
      send: (req: any) =>
        (async function* () {
          log.push(`ai:${req.prompt}`);
          yield { type: 'text', delta: replies[Math.min(i++, replies.length - 1)] };
          yield { type: 'done' };
        })(),
    }),
    model: () => 'm',
    gate: { beginRun() {}, stop() {} },
    buildTurn: () => ({ run: {}, request: {} }),
    setRun() {},
    afterRun() {},
    hasPendingConfirm: () => false,
    resolveConfirm() {},
    rejectConfirms() {},
    localLaunch: async (t: string) => (/open spotify/i.test(t) ? 'Opening Spotify.' : null),
    localIntent: async () => null,
    voice: { stopSpeaking() {}, armFollowUp: (ms: number) => void log.push(`arm:${ms}`), speak: async (x: string) => void log.push(`say:${x}`), enabled: () => true },
    ui: {
      busy() {},
      event() {},
      notice() {},
      userEcho() {},
      panelVisible: () => visible,
      dismiss: () => {
        visible = false;
        log.push('dismiss');
      },
    },
  };
  // (The real controller module is imported lazily so fake timers can apply.)
  return { h, log };
}

describe('#2: "Okay… (pause) now open Spotify" stays one turn', async () => {
  const { ConversationController } = await import('../src/main/conversation');
  it('an acknowledgement alone waits ~1 s (listening) before closing', async () => {
    const { h, log } = harness(["It's 72 and sunny in Seattle."]);
    const c = new ConversationController(h);
    c.summon(1, { voice: true });
    await c.onVoice('what is the weather', false);
    await c.onVoice('okay', true);
    expect(log).not.toContain('dismiss');
    expect(log.at(-1)).toBe(`arm:${ACK_CLOSE_WAIT_MS + 400}`); // still listening for more
    await new Promise((r) => setTimeout(r, ACK_CLOSE_WAIT_MS + 100));
    expect(log).toContain('dismiss');
  });
  it('more speech within the wait cancels the close; the request runs', async () => {
    const { h, log } = harness(["It's 72 and sunny in Seattle."]);
    const c = new ConversationController(h);
    c.summon(1, { voice: true });
    await c.onVoice('what is the weather', false);
    await c.onVoice('okay', true);
    c.followUpHeard(); // the follow-up capture started
    await c.onVoice('now open Spotify', true);
    await new Promise((r) => setTimeout(r, ACK_CLOSE_WAIT_MS + 100));
    expect(log).toContain('say:Opening Spotify.');
    expect(log).not.toContain('dismiss');
  });
  it('explicit goodbyes close at once', async () => {
    for (const bye of ['thanks', 'bye Nova', 'goodnight', 'good night', 'night', 'nite']) {
      const { h, log } = harness(["It's 72 and sunny in Seattle."]);
      const c = new ConversationController(h);
      c.summon(1, { voice: true });
      await c.onVoice('what is the weather', false);
      await c.onVoice(bye, true);
      expect(log, bye).toContain('dismiss');
    }
  });
});

describe('#3: long or linked replies stay readable after the window', async () => {
  const { ConversationController } = await import('../src/main/conversation');
  it('grace by length: none for short spoken answers, 10–30 s for links / lists / long text', () => {
    expect(readingGraceMs("It's 72 and sunny.")).toBe(0);
    expect(readingGraceMs('Top stories: A. B.\nSources: [BBC](https://bbc.co.uk)')).toBe(10_000);
    expect(readingGraceMs('- one\n- two\n- three')).toBe(10_000);
    expect(readingGraceMs('One sentence here. Another one. And a third.')).toBe(10_000); // > 2 sentences
    expect(readingGraceMs(`${'word '.repeat(60)}. Two. Three.`)).toBe(63 * 300); // scales with length (63 words)
    expect(readingGraceMs('word. '.repeat(200))).toBe(30_000);
  });
  it('the panel stays (not listening), then goes away; a new turn cancels that', async () => {
    vi.useFakeTimers();
    try {
      const { h, log } = harness(['Here are the headlines. One. Two. Three. Sources: [BBC](https://bbc.co.uk)']);
      const c = new ConversationController(h);
      c.summon(1, { voice: true });
      const p = c.onVoice('what are the headlines', false);
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      c.followUpExpired();
      expect(log).not.toContain('dismiss');
      expect(c.listeningForFollowUp).toBe(false);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(log).not.toContain('dismiss');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(log).toContain('dismiss');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('#4: good night / night / nite; "Bye, …" information is not a farewell', () => {
  it('closers', () => {
    for (const t of ['good night', 'goodnight', 'night', 'nite', 'night night', 'good night Nova']) expect(isClosing(t, 'nova'), t).toBe(true);
    expect(farewellFor('nite', 0)).toBe('Goodnight.');
  });
  it('pure farewells only', () => {
    expect(isPureFarewell('Bye for now, Sam!')).toBe(true);
    expect(isPureFarewell('Goodnight! Sleep well.')).toBe(true);
    expect(isPureFarewell('Bye, the meeting moved to 3 pm.')).toBe(false);
    expect(isPureFarewell("You're welcome, the file is on your desktop.")).toBe(false);
  });
});

describe('"readme dot md" is a file', () => {
  it('spoken "dot" + a file extension is not a website', () => {
    expect(spokenUrlCandidates('open readme dot md')).toBeNull();
    expect(spokenUrlCandidates('open setup dot py')).toBeNull();
    expect(spokenUrlCandidates('open bbc dot co dot uk')?.urls).toEqual(['https://bbc.co.uk/']);
  });
});
