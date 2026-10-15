// Round 9: REVIEW-8 top 10.
import { describe, expect, it } from 'vitest';
import { checkOpenUrl } from '../src/main/open-url';
import { checkWeb, isPrivateIp } from '../src/shared/web-guard';
import { hostNamedByUser, registrableDomain, urlNamedByUser } from '../src/shared/domains';
import { parseIntent } from '../src/shared/intents';

describe('R8-1: open_url is silent only for the exact site the user named', () => {
  const open = (url: string, prompt: string) => checkOpenUrl({ url, prompt }).decision;
  it("the reviewer's phishing probes now ask first", () => {
    expect(open('https://google.evil.com/', 'open google')).toBe('confirm');
    expect(open('https://youtube.com.evil.io/login', 'open youtube')).toBe('confirm');
    expect(open('https://news.evil.com/?d=project-falcon', 'show me the news')).toBe('confirm');
    expect(open('https://evil-google.com/', 'open google')).toBe('confirm');
    // Round 11.7: in the default level a page on the site the user named is ordinary and opens.
    expect(open('https://www.youtube.com/watch?v=abc123', 'open youtube')).toBe('allow');
  });
  it('the sites the user names still open straight away', () => {
    expect(open('https://www.google.com/', 'open google')).toBe('allow');
    expect(open('https://www.youtube.com/', 'open youtube in chrome')).toBe('allow');
    expect(open('https://mail.google.com/', 'open gmail')).toBe('allow');
    expect(open('https://www.bbc.co.uk/news', 'open bbc news')).toBe('allow');
    expect(open('https://www.example.org/docs', 'open example.org docs')).toBe('allow');
    expect(open('https://docs.example.org/', 'go to example.org')).toBe('allow'); // same registrable domain
  });
  it('a curated name only matches that exact host when it has a subdomain', () => {
    expect(open('https://accounts.google.com/', 'open gmail')).toBe('confirm');
    expect(hostNamedByUser('mail.google.com', 'check gmail')).toBe(true);
  });
  it('registrable domains come from the public-suffix list', () => {
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableDomain('https://youtube.com.evil.io/login')).toBe('evil.io');
    expect(registrableDomain('192.168.1.1')).toBe('');
  });
});

describe('R8-2: WebFetch "the user said it" = exact registrable domain, and nothing extra in the path or query', () => {
  const base = { tool: 'fetch' as const, enabled: true, screen: ['Project Falcon: ACME merger closes Friday'], resolved: ['93.184.216.34'] };
  it('netflix.com does not vouch for lix.com', () => {
    expect(checkWeb({ ...base, prompt: 'open netflix.com', text: 'https://lix.com/?d=falcon-merger' }).decision).toBe('confirm');
    expect(checkWeb({ ...base, prompt: 'open netflix.com', text: 'https://www.netflix.com/' }).decision).toBe('allow');
  });
  it('screen text in the query string or path needs a card', () => {
    expect(checkWeb({ ...base, prompt: 'check example.com', text: 'https://example.com/?q=project+falcon+acme+merger' }).decision).toBe('confirm');
    expect(checkWeb({ ...base, prompt: 'check example.com', text: 'https://example.com/project-falcon-acme-merger' }).decision).toBe('confirm');
    expect(checkWeb({ ...base, prompt: 'check example.com', text: 'https://example.com/' }).decision).toBe('allow');
  });
  it('whole words only', () => {
    expect(urlNamedByUser('https://example.com/lix', 'open example.com netflix')).toBe(false);
  });
});

describe('R8-3: DNS fails closed; special-purpose ranges', () => {
  const base = { tool: 'fetch' as const, enabled: true, screen: [], prompt: 'read https://www.reuters.com/world', text: 'https://www.reuters.com/world' };
  it('a failed lookup gets a card, not a silent fetch', () => {
    expect(checkWeb({ ...base, resolved: ['93.184.216.34'] }).decision).toBe('allow');
    expect(checkWeb({ ...base, resolved: [], resolveFailed: true }).decision).toBe('confirm');
  });
  it('NAT64, 192.0.0.0/24, TEST-NETs, 6to4, Teredo, documentation, discard', () => {
    for (const ip of ['64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b:1::1', '192.0.0.8', '192.0.2.1', '198.51.100.7', '203.0.113.9', '192.88.99.1', '2002:7f00:1::', '2001:0:4136:e378::1', '2001:db8::1', '100::1', '::7f00:1', '::127.0.0.1', '240.0.0.1', 'fec0::1'])
      expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) expect(isPrivateIp(ip), ip).toBe(false);
  });
});

describe('R8-4: lock_pc', async () => {
  const { ToolHost } = await import('../src/main/tools');
  const { SafetyGate } = await import('../src/main/safety-gate');
  const { DEFAULT_SAFETY } = await import('../src/shared/safety');
  const fx = { ghostMoveTo: async () => {}, ghostClick: () => {}, ghostHide: () => {}, highlight: () => {}, clearPoint: async () => () => {}, status: () => {} };
  function host(prompt: string, o: { onCall?: boolean; tainted?: boolean; answer?: boolean } = {}) {
    const asked: string[] = [];
    let locked = 0;
    const gate = new SafetyGate(() => DEFAULT_SAFETY, {
      confirm: async (p) => {
        asked.push(`${p.title} ${p.detail} ${p.risk}`);
        return !!o.answer;
      },
    });
    const h = new ToolHost({} as any, gate, fx as any);
    h.system = { lockPc: async () => (locked++, 'Locked.'), micInUse: async () => !!o.onCall, openUrl: async () => 'x' };
    h.run = { target: null, signal: new AbortController().signal, frame: null, nodes: new Map(), prompt, emailTainted: o.tainted };
    return { h, asked, locked: () => locked };
  }
  const say = async (x: ReturnType<typeof host>) => ((await x.h.lockPcTool()).content[0] as any).text as string;
  it('the user asked: locks without a card', async () => {
    const x = host('lock my computer');
    expect(await say(x)).toBe('Locked.');
    expect(x.asked).toEqual([]);
  });
  it('not asked (screen / web / email "told" the AI): a card, and no means no', async () => {
    const x = host('summarize this page');
    expect(await say(x)).toMatch(/declined/);
    expect(x.asked[0]).toMatch(/Lock this PC now\? /);
    expect(x.locked()).toBe(0);
  });
  it('after an email, or during a call: a card even when asked', async () => {
    expect((await say(host('lock my pc', { tainted: true }))).match(/declined/)).toBeTruthy();
    const call = host('lock my pc', { onCall: true, answer: true });
    expect(await say(call)).toBe('Locked.');
    expect(call.asked[0]).toMatch(/microphone/);
  });
  it('local fast path: only "anyway" overrides the call check (R9-2)', () => {
    expect(parseIntent('lock my pc')).toEqual({ kind: 'lock-pc', force: false });
    expect(parseIntent('lock my pc now')).toEqual({ kind: 'lock-pc', force: false });
    expect(parseIntent('lock my computer anyway')).toEqual({ kind: 'lock-pc', force: true });
  });
});

describe('R8-5: greeting window', async () => {
  const { GREETING_WINDOW_MS } = await import('../src/main/greeter');
  const { VoicePipeline } = await import('../src/main/voice/pipeline');
  it('is about 4 s', () => expect(GREETING_WINDOW_MS).toBe(4000));
  it('needs speech near the user’s own level and above background talk', () => {
    const p: any = Object.create(VoicePipeline.prototype);
    p.bgSpeech = 0.01;
    p.userLevel = 0.08;
    p.followStrict = false;
    expect(p.followThreshold()).toBeCloseTo(0.03);
    p.followStrict = true;
    expect(p.followThreshold()).toBeCloseTo(0.04); // within 6 dB of the user's level
    p.userLevel = 0; // not learned yet: still stricter than a normal follow-up
    expect(p.followThreshold()).toBeGreaterThan(0.03);
  });
});


// ---------------------------------------------------------------------------
// Round 9.5: REVIEW-9 items 2–5.
describe('R9-3: always-on mic apps can be marked "not a call"', async () => {
  const { exeName, appLabel, micUsersFromReg } = await import('../src/main/mic-usage');
  const { Greeter } = await import('../src/main/greeter');
  const { mergeSettings } = await import('../src/shared/settings');
  const BS = String.fromCharCode(92);
  const win = (...parts: string[]) => parts.join(BS);
  it('process names for Settings and the log', () => {
    expect(exeName(win('C:', 'Program Files', 'obs-studio', 'bin', '64bit', 'obs64.exe'))).toBe('obs64.exe');
    expect(appLabel(win('C:', 'Program Files', 'Zoom', 'Zoom.exe'))).toBe('zoom');
    const reg = [win('HKEY_CURRENT_USER', 'X', 'microphone', 'NonPackaged', 'C:#Tools#Voicemeeter#voicemeeter8x64.exe'), '    LastUsedTimeStart    REG_QWORD    0x1', '    LastUsedTimeStop    REG_QWORD    0x0'].join('\n');
    expect(micUsersFromReg(reg).map(exeName)).toEqual(['voicemeeter8x64.exe']);
  });
  it('the greeter log names the app', async () => {
    const logs: string[] = [];
    const g = new Greeter({
      now: () => Date.now(),
      settings: () => ({ enabled: true, awayMinutes: 20, quietStart: '', quietEnd: '', recent: [] }),
      name: () => '',
      dialect: () => null,
      voiceReady: () => true,
      userBusy: () => false,
      presence: async () => ({ notificationState: 'accepts-notifications', speakerMuted: false }),
      micUsers: async () => [win('C:', 'Program Files', 'NVIDIA Corporation', 'NVIDIA Broadcast', 'NVIDIA Broadcast.exe')],
      speak: async () => {},
      openWindow: () => {},
      saveRecent: () => {},
      log: (m) => void logs.push(m),
    });
    expect(await g.greet('unlock')).toBe(false);
    expect(logs[0]).toBe('[greet] skipped unlock: another app is using the microphone (nvidia broadcast.exe)');
  });
  it('the "not a call" list is sanitized (names only, no paths)', () => {
    const s = mergeSettings({ micNotCall: ['OBS64.exe', win('C:', 'evil', 'x.exe'), 'Microsoft.SkypeApp_kzf8qxf38zg5c', 42] });
    expect(s.micNotCall).toEqual(['obs64.exe', 'microsoft.skypeapp_kzf8qxf38zg5c']);
  });
});

describe("R9-4: open_url from this turn's search on a site the user named", () => {
  it('opens silently; query parameter names are ignored, values still checked', () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    expect(checkOpenUrl({ url, prompt: 'play never gonna give you up on youtube', webUrls: [url] }).decision).toBe('allow');
    expect(checkOpenUrl({ url, prompt: 'play never gonna give you up on youtube' }).decision).toBe('allow'); // round 11.7: the site the user named
    expect(checkOpenUrl({ url: 'https://evil.example-video.com/watch?v=1', prompt: 'play it on youtube', webUrls: ['https://evil.example-video.com/watch?v=1'] }).decision).toBe('confirm'); // site not named
    expect(urlNamedByUser('https://www.amazon.com/s?k=usb+cable', 'search amazon for usb cable')).toBe(true); // "k" is a name, not a value
    expect(urlNamedByUser('https://www.amazon.com/s?k=project+falcon', 'search amazon for usb cable')).toBe(false);
  });
});

describe('R9-5: Gmail client — one token refresh in flight, metadata 4 at a time', async () => {
  const http = await import('node:http');
  const { GmailApiBackend, METADATA_PARALLEL } = await import('../src/main/email/gmail-api');
  it('parallel callers share one refresh; at most 4 metadata requests at once; order kept', async () => {
    let tokenCalls = 0;
    let inFlight = 0;
    let peak = 0;
    const ids = Array.from({ length: 9 }, (_, i) => `abc${i}`);
    const server = http.createServer((req, res) => {
      const u = new URL(req.url!, 'http://x');
      const json = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      if (u.pathname === '/token') {
        tokenCalls++;
        setTimeout(() => json({ access_token: 'fake-access', expires_in: 3600 }), 30);
        return;
      }
      if (u.pathname === '/gmail/v1/users/me/messages') return json({ messages: ids.map((id) => ({ id })) });
      const id = u.pathname.split('/').pop()!;
      if (ids.includes(id)) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        setTimeout(() => {
          inFlight--;
          json({ id, internalDate: '1760000000000', snippet: 'hi', payload: { headers: [{ name: 'Subject', value: id }, { name: 'From', value: 'A <a@example.com>' }] } });
        }, 15);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const b = new GmailApiBackend({ clientId: '1-a.apps.googleusercontent.com' }, 'fake-refresh', { oauth2TokenUrl: `${base}/token`, gmailRoot: `${base}/` });
      const [r1, r2] = await Promise.all([b.search('in:inbox'), b.search('in:inbox')]);
      expect(tokenCalls).toBe(1);
      expect(peak).toBeLessThanOrEqual(METADATA_PARALLEL * 2); // two searches, 4 each
      expect(r1.map((x) => x.subject)).toEqual(ids);
      expect(r2).toHaveLength(9);
      peak = 0;
      await b.search('in:inbox');
      expect(peak).toBeLessThanOrEqual(METADATA_PARALLEL);
      expect(peak).toBeGreaterThan(1);
    } finally {
      server.close();
    }
  });
});
