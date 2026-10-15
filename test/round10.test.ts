// Round 10: the user's hands-on results — spoken URLs, "Anything else?" on
// every reply, and slow greetings.
import { describe, expect, it, vi } from 'vitest';
import { chooseUrl, displayUrl, normalizeSpokenUrl, spokenUrlCandidates, stripLaunchPhrase } from '../src/shared/spoken-url';
import { answerLocally, asksToConfirm, endsWithOpenQuestion, invitesClose, isGenericCloser, stripGenericCloser } from '../src/shared/smalltalk';

const urls = (t: string, knownSites = false) => spokenUrlCandidates(t, { knownSites })?.urls ?? null;

describe('1. spoken web addresses', () => {
  it('realistic STT variants', () => {
    expect(urls('open up tv.youtube.com')).toEqual(['https://tv.youtube.com/']);
    expect(urls('Open up TV.YouTube.com.')).toEqual(['https://tv.youtube.com/']);
    expect(urls('openup tv.youtube.com')).toEqual(['https://tv.youtube.com/']);
    expect(urls('open up TV dot YouTube dot com')).toEqual(['https://tv.youtube.com/']);
    expect(urls('open up tv dot youtube dot com')).toEqual(['https://tv.youtube.com/']);
    expect(urls('pull up youtube.com/tv')).toEqual(['https://youtube.com/tv']);
    expect(urls('pull up youtube dot com slash tv')).toEqual(['https://youtube.com/tv']);
    expect(urls('go to bbc dot co dot uk')).toEqual(['https://bbc.co.uk/']);
    expect(urls('navigate to w w w dot espn dot com')).toEqual(['https://www.espn.com/']);
    expect(urls('take me to h t t p s colon slash slash example dot com')).toEqual(['https://example.com/']);
    expect(urls('Cadabra, bring up reddit.com/r/news please')).toEqual(['https://reddit.com/r/news']);
  });
  it('"Open uptv.youtube.com": the glued particle gives a second candidate, flagged', () => {
    const c = spokenUrlCandidates('Open uptv.youtube.com');
    expect(c?.urls).toEqual(['https://uptv.youtube.com/', 'https://tv.youtube.com/']);
    expect(c?.suspectGlue).toBe(true);
    // A real two-label host is never split ("uptime.com", "meet.google.com" stays as heard).
    expect(urls('open uptime.com')).toEqual(['https://uptime.com/']);
    expect(urls('open up meet.google.com')).toEqual(['https://meet.google.com/']);
  });
  it('never glues an ordinary word onto a host label', () => {
    expect(normalizeSpokenUrl('up tv dot youtube dot com')).toBe('up tv.youtube.com');
    expect(normalizeSpokenUrl('youtube dot com slash tv')).toBe('youtube.com/tv');
    expect(normalizeSpokenUrl('w w w dot espn dot com')).toBe('www.espn.com');
    expect(urls('open my favourite site example.com')).toBeNull(); // not "open <address>"
  });
  it('real public suffixes only; apps and UI stay apps', () => {
    expect(urls('open power point')).toBeNull();
    expect(urls('open notepad')).toBeNull();
    expect(urls('open the file menu')).toBeNull();
    expect(urls('open readme.txtx')).toBeNull();
    expect(urls('open my gmail')).toBeNull(); // only once no app matched…
    expect(urls('open my gmail', true)).toEqual(['https://mail.google.com/']); // …then the well-known site
    expect(urls('open youtube', true)).toEqual(['https://www.youtube.com/']);
  });
  it('launch phrasing and "in Chrome"', () => {
    expect(stripLaunchPhrase('Cadabra, open up tv.youtube.com in Chrome')).toEqual({ target: 'tv.youtube.com', browser: 'chrome' });
    expect(stripLaunchPhrase('could you navigate to espn.com for me')).toEqual({ target: 'espn.com', browser: undefined });
    expect(stripLaunchPhrase('what is the weather')).toBeNull();
  });
  it('DNS decides; ambiguity asks "Did you mean …?"', async () => {
    const c = spokenUrlCandidates('Open uptv.youtube.com')!;
    expect(await chooseUrl(c, async (h) => h === 'tv.youtube.com')).toEqual({ open: 'https://tv.youtube.com/' });
    expect(await chooseUrl(c, async () => true)).toEqual({ ask: 'https://tv.youtube.com/' });
    expect(await chooseUrl(c, async () => false)).toEqual({ none: 'https://tv.youtube.com/' });
    expect(await chooseUrl(spokenUrlCandidates('open up tv.youtube.com')!, async () => true)).toEqual({ open: 'https://tv.youtube.com/' });
    expect(displayUrl('https://tv.youtube.com/')).toBe('tv.youtube.com');
  });
  it('a "no" to "Did you mean …?" answers it instead of closing the conversation', () => {
    expect(asksToConfirm('Did you mean tv.youtube.com?')).toBe(true);
    expect(asksToConfirm('I couldn’t find x.com. Do you want me to try opening it anyway?')).toBe(true);
    expect(asksToConfirm('It is sunny.')).toBe(false);
  });
  it('open_url refuses a host that does not exist and names the likely one', async () => {
    const { ToolHost } = await import('../src/main/tools');
    const { SafetyGate } = await import('../src/main/safety-gate');
    const { DEFAULT_SAFETY } = await import('../src/shared/safety');
    const opened: string[] = [];
    const h = new ToolHost({} as any, new SafetyGate(() => DEFAULT_SAFETY, { confirm: async () => true }), { status: () => {} } as any);
    h.system = { lockPc: async () => '', micInUse: async () => false, resolves: async (host) => host === 'tv.youtube.com', openUrl: async (u) => (opened.push(u), 'Opened in your browser.') };
    h.run = { target: null, signal: new AbortController().signal, frame: null, nodes: new Map(), prompt: 'Open uptv.youtube.com' };
    const r = await h.openUrlTool({ url: 'https://uptv.youtube.com/' });
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toMatch(/Did you mean tv\.youtube\.com\?/);
    expect(opened).toEqual([]);
  });
});

describe('2. replies end naturally', async () => {
  const { SYSTEM_PROMPT } = await import('../src/main/tools');
  it('the prompts no longer ask for "Anything else?"', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/end with (a light )?"Anything else\?"|then "Anything else\?"/);
    expect(SYSTEM_PROMPT).toMatch(/never end two replies in a row with a question/);
  });
  it('generic closers are recognised and never spoken; real offers stay', () => {
    for (const x of ['Anything else?', 'Is there anything else I can help with?', 'Let me know if you need anything.', 'Can I help with anything else?']) expect(isGenericCloser(x), x).toBe(true);
    for (const x of ['Want me to open it?', 'Should I read the rest?', 'Anything in particular?']) expect(isGenericCloser(x), x).toBe(false);
    expect(stripGenericCloser("It's 72 and sunny. Anything else?")).toBe("It's 72 and sunny.");
    expect(stripGenericCloser('Done. Want me to open it?')).toBe('Done. Want me to open it?');
  });
  it('the Scenario A line only on the first turn', () => {
    const now = new Date(2026, 9, 15, 10, 21);
    expect(answerLocally('are you there', { now, name: 'Sam', firstTurn: true, voice: true })?.text).toMatch(/Anything I can help you with\?$/);
    expect(answerLocally('what time is it', { now, name: 'Sam', firstTurn: false, voice: true })?.text).toBe("It's 10:21 AM.");
  });
  it('"got it" closes after a finished answer, not mid-instructions or after a specific question', () => {
    expect(invitesClose("It's 72 and sunny in Seattle.")).toBe(true);
    expect(invitesClose('First open Settings, then click Display.')).toBe(false);
    expect(invitesClose('Should I archive it?')).toBe(false);
    expect(endsWithOpenQuestion('Anything I can help you with?')).toBe(true);
    expect(endsWithOpenQuestion('Want me to open it?')).toBe(false);
  });
  it('the follow-up window opens after a spoken reply that has no question', async () => {
    const { ConversationController } = await import('../src/main/conversation');
    const armed: number[] = [];
    const h: any = {
      settings: () => ({ provider: 'claude', voice: { speakReplies: 'voice', followUpSeconds: 8, wakeWord: 'cadabra' }, displayName: '' }),
      now: () => Date.now(),
      provider: () => ({ send: () => (async function* () { yield { type: 'text', delta: "It's 72 and sunny in Seattle." }; yield { type: 'done' }; })() }),
      model: () => 'm',
      gate: { beginRun() {}, stop() {} },
      buildTurn: () => ({ run: {}, request: {} }),
      setRun() {},
      afterRun() {},
      hasPendingConfirm: () => false,
      resolveConfirm() {},
      rejectConfirms() {},
      localLaunch: async () => null,
      localIntent: async () => null,
      voice: { stopSpeaking() {}, armFollowUp: (ms: number) => void armed.push(ms), speak: async () => {}, enabled: () => true },
      ui: { busy() {}, event() {}, notice() {}, userEcho() {}, panelVisible: () => true, dismiss() {} },
    };
    const c = new ConversationController(h);
    await c.onVoice('what is the weather in seattle', false);
    expect(armed.at(-1)).toBe(8000);
  });
});

describe('3. greetings are instant', async () => {
  const { Greeter } = await import('../src/main/greeter');
  function make() {
    let now = new Date(2026, 9, 15, 9, 0).getTime();
    const said: string[] = [];
    const rendered: string[] = [];
    const armed: boolean[] = [];
    const st = { enabled: true, awayMinutes: 20, quietStart: '', quietEnd: '', recent: [] as string[] };
    const g = new Greeter({
      now: () => now,
      settings: () => st,
      name: () => 'Sam',
      dialect: () => null,
      voiceReady: () => true,
      userBusy: () => false,
      presence: async () => (await new Promise((r) => setTimeout(r, 40)), { notificationState: 'accepts-notifications', speakerMuted: false }),
      micUsers: async () => (await new Promise((r) => setTimeout(r, 40)), []),
      speak: async (t) => void said.push(t),
      prerender: async (t) => void rendered.push(t),
      armActivity: (on) => void armed.push(on),
      openWindow: () => {},
      saveRecent: (r) => void (st.recent = r),
      log: () => {},
    });
    return { g, said, rendered, armed, st, advance: (ms: number) => (now += ms) };
  }
  it('locking pre-renders the unlock line; unlock plays exactly that line', async () => {
    const t = make();
    t.g.onSession('lock');
    expect(t.rendered).toHaveLength(1);
    expect(await t.g.onSession('unlock')).toBe(true);
    expect(t.said).toEqual(t.rendered);
  });
  it('a pre-picked line from another time of day is stale and re-picked', async () => {
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0); // the first line of each pool
    try {
      const t = make();
      t.g.onSession('lock');
      expect(t.rendered[0]).toMatch(/morning/i); // a morning-only line
      t.advance(5 * 3600_000); // 9:00 → 14:00
      await t.g.onSession('unlock');
      expect(t.said).toHaveLength(1);
      expect(t.said[0]).not.toBe(t.rendered[0]);
    } finally {
      rnd.mockRestore();
    }
  });
  it('away → armed for the first input + pre-rendered; first input greets once', async () => {
    const t = make();
    t.g.tick(25 * 60_000);
    expect(t.armed).toEqual([true]);
    expect(t.rendered).toHaveLength(1);
    expect(await t.g.onActivity()).toBe(true);
    expect(t.said).toEqual(t.rendered);
    expect(t.g.onActivity()).toBeUndefined(); // not away any more
  });
  it('suppression checks run in parallel and still apply', async () => {
    const t = make();
    const t0 = Date.now();
    await t.g.greet('unlock');
    expect(Date.now() - t0).toBeLessThan(75); // 2 × 40 ms checks, concurrently
    const q = make();
    q.st.quietStart = '08:00';
    q.st.quietEnd = '10:00';
    q.g.onSession('lock');
    expect(await q.g.onSession('unlock')).toBe(false);
    expect(q.said).toEqual([]);
  });
});
