// Hidden window: microphone capture (getUserMedia + AudioWorklet) feeding the
// voice utilityProcess through a MessagePort, plus optional spoken replies.
// Audio never goes anywhere else.

const bridge = (window as any).cadabra as {
  onCommand(cb: (m: any) => void): void;
  status(m: unknown): void;
};

// The worklet runs on the audio thread: it batches 512-sample frameCount and, if
// the context isn't at 16 kHz, linearly resamples to 16 kHz.
const WORKLET = `
class CadabraMic extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.buf = new Float32Array(512); this.n = 0; this.pos = 0; this.prev = 0; }
  push(v) { this.buf[this.n++] = v; if (this.n === 512) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(512); this.n = 0; } }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.ratio === 1) { for (let i = 0; i < ch.length; i++) this.push(ch[i]); return true; }
    // linear resample to 16 kHz
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos), f = this.pos - i;
      const a = i === 0 ? this.prev : ch[i - 1], b = ch[i];
      this.push(a + (b - a) * f);
      this.pos += this.ratio;
    }
    this.pos -= ch.length; this.prev = ch[ch.length - 1];
    return true;
  }
}
registerProcessor('cadabra-mic', CadabraMic);
`;

let port: MessagePort | null = null;
let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let frameCount = 0;
/** Peak absolute sample in the last stats interval (0 = digital silence). */
let peak = 0;
/** Serialises start/stop so overlapping commands can't leave a dead or orphaned capture. */
let chain: Promise<void> = Promise.resolve();
let wanted: { deviceId?: string; raw: boolean } | null = null;
let generation = 0;

window.addEventListener('message', (e) => {
  if (e.data?.cadabraVoicePort && e.ports[0]) {
    port = e.ports[0];
    port.start();
  }
});

function queue(fn: () => Promise<void>) {
  chain = chain.then(fn, fn);
  return chain;
}

async function openCapture(deviceId: string | undefined, raw: boolean) {
  await closeCapture();
  const gen = ++generation;
  try {
    // REVIEW-5 D2: a driver can hang getUserMedia forever; give up after 8 s
    // (main then restarts, eventually with a fresh mic window).
    const gum = navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: !raw, noiseSuppression: !raw, autoGainControl: !raw, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const s = await Promise.race([
      gum,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          timedOut = true;
          // Only a stream that arrives AFTER we gave up is stopped.
          void gum.then((late) => late.getTracks().forEach((t) => t.stop())).catch(() => undefined);
          rej(Object.assign(new Error('the microphone did not open within 8 s'), { name: 'TimeoutError' }));
        }, 8000);
      }),
    ]).finally(() => clearTimeout(timer));
    if (timedOut) return;
    if (gen !== generation || !wanted) {
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = s;
    const c = new AudioContext({ sampleRate: 16000 });
    ctx = c;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await c.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(c, 'cadabra-mic');
    c.createMediaStreamSource(s).connect(node);
    node.port.onmessage = (ev) => {
      frameCount++;
      const f = ev.data as Float32Array;
      for (let i = 0; i < f.length; i += 16) {
        const a = Math.abs(f[i]);
        if (a > peak) peak = a;
      }
      // No transfer list: Electron's MessagePortMain (utilityProcess side)
      // delivers transferred ArrayBuffers as null (measured, Electron 44).
      port?.postMessage(f);
    };
    const track = s.getAudioTracks()[0];
    // Round 4.5: a capture can end without any error (device unplugged or
    // invalidated, a Bluetooth headset switching profile, the driver changing
    // its sample rate). Report it; main restarts the capture.
    track?.addEventListener('ended', () => {
      if (stream === s) bridge.status({ type: 'mic', state: 'ended', track: track.label });
    });
    track?.addEventListener('mute', () => stream === s && bridge.status({ type: 'mic', state: 'muted', track: track.label }));
    track?.addEventListener('unmute', () => stream === s && bridge.status({ type: 'mic', state: 'unmuted', track: track.label }));
    c.onstatechange = () => ctx === c && bridge.status({ type: 'mic', state: 'context', context: c.state });
    if (c.state === 'suspended') await c.resume().catch(() => undefined);
    bridge.status({ type: 'mic', state: 'started', defaultInput: await defaultInputLabel(), contextRate: c.sampleRate, context: c.state, track: track?.label ?? '', settings: track?.getSettings?.() ? { sampleRate: track.getSettings().sampleRate, channelCount: track.getSettings().channelCount } : undefined });
  } catch (err) {
    bridge.status({ type: 'mic', state: 'error', message: (err as Error).message, name: (err as Error).name });
  }
}

async function closeCapture() {
  generation++;
  const s = stream;
  const c = ctx;
  stream = null;
  ctx = null;
  s?.getTracks().forEach((t) => t.stop());
  if (c) await c.close().catch(() => undefined);
}

/** Round 7: a chosen microphone by its label (ids aren't shown to the user). '' = Windows default. */
async function deviceIdFor(label?: string): Promise<string | undefined> {
  if (!label) return undefined;
  try {
    const ds = await navigator.mediaDevices.enumerateDevices();
    const d = ds.find((x) => x.kind === 'audioinput' && x.deviceId !== 'default' && x.deviceId !== 'communications' && x.label === label);
    if (!d) bridge.status({ type: 'mic', state: 'device-missing', track: label });
    return d?.deviceId;
  } catch {
    return undefined;
  }
}

function start(deviceId?: string, raw = false) {
  wanted = { deviceId, raw };
  return queue(() => openCapture(deviceId, raw));
}

function stop() {
  wanted = null;
  return queue(closeCapture);
}

/** The Windows default input's label ("Default - Microphone (…)" → "Microphone (…)"). */
async function defaultInputLabel(): Promise<string> {
  try {
    const ds = await navigator.mediaDevices.enumerateDevices();
    const d = ds.find((x) => x.kind === 'audioinput' && x.deviceId === 'default');
    return (d?.label ?? '').replace(/^Default - /, '');
  } catch {
    return '';
  }
}

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  void navigator.mediaDevices.enumerateDevices().then(async (ds) => {
    const inputs = ds.filter((d) => d.kind === 'audioinput').map((d) => d.label || d.deviceId.slice(0, 8));
    bridge.status({ type: 'mic', state: 'devicechange', inputs, defaultInput: await defaultInputLabel(), track: stream?.getAudioTracks()[0]?.label ?? '', live: stream?.getAudioTracks()[0]?.readyState === 'live' });
  });
});

/** Test/demo modes: synthesis and timing as usual, but silent (no real speakers). */
let muted = false;

function speak(text: string) {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (muted) u.volume = 0;
  u.rate = 1.04;
  const voices = speechSynthesis.getVoices();
  const pick = voices.find((v) => /aria|jenny|zira|natural/i.test(v.name) && v.lang.startsWith('en')) ?? voices.find((v) => v.lang.startsWith('en'));
  if (pick) u.voice = pick;
  u.onstart = () => bridge.status({ type: 'tts', state: 'start' });
  u.onend = () => bridge.status({ type: 'tts', state: 'end' });
  u.onerror = () => bridge.status({ type: 'tts', state: 'end' });
  speechSynthesis.speak(u);
}

// --------------------------------------------- Windows voice, streamed --
// Round 6 (REVIEW-5 V5-1): sentences are queued as they arrive and the whole
// queue stops instantly on "stop-speaking"; a newer generation ignores events
// from cancelled utterances.
let sayGen = 0;
let sayPending = 0;
let sayFinished = false;
let sayStarted = false;

function windowsVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => /aria|jenny|zira|natural/i.test(v.name) && v.lang.startsWith('en')) ?? voices.find((v) => v.lang.startsWith('en'));
}

function sayEndIfDone() {
  if (sayFinished && sayPending === 0) {
    sayFinished = false;
    sayStarted = false;
    bridge.status({ type: 'tts', state: 'end' });
  }
}

function sayBegin() {
  speechSynthesis.cancel();
  sayGen++;
  sayPending = 0;
  sayFinished = false;
  sayStarted = false;
}

function say(text: string) {
  const g = sayGen;
  const u = new SpeechSynthesisUtterance(text);
  if (muted) u.volume = 0;
  u.rate = 1.04;
  const pick = windowsVoice();
  if (pick) u.voice = pick;
  u.onstart = () => {
    if (g === sayGen && !sayStarted) {
      sayStarted = true;
      bridge.status({ type: 'tts', state: 'start' });
    }
  };
  const done = () => {
    if (g !== sayGen) return;
    sayPending = Math.max(0, sayPending - 1);
    sayEndIfDone();
  };
  u.onend = done;
  u.onerror = done;
  sayPending++;
  speechSynthesis.speak(u);
}

// ------------------------------------------------- natural-voice player --
// Kokoro audio arrives sentence by sentence; each chunk is scheduled right
// after the previous one so speech is continuous. Stops instantly on
// "stop-speaking" (Esc, "stop", the wake word).
let playCtx: AudioContext | null = null;
let playing: AudioBufferSourceNode[] = [];
let nextAt = 0;
let started = false;
let finished = false;
let pending = 0;

function resetPlayer() {
  for (const s of playing) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  playing = [];
  nextAt = 0;
  pending = 0;
}

function endIfDone() {
  if (finished && pending === 0 && started) {
    started = false;
    bridge.status({ type: 'tts', state: 'end' });
  }
}

// 0.9.6: announcements: optional output device (by label), louder playback, chime.
let ann: { on: boolean; boost: boolean } = { on: false, boost: false };
let annGain: GainNode | null = null;

function outNode(c: AudioContext): AudioNode {
  if (!ann.on || !ann.boost) return c.destination;
  if (!annGain || annGain.context !== c) {
    // About +5 dB, with a compressor so loud words don't clip.
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 6;
    annGain = c.createGain();
    annGain.gain.value = 1.8;
    annGain.connect(comp).connect(c.destination);
  }
  return annGain;
}

async function outputs(): Promise<MediaDeviceInfo[]> {
  const ds = await navigator.mediaDevices.enumerateDevices();
  return ds.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
}

async function setSink(label: string): Promise<boolean> {
  playCtx ??= new AudioContext();
  const c = playCtx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (!c.setSinkId) return !label;
  try {
    const id = label ? (await outputs()).find((d) => d.label === label)?.deviceId : '';
    if (label && !id) return false;
    await c.setSinkId(id ?? '');
    return true;
  } catch {
    return false;
  }
}

function chime(): Promise<void> {
  playCtx ??= new AudioContext();
  const c = playCtx;
  if (c.state === 'suspended') void c.resume();
  // Two soft bell tones (E6 then A5), about 0.7 s.
  const t = c.currentTime + 0.03;
  for (const [f, at] of [
    [1318.5, 0],
    [880, 0.22],
  ] as const) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t + at);
    g.gain.linearRampToValueAtTime(muted ? 0 : 0.18, t + at + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.45);
    o.connect(g).connect(outNode(c));
    o.start(t + at);
    o.stop(t + at + 0.5);
  }
  return new Promise((r) => setTimeout(r, 800));
}

function playChunk(samples: Float32Array, sampleRate: number) {
  playCtx ??= new AudioContext();
  if (playCtx.state === 'suspended') void playCtx.resume();
  const buf = playCtx.createBuffer(1, samples.length, sampleRate);
  buf.copyToChannel(new Float32Array(samples), 0);
  const src = playCtx.createBufferSource();
  src.buffer = buf;
  if (muted) {
    const g = playCtx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(playCtx.destination);
  } else src.connect(outNode(playCtx));
  const at = Math.max(playCtx.currentTime + 0.02, nextAt);
  src.start(at);
  nextAt = at + buf.duration;
  playing.push(src);
  pending++;
  if (!started) {
    started = true;
    bridge.status({ type: 'tts', state: 'start' });
  }
  src.onended = () => {
    pending--;
    playing = playing.filter((p) => p !== src);
    endIfDone();
  };
}

setInterval(() => {
  if (ctx || wanted) {
    const t = stream?.getAudioTracks()[0];
    bridge.status({ type: 'mic', state: 'stats', frames: frameCount, peak: Math.round(peak * 1000) / 1000, contextRate: ctx?.sampleRate, context: ctx?.state ?? 'none', track: t?.readyState ?? 'none', wanted: !!wanted });
  }
  peak = 0;
}, 2000);

/**
 * Round 12: decode a WhatsApp voice note (Ogg/Opus, or any format Chromium
 * decodes) to 16 kHz mono PCM for the local speech recogniser. Nothing is
 * played; the bytes never leave the PC.
 */
async function decodeTo16k(id: number, bytes: Uint8Array) {
  try {
    const tmp = new OfflineAudioContext(1, 1, 16000);
    const buf = await tmp.decodeAudioData(bytes.slice().buffer);
    const frames = Math.max(1, Math.ceil(buf.duration * 16000));
    const off = new OfflineAudioContext(1, frames, 16000);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    bridge.status({ type: 'decoded', id, samples: out.getChannelData(0) });
  } catch (e) {
    bridge.status({ type: 'decoded', id, error: (e as Error).name || 'decode failed' });
  }
}

bridge.onCommand((m) => {
  if (m.type === 'decode') {
    void decodeTo16k(m.id, m.bytes);
    return;
  }
  if (m.type === 'config') muted = !!m.mute;
  else if (m.type === 'start') void deviceIdFor(m.label).then((id) => start(id ?? m.deviceId, !!m.raw));
  else if (m.type === 'list-devices') {
    void navigator.mediaDevices.enumerateDevices().then(async (ds) =>
      bridge.status({
        type: 'devices',
        inputs: ds.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => d.label).filter(Boolean),
        defaultInput: await defaultInputLabel(),
      }),
    );
  }
  else if (m.type === 'simulate-loss') {
    // Soak test only: what Windows did on the user's PC (the capture stops).
    const t = stream?.getAudioTracks()[0];
    t?.stop();
    if (m.withEvent) t?.dispatchEvent(new Event('ended'));
  } else if (m.type === 'restart') {
    if (wanted) void start(wanted.deviceId, wanted.raw);
  } else if (m.type === 'stop') void stop().then(() => bridge.status({ type: 'mic', state: 'stopped' }));
  else if (m.type === 'speak') speak(m.text);
  else if (m.type === 'ann-config') {
    ann = { on: !!m.on, boost: !!m.boost };
    // Route to the chosen device while announcing; back to the default after.
    void setSink(m.on ? String(m.device ?? '') : '').then((ok) => {
      if (m.on) bridge.status({ type: 'ann-ready', ok });
    });
  } else if (m.type === 'ann-chime') void chime().then(() => bridge.status({ type: 'ann-chime-done' }));
  else if (m.type === 'list-outputs') void outputs().then((os) => bridge.status({ type: 'outputs', outputs: os.map((d) => d.label).filter(Boolean) }));
  else if (m.type === 'say-begin') sayBegin();
  else if (m.type === 'say') say(m.text);
  else if (m.type === 'say-end') {
    sayFinished = true;
    sayEndIfDone();
  } else if (m.type === 'stop-speaking') {
    speechSynthesis.cancel();
    const wasSaying = sayStarted;
    sayGen++;
    sayPending = 0;
    sayFinished = false;
    sayStarted = false;
    if (wasSaying) bridge.status({ type: 'tts', state: 'end' });
    const was = started;
    resetPlayer();
    finished = true;
    if (was) {
      started = false;
      bridge.status({ type: 'tts', state: 'end' });
    }
  } else if (m.type === 'tts-begin') {
    resetPlayer();
    started = false;
    finished = false;
  } else if (m.type === 'tts-chunk') {
    playChunk(m.samples, m.sampleRate);
    if (m.last) finished = true;
  } else if (m.type === 'tts-done') {
    finished = true;
    if (!started) bridge.status({ type: 'tts', state: 'end' });
    else endIfDone();
  }
});
bridge.status({ type: 'ready' });
export {};
