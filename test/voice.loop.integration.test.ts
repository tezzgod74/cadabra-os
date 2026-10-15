// Repeated-detection check: the same clip looped N times through ONE pipeline
// (like Chromium's looping fake capture device). Skipped without models.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { VoicePipeline, type PipelineEvent } from '../src/main/voice/pipeline';

const asrDir = process.env.CADABRA_ASR_DIR ?? '';
const wavDir = process.env.CADABRA_WAV_DIR ?? '';
const enabled = !!asrDir && fs.existsSync(asrDir) && !!wavDir && fs.existsSync(wavDir);

describe.skipIf(!enabled)('voice pipeline: looped clips', () => {
  for (const f of ['pos-error.wav', 'pos-copilot.wav', 'pos-spotify.wav', 'neg-abra.wav', 'neg-coffee.wav']) {
    it(`${f} x6`, () => {
      const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
      const evs: PipelineEvent[] = [];
      const pipe = new VoicePipeline(sherpa, { modelsDir: path.resolve('resources/models'), asrDir, sensitivity: Number(process.env.CADABRA_SENS ?? 0.5), workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cv-')) }, (e) => evs.push(e));
      const w = sherpa.readWave(path.join(wavDir, f));
      for (let i = 0; i < 6; i++) pipe.accept(w.samples);
      pipe.accept(new Float32Array(32000));
      const n = evs.filter((e) => e.type === 'utterance').length;
      console.log(f, 'utterances', n, 'wakes', evs.filter((e) => e.type === 'wake').length, JSON.stringify(evs.filter((e) => e.type === 'utterance' || e.type === 'rejected').map((e: any) => e.text)));
      if (f.startsWith('neg')) expect(n).toBe(0);
      else expect(n).toBeGreaterThanOrEqual(4);
    });
  }
});
