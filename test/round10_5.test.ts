// Round 10.5: wake-free windows vs. a video playing; REVIEW-10 follow-ups.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptGreetingReply, followUpLooksLikeMedia, MediaWatch, mediaVerdict, MEDIA_POLL_MS } from '../src/main/media-watch';
import { looksLikeFileName, PENDING_URL_MS, spokenUrlCandidates } from '../src/shared/spoken-url';
import { checkOpenUrl } from '../src/main/open-url';
import { offersSomething } from '../src/shared/smalltalk';

describe('other apps playing sound', () => {
  it('sustained output counts; a short blip does not', () => {
    const now = 10_000;
    const loud = (exe: string, from: number, n: number) => Array.from({ length: n }, (_, i) => ({ t: from + i * MEDIA_POLL_MS, exe }));
    expect(mediaVerdict(loud('chrome.exe', now - 1500, 6), now)).toBe('chrome.exe'); // 900 ms of a video
    expect(mediaVerdict(loud('chrome.exe', now - 300, 1), now)).toBeNull(); // one notification blip
    expect(mediaVerdict(loud('spotify.exe', now - 5000, 10), now)).toBeNull(); // stopped 3+ s ago
  });
  it('a fake helper reporting a video: the watch says which app (Cadabra itself never counts)', async () => {
    let t = 0;
    const w = new MediaWatch(async () => [
      { exe: 'cadabra os.exe', peak: 0.6 },
      { exe: 'chrome.exe', peak: 0.3 },
    ], () => t);
    w.watchFor(10_000);
    for (let i = 0; i < 5; i++) {
      t += MEDIA_POLL_MS;
      await w.tick();
    }
    expect(w.playing()).toBe('chrome.exe');
    w.stop();
    const quiet = new MediaWatch(async () => [{ exe: 'chrome.exe', peak: 0.004 }], () => t);
    quiet.watchFor(10_000);
    for (let i = 0; i < 5; i++) await quiet.tick();
    expect(quiet.playing()).toBeNull();
    quiet.stop();
  });
});

describe('banter window hardening', () => {
  it('TV-like speech is ignored; the user’s quick banter or request is not', () => {
    expect(acceptGreetingReply({ text: 'and in other news tonight the senator said the vote will come next week', startLagMs: 200 })).toBe(false);
    expect(acceptGreetingReply({ text: 'thanks', startLagMs: 2600 })).toBe(false); // started late
    expect(acceptGreetingReply({ text: 'haha very funny', startLagMs: 300 })).toBe(true);
    expect(acceptGreetingReply({ text: "what's the weather today", startLagMs: 900 })).toBe(true);
  });
  it('follow-ups that look like media are ignored unless they say the name', () => {
    expect(followUpLooksLikeMedia({ text: 'long tv monologue', audioMs: 9500, startLagMs: 100, name: 'Cadabra' })).toBe(true);
    expect(followUpLooksLikeMedia({ text: 'more tv', audioMs: 6000, startLagMs: 4000, name: 'Cadabra' })).toBe(true);
    expect(followUpLooksLikeMedia({ text: 'Cadabra, and turn it down', audioMs: 9500, startLagMs: 100, name: 'Cadabra' })).toBe(false);
    expect(followUpLooksLikeMedia({ text: 'and tomorrow?', audioMs: 1500, startLagMs: 800, name: 'Cadabra' })).toBe(false);
  });
});

describe('REVIEW-10 #1: file names are not websites', () => {
  it('readme.md, setup.py, main.rs, notes.zip, clip.mov, report.pdf → not a web address', () => {
    for (const f of ['readme.md', 'setup.py', 'main.rs', 'notes.zip', 'clip.mov', 'report.pdf']) {
      expect(looksLikeFileName(f), f).toBe(true);
      expect(spokenUrlCandidates(`open ${f}`), f).toBeNull();
    }
  });
  it('unless the user clearly means a site', () => {
    expect(spokenUrlCandidates('open the website notes.zip')?.urls).toEqual(['https://notes.zip/']);
    expect(spokenUrlCandidates('open notes dot zip')).toBeNull(); // round 10.6: spoken "dot" + a file extension is a file
    expect(spokenUrlCandidates('open the website notes dot zip')?.urls).toEqual(['https://notes.zip/']);
    expect(spokenUrlCandidates('open https://clip.mov')?.urls).toEqual(['https://clip.mov/']);
    expect(spokenUrlCandidates('open www.report.pdf')).toBeNull(); // .pdf isn't a public suffix at all
    expect(spokenUrlCandidates('open claude.ai')?.urls).toEqual(['https://claude.ai/']);
    expect(spokenUrlCandidates('open youtube.com')?.urls).toEqual(['https://youtube.com/']);
  });
  it('open_url asks before treating a file-like name as a site', () => {
    expect(checkOpenUrl({ url: 'https://notes.zip/', prompt: 'open notes.zip' }).decision).toBe('confirm');
    expect(checkOpenUrl({ url: 'https://notes.zip/', prompt: 'open the website notes.zip' }).decision).toBe('allow');
  });
});

describe('REVIEW-10 #2: pre-rendering never cancels speech', () => {
  afterEach(() => vi.useRealTimers());
  it('a pre-render cancelled by a real reply is retried once', async () => {
    vi.useFakeTimers();
    const { Greeter } = await import('../src/main/greeter');
    const calls: string[] = [];
    let first = true;
    const st = { enabled: true, awayMinutes: 20, quietStart: '', quietEnd: '', recent: [] as string[] };
    const g = new Greeter({
      now: () => Date.now(),
      settings: () => st,
      name: () => '',
      dialect: () => null,
      voiceReady: () => true,
      userBusy: () => false,
      presence: async () => null,
      micUsers: async () => [],
      speak: async () => {},
      prerender: async (t) => {
        calls.push(t);
        const ok = !first;
        first = false;
        return ok;
      },
      openWindow: () => {},
      saveRecent: () => {},
      log: () => {},
    });
    g.onSession('lock');
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3100);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
  });
  it('the speech worker: a background request does not cancel the active one', async () => {
    const src = (await import('node:fs')).readFileSync('src/main/voice/tts-worker.ts', 'utf8');
    expect(src).toMatch(/for \(const id of m\.background \? \[\] : active\)/);
  });
});

describe('REVIEW-10 #3/#4', () => {
  it('"Did you mean …?" waits 20 s', () => expect(PENDING_URL_MS).toBe(20_000));
  it('a bare "no" declines an offer', () => {
    expect(offersSomething('Here it is. Want me to open it?')).toBe(true);
    expect(offersSomething('Should I read the rest?')).toBe(true);
    expect(offersSomething('Did you mean tv.youtube.com?')).toBe(false);
    expect(offersSomething('Anything I can help you with?')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round 10.5 (user, with the assistant named "Nova"): a natural end of the
// conversation makes Nova stop listening and go away.
describe('ending a conversation (assistant name "Nova")', async () => {
  const { ConversationController } = await import('../src/main/conversation');
  const { isClosing, isSoftClose, farewellFor, isPureFarewell } = await import('../src/shared/smalltalk');
  function harness(replies: (string | ((run: any) => string))[]) {
    const log: string[] = [];
    let i = 0;
    let visible = true;
    let t = 1_000_000;
    const settings = { provider: 'claude', voice: { speakReplies: 'voice', followUpSeconds: 8, wakeWord: 'nova' }, displayName: '' };
    let run: any = {};
    const h: any = {
      settings: () => settings,
      now: () => t,
      provider: () => ({
        reset() {},
        send: () =>
          (async function* () {
            const r = replies[Math.min(i++, replies.length - 1)];
            yield { type: 'text', delta: typeof r === 'function' ? r(run) : r };
            yield { type: 'done' };
          })(),
      }),
      model: () => 'm',
      gate: { beginRun() {}, stop() {} },
      buildTurn: () => ((run = {}), { run, request: {} }),
      setRun() {},
      afterRun() {},
      hasPendingConfirm: () => false,
      resolveConfirm() {},
      rejectConfirms() {},
      localLaunch: async () => null,
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
    const c = new ConversationController(h);
    c.summon(1, { voice: true });
    return { c, log, advance: (ms: number) => (t += ms), show: () => (visible = true) };
  }

  it('silence after a reply: the panel goes away, the mic is wake-word-only, the context stays 3 min', async () => {
    const x = harness(["It's 72 and sunny in Seattle."]);
    await x.c.onVoice('what is the weather in seattle', false);
    expect(x.log).toContain('arm:8000');
    x.c.followUpExpired(); // the engine's "expired" (no valid speech in the window)
    expect(x.log.at(-1)).toBe('dismiss');
    expect(x.c.listeningForFollowUp).toBe(false);
    x.advance(2 * 60_000);
    expect(x.c.shouldStartFresh(99, { voice: true })).toBe(false); // "Nova, …" continues
    x.advance(2 * 60_000);
    expect(x.c.shouldStartFresh(99, { voice: true })).toBe(true);
  });

  it('every natural closer after a finished answer ends it', async () => {
    for (const phrase of ['cool', 'perfect', 'awesome', 'great', 'nice', 'alright', 'okay cool', 'sounds good', 'that works', "that's what I needed", "that's all I needed", "I'm good", "we're good", 'all set', 'good to know', 'gotcha', 'appreciate it', 'thanks Nova', 'thank you Nova', 'bye Nova', 'talk later', 'goodnight']) {
      const x = harness(["It's 72 and sunny in Seattle."]);
      await x.c.onVoice('what is the weather', false);
      await x.c.onVoice(phrase, true);
      await new Promise((r) => setTimeout(r, 1100)); // round 10.6: acknowledgements wait ~1 s for more speech
      expect(x.log, phrase).toContain('dismiss');
      expect(x.log.filter((l) => /^arm:\d{4,}$/.test(l) && Number(l.slice(4)) >= 2000).length, phrase).toBe(1); // no new follow-up window after the closer
    }
  }, 60_000);

  it('…but not after a question Nova asked, nor when a request follows', async () => {
    const q = harness(['Which city should I use?', 'Okay.']);
    await q.c.onVoice('what is the weather', false);
    await q.c.onVoice('cool', true);
    expect(q.log).not.toContain('dismiss');
    const r = harness(["It's 72 and sunny.", 'Opening Spotify.']);
    await r.c.onVoice('what is the weather', false);
    await r.c.onVoice('cool, now open Spotify', true);
    expect(r.log).not.toContain('dismiss');
    expect(isClosing('cool, now open spotify', 'nova')).toBe(false);
  });

  it('the matcher knows the configured name; farewells are short and varied (sometimes none)', () => {
    expect(isClosing('thanks Nova', 'nova')).toBe(true);
    expect(isClosing('bye Nova', 'nova')).toBe(true);
    expect(isSoftClose('cool Nova', 'nova')).toBe(true);
    expect(farewellFor('goodnight Nova', 0, 'nova')).toBe('Goodnight.');
    expect(['Bye!', 'Talk soon.', 'See you.']).toContain(farewellFor('bye', 1));
    expect(farewellFor('cool', 0)).toBe(''); // just the dissolve
    expect(farewellFor('thanks', 0)).toBe('Anytime.');
  });

  it('end_conversation (model side) closes after its short reply, with no new window', async () => {
    const x = harness([
      "It's 72 and sunny.",
      (run) => {
        run.endConversation = true; // what the end_conversation tool sets
        return 'Enjoy your evening.';
      },
    ]);
    await x.c.onVoice('what is the weather', false);
    await x.c.onVoice("I'm heading out for a walk now", true);
    expect(x.log).toContain('dismiss');
    expect(x.log.slice(x.log.indexOf('dismiss')).some((l) => /^arm:[1-9]/.test(l))).toBe(false);
    const { ToolHost } = await import('../src/main/tools');
    const h = new ToolHost({} as any, { isStopped: false } as any, {} as any, {} as any);
    h.run = { target: null, signal: new AbortController().signal, frame: null, nodes: new Map() };
    const tool = h.definitions().find((d) => d.name === 'end_conversation')!;
    await tool.handler({});
    expect(h.run.endConversation).toBe(true);
  });

  it('a reply that is itself a farewell closes; a goodbye never gets a reply that reopens listening', async () => {
    expect(isPureFarewell('Have a great evening!')).toBe(true);
    expect(isPureFarewell("You're welcome! Next up is the 3 pm meeting.")).toBe(false);
    const x = harness(["It's 72 and sunny.", "You're welcome! Is there anything else you'd like?"]);
    await x.c.onVoice('what is the weather', false);
    await x.c.onVoice('cheers mate, thanks a bunch for that', true);
    expect(x.log).toContain('dismiss');
    expect(x.log.slice(x.log.indexOf('dismiss')).some((l) => /^arm:[1-9]/.test(l))).toBe(false);
  });

  it('a voice conversation continues by the wake word after it went away', async () => {
    const x = harness(["It's 72 and sunny.", 'Tomorrow: 75 and clear.']);
    await x.c.onVoice('what is the weather', false);
    x.c.followUpExpired();
    x.advance(60_000);
    expect(x.c.shouldStartFresh(42, { voice: true })).toBe(false);
    x.show();
    await x.c.onVoice('and tomorrow', false);
    expect(x.log).toContain('arm:8000');
  });
});
