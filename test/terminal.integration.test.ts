// Opens a REAL visible PowerShell console, runs `hostname` (read-only) and
// reads the teed output back, then closes that console. Opt-in:
//   CADABRA_TEST_TERMINAL=1 npx vitest run test/terminal.integration.test.ts
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runInTerminal } from '../src/main/terminal-runner';

describe.skipIf(process.env.CADABRA_TEST_TERMINAL !== '1')('run_in_terminal (real console)', () => {
  it('runs hostname in a visible PowerShell window and captures the output', async () => {
    const t0 = Date.now();
    const r = await runInTerminal('hostname', { prefer: 'powershell', timeoutMs: 20_000 });
    console.log('terminal result', { ms: Date.now() - t0, output: r.output, exitCode: r.exitCode, timedOut: r.timedOut });
    try {
      expect(r.timedOut).toBe(false);
      expect(r.output.toLowerCase()).toContain(os.hostname().toLowerCase());
    } finally {
      // Close only the console this test opened (PowerShell started after t0, titled "Cadabra — hostname").
      const secs = Math.ceil((Date.now() - t0) / 1000) + 5;
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.ProcessId -ne $PID -and $_.CreationDate -ge (Get-Date).AddSeconds(-${secs}) -and $_.CommandLine -match 'NoExit.*EncodedCommand' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
      ]);
    }
  }, 30_000);

  it('O1: Esc (abort) stops the running command and its console', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 2500);
    const r = await runInTerminal('ping -n 30 127.0.0.1', { prefer: 'powershell', timeoutMs: 40_000, signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r.exitCode).toBeNull();
    await new Promise((res) => setTimeout(res, 800));
    const secs = Math.ceil((Date.now() - t0) / 1000) + 5;
    const left = execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'NoExit.*EncodedCommand' -or $_.Name -eq 'PING.EXE') -and $_.CreationDate -ge (Get-Date).AddSeconds(-${secs}) }).Count`,
    ])
      .toString()
      .trim();
    expect(left).toBe('0');
  }, 30_000);
});
