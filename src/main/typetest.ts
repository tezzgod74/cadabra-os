// Round 11: `--typetest` reproduces "Open Notepad and type 622322422" through
// the SAME tool calls the AI makes (find_apps → launch_app → type_text), with
// no AI. Test mode (fake mic, muted, no hooks). It refuses to run if Notepad is
// already open (it must never touch the user's windows), types only into the
// Notepad window it launched (the helper verifies it's in front before typing),
// then clears that text and closes the window without saving.
import { app } from 'electron';
import type { CadabraApp } from './app';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runTypeTest(c: CadabraApp) {
  const out: Record<string, unknown> = {};
  const A: any = c;
  const h = c.helper!;
  const cards: string[] = [];
  A.confirmOverride = async (p: { title: string }) => (cards.push(p.title), false);
  try {
    const wins: { hwnd: number; process: string; title: string }[] = await h.call('list_windows');
    if (wins.some((w) => /notepad\.exe$/i.test(w.process))) {
      console.log('TYPETEST', JSON.stringify({ skipped: 'Notepad is already open; not touching the user’s windows.' }));
      app.exit(0);
      return;
    }
    await c.appIndex.ready();
    const ctl = new AbortController();
    // As after a voice summon with nothing particular under the cursor.
    c.tools.run = { target: null, signal: ctl.signal, frame: null, nodes: new Map(), prompt: 'open notepad and type 622322422', id: 1 };
    c.gate.beginRun();
    const t = (r: any) => ({ ok: !r.isError, text: String(r.content?.[0]?.text ?? '').slice(0, 300) });
    const find = await c.tools.findApps({ query: 'notepad' });
    const id = /\[([^\]]+)\] Notepad \(/.exec(String((find.content[0] as any).text))?.[1];
    out.find = t(find);
    if (!id) throw new Error('Notepad not found in the app index');
    const launched = await c.tools.launchAppTool({ id, new_instance: true });
    out.launch = t(launched);
    out.targetAfterLaunch = c.tools.run?.target ? { process: c.tools.run.target.process, hasHwnd: !!c.tools.run.target.hwnd } : null;
    await sleep(800);
    const typed = await c.tools.typeText({ text: '622322422' });
    out.type = t(typed);
    out.cards = cards;
    // Clean up: only the Notepad window this test opened.
    const after: { hwnd: number; process: string; title: string; pid: number }[] = await h.call('list_windows');
    const mine = after.filter((w) => /notepad\.exe$/i.test(w.process));
    out.notepadWindows = mine.length;
    for (const w of mine) {
      const fg = (await h.foreground(w.hwnd).catch(() => null)) as { foreground?: number } | null;
      if (fg?.foreground === w.hwnd) {
        await h.pressKeys('ctrl+a');
        await h.pressKeys('delete');
        await sleep(200);
      }
      await h.call('close_window', { hwnd: w.hwnd }).catch(() => undefined);
    }
    await sleep(1500);
    const left: { process: string }[] = await h.call('list_windows');
    out.notepadLeftOpen = left.filter((w) => /notepad\.exe$/i.test(w.process)).length;
  } catch (e) {
    out.error = (e as Error).message;
  }
  console.log('TYPETEST', JSON.stringify(out, null, 1));
  app.exit(0);
}
