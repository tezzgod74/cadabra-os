// Electron utilityProcess entry: Kokoro text-to-speech (sherpa-onnx
// OfflineTts) off the main thread. Synthesises sentence by sentence and posts
// each chunk as soon as it's ready, so playback of the first sentence starts
// while the rest is still being made.
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { accentConfig, voiceById } from '../../shared/voices';
import { readKokoroSpeakers } from './kokoro-meta';
import { shapeChunk } from './tts-shape';

const parentPort = (process as any).parentPort as {
  on(ev: 'message', cb: (e: { data: any }) => void): void;
  postMessage(m: unknown): void;
};

let sherpa: any = null;
let dir = '';
// REVIEW-3 TTS-1: a typical laptop has 4 physical cores; never use more than 4
// threads (and leave the rest of the machine responsive).
let threads = Number(process.env.CADABRA_TTS_THREADS) || Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));
const engines = new Map<string, Promise<any>>(); // by accent
const cancelled = new Set<number>();
/** Round 5: open (streaming) requests: sentences keep arriving until 'end'. */
const streams = new Map<number, { sentences: string[]; ended: boolean; wake: (() => void) | null }>();
const active = new Set<number>();
let chain: Promise<void> = Promise.resolve();

function engineFor(accent: 'british' | 'american'): Promise<any> {
  let e = engines.get(accent);
  if (!e) {
    sherpa ??= createRequire(import.meta.url)('sherpa-onnx-node');
    const { lang, lexicon } = accentConfig(voiceById(accent === 'british' ? 'bm_george' : 'af_heart'));
    e = sherpa.OfflineTts.createAsync({
      model: {
        kokoro: {
          model: path.join(dir, 'model.onnx'),
          voices: path.join(dir, 'voices.bin'),
          tokens: path.join(dir, 'tokens.txt'),
          dataDir: path.join(dir, 'espeak-ng-data'),
          lexicon: path.join(dir, lexicon),
          lang,
        },
        numThreads: threads,
        provider: 'cpu',
        debug: false,
      },
      maxNumSentences: 1,
    });
    engines.set(accent, e!);
  }
  return e!;
}

parentPort.on('message', async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      dir = m.dir;
      if (m.threads) threads = m.threads;
      // Warm the default accent so the first reply doesn't pay the model load.
      const t0 = Date.now();
      await engineFor(voiceById(m.voice).accent);
      parentPort.postMessage({ type: 'ready', loadMs: Date.now() - t0 });
    } else if (m.type === 'cancel') {
      cancelled.add(m.id);
      streams.get(m.id)?.wake?.();
    } else if (m.type === 'append' || m.type === 'end') {
      const st = streams.get(m.id);
      if (st) {
        if (m.type === 'append') st.sentences.push(...(m.sentences ?? []));
        else st.ended = true;
        st.wake?.();
      }
    } else if (m.type === 'speak') {
      // TTS-2: one request at a time; a new request cancels older ones.
      // REVIEW-10 #2: a background request (a pre-rendered greeting) never
      // cancels anything; it waits its turn in the chain.
      for (const id of m.background ? [] : active) {
        if (id === m.id) continue;
        cancelled.add(id);
        streams.get(id)?.wake?.();
      }
      active.add(m.id);
      const st = { sentences: [...m.sentences], ended: !m.open, wake: null as (() => void) | null };
      streams.set(m.id, st);
      const prev = chain;
      let release!: () => void;
      chain = new Promise<void>((r) => (release = r));
      await prev;
      try {
      const v = voiceById(m.voice);
      const tts = await engineFor(v.accent);
      // research §9: speaker ids from the model's own metadata; the table is the fallback.
      const sid = readKokoroSpeakers(path.join(dir, 'model.onnx')).get(v.id) ?? v.sid;
      const t0 = Date.now();
      for (let i = 0; ; i++) {
        if (cancelled.has(m.id)) break;
        if (i >= st.sentences.length) {
          if (st.ended) break;
          await new Promise<void>((r) => (st.wake = r));
          st.wake = null;
          i--;
          continue;
        }
        const ts = Date.now();
        // Electron's V8 memory cage forbids external ArrayBuffers, so the audio must
        // be copied into a V8-owned buffer (enableExternalBuffer: false; measured).
        const audio = await tts.generateAsync({ text: st.sentences[i], sid, speed: m.speed ?? 1, enableExternalBuffer: false });
        if (cancelled.has(m.id)) break;
        const last = st.ended && i === st.sentences.length - 1;
        parentPort.postMessage({
          type: 'audio',
          id: m.id,
          index: i,
          last,
          // Round 5 cadence: click-free edges and a natural pause between sentences.
          samples: shapeChunk(audio.samples, audio.sampleRate, { pauseMs: last ? 0 : 140 }),
          sampleRate: audio.sampleRate,
          synthMs: Date.now() - ts,
          sinceStartMs: Date.now() - t0,
        });
      }
      parentPort.postMessage({ type: 'done', id: m.id, cancelled: cancelled.has(m.id) });
      } finally {
        cancelled.delete(m.id);
        active.delete(m.id);
        streams.delete(m.id);
        release();
      }
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: m?.id, message: (err as Error).message });
  }
});
