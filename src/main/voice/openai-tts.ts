// Round 5 (research §9.4): the Southern / Texas voices are cloud-only — OpenAI
// gpt-4o-mini-tts with an accent instruction, using the USER'S OWN OpenAI key
// (stored encrypted, off by default). Audio streams as raw PCM (24 kHz, 16-bit
// mono) and is played chunk by chunk like the local voice. The key is never
// logged. Tests point CADABRA_OPENAI_BASE at a fake server; Cadabra's own tests
// never call OpenAI.
import { EventEmitter } from 'node:events';
import { SOUTHERN_INSTRUCTIONS, type VoiceOption } from '../../shared/voices';
import type { TtsChunk } from './kokoro-tts';

export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
export const PCM_RATE = 24_000;

export interface CloudTtsDeps {
  key: () => string | undefined;
  /** Default https://api.openai.com/v1 (tests: a local fake). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Little-endian 16-bit PCM → Float32 (keeps an odd trailing byte for the next chunk). */
export function pcm16ToFloat(buf: Uint8Array, carry: Uint8Array | null): { samples: Float32Array; carry: Uint8Array | null } {
  let b = buf;
  if (carry?.length) {
    const j = new Uint8Array(carry.length + buf.length);
    j.set(carry);
    j.set(buf, carry.length);
    b = j;
  }
  const n = Math.floor(b.length / 2);
  const out = new Float32Array(n);
  const dv = new DataView(b.buffer, b.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
  return { samples: out, carry: b.length % 2 ? b.slice(b.length - 1) : null };
}

interface Req {
  id: number;
  voice: VoiceOption;
  speed: number;
  sentences: string[];
  ended: boolean;
  wake: (() => void) | null;
  abort: AbortController;
}

/**
 * Same events as KokoroTts: 'chunk' (TtsChunk), 'done' ({id, cancelled}),
 * 'error' (Error, id). One request at a time; a new one cancels the old.
 */
export class CloudTts extends EventEmitter {
  private nextId = 1_000_000;
  private cur: Req | null = null;

  constructor(private readonly deps: CloudTtsDeps) {
    super();
  }

  get configured(): boolean {
    return !!this.deps.key()?.trim();
  }

  speak(sentences: string[], voice: VoiceOption, speed: number, open = false): number {
    if (this.cur) this.cancel(this.cur.id);
    const r: Req = { id: this.nextId++, voice, speed, sentences: [...sentences], ended: !open, wake: null, abort: new AbortController() };
    this.cur = r;
    void this.run(r);
    return r.id;
  }

  append(id: number, sentences: string[]) {
    if (this.cur?.id !== id) return;
    this.cur.sentences.push(...sentences);
    this.cur.wake?.();
  }

  end(id: number) {
    if (this.cur?.id !== id) return;
    this.cur.ended = true;
    this.cur.wake?.();
  }

  cancel(id: number) {
    if (this.cur?.id !== id) return;
    this.cur.abort.abort();
    this.cur.wake?.();
  }

  private async run(r: Req) {
    const t0 = Date.now();
    let index = 0;
    let i = 0;
    try {
      for (; ; i++) {
        if (r.abort.signal.aborted) break;
        if (i >= r.sentences.length) {
          if (r.ended) break;
          await new Promise<void>((res) => (r.wake = res));
          r.wake = null;
          i--;
          continue;
        }
        const ts = Date.now();
        const key = this.deps.key()?.trim();
        if (!key) throw new Error('No OpenAI API key (Settings → Voice → Southern voices).');
        const res = await (this.deps.fetchImpl ?? fetch)(`${this.deps.baseUrl ?? process.env.CADABRA_OPENAI_BASE ?? 'https://api.openai.com/v1'}/audio/speech`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: OPENAI_TTS_MODEL, voice: r.voice.openaiVoice, input: r.sentences[i], instructions: SOUTHERN_INSTRUCTIONS, response_format: 'pcm', speed: r.speed }),
          signal: r.abort.signal,
        });
        if (!res.ok || !res.body) {
          // Never echo the request (it carries the key); the status is enough.
          throw new Error(`OpenAI voice request failed (HTTP ${res.status})`);
        }
        let carry: Uint8Array | null = null;
        let pending: Float32Array[] = [];
        let pendingLen = 0;
        const flush = (last: boolean) => {
          if (!pendingLen && !last) return;
          const out = new Float32Array(pendingLen);
          let o = 0;
          for (const p of pending) {
            out.set(p, o);
            o += p.length;
          }
          pending = [];
          pendingLen = 0;
          const c: TtsChunk = { id: r.id, index: index++, last, samples: out, sampleRate: PCM_RATE, synthMs: Date.now() - ts, sinceStartMs: Date.now() - t0 };
          this.emit('chunk', c);
        };
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (r.abort.signal.aborted) break;
          const conv = pcm16ToFloat(value, carry);
          carry = conv.carry;
          pending.push(conv.samples);
          pendingLen += conv.samples.length;
          // ~0.25 s per chunk: low latency without thousands of tiny buffers.
          if (pendingLen >= PCM_RATE / 4) flush(false);
        }
        if (r.abort.signal.aborted) break;
        // A short pause between sentences (the local voice does the same).
        const isLast = r.ended && i === r.sentences.length - 1;
        if (!isLast) {
          pending.push(new Float32Array(Math.round(PCM_RATE * 0.12)));
          pendingLen += Math.round(PCM_RATE * 0.12);
        }
        flush(isLast);
      }
      this.emit('done', { id: r.id, cancelled: r.abort.signal.aborted });
    } catch (e) {
      if (r.abort.signal.aborted) this.emit('done', { id: r.id, cancelled: true });
      // The caller finishes the rest with the offline voice (same gender, American).
      else this.emit('error', e as Error, r.id, { remaining: r.sentences.slice(i), ended: r.ended });
    } finally {
      if (this.cur === r) this.cur = null;
    }
  }
}
