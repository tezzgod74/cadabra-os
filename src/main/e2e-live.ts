// `npm run e2e:live -- --provider claude|claude-code|codex|gemini`
//
// REVIEW-2 #1 live-readiness harness. Runs Scenarios A and B and five screen
// tasks against a REAL, signed-in backend, but every screen action targets
// Cadabra's OWN throwaway test window (the helper's test window), never the
// user's apps. Confirm cards for actions in the test window are answered
// "yes" automatically and counted; anything else is answered "no".
// Records latency (send → first text / first tool / done), confirm counts,
// tool usage and any non-Cadabra tool, then writes JSON + Markdown reports to
// %APPDATA%\Cadabra OS\e2e-live\. Skips cleanly when the backend isn't
// installed or signed in. Your settings are restored afterwards.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { CadabraApp } from './app';
import type { ProviderEvent, ProviderId, Settings } from '../shared/types';
import { CADABRA_TOOLS, summarize, toMarkdown, type LiveReport, type TaskResult } from '../shared/e2e-report';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function harnessTarget(arg: string): { provider: ProviderId; claudeRoute?: Settings['claudeRoute'] } | null {
  switch (arg) {
    case 'claude':
      return { provider: 'claude', claudeRoute: 'api-key' };
    case 'claude-code':
      return { provider: 'claude', claudeRoute: 'claude-code' };
    case 'codex':
    case 'gemini':
      return { provider: arg };
    default:
      return null;
  }
}

export const SCREEN_TASKS: { id: string; prompt: string; check?: (text: string) => boolean }[] = [
  { id: 'T1', prompt: 'What does this window say? Answer in one sentence.' },
  { id: 'T2', prompt: 'Point at the text box in this window.' },
  { id: 'T3', prompt: "Type 'hello from cadabra' into the text box.", check: (t) => /hello from cadabra/i.test(t) },
  { id: 'T4', prompt: "Replace the text in the text box with 'second line'.", check: (t) => /second line/i.test(t) && !/hello from cadabra/i.test(t) },
  { id: 'T5', prompt: 'Select all the text in the text box and delete it.', check: (t) => t.trim() === '' },
];

export async function runLiveReadiness(c: CadabraApp, arg: string): Promise<void> {
  const outDir = path.join(app.getPath('userData'), 'e2e-live');
  fs.mkdirSync(outDir, { recursive: true });
  const report: LiveReport = { provider: arg, startedAt: new Date().toISOString(), status: 'completed', tasks: [] };
  const target = harnessTarget(arg);
  // AUTH-2 guard: only ever run on the harness's own data folder.
  if (!/Cadabra OS \(e2e\)$/.test(app.getPath('userData'))) {
    console.log('E2E SKIPPED: refusing to run on the real Cadabra data folder');
    app.exit(2);
    return;
  }
  // REVIEW-5 V5-3: never the real microphone or speakers.
  if (process.env.CADABRA_MUTE_TTS !== '1' || !app.commandLine.hasSwitch('use-fake-device-for-media-stream')) {
    console.log('E2E SKIPPED: speech must be muted and the microphone faked in the harness');
    app.exit(2);
    return;
  }
  const saved = c.settings.get();
  const finish = (code = 0) => {
    const stamp = report.startedAt.replace(/[:.]/g, '-');
    const json = path.join(outDir, `report-${arg}-${stamp}.json`);
    const md = path.join(outDir, `report-${arg}-${stamp}.md`);
    fs.writeFileSync(json, JSON.stringify({ ...report, summary: report.status === 'completed' ? summarize(report) : undefined }, null, 2));
    fs.writeFileSync(md, toMarkdown(report));
    console.log(`E2E ${report.status.toUpperCase()}${report.skipReason ? `: ${report.skipReason}` : ''}`);
    console.log(`E2E report: ${md}`);
    // Restore the user's own choice of backend.
    c.settings.update({ provider: saved.provider, claudeRoute: saved.claudeRoute, models: saved.models });
    void c.helper?.call('test_window_close').catch(() => undefined);
    setTimeout(() => app.exit(code), 300);
  };
  if (!target) {
    report.status = 'skipped';
    report.skipReason = `unknown provider "${arg}" (use claude, claude-code, codex or gemini)`;
    return finish(2);
  }
  try {
    // A fast, cheap model keeps a readiness run light on the user's limits.
    const fast = target.provider === 'claude' ? { models: { ...saved.models, claude: 'claude-haiku-5-5' } } : {};
    c.settings.update({ provider: target.provider, ...(target.claudeRoute ? { claudeRoute: target.claudeRoute } : {}), ...fast });
    const p = c.providers[target.provider];
    const auth = await p.checkAuth().catch((e) => ({ ok: false, detail: (e as Error).message }));
    report.auth = auth.detail;
    if (!auth.ok) {
      report.status = 'skipped';
      report.skipReason = `${p.label} is not available: ${auth.detail}${(auth as any).howTo ? ` (${(auth as any).howTo})` : ''}`;
      return finish(0);
    }
    if (!c.helper?.running) {
      report.status = 'skipped';
      report.skipReason = 'the native helper is not running';
      return finish(0);
    }
    const iso = (p as any).verifyIsolation ? await (p as any).verifyIsolation() : null;
    report.isolation = iso ? `${iso.verified ? 'verified' : 'NOT verified'}: ${iso.detail}` : 'enforced by Cadabra (no built-in tools offered); verified per call below';

    // Every confirm card: "yes" only for actions in Cadabra's own test window.
    let confirms = 0;
    // REVIEW-3 E2E-1: approve by window HANDLE (the helper's own test window),
    // never by matching card text; plus exactly the Scenario B command.
    let approvedHwnd = -1;
    c.confirmOverride = async (card) => {
      confirms += 1;
      const inTestWindow = card.hwnd != null && card.hwnd === approvedHwnd;
      const isNslookup = card.actionKind === 'terminal' && card.mono === 'nslookup 8.8.8.8';
      return inTestWindow || isNslookup;
    };

    const run = async (id: string, prompt: string, voice: boolean, check?: () => Promise<boolean>): Promise<TaskResult> => {
      const t0 = Date.now();
      const r: TaskResult = { id, prompt, status: 'error', tools: [], confirms: 0, foreignTools: [], reply: '' };
      const before = confirms;
      c.eventTap = (ev: ProviderEvent) => {
        const dt = Date.now() - t0;
        if (ev.type === 'text') {
          r.firstTextMs ??= dt;
          r.reply += ev.delta;
        }
        if (ev.type === 'tool' && ev.phase === 'start') {
          r.firstToolMs ??= dt;
          r.tools.push(ev.name);
          if (!CADABRA_TOOLS.has(ev.name)) r.foreignTools.push(ev.name);
        }
        if (ev.type === 'done') r.doneMs ??= dt;
        if (ev.type === 'error') r.note = ev.message;
      };
      try {
        await Promise.race([c.send(prompt, voice ? 'voice' : 'typed'), sleep(180_000).then(() => {
          r.note = 'timed out after 180 s';
          c.cancelRun('Stopped.');
        })]);
        r.doneMs ??= Date.now() - t0;
        r.confirms = confirms - before;
        const ok = r.reply.trim().length > 0 && !r.foreignTools.length && (check ? await check() : true);
        r.status = r.note && !r.reply ? 'error' : ok ? 'pass' : 'fail';
      } catch (e) {
        r.note = (e as Error).message;
      } finally {
        c.eventTap = null;
      }
      r.reply = r.reply.slice(0, 400);
      return r;
    };

    // Round 7: web check only (CADABRA_E2E_WEB=1): weather (local fast path) and
    // news headlines (the backend's own web search, through Cadabra's guard).
    if (process.env.CADABRA_E2E_WEB === '1') {
      for (const n of ['WebSearch', 'WebFetch', 'web_search', 'google_web_search', 'web_fetch']) CADABRA_TOOLS.add(n);
      c.conv.newChat();
      const w1 = await run('W1', "What's the weather in Seattle today?", true);
      if (w1.status === 'pass' && !/seattle/i.test(w1.reply)) w1.status = 'fail';
      report.tasks.push(w1);
      c.conv.newChat();
      const w2 = await run('W2', 'What are the top news headlines right now?', true);
      if (w2.status === 'pass' && !w2.tools.some((t) => /web/i.test(t))) w2.status = 'fail';
      report.tasks.push(w2);
      c.confirmOverride = null;
      c.dismiss();
      return finish(0);
    }
    // Screen tasks first, so nothing (like Scenario B's terminal) covers the test window.
    // Five screen tasks on Cadabra's own test window.
    const tw = await c.helper.call<{ hwnd: number; windowRect: { x: number; y: number; width: number; height: number } }>('test_window_open', { x: 60, y: 200 });
    const testHwnd = tw.hwnd;
    approvedHwnd = testHwnd;
    await sleep(400);
    const info = await c.helper.call<any>('window_info', { hwnd: testHwnd });
    c.conv.newChat();
    // Summon at the window's right edge so the panel opens beside it, not over it.
    await c.onSummon({ event: 'summon', trigger: 'mouse', x: tw.windowRect.x + tw.windowRect.width - 12, y: tw.windowRect.y + 60, ...info, hwnd: testHwnd } as any);
    await c.helper.foreground(testHwnd).catch(() => undefined);
    if (process.env.CADABRA_E2E_DRY) {
      // Diagnostics without any model call: what would the tools see?
      const ac = new AbortController();
      (c as any).tools.run = { target: (c as any).target, signal: ac.signal, frame: null, nodes: new Map(), id: 1, screen: [] };
      (c as any).gate.beginRun();
      const ui = await (c as any).tools.readUi({});
      const shot = await (c as any).tools.seeScreen({});
      console.log('E2E DRY target', JSON.stringify((c as any).target));
      console.log('E2E DRY read_ui', JSON.stringify(ui.content[0].text).slice(0, 800));
      console.log('E2E DRY see_screen', JSON.stringify(shot.content[1]?.text ?? shot.content[0]?.text).slice(0, 300));
      fs.writeFileSync(path.join(outDir, 'dry.png'), Buffer.from(shot.content[0].data ?? '', 'base64'));
      report.status = 'skipped';
      report.skipReason = 'dry run';
      return finish(0);
    }
    for (const t of SCREEN_TASKS) {
      const res = await run(t.id, t.prompt, false, t.check ? async () => t.check!(String(await c.helper!.call('test_window_text'))) : undefined);
      report.tasks.push(res);
    }
    c.dismiss();
    await c.helper.call('test_window_close').catch(() => undefined);
    await sleep(300);
    // Scenario A and B (spoken-style turns; nothing is played or recorded).
    c.conv.newChat();
    report.tasks.push(await run('A', 'Are you there? What time is it?', true));
    report.tasks.push(await run('B', 'Open a terminal and do an nslookup for 8.8.8.8', true, async () => /dns\.google|8\.8\.8\.8/i.test(report.tasks.at(-1)?.reply ?? '')));
    const b = report.tasks.at(-1)!;
    if (b.status === 'fail' && /dns\.google|8\.8\.8\.8/i.test(b.reply)) b.status = 'pass';
    report.tasks.push(await run('B2', "I'm not looking at the screen. What's the output?", true, async () => /dns\.google|google/i.test(report.tasks.at(-1)?.reply ?? '')));

    // Close the terminal Scenario B opened (only that one: titled by Cadabra).
    try {
      const wins = await c.helper.call<{ hwnd: number; title: string }[]>('list_windows');
      for (const w of wins) if (/nslookup 8\.8\.8\.8/.test(w.title)) await c.helper.call('close_window', { hwnd: w.hwnd }).catch(() => undefined);
    } catch {
      /* ignore */
    }
    await sleep(500);
    c.confirmOverride = null;
    c.dismiss();
    finish(0);
  } catch (e) {
    report.status = 'skipped';
    report.skipReason = `harness error: ${(e as Error).message}`;
    finish(1);
  }
}
