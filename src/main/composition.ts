// Round 11.6 (REVIEW-11.5 wiring audit: focusedElement / inputState /
// windowInfo were never wired into the installed app for rounds 3–11, while
// the tests passed them): the helper-backed dependency objects the app builds
// live here as factories, so `test/composition.test.ts` can build them with a
// recording helper double and check that every member reaches the matching
// helper method. The key lists are checked against the types, so adding a
// member breaks the test until it's wired.
import type { HelperClient } from './helper';
import type { HelperLike } from './tools';
import type { LauncherDeps, WinInfo } from './apps/launcher';

/** The helper surface the ToolHost uses (all members required). */
export function toolHelperFor(h: () => HelperClient): HelperLike {
  return {
    capture: (p) => h().capture(p),
    uiTree: (p) => h().uiTree(p),
    elementInfo: (id) => h().elementInfo(id),
    click: (x, y, b, c) => h().click(x, y, b, c),
    typeText: (t) => h().typeText(t),
    pressKeys: (k, r) => h().pressKeys(k, r),
    scroll: (p) => h().scroll(p),
    invoke: (id) => h().invoke(id),
    setValue: (id, v) => h().setValue(id, v),
    focusElement: (id) => h().focusElement(id),
    foreground: (hwnd) => h().foreground(hwnd),
    windowRect: (hwnd) => h().windowRect(hwnd),
    elementAt: (x, y) => h().elementAt(x, y),
    windowAt: (x, y) => h().windowAt(x, y),
    focusedElement: () => h().focusedElement(),
    inputState: () => h().inputState(),
    windowInfo: (hwnd) => h().windowInfo(hwnd),
  };
}

/** Every ToolHost helper member, mapped to the HelperClient method it must reach. */
export const TOOL_HELPER_KEYS = {
  capture: 'capture',
  uiTree: 'uiTree',
  elementInfo: 'elementInfo',
  click: 'click',
  typeText: 'typeText',
  pressKeys: 'pressKeys',
  scroll: 'scroll',
  invoke: 'invoke',
  setValue: 'setValue',
  focusElement: 'focusElement',
  foreground: 'foreground',
  windowRect: 'windowRect',
  elementAt: 'elementAt',
  windowAt: 'windowAt',
  focusedElement: 'focusedElement',
  inputState: 'inputState',
  windowInfo: 'windowInfo',
} as const satisfies Record<keyof HelperLike, keyof HelperClient>;

/** The app launcher's window access (the shell parts come from Electron). */
export function launcherDepsFor(h: () => HelperClient, shell: { openPath(p: string): Promise<string>; openExternal(u: string): Promise<void> }): LauncherDeps {
  return {
    listWindows: () => h().call<WinInfo[]>('list_windows'),
    foreground: (hwnd) => h().foreground(hwnd),
    openPath: (p) => shell.openPath(p),
    openExternal: (u) => shell.openExternal(u),
  };
}

/** Greeter / lock / media / activity: the helper-backed session lookups. */
export interface SessionHelper {
  presence(): Promise<{ notificationState: string; speakerMuted: boolean | null } | null>;
  audioSessions(exclude: number[]): Promise<{ exe: string; peak: number }[]>;
  armActivity(on: boolean): Promise<{ hooks: boolean } | null>;
  lockWorkstation(): Promise<unknown>;
  inputState(): Promise<{ cursorShowing: boolean; idleMs: number } | null>;
}

/** No helper (it failed to start) → explicit nulls / empty lists, never a silent "ok". */
export function sessionHelperFor(h: () => HelperClient | null): SessionHelper {
  return {
    presence: async () => (h() ? h()!.presence() : null),
    audioSessions: async (exclude) => (h() ? ((await h()!.audioSessions(exclude))?.sessions ?? []) : []),
    armActivity: async (on) => (h() ? h()!.armActivity(on) : null),
    lockWorkstation: async () => {
      if (!h()) throw new Error('the helper isn’t running');
      return h()!.lockWorkstation();
    },
    inputState: async () => (h() ? h()!.inputState() : null),
  };
}

export const SESSION_HELPER_KEYS = {
  presence: 'presence',
  audioSessions: 'audioSessions',
  armActivity: 'armActivity',
  lockWorkstation: 'lockWorkstation',
  inputState: 'inputState',
} as const satisfies Record<keyof SessionHelper, keyof HelperClient>;
