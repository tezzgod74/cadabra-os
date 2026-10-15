// Round 8: is ANOTHER app using the microphone right now (a call, a meeting,
// a recording)? Windows keeps a per-app record under CapabilityAccessManager:
// an app is using the mic while LastUsedTimeStart is set and LastUsedTimeStop
// is 0. Read-only (`reg query`); Cadabra's own entries are ignored.
import { execFile } from 'node:child_process';

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';

/** Parse `reg query … /s` output into the apps using the mic now (pure; tested). */
export function micUsersFromReg(out: string, ignore: RegExp = /cadabra os\.exe|electron\.exe/i): string[] {
  const users: string[] = [];
  let key = '';
  let start = '';
  let stop = '';
  const flush = () => {
    if (key && start && start !== '0x0' && stop === '0x0' && !ignore.test(key)) users.push(key.split('\\').pop()!.replace(/#/g, '\\'));
    start = '';
    stop = '';
  };
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^HKEY_/i.test(line)) {
      flush();
      key = line;
      continue;
    }
    const m = /^(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(line);
    if (m) {
      if (m[1] === 'LastUsedTimeStart') start = m[2].toLowerCase();
      else stop = m[2].toLowerCase();
    }
  }
  flush();
  return users;
}

/** "C:\\Program Files\\OBS\\obs64.exe" → "obs64.exe" (lower case; Store apps keep their package name). */
export function exeName(p: string): string {
  return (p.split(/[\\/]/).pop() ?? p).toLowerCase();
}

/** A friendlier name for messages ("obs64.exe" → "obs64"). */
export function appLabel(p: string): string {
  return exeName(p).replace(/\.exe$/, '').replace(/_[a-z0-9]{13}$/, '');
}

/** Apps (other than Cadabra) using the microphone right now. Never throws. */
export function micUsersNow(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('reg', ['query', KEY, '/s'], { windowsHide: true, timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? [] : micUsersFromReg(String(stdout))));
  });
}
