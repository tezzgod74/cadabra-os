// Round 4.5: hands-on voice failure ("worked, then got wonky; after a restart
// neither the wake word nor push-to-talk heard anything") and its fixes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MicWatch, MIC_RETRIES_BEFORE_ENGINE, restartDelay, SILENT_MS, STALL_MS, healthIsProblem, type VoiceHealth } from '../src/main/voice/health';
import { VoicePipeline, FRAME, type PipelineEvent } from '../src/main/voice/pipeline';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadabra-r45-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));

function watch() {
  let now = 1_000_000;
  const healths: [VoiceHealth, string][] = [];
  const restarts: ['mic' | 'engine', number][] = [];
  const w = new MicWatch({ health: (h, d) => healths.push([h, d]), restart: (k, d) => restarts.push([k, d]) }, () => now);
  return { w, healths, restarts, advance: (ms: number) => (now += ms) };
}

describe('voice health watchdog (MicWatch)', () => {
  it('ok only when the engine is ready AND the mic delivers', () => {
    const { w } = watch();
    w.starting();
    expect(w.health).toBe('starting');
    w.engineReady();
    expect(w.health).toBe('starting');
    w.onMic({ state: 'started', track: 'Mic' });
    expect(w.health).toBe('ok');
  });

  it('CONFIRMED failure mode: the capture ends with no error → mic-lost + automatic mic restart', () => {
    const { w, restarts } = watch();
    w.starting();
    w.engineReady();
    w.onMic({ state: 'started' });
    w.onMic({ state: 'ended', track: 'Analogue 1 + 2' });
    expect(w.health).toBe('mic-lost');
    expect(restarts).toEqual([['mic', 1000]]);
    // It comes back.
    w.onMic({ state: 'started' });
    expect(w.health).toBe('ok');
  });

  it('frames stop arriving (stalled capture) → mic-lost', () => {
    const { w, restarts, advance } = watch();
    w.starting();
    w.engineReady();
    w.onMic({ state: 'started' });
    w.onMic({ state: 'stats', frames: 10, peak: 0.1 });
    advance(STALL_MS + 100);
    w.onMic({ state: 'stats', frames: 10, peak: 0.1 });
    expect(w.health).toBe('mic-lost');
    expect(restarts[0][0]).toBe('mic');
  });

  it('the mic window going quiet altogether is caught by tick()', () => {
    const { w, advance } = watch();
    w.starting();
    w.engineReady();
    w.onMic({ state: 'started' });
    advance(STALL_MS + 5000);
    w.tick();
    expect(w.health).toBe('mic-lost');
  });

  it('digital silence for 20 s → "silent" (muted / wrong input), recovers on sound', () => {
    const { w, advance } = watch();
    w.starting();
    w.engineReady();
    w.onMic({ state: 'started' });
    let f = 0;
    for (let t = 0; t <= SILENT_MS; t += 2000) {
      w.onMic({ state: 'stats', frames: (f += 60), peak: 0 });
      advance(2000);
    }
    expect(w.health).toBe('silent');
    w.onMic({ state: 'stats', frames: f + 60, peak: 0.05 });
    expect(w.health).toBe('ok');
  });

  it('backoff, then a full engine restart after repeated mic failures', () => {
    const { w, restarts } = watch();
    w.starting();
    w.engineReady();
    for (let i = 0; i < MIC_RETRIES_BEFORE_ENGINE + 1; i++) w.onMic({ state: 'error', name: 'NotReadableError', message: 'Could not start audio source' });
    expect(restarts.map((r) => r[1])).toEqual([1000, 2000, 4000, 8000]);
    expect(restarts.at(-1)![0]).toBe('engine');
    expect(restartDelay(10)).toBe(30_000);
  });

  it('blocked microphone permission is reported plainly and retried slowly', () => {
    const { w, restarts } = watch();
    w.starting();
    w.onMic({ state: 'error', name: 'NotAllowedError', message: 'Permission denied' });
    expect(w.health).toBe('no-mic-access');
    expect(restarts).toEqual([['mic', 30_000]]);
    expect(healthIsProblem('no-mic-access')).toBe(true);
  });

  it('engine exit → engine-error + restart; stop() silences everything', () => {
    const { w, restarts } = watch();
    w.starting();
    w.engineReady();
    w.onMic({ state: 'started' });
    w.engineGone('exit code 3221225477');
    expect(w.health).toBe('engine-error');
    expect(restarts.at(-1)![0]).toBe('engine');
    w.stopped();
    expect(w.health).toBe('off');
    w.onMic({ state: 'ended' });
    expect(w.health).toBe('off');
  });
});

// A fake sherpa-onnx: VAD and ASR results are scripted per test.
function fakeSherpa(o: { speech: () => boolean; text: () => string; keyword?: () => string | null }) {
  return {
    KeywordSpotter: class {
      createStream() {
        return { acceptWaveform() {} };
      }
      isReady() {
        return !!o.keyword?.();
      }
      decode() {}
      getResult() {
        const k = o.keyword?.();
        o.keyword = () => null;
        return { keyword: k ?? '' };
      }
      reset() {}
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
      decode() {}
      getResult() {
        return { text: o.text() };
      }
    },
  };
}

function pipeline(o: Parameters<typeof fakeSherpa>[0]) {
  const asrDir = path.join(tmp, 'asr');
  fs.mkdirSync(asrDir, { recursive: true });
  fs.writeFileSync(path.join(asrDir, 'model.int8.onnx'), '');
  fs.mkdirSync(path.join(tmp, 'kws'), { recursive: true });
  fs.copyFileSync(path.resolve('resources/models/kws/scores.json'), path.join(tmp, 'kws', 'scores.json'));
  const events: PipelineEvent[] = [];
  const p = new VoicePipeline(fakeSherpa(o), { modelsDir: tmp, asrDir, sensitivity: 0.5, workDir: path.join(tmp, 'voice') }, (e) => events.push(e));
  const feed = (frames: number) => p.accept(new Float32Array(FRAME * frames));
  return { p, events, feed };
}

describe('voice pipeline fixes (soak-test findings)', () => {
  it('push-to-talk that hears nothing is rejected, not an empty utterance (no empty panel)', () => {
    const { p, events, feed } = pipeline({ speech: () => false, text: () => '' });
    feed(10);
    p.beginManualCapture();
    feed(30);
    p.endManualCapture();
    expect(events.some((e) => e.type === 'utterance')).toBe(false);
    expect(events.find((e) => e.type === 'rejected')).toMatchObject({ reason: 'nothing heard (push-to-talk)' });
  });

  it('push-to-talk with speech gives a manual utterance', () => {
    const { p, events, feed } = pipeline({ speech: () => true, text: () => 'what time is it' });
    p.beginManualCapture();
    feed(30);
    p.endManualCapture();
    expect(events.find((e) => e.type === 'utterance')).toMatchObject({ request: 'what time is it', manual: true });
  });

  it('arming the follow-up during a push-to-talk capture does not cut it short', () => {
    const { p, events, feed } = pipeline({ speech: () => true, text: () => 'open the calculator please' });
    p.beginManualCapture();
    feed(10);
    p.armFollowUp(8000); // the previous reply finished speaking mid-capture
    feed(20);
    expect(events.some((e) => e.type === 'followup')).toBe(false);
    p.endManualCapture();
    expect(events.find((e) => e.type === 'utterance')).toMatchObject({ request: 'open the calculator please' });
  });
});

describe('backend that goes silent mid-turn is given up on', async () => {
  const { ConversationController } = await import('../src/main/conversation');
  it('no event for the idle limit → error shown, provider reset, not busy any more', async () => {
    vi.useFakeTimers();
    try {
      const ui: any[] = [];
      let resets = 0;
      const provider = {
        reset: () => resets++,
        send: () => ({
          [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined), return: async () => ({ done: true, value: undefined }) }),
        }),
      };
      const settings = { provider: 'claude', voice: { speakReplies: 'never', followUpSeconds: 0, wakeWord: 'cadabra' }, displayName: '' };
      const h: any = {
        settings: () => settings,
        now: () => Date.now(),
        provider: () => provider,
        model: () => 'm',
        gate: { beginRun() {} },
        buildTurn: () => ({ run: {}, request: {} }),
        setRun() {},
        afterRun() {},
        hasPendingConfirm: () => false,
        resolveConfirm() {},
        localLaunch: async () => null,
        localIntent: async () => null,
        voice: { stopSpeaking() {}, armFollowUp() {}, speak: async () => {}, enabled: () => false },
        ui: { busy: (b: boolean) => ui.push(['busy', b]), event: (e: any) => ui.push(e), notice() {}, userEcho() {}, panelVisible: () => true },
      };
      const c = new ConversationController(h);
      c.idleMs = 5000;
      const done = c.send('do something complicated', 'typed');
      await vi.advanceTimersByTimeAsync(6000);
      await done;
      expect(ui.some((e) => e?.type === 'error' && /No reply from the AI/.test(e.message))).toBe(true);
      expect(resets).toBe(1);
      expect(c.busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
