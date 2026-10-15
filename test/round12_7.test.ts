// Round 12.7 (user bug): Nova sent the WhatsApp screenshot, then "corrected"
// herself ("I didn't actually send it") because send_screenshot wasn't mapped
// to "sent". The claim → tool mapping now comes from one registry, and this
// test fails if any tool Cadabra exposes lacks a declaration.
import { describe, expect, it } from 'vitest';
import { ToolHost } from '../src/main/tools';
import { SafetyGate } from '../src/main/safety-gate';
import { DEFAULT_SAFETY } from '../src/shared/safety';
import { honestyCorrection } from '../src/main/conversation';
import { TOOL_CLAIMS, LOCAL_ACTION } from '../src/main/claims';

const ok = (name: string) => ({ name, ok: true, code: 'ok' });

describe('every tool declares which claims it backs', () => {
  it('no exposed tool is missing from the registry', () => {
    const h = new ToolHost({} as any, new SafetyGate(() => DEFAULT_SAFETY, { confirm: async () => false }), {} as any, {} as any, {} as any, {} as any);
    const names = h.definitions().map((d) => d.name);
    expect(names.length).toBeGreaterThan(20);
    const missing = names.filter((n) => !(n in TOOL_CLAIMS));
    expect(missing, `add these to TOOL_CLAIMS in src/main/claims.ts: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('the WhatsApp screenshot case', () => {
  it('after send_screenshot succeeded, no false correction', () => {
    for (const reply of ['Here’s your screenshot — sent!', 'I’ve sent you a screenshot of your screen.', 'I took a screenshot and sent it to you.', 'Done — sent.', 'I captured your screen and shared it here.'])
      expect(honestyCorrection(reply, [ok('send_screenshot')]), reply).toBeNull();
  });
  it('a failed send is still corrected', () => {
    expect(honestyCorrection('I’ve sent you a screenshot.', [{ name: 'send_screenshot', ok: false, code: 'error' }])).toBe("Correction: I couldn't send it: it failed.");
  });
});

describe('each tool’s typical success sentence passes; without the tool it is corrected', () => {
  const cases: [string, string][] = [
    ['type_text', 'I typed 622322422 into Notepad.'],
    ['click', 'I clicked Directions.'],
    ['press_keys', 'I pressed Enter.'],
    ['launch_app', 'I opened Notepad.'],
    ['focus_app', 'I brought Spotify to the front.'],
    ['open_url', 'I opened YouTube in Chrome.'],
    ['open_email', 'I opened the email in Gmail.'],
    ['run_in_terminal', 'I ran nslookup for you.'],
    ['lock_pc', 'I locked your PC.'],
    ['see_screen', 'I took a screenshot to check.'],
    ['search_email', 'I checked your inbox.'],
    ['get_weather', 'I looked it up: 72 and sunny.'],
    ['scroll', 'I scrolled down.'],
    ['highlight', 'I highlighted the Save button.'],
    ['set_provider', 'I switched to Copilot.'],
    ['pause_cadabra', 'I paused Cadabra.'],
  ];
  for (const [tool, sentence] of cases) {
    it(`${tool}: "${sentence}"`, () => {
      expect(TOOL_CLAIMS[tool]?.length ?? 0, tool).toBeGreaterThan(0);
      expect(honestyCorrection(sentence, [ok(tool)])).toBeNull();
      expect(honestyCorrection(sentence, [])).toMatch(/^Correction: I didn't actually/);
    });
  }
  it('app-side actions in the turn count (e.g. the spoken-address opener)', () => {
    expect(honestyCorrection('I opened tv.youtube.com.', [LOCAL_ACTION('open')])).toBeNull();
  });
});
