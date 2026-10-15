import { WakeMuteHold } from '../duck-records';
import { BrowserWindow, ipcMain, MessageChannelMain, session, utilityProcess, type UtilityProcess } from 'electron';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VoiceSettings, VoiceState } from '../../shared/types';
import { load, PRELOAD } from '../windows';
import type { VoiceEngine } from './engine';
import { asrDirFor, asrInstalled, ensureAsrModel } from './models';
import type { PipelineEvent } from './pipeline';
import { KokoroTts, type TtsChunk } from './kokoro-tts';
import { speechSentences, toSpokenText } from '../../shared/spoken-text';
import { DEFAULT_SPEED, DEFAULT_VOICE, offlineFallback, voiceById, type VoiceOption } from '../../shared/voices';
import { CloudTts } from './openai-tts';
import { MicWatch, type VoiceHealth, HEALTH_TEXT } from './health';

export { type VoiceHealth, HEALTH_TEXT } from './health';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface SherpaEngineOptions {
  /** Shipped models: kws/ + silero_vad.onnx */
  modelsDir: string;
  userData: string;
  settings: () => VoiceSettings;
  /** Override the ASR dir (dev/tests), else userData/models/parakeet-110m-int8. */
  asrDirOverride?: string;
  /** Round 5: the user's own OpenAI key for the cloud (Southern) voices. */
  openaiKey?: () => string | undefined;
}

/** Round 5: a speech stream (sentences pushed as the reply streams in). */
export interface SpeechStream {
  route: 'kokoro' | 'cloud' | 'windows';
  voice: string;
  push(sentences: string[]): void;
  end(): void;
  /** Stop this stream now (Esc / "stop"); nothing more is spoken. */
  cancel(): void;
  /** Resolves when the speech has ended (or timed out / was stopped). */
  done: Promise<void>;
}

/**
 * Local voice: hidden mic window (getUserMedia + AudioWorklet @16 kHz) →
 * MessagePort → utilityProcess running sherpa-onnx (KWS + VAD + Parakeet).
 * Events: 'state', 'level', 'utterance', 'error', 'progress' (model download %),
 * 'mic' (mic status), 'health' (round 4.5), 'debug'.
 *
 * Round 4.5 (hands-on): the capture could end silently (device lost or
 * invalidated) and voice stayed "on" but deaf, with nothing logged. Now a
 * watchdog (MicWatch) tracks frames, track state and digital silence, reports
 * a health state and restarts the mic, then the whole pipeline, with backoff.
 */
export class SherpaVoiceEngine extends EventEmitter implements VoiceEngine {
  readonly name = 'sherpa-onnx';
  state: VoiceState = 'off';
  private proc: UtilityProcess | null = null;
  private mic: BrowserWindow | null = null;
  private micReady: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private wantRunning = false;
  speaking = false;
  /** Natural voice (Kokoro) — used when downloaded and selected; Windows voices otherwise. */
  readonly tts: KokoroTts;
  /** Round 5: cloud voices (OpenAI, the user's own key). */
  readonly cloud: CloudTts;
  private ttsId = 0;
  /** Time-to-first-audio of the last natural-voice reply (ms), for diagnostics. */
  lastTtfaMs: number | null = null;
  readonly watch: MicWatch;
  private restartTimer: NodeJS.Timeout | null = null;
  private ticker: NodeJS.Timeout | null = null;

  constructor(private readonly o: SherpaEngineOptions) {
    super();
    this.watch = new MicWatch({
      health: (h, detail) => {
        this.emit('health', { state: h, detail, text: HEALTH_TEXT[h] });
      },
      restart: (kind, delay) => this.scheduleRestart(kind, delay),
    });
    this.tts = new KokoroTts(o.userData);
    this.cloud = new CloudTts({ key: () => o.openaiKey?.() });
    this.cloud.on('chunk', (c: TtsChunk) => {
      if (c.id !== this.ttsId) return;
      if (c.index === 0) this.lastTtfaMs = c.sinceStartMs;
      this.mic?.webContents.send('mic:cmd', { type: 'tts-chunk', id: c.id, samples: c.samples, sampleRate: c.sampleRate, last: c.last });
    });
    this.cloud.on('done', (m: { id: number }) => {
      if (m.id === this.ttsId) this.mic?.webContents.send('mic:cmd', { type: 'tts-done', id: m.id });
    });
    this.tts.on('progress', (pct: number) => this.emit('tts-progress', pct));
    this.tts.on('slow', (rtf: number) => this.emit('tts-slow', rtf));
    this.tts.on('chunk', (c: TtsChunk) => {
      if (c.id !== this.ttsId) return;
      if (c.index === 0) {
        this.lastTtfaMs = c.sinceStartMs;
        this.emit('debug', `first audio chunk synthesised (${c.synthMs} ms)`);
      }
      this.mic?.webContents.send('mic:cmd', { type: 'tts-chunk', id: c.id, samples: c.samples, sampleRate: c.sampleRate, last: c.last });
    });
    this.tts.on('done', (m: { id: number; cancelled: boolean }) => {
      if (m.id === this.ttsId) this.mic?.webContents.send('mic:cmd', { type: 'tts-done', id: m.id });
    });
    this.tts.on('error', (e: Error, id?: number) => {
      this.emit('debug', `tts: ${e.message}`);
      if (id === this.ttsId) this.mic?.webContents.send('mic:cmd', { type: 'tts-done', id });
    });
    this.tts.on('debug', (m: string) => this.emit('debug', m));
    ipcMain.on('mic:status', (e, m: any) => {
      if (!this.mic || e.sender !== this.mic.webContents) return;
      if (m?.type === 'decoded') {
        const w = this.decodeWaiters.get(m.id);
        this.decodeWaiters.delete(m.id);
        w?.({ samples: m.samples instanceof Float32Array ? m.samples : m.samples ? Float32Array.from(Object.values(m.samples)) : undefined, error: m.error });
        return;
      }
      if (m?.type === 'tts') {
        // While speaking: no follow-up capture, but "Cadabra" still barges in.
        this.speaking = m.state === 'start';
        this.proc?.postMessage({ type: 'speaking', speaking: this.speaking });
        this.emit('tts', m.state);
      } else if (m?.type === 'mic') {
        this.emit('mic', m);
        if (m.state !== 'stats') this.emit('debug', `mic ${m.state}${m.track ? ` [${m.track}]` : ''}${m.message ? `: ${m.name ?? ''} ${m.message}` : ''}${m.inputs ? ` inputs=${JSON.stringify(m.inputs)}` : ''}${m.context ? ` context=${m.context}` : ''}`);
        if (m.state === 'error') {
          this.setState('error');
          this.emit('error', new Error(m.name === 'NotAllowedError' ? 'Microphone access is blocked (Windows Settings → Privacy & security → Microphone).' : `Microphone: ${m.message}`));
        }
        this.watch.onMic(m);
      }
    });
  }

  get health(): VoiceHealth {
    return this.watch.health;
  }

  get healthDetail(): string {
    return this.watch.detail;
  }

  /** Voice is on and really hearing the microphone. */
  get healthy(): boolean {
    return this.watch.health === 'ok';
  }

  get asrDir(): string {
    return this.o.asrDirOverride ?? asrDirFor(this.o.userData);
  }

  async available() {
    const kws = fs.existsSync(path.join(this.o.modelsDir, 'kws', 'tokens.txt')) && fs.existsSync(path.join(this.o.modelsDir, 'silero_vad.onnx'));
    if (!kws) return { ok: false, detail: 'Wake-word models are missing from the install.' };
    return { ok: true, detail: asrInstalled(this.asrDir) ? 'Ready' : 'Speech model will download on first use (~100 MB)' };
  }

  private setState(s: VoiceState) {
    if (this.state === s) return;
    this.emit('debug', `state ${this.state} → ${s}`);
    this.state = s;
    this.emit('state', s);
  }

  /** Restart the mic capture ('mic') or the whole pipeline ('engine'). */
  private scheduleRestart(kind: 'mic' | 'engine', delay: number) {
    if (!this.wantRunning || this.restartTimer) return;
    this.emit('debug', `scheduling ${kind} restart in ${delay} ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.wantRunning) return;
      if (kind === 'mic' && this.mic && !this.mic.isDestroyed() && this.proc) {
        this.watch.restarting('microphone');
        this.mic.webContents.send('mic:cmd', { type: 'start', label: this.o.settings().inputDevice || '', raw: process.env.CADABRA_MIC_RAW === '1' });
      } else void this.restart();
    }, delay);
  }

  /** Tray → "Restart voice", or automatic recovery. */
  async restart(): Promise<void> {
    this.emit('debug', 'restarting the voice pipeline');
    if (!this.wantRunning) return;
    // REVIEW-6: the mic window also plays the spoken reply; let it finish first
    // (up to 30 s) instead of cutting Cadabra off mid-sentence.
    if (this.speaking) await new Promise<void>((r) => {
      const t = setTimeout(r, 30_000);
      const on = (st: string) => {
        if (st === 'end') {
          clearTimeout(t);
          this.off('tts', on);
          r();
        }
      };
      this.on('tts', on);
    });
    await this.stop();
    // REVIEW-5 D2: a fresh mic window too (a hung getUserMedia would otherwise
    // block every later start in the old one).
    if (this.mic && !this.mic.isDestroyed()) this.mic.destroy();
    this.mic = null;
    this.micReady = null;
    this.watch.restarting('voice');
    await this.start();
  }

  private ensureMicWindow(): Promise<void> {
    if (this.mic && !this.mic.isDestroyed() && this.micReady) return this.micReady;
    const win = new BrowserWindow({
      show: false,
      width: 200,
      height: 120,
      skipTaskbar: true,
      webPreferences: {
        preload: PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        additionalArguments: ['--cadabra-role=mic'],
      },
    });
    this.mic = win;
    // Only this hidden window may use the microphone; everything else is denied.
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((wc, perm, cb, details: any) => {
      cb(perm === 'media' && wc === this.mic?.webContents && (details?.mediaTypes ?? ['audio']).every((t: string) => t === 'audio'));
    });
    ses.setPermissionCheckHandler((wc, perm) => perm === 'media' && wc === this.mic?.webContents);
    // Round 4.5: the mic window's own console and crashes go to the log.
    win.webContents.on('console-message', (e: any) => {
      const level = e?.level ?? '';
      if (level === 'warning' || level === 'error' || level === 2 || level === 3) this.emit('debug', `mic window ${level}: ${String(e?.message ?? '').slice(0, 300)}`);
    });
    win.webContents.on('render-process-gone', (_e, d) => {
      this.emit('debug', `mic window gone: ${d.reason} (exit ${d.exitCode})`);
      if (this.mic === win) {
        this.mic = null;
        this.micReady = null;
      }
      if (!win.isDestroyed()) win.destroy();
      this.watch.engineGone(`mic window ${d.reason}`);
    });
    let readyListener: ((e: Electron.IpcMainEvent, m: any) => void) | null = null;
    let settleReady: (() => void) | null = null;
    this.micReady = new Promise<void>((resolve) => {
      settleReady = resolve;
      const onStatus = (readyListener = (e: Electron.IpcMainEvent, m: any) => {
        if (e.sender === win.webContents && m?.type === 'ready') {
          ipcMain.removeListener('mic:status', onStatus);
          // Test/demo modes never make a sound on the real speakers.
          win.webContents.send('mic:cmd', { type: 'config', mute: process.env.CADABRA_MUTE_TTS === '1' });
          resolve();
        }
      });
      ipcMain.on('mic:status', onStatus);
    });
    void load(win, 'mic');
    win.on('closed', () => {
      // REVIEW-6: don't leak the 'ready' listener (or leave waiters hanging)
      // when a window dies before it was ready.
      if (readyListener) ipcMain.removeListener('mic:status', readyListener);
      settleReady?.();
      if (this.mic === win) {
        this.mic = null;
        this.micReady = null;
      }
    });
    return this.micReady;
  }

  async start(): Promise<void> {
    this.wantRunning = true;
    this.ticker ??= setInterval(() => this.watch.tick(), 2000);
    this.ticker.unref?.();
    if (this.proc) return;
    if (this.starting) return this.starting;
    this.watch.starting();
    this.starting = this.doStart().finally(() => (this.starting = null));
    return this.starting;
  }

  private async doStart() {
    const avail = await this.available();
    if (!avail.ok) {
      this.setState('error');
      this.watch.engineGone(avail.detail, false);
      this.emit('error', new Error(avail.detail));
      return;
    }
    if (!asrInstalled(this.asrDir)) {
      this.setState('downloading');
      try {
        await ensureAsrModel(this.o.userData, (pct) => this.emit('progress', pct));
      } catch (e) {
        this.setState('error');
        this.watch.engineGone(`speech model download failed: ${(e as Error).message}`, false);
        this.emit('error', e as Error);
        return;
      }
    }
    if (!this.wantRunning) return;
    const s = this.o.settings();
    const proc = utilityProcess.fork(path.join(here, 'voice-engine.js'), [], { serviceName: 'Cadabra Voice', stdio: 'pipe' });
    this.proc = proc;
    this.emit('debug', `voice engine starting (pid ${proc.pid ?? '?'})`);
    proc.stderr?.on('data', (d) => this.emit('debug', `engine stderr: ${String(d).trim().slice(0, 400)}`));
    proc.stdout?.on('data', (d) => this.emit('debug', `engine: ${String(d).trim().slice(0, 400)}`));
    proc.on('exit', (code) => {
      this.emit('debug', `voice engine exited (code ${code})`);
      if (this.proc === proc) {
        this.proc = null;
        if (this.wantRunning) {
          this.setState('error');
          this.emit('error', new Error(`voice engine exited (${code}); restarting`));
          this.watch.engineGone(`exit code ${code}`);
        }
      }
    });
    proc.on('message', (m: PipelineEvent | any) => this.onEngine(m));
    await this.ensureMicWindow();
    const { port1, port2 } = new MessageChannelMain();
    this.mic!.webContents.postMessage('voice:port', null, [port1]);
    proc.postMessage(
      {
        type: 'init',
        options: {
          modelsDir: this.o.modelsDir,
          asrDir: this.asrDir,
          sensitivity: s.sensitivity,
          wakeWord: s.wakeWord,
          workDir: path.join(this.o.userData, 'voice'),
        },
      },
      [port2],
    );
    // Push-to-talk-only mode: wake detection muted from the start.
    if (s.pushToTalk) proc.postMessage({ type: 'mute', muted: true });
    this.wakeMuted = !!s.pushToTalk;
    this.mic!.webContents.send('mic:cmd', { type: 'start', label: s.inputDevice || '', raw: process.env.CADABRA_MIC_RAW === '1' });
  }

  private onEngine(m: any) {
    switch (m.type) {
      case 'ready':
        this.emit('debug', `voice engine ready (asr=${m.asr}, ${m.loadMs} ms)`);
        this.setState('idle');
        this.watch.engineReady();
        break;
      case 'wake':
        this.setState('listening');
        this.emit('wake', m.keyword);
        break;
      case 'level':
        this.emit('level', m.level);
        break;
      case 'transcript': {
        const w = this.clipWaiters.get(m.id);
        this.clipWaiters.delete(m.id);
        w?.(String(m.text ?? ''));
        break;
      }
      case 'utterance':
        this.setState('idle');
        this.emit('debug', `utterance (${m.audioMs} ms audio, ASR ${m.asrMs} ms${m.followUp ? ', follow-up' : ''}, ${String(m.request ?? '').length} chars)`);
        this.emit('utterance', { text: m.text, request: m.request, asrMs: m.asrMs, audioMs: m.audioMs, followUp: !!m.followUp, manual: !!m.manual, silenceMs: m.silenceMs ?? 0 });
        break;
      case 'followup':
        // Never let "follow-up armed" overwrite a capture in progress (seen in the soak test).
        if (m.state === 'armed' && this.state !== 'listening') this.setState('followup');
        else if (m.state === 'heard') this.setState('listening');
        else if (m.state !== 'armed' && this.state === 'followup') this.setState('idle');
        this.emit('followup', m.state);
        break;
      case 'barge':
        this.stopSpeaking();
        this.emit('barge');
        break;
      case 'rejected':
        this.setState('idle');
        this.emit('debug', `capture rejected: ${m.reason}`);
        this.emit('rejected', m);
        break;
      case 'error':
        this.emit('debug', `engine error: ${m.message}`);
        this.emit('error', new Error(m.message));
        break;
      case 'heartbeat':
        this.watch.engineHeartbeat(Number(m.frames) || 0);
        break;
      case 'mic-stats':
        break;
      default:
        // REVIEW-5: whitelisted fields only (a future message could carry a transcript).
        this.emit('debug', `engine message "${String(m?.type).slice(0, 30)}"${typeof m?.ms === 'number' ? ` ms=${m.ms}` : ''}`);
    }
  }

  private clipWaiters = new Map<number, (text: string) => void>();
  private decodeWaiters = new Map<number, (r: { samples?: Float32Array; error?: string }) => void>();
  private clipSeq = 0;

  /**
   * Round 12: a WhatsApp voice note → text, entirely on this PC: the hidden mic
   * window decodes it (Chromium's Opus decoder) to 16 kHz PCM, the speech
   * worker transcribes it. null when voice isn't running or decoding fails.
   */
  async transcribeAudio(bytes: Buffer): Promise<string | null> {
    if (!this.proc) return null;
    await this.ensureMicWindow();
    const id = ++this.clipSeq;
    const dec = await new Promise<{ samples?: Float32Array; error?: string }>((resolve) => {
      this.decodeWaiters.set(id, resolve);
      this.mic?.webContents.send('mic:cmd', { type: 'decode', id, bytes: new Uint8Array(bytes) });
      setTimeout(() => this.decodeWaiters.delete(id) && resolve({ error: 'timeout' }), 20_000).unref?.();
    });
    if (!dec.samples?.length) {
      this.emit('debug', `voice note not decoded (${dec.error ?? 'empty'})`);
      return null;
    }
    const text = await new Promise<string>((resolve) => {
      this.clipWaiters.set(id, resolve);
      this.proc?.postMessage({ type: 'transcribe', id, samples: dec.samples });
      setTimeout(() => this.clipWaiters.delete(id) && resolve(''), 60_000).unref?.();
    });
    this.emit('debug', `voice note transcribed (${Math.round(dec.samples.length / 16)} ms audio, ${text.length} chars)`);
    return text || null;
  }

  /** Listen for a follow-up (no wake word) for `ms`; 0 disarms. */
  armFollowUp(ms: number, strict = false) {
    this.proc?.postMessage({ type: 'followup', ms, strict });
  }

  /**
   * Push-to-talk. Returns false (and captures nothing) when voice isn't really
   * hearing the microphone, so the caller can say why instead of showing a
   * listening UI that hears nothing.
   */
  setPushToTalk(down: boolean): boolean {
    if (down && (!this.proc || !this.healthy)) {
      this.emit('debug', `push-to-talk ignored: voice ${this.health}${this.proc ? '' : ' (no engine)'}`);
      return false;
    }
    this.proc?.postMessage({ type: 'ptt', down });
    return true;
  }

  /** Soak test only: make the capture die like it did on the user's PC. */
  simulateMicLoss(withEvent: boolean) {
    this.mic?.webContents.send('mic:cmd', { type: 'simulate-loss', withEvent });
  }

  /** Round 7: the microphones Windows offers (labels), for Settings → Voice. */
  async listDevices(): Promise<{ inputs: string[]; defaultInput: string }> {
    await this.ensureMicWindow();
    const win = this.mic!;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        ipcMain.removeListener('mic:status', on);
        resolve({ inputs: [], defaultInput: '' });
      }, 3000);
      const on = (e: Electron.IpcMainEvent, m: any) => {
        if (e.sender !== win.webContents || m?.type !== 'devices') return;
        clearTimeout(t);
        ipcMain.removeListener('mic:status', on);
        resolve({ inputs: Array.isArray(m.inputs) ? m.inputs.map(String) : [], defaultInput: String(m.defaultInput ?? '') });
      };
      ipcMain.on('mic:status', on);
      win.webContents.send('mic:cmd', { type: 'list-devices' });
    });
  }

  /** Push-to-talk-only mode on/off without restarting anything. */
  /** The wake word's current mute state (push-to-talk, announcements…). */
  wakeMuted = false;

  setWakeMuted(muted: boolean) {
    this.wakeMuted = muted;
    this.proc?.postMessage({ type: 'mute', muted });
  }

  cancelCapture() {
    this.proc?.postMessage({ type: 'cancel' });
    if (this.state === 'listening') this.setState('idle');
  }

  async stop(): Promise<void> {
    this.wantRunning = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.watch.stopped();
    this.mic?.webContents.send('mic:cmd', { type: 'stop' });
    const p = this.proc;
    this.proc = null;
    p?.kill();
    this.setState('off');
  }

  /** Natural voice when downloaded + selected; otherwise the Windows voice. */
  private useKokoro(): boolean {
    const s = this.o.settings();
    return (s.ttsEngine ?? 'kokoro') === 'kokoro' && this.tts.installed && !this.tts.tooSlow;
  }

  /**
   * Which voice actually speaks: the chosen one, or (cloud voice not allowed,
   * no key, offline) the offline voice of the same gender (research §9).
   */
  resolveVoice(voiceId?: string): { voice: VoiceOption; route: 'kokoro' | 'cloud' | 'windows' } {
    const s = this.o.settings();
    const v = voiceById(voiceId ?? s.ttsVoice ?? DEFAULT_VOICE);
    if (v.engine === 'openai') {
      // An explicit Preview (voiceId given) may use the cloud voice before it is switched on.
      if ((s.cloudVoice || voiceId) && this.cloud.configured && !this.cloudFailedRecently()) return { voice: v, route: 'cloud' };
      const fb = offlineFallback(v);
      return { voice: fb, route: this.useKokoro() || voiceId ? 'kokoro' : 'windows' };
    }
    return { voice: v, route: this.useKokoro() || voiceId ? 'kokoro' : 'windows' };
  }

  private cloudFailedAt = 0;
  private cloudFailedRecently() {
    return Date.now() - this.cloudFailedAt < 60_000;
  }

  /**
   * Round 5: open a speech stream. Sentences can be pushed as they arrive (the
   * first one starts playing while the model is still writing the rest) and
   * `done` resolves when the speech has ENDED (or a length-based timeout).
   *
   * Round 6 (REVIEW-5 V5-1): every stream belongs to a "speech generation".
   * stopSpeaking() (Esc, "stop", the wake word) starts a new generation, and
   * any push/end/fallback from an older stream is ignored, so nothing can
   * start talking again after a stop. cancel() stops this stream.
   */
  async openSpeech(opts: { voice?: string; speed?: number } = {}): Promise<SpeechStream> {
    this.endSpeech?.();
    await this.ensureMicWindow();
    const gen = ++this.speechGen;
    const live = () => gen === this.speechGen;
    const s = this.o.settings();
    const speed = opts.speed ?? s.ttsSpeed ?? DEFAULT_SPEED;
    const { voice, route } = this.resolveVoice(opts.voice);
    let words = 0;
    let ended = false;
    let timer: NodeJS.Timeout | null = null;
    let fin = false;
    const onTts = (state: string) => {
      if (state === 'end' && ended) finish();
    };
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const finish = () => {
      if (fin) return;
      fin = true;
      if (timer) clearTimeout(timer);
      this.off('tts', onTts);
      if (this.endSpeech === finish) this.endSpeech = null;
      resolveDone();
    };
    this.on('tts', onTts);
    this.endSpeech = finish;
    const armTimeout = () => {
      // + model start-up for the natural voice.
      const ms = Math.min(60_000, 2500 + words * 420 + (route !== 'windows' ? 4000 : 0));
      timer = setTimeout(() => {
        this.emit('debug', `speech end not reported within ${ms} ms (timeout)`);
        finish();
      }, ms);
    };
    const countWords = (xs: string[]) => (words += xs.join(' ').split(/\s+/).filter(Boolean).length);
    const cancel = () => {
      if (live()) this.stopSpeaking();
      finish();
    };
    this.speechStartedAt = Date.now();
    this.emit('debug', `speech stream opened (${route}, ${voice.id})`);

    // The Windows voice: each sentence is queued as it arrives (it streams too).
    const windowsStream = (): SpeechStream => {
      let any = false;
      this.mic?.webContents.send('mic:cmd', { type: 'say-begin' });
      return {
        route: 'windows',
        voice: voice.id,
        push: (xs) => {
          if (!live() || !xs.length) return;
          any = true;
          countWords(xs);
          for (const x of xs) this.mic?.webContents.send('mic:cmd', { type: 'say', text: x });
        },
        end: () => {
          ended = true;
          if (!live() || !any) return finish();
          this.mic?.webContents.send('mic:cmd', { type: 'say-end' });
          armTimeout();
        },
        cancel,
        done,
      };
    };
    if (route === 'windows') return windowsStream();

    this.ttsId = -1;
    this.mic?.webContents.send('mic:cmd', { type: 'tts-begin' });
    if (route === 'cloud') {
      const id = this.cloud.speak([], voice, speed, true);
      this.ttsId = id;
      let any = false;
      let fallbackId = 0;
      // Cloud failure mid-reply: finish with the offline voice of the same gender
      // (unless the user stopped it meanwhile: REVIEW-5 V5-4 edge).
      const onErr = (e: Error, eid: number, rest: { remaining: string[]; ended: boolean }) => {
        if (eid !== id || !live()) return;
        this.cloudFailedAt = Date.now();
        this.emit('debug', `cloud voice failed (${e.message}); continuing with the offline voice`);
        this.emit('cloud-error', e.message);
        const fb = offlineFallback(voice);
        if (!this.useKokoro()) {
          this.mic?.webContents.send('mic:cmd', { type: 'say-begin' });
          for (const x of rest.remaining) this.mic?.webContents.send('mic:cmd', { type: 'say', text: x });
          this.mic?.webContents.send('mic:cmd', { type: 'say-end' });
          return;
        }
        void this.tts.speak(rest.remaining, fb.id, speed, !ended).then((kid) => {
          if (!live()) {
            this.tts.cancel(kid);
            return;
          }
          this.ttsId = kid;
          fallbackId = kid;
          if (ended) this.tts.end(kid);
        });
      };
      this.cloud.on('error', onErr);
      void done.then(() => this.cloud.off('error', onErr));
      return {
        route,
        voice: voice.id,
        push: (xs) => {
          if (!xs.length || !live()) return;
          any = true;
          countWords(xs);
          if (fallbackId) this.tts.append(fallbackId, xs);
          else this.cloud.append(id, xs);
        },
        end: () => {
          ended = true;
          if (!live()) return finish();
          if (fallbackId) this.tts.end(fallbackId);
          else this.cloud.end(id);
          if (!any) this.mic?.webContents.send('mic:cmd', { type: 'tts-done', id });
          armTimeout();
        },
        cancel,
        done,
      };
    }

    try {
      // The player starts on the first chunk; the worker keeps synthesising the rest.
      const id = await this.tts.speak([], voice.id, speed, true);
      if (!live()) this.tts.cancel(id);
      else this.ttsId = id;
      let any = false;
      return {
        route,
        voice: voice.id,
        push: (xs) => {
          if (!xs.length || !live()) return;
          any = true;
          countWords(xs);
          this.tts.append(id, xs);
        },
        end: () => {
          ended = true;
          if (!live()) return finish();
          this.tts.end(id);
          if (!any) this.mic?.webContents.send('mic:cmd', { type: 'tts-done', id });
          armTimeout();
        },
        cancel,
        done,
      };
    } catch (e) {
      this.emit('debug', `natural voice failed, using Windows voice: ${(e as Error).message}`);
      return windowsStream();
    }
  }

  /**
   * Round 10: audio rendered ahead of time (the next greeting), so it can play
   * the moment it's needed. Natural voice only; stale entries (other text,
   * voice or speed) are simply not used.
   */
  private prerendered: { text: string; voice: string; speed: number; chunks: { samples: Float32Array; sampleRate: number }[]; complete: boolean; id: number } | null = null;

  async prerender(text: string): Promise<boolean> {
    const s = this.o.settings();
    const speed = s.ttsSpeed ?? DEFAULT_SPEED;
    const { voice, route } = this.resolveVoice();
    if (route !== 'kokoro') return false;
    const p = this.prerendered;
    if (p && p.text === text && p.voice === voice.id && p.speed === speed) return p.complete;
    const sentences = speechSentences(toSpokenText(text, this.dialectOf(voice.id)));
    // Background: queued behind any speech that is playing (e.g. "Locked."), never cancelling it.
    const id = await this.tts.speak(sentences, voice.id, speed, false, true);
    const entry = { text, voice: voice.id, speed, chunks: [] as { samples: Float32Array; sampleRate: number }[], complete: false, id };
    this.prerendered = entry;
    return new Promise<boolean>((resolve) => {
      const onChunk = (c: TtsChunk) => {
        if (c.id === id) entry.chunks.push({ samples: c.samples, sampleRate: c.sampleRate });
      };
      const fin = (ok: boolean) => {
        this.tts.off('chunk', onChunk);
        this.tts.off('done', onDone);
        clearTimeout(t);
        entry.complete = ok && entry.chunks.length > 0;
        this.emit('debug', `greeting pre-render ${entry.complete ? `ready (${entry.chunks.length} chunks)` : `not ready (${ok ? 'no audio' : 'cancelled or timed out'})`}`);
        if (!entry.complete && this.prerendered === entry) this.prerendered = null;
        resolve(entry.complete);
      };
      const onDone = (m: { id: number; cancelled: boolean }) => {
        if (m.id === id) fin(!m.cancelled);
      };
      const t = setTimeout(() => fin(false), 20_000);
      this.tts.on('chunk', onChunk);
      this.tts.on('done', onDone);
    });
  }

  /** Play pre-rendered audio for `text` now; false when there is none (caller synthesises live). */
  async playPrerendered(text: string): Promise<boolean> {
    const p = this.prerendered;
    const s = this.o.settings();
    const { voice, route } = this.resolveVoice();
    if (!p || !p.complete || p.text !== text || route !== 'kokoro' || p.voice !== voice.id || p.speed !== (s.ttsSpeed ?? DEFAULT_SPEED)) {
      if (p) this.emit('debug', `pre-rendered audio not used (${!p.complete ? 'not ready' : p.text !== text ? 'other line' : 'voice changed'})`);
      return false;
    }
    this.prerendered = null;
    this.endSpeech?.();
    await this.ensureMicWindow();
    ++this.speechGen;
    const audioMs = p.chunks.reduce((a, c) => a + (c.samples.length / c.sampleRate) * 1000, 0);
    const done = new Promise<void>((resolve) => {
      const onTts = (st: string) => {
        if (st !== 'end') return;
        this.off('tts', onTts);
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        this.off('tts', onTts);
        resolve();
      }, audioMs + 3000);
      this.on('tts', onTts);
    });
    this.speechStartedAt = Date.now();
    this.ttsId = p.id;
    this.emit('debug', 'speech: playing pre-rendered audio');
    this.mic?.webContents.send('mic:cmd', { type: 'tts-begin' });
    p.chunks.forEach((c, i) => this.mic?.webContents.send('mic:cmd', { type: 'tts-chunk', id: p.id, samples: c.samples, sampleRate: c.sampleRate, last: i === p.chunks.length - 1 }));
    this.mic?.webContents.send('mic:cmd', { type: 'tts-done', id: p.id });
    await done;
    return true;
  }

  /** Bumped by stopSpeaking(): older streams go quiet for good. */
  private speechGen = 0;

  /** When the current speech stream was opened (for latency measurements). */
  speechStartedAt = 0;

  /** Settings → Preview: play a short line in `voice` (user-initiated). */
  async preview(voice: string, speed: number, line: string): Promise<void> {
    // An explicit Preview is also an explicit "try the natural voice again".
    if (this.tts.tooSlow) this.tts.retest();
    await this.speakAndWait(line, { voice, speed });
  }

  stopSpeaking() {
    this.speechGen++;
    if (this.ttsId > 0) {
      this.tts.cancel(this.ttsId);
      this.cloud.cancel(this.ttsId);
    }
    this.ttsId = 0;
    this.mic?.webContents.send('mic:cmd', { type: 'stop-speaking' });
    this.endSpeech?.();
  }

  private endSpeech: (() => void) | null = null;

  /**
   * V3: speak and resolve when the speech has ENDED (the mic window's TTS
   * "end"), with a length-based timeout in case the voice never reports back.
   */
  async speakAndWait(text: string, opts: { voice?: string; speed?: number } = {}): Promise<void> {
    const st = await this.openSpeech(opts);
    st.push(speechSentences(toSpokenText(text, this.dialectOf(st.voice))));
    st.end();
    await st.done;
  }

  /** Fire-and-forget speech. */
  async speak(text: string, opts: { voice?: string; speed?: number } = {}): Promise<void> {
    const st = await this.openSpeech(opts);
    st.push(speechSentences(toSpokenText(text, this.dialectOf(st.voice))));
    st.end();
  }

  /**
   * 0.9.6: an announcement. Optional chime, the text repeated 1–3 times, on the
   * chosen output device, optionally louder. The wake word is muted meanwhile so
   * the PC can't "hear itself"; Esc / "stop" cancel it (stopSpeaking or the
   * signal). Always spoken, even if spoken replies are off; the Windows voice
   * speaks when the natural voice isn't installed (always on the default device).
   */
  async announce(text: string, o: { chime: boolean; repeat: number; boost: boolean; device: string; signal: AbortSignal }): Promise<'done' | 'stopped'> {
    await this.ensureMicWindow();
    const onAbort = () => this.stopSpeaking();
    o.signal.addEventListener('abort', onAbort, { once: true });
    // A3: put back whatever mute state the wake word had before.
    const releaseWake = new WakeMuteHold(() => this.wakeMuted, (m) => this.setWakeMuted(m)).hold();
    // Every speech stream bumps speechGen once; any other bump is a stop (Esc, "stop", the wake word).
    let expected = this.speechGen;
    try {
      await this.micRequest({ type: 'ann-config', on: true, device: o.device, boost: o.boost }, 'ann-ready', 3000);
      if (o.chime && !o.signal.aborted) await this.micRequest({ type: 'ann-chime' }, 'ann-chime-done', 3000);
      for (let i = 0; i < o.repeat; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 700));
        if (o.signal.aborted || this.speechGen !== expected) return 'stopped';
        await this.speakAndWait(text);
        expected++;
        if (o.signal.aborted || this.speechGen !== expected) return 'stopped';
      }
      return 'done';
    } finally {
      o.signal.removeEventListener('abort', onAbort);
      this.mic?.webContents.send('mic:cmd', { type: 'ann-config', on: false });
      releaseWake();
    }
  }

  /** Output devices the mic window can play to (labels). */
  async outputDevices(): Promise<string[]> {
    await this.ensureMicWindow();
    const r = await this.micRequest({ type: 'list-outputs' }, 'outputs', 3000);
    return Array.isArray(r?.outputs) ? r.outputs : [];
  }

  /** Send a command to the mic window and wait for a status of `reply` type (null on timeout). */
  private micRequest(cmd: Record<string, unknown>, reply: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve) => {
      const mic = this.mic;
      if (!mic) return resolve(null);
      const on = (e: Electron.IpcMainEvent, m: any) => {
        if (e.sender !== mic.webContents || m?.type !== reply) return;
        clearTimeout(t);
        ipcMain.removeListener('mic:status', on);
        resolve(m);
      };
      const t = setTimeout(() => {
        ipcMain.removeListener('mic:status', on);
        resolve(null);
      }, timeoutMs);
      ipcMain.on('mic:status', on);
      mic.webContents.send('mic:cmd', cmd);
    });
  }

  /** British or American pronunciation rules for a voice. */
  dialectOf(voiceId: string): 'british' | 'american' {
    return voiceById(voiceId).accent;
  }

  dispose() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.tts.dispose();
    void this.stop();
    if (this.mic && !this.mic.isDestroyed()) this.mic.destroy();
    this.mic = null;
  }
}
