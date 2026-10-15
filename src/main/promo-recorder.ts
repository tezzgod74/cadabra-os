// `npm run demo:video` (scripts/record-demo.ts) → `electron . --demo --promo=<dir>`.
// Records the staged demo desktop (synthetic data only: the fake mail app,
// "Alex", the demo backend) from an OFFSCREEN window: no real desktop capture,
// no input injection, no microphone. Frames are taken from Electron's offscreen
// renderer and written at a constant 30 fps (wall clock) straight into ffmpeg.
// The page's promo timeline returns cue times for the audio track.

import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { load } from './windows';

export interface PromoOptions {
  /** Output folder (video-only mp4 + cues.json). */
  out: string;
  ffmpeg: string;
  /** Spoken-line durations (ms) from the rendered WAVs, so subtitles and pacing match the audio. */
  durations: Record<string, number>;
}

const W = 1920;
const H = 1080;
const FPS = 30;
/** The stage is 1280×800 CSS px; at 1.2× it fills 1536×960 of the 1920×1080 frame plus a caption band. */
const ZOOM = 1.2;

export async function recordPromo(o: PromoOptions): Promise<void> {
  fs.mkdirSync(o.out, { recursive: true });
  const win = new BrowserWindow({
    width: W,
    height: H,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#0b0a1a',
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, zoomFactor: ZOOM },
  });
  win.webContents.setFrameRate(FPS);
  let last: Buffer | null = null;
  win.webContents.on('paint', (_e, _dirty, image) => {
    const s = image.getSize();
    if (s.width === W && s.height === H) last = image.toBitmap();
    else last = image.resize({ width: W, height: H }).toBitmap();
  });
  await load(win, 'demo', { capture: '1', promo: '1', durs: JSON.stringify(o.durations) });
  win.webContents.setZoomFactor(ZOOM);
  await win.webContents.executeJavaScript('window.demoReady');
  await win.webContents.executeJavaScript('window.promo.prepare()');
  await new Promise((r) => setTimeout(r, 800));

  const videoFile = path.join(o.out, 'video.mp4');
  const ff = spawn(o.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', videoFile], { stdio: ['pipe', 'inherit', 'inherit'] });
  let frames = 0;
  const t0 = performance.now();
  let stop = false;
  // Constant frame rate against the wall clock: each tick writes as many copies
  // of the latest frame as are due (a static screen produces no paint events).
  const pump = async () => {
    while (!stop) {
      const due = Math.floor(((performance.now() - t0) / 1000) * FPS);
      while (frames < due && last) {
        if (!ff.stdin.write(last)) await new Promise((r) => ff.stdin.once('drain', r));
        frames++;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const pumping = pump();
  const runAt = performance.now() - t0;
  const cues: { id: string; t: number }[] = await win.webContents.executeJavaScript('window.promo.run()');
  // Hold the last frame (the outro) a moment, then finish.
  await new Promise((r) => setTimeout(r, 300));
  stop = true;
  await pumping;
  ff.stdin.end();
  await new Promise((r) => ff.on('exit', r));
  fs.writeFileSync(path.join(o.out, 'cues.json'), JSON.stringify({ frames, fps: FPS, cues: cues.map((c) => ({ id: c.id, t: Math.round(c.t + runAt) })) }, null, 2));
  console.log(`promo: ${frames} frames (${(frames / FPS).toFixed(1)} s) → ${videoFile}`);
  win.destroy();
  app.quit();
}
