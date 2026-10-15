// Logs + "Export diagnostics…" (tray). Everything that leaves this PC in a
// bundle is redacted: e-mail addresses, API keys / tokens, long secrets, the
// Windows user name and the display name.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RING: string[] = [];
const RING_MAX = 3000;
let logFile: string | null = null;

/** Mirror console output into a ring buffer and %APPDATA%\Cadabra OS\logs\cadabra.log (rotated at 2 MB). */
export function installLogCapture(userData: string) {
  const dir = path.join(userData, 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'cadabra.log');
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) fs.renameSync(logFile, path.join(dir, 'cadabra.old.log'));
  } catch {
    logFile = null;
  }
  for (const level of ['log', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      const line = `${new Date().toISOString()} ${level.toUpperCase()} ${args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')}`;
      // Logs on disk are redacted too: they may be attached to a bug report.
      const red = redact(line).slice(0, 4000);
      RING.push(red);
      if (RING.length > RING_MAX) RING.shift();
      if (logFile) fs.appendFile(logFile, red + '\n', () => undefined);
    };
  }
}

function safeJson(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Window titles Cadabra saw (chat partners, document names…). In logs and
 * bundles they are replaced by the app's process name only.
 */
const TITLES = new Map<string, string>();
export function rememberWindowTitle(title: string | undefined, process: string | undefined) {
  const t = (title ?? '').trim();
  if (t.length < 4) return;
  TITLES.set(t, (process ?? 'app').replace(/\.exe$/i, ''));
  if (TITLES.size > 200) TITLES.delete(TITLES.keys().next().value!);
}

/** Field names whose VALUES are secret whatever their shape (refresh_token, apiKey, password…). */
const SECRET_FIELD = /(\b[\w-]*(?:token|secret|password|passwd|pwd|credential|(?<!hot|shortcut)key)\b)(["']?\s*[:=]\s*["']?)([^\s"',;&}\]]{6,})/gi;

/** Remove anything that identifies the user or could unlock an account. */
export function redact(text: string, extra: string[] = []): string {
  let t = text;
  // Window titles first (they may contain names, which the rules below would only partly catch).
  for (const [title, proc] of TITLES) if (t.includes(title)) t = t.split(title).join(`[${proc} window]`);
  // URL-encoded e-mails (jane%40contoso.com).
  t = t.replace(/%(?:25)?40/gi, '@');
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  t = t.replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g, '[key]');
  t = t.replace(/\b(Bearer|Authorization)([\s:="']+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1$2[token]');
  t = t.replace(SECRET_FIELD, '$1$2[secret]');
  // AWS-style secrets: 40 chars of base64 including / or +.
  t = t.replace(/(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g, (m) => (/[/+]/.test(m) && /\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) ? '[secret]' : m));
  t = t.replace(/\b[A-Za-z0-9_-]{32,}\b/g, (m) => (/^[a-f0-9]{32,}$/i.test(m) || /\d/.test(m) ? '[secret]' : m));
  // Names, case-insensitively: account name, profile folder (they can differ, e.g. a
  // Microsoft account vs C:\Users\<folder>), machine name, Windows domain, display name.
  const names: [string | undefined, string][] = [
    [os.userInfo().username, '[user]'],
    [path.basename(os.homedir()), '[user]'],
    [process.env.USERNAME, '[user]'],
    ...extra.map((x): [string, string] => [x, '[user]']),
    [os.hostname(), '[machine]'],
    [process.env.COMPUTERNAME, '[machine]'],
    [process.env.USERDOMAIN, '[domain]'],
  ];
  for (const [n, label] of names) if (n && n.trim().length >= 3) t = t.replace(new RegExp(escapeRe(n.trim()), 'gi'), label);
  return t;
}

/** A device label → its kind + a short hash ("Bluetooth/headset input #3fa2c1"): no names in exports. */
export function deviceTag(label: string): string {
  const l = label.trim();
  if (!l) return 'input';
  let h = 0x811c9dc5;
  for (let i = 0; i < l.length; i++) h = Math.imul(h ^ l.charCodeAt(i), 0x01000193) >>> 0;
  const kind = /bluetooth|hands-?free|airpods|buds|headset|\bbt\b/i.test(l)
    ? 'Bluetooth/headset input'
    : /usb|interface|analogue|analog/i.test(l)
      ? 'USB input'
      : /realtek|array|internal|built-?in|webcam|camera/i.test(l)
        ? 'built-in input'
        : /fake/i.test(l)
          ? 'test input'
          : 'input';
  return `${kind} #${h.toString(16).padStart(8, '0').slice(0, 6)}`;
}

/** Microphone device labels in our log lines ("mic started [label]", "input [label]", inputs=[…]) → deviceTag(). */
export function redactDevices(text: string): string {
  return text
    .replace(/(\bmic [a-z-]+ |\binput )\[([^\]\n]{1,120})\]/g, (m, pre: string, label: string) => (/ #[0-9a-f]{6}$/.test(label) ? m : `${pre}[${deviceTag(label)}]`))
    .replace(/inputs=(\[[^\]\n]*\])/g, (_m, arr: string) => {
      try {
        return `inputs=${JSON.stringify((JSON.parse(arr) as string[]).map((x) => deviceTag(String(x))))}`;
      } catch {
        return 'inputs=[…]';
      }
    });
}

export function recentLog(lines = 1500): string[] {
  return RING.slice(-lines);
}

export interface DiagnosticsInfo {
  version: string;
  settings: unknown;
  providers: { id: string; auth?: { ok: boolean; detail: string } }[];
  helper: string;
  voice: string;
  tts?: { installed: boolean; rtf: number | null; tooSlow: boolean };
  displayName?: string;
  /** Keyboard/mouse sharing tools running (Input Director, Mouse Without Borders…). */
  kvm?: string[];
}

/** The text of a redacted diagnostic bundle (what "Export diagnostics…" saves). */
export function diagnosticsText(info: DiagnosticsInfo): string {
  const s = JSON.parse(JSON.stringify(info.settings ?? {}));
  if (s.displayName) s.displayName = '[name]';
  // Round 8: the connected mailbox and the Google client id never leave the PC.
  if (s.email) s.email = { mode: s.email.mode, allowBodies: s.email.allowBodies, address: s.email.address ? '[email]' : '', clientId: s.email.clientId ? '[client id]' : '' };
  if (s.location) s.location = '[city]';
  // Round 12: the WhatsApp owner id and poll offset stay on the PC.
  if (s.remote) s.remote = { enabled: s.remote.enabled, autonomy: s.remote.autonomy, paired: !!s.remote.pairedFrom };
  const body = [
    `Cadabra OS diagnostics`,
    `Version: ${info.version}`,
    `Windows: ${os.release()} (${os.arch()}), ${os.cpus().length} logical CPUs, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM`,
    `Created: ${new Date().toISOString()}`,
    `Privacy: e-mails, keys, tokens, your user/machine names and the window titles Cadabra saw are removed. Text from other apps can still appear in the log, so please read this file before sending it.`,
    '',
    '## Status',
    `Helper: ${info.helper}`,
    `Voice: ${info.voice}`,
    `Natural voice: ${info.tts ? `${info.tts.installed ? 'installed' : 'not installed'}, RTF ${info.tts.rtf?.toFixed(2) ?? 'n/a'}${info.tts.tooSlow ? ' (too slow, using the Windows voice)' : ''}` : 'n/a'}`,
    `Keyboard/mouse sharing: ${info.kvm == null ? 'not checked' : info.kvm.length ? `${info.kvm.join(', ')} running (typing and clicks can go to another PC while it's in control)` : 'none detected'}`,
    ...info.providers.map((p) => `Backend ${p.id}: ${p.auth ? `${p.auth.ok ? 'ok' : 'not ready'} (${p.auth.detail})` : 'not checked'}`),
    '',
    '## Settings (keys and names removed)',
    JSON.stringify(s, null, 2),
    '',
    '## Recent log',
    ...recentLog(),
  ].join('\n');
  // Round 6: microphone names ("Jane's AirPods") become a kind + hash in exports.
  // Round 8 (REVIEW-7): web domains stay in the local log but not in exports.
  return redactDevices(redact(body, info.displayName ? [info.displayName] : [])).replace(/(\[web\] (?:search|fetch)) [^\s:]+:/g, '$1:');
}
