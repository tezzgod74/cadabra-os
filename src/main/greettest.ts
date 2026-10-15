// Round 10: `--greettest` measures the greeting timeline (event → decision →
// first audio) for unlock and return-after-away. Test mode: Chromium's fake
// microphone, speech muted (CADABRA_MUTE_TTS), the demo data folder; the
// session events are simulated (LockWorkStation is never called).
import { app } from 'electron';
import type { CadabraApp } from './app';
import { SherpaVoiceEngine } from './voice/sherpa-engine';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runGreetTest(c: CadabraApp) {
  const out: Record<string, unknown> = {};
  const notes: string[] = [];
  const v = c.voice;
  if (!(v instanceof SherpaVoiceEngine)) {
    console.log('GREETTEST', JSON.stringify({ error: 'sherpa engine not available' }));
    app.exit(2);
    return;
  }
  c.settings.update({ greetings: { ...c.settings.get().greetings, enabled: true, quietStart: '', quietEnd: '' }, voice: { ...c.settings.get().voice, speakReplies: 'voice', enabled: true } } as any);
  await c.applyIntent({ kind: 'voice', enabled: true });
  for (let i = 0; i < 40 && v.health !== 'ok'; i++) await sleep(500);
  notes.push(`voice health ${v.health}; natural voice ${v.tts.installed ? 'installed' : 'not installed (Windows voice)'}`);
  // Warm the speech model once, as a running Cadabra would have it.
  await v.speakAndWait('Ready.').catch(() => undefined);

  const g: any = c.greeter;
  const d = g.d;
  // Record when the greeter decides to speak; report (never bypass) suppression.
  let decidedAt: number;
  const speak0 = d.speak;
  d.speak = (t: string) => {
    decidedAt = Date.now();
    return speak0(t);
  };
  const log0 = d.log;
  d.log = (m: string) => {
    notes.push(m.replace(/\(([^)]*\.exe[^)]*)\)/, '(app)'));
    log0(m);
  };
  if (process.env.CADABRA_GREETTEST_FORCE === '1') {
    // Only for measuring on a PC where something holds the mic / Focus is on.
    // The real checks still run (their time counts); only their verdict is overridden.
    const p0 = d.presence;
    const m0 = d.micUsers;
    d.presence = async () => (await p0().catch(() => null), { notificationState: 'accepts-notifications', speakerMuted: false });
    d.micUsers = async () => (await m0().catch(() => []), []);
    notes.push('suppression verdicts overridden for timing (CADABRA_GREETTEST_FORCE=1); the checks still run');
  }
  let firstAudio = 0;
  v.on('tts', (s: string) => {
    if (s === 'start' && !firstAudio) firstAudio = Date.now();
  });
  const waitAudio = async (ms: number) => {
    const t = Date.now();
    while (!firstAudio && Date.now() - t < ms) await sleep(10);
  };

  // ---- Unlock
  await (c as any).onSessionEvent('lock');
  await sleep(5000); // locked for a while (pre-render, if any, happens here)
  g.lastGreetAt = -Infinity;
  firstAudio = 0;
  decidedAt = 0;
  const tU = Date.now();
  void (c as any).onSessionEvent('unlock');
  await waitAudio(15_000);
  out.unlock = { decisionMs: decidedAt ? decidedAt - tU : null, firstAudioMs: firstAudio ? firstAudio - tU : null };
  await sleep(9000);

  // ---- Return after being away
  // (The harness reports the first input itself; no idle polling meanwhile.)
  (c as any).armActivity = async () => undefined;
  g.lastGreetAt = -Infinity;
  g.tick(25 * 60_000); // away (≥ 20 min idle)
  await sleep(5000);
  firstAudio = 0;
  decidedAt = 0;
  const tR = Date.now();
  if (typeof (c as any).onInputActivity === 'function') (c as any).onInputActivity('test');
  else void g.tick(500); // round 9: what the next 30 s poll would do (plus 0–30 s of waiting for it)
  await waitAudio(15_000);
  out.return = { decisionMs: decidedAt ? decidedAt - tR : null, firstAudioMs: firstAudio ? firstAudio - tR : null };
  await sleep(6000);

  // ---- Round 10.5: the banter window vs. a video. Utterances are injected
  // as the voice pipeline would report them (no real audio, nothing spoken).
  const A: any = c;
  const panelOpens = () => A.panelVisible as boolean;
  const greetAndWait = async () => {
    g.lastGreetAt = -Infinity;
    firstAudio = 0;
    await A.onSessionEvent('lock');
    await sleep(1500);
    void A.onSessionEvent('unlock');
    for (let i = 0; i < 300 && !(A.greetWindowUntil > Date.now()); i++) await sleep(20);
    return A.greetWindowUntil > Date.now();
  };
  const utter = (request: string, audioMs: number, lagMs = 200) => {
    A.followArmedAt = Date.now() - audioMs - lagMs - 50;
    return A.onVoice({ text: request, request, audioMs, asrMs: 50, followUp: true, silenceMs: 700 });
  };
  const banter: Record<string, unknown> = {};
  // This PC may really be playing audio; phases a) and b) are about speech in the window.
  const realPlaying = A.media.playing.bind(A.media);
  banter.mediaReallyPlaying = realPlaying() ?? 'none';
  A.media.playing = () => null;
  // a) TV speech in the window (long, or starting late): ignored silently.
  banter.windowOpened = await greetAndWait();
  firstAudio = 0;
  await utter('and in other news tonight the senator said the vote on the new budget will come next week', 6500);
  await sleep(800);
  banter.tvSpeechAnswered = !!firstAudio || panelOpens();
  // b) the user's banter right away: a comeback.
  await greetAndWait();
  firstAudio = 0;
  await utter('haha very funny', 900);
  await sleep(1500);
  banter.userBanterAnswered = !!firstAudio;
  // c) a video playing (fake helper verdict): the greeting plays, no window opens.
  await sleep(4000);
  A.media.playing = () => 'chrome.exe';
  g.lastGreetAt = -Infinity;
  await A.onSessionEvent('lock');
  await sleep(1500);
  firstAudio = 0;
  void A.onSessionEvent('unlock');
  await waitAudio(5000);
  await sleep(4000);
  banter.greetedWithMedia = !!firstAudio;
  banter.windowOpenedWithMedia = A.greetWindowUntil > Date.now() - 3000;
  out.banter = banter;
  await c.stopVoice();
  console.log('GREETTEST', JSON.stringify({ ...out, notes }, null, 1));
  app.exit(0);
}
