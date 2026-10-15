// Round 12.6: REVIEW-12.5 top 5.
import fs from 'node:fs';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { confirmDetail, maskedPreview, RemoteBridge, type RemoteState } from '../src/main/whatsapp/bridge';
import { WhatsAppClient } from '../src/main/whatsapp/client';
import { screenshotRequested } from '../src/main/tools';

describe('S1: what a WhatsApp confirmation shows', () => {
  it('terminal commands, programs and web addresses in full', () => {
    const cmd = 'Remove-Item -Recurse -Force C:\\Users\\me\\Downloads\\old-builds-2026-10-01';
    expect(confirmDetail({ title: 'Run this command?', mono: cmd, kind: 'terminal' })).toBe(cmd);
    const url = 'https://some-blog.net/a/very/long/path?with=query&and=more';
    expect(confirmDetail({ title: 'Open this web page?', mono: url, kind: 'open_url' })).toBe(url);
  });
  it('typed text: a short masked preview, short secrets masked too', () => {
    expect(confirmDetail({ title: 'Type this in Notepad?', mono: 'my password is hunter2', kind: 'type_text' })).toBe('“my password is •••”');
    expect(maskedPreview('pin: 4821 please')).toBe('pin: ••• please');
    expect(maskedPreview('the code 7X2-9QK works')).toBe('the code ••• works');
  });
  it('nothing at all for password / secret fields', () => {
    expect(confirmDetail({ title: 'Fill in “Password”?', mono: 'hunter2', kind: 'set_value' })).toBe('(hidden: a password or secret field)');
  });
});

describe('F1: WhatsApp runs and the helper input epoch (production wiring)', () => {
  const src = fs.readFileSync('src/main/app.ts', 'utf8');
  it('a WhatsApp run advances the input epoch like a PC run (an old Esc can’t block it)', () => {
    const i = src.indexOf("this.tools.setRunFor('whatsapp', run);");
    expect(i).toBeGreaterThan(0);
    expect(src.slice(i, i + 400)).toMatch(/this\.helper\.inputEpoch = run\.id/);
  });
  it('a remote "stop" cancels in-progress typing / clicks (helper cancel), like Esc', () => {
    expect(src).toMatch(/stop: \(\) => \{\s*\/\/ Round 12\.6[^\n]*\n\s*void this\.helper\?\.cancelInput\(this\.tools\.runOf\('whatsapp'\)\?\.id/);
  });
});

describe('media download never follows a redirect with the key', () => {
  const servers: http.Server[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));
  it('a redirect is refused and the other host never sees the token', async () => {
    let otherHit = '';
    const other = http.createServer((req, res) => ((otherHit = String(req.headers.authorization ?? 'none')), res.end('x')));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
    servers.push(other);
    const api = http.createServer((req, res) => {
      if (req.url!.includes('/media/')) return res.writeHead(302, { location: `http://127.0.0.1:${(other.address() as any).port}/steal` }).end();
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    servers.push(api);
    const c = new WhatsAppClient(() => 'secret-token', `http://127.0.0.1:${(api.address() as any).port}/agent/v1`);
    await expect(c.download('m1')).rejects.toThrow();
    expect(otherHit).toBe('');
  });
});

describe('screenshot phrases (wider, still strict)', () => {
  it('asks', () => {
    for (const t of ['send me a pic of my screen', 'a photo of the screen please', 'picture of my desktop', 'snapshot of my screen', 'screenshot please', 'what does my screen look like', 'grab a screengrab'])
      expect(screenshotRequested(t), t).toBe(true);
  });
  it('not asks', () => {
    for (const t of ['show me the weather', 'my screen time today', 'order a screen protector', 'a picture of a cat', 'what does the weather look like']) expect(screenshotRequested(t), t).toBe(false);
  });
});

describe('"Stop it and continue": the PC takes over from WhatsApp', () => {
  it('the bridge stops the WhatsApp run and tells the phone', async () => {
    const sent: string[] = [];
    const server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        if (req.url!.includes('/messages')) sent.push(JSON.parse(b).text?.body ?? '');
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"messages":[{"id":"w"}],"success":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const state: RemoteState = { offset: null, pairedFrom: 'user:1' };
      let stops = 0;
      let aborted = false;
      const b = new RemoteBridge({
        client: new WhatsAppClient(() => 't', `http://127.0.0.1:${(server.address() as any).port}/agent/v1`),
        active: () => true,
        state: () => state,
        saveState: () => {},
        log: () => {},
        showPairingCode: () => {},
        locked: () => false,
        busyLocal: () => false,
        handle: (_t, ctx) => new Promise<string>((r) => ctx.signal.addEventListener('abort', () => ((aborted = true), r('')))),
        stop: () => void stops++,
        transcribe: async () => null,
      });
      await b.onMessage({ from: 'user:1', id: 'w1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'tidy my desktop' } });
      await new Promise((r) => setTimeout(r, 100));
      expect(b.busy).toBe(true);
      await b.takeOver();
      await new Promise((r) => setTimeout(r, 50));
      expect(aborted).toBe(true);
      expect(stops).toBe(1);
      expect(b.busy).toBe(false);
      expect(sent).toContain('Stopped — you took over at the PC.');
    } finally {
      server.close();
    }
  });
  it('the PC turn proceeds once the user chose to take over (and is refused otherwise)', async () => {
    const { ConversationController } = await import('../src/main/conversation');
    const mk = (take: boolean) => {
      let sent = 0;
      const events: any[] = [];
      const h: any = {
        settings: () => ({ provider: 'claude', voice: { speakReplies: 'never', followUpSeconds: 0, wakeWord: 'cadabra' }, displayName: '' }),
        now: () => Date.now(),
        provider: () => ({ send: () => (sent++, (async function* () { yield { type: 'text', delta: 'Done.' }; yield { type: 'done' }; })()) }),
        model: () => 'm',
        gate: { beginRun() {}, stop() {} },
        blocked: () => 'Nova is busy with a request from your WhatsApp right now.',
        takeOver: async () => take,
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
      return { c: new ConversationController(h), sent: () => sent, events };
    };
    const yes = mk(true);
    await yes.c.send('summarize this page', 'typed');
    expect(yes.sent()).toBe(1);
    const no = mk(false);
    await no.c.send('summarize this page', 'typed');
    expect(no.sent()).toBe(0);
    expect(no.events.find((e) => e.type === 'text')?.delta).toMatch(/busy with a request from your WhatsApp/);
  });
});
