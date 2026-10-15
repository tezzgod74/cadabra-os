import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodePowerShell, terminalScript } from '../shared/terminal';
import { whichSync } from './exe-finder';
import type { WinInfo } from './apps/launcher';

export interface TerminalResult {
  output: string;
  exitCode: string | null;
  terminal: 'wt' | 'powershell';
  window: WinInfo | null;
  timedOut: boolean;
}

/** PowerShell 5.1's Tee-Object writes UTF-16LE with a BOM; newer hosts write UTF-8. */
export function decodeTeeFile(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** O1: Esc stops the command: kill the terminal's PowerShell (and what it started). */
export async function stopTerminal(pidFile: string): Promise<boolean> {
  let pid = 0;
  try {
    pid = Number(decodeTeeFile(fs.readFileSync(pidFile)).trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 4) return false;
  await new Promise<void>((r) => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => r()));
  return true;
}

/**
 * Opens a VISIBLE terminal (Windows Terminal if installed, else a PowerShell
 * console), shows and runs the command there, and tees its output to a temp
 * file so Cadabra can read/speak it. Why tee instead of scraping the console
 * via UIA: it's exact (no wrapping/scrollback/truncation issues), works the
 * same in conhost and Windows Terminal, and needs no focus. The script is
 * passed with -EncodedCommand so nothing gets mangled by wt.exe or cmd
 * quoting. Never elevated (plain CreateProcess).
 */
export async function runInTerminal(
  command: string,
  opts: { listWindows?: () => Promise<WinInfo[]>; onWindow?: (w: WinInfo) => void; timeoutMs?: number; prefer?: 'wt' | 'powershell'; signal?: AbortSignal },
): Promise<TerminalResult> {
  const dir = path.join(os.tmpdir(), `cadabra-term-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'out.txt');
  const done = path.join(dir, 'done.txt');
  const pidFile = path.join(dir, 'pid.txt');
  const enc = encodePowerShell(terminalScript(command, out, done, pidFile));
  const ps = ['powershell.exe', '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc];
  const wt = opts.prefer === 'powershell' ? undefined : whichSync('wt.exe');
  const before = new Set((await opts.listWindows?.().catch(() => []))?.map((w) => w.hwnd) ?? []);
  // Windows Terminal is a GUI app: it opens its own window. For plain PowerShell,
  // `start` gives it a NEW visible console (a detached child has no console and
  // exits immediately; an attached one would share Cadabra's hidden console).
  if (wt) spawn(wt, ['-w', 'new', ...ps], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  else spawn('cmd.exe', ['/d', '/c', 'start', '""', ...ps], { stdio: 'ignore', windowsHide: true }).unref();

  let window: WinInfo | null = null;
  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);
  let timedOut = true;
  while (Date.now() < deadline && !opts.signal?.aborted) {
    await sleep(250);
    if (!window && opts.listWindows) {
      const ws = await opts.listWindows().catch(() => [] as WinInfo[]);
      window = ws.find((w) => !before.has(w.hwnd) && /powershell|windowsterminal|openconsole|conhost/i.test(w.process)) ?? null;
      if (window) opts.onWindow?.(window);
    }
    if (fs.existsSync(done)) {
      timedOut = false;
      break;
    }
  }
  if (opts.signal?.aborted && !fs.existsSync(done)) await stopTerminal(pidFile);
  await sleep(100);
  let output = '';
  try {
    output = decodeTeeFile(fs.readFileSync(out));
  } catch {
    /* nothing captured */
  }
  let exitCode: string | null = null;
  try {
    exitCode = decodeTeeFile(fs.readFileSync(done)).trim() || null;
  } catch {
    /* not finished */
  }
  setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => undefined), 5000);
  return { output: output.replace(/\r\n/g, '\n').trim(), exitCode, terminal: wt ? 'wt' : 'powershell', window, timedOut };
}
