import { app, screen } from 'electron';
import type { CadabraApp } from './app';
import type { WinInfo } from './apps/launcher';
import { detectDisplayName } from './app';
import { resolveAppIcon } from './apps/icons';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `--apptest`: builds the app index on this machine, prints counts and a few
 * fuzzy matches, then launches ONLY Notepad (harmless built-in) through the
 * real launcher + launch magic, waits for its window, and closes that window.
 */
export async function runAppTest(c: CadabraApp) {
  const results: Record<string, unknown> = {};
  const t0 = Date.now();
  await c.appIndex.refresh();
  results.indexMs = Date.now() - t0;
  results.total = c.appIndex.apps.length;
  results.counts = c.appIndex.counts;
  results.matches = Object.fromEntries(
    ['notepad', 'calculator', 'calc', 'chrome', 'edge', 'vs code', 'spotify', 'steam', 'terminal', 'paint'].map((q) => [q, c.appIndex.find(q, 3).map((m) => `${m.app.name} [${m.app.source}] ${Math.round(m.score)}`)]),
  );
  // UX6: real icons (no launching): how many index entries resolve to an image.
  const sample = [...c.appIndex.apps.filter((a) => a.kind === 'aumid').slice(0, 15), ...c.appIndex.apps.filter((a) => a.kind !== 'aumid').slice(0, 25)];
  const ti = Date.now();
  const icons = await Promise.all(sample.map(async (a) => ({ a, url: await resolveAppIcon(a).catch(() => null) })));
  results.icons = {
    ms: Date.now() - ti,
    store: `${icons.filter((x) => x.a.kind === 'aumid' && x.url).length}/${icons.filter((x) => x.a.kind === 'aumid').length}`,
    classic: `${icons.filter((x) => x.a.kind !== 'aumid' && x.url).length}/${icons.filter((x) => x.a.kind !== 'aumid').length}`,
    calculator: !!(await resolveAppIcon(c.appIndex.find('calculator', 1)[0]?.app ?? sample[0]).catch(() => null)),
  };
  const notepad = c.appIndex.find('notepad', 3).find((m) => /^notepad$/i.test(m.app.name))?.app;
  results.notepadEntry = notepad ? { id: notepad.id, kind: notepad.kind, target: notepad.target } : null;
  if (notepad && c.helper?.running) {
    const before = new Set(((await c.helper.call<WinInfo[]>('list_windows')) ?? []).map((w) => w.hwnd));
    const tl = Date.now();
    results.launchMessage = await c.launchIndexed(notepad, false);
    results.launchMs = Date.now() - tl;
    await sleep(1500);
    const after = (await c.helper.call<WinInfo[]>('list_windows')) ?? [];
    const opened = after.filter((w) => !before.has(w.hwnd) && /notepad/i.test(w.process));
    results.newNotepadWindows = opened.map((w) => ({ title: w.title.replace(/.*- /, '… - '), process: w.process }));
    for (const w of opened) await c.helper.call('close_window', { hwnd: w.hwnd }).catch(() => undefined);
    await sleep(1200);
    const still = ((await c.helper.call<WinInfo[]>('list_windows')) ?? []).filter((w) => opened.some((o) => o.hwnd === w.hwnd));
    results.closedCleanly = still.length === 0;
  }
  results.displays = screen.getAllDisplays().length;
  results.detectedDisplayName = await detectDisplayName();
  console.log('APPTEST', JSON.stringify(results, null, 1));
  app.quit();
}
