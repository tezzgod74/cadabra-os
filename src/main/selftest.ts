import { app, BrowserWindow, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { CadabraApp } from './app';
import { load } from './windows';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `npm run selftest` — drives the REAL panel + overlay windows (acrylic,
 * transparent overlays, native helper) over a backdrop window that Cadabra
 * owns (a mock desktop), with the offline demo backend, then screenshots the
 * region through the native helper. No input is injected anywhere.
 */
export async function runSelfTest(c: CadabraApp) {
  const out = path.join(app.getAppPath(), 'docs', 'screenshots');
  fs.mkdirSync(out, { recursive: true });
  const results: Record<string, unknown> = {};
  const W = 1280;
  const H = 800;
  const d = screen.getPrimaryDisplay();
  const bx = Math.round(d.workArea.x + (d.workArea.width - W) / 2);
  const by = Math.round(d.workArea.y + (d.workArea.height - H) / 2);
  const backdrop = new BrowserWindow({
    x: bx,
    y: by,
    width: W,
    height: H,
    frame: false,
    show: false,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  backdrop.setAlwaysOnTop(true, 'floating');
  await load(backdrop, 'demo', { capture: '1', bare: '1' });
  backdrop.showInactive();
  await sleep(700);

  const physRect = screen.dipToScreenRect(null, { x: bx, y: by, width: W, height: H });
  const shot = async (name: string) => {
    try {
      const cap = await c.helper!.capture({ rect: physRect, maxSize: 1600 });
      fs.writeFileSync(path.join(out, name), Buffer.from(cap.png, 'base64'));
      return true;
    } catch (e) {
      results[`${name}-error`] = (e as Error).message;
      return false;
    }
  };

  results.helperRunning = !!c.helper?.running;
  try {
    const hwnd = Number(c.panel!.getNativeWindowHandle().readBigUInt64LE(0));
    results.styleWindow = await c.helper!.call('style_window', { hwnd, border: 'none', round: true });
  } catch (e) {
    results.styleWindow = (e as Error).message;
  }
  results.displays = screen.getAllDisplays().map((x) => ({ bounds: x.bounds, scale: x.scaleFactor }));
  const t0 = Date.now();
  await c.showPanelAt(screen.dipToScreenPoint({ x: bx + 560, y: by + 150 }), null);
  results.summonToVisibleMs = Date.now() - t0;
  await shot('live-01-summon.png');
  await sleep(1400);
  results.panelVisible = c.panel?.isVisible();
  results.panelBounds = c.panel?.getBounds();
  results.panelFocused = c.panel?.isFocused();
  await shot('live-02-panel-acrylic.png');
  void c.send('show me how', 'typed');
  await sleep(1500);
  await shot('live-03-ghost.png');
  await sleep(3200);
  await shot('live-04-answer.png');
  c.dismiss();
  await sleep(500);
  results.panelHiddenAfterDismiss = !c.panel?.isVisible();

  // Keyboard summon through the real helper hook: our own backdrop window is
  // foreground; the hook accepts our injected Ctrl+` only in this test mode.
  try {
    backdrop.setFocusable(true);
    backdrop.focus();
    await c.helper!.foreground(Number(backdrop.getNativeWindowHandle().readBigUInt64LE(0)));
    await c.helper!.call('set_binding', { kind: 'key', vk: 0xc0, ctrl: true, alt: false, shift: false, win: false, anyShift: true, allowInjected: true });
    await c.helper!.call('install_hooks');
    await sleep(300);
    await c.helper!.setHookEnabled(true);
    let summons = 0;
    c.helper!.on('summon', () => summons++);
    c.helper!.on('hook', (m: unknown) => ((results.hookEvents as unknown[]) ??= []).push(m));
    results.bindingStatus = await c.helper!.call('binding_status');
    await sleep(200);
    await c.helper!.pressKeys('ctrl+`');
    await sleep(900);
    results.keySummonOpened = !!c.panel?.isVisible();
    results.summonEvents = summons;
    await shot('live-05-key-summon.png');
    await c.helper!.pressKeys('ctrl+`');
    await sleep(700);
    results.keySummonToggledClosed = !c.panel?.isVisible();
    results.summonEventsAfterToggle = summons;
  } catch (e) {
    results.keySummonError = (e as Error).message;
  } finally {
    await c.applyBinding(); // restore the normal binding (injected input ignored again)
  }
  backdrop.destroy();
  fs.writeFileSync(path.join(out, 'selftest.json'), JSON.stringify(results, null, 2));
  console.log('SELFTEST', JSON.stringify(results));
  app.quit();
}
