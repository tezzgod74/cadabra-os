// Round 6: REVIEW-5 top 10.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MicWatch, ENGINE_STALL_MS, SILENT_MS, type VoiceHealth } from '../src/main/voice/health';
import { endsOpen, FRAME, keywordsFileContent, VoicePipeline, type PipelineEvent } from '../src/main/voice/pipeline';
import { keywordsFileFor, type Scores } from '../src/shared/kws-tokens';
import { CLOUD_VOICE_DISCLOSURE, PERSONAS } from '../src/shared/voices';
import { deviceTag, redactDevices } from '../src/main/diagnostics';

const scores = JSON.parse(fs.readFileSync(path.resolve('resources/models/kws/scores.json'), 'utf8')) as Scores;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadabra-r6-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));

describe('V5-1: Esc / "stop" silences a streamed reply (any voice)', async () => {
  const { ConversationController } = await import('../src/main/conversation');
  it('after an abort the stream is cancelled, never ended (ended = "speak the rest")', async () => {
    const calls: string[] = [];
    const ref: { c?: InstanceType<typeof ConversationController> } = {};
    const provider = {
      send: (req: any) =>
        (async function* () {
          yield { type: 'text', delta: 'Once upon a time there was a lighthouse keeper. ' };
          ref.c!.cancel('Stopped.'); // Esc while the story streams
          yield { type: 'text', delta: 'He lived on a rock in the sea. And so on. ' };
          void req;
          yield { type: 'done' };
        })(),
      reset() {},
      onAbort() {},
    };
    const settings = { provider: 'claude', voice: { speakReplies: 'voice', followUpSeconds: 0, wakeWord: 'cadabra' }, displayName: '' };
    const c = (ref.c = new ConversationController({
      settings: () => settings,
      now: () => Date.now(),
      provider: () => provider,
      model: () => 'm',
      gate: { beginRun() {}, stop() {} },
      buildTurn: () => ({ run: {}, request: {} }),
      setRun() {},
      afterRun() {},
      hasPendingConfirm: () => false,
      resolveConfirm() {},
      rejectConfirms() {},
      localLaunch: async () => null,
      localIntent: async () => null,
      voice: {
        stopSpeaking: () => calls.push('stopSpeaking'),
        armFollowUp() {},
        speak: async () => void calls.push('speak'),
        enabled: () => true,
        openStream: async () => ({ push: (xs: string[]) => void calls.push(`push:${xs.length}`), end: async () => void calls.push('end'), cancel: () => void calls.push('cancel') }),
      },
      ui: { busy() {}, event() {}, notice() {}, userEcho() {}, panelVisible: () => true, dismiss() {} },
    } as any));
    await c.onVoice('tell me a short story about a lighthouse', false);
    expect(calls).toContain('stopSpeaking');
    expect(calls).toContain('cancel');
    expect(calls).not.toContain('end');
    expect(calls).not.toContain('speak');
  });
});

describe('V5-2: endpointing after a question / presence phrase', () => {
  it('endsOpen', () => {
    expect(endsOpen('Cadabra, are you there?')).toBe(true);
    expect(endsOpen('Cadabra are you there')).toBe(true);
    expect(endsOpen('hello')).toBe(true);
    expect(endsOpen('what time is it')).toBe(false);
    expect(endsOpen('Cadabra, what time is it?')).toBe(false); // REVIEW-7 W7-5: full questions end at 700 ms
    expect(endsOpen('Cadabra, you awake?')).toBe(true);
    expect(endsOpen('open the calculator')).toBe(false);
    expect(endsOpen('')).toBe(false);
  });

  function fake(o: { speech: () => boolean; text: () => string }) {
    let asrCalls = 0;
    const sherpa = {
      KeywordSpotter: class {
        createStream() {
          return { acceptWaveform() {} };
        }
        isReady() {
          return false;
        }
      },
      Vad: class {
        acceptWaveform() {}
        isDetected() {
          return o.speech();
        }
        isEmpty() {
          return true;
        }
        pop() {}
      },
      OfflineRecognizer: class {
        createStream() {
          return { acceptWaveform() {} };
        }
        decode() {
          asrCalls++;
        }
        getResult() {
          return { text: o.text() };
        }
      },
    };
    return { sherpa, asr: () => asrCalls };
  }
  function pipe(o: { speech: () => boolean; text: () => string }) {
    const asrDir = path.join(tmp, 'asr');
    fs.mkdirSync(asrDir, { recursive: true });
    fs.writeFileSync(path.join(asrDir, 'model.int8.onnx'), '');
    fs.mkdirSync(path.join(tmp, 'kws'), { recursive: true });
    fs.copyFileSync(path.resolve('resources/models/kws/scores.json'), path.join(tmp, 'kws', 'scores.json'));
    const f = fake(o);
    const events: PipelineEvent[] = [];
    const p = new VoicePipeline(f.sherpa, { modelsDir: tmp, asrDir, sensitivity: 0.5, workDir: path.join(tmp, 'v') }, (e) => events.push(e));
    return { p, events, asr: f.asr };
  }
  const frames = (ms: number) => Math.ceil((ms / 1000) * 16000 / FRAME);

  it('waits ~950 ms (not 700) after "are you there?" and keeps listening', () => {
    let speaking = true;
    let t = 'Cadabra, are you there?';
    const { p, events } = pipe({ speech: () => speaking, text: () => t });
    p.armFollowUp(30_000);
    for (let i = 0; i < frames(2200); i++) p.accept(speaking ? new Float32Array(FRAME).fill(0.1) : new Float32Array(FRAME)); // speech
    speaking = false;
    for (let i = 0; i < frames(800); i++) p.accept(speaking ? new Float32Array(FRAME).fill(0.1) : new Float32Array(FRAME)); // a natural 0.8 s pause
    expect(events.some((e) => e.type === 'utterance')).toBe(false); // not cut at 700 ms
    speaking = true;
    t = 'Cadabra, are you there? What time is it?';
    for (let i = 0; i < frames(900); i++) p.accept(speaking ? new Float32Array(FRAME).fill(0.1) : new Float32Array(FRAME));
    speaking = false;
    for (let i = 0; i < frames(1100); i++) p.accept(speaking ? new Float32Array(FRAME).fill(0.1) : new Float32Array(FRAME));
    const u = events.filter((e) => e.type === 'utterance');
    expect(u).toHaveLength(1);
    expect((u[0] as any).text).toMatch(/What time is it/);
  });

  it('a plain request still ends after ~700 ms and the probe transcript is reused', () => {
    let speaking = true;
    const { p, events, asr } = pipe({ speech: () => speaking, text: () => 'Cadabra, open the calculator' });
    p.armFollowUp(30_000);
    for (let i = 0; i < frames(2200); i++) p.accept(speaking ? new Float32Array(FRAME).fill(0.1) : new Float32Array(FRAME));
    speaking = false;
    for (let i = 0; i < frames(760); i++) p.accept(speaking ? new Float32Array(FRAME).fill(0.1) : new Float32Array(FRAME));
    expect(events.filter((e) => e.type === 'utterance')).toHaveLength(1);
    expect(asr()).toBe(1); // one ASR pass, not two
  });
});

describe('V5-5: Cadabra keeps its round-4 wake line; tuning env vars only in test modes', () => {
  it('Cadabra = the exact round-4 line (one path, #0.28 at Medium)', () => {
    const lines = keywordsFileContent(0.5, 'Cadabra', scores).trim().split('\n');
    expect(lines[0]).toBe('▁CA D A B RA :2.0 #0.28 @CADABRA');
    expect(lines.filter((l) => l.endsWith('@CADABRA'))).toHaveLength(1);
  });
  it('CADABRA_KWS_* are ignored unless CADABRA_TEST_MODE=1', () => {
    const was = { ...process.env };
    try {
      delete process.env.CADABRA_TEST_MODE;
      process.env.CADABRA_KWS_TH_OFFSET = '-0.3';
      process.env.CADABRA_KWS_PATHS = '6';
      const a = keywordsFileFor('Vesper', 0.5, scores);
      expect(a).toMatch(/#0\.18 @VESPER/);
      expect(a.trim().split('\n').filter((l) => l.endsWith('@VESPER')).length).toBeLessThanOrEqual(3);
      process.env.CADABRA_TEST_MODE = '1';
      expect(keywordsFileFor('Vesper', 0.5, scores)).toMatch(/#0\.05 @VESPER/);
    } finally {
      process.env = was;
    }
  });
});

describe('D1–D5: health watchdog additions', () => {
  function watch() {
    let now = 1_000_000;
    const healths: VoiceHealth[] = [];
    const restarts: ['mic' | 'engine', number][] = [];
    const w = new MicWatch({ health: (h) => healths.push(h), restart: (k, d) => restarts.push([k, d]) }, () => now);
    w.starting();
    w.engineReady();
    w.onMic({ state: 'started', track: 'Microphone (USB Audio)', defaultInput: 'Microphone (USB Audio)' });
    return { w, healths, restarts, advance: (ms: number) => (now += ms) };
  }
  it('D1: mic frames flowing but the engine processing none → engine restart', () => {
    const { w, restarts, advance } = watch();
    let f = 0;
    for (let t = 0; t <= ENGINE_STALL_MS + 2000; t += 2000) {
      w.onMic({ state: 'stats', frames: (f += 60), peak: 0.1 });
      advance(2000);
    }
    expect(w.health).toBe('engine-error');
    expect(restarts.at(-1)![0]).toBe('engine');
    expect(w.status().lastRestartReason).toMatch(/stopped processing audio/);
  });
  it('D1: a ticking engine heartbeat keeps it healthy', () => {
    const { w, restarts, advance } = watch();
    let f = 0;
    for (let t = 0; t <= 20_000; t += 2000) {
      w.engineHeartbeat(f);
      w.onMic({ state: 'stats', frames: (f += 60), peak: 0.1 });
      advance(2000);
    }
    expect(w.health).toBe('ok');
    expect(restarts).toHaveLength(0);
  });
  it('D5: a muted track says so at once; unmute recovers', () => {
    const { w } = watch();
    w.onMic({ state: 'muted' });
    expect(w.health).toBe('mic-muted');
    w.onMic({ state: 'unmuted' });
    expect(w.health).toBe('ok');
  });
  it('D3: one capture restart per silence episode — no restart loop', () => {
    const { w, restarts, advance } = watch();
    let f = 0;
    const silentFor = (ms: number) => {
      for (let t = 0; t < ms; t += 2000) {
        w.engineHeartbeat(f);
        w.onMic({ state: 'stats', frames: (f += 60), peak: 0 });
        advance(2000);
      }
    };
    silentFor(SILENT_MS + 2000);
    expect(w.health).toBe('silent');
    expect(restarts).toHaveLength(1);
    w.onMic({ state: 'started', track: 'Microphone (USB Audio)' }); // the restarted capture
    silentFor(SILENT_MS * 4);
    expect(restarts).toHaveLength(1); // still silent: reported, not restarted again
    expect(w.health).toBe('silent');
  });
  it('D4: the Windows default input changed → follow it (restart the capture once)', () => {
    const { w, restarts } = watch();
    w.onMic({ state: 'devicechange', defaultInput: 'Headset Microphone (Bluetooth)', live: true });
    expect(restarts).toEqual([['mic', 500]]);
    expect(w.status().lastRestartReason).toBe('the default microphone changed');
    w.onMic({ state: 'started', track: 'Headset Microphone (Bluetooth)', defaultInput: 'Headset Microphone (Bluetooth)' });
    expect(w.status().device).toBe('Headset Microphone (Bluetooth)');
    w.onMic({ state: 'devicechange', defaultInput: 'Headset Microphone (Bluetooth)', live: true });
    expect(restarts).toHaveLength(1);
  });
  it('status() feeds Settings → Voice status', () => {
    const { w } = watch();
    w.manualRestart();
    expect(w.status()).toMatchObject({ health: 'ok', text: 'Voice: listening', device: 'Microphone (USB Audio)', lastRestartReason: 'restarted by you' });
  });
});

describe('V5-4 / privacy', () => {
  it('the cloud disclosure says what leaves the PC', () => {
    expect(CLOUD_VOICE_DISCLOSURE).toMatch(/text of every spoken reply is sent to OpenAI/);
    for (const p of PERSONAS.filter((x) => x.dialect === 'southern')) expect(p.blurb).toMatch(/sent to OpenAI/);
  });
  it('exported diagnostics replace microphone names with a kind + hash', () => {
    expect(deviceTag("Jane's AirPods Pro")).toMatch(/^Bluetooth\/headset input #[0-9a-f]{6}$/);
    expect(deviceTag('Analogue 1 + 2 (USB Audio Interface)')).toMatch(/^USB input #/);
    const t = redactDevices(`[voice] mic started [Jane's AirPods Pro] context=running\n[voice] mic devicechange inputs=["Default - Jane's AirPods Pro","Microphone Array (Realtek)"]\nVoice: idle, input [Jane's AirPods Pro]`);
    expect(t).not.toMatch(/Jane|AirPods|Realtek/);
    expect(t).toMatch(/mic started \[Bluetooth\/headset input #[0-9a-f]{6}\]/);
    expect(t).toMatch(/built-in input #/);
  });
});
