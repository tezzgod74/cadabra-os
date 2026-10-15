// Electron utilityProcess entry: hosts sherpa-onnx (native, N-API) away from
// the main process and the UI. Receives 16 kHz Float32 frames from the hidden
// mic window over a MessagePort and posts pipeline events to the main process.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { VoicePipeline, type PipelineEvent } from './pipeline';

const parentPort = (process as any).parentPort as {
  on(ev: 'message', cb: (e: { data: any; ports: any[] }) => void): void;
  postMessage(m: unknown): void;
};

let pipe: VoicePipeline | null = null;
/** Round 6 (REVIEW-5 D1): frames actually processed, reported every 2 s. */
let processed = 0;
setInterval(() => pipe && parentPort.postMessage({ type: 'heartbeat', frames: processed }), 2000);
// Debug only: CADABRA_VOICE_DUMP=<file.wav> records the first 12 s the engine receives.
const dumpFile = process.env.CADABRA_VOICE_DUMP;
const dump: Float32Array[] = [];
let dumped = 0;
function maybeDump(f: Float32Array, sherpa: any) {
  if (!dumpFile || dumped < 0) return;
  dump.push(new Float32Array(f));
  dumped += f.length;
  if (dumped >= 16000 * 12) {
    const all = new Float32Array(dumped);
    let o = 0;
    for (const d of dump) {
      all.set(d, o);
      o += d.length;
    }
    void sherpa;
    const pcm = Buffer.alloc(44 + all.length * 2);
    pcm.write('RIFF', 0);
    pcm.writeUInt32LE(36 + all.length * 2, 4);
    pcm.write('WAVEfmt ', 8);
    pcm.writeUInt32LE(16, 16);
    pcm.writeUInt16LE(1, 20);
    pcm.writeUInt16LE(1, 22);
    pcm.writeUInt32LE(16000, 24);
    pcm.writeUInt32LE(32000, 28);
    pcm.writeUInt16LE(2, 32);
    pcm.writeUInt16LE(16, 34);
    pcm.write('data', 36);
    pcm.writeUInt32LE(all.length * 2, 40);
    for (let i = 0; i < all.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(all[i] * 32767))), 44 + i * 2);
    fs.writeFileSync(dumpFile, pcm);
    dumped = -1;
  }
}
let sherpaRef: any = null;
const post = (e: PipelineEvent | Record<string, unknown>) => parentPort.postMessage(e);

parentPort.on('message', (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
      sherpaRef = sherpa;
      pipe = new VoicePipeline(sherpa, m.options, post);
      const port = e.ports?.[0];
      if (port) {
        port.on('message', (ev: { data: any }) => {
          const d = ev.data;
          const f =
            d instanceof Float32Array ? d : ArrayBuffer.isView(d) ? new Float32Array(d.buffer, d.byteOffset, d.byteLength / 4) : Array.isArray(d) ? Float32Array.from(d) : null;
          if (f) {
            try {
              maybeDump(f, sherpaRef);
            } catch (err) {
              post({ type: 'error', message: `dump: ${(err as Error).message}` });
              dumped = -1;
            }
            pipe?.accept(f);
            processed++;
          }
          else if (d?.type === 'stats') post({ type: 'mic-stats', ...d });
        });
        port.start();
      }
    } else if (m.type === 'mute') pipe?.setMuted(!!m.muted);
    else if (m.type === 'speaking') pipe?.setSpeaking(!!m.speaking);
    else if (m.type === 'followup') {
      if (m.ms > 0) pipe?.armFollowUp(m.ms, !!m.strict);
      else pipe?.disarmFollowUp();
    }
    else if (m.type === 'ptt') {
      if (m.down) pipe?.beginManualCapture();
      else pipe?.endManualCapture();
    } else if (m.type === 'cancel') pipe?.cancel();
    else if (m.type === 'transcribe') {
      // Round 12: a voice note from WhatsApp (16 kHz mono PCM).
      const f = m.samples instanceof Float32Array ? m.samples : Float32Array.from(m.samples ?? []);
      post({ type: 'transcript', id: m.id, text: pipe ? pipe.transcribeClip(f) : '' });
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
});
