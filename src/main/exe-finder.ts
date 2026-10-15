import { execFile, spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Search PATH (with PATHEXT) for an executable name. */
export function whichSync(name: string, envPath = process.env.PATH ?? '', pathExt = process.env.PATHEXT ?? '.EXE;.CMD;.BAT'): string | undefined {
  const exts = path.extname(name) ? [''] : ['', ...pathExt.split(';').filter(Boolean).map((e) => e.toLowerCase())];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

export function firstExisting(paths: (string | undefined)[]): string | undefined {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return undefined;
}

/** Global npm root on Windows (best effort, no child process). */
export function npmGlobalRoots(): string[] {
  const roots: string[] = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  if (process.env.NVM_SYMLINK) roots.push(path.join(process.env.NVM_SYMLINK, 'node_modules'));
  roots.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'));
  return [...new Set(roots)];
}

/**
 * Kill a child and its descendants. CLIs installed by npm are `.cmd` shims
 * (cmd.exe -> node.exe), so `proc.kill()` alone would orphan the real agent.
 */
export function killTree(proc: { pid?: number; kill(): boolean } | null | undefined): Promise<void> {
  if (!proc?.pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    proc.kill();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      resolve();
    });
  });
}

/**
 * Spawn a CLI with piped stdio. npm installs `.cmd` shims, which need cmd.exe;
 * the arguments here are fixed flags (never user text), quoted explicitly
 * instead of using `shell: true`.
 */
export function spawnCli(exe: string, args: string[], opts: Omit<SpawnOptions, 'stdio' | 'shell'>): ChildProcessWithoutNullStreams {
  const base = { ...opts, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true };
  if (!/\.(cmd|bat)$/i.test(exe)) return spawn(exe, args, base) as ChildProcessWithoutNullStreams;
  if ([exe, ...args].some((a) => /["%^&|<>]/.test(a))) throw new Error(`Refusing to run ${exe}: unsafe characters in the command line`);
  const line = [exe, ...args].map((a) => `"${a}"`).join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...base, windowsVerbatimArguments: true }) as ChildProcessWithoutNullStreams;
}

/**
 * Run a CLI to completion and collect stdout (status/version probes). Uses the
 * same explicit quoting as spawnCli, so `.cmd` paths with spaces work
 * (REVIEW-3 MISC; no `shell: true`).
 */
export function execCli(exe: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string } = {}): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawnCli(exe, args, { env: opts.env ?? process.env, cwd: opts.cwd });
    } catch {
      resolve({ code: null, stdout: '' });
      return;
    }
    let out = '';
    proc.stdin.end();
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', () => undefined);
    const t = setTimeout(() => {
      void killTree(proc);
      resolve({ code: null, stdout: out });
    }, opts.timeoutMs ?? 15_000);
    proc.on('error', () => {
      clearTimeout(t);
      resolve({ code: null, stdout: out });
    });
    proc.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, stdout: out });
    });
  });
}
