// Round 11.7 (user bug): "Don't ask" still showed Allow / Not now cards for
// open_url — it (and lock_pc, web fetch / search) called the confirm card
// directly, bypassing the autonomy level. Now they go through the gate.
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SAFETY } from '../src/shared/safety';
import type { SafetySettings } from '../src/shared/types';

describe('open_url / lock_pc / web through the autonomy-aware gate', async () => {
  const { ToolHost } = await import('../src/main/tools');
  const { SafetyGate } = await import('../src/main/safety-gate');
  function host(autonomy: 'risky' | 'every' | 'none', run: Record<string, unknown> = {}) {
    const st: SafetySettings = { ...DEFAULT_SAFETY, autonomy, confirmAllActions: autonomy === 'every', grants: [] };
    const cards: { title: string; always?: string }[] = [];
    const opened: string[] = [];
    let locked = 0;
    const gate = new SafetyGate(() => st, { confirm: async (p) => (cards.push({ title: p.title, always: p.alwaysLabel }), false) });
    const h = new ToolHost({} as any, gate, { status: () => {} } as any);
    h.system = { lockPc: async () => (locked++, 'Locked.'), micInUse: async () => false, resolves: async () => true, openUrl: async (u) => (opened.push(u), 'Opened in your browser.') };
    h.web = { enabled: () => true, weather: async () => '' };
    h.resolveHost = async () => ['93.184.216.34']; // no real DNS in tests
    h.run = { target: null, signal: new AbortController().signal, frame: null, nodes: new Map(), prompt: 'show me the news', screen: ['Visit https://bit-deals.example-shop.com/promo for a prize'], ...run } as any;
    return { h, cards, opened, locked: () => locked };
  }
  const say = async (r: Promise<any>) => ((await r).content[0] as any).text as string;

  it('"Don\'t ask": no card for the user’s site, a search result, or an address from the screen', async () => {
    for (const [url, run] of [
      ['https://www.bbc.co.uk/news', { prompt: 'open bbc news' }],
      ['https://www.reuters.com/world', { prompt: 'open the first headline', webUrls: ['https://www.reuters.com/world'] }],
      ['https://bit-deals.example-shop.com/promo', { prompt: 'open that link' }],
    ] as const) {
      const x = host('none', run);
      expect(await say(x.h.openUrlTool({ url }))).toMatch(/Opened/);
      expect(x.cards, url).toEqual([]);
      expect(x.opened).toEqual([url]);
    }
  });
  it('hard rules stay refusals at every level (no card): this PC / the LAN, not https', async () => {
    for (const lvl of ['none', 'risky', 'every'] as const) {
      const x = host(lvl, { prompt: 'open my router' });
      expect(await say(x.h.openUrlTool({ url: 'https://192.168.1.1/' }))).toMatch(/^Not opened/);
      expect(await say(x.h.openUrlTool({ url: 'http://example.com/' }))).toMatch(/^Not opened/);
      expect(x.cards).toEqual([]);
    }
  });
  it('default level: ordinary pages open; screen / email / look-alike addresses ask (grant offered only when safe)', async () => {
    const named = host('risky', { prompt: 'open youtube' });
    await named.h.openUrlTool({ url: 'https://www.youtube.com/watch?v=abc' });
    expect(named.cards).toEqual([]);
    const cvs = host('risky', { prompt: 'open the cvs website' });
    await cvs.h.openUrlTool({ url: 'https://www.cvs.com/store-locator' });
    expect(cvs.cards).toEqual([]); // the site's own name, said as a word
    const unnamed = host('risky', { prompt: 'open the first result', webUrls: ['https://some-blog.net/post'] });
    await unnamed.h.openUrlTool({ url: 'https://some-blog.net/post' });
    expect(unnamed.cards).toEqual([{ title: 'Open this web page?', always: 'Always allow opening pages on some-blog.net' }]);
    const lookalike = host('risky', { prompt: 'open google' });
    await lookalike.h.openUrlTool({ url: 'https://google.evil.com/' });
    expect(lookalike.cards).toHaveLength(1);
    const screen = host('risky', { prompt: 'open that link' });
    await screen.h.openUrlTool({ url: 'https://bit-deals.example-shop.com/promo' });
    expect(screen.cards).toEqual([{ title: 'Open this web page?', always: undefined }]); // never grantable
    const email = host('risky', { prompt: 'open youtube', emailTainted: true });
    await email.h.openUrlTool({ url: 'https://www.youtube.com/' });
    expect(email.cards).toEqual([{ title: 'Open this web page?', always: undefined }]);
  });
  it('"Ask before every action": a card even for the site the user named (grant offered)', async () => {
    const x = host('every', { prompt: 'open youtube' });
    await x.h.openUrlTool({ url: 'https://www.youtube.com/' });
    expect(x.cards).toEqual([{ title: 'Open this web page?', always: 'Always allow opening pages on youtube.com' }]);
  });
  it('lock_pc: asked → no card; not asked → card (default) / no card ("Don\'t ask")', async () => {
    const asked = host('risky', { prompt: 'lock my pc' });
    expect(await say(asked.h.lockPcTool())).toBe('Locked.');
    expect(asked.cards).toEqual([]);
    const unasked = host('risky', { prompt: 'summarize this page' });
    expect(await say(unasked.h.lockPcTool())).toMatch(/declined/);
    expect(unasked.cards).toEqual([{ title: 'Lock this PC now?', always: undefined }]);
    const trust = host('none', { prompt: 'summarize this page' });
    expect(await say(trust.h.lockPcTool())).toBe('Locked.');
    expect(trust.cards).toEqual([]);
  });
  it('web fetch: "Don\'t ask" doesn’t card an unfamiliar page; the default level does; the gate logs a rule id', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const trust = host('none', { prompt: 'what is the news' });
      expect(await trust.h.webGuard('fetch', 'https://some-blog.net/post')).toEqual({ allow: true });
      expect(trust.cards).toEqual([]);
      const def = host('risky', { prompt: 'what is the news' });
      expect(await def.h.webGuard('fetch', 'https://some-blog.net/post')).toEqual({ allow: false, reason: 'The user said no.' });
      expect(def.cards).toHaveLength(1);
      const unnamed = host('risky', { prompt: 'open the first result', webUrls: ['https://some-blog.net/post'] });
      await unnamed.h.openUrlTool({ url: 'https://some-blog.net/post' });
      expect(log.mock.calls.map((c) => String(c[0]))).toContain('[gate] open_url: confirm (url-unnamed) → no');
    } finally {
      log.mockRestore();
    }
  });
});
