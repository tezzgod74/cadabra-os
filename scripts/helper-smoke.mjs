// Smoke test for the native helper. Input injection ONLY targets the helper's
// own throwaway test window, and is skipped unless that window is verified to
// be the foreground window.
//   node scripts/helper-smoke.mjs [--no-input]
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';

const exe = path.resolve('native/cadabra-helper/target/release/cadabra-helper.exe');
if (!existsSync(exe)) {
  console.error('helper not built:', exe);
  process.exit(1);
}
const noInput = process.argv.includes('--no-input');
const withHook = process.argv.includes('--hook');
const child = spawn(exe, withHook ? [] : ['--no-hook'], { stdio: ['pipe', 'pipe', 'inherit'] });
let hookStatus = null;
const summons = [];
const rl = createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.event) {
    console.log('event:', msg.event, msg.status ?? '');
    if (msg.event === 'hook') hookStatus = msg.status;
    if (msg.event === 'summon') summons.push(msg);
  }
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`);
  if (!ok) failures++;
};

try {
  check('ping', (await call('ping')) === 'pong');
  if (withHook) {
    await sleep(300);
    check('LL hooks installed', hookStatus === 'installed', String(hookStatus));
    check('reinstall_hooks', (await call('reinstall_hooks')) === true);
    await sleep(100);
  }
  const mons = await call('monitors');
  check('monitors', Array.isArray(mons) && mons.length > 0, JSON.stringify(mons.map((m) => ({ ...m.rect, scale: m.scale }))));
  const cur = await call('cursor_pos');
  check('cursor_pos', typeof cur.x === 'number');
  const ist = await call('input_state');
  check('input_state (KVM hint, read-only)', typeof ist.cursorShowing === 'boolean' && typeof ist.idleMs === 'number', JSON.stringify(ist));

  const tw = await call('test_window_open', { x: 240, y: 240 });
  check('test_window_open', tw.hwnd > 0, JSON.stringify(tw.windowRect));
  await sleep(300);
  const info = await call('window_info', { hwnd: tw.hwnd });
  check('window_info', info.title === 'Cadabra helper test window', `${info.process} dpi=${info.dpi}`);
  check('window_info elevated=false (same integrity)', info.elevated === false, String(info.elevated));

  const tree = await call('ui_tree_at', { hwnd: tw.hwnd });
  const editNode = tree.nodes.find((n) => n.role === 'edit');
  check('ui_tree_at(hwnd)', tree.nodes.length > 0 && !!editNode, `nodes=${tree.nodes.length} roles=${[...new Set(tree.nodes.map((n) => n.role))].join(',')}`);

  const t0 = Date.now();
  const cap = await call('capture', { hwnd: tw.hwnd, maxSize: 800 });
  check('capture(hwnd)', cap.png.length > 100 && cap.width > 0, `${cap.width}x${cap.height} scale=${cap.scale.toFixed(2)} ${cap.bytes}B ${Date.now() - t0}ms`);
  const capWin = await call('capture', { hwnd: tw.hwnd, mode: 'window', maxSize: 800 });
  check('capture(hwnd, PrintWindow)', capWin.png.length > 100);

  if (editNode) {
    await call('set_value', { id: editNode.id, value: 'set via UIA' });
    check('set_value (UIA ValuePattern)', (await call('test_window_text')) === 'set via UIA');
  }

  if (!noInput) {
    const fg = await call('foreground', { hwnd: tw.hwnd });
    await sleep(200);
    if (fg.foreground !== tw.hwnd) {
      console.log('SKIP input tests: test window is not foreground (focus-steal prevention); not injecting input.');
    } else {
      const r = tw.editRect;
      const before = await call('cursor_pos');
      await call('click', { x: r.x + r.width / 2, y: r.y + r.height / 2 });
      const after = await call('cursor_pos');
      check('click restores cursor', before.x === after.x && before.y === after.y);
      const fg2 = await call('window_info', { hwnd: tw.hwnd });
      void fg2;
      // classic multi-line EDIT has no Ctrl+A; clear through UIA instead
      if (editNode) await call('set_value', { id: editNode.id, value: '' });
      await call('press_keys', { keys: 'end' });
      await call('type_text', { text: 'Hello, Cadabra ✨' });
      await sleep(150);
      const txt = await call('test_window_text');
      check('type_text (unicode)', txt === 'Hello, Cadabra ✨', JSON.stringify(txt));
      await call('press_keys', { keys: 'backspace', repeat: 2 });
      await sleep(100);
      const txt2 = await call('test_window_text');
      check('press_keys repeat', txt2 === 'Hello, Cadabra', JSON.stringify(txt2));
      // B1/H3: a long type_text can be cancelled mid-way, and other calls aren't queued behind it.
      if (editNode) await call('set_value', { id: editNode.id, value: '' });
      const longText = 'x'.repeat(1500);
      const t0 = Date.now();
      const typing = call('type_text', { text: longText, delayMs: 10 }, 60000).then(
        () => 'finished',
        (e) => String(e.message),
      );
      await sleep(400);
      const tq = Date.now();
      await call('window_info', { hwnd: tw.hwnd });
      const queryMs = Date.now() - tq;
      const tc = Date.now();
      await call('cancel');
      const cancelMs = Date.now() - tc;
      const typingResult = await typing;
      const stoppedAfter = Date.now() - t0;
      const typed = (await call('test_window_text')).length;
      check('window_info answers while type_text runs (concurrent lanes)', queryMs < 300, `${queryMs} ms`);
      check('cancel RPC answers immediately', cancelMs < 300, `${cancelMs} ms`);
      check('type_text stops on cancel', /cancelled/.test(typingResult) && typed < 1500 && stoppedAfter < 3000, `${typingResult}; typed ${typed}/1500 in ${stoppedAfter} ms`);
      if (editNode) await call('set_value', { id: editNode.id, value: 'Hello, Cadabra' });
      await call('press_keys', { keys: 'ctrl+end' });
      if (withHook) {
        // Summon shortcut through the real WH_KEYBOARD_LL hook. Injected input is
        // normally ignored; allowInjected is a test-only switch. Only our own
        // test window is foreground here.
        await call('set_binding', { kind: 'key', vk: 0xc0, ctrl: true, alt: false, shift: false, win: false, anyShift: true, allowInjected: true });
        await sleep(150);
        await call('press_keys', { keys: 'ctrl+`' });
        await sleep(400);
        await call('press_keys', { keys: 'ctrl+shift+`' });
        await sleep(400);
        await call('press_keys', { keys: '`' });
        await sleep(300);
        const t3 = await call('test_window_text');
        check('Ctrl+` and Ctrl+Shift+` summon (trigger=key, foreground window)', summons.length === 2 && summons.every((e) => e.trigger === 'key' && e.hwnd === tw.hwnd), JSON.stringify(summons.map((e) => [e.trigger, e.hwnd === tw.hwnd])));
        check('combo swallowed, plain ` still types', t3 === 'Hello, Cadabra`', JSON.stringify(t3));
        const ms = await call('set_binding', { kind: 'mouse', button: 'right', ctrl: true, alt: false, shift: false, win: false });
        check('mouse binding installs mouse hook', ms.mouseHook === true);
        const back = await call('set_binding', { kind: 'key', vk: 0xc0, ctrl: true, alt: false, shift: false, win: false, anyShift: true });
        check('back to keyboard binding (mouse hook removed)', back.mouseHook === false && (await call('binding_status')).mouseHook === false);
        const caret = await call('caret_rect', { hwnd: tw.hwnd });
        check('caret_rect finds the edit caret', !!caret?.rect, JSON.stringify(caret));
      }
    }
  }
  const hitTree = await call('ui_tree_at', { x: tw.windowRect.x + 60, y: tw.windowRect.y + 80 });
  check('ui_tree_at(point) hit', !!hitTree.hit, JSON.stringify(hitTree.hit?.role));
  await call('test_window_close');
  check('unknown method errors', await call('nope').then(() => false, () => true));
} catch (e) {
  console.error('ERROR', e);
  failures++;
} finally {
  await call('shutdown').catch(() => {});
  setTimeout(() => child.kill(), 200);
}
console.log(failures ? `${failures} failure(s)` : 'all helper checks passed');
process.exitCode = failures ? 1 : 0;
