// Round 12.5: REVIEW-12 — per-run channel (H1), stale messages, media host
// pinning, strict screenshot intent, masked confirmations, dedupe.
import fs from 'node:fs';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolHost, screenshotRequested } from '../src/main/tools';
import { SafetyGate, type ConfirmPrompt } from '../src/main/safety-gate';
import { DEFAULT_SAFETY } from '../src/shared/safety';
import { WhatsAppClient } from '../src/main/whatsapp/client';
import { RemoteBridge, maskedPreview, type RemoteState } from '../src/main/whatsapp/bridge';

const run = (over: Record<string, unknown> = {}) => ({ target: null, signal: new AbortController().signal, frame: null, nodes: new Map(), ...over }) as any;

describe('H1: every run carries its own channel', () => {
  it('a PC turn can’t replace or clear the WhatsApp run’s state (target, taint, autonomy)', () => {
    const h = new ToolHost({} as any, new SafetyGate(() => DEFAULT_SAFETY, { confirm: async () => false }), {} as any);
    const wa = run({ remote: true, autonomy: 'none', emailTainted: true, prompt: 'wa' });
    const pc = run({ target: { hwnd: 7, title: 'Notepad', process: 'notepad.exe', rect: { x: 0, y: 0, width: 1, height: 1 } }, prompt: 'pc' });
    h.setRunFor('whatsapp', wa);
    h.setRunFor('pc', pc);
    expect(h.run).toBe(pc);
    expect(h.runOf('whatsapp')).toBe(wa);
    h.setRunFor('pc', null); // the PC turn ends
    expect(h.run).toBe(wa); // the WhatsApp run is untouched
    expect(wa).toMatchObject({ channel: 'whatsapp', autonomy: 'none', emailTainted: true, target: null });
    expect(pc.channel).toBe('pc');
  });
  it('autonomy and confirm routing come from the run: remote "Don’t ask" never affects a PC turn', async () => {
    const cards: ConfirmPrompt[] = [];
    const gate = new SafetyGate(() => ({ ...DEFAULT_SAFETY, autonomy: 'risky' }), { confirm: async (p) => (cards.push(p), false) });
    const send = { kind: 'click' as const, elementName: 'Send', process: 'outlook.exe', title: 'Inbox - Outlook', hwnd: 5 };
    // WhatsApp run with remote autonomy "none": no card.
    await gate.authorize({ signal: new AbortController().signal, channel: 'whatsapp', autonomy: 'none' }, send);
    expect(cards).toEqual([]);
    // A PC run at the same time: the PC level (risky) applies and the card goes to the PC.
    await expect(gate.authorize({ signal: new AbortController().signal, channel: 'pc' }, send)).rejects.toThrow(/declined/);
    expect(cards.map((c) => c.channel)).toEqual(['pc']);
    // A WhatsApp run's card is routed to WhatsApp (no "Always allow").
    await expect(gate.authorize({ signal: new AbortController().signal, channel: 'whatsapp', autonomy: 'risky' }, send)).rejects.toThrow(/declined/);
    expect(cards[1]).toMatchObject({ channel: 'whatsapp', alwaysLabel: undefined });
  });
  it('a WhatsApp "stop" survives a PC summon (beginRun only resets its own channel)', async () => {
    const gate = new SafetyGate(() => DEFAULT_SAFETY, { confirm: async () => true });
    gate.beginRun('whatsapp');
    gate.stop('whatsapp');
    gate.beginRun('pc');
    expect(gate.isStoppedFor('whatsapp')).toBe(true);
    expect(gate.isStoppedFor('pc')).toBe(false);
    await expect(gate.authorize({ signal: new AbortController().signal, channel: 'whatsapp' }, { kind: 'scroll', process: 'x', hwnd: 1 })).rejects.toThrow(/Stopped/);
    await gate.authorize({ signal: new AbortController().signal, channel: 'pc' }, { kind: 'scroll', process: 'x', hwnd: 1 });
  });
  it('a PC request while WhatsApp is working is refused, not run concurrently', async () => {
    const { ConversationController } = await import('../src/main/conversation');
    const events: any[] = [];
    let sent = 0;
    const h: any = {
      settings: () => ({ provider: 'claude', voice: { speakReplies: 'never', followUpSeconds: 0, wakeWord: 'cadabra' }, displayName: '' }),
      now: () => Date.now(),
      provider: () => ({ send: () => (sent++, (async function* () { yield { type: 'done' }; })()) }),
      model: () => 'm',
      gate: { beginRun() {}, stop() {} },
      blocked: () => 'Nova is busy with a request from your WhatsApp right now. Press Esc to stop it, then ask again.',
      buildTurn: () => ({ run: {}, request: {} }),
      setRun() {},
      afterRun() {},
      hasPendingConfirm: () => false,
      resolveConfirm() {},
      rejectConfirms() {},
      localLaunch: async () => null,
      localIntent: async () => null,
      voice: { stopSpeaking() {}, armFollowUp() {}, speak: async () => {}, enabled: () => false },
      ui: { busy() {}, event: (e: any) => events.push(e), notice() {}, userEcho() {}, panelVisible: () => true, dismiss() {} },
    };
    const c = new ConversationController(h);
    await c.send('summarize this page', 'typed');
    expect(sent).toBe(0);
    expect(events.find((e) => e.type === 'text')?.delta).toMatch(/busy with a request from your WhatsApp/);
  });
  it('production wiring: each conversation host is bound to its channel; no global remote flag', () => {
    const src = fs.readFileSync('src/main/app.ts', 'utf8');
    expect(src).toMatch(/gate: \{ beginRun: \(\) => this\.gate\.beginRun\('pc'\), stop: \(\) => this\.gate\.stop\('pc'\) \}/);
    expect(src).toMatch(/gate: \{ beginRun: \(\) => this\.gate\.beginRun\('whatsapp'\), stop: \(\) => this\.gate\.stop\('whatsapp'\) \}/);
    expect(src).toMatch(/this\.tools\.setRunFor\('pc', run\)/);
    expect(src).toMatch(/this\.tools\.setRunFor\('whatsapp', run\)/);
    expect(src).toMatch(/channel: 'whatsapp', autonomy: this\.settings\.get\(\)\.remote\.autonomy/);
    expect(src).toMatch(/if \(p\.channel === 'whatsapp'\) return this\.remote\.confirm/);
    expect(src).not.toMatch(/remoteActive/);
  });
});

describe('WhatsApp hardening', () => {
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
  function bridge(base: string, now: number) {
    const state: RemoteState = { offset: null, pairedFrom: 'user:1' };
    const handled: string[] = [];
    const b = new RemoteBridge({
      client: new WhatsAppClient(() => 't', base),
      active: () => true,
      state: () => state,
      saveState: (s) => Object.assign(state, s),
      log: () => {},
      showPairingCode: () => {},
      locked: () => false,
      busyLocal: () => false,
      handle: async (t) => (handled.push(t), 'ok'),
      stop: () => {},
      transcribe: async () => null,
      now: () => now,
    });
    return { b, handled };
  }
  it('messages that waited while the PC was off are not acted on (one reply)', async () => {
    const f = await fake();
    const now = 1_760_000_000_000;
    const x = bridge(f.base, now);
    const old = { from: 'user:1', id: 'w-old', timestamp: String(Math.floor((now - 30 * 60_000) / 1000)), type: 'text', text: { body: 'delete my downloads' } };
    expect(x.b.isStale(old as any)).toBe(true);
    await (x.b as any).onStale([old, { ...old, id: 'w-old2' }]);
    expect(f.sent.map((m) => m.text.body)).toEqual(['I missed this while your PC was off or asleep. Send it again if you still want it.']);
    expect(x.handled).toEqual([]);
    expect(x.b.isStale({ ...old, timestamp: String(Math.floor(now / 1000) - 30) } as any)).toBe(false);
  });
  it('a re-delivered message is handled once', async () => {
    const f = await fake();
    const x = bridge(f.base, Date.now());
    const m = { from: 'user:1', id: 'w-dup', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hello' } };
    await x.b.onMessage(m as any);
    await new Promise((r) => setTimeout(r, 100));
    await x.b.onMessage(m as any);
    await new Promise((r) => setTimeout(r, 100));
    expect(x.handled).toEqual(['hello']);
  });
  it('the API token is only sent to WhatsApp’s own hosts', () => {
    const c = new WhatsAppClient(() => 't');
    expect(c.mediaHostAllowed('https://lookaside.fbsbx.com/agent/v1/media/abc/content')).toBe(true);
    expect(c.mediaHostAllowed('https://api.whatsapp.com/agent/v1/media/abc')).toBe(true);
    for (const u of ['https://evil.com/x', 'http://lookaside.fbsbx.com/x', 'https://lookaside.fbsbx.com.evil.com/x', 'https://u:p@lookaside.fbsbx.com/x', 'https://lookaside.fbsbx.com:8443/x', 'http://127.0.0.1:9/x']) expect(c.mediaHostAllowed(u), u).toBe(false);
    // The fake server in tests is this client's own base origin.
    expect(new WhatsAppClient(() => 't', 'http://127.0.0.1:5555/agent/v1').mediaHostAllowed('http://127.0.0.1:5555/dl')).toBe(true);
  });
  it('screenshots only when the owner asks to see the screen', () => {
    for (const t of ['show me my screen', 'send a screenshot', "what's on my screen?", 'screenshot please', 'can I see a screen capture', 'what do you see on my screen']) expect(screenshotRequested(t), t).toBe(true);
    for (const t of ['show me the weather', 'how much screen time did I have', 'show me my calendar', 'clean my screen protector order', 'what is on sale']) expect(screenshotRequested(t), t).toBe(false);
  });
  it('confirmations show a short masked preview, never the full text or secrets', () => {
    expect(maskedPreview('My card is 4111 1111 1111 1111 and the code is 482913')).toBe('My card is ••• ••• ••• ••• and the code …');
    expect(maskedPreview('use key sk_live_abcDEF1234567890xyz')).toBe('use key •••');
    expect(maskedPreview('x'.repeat(100)).length).toBeLessThanOrEqual(41);
  });
});
