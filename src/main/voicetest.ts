import { app } from 'electron';
import type { CadabraApp } from './app';
import { SherpaVoiceEngine } from './voice/sherpa-engine';
import { parseIntent } from '../shared/intents';

/**
 * `--voicetest <file.wav>`: full voice path inside Electron with Chromium's
 * fake audio capture device playing a WAV (never the real microphone):
 * getUserMedia → AudioWorklet @16 kHz → MessagePort → utilityProcess
 * (sherpa-onnx KWS + VAD + Parakeet) → main.
 */
export async function runVoiceTest(c: CadabraApp) {
  const results: Record<string, unknown> = {};
  const v = c.voice;
  if (!(v instanceof SherpaVoiceEngine)) {
    console.log('VOICETEST', JSON.stringify({ error: 'sherpa engine not available' }));
    app.exit(2);
    return;
  }
  const t0 = Date.now();
  const states: string[] = [];
  v.on('state', (s: string) => states.push(`${s}@${Date.now() - t0}`));
  v.on('mic', (m: any) => {
    if (m.state === 'started') results.micStarted = { contextRate: m.contextRate, track: m.track };
    if (m.state === 'stats') results.micStats = m;
    if (m.state === 'error') results.micError = m;
  });
  v.on('debug', (m: string) => ((results.debug as string[]) ??= []).push(m.trim().slice(0, 200)));
  const done = new Promise<void>((resolve) => {
    v.on('utterance', (u: any) => {
      results.utterance = u;
      results.msToUtterance = Date.now() - t0;
      results.intent = parseIntent(u.request) ?? null;
      resolve();
    });
    setTimeout(resolve, 45_000);
  });
  v.on('error', (e: Error) => (results.error = e.message));
  if (process.env.CADABRA_SENS) c.settings.update({ voice: { ...c.settings.get().voice, sensitivity: Number(process.env.CADABRA_SENS) } });
  results.sensitivity = c.settings.get().voice.sensitivity;
  await c.applyIntent({ kind: 'voice', enabled: true });
  await done;
  results.states = states;
  await c.stopVoice();
  console.log('VOICETEST', JSON.stringify(results));
  app.quit();
}

/**
 * `--voicesoak <file.wav>` (round 4.5): reproduces the hands-on failure
 * "voice works for a while, then the wake word and push-to-talk hear nothing".
 * Chromium's fake device loops the WAV (never the real microphone). Phases:
 * wake words → settings change (push-to-talk on: engine restart) → PTT press →
 * push-to-talk off (restart again) → wake words. Mic frame counters are
 * sampled throughout so a dead capture shows up.
 */
export async function runVoiceSoak(c: CadabraApp) {
  const v = c.voice;
  if (!(v instanceof SherpaVoiceEngine)) {
    console.log('VOICESOAK', JSON.stringify({ error: 'sherpa engine not available' }));
    app.exit(2);
    return;
  }
  const t0 = Date.now();
  const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const log: string[] = [];
  const phase = { name: 'start', utterances: 0, wakes: 0 };
  const phases: Record<string, { utterances: number; wakes: number; framesStart?: number; framesEnd?: number }> = {};
  let frames = 0;
  v.on('state', (s: string) => log.push(`${at()} state ${s}`));
  v.on('mic', (m: any) => {
    if (m.state === 'stats') frames = m.frames;
    else log.push(`${at()} mic ${m.state} ${m.message ?? ''}`);
  });
  v.on('error', (e: Error) => log.push(`${at()} ERROR ${e.message}`));
  v.on('health', (h: any) => log.push(`${at()} health ${JSON.stringify(h)}`));
  v.on('utterance', (u: any) => {
    phase.utterances++;
    log.push(`${at()} utterance "${u.request}" (${u.text})`);
  });
  v.on('wake', () => phase.wakes++);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const run = async (name: string, ms: number, body?: () => Promise<void>) => {
    phase.name = name;
    phase.utterances = 0;
    phase.wakes = 0;
    const f0 = frames;
    log.push(`${at()} --- ${name}`);
    if (body) await body();
    await sleep(ms);
    phases[name] = { utterances: phase.utterances, wakes: phase.wakes, framesStart: f0, framesEnd: frames };
  };
  const setVoice = (patch: Record<string, unknown>) => {
    const before = c.settings.get();
    const after = c.settings.update({ voice: { ...before.voice, ...patch } } as any);
    c.onVoiceSettingsChanged(before, after);
  };
  c.settings.update({ voice: { ...c.settings.get().voice, pushToTalk: false } } as any);
  await run('wake words', 30_000, async () => {
    await c.applyIntent({ kind: 'voice', enabled: true });
  });
  await run('push-to-talk on (restart)', 15_000, async () => setVoice({ pushToTalk: true }));
  await run('push-to-talk press', 6_000, async () => {
    v.setPushToTalk(true);
    await sleep(4000);
    v.setPushToTalk(false);
  });
  await run('push-to-talk off (restart)', 30_000, async () => setVoice({ pushToTalk: false }));
  await run('quick double toggle', 30_000, async () => {
    setVoice({ sensitivity: 0.55 });
    await sleep(150);
    setVoice({ sensitivity: 0.5 });
  });
  await run('capture lost (ended event) → auto-recovers', 30_000, async () => v.simulateMicLoss(true));
  await run('capture lost silently (no event) → watchdog recovers', 35_000, async () => v.simulateMicLoss(false));
  const pttOk = v.setPushToTalk(true);
  v.setPushToTalk(false);
  log.push(`${at()} push-to-talk accepted while healthy: ${pttOk}`);
  await c.stopVoice();
  console.log('VOICESOAK', JSON.stringify({ phases, log }, null, 1));
  app.quit();
}

/**
 * `--voicemeasure <file.wav>` (round 5): end of the user's speech → first audio
 * of the reply, over ~60 s of looped turns (fake mic, muted output). Run with
 * CADABRA_ENDPOINT_MS=1100 CADABRA_NO_STREAM=1 for the round-4 "before" numbers.
 */
export async function runVoiceMeasure(c: CadabraApp) {
  const v = c.voice;
  if (!(v instanceof SherpaVoiceEngine)) {
    console.log('VOICEMEASURE', JSON.stringify({ error: 'sherpa engine not available' }));
    app.exit(2);
    return;
  }
  const lat: number[] = [];
  c.emit = (ev, val) => {
    if (ev === 'latency') lat.push(val as number);
  };
  c.settings.update({ provider: 'demo', voice: { ...c.settings.get().voice, pushToTalk: false, followUpSeconds: 0, speakReplies: 'always', ttsEngine: 'kokoro', ttsVoice: 'bm_george' } } as any);
  await c.applyIntent({ kind: 'voice', enabled: true });
  v.tts.prewarm('bm_george');
  await new Promise((r) => setTimeout(r, Number(process.env.CADABRA_MEASURE_MS ?? 60_000)));
  await c.stopVoice();
  const sorted = [...lat].sort((a, b) => a - b);
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  console.log('VOICEMEASURE', JSON.stringify({ samples: lat, median: med, endpointMs: process.env.CADABRA_ENDPOINT_MS ?? 'adaptive', streaming: !process.env.CADABRA_NO_STREAM }));
  app.quit();
}
