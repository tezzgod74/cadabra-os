// Wake-word test matrix (round 5). For each candidate name, runs the REAL voice
// pipeline (sherpa KWS + VAD + Parakeet ASR second stage) over Windows-TTS WAVs:
//   <name>-<voice>-pos0/pos2.wav : 3 wake phrases each (normal and fast rate)
//   <name>-<voice>-near.wav       : sentences with near-words (should NOT wake)
//   generic-<voice>.wav           : everyday sentences (should NOT wake)
// Usage: npx tsx scripts/kws-matrix.ts <wavDir> <asrDir> [sensitivity]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { VoicePipeline, FRAME, type PipelineEvent } from '../src/main/voice/pipeline';

process.env.CADABRA_TEST_MODE = '1'; // honour the CADABRA_KWS_* tuning variables
const [wavDir, asrDir, sensArg] = process.argv.slice(2);
const sensitivity = Number(sensArg ?? 0.5);
const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
const modelsDir = path.resolve('resources/models');

function readWav(file: string): Float32Array {
  const b = fs.readFileSync(file);
  let o = 12;
  while (o < b.length) {
    const id = b.toString('ascii', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === 'data') {
      const n = size / 2;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(o + 8 + i * 2) / 32768;
      return out;
    }
    o += 8 + size;
  }
  throw new Error(`no data chunk in ${file}`);
}

function run(name: string, file: string) {
  const events: PipelineEvent[] = [];
  const p = new VoicePipeline(sherpa, { modelsDir, asrDir, sensitivity, workDir: path.join(os.tmpdir(), 'cadabra-kws-matrix'), wakeWord: name }, (e) => events.push(e));
  const audio = readWav(file);
  // 4 s of faint room noise first (a live mic is always running, so the
  // spotter is warm), + 2 s of silence so the last capture can finish.
  const lead = 4 * 16000;
  const all = new Float32Array(lead + audio.length + 32000);
  let seed = 7;
  for (let i = 0; i < all.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    all[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.002;
  }
  for (let i = 0; i < audio.length; i++) all[lead + i] += audio[i];
  for (let i = 0; i + FRAME <= all.length; i += FRAME) p.accept(all.subarray(i, i + FRAME));
  return {
    wakes: events.filter((e) => e.type === 'wake').length,
    accepted: events.filter((e) => e.type === 'utterance').length,
    texts: events.filter((e) => e.type === 'utterance' || e.type === 'rejected').map((e: any) => e.text),
  };
}

const names = [...new Set(fs.readdirSync(wavDir).filter((f) => /-pos0\.wav$/.test(f)).map((f) => f.split('-')[0]))].sort();
const voices = [...new Set(fs.readdirSync(wavDir).filter((f) => f.startsWith('generic-')).map((f) => f.slice(8, -4)))];
const rows: string[] = [];
const summary: Record<string, { hit: number; of: number; kwsHit: number; falseNear: number; falseGeneric: number; nearTexts: string[] }> = {};
for (const name of names) {
  const s = (summary[name] = { hit: 0, of: 0, kwsHit: 0, falseNear: 0, falseGeneric: 0, nearTexts: [] as string[] });
  for (const v of voices) {
    for (const rate of ['pos0', 'pos2']) {
      const r = run(name, path.join(wavDir, `${name}-${v}-${rate}.wav`));
      s.hit += Math.min(3, r.accepted);
      s.kwsHit += Math.min(3, r.wakes);
      s.of += 3;
      rows.push(`${name} ${v} ${rate}: wakes ${r.wakes}, accepted ${r.accepted} ${JSON.stringify(r.texts)}`);
    }
    const near = run(name, path.join(wavDir, `${name}-${v}-near.wav`));
    s.falseNear += near.accepted;
    if (near.accepted) s.nearTexts.push(...near.texts);
    const gen = run(name, path.join(wavDir, `generic-${v}.wav`));
    s.falseGeneric += gen.accepted;
    rows.push(`${name} ${v} near: wakes ${near.wakes}, accepted ${near.accepted}; generic: wakes ${gen.wakes}, accepted ${gen.accepted}`);
  }
}
console.log(rows.join('\n'));
console.log('\nSUMMARY (sensitivity ' + sensitivity + ')');
console.log('| Name | Wake (KWS) | Wake (end-to-end) | False wakes: near-words | False wakes: everyday speech |');
console.log('|---|---|---|---|---|');
for (const [n, s] of Object.entries(summary)) console.log(`| ${n} | ${s.kwsHit}/${s.of} | ${s.hit}/${s.of} | ${s.falseNear} | ${s.falseGeneric} |`);
