// Round 12: a small client for the WhatsApp Agent Platform API
// (https://api.whatsapp.com/agent/v1; Developer manual v1, Aug 25 2026).
// The API token is passed in per call (it lives in safeStorage) and is never
// logged. Retry rules follow the manual: 2xx done; 4xx never retried except
// 429 (back off); 503 / code 131016 not sent → retry after backing off; 500, a
// reset or our own timeout leaves a send UNKNOWN → never blindly re-sent. Sends
// to the same recipient are serialised; rate limits are enforced client-side.

export const WA_BASE = 'https://api.whatsapp.com/agent/v1';

/** Rolling 60-second window limiter (the platform's limits are per method, per minute). */
export class RateLimiter {
  private stamps: number[] = [];
  constructor(
    readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}
  /** ms to wait before the next request (0 = go). */
  waitMs(): number {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 60_000);
    return this.stamps.length < this.perMinute ? 0 : 60_000 - (t - this.stamps[0]) + 5;
  }
  take(): void {
    this.stamps.push(this.now());
  }
}

export class WaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
    /** May the request be retried after backing off? */
    readonly retryable: boolean,
    /** A send whose outcome is unknown (500 / reset / timeout): don't re-send blindly. */
    readonly unknown = false,
  ) {
    super(message);
  }
}

export interface WaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  audio?: { id: string; mime_type: string; voice?: boolean };
  video?: { id: string; mime_type: string; caption?: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
  sticker?: { id: string; mime_type: string };
  reaction?: { message_id: string; emoji: string };
}

export interface WaPoll {
  /** 204 → no entries (re-poll with the same offset). */
  messages: WaMessage[];
  nextOffset: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WhatsAppClient {
  readonly limits = {
    updates: new RateLimiter(15),
    messages: new RateLimiter(12),
    statuses: new RateLimiter(12),
    mediaGet: new RateLimiter(12),
    mediaPost: new RateLimiter(12),
    mediaDelete: new RateLimiter(12),
  };
  private sendChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly token: () => string | undefined,
    private readonly base = WA_BASE,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private headers(json = true): Record<string, string> {
    const t = this.token();
    if (!t) throw new WaError('No WhatsApp API token is set.', 0, null, false);
    return { Authorization: `Bearer ${t}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
  }

  private async limited(l: RateLimiter, signal?: AbortSignal) {
    for (let w = l.waitMs(); w > 0; w = l.waitMs()) {
      if (signal?.aborted) throw new WaError('Stopped.', 0, null, false);
      await sleep(Math.min(w, 2000));
    }
    l.take();
  }

  private static async error(res: Response): Promise<WaError> {
    const j: any = await res.json().catch(() => ({}));
    const code = typeof j?.error?.code === 'number' ? j.error.code : null;
    const msg = res.status === 401 || code === 190 ? 'WhatsApp refused the API token (missing or malformed).' : code === 100 && res.status === 400 ? 'WhatsApp says the API token isn’t valid (it may have been regenerated).' : res.status === 403 ? 'WhatsApp only lets the agent message its creator.' : `WhatsApp error ${res.status}${code ? ` (code ${code})` : ''}.`;
    return new WaError(msg, res.status, code, res.status === 429 || res.status === 503 || (res.status >= 500 && res.status !== 500) || res.status === 409, res.status === 500);
  }

  /** Long-poll for updates. `offset` undefined = only new traffic (first poll). */
  async poll(offset: number | undefined, timeoutSec = 25, signal?: AbortSignal): Promise<WaPoll> {
    await this.limited(this.limits.updates, signal);
    const q = new URLSearchParams({ limit: '100', timeout: String(timeoutSec) });
    if (offset != null) q.set('offset', String(offset));
    const res = await this.fetchFn(`${this.base}/updates?${q}`, { headers: this.headers(false), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout((timeoutSec + 15) * 1000)]) : AbortSignal.timeout((timeoutSec + 15) * 1000) });
    if (res.status === 204) return { messages: [], nextOffset: null };
    if (!res.ok) throw await WhatsAppClient.error(res);
    const j: any = await res.json();
    const messages: WaMessage[] = [];
    for (const e of j?.entry ?? []) for (const c of e?.changes ?? []) for (const m of c?.value?.messages ?? []) messages.push(m);
    return { messages, nextOffset: typeof j?.next_offset === 'number' ? j.next_offset : null };
  }

  private async post(path: string, body: unknown, l: RateLimiter, signal?: AbortSignal): Promise<any> {
    await this.limited(l, signal);
    const res = await this.fetchFn(`${this.base}${path}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }).catch((e) => {
      throw new WaError(`Couldn't reach WhatsApp (${(e as Error).name}).`, 0, null, false, true);
    });
    if (!res.ok) throw await WhatsAppClient.error(res);
    return res.json().catch(() => ({}));
  }

  /**
   * Send a message to the owner. Serialised (no concurrent sends to one
   * recipient). Retries only 429 and 503/131016, with backoff; a 500 / reset
   * is reported as unknown and NOT re-sent.
   */
  send(to: string, payload: { type: 'text'; text: string } | { type: 'image' | 'audio' | 'document'; id: string; caption?: string; filename?: string }): Promise<string> {
    const run = async () => {
      const body: any = { messaging_product: 'whatsapp', to, type: payload.type };
      if (payload.type === 'text') body.text = { body: payload.text.slice(0, 4096), preview_url: /https?:\/\//.test(payload.text) };
      else body[payload.type] = { id: payload.id, ...(payload.caption ? { caption: payload.caption.slice(0, 1024) } : {}), ...(payload.filename ? { filename: payload.filename } : {}) };
      for (let attempt = 0; ; attempt++) {
        try {
          const j = await this.post('/messages', body, this.limits.messages);
          return String(j?.messages?.[0]?.id ?? '');
        } catch (e) {
          const w = e as WaError;
          const retry = w instanceof WaError && (w.status === 429 || (w.status === 503 && (w.code === 131016 || w.code == null))) && attempt < 3;
          if (!retry) throw e;
          await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        }
      }
    };
    const p = this.sendChain.then(run, run);
    this.sendChain = p.catch(() => undefined);
    return p;
  }

  /** Read receipt, optionally with the typing indicator (≤ 25 s; repeat to refresh). */
  async markRead(messageId: string, typing = false): Promise<void> {
    await this.post('/statuses', { messaging_product: 'whatsapp', status: 'read', message_id: messageId, ...(typing ? { typing_indicator: { type: 'text' } } : {}) }, this.limits.statuses).catch(() => undefined);
  }

  /** Download an inbound media object (metadata, then the bytes from its url). */
  async download(mediaId: string, maxBytes = 16 * 1024 * 1024): Promise<{ bytes: Buffer; mime: string }> {
    await this.limited(this.limits.mediaGet);
    // Round 12.6: never follow a redirect with the key (it could lead to another host).
    const meta = await this.fetchFn(`${this.base}/media/${encodeURIComponent(mediaId)}`, { headers: this.headers(false), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!meta.ok) throw await WhatsAppClient.error(meta);
    const m: any = await meta.json();
    // Round 12.5: the token goes only to WhatsApp's own hosts (the API host, or the manual's
    // media host lookaside.fbsbx.com) over https — or to this client's own base host (tests).
    if (typeof m?.url !== 'string' || !this.mediaHostAllowed(m.url)) throw new WaError('WhatsApp sent a media address Cadabra doesn’t trust.', 0, null, false);
    if (typeof m.file_size === 'number' && m.file_size > maxBytes) throw new WaError('That file is too big.', 0, null, false);
    const res = await this.fetchFn(m.url, { headers: this.headers(false), redirect: 'error', signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw await WhatsAppClient.error(res);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new WaError('That file is too big.', 0, null, false);
    return { bytes, mime: String(m.mime_type ?? res.headers.get('content-type') ?? 'application/octet-stream') };
  }

  /** May the API token be sent to this media url? */
  mediaHostAllowed(url: string): boolean {
    try {
      const u = new URL(url);
      const base = new URL(this.base);
      if (u.origin === base.origin) return true; // the API host itself (or the fake server in tests)
      return u.protocol === 'https:' && ['api.whatsapp.com', 'lookaside.fbsbx.com'].includes(u.hostname) && !u.username && !u.password && !u.port;
    } catch {
      return false;
    }
  }

  /** Delete an uploaded media object (research §11: don't leave screenshots on the service for 30 days). */
  async deleteMedia(mediaId: string): Promise<void> {
    await this.limited(this.limits.mediaDelete);
    const res = await this.fetchFn(`${this.base}/media/${encodeURIComponent(mediaId)}`, { method: 'DELETE', headers: this.headers(false), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw await WhatsAppClient.error(res);
  }

  /** Upload media for an outbound message; returns its id. */
  async upload(bytes: Buffer, mime: string, filename: string): Promise<string> {
    await this.limited(this.limits.mediaPost);
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', mime);
    form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    const res = await this.fetchFn(`${this.base}/media`, { method: 'POST', headers: this.headers(false), body: form, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw await WhatsAppClient.error(res);
    const j: any = await res.json();
    if (typeof j?.id !== 'string') throw new WaError('WhatsApp returned no media id.', 0, null, false);
    return j.id;
  }
}
