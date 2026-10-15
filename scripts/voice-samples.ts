// Renders reference lines in the persona voices to docs/voice-samples/
// (11 kHz µ-law WAVs: small, play in Windows), using the app's own text
// normalisation, speaker ids (read from the model), sentence splitting and
// round-5 cadence shaping. Also renders before/after cadence pairs.
//   CADABRA_TTS_DIR=<kokoro-multi-lang-v1_0> npx tsx scripts/voice-samples.ts
// Never plays audio. Southern (cloud) voices need an OpenAI key and are not
// rendered here.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readKokoroSpeakers } from '../src/main/voice/kokoro-meta';
import { shapeChunk } from '../src/main/voice/tts-shape';
import { speechSentences, toSpokenText } from '../src/shared/spoken-text';
import { accentConfig, voiceById } from '../src/shared/voices';

const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
const dir = process.env.CADABRA_TTS_DIR;
if (!dir) {
  console.error('Set CADABRA_TTS_DIR to the Kokoro v1.0 folder.');
  process.exit(2);
}
const out = path.resolve('docs/voice-samples');
fs.mkdirSync(path.join(out, 'before-after'), { recursive: true });
const threads = Number(process.env.CADABRA_TTS_THREADS ?? 4);
const sids = readKokoroSpeakers(path.join(dir, 'model.onnx'));
const engines: Record<string, any> = {};
function engine(accent: 'british' | 'american') {
  if (engines[accent]) return engines[accent];
  const { lang, lexicon } = accentConfig(voiceById(accent === 'british' ? 'bm_george' : 'af_heart'));
  engines[accent] = new sherpa.OfflineTts({
    model: { kokoro: { model: path.join(dir!, 'model.onnx'), voices: path.join(dir!, 'voices.bin'), tokens: path.join(dir!, 'tokens.txt'), dataDir: path.join(dir!, 'espeak-ng-data'), lexicon: path.join(dir!, lexicon), lang }, numThreads: threads, provider: 'cpu' },
    maxNumSentences: 1,
  });
  return engines[accent];
}

function muLawWav(samples: Float32Array, srcRate: number, rate = 11025): Buffer {
  const n = Math.floor((samples.length * rate) / srcRate);
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(7, 20); // µ-law
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) {
    const pos = (i * srcRate) / rate;
    const j = Math.floor(pos);
    const f = pos - j;
    const s = (samples[j] ?? 0) * (1 - f) + (samples[j + 1] ?? 0) * f;
    let x = Math.max(-32635, Math.min(32635, Math.round(s * 32767)));
    const sign = x < 0 ? 0x80 : 0;
    if (x < 0) x = -x;
    x += 132;
    let exp = 7;
    for (let m = 0x4000; (x & m) === 0 && exp > 0; m >>= 1) exp--;
    const mant = (x >> (exp + 3)) & 0x0f;
    buf[44 + i] = ~(sign | (exp << 4) | mant) & 0xff;
  }
  return buf;
}

const join = (parts: Float32Array[]) => {
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return all;
};

/** Round 5 (after): speed 1.05, merged sentences, trimmed edges, fades, 140 ms pauses. */
function renderAfter(voice: string, text: string, speed = 1.05) {
  const v = voiceById(voice);
  const sents = speechSentences(toSpokenText(text, v.accent));
  const ts = Date.now();
  let first = 0;
  const parts = sents.map((s, i) => {
    const a = engine(v.accent).generate({ text: s, sid: sids.get(voice) ?? v.sid, speed });
    if (i === 0) first = Date.now() - ts;
    return shapeChunk(a.samples, a.sampleRate, { pauseMs: i === sents.length - 1 ? 0 : 140 });
  });
  return { audio: join(parts), firstMs: first, totalMs: Date.now() - ts, sentences: sents };
}

/** Round 4 (before): speed 0.95, raw chunks back to back (Kokoro's own padding). */
function renderBefore(voice: string, text: string) {
  const v = voiceById(voice);
  const sents = toSpokenText(text, v.accent).split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
  const parts = sents.map((s) => engine(v.accent).generate({ text: s, sid: sids.get(voice) ?? v.sid, speed: 0.95 }).samples as Float32Array);
  return join(parts);
}

const LINES = {
  a: "Good morning, Alex. It's 10:21 AM. Anything I can help you with?",
  b: '8.8.8.8 resolves to dns.google. Anything else?',
};
const VOICES = ['bm_george', 'bf_emma', 'am_michael', 'af_heart', 'bm_fable', 'bf_isabella', 'af_bella', 'am_fenrir'];
const stats: unknown[] = [];
for (const voice of VOICES) {
  for (const [k, line] of Object.entries(LINES)) {
    const r = renderAfter(voice, line);
    fs.writeFileSync(path.join(out, `${voice}-${k}.wav`), muLawWav(r.audio, 24000));
    stats.push({ voice, line: k, firstAudioMs: r.firstMs, totalMs: r.totalMs, audioSec: +(r.audio.length / 24000).toFixed(2) });
  }
}
// Cadence before/after: a longer reply.
const LONG = "Sure. I've opened the terminal and run the lookup. 8.8.8.8 resolves to dns.google, which is Google's public DNS. Anything else?";
for (const voice of ['bm_george', 'bf_emma', 'am_michael', 'af_heart']) {
  fs.writeFileSync(path.join(out, 'before-after', `${voice}-before.wav`), muLawWav(renderBefore(voice, LONG), 24000));
  fs.writeFileSync(path.join(out, 'before-after', `${voice}-after.wav`), muLawWav(renderAfter(voice, LONG).audio, 24000));
}
console.table(stats);
fs.writeFileSync(path.join(out, 'timings.json'), JSON.stringify({ threads, speed: 1.05, stats }, null, 2));
