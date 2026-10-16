// 0.9.11: "the Cadabra window does not show when I'm doing a demo". The new
// "Show Cadabra in screen recordings and screen sharing" setting (Settings →
// Privacy, tray "Presenting mode"): content protection on every Cadabra window
// follows it live, and Cadabra's own captures still never include Cadabra.
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CaptureVisibility, type ProtectableWindow } from '../src/main/capture-visibility';
import { HelperClient } from '../src/main/helper';
import { applyPatch, DEFAULT_SETTINGS, mergeSettings, sanitizeRendererPatch } from '../src/shared/settings';

class FakeWin implements ProtectableWindow {
  calls: boolean[] = [];
  destroyed = false;
  get protectedNow() {
    return this.calls.at(-1);
  }
  setContentProtection(on: boolean) {
    this.calls.push(on);
  }
  isDestroyed() {
    return this.destroyed;
  }
}

const noSleep = () => Promise.resolve();

describe('0.9.11 content protection follows the setting, live, on every window', () => {
  it('default (off): every window is protected as soon as it is registered', () => {
    const v = new CaptureVisibility(false, noSleep);
    const panel = new FakeWin();
    const overlay = new FakeWin();
    v.register(panel);
    v.register(overlay);
    expect(panel.protectedNow).toBe(true);
    expect(overlay.protectedNow).toBe(true);
    expect(v.visibleToRecordings).toBe(false);
  });

  it('turning it on / off applies to all windows at once (no restart), including windows created later', () => {
    const v = new CaptureVisibility(false, noSleep);
    const [panel, ov1] = [new FakeWin(), new FakeWin()];
    v.register(panel);
    v.register(ov1);
    v.setVisible(true);
    expect([panel.protectedNow, ov1.protectedNow]).toEqual([false, false]);
    const ov2 = new FakeWin(); // a display was plugged in
    v.register(ov2);
    expect(ov2.protectedNow).toBe(false);
    v.setVisible(false);
    expect([panel.protectedNow, ov1.protectedNow, ov2.protectedNow]).toEqual([true, true, true]);
  });

  it('exempt windows (self-test, offline demo panel) are never protected', () => {
    const v = new CaptureVisibility(false, noSleep);
    const demo = new FakeWin();
    v.register(demo, { exempt: true });
    expect(demo.protectedNow).toBe(false);
    v.setVisible(true);
    v.setVisible(false);
    expect(demo.calls.every((c) => c === false)).toBe(true);
  });

  it('visible to recordings: Cadabra’s own capture re-protects every window for the frame, then restores', async () => {
    const sleeps: number[] = [];
    const v = new CaptureVisibility(true, async (ms) => void sleeps.push(ms));
    const [panel, overlay] = [new FakeWin(), new FakeWin()];
    v.register(panel);
    v.register(overlay);
    expect(panel.protectedNow).toBe(false);
    let during: (boolean | undefined)[] = [];
    const r = await v.forCapture(async () => {
      during = [panel.protectedNow, overlay.protectedNow];
      return 'png';
    });
    expect(r).toBe('png');
    expect(during).toEqual([true, true]); // Cadabra is out of the captured frame
    expect(sleeps.length).toBe(1); // waits for DWM to apply it first
    expect(sleeps[0]).toBeGreaterThanOrEqual(33); // at least two frames at 60 Hz
    expect([panel.protectedNow, overlay.protectedNow]).toEqual([false, false]); // visible again for the recording
  });

  it('concurrent captures share one protect cycle; a failing capture still restores', async () => {
    const v = new CaptureVisibility(true, noSleep);
    const w = new FakeWin();
    v.register(w);
    let release!: () => void;
    const first = v.forCapture(() => new Promise<void>((r) => (release = r)));
    await Promise.resolve();
    const second = v.forCapture(async () => {
      expect(w.protectedNow).toBe(true);
    });
    await second;
    expect(w.protectedNow).toBe(true); // the first capture is still running
    release();
    await first;
    expect(w.protectedNow).toBe(false);
    await expect(v.forCapture(async () => Promise.reject(new Error('helper died')))).rejects.toThrow('helper died');
    expect(w.protectedNow).toBe(false);
  });

  it('hidden from recordings (default): captures don’t toggle anything or wait', async () => {
    const sleep = vi.fn(noSleep);
    const v = new CaptureVisibility(false, sleep);
    const w = new FakeWin();
    v.register(w);
    const before = w.calls.length;
    await v.forCapture(async () => expect(w.protectedNow).toBe(true));
    expect(w.calls.length).toBe(before);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('turning it on during a capture keeps the capture protected until it ends', async () => {
    const v = new CaptureVisibility(false, noSleep);
    const w = new FakeWin();
    v.register(w);
    await v.forCapture(async () => {
      v.setVisible(true);
      expect(w.protectedNow).toBe(true);
    });
    expect(w.protectedNow).toBe(false);
  });

  it('destroyed windows are dropped', () => {
    const v = new CaptureVisibility(false, noSleep);
    const w = new FakeWin();
    v.register(w);
    w.destroyed = true;
    v.setVisible(true);
    expect(w.calls).toEqual([true]);
  });
});

describe('0.9.11 every helper capture goes through the shield', () => {
  it('HelperClient.capture runs inside captureShield (and passes the mask through)', async () => {
    const h = new HelperClient('nonexistent.exe');
    const order: string[] = [];
    (h as any).call = vi.fn(async (method: string, p: unknown) => {
      order.push(`call:${method}:${JSON.stringify(p)}`);
      return { png: '', width: 1, height: 1, scale: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, bytes: 0 };
    });
    h.captureShield = async (fn) => {
      order.push('protect');
      try {
        return await fn();
      } finally {
        order.push('restore');
      }
    };
    await h.capture({ maxSize: 1600, mask: [{ x: 1, y: 2, width: 3, height: 4 }] });
    expect(order).toEqual(['protect', 'call:capture:{"maxSize":1600,"mask":[{"x":1,"y":2,"width":3,"height":4}]}', 'restore']);
  });

  it('nothing in src calls the helper’s capture method except through HelperClient.capture', () => {
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = `${d}/${e.name}`;
        if (e.isDirectory()) walk(f);
        else if (/\.ts$/.test(e.name) && /call(<[^>]*>)?\(\s*['"]capture['"]/.test(fs.readFileSync(f, 'utf8')) && !f.endsWith('main/helper.ts')) offenders.push(f);
      }
    };
    walk('src');
    expect(offenders).toEqual([]);
    const helper = fs.readFileSync('src/main/helper.ts', 'utf8');
    expect(helper).toMatch(/capture = \([^)]*\) => this\.captureShield\(\(\) => this\.call<Capture>\('capture', p, 20000\)\)/);
  });
});

describe('0.9.11 setting: default off, persisted, renderer may change it', () => {
  it('defaults, merge and patching', () => {
    expect(DEFAULT_SETTINGS.privacy.showInRecordings).toBe(false);
    expect(mergeSettings({}).privacy.showInRecordings).toBe(false);
    expect(mergeSettings({ privacy: { showInRecordings: true } }).privacy).toEqual({ keepHistory: 'until-cleared', showInRecordings: true });
    expect(mergeSettings({ privacy: { showInRecordings: 'yes' } }).privacy.showInRecordings).toBe(false);
    // Changing "Keep chat history" from the panel doesn't reset it (and vice versa).
    const on = applyPatch(DEFAULT_SETTINGS, { privacy: { ...DEFAULT_SETTINGS.privacy, showInRecordings: true } });
    expect(applyPatch(on, { privacy: { keepHistory: 'on-close' } as any }).privacy).toEqual({ keepHistory: 'on-close', showInRecordings: true });
    expect(sanitizeRendererPatch({ privacy: { showInRecordings: true } })).toEqual({ privacy: { showInRecordings: true } });
  });

  it('persists across a restart (settings store round trip)', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadabra-rec-'));
    try {
      const { SettingsStore } = await import('../src/main/settings-store');
      const cipher = { isEncryptionAvailable: () => false, encryptString: (t: string) => Buffer.from(t), decryptString: (b: Buffer) => b.toString() };
      const a = new SettingsStore(dir, cipher);
      const seen: boolean[] = [];
      a.onChange((s) => seen.push(s.privacy.showInRecordings)); // the app applies it live from here
      a.update({ privacy: { ...a.get().privacy, showInRecordings: true } });
      expect(seen).toEqual([true]);
      const b = new SettingsStore(dir, cipher);
      expect(b.get().privacy.showInRecordings).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('0.9.11 production wiring', () => {
  const app = fs.readFileSync('src/main/app.ts', 'utf8');
  const windows = fs.readFileSync('src/main/windows.ts', 'utf8');
  const panel = fs.readFileSync('src/renderer/panel/main.ts', 'utf8');
  const html = fs.readFileSync('src/renderer/panel/index.html', 'utf8');

  it('panel and every overlay (ghost cursor, highlights, WhatsApp pill, toasts) register with CaptureVisibility', () => {
    expect(app).toMatch(/this\.visibility = new CaptureVisibility\(this\.settings\.get\(\)\.privacy\.showInRecordings\)/);
    expect(app).toMatch(/new OverlayManager\(\(w\) => this\.visibility\.register\(w, \{ exempt: !!this\.opts\.selftest \}\)\)/);
    expect(app).toMatch(/createPanel\(\{ onCreate: \(w\) => this\.visibility\.register\(w,/);
    expect(windows).not.toMatch(/setContentProtection/); // only CaptureVisibility sets it
    expect(windows).toMatch(/this\.onCreate\(win\);/);
    expect(windows).toMatch(/opts\.onCreate\(win\);/);
    // Confirm cards are in the panel; the pill, ghost cursor and highlights are overlay messages.
    expect(app).toMatch(/overlays\.broadcast\(\{ type: 'remote-pill'/);
  });

  it('live apply on any settings change, helper shield, WhatsApp mask, tray toggle, panel badge', () => {
    expect(app).toMatch(/this\.settings\.onChange\(\(s\) => this\.applyRecordingVisibility\(s\.privacy\.showInRecordings\)\)/);
    expect(app).toMatch(/this\.helper\.captureShield = \(fn\) => this\.visibility\.forCapture\(fn\);/);
    expect(app).toMatch(/capture\(\{ maxSize: 1600, mask: this\.cadabraMask\(\) \}\)/);
    expect(app).toMatch(/screen\.dipToScreenRect\(p, p\.getBounds\(\)\)/);
    expect(app).toMatch(/label: 'Presenting mode \(show Cadabra in recordings\)',\s*type: 'checkbox',\s*checked: s\.privacy\.showInRecordings,\s*click: \(i\) => this\.settings\.update\(\{ privacy: \{ \.\.\.this\.settings\.get\(\)\.privacy, showInRecordings: i\.checked \} \}\)/);
    expect(app).toMatch(/sendPanel\(this\.panel, \{ type: 'recording-visible', on \}\)/);
    expect(app).toMatch(/did-finish-load', \(\) => sendPanel\(panel, \{ type: 'recording-visible', on: this\.visibility\.visibleToRecordings \}\)/);
    expect(panel).toMatch(/recordings: \(v\) => \(\{ privacy: \{ \.\.\.s\.privacy, showInRecordings: v \} \}\)/);
    expect(panel).toMatch(/case 'recording-visible':\s*\$\('rec-badge'\)\.hidden = !m\.on;/);
    expect(panel).toMatch(/Show \$\{nm\} in screen recordings and screen sharing/);
    expect(html).toMatch(/id="rec-badge" class="rec-badge" hidden/);
  });
});
