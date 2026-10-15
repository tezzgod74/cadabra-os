import { utilityProcess, type UtilityProcess } from 'electron';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTtsModel, ttsDirFor, ttsInstalled } from './models';
import { MAX_RTF, SpeedStore, speedVerdict, type SpeedSample } from './tts-speed';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface TtsChunk {
  id: number;
  index: number;
  last: boolean;
  samples: Float32Array;
  sampleRate: number;
  synthMs: number;
  sinceStartMs: number;
}

/**
 * Natural voice (Kokoro via sherpa-onnx) in its own utilityProcess. Emits
 * 'chunk' (TtsChunk), 'done' ({id, cancelled}), 'progress' (download %),
 * 'error'. Synthesis is sentence by sentence; the caller plays chunks as they
 * arrive.
 */
export class KokoroTts extends EventEmitter {
  private proc: UtilityProcess | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private downloading: Promise<string> | null = null;
  /** Measured real-time factor of the last natural-voice sentences (synth time / audio time). */
  rtf: number | null = null;
  /** REVIEW-3 TTS-1: this PC synthesises too slowly to speak naturally; use the Windows voice. */
  tooSlow = false;
  static readonly MAX_RTF = MAX_RTF;
  private sawFirst = false;
  private samples: SpeedSample[] = [];
  private decided = false;
  private readonly speed: SpeedStore;

  constructor(private readonly userData: string) {
    super();
    // A persisted, still-fresh "too slow" verdict for this machine: start on the
    // Windows voice right away instead of stuttering for a few seconds first.
    this.speed = SpeedStore.for(userData);
    const v = this.speed.load();
    this.rtf = v.rtf;
    this.tooSlow = v.tooSlow;
  }

  /** Explicit "test the natural voice again" (Preview, ttstest): forget the verdict and measure afresh. */
  retest() {
    this.tooSlow = false;
    this.decided = false;
    this.samples = [];
    this.sawFirst = false;
    this.speed.save(this.rtf, false);
  }

  get dir(): string {
    // Dev/tests may point at an extracted model instead of the downloaded one.
    return process.env.CADABRA_TTS_DIR || ttsDirFor(this.userData);
  }

  get installed(): boolean {
    return ttsInstalled(this.dir);
  }

  get isDownloading(): boolean {
    return !!this.downloading;
  }

  /** Download (resumable, SHA-256 pinned) on explicit opt-in. */
  download(): Promise<string> {
    this.downloading ??= ensureTtsModel(this.userData, (pct) => this.emit('progress', pct)).finally(() => (this.downloading = null));
    return this.downloading;
  }

  private start(voice: string): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const proc = utilityProcess.fork(path.join(here, 'tts-worker.js'), [], { serviceName: 'Cadabra Voice (speech)', stdio: 'pipe' });
      this.proc = proc;
      proc.stderr?.on('data', (d) => this.emit('debug', `tts stderr: ${String(d).trim().slice(0, 300)}`));
      this.emit('debug', `tts worker starting (pid ${proc.pid ?? '?'})`);
      proc.on('exit', (code) => {
        this.emit('debug', `tts worker exited (code ${code})`);
        if (this.proc === proc) {
          this.proc = null;
          this.ready = null;
        }
      });
      proc.on('message', (m: any) => {
        if (m.type === 'ready') resolve();
        else if (m.type === 'audio') {
          const c = m as TtsChunk;
          // Real-time factor over a sliding window of recent sentences, skipping
          // the very first one after the model loads (one-off warm-up cost).
          // See tts-speed.ts: ≥ 4 s of audio and most sentences slow, so one
          // busy moment can't flip the voice; the verdict is persisted per machine.
          const audioSec = c.samples.length / c.sampleRate;
          if (this.sawFirst && audioSec > 0) {
            this.samples.push({ synthSec: c.synthMs / 1000, audioSec });
            if (this.samples.length > 20) this.samples.shift();
            const v = speedVerdict(this.samples);
            if (v.rtf != null) this.rtf = v.rtf;
            if (v.tooSlow === true && !this.tooSlow) {
              this.tooSlow = true;
              this.decided = true;
              this.speed.save(this.rtf, true);
              this.emit('slow', this.rtf);
            } else if (v.tooSlow === false && !this.decided) {
              this.decided = true;
              this.speed.save(this.rtf, false);
            }
          }
          this.sawFirst = true;
          this.emit('chunk', c);
        }
        else if (m.type === 'done') this.emit('done', m);
        else if (m.type === 'error') {
          this.emit('error', new Error(m.message), m.id);
          if (m.id == null) reject(new Error(m.message));
        }
      });
      proc.postMessage({ type: 'init', dir: this.dir, voice });
    });
    // TTS-2: a failed start-up must not poison every later attempt.
    this.ready.catch(() => {
      this.proc?.kill();
      this.proc = null;
      this.ready = null;
    });
    return this.ready;
  }

  /** Start speaking; returns the request id (chunks arrive as 'chunk' events). */
  async speak(sentences: string[], voice: string, speed: number, open = false, background = false): Promise<number> {
    await this.start(voice);
    const id = this.nextId++;
    this.proc?.postMessage({ type: 'speak', id, sentences, voice, speed, open, background });
    return id;
  }

  /** Round 5 streaming: more sentences for an open request (speak(..., open = true)). */
  append(id: number, sentences: string[]) {
    if (sentences.length) this.proc?.postMessage({ type: 'append', id, sentences });
  }

  /** No more sentences for this open request. */
  end(id: number) {
    this.proc?.postMessage({ type: 'end', id });
  }

  cancel(id: number) {
    this.proc?.postMessage({ type: 'cancel', id });
  }

  /** Warm the model so the first reply doesn't pay the ~1.5 s load. */
  prewarm(voice: string) {
    if (this.installed) void this.start(voice).catch(() => undefined);
  }

  dispose() {
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }
}
