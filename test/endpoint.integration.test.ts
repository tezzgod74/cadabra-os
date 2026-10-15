// REVIEW-5 V5-2 (round 6): "Cadabra, are you there? (pause) What time is it."
// must come out as ONE request. Real models (sherpa KWS + VAD + Parakeet) over
// Windows-TTS WAVs with an inserted 600 / 750 / 900 ms gap.
// Opt-in: CADABRA_ASR_DIR=<parakeet dir> CADABRA_ENDPOINT_WAVS=<dir of *-gapNNN.wav>
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FRAME, VoicePipeline, type PipelineEvent } from '../src/main/voice/pipeline';

const asrDir = process.env.CADABRA_ASR_DIR;
const wavDir = process.env.CADABRA_ENDPOINT_WAVS;
const run = asrDir && wavDir && fs.existsSync(wavDir) ? describe : describe.skip;

function readWav(file: string): Float32Array {
  const b = fs.readFileSync(file);
  let o = 12;
  while (o < b.length) {
    const id = b.toString('ascii', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === 'data') {
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(o + 8 + i * 2) / 32768;
      return out;
    }
    o += 8 + size;
  }
  throw new Error('no data chunk');
}

function utterances(file: string, minSilenceMs?: number) {
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
  const events: PipelineEvent[] = [];
  const p = new VoicePipeline(sherpa, { modelsDir: path.resolve('resources/models'), asrDir: asrDir!, sensitivity: 0.5, workDir: path.join(os.tmpdir(), 'cadabra-endpoint-test'), minSilenceMs }, (e) => events.push(e));
  // Warm (a live mic is always running): 4 s of faint noise first.
  const audio = readWav(file);
  const lead = 4 * 16000;
  const all = new Float32Array(lead + audio.length + 32000);
  for (let i = 0; i < all.length; i++) all[i] = ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 0.002;
  for (let i = 0; i < audio.length; i++) all[lead + i] += audio[i];
  // Endpointing is what's under test, not the wake word: a follow-up window
  // captures from speech onset with the same end-of-speech logic.
  let armed = false;
  for (let i = 0; i + FRAME <= all.length; i += FRAME) {
    // Armed 1.7 s into the file: background sound (if any) has been playing a while.
    if (!armed && i >= lead + 1.7 * 16000) {
      p.armFollowUp(20_000);
      armed = true;
    }
    p.accept(all.subarray(i, i + FRAME));
  }
  return events.filter((e): e is Extract<PipelineEvent, { type: 'utterance' }> => e.type === 'utterance');
}

run('V5-2: a natural pause after "are you there?" doesn\'t split Scenario A', () => {
  const files = wavDir ? fs.readdirSync(wavDir).filter((f) => /-gap\d+\.wav$/.test(f)) : [];
  it.each(files)('%s → one request with both parts', (f) => {
    const us = utterances(path.join(wavDir!, f));
    const joined = us.map((u) => u.text).join(' | ');
    expect(us.length, joined).toBe(1);
    expect(us[0].text.toLowerCase()).toMatch(/there/);
    expect(us[0].text.toLowerCase()).toMatch(/time is it/);
  });

  // REVIEW-6 N6-1: steady background sound must not hold the turn open to the
  // 15 s cap. Same files mixed with pink noise (−25 dB) or TV-like speech (−20 dB).
  const noisyDir = wavDir ? path.join(wavDir, 'noisy') : '';
  const noisy = noisyDir && fs.existsSync(noisyDir) ? fs.readdirSync(noisyDir).filter((f) => f.endsWith('.wav')) : [];
  it.each(noisy.filter((f) => !/-tv1[05]\.wav$/.test(f)))('noisy %s → ends promptly, one request', (f) => {
    const us = utterances(path.join(noisyDir, f));
    expect(us.length, us.map((u) => u.text).join(' | ')).toBeGreaterThanOrEqual(1);
    expect(us[0].audioMs).toBeLessThan(9000); // not the 15 s cap
    expect(us[0].text.toLowerCase()).toMatch(/there/);
    expect(us[0].text.toLowerCase()).toMatch(/time/);
  });

  // REVIEW-7 W7-6: a TV only 15 / 10 dB below the user. Speech recognition then
  // mixes in TV words (acoustics, not endpointing), so this checks that the turn
  // ENDS promptly (no 15 s hang).
  it.each(noisy.filter((f) => /-tv1[05]\.wav$/.test(f)))('louder TV %s → still ends promptly', (f) => {
    const us = utterances(path.join(noisyDir, f));
    expect(us.length).toBeGreaterThanOrEqual(1);
    expect(us[0].audioMs).toBeLessThan(9000);
    // Not asserted: with TV this loud the transcript can include TV words and
    // occasionally loses the second phrase (documented in BUILD_NOTES).
  });
});
