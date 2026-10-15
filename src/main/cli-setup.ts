// One-click install of the vendors' OFFICIAL CLIs (Part B, round 3), only
// after the user has seen the exact command and agreed. Per-user, no admin.
//
// Sources (verified 2026-10-12):
// - Claude Code: https://code.claude.com/docs/en/setup → Windows PowerShell:
//   `irm https://claude.ai/install.ps1 | iex` ("You do not need to run as
//   Administrator"). Fallbacks: `winget install Anthropic.ClaudeCode`,
//   `npm install -g @anthropic-ai/claude-code` (Node 22+).
// - Codex: `npm install -g @openai/codex` (docs/research.md §8.2 and OpenAI's
//   README; needs Node.js).
// - Gemini CLI: `npm install -g @google/gemini-cli` (docs/research.md §8.3 and
//   Google's README; Node.js 20+).
// Sign-in always runs in the vendor's own flow (Claude: a visible terminal
// with `claude auth login`; Codex/Gemini: their app-server / ACP login).

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { spawnCli, whichSync } from './exe-finder';

export type CliId = 'claude' | 'codex' | 'gemini';

export interface CliInstallSpec {
  id: CliId;
  name: string;
  /** Shown verbatim to the user before anything runs. */
  displayCommand: string;
  /** What actually runs (same command; no shell string assembly from user input). */
  exe: string;
  args: string[];
  needsNode?: { minMajor: number };
  docsUrl: string;
  /** Copyable alternatives for the manual panel. */
  manual: string[];
}

export const CLI_INSTALLS: Record<CliId, CliInstallSpec> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    displayCommand: 'irm https://claude.ai/install.ps1 | iex',
    exe: 'powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'],
    docsUrl: 'https://code.claude.com/docs/en/setup',
    manual: ['irm https://claude.ai/install.ps1 | iex', 'winget install Anthropic.ClaudeCode', 'npm install -g @anthropic-ai/claude-code'],
  },
  codex: {
    id: 'codex',
    name: 'Codex CLI',
    displayCommand: 'npm install -g @openai/codex',
    exe: 'npm.cmd',
    args: ['install', '-g', '@openai/codex'],
    needsNode: { minMajor: 18 },
    docsUrl: 'https://github.com/openai/codex',
    manual: ['npm install -g @openai/codex'],
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    displayCommand: 'npm install -g @google/gemini-cli',
    exe: 'npm.cmd',
    args: ['install', '-g', '@google/gemini-cli'],
    needsNode: { minMajor: 20 },
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    manual: ['npm install -g @google/gemini-cli'],
  },
};

export interface InstallIO {
  /** Progress lines (installer output, elapsed time). */
  line(text: string): void;
  signal?: AbortSignal;
}

export interface InstallResult {
  ok: boolean;
  exitCode: number | null;
  error?: string;
  output: string;
}

export interface SetupDeps {
  /** Spawn function (tests inject a fake installer). */
  spawn?: (exe: string, args: string[]) => ChildProcess;
  /** Node version probe (tests inject). */
  nodeVersion?: () => Promise<string | null>;
}

export function nodeVersion(): Promise<string | null> {
  const node = whichSync('node.exe');
  if (!node) return Promise.resolve(null);
  return new Promise((resolve) => execFile(node, ['--version'], { windowsHide: true, timeout: 8000 }, (e, out) => resolve(e ? null : String(out).trim())));
}

/** Why an install can't start (missing / old Node), or null. */
export async function installBlocker(spec: CliInstallSpec, deps: SetupDeps = {}): Promise<string | null> {
  if (!spec.needsNode) return null;
  const v = await (deps.nodeVersion ?? nodeVersion)();
  if (!v) return `${spec.name} installs with npm, which needs Node.js ${spec.needsNode.minMajor} or later. Install Node.js LTS from https://nodejs.org (or \`winget install OpenJS.NodeJS.LTS\`), then try again.`;
  const major = Number(/v?(\d+)/.exec(v)?.[1] ?? 0);
  if (major < spec.needsNode.minMajor) return `${spec.name} needs Node.js ${spec.needsNode.minMajor}+ (you have ${v}). Update Node.js, then try again.`;
  return null;
}

/**
 * Run the official installer (after consent). Hidden window; output is
 * streamed as progress. Never elevated.
 */
export async function installCli(spec: CliInstallSpec, io: InstallIO, deps: SetupDeps = {}): Promise<InstallResult> {
  const blocker = await installBlocker(spec, deps);
  if (blocker) return { ok: false, exitCode: null, error: blocker, output: '' };
  const doSpawn =
    deps.spawn ??
    ((exe: string, args: string[]) => {
      // npm is a .cmd: resolve it and quote it explicitly (no `shell: true`).
      const resolved = /\.cmd$/i.test(exe) ? (whichSync(exe) ?? exe) : exe;
      const p = spawnCli(resolved, args, {});
      p.stdin.end();
      return p;
    });
  let output = '';
  const started = Date.now();
  io.line(`Running: ${spec.displayCommand}`);
  return new Promise<InstallResult>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = doSpawn(spec.exe, spec.args);
    } catch (e) {
      resolve({ ok: false, exitCode: null, error: (e as Error).message, output });
      return;
    }
    const tick = setInterval(() => io.line(`Still installing… ${Math.round((Date.now() - started) / 1000)} s`), 5000);
    const onData = (d: Buffer) => {
      const t = String(d);
      output += t;
      for (const l of t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) io.line(l.slice(0, 200));
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    const onAbort = () => proc.kill();
    io.signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (e) => {
      clearInterval(tick);
      resolve({ ok: false, exitCode: null, error: e.message, output });
    });
    proc.on('exit', (code) => {
      clearInterval(tick);
      io.signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve({ ok: true, exitCode: 0, output });
      else resolve({ ok: false, exitCode: code, error: friendlyInstallError(output, code), output });
    });
  });
}

export function friendlyInstallError(output: string, code: number | null): string {
  const o = output.toLowerCase();
  if (/eacces|eperm|permission denied/.test(o)) return 'npm could not write to its global folder (permission error). See the manual steps, or fix the npm prefix (npm config get prefix).';
  if (/enotfound|getaddrinfo|could not resolve|unable to connect|network/.test(o)) return 'The download failed (no internet connection or a proxy is blocking it).';
  if (/execution.?policy|running scripts is disabled/.test(o)) return 'PowerShell blocked the install script (execution policy). Use the manual steps below.';
  if (/403/.test(o)) return 'The download was refused (HTTP 403). Your region or network may block it; see the docs.';
  return `The installer exited with code ${code ?? 'unknown'}. See the output above, or use the manual steps.`;
}

/**
 * Claude Code's own sign-in, in a VISIBLE terminal the user controls
 * (`claude auth login`). Cadabra only opens it and polls `claude auth status`.
 */
export function openLoginTerminal(exe: string, args: string[] = ['auth', 'login']): void {
  const line = [exe, ...args].map((a) => (/[\s&^|<>"]/.test(a) ? `"${a.replace(/"/g, '')}"` : a)).join(' ');
  spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '"Sign in to Claude Code"', 'cmd', '/k', line], { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true }).unref();
}
