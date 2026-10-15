// Round 12: "Chat with Cadabra on WhatsApp" against a FAKE WhatsApp Agent
// Platform server (no calls to api.whatsapp.com). Covers the long-poll and
// offsets, 204 / 429 / 503 / 500 handling, pairing and the owner lock, code
// confirmations, the remote "stop", voice notes (fake decoder) and pictures.
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WhatsAppClient, WaError } from '../src/main/whatsapp/client';
import { RemoteBridge, chunkReply, idHash, type RemoteDeps, type RemoteState } from '../src/main/whatsapp/bridge';

type Handler = (req: http.IncomingMessage, body: string, url: URL) => { status: number; json?: unknown; raw?: Buffer } | null;

async function fakePlatform(handlers: Handler[] = []) {
  const reqs: { method: string; path: string; query: Record<string, string>; auth: string; body: any }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        /* multipart */
      }
      reqs.push({ method: req.method!, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: String(req.headers.authorization ?? ''), body });
      for (const h of handlers) {
        const r = h(req, raw, url);
        if (r) {
          res.writeHead(r.status, r.raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' });
          return res.end(r.raw ?? (r.json != null ? JSON.stringify(r.json) : ''));
        }
      }
      if (url.pathname.endsWith('/updates')) return res.writeHead(204).end();
      if (url.pathname.endsWith('/messages')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.${reqs.length}` }] }));
      if (url.pathname.endsWith('/statuses')) return res.writeHead(200).end('{"success":true}');
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}/agent/v1`;
  return { base, reqs, close: () => server.close() };
}

const update = (messages: unknown[], next: number) => ({
  status: 200,
  json: { object: 'whatsapp_agent_platform', entry: [{ id: '123', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', contacts: [], messages, statuses: [] } }] }], next_offset: next },
});
const text = (from: string, body: string, id = `wamid.in.${Math.random()}`) => ({ from, id, timestamp: '1736844652', type: 'text', text: { body } });
const OWNER = 'user:50972923564215';
const servers: { close(): void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

describe('client: long-poll and sends follow the manual', () => {
  it('first poll omits offset (no 30-day backlog); later polls pass next_offset unchanged; 204 = nothing', async () => {
    let n = 0;
    const p = await fakePlatform([(_r, _b, u) => (u.pathname.endsWith('/updates') && n++ === 0 ? update([text(OWNER, 'hi')], 1288) : null)]);
    servers.push(p);
    const c = new WhatsAppClient(() => 'test-token', p.base);
    const a = await c.poll(undefined, 0);
    expect(a).toMatchObject({ nextOffset: 1288, messages: [{ from: OWNER, type: 'text', text: { body: 'hi' } }] });
    const b = await c.poll(1288, 0);
    expect(b).toEqual({ messages: [], nextOffset: null });
    expect(p.reqs[0].query).toEqual({ limit: '100', timeout: '0' });
    expect(p.reqs[1].query.offset).toBe('1288');
    expect(p.reqs[0].auth).toBe('Bearer test-token');
  });
  it('send: 503/131016 is retried; 500 is NOT re-sent (outcome unknown); 4xx is not retried', async () => {
    let calls = 0;
    const p = await fakePlatform([
      (_r, _b, u) => {
        if (!u.pathname.endsWith('/messages')) return null;
        calls++;
        if (calls === 1) return { status: 503, json: { error: { code: 131016, message: '(#131016) Not accepted' } } };
        if (calls === 3) return { status: 500, json: { error: { code: 2 } } };
        if (calls === 4) return { status: 403, json: { error: { code: 131005 } } };
        return null;
      },
    ]);
    servers.push(p);
    const c = new WhatsAppClient(() => 't', p.base);
    expect(await c.send(OWNER, { type: 'text', text: 'hello' })).toMatch(/^wamid\./);
    expect(calls).toBe(2);
    await expect(c.send(OWNER, { type: 'text', text: 'again' })).rejects.toMatchObject({ status: 500, unknown: true });
    expect(calls).toBe(3); // not re-sent
    await expect(c.send(OWNER, { type: 'text', text: 'x' })).rejects.toMatchObject({ status: 403 });
    expect(calls).toBe(4);
    const sent = p.reqs.filter((r) => r.path.endsWith('/messages'))[0].body;
    expect(sent).toEqual({ messaging_product: 'whatsapp', to: OWNER, type: 'text', text: { body: 'hello', preview_url: false } });
  }, 15_000);
  it('a refused token is reported plainly; 429 is retryable', async () => {
    const p = await fakePlatform([(_r, _b, u) => (u.pathname.endsWith('/updates') ? { status: 400, json: { error: { code: 100 } } } : null)]);
    servers.push(p);
    const c = new WhatsAppClient(() => 'bad', p.base);
    await expect(c.poll(undefined, 0)).rejects.toThrow(/isn’t valid/);
    const e = new WaError('x', 429, 130429, true);
    expect(e.retryable).toBe(true);
  });
  it('long replies are split under 4096 characters', () => {
    const parts = chunkReply(`${'word '.repeat(1000)}\n\n${'more '.repeat(900)}`);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((x) => x.length <= 4096)).toBe(true);
  });
});

function bridgeWith(p: { base: string }, over: Partial<RemoteDeps> = {}) {
  const state: RemoteState = { offset: null, pairedFrom: '' };
  const logs: string[] = [];
  const codes: string[] = [];
  const handled: string[] = [];
  let stops = 0;
  const b = new RemoteBridge({
    client: new WhatsAppClient(() => 't', p.base),
    active: () => true,
    state: () => state,
    saveState: (s) => Object.assign(state, s),
    log: (m) => void logs.push(m),
    showPairingCode: (c) => void codes.push(c),
    locked: () => false,
    busyLocal: () => false,
    handle: async (t) => (handled.push(t), `You said: ${t}`),
    stop: () => void stops++,
    transcribe: async () => 'what time is it',
    ...over,
  });
  return { b, state, logs, codes, handled, stops: () => stops };
}
const sends = (p: { reqs: any[] }) => p.reqs.filter((r) => r.path.endsWith('/messages')).map((r) => r.body?.text?.body ?? r.body?.type);
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('pairing and the owner lock', () => {
  it('an unpaired chat gets pairing instructions; the code from the PC pairs it; the first message says it’s an AI agent', async () => {
    const p = await fakePlatform();
    servers.push(p);
    const x = bridgeWith(p);
    await x.b.onMessage(text(OWNER, 'hi'));
    expect(x.handled).toEqual([]);
    expect(x.codes).toHaveLength(1); // shown on the PC only
    expect(sends(p)[0]).toMatch(/send the 6-digit code/);
    expect(JSON.stringify(p.reqs)).not.toContain(x.codes[0]); // never sent to WhatsApp
    await x.b.onMessage(text(OWNER, x.codes[0]));
    expect(x.state.pairedFrom).toBe(OWNER);
    expect(sends(p)[1]).toMatch(/I’m Cadabra, an AI agent running on your PC/);
    await x.b.onMessage(text(OWNER, 'what is the weather'));
    await settle();
    expect(x.handled).toEqual(['what is the weather']);
    expect(sends(p).at(-1)).toBe('You said: what is the weather');
    // Read receipt + typing indicator for the owner's message.
    expect(p.reqs.some((r) => r.path.endsWith('/statuses') && r.body?.typing_indicator?.type === 'text')).toBe(true);
  });
  it('a different sender id is ignored (only an id hash is logged) and must pair again', async () => {
    const p = await fakePlatform();
    servers.push(p);
    const x = bridgeWith(p);
    x.state.pairedFrom = OWNER;
    await x.b.onMessage(text('user:999', 'delete my files'));
    expect(x.handled).toEqual([]);
    expect(x.logs.join('\n')).toContain(idHash('user:999'));
    expect(x.logs.join('\n')).not.toContain('user:999');
    expect(sends(p)[0]).toMatch(/isn’t paired/);
  });
});

describe('remote safety', () => {
  async function paired(over: Partial<RemoteDeps> = {}) {
    const p = await fakePlatform();
    servers.push(p);
    const x = bridgeWith(p, over);
    x.state.pairedFrom = OWNER;
    return { p, ...x };
  }
  it('risky actions ask IN the chat with a one-time code; only that code approves, once', async () => {
    const x = await paired();
    await x.b.onMessage(text(OWNER, 'hi')); // sets the reply target
    const ask = x.b.confirm({ title: 'Send this message in Outlook?', mono: 'See you at 5' });
    await settle();
    const prompt = sends(x.p).filter((t) => /Reply \d{4}/.test(t)).at(-1)!;
    const code = /Reply (\d{4})/.exec(prompt)![1];
    expect(prompt).toMatch(/Cadabra wants to: Send this message in Outlook\?/);
    await x.b.onMessage(text(OWNER, 'yes')); // a bare yes doesn't approve
    expect(await ask).toBe(false);
    const ask2 = x.b.confirm({ title: 'Send this message in Outlook?' });
    await settle();
    const code2 = /Reply (\d{4})/.exec(sends(x.p).filter((t) => /Reply \d{4}/.test(t)).at(-1)!)![1];
    expect(code2).toMatch(/^\d{4}$/);
    await x.b.onMessage(text(OWNER, `yes ${code2}`));
    expect(await ask2).toBe(true);
    expect(code).toMatch(/^\d{4}$/);
  });
  it('"stop" halts the running request', async () => {
    let release!: () => void;
    const x = await paired({ handle: () => new Promise<string>((r) => (release = () => r('done'))) });
    await x.b.onMessage(text(OWNER, 'clean up my desktop'));
    await settle();
    expect(x.b.busy).toBe(true);
    await x.b.onMessage(text(OWNER, 'Stop'));
    expect(x.stops()).toBe(1);
    expect(sends(x.p)).toContain('Stopped.');
    release();
  });
  it('a locked PC: says so and doesn’t act', async () => {
    const x = await paired({ locked: () => true });
    await x.b.onMessage(text(OWNER, 'open notepad'));
    expect(x.handled).toEqual([]);
    expect(sends(x.p).at(-1)).toMatch(/Your PC is locked/);
  });
  it('remote turns are rate-limited', async () => {
    const x = await paired();
    for (let i = 0; i < 7; i++) {
      await x.b.onMessage(text(OWNER, `q${i}`));
      await settle();
    }
    expect(x.handled).toHaveLength(6);
    expect(sends(x.p).at(-1)).toMatch(/a lot of requests/);
  });
});

describe('voice notes and pictures', () => {
  const media: Handler = (_r, _b, u) => {
    if (/\/media\/[\w-]+$/.test(u.pathname)) return { status: 200, json: { url: `http://127.0.0.1:${u.port || ''}/dl`, mime_type: 'audio/ogg', file_size: 4, id: 'm1', messaging_product: 'whatsapp' } };
    if (u.pathname === '/dl') return { status: 200, raw: Buffer.from('OggS') };
    return null;
  };
  it('a voice note is downloaded, decoded and transcribed on the PC, then answered', async () => {
    const p = await fakePlatform([media]);
    servers.push(p);
    // The fake media url must point at the fake server.
    const fixUrl: Handler = (req, b, u) => {
      if (/\/media\/[\w-]+$/.test(u.pathname)) return { status: 200, json: { url: `http://${req.headers.host}/dl`, mime_type: 'audio/ogg', file_size: 4 } };
      return media(req, b, u);
    };
    const p2 = await fakePlatform([fixUrl]);
    servers.push(p2);
    let got: Buffer | null = null;
    const x = bridgeWith(p2, { transcribe: async (bytes) => ((got = bytes), 'what time is it') });
    x.state.pairedFrom = OWNER;
    await x.b.onMessage({ from: OWNER, id: 'w1', timestamp: '1', type: 'audio', audio: { id: 'a1', mime_type: 'audio/ogg', voice: true } });
    await settle();
    expect(got!.toString()).toBe('OggS');
    expect(x.handled).toEqual(['what time is it']);
  });
  it('no decoder → "I can’t hear that voice note yet"', async () => {
    const p = await fakePlatform([(_req, _b, u) => (/\/media\/[\w-]+$/.test(u.pathname) ? { status: 200, json: { url: `${new URL(p.base).origin}/dl`, mime_type: 'audio/ogg' } } : u.pathname === '/dl' ? { status: 200, raw: Buffer.from('x') } : null)]);
    servers.push(p);
    const x = bridgeWith(p, { transcribe: async () => null });
    x.state.pairedFrom = OWNER;
    await x.b.onMessage({ from: OWNER, id: 'w2', timestamp: '1', type: 'audio', audio: { id: 'a2', mime_type: 'audio/ogg', voice: true } });
    expect(sends(p).at(-1)).toMatch(/can’t hear that voice note/);
    expect(x.handled).toEqual([]);
  });
  it('a screenshot is sent as an image and its upload is deleted right after', async () => {
    const p = await fakePlatform([(_r, _b, u) => (u.pathname.endsWith('/media') ? { status: 200, json: { id: 'up1' } } : null), (r, _b, u) => (r.method === 'DELETE' && u.pathname.endsWith('/media/up1') ? { status: 200, json: { success: true } } : null)]);
    servers.push(p);
    const x = bridgeWith(p);
    x.state.pairedFrom = OWNER;
    await x.b.onMessage(text(OWNER, 'hi'));
    await settle();
    await x.b.sendImage(Buffer.from([0xff, 0xd8, 0xff]), 'Your screen');
    const msg = p.reqs.filter((r) => r.path.endsWith('/messages')).at(-1)!.body;
    expect(msg).toEqual({ messaging_product: 'whatsapp', to: OWNER, type: 'image', image: { id: 'up1', caption: 'Your screen' } });
    expect(p.reqs.some((r) => r.method === 'DELETE' && r.path.endsWith('/media/up1'))).toBe(true);
  });
});

describe('the poll loop', () => {
  it('persists next_offset, re-polls with it, and backs off after a 500 without losing the offset', async () => {
    let n = 0;
    const p = await fakePlatform([
      (_r, _b, u) => {
        if (!u.pathname.endsWith('/updates')) return null;
        n++;
        if (n === 1) return update([], 41);
        if (n === 2) return { status: 500, json: { error: { code: 2 } } };
        return null; // 204
      },
    ]);
    servers.push(p);
    const x = bridgeWith(p);
    x.b.start();
    for (let i = 0; i < 60 && n < 3; i++) await new Promise((r) => setTimeout(r, 100));
    x.b.stopLoop();
    expect(x.state.offset).toBe(41);
    const polls = p.reqs.filter((r) => r.path.endsWith('/updates'));
    expect(polls[0].query.offset).toBeUndefined(); // first poll: new traffic only
    expect(polls[1].query.offset).toBe('41');
    expect(polls[2].query.offset).toBe('41'); // after the 500: same offset
    expect(x.logs.join('\n')).toMatch(/poll failed \(500\)/);
  }, 15_000);
});
