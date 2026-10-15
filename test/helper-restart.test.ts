// REVIEW-1 H1/H4: after the helper process dies it is restarted, announces
// 'ready' again, and the state the app pushes on 'ready' (here: a custom
// summon binding) is back in force. Uses the real helper with --no-hook.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HelperClient } from '../src/main/helper';
import { bindingToHelper } from '../src/shared/binding';

const exe = path.resolve('native/cadabra-helper/target/release/cadabra-helper.exe');

describe.skipIf(!fs.existsSync(exe))('helper restart re-applies state', () => {
  it('a custom binding survives a helper crash', async () => {
    const h = new HelperClient(exe, ['--no-hook']);
    const custom = { kind: 'key' as const, ctrl: true, alt: true, shift: false, win: false, vk: 0x4a, key: 'J' };
    let readies = 0;
    // What CadabraApp.applyHelperState does on every 'ready'.
    h.on('ready', () => {
      readies++;
      void h.call('set_binding', bindingToHelper(custom));
    });
    const restarting = new Promise<void>((r) => h.once('restarting', () => r()));
    await h.start();
    await new Promise((r) => setTimeout(r, 150));
    expect((await h.call('binding_status')).vk).toBe(0x4a);

    (h as any).proc.kill(); // simulate a crash
    await restarting;
    await new Promise<void>((r) => {
      const t = setInterval(() => {
        if (readies >= 2 && h.running) {
          clearInterval(t);
          r();
        }
      }, 50);
    });
    await new Promise((r) => setTimeout(r, 150));
    const st = await h.call('binding_status');
    expect(st.vk).toBe(0x4a); // not the default 0xC0
    expect(st.mods & 3).toBe(3); // ctrl + alt
    await h.stop();
  }, 20_000);

  it('calls after the helper died reject instead of throwing EPIPE', async () => {
    const h = new HelperClient(exe, ['--no-hook']);
    await h.start();
    await h.stop();
    await new Promise((r) => setTimeout(r, 500));
    await expect(h.call('ping')).rejects.toThrow();
  }, 10_000);
});
