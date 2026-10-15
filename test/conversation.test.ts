// Acceptance scenarios A and B (docs/BUILD_NOTES.md), pure parts:
// local fast paths, closers, spoken formatting, terminal allowlist.
import { describe, expect, it } from 'vitest';
import { answerLocally, clauses, greeting } from '../src/shared/smalltalk';
import { checkCommand, encodePowerShell, terminalScript } from '../src/shared/terminal';
import { toSpeech } from '../src/shared/speech';

const at = (h: number, m: number) => new Date(2026, 9, 11, h, m);

describe('Scenario A — presence + time, answered locally', () => {
  it('"Cadabra, are you there? What time is it." → greeting by name + time + offer', () => {
    const r = answerLocally('Cadabra, are you there? What time is it.', { now: at(10, 21), name: 'Alex', firstTurn: true, voice: true });
    expect(r).toEqual({ kind: 'answer', text: "Good morning, Alex. It's 10:21 AM. Anything I can help you with?" });
  });
  it('"No. Thanks." closes gracefully', () => {
    expect(answerLocally('No. Thanks.', { now: at(10, 22), firstTurn: false, voice: true })).toEqual({ kind: 'close', text: 'Anytime.' });
    for (const s of ['Nope, thanks', "That's all", 'never mind', 'thank you', 'no thanks', 'Nope. Thanks.', "I'm good"]) {
      expect(answerLocally(s, { now: at(10, 22), firstTurn: false, voice: true })?.kind, s).toBe('close');
    }
  });
  it('greets only on the first turn and by time of day', () => {
    expect(greeting(at(9, 0))).toBe('Good morning');
    expect(greeting(at(14, 0))).toBe('Good afternoon');
    expect(greeting(at(20, 0))).toBe('Good evening');
    expect(answerLocally('what time is it', { now: at(15, 5), name: 'Alex', firstTurn: false, voice: false })?.text).toBe("It's 3:05 PM.");
    expect(answerLocally('are you there', { now: at(15, 5), name: 'Alex', firstTurn: true, voice: true })?.text).toBe("Good afternoon, Alex. I'm here. Anything I can help you with?");
  });
  it('answers date questions', () => {
    expect(answerLocally("what's the date", { now: at(15, 5), firstTurn: false, voice: false })?.text).toBe("Today is Sunday 11 October 2026.");
  });
  it('mixed local + non-local goes to the AI', () => {
    expect(answerLocally('are you there? what is this error', { now: at(10, 0), firstTurn: true, voice: true })).toBeNull();
    expect(answerLocally('no, open the settings', { now: at(10, 0), firstTurn: false, voice: true })).toBeNull();
    expect(answerLocally('thanks, now click send', { now: at(10, 0), firstTurn: false, voice: true })).toBeNull();
  });
  it('splits clauses sensibly', () => {
    expect(clauses('Cadabra, are you there? What time is it.')).toEqual(['are you there', 'what time is it']);
  });
});

describe('Scenario B — terminal allowlist', () => {
  it('allows read-only diagnostics without confirmation', () => {
    for (const c of ['nslookup 8.8.8.8', 'ping -n 4 example.com', 'tracert -d 1.1.1.1', 'ipconfig /all', 'whoami', 'hostname', 'Get-Date', 'Test-NetConnection github.com -Port 443', 'dir C:\\Users', 'Get-Process chrome', 'Resolve-DnsName dns.google']) {
      expect(checkCommand(c).allowed, c).toBe(true);
    }
  });
  it('requires confirmation for anything else, showing why', () => {
    const cases: [string, RegExp][] = [
      ['nslookup 8.8.8.8 | findstr Name', /operators/],
      ['ping 8.8.8.8; del C:\\x', /operators/],
      ['nslookup $(whoami)', /operators/],
      ['ipconfig > out.txt', /operators/],
      ['del C:\\Windows\\x', /allowlist/],
      ['Remove-Item foo', /allowlist/],
      ['ping -t 8.8.8.8', /arguments/],
      ['dir ..\\..\\secrets', /arguments/],
      ['nslookup "evil host"', /operators/],
      ['powershell -enc AAAA', /allowlist/],
    ];
    for (const [c, why] of cases) {
      const r = checkCommand(c);
      expect(r.allowed, c).toBe(false);
      expect(r.reason, c).toMatch(why);
    }
  });
  it('builds a tee-to-file PowerShell script safely encoded', () => {
    const s = terminalScript("nslookup 8.8.8.8", 'C:\\t\\out.txt', 'C:\\t\\done.txt');
    expect(s).toContain("Tee-Object -FilePath 'C:\\t\\out.txt'");
    expect(s).toContain("Write-Host ('PS> ' + 'nslookup 8.8.8.8')");
    expect(Buffer.from(encodePowerShell(s), 'base64').toString('utf16le')).toBe(s);
    expect(terminalScript("x'y", 'o', 'd')).toContain("'x''y'");
  });
});

describe('spoken replies are voice-formatted', () => {
  it('strips markdown, URLs and code, keeps it short', () => {
    const md = "**8.8.8.8** resolves to `dns.google`. Anything else?\n\n```\nServer: one.one.one.one\nAddress: 1.1.1.1\n```\nSee https://dns.google for more.";
    expect(toSpeech(md)).toBe('8.8.8.8 resolves to dns.google. Anything else?');
    expect(toSpeech('- First thing\n- Second thing\n- Third thing')).toBe('First thing. Second thing.');
    expect(toSpeech('Read [the docs](https://x.y/z) now.')).toBe('Read the docs now.');
  });
});

describe('normalizeSpoken (voice prompts vs. the host check)', () => {
  it('turns spoken addresses and "ns look up" into their written form', async () => {
    const { normalizeSpoken } = await import('../src/shared/speech');
    expect(normalizeSpoken('Ets look up for eight point eight point eight point eight')).toBe('nslookup for 8.8.8.8');
    expect(normalizeSpoken('ping one nine two dot one six eight dot zero dot one')).toBe('ping 192.168.0.1');
    expect(normalizeSpoken('open notepad')).toBe('open notepad');
  });
});
