// Software KVMs (keyboard/mouse sharing) can capture or redirect both physical
// and injected input: while another PC is in control, Cadabra's keystrokes and
// clicks may never reach this PC's windows. We only DETECT them (read-only
// process list + cursor state). Cadabra never sends input to, or otherwise
// interacts with, these tools.
import { execFile } from 'node:child_process';

export interface KvmTool {
  /** Product name shown to the user. */
  name: string;
  /** Lower-case process names without ".exe". */
  processes: string[];
}

export const KVM_TOOLS: KvmTool[] = [
  // 0.9.13: InputDirectorSessionHelper alone stays running after Input Director is shut down: not a sign it's active.
  { name: 'Input Director', processes: ['inputdirector', 'idmaster', 'idslave'] },
  { name: 'Mouse Without Borders', processes: ['mousewithoutborders', 'mousewithoutbordershelper', 'mousewithoutbordersservice', 'powertoys.mousewithoutborders', 'powertoys.mousewithoutbordershelper', 'powertoys.mousewithoutbordersservice'] },
  { name: 'Synergy', processes: ['synergy', 'synergys', 'synergyc', 'synergy-core', 'synergy-server', 'synergy-client', 'synergy-service'] },
  { name: 'Deskflow', processes: ['deskflow', 'deskflow-core', 'deskflow-server', 'deskflow-client', 'deskflow-daemon'] },
  { name: 'Barrier', processes: ['barrier', 'barriers', 'barrierc', 'barrierd'] },
  { name: 'Input Leap', processes: ['input-leap', 'input-leaps', 'input-leapc', 'input-leapd', 'inputleap'] },
  { name: 'ShareMouse', processes: ['sharemouse', 'sharemouseservice'] },
];

function norm(p: string): string {
  return p.trim().replace(/^"|"$/g, '').toLowerCase().replace(/\.exe$/, '');
}

/** Which KVM tools appear in a list of process names (pure; tested). */
export function detectKvm(processNames: string[]): string[] {
  const names = new Set(processNames.map(norm));
  return KVM_TOOLS.filter((t) => t.processes.some((p) => names.has(p))).map((t) => t.name);
}

/** Parse `tasklist /fo csv /nh` output into process names. */
export function parseTasklist(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.match(/^"([^"]+)"/)?.[1])
    .filter((x): x is string => !!x);
}

let cache: { at: number; tools: string[] } | null = null;

/** KVM tools running on this PC (cached for 15 s; never throws). */
export function runningKvmTools(maxAgeMs = 15000): Promise<string[]> {
  if (cache && Date.now() - cache.at < maxAgeMs) return Promise.resolve(cache.tools);
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const tools = err ? [] : detectKvm(parseTasklist(String(stdout)));
      cache = { at: Date.now(), tools };
      resolve(tools);
    });
  });
}

/** For tests. */
export function _setKvmCache(tools: string[] | null) {
  cache = tools ? { at: Date.now(), tools } : null;
}

export interface InputState {
  cursorShowing?: boolean;
  idleMs?: number;
}

/**
 * Best-effort "is this PC the active one?": with a KVM running, a hidden local
 * cursor usually means the keyboard/mouse are controlling another PC.
 * Returns undefined when it can't tell.
 */
export function likelyRemote(tools: string[], s: InputState | null | undefined): boolean | undefined {
  if (!tools.length || !s || s.cursorShowing == null) return undefined;
  return s.cursorShowing === false;
}

/** The message shown when typing/clicking couldn't be verified and a KVM is running. */
export function kvmMessage(tools: string[], remote?: boolean): string {
  const name = tools.length === 1 ? tools[0] : tools.length ? `${tools.slice(0, -1).join(', ')} or ${tools[tools.length - 1]}` : 'a keyboard/mouse sharing tool';
  return remote
    ? `Your keyboard/mouse seem to be controlling another PC via ${name}. Switch back to this PC and try again.`
    : `Your keyboard/mouse may be controlling another PC via ${name}. Switch back and try again.`;
}
