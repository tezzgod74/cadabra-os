import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { CadabraApp } from './app';
import { runDemoStage } from './demo-stage';
import { runSelfTest } from './selftest';
import { runVoiceMeasure, runVoiceSoak, runVoiceTest } from './voicetest';
import { runAppTest } from './apptest';
import { runGreetTest } from './greettest';
import { runTypeTest } from './typetest';
import { runTtsTest } from './ttstest';
import { runLiveReadiness } from './e2e-live';

const args = process.argv.slice(1);
const flag = (f: string) => args.includes(f);

app.setAppUserModelId('ai.cadabra.os');
// Demo / self-test runs must never touch the real user's settings or secrets.
const voiceWav =
  args.find((a) => a.startsWith('--voicetest='))?.slice('--voicetest='.length) ??
  args.find((a) => a.startsWith('--voicesoak='))?.slice('--voicesoak='.length) ??
  args.find((a) => a.startsWith('--voicemeasure='))?.slice('--voicemeasure='.length);
const voiceMeasure = args.some((a) => a.startsWith('--voicemeasure='));
const voiceSoak = args.some((a) => a.startsWith('--voicesoak='));
// Live-readiness harness: runs on its own data folder "Cadabra OS (e2e)" (AUTH-2); only the Codex/Gemini login homes are shared.
const e2eProvider = args.find((a) => a.startsWith('--e2e-live='))?.slice('--e2e-live='.length);
// AUTH-2: the harness never touches the user's real settings. It runs on its own
// data folder; only the Codex/Gemini private homes (their logins) are shared.
const realUserData = app.getPath('userData');
if (e2eProvider) app.setPath('userData', path.join(app.getPath('appData'), 'Cadabra OS (e2e)'));
if (voiceWav) {
  // Chromium fake capture device: feeds a WAV instead of the microphone.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', voiceWav);
}
const testMode = flag('--typetest') || flag('--greettest') || flag('--demo-live') || flag('--selftest') || flag('--apptest') || flag('--ttstest') || !!voiceWav || flag('--demo');
if (testMode) app.setPath('userData', path.join(app.getPath('appData'), 'Cadabra OS (demo)'));
// Test and demo modes must NEVER open the real microphone (found in round 4.5:
// --apptest started voice from the demo settings). Chromium's fake device
// (a WAV, or a synthetic tone) stands in for it.
// REVIEW-5 V5-3: the e2e harness too (it sends voice turns, so replies are spoken).
if ((testMode || e2eProvider) && !voiceWav) app.commandLine.appendSwitch('use-fake-device-for-media-stream');
// …and never make a sound on the real speakers (found in round 5: the voice
// soak's spoken replies went to the default output). Timing is unchanged.
if (testMode || e2eProvider) {
  process.env.CADABRA_MUTE_TTS = '1';
  // Wake-word tuning env vars only count in test modes (REVIEW-5 V5-5 nit).
  process.env.CADABRA_TEST_MODE = '1';
}
// Keep animations smooth even when windows are occluded / hidden.
app.commandLine.appendSwitch('disable-renderer-backgrounding');

if (flag('--demo')) {
  // Visual preview stage: every state rendered in one window, no hook, no backend.
  app.whenReady().then(() => runDemoStage({ screenshots: flag('--screenshots') }));
  app.on('window-all-closed', () => app.quit());
} else {
  if (!app.requestSingleInstanceLock()) {
    if (e2eProvider) console.log('E2E SKIPPED: Cadabra is already running. Quit it from the tray, then run the harness again.');
    app.quit();
  } else {
    let cadabra: CadabraApp | null = null;
    app.on('second-instance', () => void cadabra?.openAtCursor());
    app.whenReady().then(async () => {
      const selftest = flag('--selftest');
      cadabra = new CadabraApp({ greetTest: flag('--greettest'), demoLive: flag('--typetest') || flag('--greettest') || flag('--demo-live') || selftest || !!voiceWav || flag('--apptest') || flag('--ttstest'), hidden: flag('--hidden') || !!e2eProvider, selftest: selftest || !!voiceWav, e2e: !!e2eProvider, providerHomes: e2eProvider ? realUserData : undefined });
      await cadabra.init();
      if (selftest) void runSelfTest(cadabra);
      if (voiceWav && voiceMeasure) void runVoiceMeasure(cadabra);
      else if (voiceWav && voiceSoak) void runVoiceSoak(cadabra);
      else if (voiceWav) void runVoiceTest(cadabra);
      if (flag('--apptest')) void runAppTest(cadabra);
      if (flag('--greettest')) void runGreetTest(cadabra);
      if (flag('--typetest')) void runTypeTest(cadabra);
      if (flag('--ttstest')) void runTtsTest(cadabra);
      if (e2eProvider) void runLiveReadiness(cadabra, e2eProvider);
    });
    // Tray app: stay alive with no visible windows.
    app.on('window-all-closed', () => undefined);
    let shuttingDown = false;
    app.on('before-quit', (e) => {
      if (shuttingDown || !cadabra) return;
      e.preventDefault();
      shuttingDown = true;
      void cadabra.shutdown().finally(() => {
        for (const w of BrowserWindow.getAllWindows()) w.destroy();
        app.exit(0);
      });
    });
  }
}
