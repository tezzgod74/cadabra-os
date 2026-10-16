import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { load } from './windows';

export const DEMO_STATES = [
  'summon-ripple',
  'window-scan',
  'panel-idle',
  'panel-thinking',
  'panel-streaming',
  'panel-answer',
  'highlight-rings',
  'ghost-moving',
  'ghost-click',
  'confirm',
  'model-picker',
  'voice-listening',
  'settings',
  'dismiss',
  'app-choices',
  'app-launch',
  'shortcut-recorder',
  'onboarding-welcome',
  'onboarding-name',
  'onboarding-backend',
  'onboarding-voice',
  'onboarding-done',
  'settings-accounts',
  'sign-in-gemini',
  'setup-card',
  'acting-hud',
  'onboarding-claude',
  'claude-install-consent',
  'claude-signed-in',
  'settings-voice',
  'onboarding-assistant',
  'voice-status-ok',
  'voice-status-reconnecting',
  'voice-status-blocked',
  'voice-ptt-not-working',
  'settings-web',
  'voice-status-headset',
  'settings-email',
  'settings-greetings',
  'claude-install-progress',
  'claude-install-manual',
  'claude-connect',
  'claude-test-ok',
  'settings-skills',
  'settings-announcements',
  'settings-privacy',
] as const;

/**
 * `npm run demo` — a single window that composes a fake desktop with the real
 * panel and overlay renderers (in iframes) and steps through every visual
 * state. `--screenshots` captures each state to docs/screenshots/.
 */
export async function runDemoStage(opts: { screenshots: boolean }) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    show: true,
    resizable: !opts.screenshots,
    backgroundColor: '#0b0a1a',
    title: 'Cadabra OS — visual preview',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await load(win, 'demo', opts.screenshots ? { capture: '1' } : {});
  if (!opts.screenshots) return;

  const out = path.join(app.getAppPath(), 'docs', 'screenshots');
  fs.mkdirSync(out, { recursive: true });
  // Wait for the iframes to boot.
  await win.webContents.executeJavaScript('window.demoReady');
  let i = 1;
  const only = process.env.CADABRA_DEMO_ONLY?.split(',');
  for (const state of DEMO_STATES) {
    if (only && !only.includes(state)) {
      i++;
      continue;
    }
    await win.webContents.executeJavaScript(`window.demo.show(${JSON.stringify(state)})`);
    await new Promise((r) => setTimeout(r, 120));
    if (process.env.CADABRA_DEMO_DEBUG) console.log(state, await win.webContents.executeJavaScript('getComputedStyle(document.getElementById("panel")).opacity'));
    const img = await win.webContents.capturePage();
    const file = path.join(out, `${String(i).padStart(2, '0')}-${state}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log('saved', file);
    i++;
  }
  if (only && !only.includes('reduced-motion')) {
    app.quit();
    return;
  }
  // Reduced-motion variant of the summon (no ripple, instant panel).
  await win.webContents.executeJavaScript(`window.demo.show('panel-answer', { reducedMotion: true })`);
  await new Promise((r) => setTimeout(r, 120));
  fs.writeFileSync(path.join(out, `${String(i).padStart(2, '0')}-reduced-motion.png`), (await win.webContents.capturePage()).toPNG());
  app.quit();
}
