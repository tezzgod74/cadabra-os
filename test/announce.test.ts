// 0.9.6: announcements — parsing (WhatsApp prefix, PC phrasings), the length cap
// and rate limit, the Announcer (muted, quiet hours, stop, ducking restored), the
// WhatsApp fast path (no AI, works while locked, "stop"), the announce tool's
// gate, and settings persistence.
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Announcer, announceReply, type AnnouncerDeps } from '../src/main/announce';
import { RemoteBridge, type RemoteState } from '../src/main/whatsapp/bridge';
import { WhatsAppClient } from '../src/main/whatsapp/client';
import { AnnounceRateLimit, capAnnouncement, DEFAULT_ANNOUNCEMENTS, mergeAnnouncements, parseLocalAnnouncement, parseRemoteAnnouncement } from '../src/shared/announce';
import { DEFAULT_SAFETY } from '../src/shared/safety';
import { mergeSettings, sanitizeRendererPatch } from '../src/shared/settings';
import type { SafetySettings } from '../src/shared/types';

describe('parsing', () => {
  it('WhatsApp: "Announcement:", "Announce:" and 📢, case-insensitive; the text exactly as written', () => {
    expect(parseRemoteAnnouncement('Announcement: Please take out the trash')).toBe('Please take out the trash');
    expect(parseRemoteAnnouncement('ANNOUNCE:   Dinner is READY, everyone!  ')).toBe('Dinner is READY, everyone!');
    expect(parseRemoteAnnouncement('announcement:Kids — bedtime in 10 min.')).toBe('Kids — bedtime in 10 min.');
    expect(parseRemoteAnnouncement('📢 Movie starts at 7:30')).toBe('Movie starts at 7:30');
    expect(parseRemoteAnnouncement('Announcement:')).toBe('');
    for (const t of ['Announcements are fun', 'please announce dinner', 'what is an announcement?', 'the announcement: later']) expect(parseRemoteAnnouncement(t), t).toBeNull();
  });
  it('PC: "make an announcement: …", "announce …", "announce that …", after the name; case kept', () => {
    expect(parseLocalAnnouncement('Cadabra, make an announcement: Dinner is ready!')).toBe('Dinner is ready!');
    expect(parseLocalAnnouncement('Nova, announce that the car is HERE', ['Nova'])).toBe('the car is HERE');
    expect(parseLocalAnnouncement('announce Dinner in 5 minutes')).toBe('Dinner in 5 minutes');
    expect(parseLocalAnnouncement('hey cadabra please make an announcement saying “Shoes on, we leave now”')).toBe('Shoes on, we leave now');
    expect(parseLocalAnnouncement('Cadabra, make an announcement')).toBeNull();
    expect(parseLocalAnnouncement("what's an announcement")).toBeNull();
    expect(parseLocalAnnouncement('open the announcements page')).toBeNull();
  });
  it('length cap (500) and rate limit (6 a minute)', () => {
    const long = 'word '.repeat(200);
    const c = capAnnouncement(long);
    expect(c.truncated).toBe(true);
    expect(c.text.length).toBeLessThanOrEqual(500);
    expect(capAnnouncement('short').truncated).toBe(false);
    let t = 0;
    const rl = new AnnounceRateLimit(6, () => t);
    for (let i = 0; i < 6; i++) expect(rl.take()).toBe(true);
    expect(rl.take()).toBe(false);
    t += 61_000;
    expect(rl.take()).toBe(true);
  });
});

function announcer(over: Partial<AnnouncerDeps> = {}, settings = { ...DEFAULT_ANNOUNCEMENTS }) {
  const spoken: { text: string; o: any }[] = [];
  const logs: string[] = [];
  let ducked = 0;
  let restored = 0;
  const a = new Announcer({
    settings: () => settings,
    muted: async () => false,
    inQuietHours: () => false,
    speak: async (text, o) => (spoken.push({ text, o }), 'done'),
    duck: async () => (ducked++, async () => void restored++),
    log: (l) => logs.push(l),
    ...over,
  });
  return { a, spoken, logs, settings, counts: () => ({ ducked, restored }) };
}

describe('Announcer', () => {
  it('speaks the text verbatim with the settings (chime, repeat, device, boost), ducks and restores', async () => {
    const x = announcer({}, { ...DEFAULT_ANNOUNCEMENTS, repeat: 2, device: 'Living Room Speaker', boost: true });
    expect(await x.a.announce('Please take out the trash', 'whatsapp')).toEqual({ ok: true, truncated: false });
    expect(x.spoken[0].text).toBe('Please take out the trash');
    expect(x.spoken[0].o).toMatchObject({ chime: true, repeat: 2, device: 'Living Room Speaker', boost: true });
    expect(x.counts()).toEqual({ ducked: 1, restored: 1 });
    // Logs: events only, never the text.
    expect(x.logs.join('\n')).not.toMatch(/trash/);
    expect(x.logs.join('\n')).toMatch(/\[announce\] whatsapp: spoken/);
  });
  it('muted speakers: not announced, and the sender is told why', async () => {
    const x = announcer({ muted: async () => true });
    const r = await x.a.announce('Hello', 'whatsapp');
    expect(r).toMatchObject({ ok: false });
    expect(announceReply(r)).toBe('📢 Not announced: Your PC’s sound is muted, so I didn’t announce it.');
    expect(x.spoken).toEqual([]);
  });
  it('quiet hours: still announced by default; skipped only when "respect quiet hours" is on', async () => {
    expect((await announcer({ inQuietHours: () => true }).a.announce('Hi there', 'pc')).ok).toBe(true);
    const r = await announcer({ inQuietHours: () => true }, { ...DEFAULT_ANNOUNCEMENTS, respectQuietHours: true }).a.announce('Hi there', 'pc');
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/quiet hours/) });
  });
  it('rate limit and truncation are reported', async () => {
    const x = announcer();
    for (let i = 0; i < 6; i++) expect((await x.a.announce(`n${i}`, 'pc')).ok).toBe(true);
    expect(await x.a.announce('one too many', 'pc')).toMatchObject({ ok: false, reason: expect.stringMatching(/a lot of announcements/) });
    const y = announcer();
    const r = await y.a.announce('x '.repeat(400), 'whatsapp');
    expect(r).toMatchObject({ ok: true, truncated: true });
    expect(announceReply(r)).toMatch(/shortened to the first 500 characters/);
  });
  it('stop (Esc / "stop") cuts it short; the other apps’ sound is restored anyway', async () => {
    let release!: () => void;
    const x = announcer({
      speak: (_t, o) =>
        new Promise((res) => {
          release = () => res('done');
          o.signal.addEventListener('abort', () => res('stopped'));
        }),
    });
    const p = x.a.announce('A long announcement', 'pc');
    await new Promise((r) => setTimeout(r, 10));
    expect(x.a.busy).toBe(true);
    x.a.stop();
    expect(await p).toMatchObject({ ok: false, stopped: true });
    expect(x.counts()).toEqual({ ducked: 1, restored: 1 });
    expect(x.a.busy).toBe(false);
    void release;
  });
  it('no voice available: a plain reason', async () => {
    const r = await announcer({ speak: async () => 'unavailable' }).a.announce('Hi', 'whatsapp');
    expect(announceReply(r)).toMatch(/Speech isn’t available/);
  });
});

describe('WhatsApp fast path', () => {
  const servers: { close(): void }[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));
  async function fake() {
    const sent: any[] = [];
    const server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        if (req.url!.includes('/messages')) sent.push(JSON.parse(b));
        res.writeHead(req.url!.includes('/updates') ? 204 : 200, { 'content-type': 'application/json' }).end(req.url!.includes('/messages') ? '{"messages":[{"id":"w"}]}' : '{"success":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    servers.push(server);
    return { base: `http://127.0.0.1:${(server.address() as any).port}/agent/v1`, sent };
  }
  function bridge(base: string, announce: (t: string, s: AbortSignal) => Promise<string>, locked = true) {
    const state: RemoteState = { offset: null, pairedFrom: 'user:1' };
    const handled: string[] = [];
    const b = new RemoteBridge({
      client: new WhatsAppClient(() => 't', base),
      active: () => true,
      state: () => state,
      saveState: (s) => Object.assign(state, s),
      log: () => {},
      showPairingCode: () => {},
      locked: () => locked,
      busyLocal: () => false,
      handle: async (t) => (handled.push(t), 'ok'),
      announce,
      stop: () => {},
      transcribe: async () => null,
    });
    return { b, handled };
  }
  const msg = (id: string, body: string) => ({ from: 'user:1', id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } });
  const texts = (sent: any[]) => sent.filter((m) => m.text).map((m) => m.text.body);

  it('"Announcement: …" is spoken verbatim with no AI turn, even with the PC locked, and the phone gets the result', async () => {
    const f = await fake();
    const said: string[] = [];
    const x = bridge(f.base, async (t) => (said.push(t), '📢 Announced on your PC.'), true);
    await x.b.onMessage(msg('a1', 'Announcement: Please take out the trash') as any);
    await new Promise((r) => setTimeout(r, 150));
    expect(said).toEqual(['Please take out the trash']);
    expect(x.handled).toEqual([]); // never went to the AI
    expect(texts(f.sent)).toEqual(['📢 Announced on your PC.']);
  });
  it('anything else still hits the locked-PC rule', async () => {
    const f = await fake();
    const x = bridge(f.base, async () => 'x', true);
    await x.b.onMessage(msg('a2', 'open notepad') as any);
    await new Promise((r) => setTimeout(r, 100));
    expect(texts(f.sent)[0]).toMatch(/Your PC is locked/);
  });
  it('"stop" from the phone stops an announcement', async () => {
    const f = await fake();
    let aborted = false;
    const x = bridge(f.base, (_t, signal) => new Promise((res) => signal.addEventListener('abort', () => ((aborted = true), res('📢 Not announced: The announcement was stopped.')))), false);
    await x.b.onMessage(msg('a3', '📢 Long story time') as any);
    await new Promise((r) => setTimeout(r, 50));
    await x.b.onMessage(msg('a4', 'stop') as any);
    await new Promise((r) => setTimeout(r, 100));
    expect(aborted).toBe(true);
    expect(texts(f.sent)).toContain('Stopped.');
  });
});

describe('the announce tool and settings', async () => {
  const { ToolHost } = await import('../src/main/tools');
  const { SafetyGate } = await import('../src/main/safety-gate');
  function host(prompt: string, autonomy: 'risky' | 'every' = 'risky') {
    const st: SafetySettings = { ...DEFAULT_SAFETY, autonomy, confirmAllActions: autonomy === 'every', grants: [] };
    const cards: { title: string; mono?: string }[] = [];
    const gate = new SafetyGate(() => st, { confirm: async (p) => (cards.push({ title: p.title, mono: p.mono }), false) });
    const h = new ToolHost({} as any, gate, { status: () => {} } as any);
    const said: string[] = [];
    h.announcer = { announce: async (t) => (said.push(t), { ok: true }) };
    h.run = { target: null, signal: new AbortController().signal, frame: null, nodes: new Map(), prompt, screen: [] } as any;
    return { h, cards, said };
  }
  const out = async (r: Promise<any>) => ((await r).content[0] as any).text as string;
  it('asked for an announcement: no card at the default level', async () => {
    const x = host('announce that dinner is ready');
    expect(await out(x.h.announceTool({ text: 'Dinner is ready' }))).toMatch(/^Announced/);
    expect(x.cards).toEqual([]);
    expect(x.said).toEqual(['Dinner is ready']);
  });
  it('not asked (e.g. a skill or the model deciding): a card with the exact text, and "no" means nothing is said', async () => {
    const x = host('remind everyone about dinner');
    expect(await out(x.h.announceTool({ text: 'Dinner is ready' }))).toMatch(/^Not done \(declined\)/);
    expect(x.cards).toEqual([{ title: 'Announce this out loud on the PC?', mono: 'Dinner is ready' }]);
    expect(x.said).toEqual([]);
  });
  it('"ask before every action" asks even when the user asked', async () => {
    const x = host('announce dinner', 'every');
    await x.h.announceTool({ text: 'Dinner' });
    expect(x.cards).toHaveLength(1);
  });
  it('settings: defaults, validation, and the device choice persists', () => {
    expect(DEFAULT_ANNOUNCEMENTS).toEqual({ chime: true, repeat: 1, boost: false, device: '', duck: true, respectQuietHours: false });
    expect(mergeAnnouncements({ repeat: 9, device: 'Living Room Speaker', boost: 'yes' })).toEqual({ ...DEFAULT_ANNOUNCEMENTS, repeat: 3, device: 'Living Room Speaker' });
    const s = mergeSettings({ announcements: { device: 'Living Room Speaker', repeat: 2 } });
    expect(s.announcements).toMatchObject({ device: 'Living Room Speaker', repeat: 2, chime: true });
    expect(mergeSettings(JSON.parse(JSON.stringify(s))).announcements.device).toBe('Living Room Speaker'); // survives a save/load
    expect(sanitizeRendererPatch({ announcements: { device: 'X' } })).toEqual({ announcements: { device: 'X' } });
  });
});
