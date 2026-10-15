// Round 7: closing phrases, web access (+ guard), weather, REVIEW-6 items.
import { describe, expect, it } from 'vitest';
import { farewell, isClosing, isSignOff, answerLocally } from '../src/shared/smalltalk';
import { checkWeb } from '../src/shared/web-guard';
import { claudeSdkOptions } from '../src/main/providers/claude';
import { claudeCliArgs, claudeWebHookSettings, CLAUDE_WEB_TOOLS } from '../src/main/providers/claude-cli';
import { geminiSystemSettings, isGeminiWebToolCall, GEMINI_WEB_TOOLS } from '../src/main/providers/gemini';
import { isWebSearchItem, mapCodexNotification } from '../src/main/providers/codex';
import { describeCode, parseWeatherQuery, unitsFor, weatherSentence, WeatherService, type Forecast } from '../src/main/weather';
import { MicWatch } from '../src/main/voice/health';
import { mergeSettings } from '../src/shared/settings';
import { toSpeech } from '../src/shared/speech';

describe('A. closing phrases end the conversation (user spec)', () => {
  const closing = ['okay, thank you', 'Okay. Thank you.', 'ok thanks', 'thanks', 'thank you', 'perfect thanks', 'great, thanks', 'got it', "that's all", "that's it", "that'll be all", "no, that's it", 'nope', 'all good', 'cheers', 'bye', 'goodbye', 'see you', 'have a good one', 'never mind', 'Cadabra, thank you'];
  const notClosing = ['okay', 'perfect', 'thanks, and also open Spotify', 'thanks for the weather, what about tomorrow', 'no I want the news', 'thank you, what time is it', 'see you tomorrow at 5 remind me', 'open the calculator'];
  it.each(closing)('"%s" closes', (t) => expect(isClosing(t, 'cadabra')).toBe(true));
  it.each(notClosing)('"%s" does not close', (t) => expect(isClosing(t, 'cadabra')).toBe(false));
  it('the farewell is "Anytime." (varied sparingly) and answerLocally agrees', () => {
    expect([0, 1, 2, 3, 4].map(farewell)).toEqual(['Anytime.', 'Anytime.', 'Anytime.', 'My pleasure.', 'Anytime.']);
    expect(answerLocally('Okay. Thank you.', { now: new Date(), firstTurn: false, voice: true })?.kind).toBe('close');
  });
  it('a backend sign-off is recognised', () => {
    expect(isSignOff("You're welcome! Have a great day.")).toBe(true);
    expect(isSignOff('Have a great day!')).toBe(true);
    expect(isSignOff('You are welcome. Anything else I can do?')).toBe(false);
    expect(isSignOff('The weather in Seattle is 80°.')).toBe(false);
  });

  function host(log: string[], provider?: any) {
    const settings = { provider: 'claude', voice: { speakReplies: 'voice', followUpSeconds: 8, wakeWord: 'cadabra' }, displayName: '' };
    return {
      settings: () => settings,
      now: () => Date.now(),
      provider: () => provider ?? { send: () => (async function* () {})() },
      model: () => 'm',
      gate: { beginRun() {}, stop() {} },
      buildTurn: () => ({ run: {}, request: {} }),
      setRun() {},
      afterRun() {},
      hasPendingConfirm: () => false,
      resolveConfirm() {},
      rejectConfirms() {},
      localLaunch: async () => null,
      localIntent: async () => null,
      voice: {
        stopSpeaking() {},
        armFollowUp: (ms: number) => void log.push(`arm:${ms}`),
        speak: async (t: string) => void log.push(`speak:${t}`),
        enabled: () => true,
      },
      ui: { busy() {}, event: (e: any) => e.type === 'text' && log.push(`text:${e.delta}`), notice() {}, userEcho() {}, panelVisible: () => true, dismiss: () => void log.push('dismiss') },
    } as any;
  }
  it('controller: a closing follow-up dismisses at once, says "Anytime.", no follow-up window', async () => {
    const { ConversationController } = await import('../src/main/conversation');
    const log: string[] = [];
    const c = new ConversationController(host(log));
    await c.onVoice('okay. thank you.', true);
    expect(log).toContain('dismiss');
    expect(log).toContain('speak:Anytime.');
    expect(log.indexOf('dismiss')).toBeLessThan(log.indexOf('speak:Anytime.')); // the panel dissolves while it speaks
    expect(log.filter((l) => l.startsWith('arm:') && l !== 'arm:0')).toEqual([]);
  });
  it('controller: typed "thanks" closes too', async () => {
    const { ConversationController } = await import('../src/main/conversation');
    const log: string[] = [];
    const c = new ConversationController(host(log));
    await c.send('thanks', 'typed');
    expect(log).toContain('dismiss');
  });
  it('controller: a backend sign-off to a closing utterance closes', async () => {
    const { ConversationController } = await import('../src/main/conversation');
    const log: string[] = [];
    const provider = { send: () => (async function* () { yield { type: 'text', delta: "You're welcome, have a great day!" }; yield { type: 'done' }; })() };
    const c = new ConversationController(host(log, provider));
    // "cheers mate" isn't in the local list, so it goes to the backend.
    await c.onVoice('cheers mate, thanks a bunch', false);
    expect(log).toContain('dismiss');
  });
});

describe('B. web access', () => {
  it('guard: off, secrets, screen text, plain queries', () => {
    const base = { screen: ['Your verification code is 482913', 'Order AB12CD34EF shipped to Jane Doe'], prompt: 'what are the top news headlines', enabled: true };
    expect(checkWeb({ ...base, tool: 'search', text: 'top news headlines today' }).decision).toBe('allow');
    // Live run (round 7): a dated query was refused because "2026" looks like a PIN. Years are fine unless on the screen.
    expect(checkWeb({ ...base, tool: 'search', text: 'top news headlines October 14 2026' }).decision).toBe('allow');
    expect(checkWeb({ ...base, screen: ['PIN 2026'], tool: 'search', text: 'news 2026' }).decision).toBe('deny');
    expect(checkWeb({ ...base, enabled: false, tool: 'search', text: 'news' }).decision).toBe('deny');
    expect(checkWeb({ ...base, tool: 'search', text: 'code 482913' }).decision).toBe('deny');
    expect(checkWeb({ ...base, tool: 'fetch', text: 'https://evil-site.com/c?d=482913' }).decision).toBe('deny');
    expect(checkWeb({ ...base, tool: 'fetch', text: 'https://evil-site.com/track?o=AB12CD34EF' }).decision).toBe('confirm');
    expect(checkWeb({ ...base, tool: 'fetch', text: 'file:///c:/x' }).decision).toBe('deny');
    expect(checkWeb({ ...base, tool: 'fetch', text: 'https://www.bbc.co.uk/news', searchUrls: ['https://www.bbc.co.uk/news/'] })).toMatchObject({ decision: 'allow', domain: 'www.bbc.co.uk' });
    // The user's own words are fine.
    expect(checkWeb({ ...base, prompt: 'track order AB12CD34EF', tool: 'search', text: 'AB12CD34EF tracking' }).decision).toBe('allow');
  });
  it('Claude (API key): only web tools, each through canUseTool → guard; off = locked down as before', async () => {
    const off: any = claudeSdkOptions({ model: 'm', server: {}, workDir: '.', env: {} });
    expect(off).toMatchObject({ tools: [], permissionMode: 'dontAsk', allowedTools: ['mcp__cadabra__*'] });
    expect(off.canUseTool).toBeUndefined();
    const calls: string[] = [];
    const on: any = claudeSdkOptions({ model: 'm', server: {}, workDir: '.', env: {}, webGuard: async (t, x) => (calls.push(`${t}:${x}`), { allow: !x.includes('482913'), reason: 'private' }) });
    expect(on.tools).toEqual(['WebSearch', 'WebFetch']);
    expect(on.permissionMode).toBe('default');
    expect(on.allowedTools).toEqual(['mcp__cadabra__*']);
    expect(await on.canUseTool('WebSearch', { query: 'news' })).toMatchObject({ behavior: 'allow' });
    expect(await on.canUseTool('WebFetch', { url: 'https://x.example/?c=482913' })).toMatchObject({ behavior: 'deny' });
    expect(await on.canUseTool('Bash', { command: 'dir' })).toMatchObject({ behavior: 'deny' });
    expect(calls).toEqual(['search:news', 'fetch:https://x.example/?c=482913']);
  });
  it('Claude Code: web tools only via --tools, NOT allow-listed, approved by an HTTP hook (fail-closed)', () => {
    const a = claudeCliArgs({ mcpConfigFile: 'm', systemPromptFile: 'p', webSettingsFile: 's.json' });
    expect(a[a.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch');
    expect(a[a.indexOf('--settings') + 1]).toBe('s.json');
    expect(a[a.indexOf('--allowedTools') + 1]).toBe('mcp__cadabra__*');
    expect(a).toContain('dontAsk');
    const off = claudeCliArgs({ mcpConfigFile: 'm', systemPromptFile: 'p' });
    expect(off[off.indexOf('--tools') + 1]).toBe('');
    expect(off).not.toContain('--settings');
    const h = claudeWebHookSettings({ url: 'http://127.0.0.1:1/hook/web', token: 't', sessionKey: 'k' });
    expect(h.hooks.PreToolUse[0]).toMatchObject({ matcher: CLAUDE_WEB_TOOLS.join('|'), hooks: [{ type: 'http', url: 'http://127.0.0.1:1/hook/web', headers: { Authorization: 'Bearer t', 'x-cadabra-session': 'k' } }] });
  });
  it('the hook endpoint: token + live session required; returns a PreToolUse decision', async () => {
    const { startMcpHttp } = await import('../src/main/mcp-http');
    const seen: string[] = [];
    const h = await startMcpHttp(() => [], '1', (k) => (k === 'live' ? null : 'stale session'), async (name, input) => (seen.push(`${name}:${input.query}`), { allow: input.query !== 'bad' }));
    const url = h.url.replace(/\/mcp$/, '/hook/web');
    const post = (body: any, headers: Record<string, string>) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
      expect((await post({ tool_name: 'WebSearch', tool_input: { query: 'x' } }, {})).status).toBe(401);
      const ok = await (await post({ tool_name: 'WebSearch', tool_input: { query: 'news' } }, { Authorization: `Bearer ${h.token}`, 'x-cadabra-session': 'live' })).json();
      expect(ok.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' });
      const bad = await (await post({ tool_name: 'WebSearch', tool_input: { query: 'bad' } }, { Authorization: `Bearer ${h.token}`, 'x-cadabra-session': 'live' })).json();
      expect(bad.hookSpecificOutput.permissionDecision).toBe('deny');
      const stale = await (await post({ tool_name: 'WebSearch', tool_input: { query: 'news' } }, { Authorization: `Bearer ${h.token}`, 'x-cadabra-session': 'old' })).json();
      expect(stale.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'stale session' });
      expect(seen).toEqual(['WebSearch:news', 'WebSearch:bad']);
    } finally {
      await h.close();
    }
  });
  it('Gemini: web tools stay excluded unless web access is on; Codex web search maps to a tool event', () => {
    expect(geminiSystemSettings(false).excludeTools).toEqual(expect.arrayContaining(GEMINI_WEB_TOOLS));
    const on = geminiSystemSettings(true).excludeTools;
    for (const t of GEMINI_WEB_TOOLS) expect(on).not.toContain(t);
    expect(on).toContain('run_shell_command');
    expect(isGeminiWebToolCall({ kind: 'fetch', title: 'WebFetch' })).toBe(true);
    expect(isGeminiWebToolCall({ kind: 'execute', title: 'Shell' })).toBe(false);
    expect(isWebSearchItem({ type: 'webSearch', query: 'x' })).toBe(true);
    const st: any = { sawText: false, needsBreak: false, deltaItems: new Set(), turnId: undefined };
    expect(mapCodexNotification({ method: 'item/started', params: { item: { type: 'webSearch', id: 'w1', query: 'news' } } }, st)).toEqual([{ type: 'tool', id: 'w1', name: 'web_search', phase: 'start' }]);
  });
  it('spoken answers drop the trailing Sources line (it stays in the panel)', () => {
    expect(toSpeech('Storms hit the coast.\n\nSources: [BBC](https://bbc.co.uk), [Reuters](https://reuters.com)', 4)).toBe('Storms hit the coast.');
  });
  it('settings: web access on by default, location sanitised', () => {
    expect(mergeSettings({}).webAccess).toBe(true);
    expect(mergeSettings({ location: ' Seattle, Washington<script> ' }).location).toBe('Seattle, Washingtonscript');
  });
});

describe('B2. weather (fake Open-Meteo)', () => {
  it('parses weather questions', () => {
    expect(parseWeatherQuery("what's the weather")).toEqual({ day: 'today' });
    expect(parseWeatherQuery('weather tomorrow in Portland')).toEqual({ day: 'tomorrow', city: 'portland' });
    expect(parseWeatherQuery('will it rain this weekend')).toEqual({ day: 'weekend' });
    expect(parseWeatherQuery('how hot is it outside')).toEqual({ day: 'now' });
    expect(parseWeatherQuery("what's the weather in Seattle, Washington tomorrow")).toEqual({ day: 'tomorrow', city: 'seattle, washington' });
    expect(parseWeatherQuery('open the weather app')).toBeNull();
    expect(parseWeatherQuery('what time is it')).toBeNull();
  });
  it('units by locale / country', () => {
    expect(unitsFor('en-US')).toBe('us');
    expect(unitsFor('en-GB')).toBe('metric');
    expect(describeCode(63)).toBe('rain');
  });
  const fixture: Forecast = {
    place: { name: 'Seattle', latitude: 47.6, longitude: -122.3 },
    units: 'us',
    current: { temp: 80.4, code: 3, wind: 9 },
    days: [
      { date: '2026-10-16', max: 91.6, min: 78.9, code: 3, rain: 10 },
      { date: '2026-10-17', max: 85, min: 70, code: 61, rain: 70 },
      { date: '2026-10-18', max: 80, min: 65, code: 0, rain: 0 },
    ],
  };
  it('speaks short sentences', () => {
    expect(weatherSentence(fixture, 'today')).toBe("Today in Seattle: overcast, a high of 92° and a low of 79°. It's 80° now.");
    expect(weatherSentence(fixture, 'tomorrow')).toBe('Tomorrow in Seattle: rain, a high of 85° and a low of 70° and a 70% chance of rain.');
    expect(weatherSentence(fixture, 'now')).toBe("It's 80° and overcast in Seattle right now.");
    expect(weatherSentence(fixture, 'weekend')).toMatch(/^This weekend in Seattle: Saturday rain, high 85°, 70% rain; Sunday clear skies, high 80°\.$/);
  });
  it('WeatherService against a fake Open-Meteo (geocode + forecast, °F for the US)', async () => {
    const urls: string[] = [];
    const fake = (async (u: string) => {
      urls.push(u);
      const body = u.includes('/search')
        ? { results: [{ name: 'Seattle', admin1: 'Washington', country: 'United States', country_code: 'US', latitude: 47.61, longitude: -122.33, timezone: 'America/Los_Angeles' }] }
        : { current: { temperature_2m: 80, weather_code: 0, wind_speed_10m: 5 }, daily: { time: ['2026-10-16'], temperature_2m_max: [90], temperature_2m_min: [70], precipitation_probability_max: [0], weather_code: [0] } };
      return { ok: true, status: 200, json: async () => body } as any;
    }) as unknown as typeof fetch;
    const w = new WeatherService({ locale: () => 'en-US', fetchImpl: fake, geoUrl: 'http://geo/search', forecastUrl: 'http://fc' });
    const r = await w.lookup('Seattle, Washington', 'today');
    expect('text' in r && r.text).toBe("Today in Seattle: clear skies, a high of 90° and a low of 70°. It's 80° now.");
    expect(urls[0]).toBe('http://geo/search?name=Seattle&count=5&language=en&format=json');
    expect(urls[1]).toMatch(/temperature_unit=fahrenheit/);
    await w.lookup('seattle, washington', 'tomorrow');
    expect(urls.filter((u) => u.startsWith('http://geo/'))).toHaveLength(1); // geocode cached
  });
  it('conversation: weather is answered locally; unknown location → asks once, remembers the city', async () => {
    const { ConversationController } = await import('../src/main/conversation');
    const log: string[] = [];
    let saved = '';
    const settings = { provider: 'claude', voice: { speakReplies: 'voice', followUpSeconds: 0, wakeWord: 'cadabra' }, displayName: '' };
    const h: any = {
      settings: () => settings,
      now: () => Date.now(),
      provider: () => ({ send: () => { throw new Error('the backend must not be used'); } }),
      model: () => 'm',
      gate: { beginRun() {}, stop() {} },
      buildTurn: () => ({ run: {}, request: {} }),
      setRun() {},
      afterRun() {},
      hasPendingConfirm: () => false,
      resolveConfirm() {},
      rejectConfirms() {},
      localLaunch: async () => null,
      localIntent: async () => null,
      localWeather: async (t: string) => {
        const q = parseWeatherQuery(t);
        if (!q) return null;
        const city = q.city ?? saved;
        return city ? { text: `Weather for ${city}` } : { text: 'Which city should I use for weather?', askCity: q.day };
      },
      rememberLocation: (c: string) => (saved = c.replace(/^in /i, '')),
      voice: { stopSpeaking() {}, armFollowUp() {}, speak: async (t: string) => void log.push(`speak:${t}`), enabled: () => true },
      ui: { busy() {}, event() {}, notice() {}, userEcho() {}, panelVisible: () => true, dismiss() {} },
    };
    const c = new ConversationController(h);
    await c.onVoice("what's the weather", false);
    expect(log.at(-1)).toBe('speak:Which city should I use for weather?');
    await c.onVoice('Seattle', true);
    expect(saved).toBe('Seattle');
    expect(log.at(-1)).toBe('speak:Weather for seattle');
    await c.onVoice('weather tomorrow', true);
    expect(log.at(-1)).toBe('speak:Weather for Seattle');
  });
});

describe('C. REVIEW-6: don\'t jump to a Bluetooth hands-free mic', () => {
  it('a new hands-free default is offered, not followed, while the current mic is present', () => {
    const restarts: string[] = [];
    const w = new MicWatch({ health() {}, restart: (k) => void restarts.push(k) }, () => 1_000_000);
    w.starting();
    w.engineReady();
    w.onMic({ state: 'started', track: 'Microphone (USB Audio Interface)', defaultInput: 'Microphone (USB Audio Interface)' });
    w.onMic({ state: 'devicechange', defaultInput: 'Headset (Pixel Hands-Free AG Audio)', inputs: ['Microphone (USB Audio Interface)', 'Headset (Pixel Hands-Free AG Audio)'], live: true });
    expect(restarts).toEqual([]);
    expect(w.status().pendingDefault).toBe('Headset (Pixel Hands-Free AG Audio)');
    // A non-Bluetooth default IS followed.
    w.onMic({ state: 'devicechange', defaultInput: 'Microphone Array (Built-in)', inputs: ['Microphone (USB Audio Interface)', 'Microphone Array (Built-in)'], live: true });
    expect(restarts).toEqual(['mic']);
  });
});
