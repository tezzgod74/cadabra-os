import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CadabraApp } from './app';
import { SherpaVoiceEngine } from './voice/sherpa-engine';
import type { TtsChunk } from './voice/kokoro-tts';
import { speechSentences, toSpokenText } from '../shared/spoken-text';

/**
 * `--ttstest` (with CADABRA_TTS_DIR or a downloaded voice): the real
 * utilityProcess TTS worker, in the app, measuring model load, time to first
 * audio and real-time factor. Audio is written to a WAV in %TEMP%, never played.
 */
export async function runTtsTest(c: CadabraApp) {
  const v = (c as any).voice;
  const res: Record<string, unknown> = {};
  if (!(v instanceof SherpaVoiceEngine) || !v.tts.installed) {
    console.log('TTSTEST', JSON.stringify({ error: 'natural voice not installed (set CADABRA_TTS_DIR)' }));
    app.exit(2);
    return;
  }
  const text = toSpokenText("Good morning, Alex. It's 10:21 a.m. Anything I can help you with? 8.8.8.8 resolves to dns.google.");
  const sentences = speechSentences(text);
  const chunks: TtsChunk[] = [];
  const t0 = Date.now();
  await new Promise<void>((resolve) => {
    v.tts.retest(); // measure afresh, ignoring any persisted verdict
    v.tts.on('chunk', (ch: TtsChunk) => chunks.push(ch));
    v.tts.on('done', () => resolve());
    v.tts.on('error', (e: Error) => ((res.errors as string[]) ??= []).push(e.message));
    void v.tts.speak(sentences, 'bm_george', 0.95);
    setTimeout(resolve, 60_000);
  });
  const audio = chunks.reduce((n, ch) => n + ch.samples.length / ch.sampleRate, 0);
  res.coldStartToFirstAudioMs = chunks[0] ? chunks[0].sinceStartMs + (Date.now() - t0 - chunks.at(-1)!.sinceStartMs) : null;
  res.firstAudioAfterModelLoadMs = chunks[0]?.sinceStartMs;
  res.totalMs = chunks.at(-1)?.sinceStartMs;
  res.audioSec = +audio.toFixed(2);
  res.rtf = chunks.length ? +((chunks.at(-1)!.sinceStartMs / 1000) / audio).toFixed(3) : null;
  // Warm second request (model already loaded): what a user hears on every later reply.
  const t1 = Date.now();
  let warmFirst = 0;
  await new Promise<void>((resolve) => {
    const on = (ch: TtsChunk) => {
      if (!warmFirst) warmFirst = Date.now() - t1;
      if (ch.last) {
        v.tts.off('chunk', on);
        resolve();
      }
    };
    v.tts.on('chunk', on);
    void v.tts.speak(speechSentences(toSpokenText('8.8.8.8 resolves to dns.google. Anything else?')), 'bm_george', 0.95);
    setTimeout(resolve, 30_000);
  });
  res.warmTimeToFirstAudioMs = warmFirst;
  res.measuredRtf = v.tts.rtf;
  res.fellBackToWindowsVoice = v.tts.tooSlow;
  const all = new Float32Array(chunks.reduce((n, ch) => n + ch.samples.length, 0));
  let o = 0;
  for (const ch of chunks) {
    all.set(ch.samples, o);
    o += ch.samples.length;
  }
  const wav = path.join(os.tmpdir(), 'cadabra-ttstest.wav');
  const pcm = Buffer.alloc(44 + all.length * 2);
  pcm.write('RIFF', 0);
  pcm.writeUInt32LE(36 + all.length * 2, 4);
  pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(24000, 24);
  pcm.writeUInt32LE(48000, 28);
  pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36);
  pcm.writeUInt32LE(all.length * 2, 40);
  for (let i = 0; i < all.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(all[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(wav, pcm);
  res.wav = wav;
  console.log('TTSTEST', JSON.stringify(res));
  v.tts.dispose();
  app.exit(0);
}
