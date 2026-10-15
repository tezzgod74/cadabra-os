// run_in_terminal safety: a read-only allowlist of diagnostic commands with
// argument checks. No pipes, redirection, chaining, subexpressions or
// variables. Anything else needs the user's explicit OK (the exact command is
// shown); nothing is ever run elevated.

export interface CommandCheck {
  allowed: boolean;
  reason: string;
  /** Normalized command (single spaces). */
  command: string;
}

const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*\.?$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f]{1,4}(:[0-9A-Fa-f]{1,4}){2,7}$/;
/** A plausible host that isn't an obvious DNS-exfiltration label (few labels, short). */
const isHost = (s: string) =>
  (IPV4.test(s) || (IPV6.test(s) && s.includes(':')) || HOST.test(s)) &&
  s.split('.').length <= 4 &&
  s.split('.').every((l) => l.length <= 32) &&
  // REVIEW-2 S6: no dotless/decimal IPs ("3232235777"), no all-numeric labels over 3 digits.
  (IPV4.test(s) || IPV6.test(s) || s.split('.').every((l) => !/^\d{4,}$/.test(l))) &&
  !/^\d+$/.test(s);
const isSmallInt = (s: string, max = 100) => /^\d{1,4}$/.test(s) && +s >= 1 && +s <= max;
// Local paths only: no UNC (\\host, //host), no device paths (\\?\, \\.\), no bare drive-less leading backslash.
const isLocalPath = (s: string) => !/^(\\\\|\/\/|\\\\?\?\\|\\\\\.\\)/.test(s) && !/^[\\/]{2}/.test(s) && !/\.\./.test(s) && !/[<>|?*"]/.test(s) && /^(?:[A-Za-z]:[\\/]?|\.?[\\/]?)?[A-Za-z0-9_.\\/ -]{0,200}$/.test(s) && !s.startsWith('-');
const SAFE_NAME = /^[A-Za-z0-9_.*-]{1,64}$/;

/**
 * Anything that could chain, redirect, substitute, escape or carry a
 * lookalike. Covers ; | & ` $ ( ) newline, quotes, ^, @, #, %, and any
 * non-ASCII character (blocks unicode-lookalike pipes/dashes/quotes).
 */
const META = /[|&;<>`$(){}[\]^%!"'@#\r\n\t\0]|[^\x20-\x7e]/;

type ArgRule = (args: string[]) => string | null;

const RULES: Record<string, ArgRule> = {
  // Only one host, no [server] arg (which is a second exfiltration target).
  nslookup: (a) => (a.length === 1 && isHost(a[0]) ? null : 'nslookup <host>'),
  'resolve-dnsname': (a) => (a.length === 1 && isHost(a[0]) ? null : 'Resolve-DnsName <host>'),
  ping: (a) => {
    const rest = [...a];
    if (rest[0] === '-n' || rest[0] === '/n') {
      if (!isSmallInt(rest[1] ?? '', 20)) return 'ping [-n 1..20] <host>';
      rest.splice(0, 2);
    }
    return rest.length === 1 && isHost(rest[0]) ? null : 'ping [-n count] <host>';
  },
  tracert: (a) => {
    const rest = a.filter((x) => x !== '-d' && x !== '/d');
    return rest.length === 1 && isHost(rest[0]) ? null : 'tracert [-d] <host>';
  },
  pathping: (a) => (a.length === 1 && isHost(a[0]) ? null : 'pathping <host>'),
  ipconfig: (a) => (a.length === 0 || (a.length === 1 && /^[/-](all|displaydns)$/i.test(a[0])) ? null : 'ipconfig [/all]'),
  whoami: (a) => (a.length === 0 || (a.length === 1 && /^[/-](user|groups|all)$/i.test(a[0])) ? null : 'whoami'),
  hostname: (a) => (a.length === 0 ? null : 'hostname'),
  systeminfo: (a) => (a.length === 0 ? null : 'systeminfo'),
  ver: (a) => (a.length === 0 ? null : 'ver'),
  'get-date': (a) => (a.length === 0 ? null : 'Get-Date'),
  'get-computerinfo': (a) => (a.length === 0 ? null : 'Get-ComputerInfo'),
  'get-netipaddress': (a) => (a.length === 0 ? null : 'Get-NetIPAddress'),
  'get-netadapter': (a) => (a.length === 0 ? null : 'Get-NetAdapter'),
  'get-process': (a) => (a.length === 0 || (a.length === 1 && SAFE_NAME.test(a[0])) ? null : 'Get-Process [name]'),
  'get-service': (a) => (a.length === 0 || (a.length === 1 && SAFE_NAME.test(a[0])) ? null : 'Get-Service [name]'),
  'test-netconnection': (a) => {
    if (a.length === 1 && isHost(a[0])) return null;
    if (a.length === 3 && isHost(a[0]) && /^-port$/i.test(a[1]) && isSmallInt(a[2], 65535)) return null;
    return 'Test-NetConnection <host> [-Port n]';
  },
  dir: (a) => (a.length <= 1 && a.every(isLocalPath) ? null : 'dir [local path] (no UNC/network paths, no switches)'),
  ls: (a) => (a.length <= 1 && a.every(isLocalPath) ? null : 'ls [local path]'),
  'get-childitem': (a) => (a.length <= 1 && a.every(isLocalPath) ? null : 'Get-ChildItem [local path] (no -Recurse, no UNC)'),
  'get-location': (a) => (a.length === 0 ? null : 'Get-Location'),
  pwd: (a) => (a.length === 0 ? null : 'pwd'),
  'netstat': (a) => (a.length <= 1 && a.every((x) => /^-[anoe]{1,4}$/.test(x)) ? null : 'netstat [-ano]'),
  arp: (a) => (a.length === 1 && a[0] === '-a' ? null : 'arp -a'),
  getmac: (a) => (a.length === 0 ? null : 'getmac'),
};

export function checkCommand(raw: string): CommandCheck {
  const command = raw.trim().replace(/\s+/g, ' ');
  if (!command) return { allowed: false, reason: 'Empty command', command };
  if (command.length > 300) return { allowed: false, reason: 'Command is too long', command };
  if (META.test(command)) return { allowed: false, reason: 'Contains shell operators (pipes, redirection, chaining or substitution)', command };
  const [name, ...args] = command.split(' ');
  const rule = RULES[name.toLowerCase().replace(/\.exe$/, '')];
  if (!rule) return { allowed: false, reason: `"${name}" is not on the read-only allowlist`, command };
  const err = rule(args);
  if (err) return { allowed: false, reason: `Unexpected arguments (allowed form: ${err})`, command };
  return { allowed: true, reason: 'Read-only diagnostic command', command };
}

/** PowerShell script that shows + runs the command and tees all output to a file. */
export function terminalScript(command: string, outFile: string, doneFile: string, pidFile?: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return [
    // O1: record our PID so Esc can stop the command (the terminal isn't our child).
    ...(pidFile ? [`Set-Content -LiteralPath ${q(pidFile)} -Value $PID`] : []),
    `$Host.UI.RawUI.WindowTitle = 'Cadabra — ' + ${q(command)}`,
    `Write-Host ('PS> ' + ${q(command)}) -ForegroundColor Yellow`,
    `try { Invoke-Expression ${q(command)} 2>&1 | Tee-Object -FilePath ${q(outFile)} | Out-Host } catch { $_ | Out-String | Tee-Object -FilePath ${q(outFile)} -Append | Out-Host }`,
    `Set-Content -LiteralPath ${q(doneFile)} -Value $LASTEXITCODE`,
  ].join('\n');
}

/** -EncodedCommand payload (UTF-16LE base64): no quoting problems through wt.exe / cmd. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}
