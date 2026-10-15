// End-to-end voice pipeline on WAVs synthesized with Windows TTS (no real mic).
// Runs only when the models are present:
//   CADABRA_ASR_DIR=<parakeet dir> CADABRA_WAV_DIR=<dir with pos-*.wav / neg-*.wav> npx vitest run test/voice.integration.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { VoicePipeline, type PipelineEvent, SAMPLE_RATE } from '../src/main/voice/pipeline';

const asrDir = process.env.CADABRA_ASR_DIR ?? '';
const wavDir = process.env.CADABRA_WAV_DIR ?? '';
const modelsDir = path.resolve('resources/models');
const enabled = !!asrDir && fs.existsSync(asrDir) && !!wavDir && fs.existsSync(wavDir) && fs.existsSync(path.join(modelsDir, 'kws'));

describe.skipIf(!enabled)('voice pipeline (sherpa-onnx, TTS clips)', () => {
  const sherpa = enabled ? createRequire(import.meta.url)('sherpa-onnx-node') : null;
  const events: PipelineEvent[] = [];
  const pipe = enabled
    ? new VoicePipeline(sherpa, { modelsDir, asrDir, sensitivity: Number(process.env.CADABRA_SENS ?? 0.5), workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cadabra-voice-')), refractoryMs: 0 }, (e) => events.push(e))
    : (null as any);

  const run = (file: string) => {
    events.length = 0;
    const w = sherpa.readWave(path.join(wavDir, file));
    expect(w.sampleRate).toBe(SAMPLE_RATE);
    pipe.accept(w.samples);
    pipe.accept(new Float32Array(SAMPLE_RATE * 2)); // trailing silence
    return [...events];
  };

  for (const f of ['pos-error.wav', 'pos-copilot.wav', 'pos-spotify.wav']) {
    it(`wakes and transcribes ${f}`, () => {
      const evs = run(f);
      const u = evs.find((e) => e.type === 'utterance') as Extract<PipelineEvent, { type: 'utterance' }> | undefined;
      console.log(f, JSON.stringify(evs.filter((e) => e.type !== 'level')));
      expect(evs.some((e) => e.type === 'wake')).toBe(true);
      expect(u).toBeTruthy();
      expect(u!.request.length).toBeGreaterThan(3);
    });
  }
  for (const f of ['neg-abra.wav', 'neg-coffee.wav']) {
    it(`does not trigger on ${f}`, () => {
      const evs = run(f);
      console.log(f, JSON.stringify(evs.filter((e) => e.type !== 'level')));
      expect(evs.some((e) => e.type === 'utterance')).toBe(false);
    });
  }
});
