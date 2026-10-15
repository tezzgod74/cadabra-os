// Opt-in: synthesise with the real Kokoro model to WAV files (never played).
//   CADABRA_TTS_DIR=<extracted kokoro-multi-lang-v1_0> npx vitest run test/tts.integration.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { speechSentences, toSpokenText } from '../src/shared/spoken-text';
import { accentConfig, voiceById } from '../src/shared/voices';

const dir = process.env.CADABRA_TTS_DIR ?? '';
describe.skipIf(!dir || !fs.existsSync(path.join(dir, 'model.onnx')))('Kokoro natural voice (real model, WAV only)', () => {
  it('streams sentence by sentence fast enough to play without gaps', () => {
    const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
    const v = voiceById('bm_george');
    const { lang, lexicon } = accentConfig(v);
    const tts = new sherpa.OfflineTts({
      model: { kokoro: { model: path.join(dir, 'model.onnx'), voices: path.join(dir, 'voices.bin'), tokens: path.join(dir, 'tokens.txt'), dataDir: path.join(dir, 'espeak-ng-data'), lexicon: path.join(dir, lexicon), lang }, numThreads: 4, provider: 'cpu' },
      maxNumSentences: 1,
    });
    const text = toSpokenText('8.8.8.8 resolves to dns.google. Your router at 192.168.40.1 answered. Anything else?');
    const t0 = Date.now();
    let first = 0;
    let audio = 0;
    for (const [i, s] of speechSentences(text).entries()) {
      const a = tts.generate({ text: s, sid: v.sid, speed: 0.95 });
      if (i === 0) first = Date.now() - t0;
      audio += a.samples.length / a.sampleRate;
      expect(a.sampleRate).toBe(24000);
      expect(a.samples.length).toBeGreaterThan(8000);
      sherpa.writeWave(path.join(os.tmpdir(), `cadabra-tts-${i}.wav`), { samples: a.samples, sampleRate: a.sampleRate });
    }
    const rtf = (Date.now() - t0) / 1000 / audio;
    console.log(`time to first audio ${first} ms, RTF ${rtf.toFixed(3)} (4 threads)`);
    expect(first).toBeLessThan(3000);
    expect(rtf).toBeLessThan(1);
  }, 60_000);
});
