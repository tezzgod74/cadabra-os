// Local voice pipeline (runs in the voice utilityProcess, or in Node for tests):
//   16 kHz mono Float32 frames → Silero VAD + sherpa-onnx keyword spotting
//   ("CADABRA", with an "ABRACADABRA" decoy) → on wake, capture from a rolling
//   4 s pre-roll so "Cadabra <request>" works in one breath → end on ~0.5 s of
//   VAD silence (15 s cap) → Parakeet (offline) ASR → second-stage check that
//   the transcript really starts with "cadabra".
// Nothing is written to disk and nothing leaves the machine.

import fs from 'node:fs';
import path from 'node:path';
import { curatedName, DEFAULT_NAME, matchWake } from '../../shared/assistant';
import { keywordLabel, keywordsFileFor, type Scores } from '../../shared/kws-tokens';

export const SAMPLE_RATE = 16000;
export const FRAME = 512; // 32 ms, Silero VAD window
/** Energy may stand in for the (late) VAD for at most this long (REVIEW-6 N6-1). */
export const ENERGY_EXTEND_SAMPLES = Math.round(0.4 * SAMPLE_RATE);
/** Sound >15 dB below the user's own level in a capture counts as background. */
export const BACKGROUND_RATIO = 0.18;
/** The user's level has dropped ≥6 dB for this long: the turn is over (loud-TV fallback). */
export const LEVEL_DROP_SAMPLES = Math.round(1.5 * SAMPLE_RATE);

export type PipelineEvent =
  | { type: 'ready'; asr: boolean; loadMs: number }
  | { type: 'wake'; keyword: string; at: number }
  | { type: 'level'; level: number }
  | { type: 'capturing'; ms: number }
  | { type: 'utterance'; text: string; request: string; audioMs: number; asrMs: number; followUp?: boolean; manual?: boolean; silenceMs?: number }
  | { type: 'followup'; state: 'armed' | 'expired' | 'heard' }
  | { type: 'barge' }
  | { type: 'rejected'; text: string; reason: string }
  | { type: 'error'; message: string };

export interface PipelineOptions {
  /** Folder with kws/ and silero_vad.onnx (shipped in the installer). */
  modelsDir: string;
  /** Folder with Parakeet model.int8.onnx + tokens.txt (downloaded), or null. */
  asrDir: string | null;
  /** 0 (strict) .. 1 (sensitive); maps to KWS threshold 0.40 .. 0.15. */
  sensitivity: number;
  /** Where to write the generated keywords file. */
  workDir: string;
  /** Round 5: the assistant's name = the wake word (default "Cadabra"). */
  wakeWord?: string;
  minSilenceMs?: number;
  maxCaptureMs?: number;
  refractoryMs?: number;
  preRollMs?: number;
}

/** Fuzzy "cadabra" at the start of a transcript (ASR may write "Kadaborra"). */
export const WAKE_RE = /^\s*(?:hey|ok(?:ay)?)?[\s,]*(?:c|k)a+\s*d+[aeiou]*\s*b+[aeiou]*r+[aeiou]*h?(?![a-z])[\s,.!?:;-]*/i;

/**
 * Round 6 (REVIEW-5 V5-2): does the request so far end like the user may go
 * on? A question ("are you there?") or a presence phrase is often followed by a
 * 0.7–1.0 s pause before the real request ("… what time is it").
 */
export function endsOpen(text: string, wake = DEFAULT_NAME): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\b(are you there|you there|are you (awake|listening|around)|can you hear me|hello|hi|hey|hiya|morning|good (morning|afternoon|evening))[\s.,!?…]*$/i.test(t)) return true;
  // REVIEW-7 W7-5: only a SHORT question (≤ 3 words after the name: "you awake?",
  // "Cadabra, quick question?") waits longer; "what time is it?" ends at 700 ms.
  if (/\?\s*$/.test(t)) {
    const words = t
      .replace(new RegExp(`^\\s*(hey |ok |okay )?${wake.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s,.!?:;-]*`, 'i'), '')
      .split(/\s+/)
      .filter(Boolean).length;
    return words <= 3;
  }
  return false;
}

/** Second-stage check: the transcript starts with the wake word (fuzzy). */
export function verifyWake(text: string, name = DEFAULT_NAME): { request: string } | null {
  if (name.toLowerCase() === 'cadabra') {
    const m = WAKE_RE.exec(text);
    if (m) return { request: text.slice(m[0].length).trim() };
  }
  return matchWake(text, name);
}

export function loadScores(modelsDir: string): Scores {
  return JSON.parse(fs.readFileSync(path.join(modelsDir, 'kws', 'scores.json'), 'utf8')) as Scores;
}

/** The KWS keywords file for a name (with its curated decoys). */
export function keywordsFileContent(sensitivity: number, name: string, scores: Scores): string {
  const c = curatedName(name);
  return keywordsFileFor(name, sensitivity, scores, c?.decoys ?? [], c?.tune);
}

export class VoicePipeline {
  private kws: any;
  private kwsStream: any;
  private vad: any;
  private asr: any = null;
  private ring: Float32Array;
  private ringPos = 0;
  private total = 0; // samples seen
  private speaking = false;
  private speechStart: number | null = null;
  private capture: Float32Array[] | null = null;
  private captureSamples = 0;
  private silentSamples = 0;
  private refractoryUntil = 0;
  private muted = false;
  private frameCount = 0;
  private manual = false;
  /** Follow-up window: capture on speech onset WITHOUT the wake word until this sample. */
  private followUntil = 0;
  private followCapture = false;
  /** Cadabra itself is speaking (TTS): no follow-up capture; the wake word barges in. */
  private speakingTts = false;
  private readonly minSilence: number;
  private readonly minSilenceShort: number;
  /** After a question / presence phrase: wait a little longer (V5-2). */
  private readonly minSilenceOpen: number;
  /** The transcript probed at the normal endpoint, kept while we wait longer. */
  private probe: { text: string; asrMs: number } | null = null;
  /** Running estimate of the room's noise level (RMS), tracked continuously. */
  private noiseFloor = 0.005;
  private lastRms = 0;
  /** Samples in a row counted as speech on energy alone (capped). */
  private energyOnly = 0;
  /** Peak speech level (RMS) of the user in the current capture. */
  private speechLevel = 0;
  /** Samples in a row ≥6 dB below the user's level (REVIEW-7 W7-6). */
  private belowUser = 0;
  /** Level of speech heard outside captures (TV, people in the room). */
  private bgSpeech = 0;
  /** Round 9 (R8-5): the user's own speaking level, learned from wake-word captures (0 = not yet). */
  userLevel = 0;
  /** The armed follow-up only starts on speech near the user's own level (greeting window). */
  private followStrict = false;
  /** Whether the current capture was started by the wake word (its level teaches userLevel). */
  private wakeCapture = false;
  private readonly maxCapture: number;
  private readonly refractory: number;
  private readonly preRoll: number;
  private readonly wakeName: string;
  private readonly wakeLabel: string;

  constructor(
    sherpa: any,
    opts: PipelineOptions,
    private readonly emit: (e: PipelineEvent) => void,
  ) {
    // Round 5 (adaptive endpointing): 700 ms of silence ends a request; a
    // capture that is still very short (just the name, then a pause) waits
    // 1300 ms so "Juniper … what time is it" isn't cut after the name.
    // CADABRA_ENDPOINT_MS forces a fixed value (before/after measurements).
    const fixed = (process.env.CADABRA_TEST_MODE === '1' ? Number(process.env.CADABRA_ENDPOINT_MS) : 0) || opts.minSilenceMs;
    this.minSilence = Math.round(((fixed ?? 700) / 1000) * SAMPLE_RATE);
    this.minSilenceShort = Math.round(((fixed ?? 1300) / 1000) * SAMPLE_RATE);
    // 1100 ms (not 950): a 0.9 s pause plus the quiet tail of "there?" measures ~0.95 s (round 7 test).
    this.minSilenceOpen = Math.round(((fixed ?? 1100) / 1000) * SAMPLE_RATE);
    this.maxCapture = Math.round(((opts.maxCaptureMs ?? 15000) / 1000) * SAMPLE_RATE);
    this.refractory = Math.round(((opts.refractoryMs ?? 2000) / 1000) * SAMPLE_RATE);
    this.preRoll = Math.round(((opts.preRollMs ?? 4000) / 1000) * SAMPLE_RATE);
    this.ring = new Float32Array(this.preRoll);
    const t0 = Date.now();
    const K = path.join(opts.modelsDir, 'kws');
    fs.mkdirSync(opts.workDir, { recursive: true });
    this.wakeName = (opts.wakeWord || DEFAULT_NAME).trim();
    this.wakeLabel = keywordLabel(this.wakeName);
    const kwFile = path.join(opts.workDir, 'wake-keywords.txt');
    fs.writeFileSync(kwFile, keywordsFileContent(opts.sensitivity, this.wakeName, loadScores(opts.modelsDir)));
    this.kws = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(K, 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
          decoder: path.join(K, 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
          joiner: path.join(K, 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        },
        tokens: path.join(K, 'tokens.txt'),
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      keywordsFile: kwFile,
    });
    this.kwsStream = this.kws.createStream();
    this.vad = new sherpa.Vad(
      {
        sileroVad: { model: path.join(opts.modelsDir, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.25, minSpeechDuration: 0.3, windowSize: FRAME, maxSpeechDuration: 20 },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        debug: false,
      },
      30,
    );
    if (opts.asrDir && fs.existsSync(path.join(opts.asrDir, 'model.int8.onnx'))) {
      this.asr = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          nemoCtc: { model: path.join(opts.asrDir, 'model.int8.onnx') },
          tokens: path.join(opts.asrDir, 'tokens.txt'),
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
      });
    }
    this.emit({ type: 'ready', asr: !!this.asr, loadMs: Date.now() - t0 });
  }

  /** Listen for a follow-up without the wake word for `ms`. */
  armFollowUp(ms: number, strict = false) {
    // Round 4.5: arming while a capture (e.g. push-to-talk) is running cut that
    // capture short in the soak test. The capture wins; arm afterwards.
    if (this.capture) return;
    this.followStrict = strict;
    this.followUntil = this.total + Math.round((ms / 1000) * SAMPLE_RATE);
    this.emit({ type: 'followup', state: 'armed' });
  }

  disarmFollowUp() {
    if (this.followUntil > this.total) this.emit({ type: 'followup', state: 'expired' });
    this.followUntil = 0;
  }

  setSpeaking(on: boolean) {
    this.speakingTts = on;
  }

  /** Mute wake detection (e.g. push-to-talk-only mode). */
  setMuted(m: boolean) {
    this.muted = m;
  }

  get capturing(): boolean {
    return !!this.capture;
  }

  /** Feed 16 kHz mono samples (any length; processed in 512-sample frames). */
  accept(samples: Float32Array) {
    for (let i = 0; i + FRAME <= samples.length; i += FRAME) this.frame(samples.subarray(i, i + FRAME));
  }

  private pushRing(f: Float32Array) {
    for (let i = 0; i < f.length; i++) {
      this.ring[this.ringPos] = f[i];
      this.ringPos = (this.ringPos + 1) % this.ring.length;
    }
  }

  /** Last `n` samples from the ring buffer, oldest first. */
  private ringTail(n: number): Float32Array {
    n = Math.min(n, this.ring.length, this.total);
    const out = new Float32Array(n);
    let p = (this.ringPos - n + this.ring.length) % this.ring.length;
    for (let i = 0; i < n; i++) {
      out[i] = this.ring[p];
      p = (p + 1) % this.ring.length;
    }
    return out;
  }

  private frame(f: Float32Array) {
    const frame = new Float32Array(f); // own copy (ports may transfer buffers)
    this.total += frame.length;
    this.pushRing(frame);
    this.frameCount++;

    this.vad.acceptWaveform(frame);
    const nowSpeaking = this.vad.isDetected();
    // Continuous noise floor (REVIEW-6 N6-1): follows quiet frames down quickly
    // and rises slowly (≈2× in 8 s) while the VAD hears no speech.
    {
      let e = 0;
      for (let i = 0; i < frame.length; i += 4) e += frame[i] * frame[i];
      this.lastRms = Math.sqrt(e / (frame.length / 4));
      if (!nowSpeaking) this.noiseFloor = this.lastRms < this.noiseFloor ? this.noiseFloor * 0.9 + this.lastRms * 0.1 : Math.min(0.2, this.noiseFloor * 1.0028 + 1e-6);
      // Background talk level (outside captures): what the VAD calls speech while
      // nobody is talking to us. Decays when the room goes quiet.
      if (!this.capture) this.bgSpeech = nowSpeaking ? this.bgSpeech * 0.97 + this.lastRms * 0.03 : this.bgSpeech * 0.995;
    }
    if (nowSpeaking && !this.speaking) this.speechStart = Math.max(0, this.total - frame.length - Math.round(0.35 * SAMPLE_RATE));
    if (!nowSpeaking && this.speaking && !this.capture) this.speechStart = null;
    this.speaking = nowSpeaking;
    while (!this.vad.isEmpty()) this.vad.pop();

    if (this.capture) {
      this.capture.push(frame);
      this.captureSamples += frame.length;
      // Round 6: Silero needs ~0.3 s of new speech before it reports it again,
      // which made a 0.6 s pause count as ~0.9 s of silence and cut "… What
      // time is it" mid-word. Clear speech energy resets the silence count too.
      // Round 7 (REVIEW-6 N6-1): the noise floor is tracked all the time (see
      // below) and energy alone counts as speech for at most 400 ms in a row,
      // so a TV or fan can't keep a turn open until the 15 s cap.
      const loud = this.lastRms > Math.max(0.015, this.noiseFloor * 3);
      // The user's own speech level in this capture (a slowly decaying peak).
      // Speech the VAD hears that is >15 dB quieter than that is the TV or
      // people in the background, not the user: it doesn't hold the turn open.
      if (nowSpeaking && loud) this.speechLevel = Math.max(this.lastRms, this.speechLevel * 0.998);
      const userSpeech = nowSpeaking && this.lastRms >= this.speechLevel * BACKGROUND_RATIO;
      // Energy at the user's level (not the TV's) bridges the VAD's late onset, for at most 400 ms.
      const userLoud = loud && this.lastRms >= this.speechLevel * BACKGROUND_RATIO;
      this.energyOnly = userSpeech || !userLoud ? 0 : this.energyOnly + frame.length;
      const voiced = userSpeech || (userLoud && this.energyOnly <= ENERGY_EXTEND_SAMPLES);
      this.silentSamples = voiced ? 0 : this.silentSamples + frame.length;
      // REVIEW-7 W7-6: a TV within 15 dB of the user still counts as "speech".
      // If the level has stayed ≥6 dB below the user's own for 1.5 s, the user
      // has stopped talking: end the turn.
      this.belowUser = this.speechLevel > 0 && this.lastRms < this.speechLevel * 0.5 ? this.belowUser + frame.length : 0;
      if (voiced) this.probe = null; // the user went on: probe again later
      if (this.frameCount % 3 === 0) {
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        this.emit({ type: 'level', level: Math.min(1, Math.sqrt(sum / frame.length) * 6) });
      }
      const minLen = 0.8 * SAMPLE_RATE;
      if (this.manual) {
        if (this.captureSamples >= this.maxCapture) this.finish();
        return;
      }
      if (this.captureSamples >= this.maxCapture) return this.finish(this.probe ?? undefined);
      if (!this.manual && this.belowUser >= LEVEL_DROP_SAMPLES && this.captureSamples > 0.8 * SAMPLE_RATE) return this.finish();
      const short = this.captureSamples - this.silentSamples < 1.8 * SAMPLE_RATE;
      if (this.captureSamples <= minLen) return;
      if (short) {
        if (this.silentSamples >= this.minSilenceShort) this.finish();
        return;
      }
      if (this.probe) {
        // Waiting a little longer after "are you there?" for "what time is it".
        if (this.silentSamples >= this.minSilenceOpen) this.finish(this.probe);
        return;
      }
      if (this.silentSamples >= this.minSilence) {
        const p = this.transcribe(this.captureAudio());
        if (!p) return this.finish();
        if (endsOpen(p.text, this.wakeName) && this.minSilenceOpen > this.minSilence) {
          this.probe = p;
          return;
        }
        this.finish(p);
      }
      return;
    }

    if (this.followUntil) {
      if (this.total >= this.followUntil) {
        this.followUntil = 0;
        this.emit({ type: 'followup', state: 'expired' });
      } else if (nowSpeaking && !this.speakingTts && this.lastRms >= this.followThreshold()) {
        // Round 7: only speech clearly louder than the background talk (TV,
        // people in the room) starts a follow-up without the wake word.
        this.followUntil = 0;
        this.followCapture = true;
        this.emit({ type: 'followup', state: 'heard' });
        this.startCapture('FOLLOW_UP');
        return;
      }
    }

    if (this.muted || this.total < this.refractoryUntil) return;
    this.kwsStream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: frame });
    while (this.kws.isReady(this.kwsStream)) {
      this.kws.decode(this.kwsStream);
      const r = this.kws.getResult(this.kwsStream);
      if (r?.keyword) {
        this.kws.reset(this.kwsStream);
        if (r.keyword === this.wakeLabel) {
          if (this.speakingTts) this.emit({ type: 'barge' });
          this.startCapture(r.keyword);
          return;
        }
      }
    }
  }

  private startCapture(keyword: string) {
    this.wakeCapture = keyword !== 'FOLLOW_UP';
    this.speechLevel = 0;
    this.energyOnly = 0;
    this.belowUser = 0;
    // Seed from the start of the current speech (includes the wake word), else 2.5 s back.
    // A follow-up has no wake word to include: a short pre-roll is enough, and
    // with a TV on "the start of the current speech" may be seconds of TV.
    const back = keyword === 'FOLLOW_UP' ? Math.round(0.5 * SAMPLE_RATE) : this.speechStart != null ? this.total - this.speechStart : Math.round(2.5 * SAMPLE_RATE);
    const seed = this.ringTail(Math.min(back, this.ring.length));
    this.capture = [seed];
    this.captureSamples = seed.length;
    this.silentSamples = 0;
    this.emit({ type: 'wake', keyword, at: this.total / SAMPLE_RATE });
  }

  /** Push-to-talk: start capturing now (no wake word needed). */
  beginManualCapture() {
    if (this.capture) return;
    this.speechLevel = 0;
    this.manual = true;
    this.capture = [this.ringTail(Math.round(0.25 * SAMPLE_RATE))];
    this.captureSamples = this.capture[0].length;
    this.silentSamples = 0;
    this.emit({ type: 'wake', keyword: 'PUSH_TO_TALK', at: this.total / SAMPLE_RATE });
  }

  /** Push-to-talk released: transcribe what was captured. */
  endManualCapture() {
    if (this.capture && this.manual) this.finish();
  }

  /** Force the end of a capture (e.g. on Esc). */
  cancel() {
    this.capture = null;
    this.manual = false;
    this.followCapture = false;
    this.followUntil = 0;
    this.freshKwsStream();
  }

  /** A fresh KWS stream: reset() alone left the spotter deaf after a long capture (measured). */
  private freshKwsStream() {
    this.kwsStream = this.kws.createStream();
  }

  private captureAudio(): Float32Array {
    const audio = new Float32Array(this.captureSamples);
    let o = 0;
    for (const p of this.capture ?? []) {
      audio.set(p, o);
      o += p.length;
    }
    return audio;
  }

  /** Round 12: transcribe a whole 16 kHz clip (a WhatsApp voice note); '' when it can't. */
  transcribeClip(audio: Float32Array): string {
    return this.transcribe(audio)?.text ?? '';
  }

  /** Offline ASR of a capture; null if the model is missing or fails. */
  private transcribe(audio: Float32Array): { text: string; asrMs: number } | null {
    if (!this.asr) return null;
    const t0 = Date.now();
    try {
      const s = this.asr.createStream();
      s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: audio });
      this.asr.decode(s);
      return { text: String(this.asr.getResult(s).text ?? '').trim(), asrMs: Date.now() - t0 };
    } catch (e) {
      this.emit({ type: 'error', message: `ASR failed: ${(e as Error).message}` });
      return null;
    }
  }

  /**
   * Level a follow-up must reach to start without the wake word. Round 7: clearly
   * above background talk. Round 9 (greeting window): also within ~6 dB of the
   * user's own learned level, so another voice in the room isn't taken as a reply.
   */
  followThreshold(): number {
    const base = Math.max(0.01, this.bgSpeech * 3);
    if (!this.followStrict) return base;
    return Math.max(base * 1.33, 0.015, this.userLevel ? this.userLevel * 0.5 : 0);
  }

  private finish(pre?: { text: string; asrMs: number }) {
    this.probe = null;
    // R8-5: learn the user's speaking level from wake-word captures.
    if (this.wakeCapture && this.speechLevel > 0.005) this.userLevel = this.userLevel ? this.userLevel * 0.7 + this.speechLevel * 0.3 : this.speechLevel;
    this.wakeCapture = false;
    this.followStrict = false;
    const parts = this.capture!;
    const manual = this.manual;
    const followUp = this.followCapture;
    const silenceMs = manual ? 0 : Math.round((this.silentSamples / SAMPLE_RATE) * 1000);
    this.capture = null;
    this.manual = false;
    this.followCapture = false;
    this.refractoryUntil = this.total + this.refractory;
    this.freshKwsStream();
    const audio = new Float32Array(this.captureSamples);
    let o = 0;
    for (const p of parts) {
      audio.set(p, o);
      o += p.length;
    }
    const audioMs = Math.round((audio.length / SAMPLE_RATE) * 1000);
    if (!this.asr) {
      this.emit({ type: 'rejected', text: '', reason: 'speech-to-text model not installed' });
      return;
    }
    // The probe's transcript is reused when only silence followed it.
    const r = pre ?? this.transcribe(audio);
    if (!r) return;
    const { text, asrMs } = r;
    // Push-to-talk and follow-ups don't need the wake word (strip it if present).
    const v = manual || followUp ? (verifyWake(text, this.wakeName) ?? { request: text }) : verifyWake(text, this.wakeName);
    if (!v) {
      this.emit({ type: 'rejected', text, reason: 'transcript does not start with the wake word' });
      return;
    }
    if (followUp && !v.request) {
      this.emit({ type: 'rejected', text, reason: 'empty follow-up' });
      return;
    }
    // Push-to-talk that heard nothing: say so, don't open an empty panel.
    if (manual && !v.request) {
      this.emit({ type: 'rejected', text, reason: 'nothing heard (push-to-talk)' });
      return;
    }
    this.emit({ type: 'utterance', text, request: v.request, audioMs, asrMs, ...(followUp ? { followUp: true } : {}), ...(manual ? { manual: true } : {}), silenceMs });
  }
}
