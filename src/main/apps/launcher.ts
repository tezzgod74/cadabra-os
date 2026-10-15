import { spawn } from 'node:child_process';
import path from 'node:path';
import { normalizeName, type AppEntry } from '../../shared/apps';
import type { Rect } from '../../shared/types';

export interface WinInfo {
  hwnd: number;
  title: string;
  pid: number;
  process: string;
  rect: Rect;
  minimized?: boolean;
}

export interface LauncherDeps {
  listWindows(): Promise<WinInfo[]>;
  foreground(hwnd: number): Promise<unknown>;
  openPath(p: string): Promise<string>;
  openExternal(url: string): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Does this window belong to the app? (process name from its exe, else title words). */
export function windowMatchesApp(w: WinInfo, app: AppEntry): boolean {
  const proc = w.process.toLowerCase();
  if (app.exe && path.basename(app.exe).toLowerCase() === proc) return true;
  const name = normalizeName(app.name);
  const first = name.split(' ')[0];
  if (first.length >= 4 && proc.replace(/\.exe$/, '').includes(first.replace(/[^a-z0-9]/g, ''))) return true;
  const title = normalizeName(w.title);
  return name.length >= 4 && (title === name || title.endsWith(` ${name}`) || title.startsWith(`${name} `));
}

export type LaunchResult =
  | { status: 'focused'; window: WinInfo }
  | { status: 'launched'; window: WinInfo | null; ms: number }
  | { status: 'error'; message: string };

/**
 * Launch an indexed app via ShellExecute / its protocol URI (never with
 * elevation flags). If it's already running, bring its window forward
 * instead of starting a second instance. Waits up to `waitMs` for the new
 * window so the caller can trace it.
 */
export async function launchApp(app: AppEntry, d: LauncherDeps, opts: { focusExisting?: boolean; waitMs?: number; onLaunched?: () => void } = {}): Promise<LaunchResult> {
  let before: WinInfo[] = [];
  try {
    before = await d.listWindows();
  } catch {
    /* no helper: launch blind */
  }
  if (opts.focusExisting !== false) {
    const running = before.find((w) => windowMatchesApp(w, app));
    if (running) {
      await d.foreground(running.hwnd).catch(() => undefined);
      return { status: 'focused', window: running };
    }
  }
  const t0 = Date.now();
  try {
    if (app.kind === 'path') {
      const err = await d.openPath(app.target);
      if (err) return { status: 'error', message: err };
    } else if (app.kind === 'uri') {
      await d.openExternal(app.target);
    } else {
      // Packaged (Store) apps launch by AUMID through the shell.
      const p = spawn('explorer.exe', [app.target], { detached: true, stdio: 'ignore', windowsHide: false });
      p.unref();
    }
  } catch (e) {
    return { status: 'error', message: (e as Error).message };
  }
  opts.onLaunched?.();
  const known = new Set(before.map((w) => w.hwnd));
  const deadline = Date.now() + (opts.waitMs ?? 20000);
  while (Date.now() < deadline) {
    await sleep(350);
    let now: WinInfo[];
    try {
      now = await d.listWindows();
    } catch {
      break;
    }
    const fresh = now.filter((w) => !known.has(w.hwnd));
    const hit = fresh.find((w) => windowMatchesApp(w, app)) ?? (fresh.length === 1 && Date.now() - t0 > 1500 ? fresh[0] : undefined);
    if (hit && hit.rect.width > 50 && hit.rect.height > 50) return { status: 'launched', window: hit, ms: Date.now() - t0 };
  }
  return { status: 'launched', window: null, ms: Date.now() - t0 };
}
