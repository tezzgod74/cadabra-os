// `npm run demo:video`: the public-beta promo video, reproducibly.
//   1. Renders Cadabra's spoken lines with the natural British voice (Kokoro,
//      offline, written to WAV, never played) and a generated chime.
//   2. Records the staged demo desktop from an OFFSCREEN Electron window
//      (synthetic data only; no real desktop capture, input or microphone).
//   3. Muxes video + audio with ffmpeg: 1920×1080 and 1080×1080 MP4s
//      (H.264 + AAC, yuv420p, faststart) and a short README GIF.
// Needs: ffmpeg on PATH (or CADABRA_FFMPEG), and the Kokoro v1.0 voice
// (CADABRA_TTS_DIR, or the copy Cadabra downloaded into %APPDATA%).
// Output: dist/media/ (git-ignored).

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import electron from 'electron';
import { readKokoroSpeakers } from '../src/main/voice/kokoro-meta';
import { shapeChunk } from '../src/main/voice/tts-shape';
import { speechSentences, toSpokenText } from '../src/shared/spoken-text';
import { accentConfig, voiceById } from '../src/shared/voices';
import { PROMO_LINES } from '../src/renderer/demo/promo';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const out = path.join(root, 'dist', 'media');
const work = path.join(out, 'work');
fs.mkdirSync(work, { recursive: true });
const ffmpeg = process.env.CADABRA_FFMPEG || 'ffmpeg';
const ffprobe = process.env.CADABRA_FFPROBE || 'ffprobe';
const RATE = 48_000;

// ---- 1. audio ----------------------------------------------------------------
function wav(samples: Float32Array, rate: number): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return b;
}

/** The same soft two-tone chime the app plays before announcements. */
function chime(): Float32Array {
  const n = Math.round(RATE * 0.8);
  const s = new Float32Array(n);
  for (const [f, at] of [
    [1318.5, 0],
    [880, 0.22],
  ] as const) {
    for (let i = Math.round(at * RATE); i < n; i++) {
      const t = i / RATE - at;
      if (t > 0.5) break;
      const env = t < 0.015 ? t / 0.015 : Math.exp(-(t - 0.015) * 9);
      s[i] += 0.3 * env * Math.sin(2 * Math.PI * f * t);
    }
  }
  return s;
}

const ttsDir = process.env.CADABRA_TTS_DIR || path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Cadabra OS', 'models', 'kokoro-v1_0');
if (!fs.existsSync(path.join(ttsDir, 'model.onnx'))) {
  console.error('The Kokoro v1.0 voice is needed: set CADABRA_TTS_DIR, or turn on the natural voice in Cadabra once.');
  process.exit(2);
}
const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
const VOICE = 'bm_george';
const v = voiceById(VOICE);
const { lang, lexicon } = accentConfig(v);
const tts = new sherpa.OfflineTts({
  model: { kokoro: { model: path.join(ttsDir, 'model.onnx'), voices: path.join(ttsDir, 'voices.bin'), tokens: path.join(ttsDir, 'tokens.txt'), dataDir: path.join(ttsDir, 'espeak-ng-data'), lexicon: path.join(ttsDir, lexicon), lang }, numThreads: 4, provider: 'cpu' },
  maxNumSentences: 1,
});
const sid = readKokoroSpeakers(path.join(ttsDir, 'model.onnx')).get(VOICE) ?? v.sid;
const durations: Record<string, number> = {};
for (const [id, text] of Object.entries(PROMO_LINES)) {
  const parts: Float32Array[] = [];
  let rate = 24_000;
  const sents = speechSentences(toSpokenText(text, v.accent));
  sents.forEach((s, i) => {
    const a = tts.generate({ text: s, sid, speed: 1.05 });
    rate = a.sampleRate;
    parts.push(shapeChunk(a.samples, a.sampleRate, { pauseMs: i === sents.length - 1 ? 0 : 140 }));
  });
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  fs.writeFileSync(path.join(work, `${id}.wav`), wav(all, rate));
  durations[id] = Math.round((all.length / rate) * 1000);
}
fs.writeFileSync(path.join(work, 'chime.wav'), wav(chime(), RATE));
durations.chime = 800;
console.log('voice lines (ms):', durations);

// ---- 2. record the staged demo ------------------------------------------------
execFileSync(process.execPath, [path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], { cwd: root, stdio: 'inherit' });
const env = { ...process.env, CADABRA_FFMPEG: ffmpeg, CADABRA_PROMO_DURS: JSON.stringify(durations) };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(electron as unknown as string, ['.', '--demo', `--promo=${work}`], { cwd: root, env, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
const { cues, frames, fps } = JSON.parse(fs.readFileSync(path.join(work, 'cues.json'), 'utf8')) as { cues: { id: string; t: number }[]; frames: number; fps: number };
const seconds = (frames / fps).toFixed(3);

// ---- 3. mux --------------------------------------------------------------------
const inputs: string[] = ['-i', path.join(work, 'video.mp4')];
const chains: string[] = [];
cues.forEach((c, i) => {
  inputs.push('-i', path.join(work, `${c.id}.wav`));
  const gain = c.id === 'chime' ? 1.1 : 1.9;
  chains.push(`[${i + 1}:a]aresample=${RATE},aformat=channel_layouts=stereo,volume=${gain},adelay=${c.t}|${c.t}[a${i}]`);
});
const mix = `${chains.join(';')};${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0:dropout_transition=0,apad=whole_dur=${seconds}[aout]`;
const common = ['-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-ar', String(RATE), '-movflags', '+faststart', '-t', seconds];
const wide = path.join(out, 'cadabra-beta-demo.mp4');
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${mix};[0:v]null[vout]`, '-map', '[vout]', '-map', '[aout]', '-crf', '20', ...common, wide], { stdio: 'inherit' });
const square = path.join(out, 'cadabra-beta-demo-square.mp4');
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${mix};[0:v]crop=1920:1080:0:0,scale=1080:-2:flags=lanczos,pad=1080:1080:0:(oh-ih)/2:color=0x0b0a1a[vout]`, '-map', '[vout]', '-map', '[aout]', '-crf', '20', ...common, square], { stdio: 'inherit' });
const gif = path.join(out, 'cadabra-beta-demo.gif');
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-t', '10', '-i', wide, '-filter_complex', 'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif], { stdio: 'inherit' });

for (const f of [wide, square, gif]) {
  const info = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,width,height,pix_fmt,r_frame_rate', '-of', 'json', f]).toString();
  console.log(path.basename(f), JSON.stringify(JSON.parse(info)));
}
