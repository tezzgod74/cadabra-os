import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Rect } from '../shared/types';

export interface SummonEvent {
  event: 'summon';
  /** 'key' = keyboard shortcut (x,y = cursor), 'mouse' = mouse binding (x,y = click). */
  trigger?: 'key' | 'mouse';
  x: number;
  y: number;
  hwnd: number;
  title?: string;
  process?: string;
  className?: string;
  pid?: number;
  rect?: Rect;
  dpi?: number;
}

export interface UiNode {
  id: number;
  depth: number;
  role: string;
  name: string;
  rect: [number, number, number, number];
  aid?: string;
  value?: string;
  enabled?: boolean;
  focused?: boolean;
}

export interface UiTree {
  window: { hwnd: number; title: string; process: string; rect: Rect };
  hit: UiNode | null;
  nodes: UiNode[];
  truncated: boolean;
}

export interface Capture {
  png: string;
  width: number;
  height: number;
  scale: number;
  rect: Rect;
  bytes: number;
}

export interface MonitorInfo {
  rect: Rect;
  work: Rect;
  primary: boolean;
  dpi: number;
  scale: number;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * Client for native/cadabra-helper. Newline-delimited JSON-RPC over stdio.
 * Emits: 'summon' (SummonEvent), 'escape', 'hook' ({status}), 'exit', 'log'.
 */
export class HelperClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stopping = false;
  private restarts = 0;
  private readyPromise: Promise<void> | null = null;
  private everStarted = false;

  constructor(
    private readonly exePath: string,
    private readonly args: string[] = [],
  ) {
    super();
  }

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.stopping = false;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const proc = spawn(this.exePath, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.proc = proc;
      const startedAt = Date.now();
      // H2: a write racing the helper's death must not become an uncaught EPIPE.
      proc.stdin.on('error', (e) => this.emit('log', `helper stdin: ${e.message}`));
      proc.on('error', (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
        this.emit('log', `helper spawn error: ${e.message}`);
      });
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          this.emit('log', `helper: bad line ${line.slice(0, 200)}`);
          return;
        }
        if (msg.id != null) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message ?? 'helper error'));
          else p.resolve(msg.result);
          return;
        }
        switch (msg.event) {
          case 'ready':
            if (!settled) {
              settled = true;
              resolve();
              // H1: every (re)start announces itself so the app re-applies the
              // binding, push-to-talk, hook state and panel styling.
              this.emit('ready', { restart: this.everStarted });
              this.everStarted = true;
            }
            break;
          case 'summon':
            this.emit('summon', msg as SummonEvent);
            break;
          case 'key':
            if (msg.key === 'Escape') this.emit('escape');
            break;
          case 'hook':
            this.emit('hook', msg);
            break;
          case 'ptt':
            this.emit('ptt', !!msg.down);
            break;
          case 'activity':
            // Round 10: first keyboard / mouse input after arm_activity (the user is back).
            this.emit('activity', String(msg.source ?? ''));
            break;
          case 'session':
            // Round 8: lock / unlock / logon (WTS session notifications).
            this.emit('session', String(msg.kind ?? ''));
            break;
          default:
            this.emit('log', `helper event: ${line.slice(0, 300)}`);
        }
      });
      proc.stderr.on('data', (d) => this.emit('log', `helper stderr: ${String(d).trim()}`));
      proc.on('exit', (code) => {
        this.proc = null;
        this.readyPromise = null;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('helper exited'));
        }
        this.pending.clear();
        this.emit('exit', code);
        if (!settled) {
          settled = true;
          reject(new Error(`helper exited with code ${code}`));
        }
        // H4: the restart budget only refills after a minute of healthy uptime.
        if (Date.now() - startedAt > 60_000) this.restarts = 0;
        if (!this.stopping && this.restarts < 5) {
          const delay = 500 * 2 ** this.restarts++;
          this.emit('restarting', delay);
          setTimeout(() => {
            if (!this.stopping) this.start().catch((e) => this.emit('log', `helper restart failed: ${e.message}`));
          }, delay);
        } else if (!this.stopping) {
          this.emit('dead');
        }
      });
    });
    return this.readyPromise;
  }

  get running(): boolean {
    return !!this.proc;
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error('helper not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`helper ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin.write(JSON.stringify({ id, method, params }) + '\n', (err) => {
          if (err && this.pending.delete(id)) {
            clearTimeout(timer);
            reject(new Error(`helper write failed: ${err.message}`));
          }
        });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  /** Manual restart after the helper gave up (tray "Restart helper"). */
  restart(): Promise<void> {
    this.restarts = 0;
    this.stopping = false;
    return this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const proc = this.proc;
    if (!proc) return;
    try {
      await this.call('shutdown', {}, 1000);
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (this.proc === proc) proc.kill();
    }, 300);
  }

  // Typed wrappers -----------------------------------------------------------
  monitors = () => this.call<MonitorInfo[]>('monitors');
  windowInfo = (hwnd: number) => this.call('window_info', { hwnd });
  windowRect = (hwnd: number) => this.call<Rect>('window_rect', { hwnd });
  uiTree = (p: { hwnd?: number; x?: number; y?: number; maxNodes?: number }) => this.call<UiTree>('ui_tree_at', p, 20000);
  elementInfo = (id: number) => this.call<UiNode>('element_info', { id });
  capture = (p: { hwnd?: number; rect?: Rect; maxSize?: number; mode?: 'screen' | 'window' }) => this.call<Capture>('capture', p, 20000);
  /**
   * REVIEW-2 #7: the current run's cancel epoch, sent with every input call.
   * After `cancel(epoch)` (or a physical Esc) the helper refuses further input
   * from that epoch, so an Esc between two calls of a run is never lost.
   */
  inputEpoch = 0;
  click = (x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', count = 1) => this.call('click', { x, y, button, count, epoch: this.inputEpoch });
  typeText = (text: string) => this.call('type_text', { text, epoch: this.inputEpoch }, 60000);
  pressKeys = (keys: string, repeat = 1) => this.call('press_keys', { keys, repeat, epoch: this.inputEpoch });
  scroll = (p: { x?: number; y?: number; dy?: number; dx?: number }) => this.call('scroll', { ...p, epoch: this.inputEpoch });
  cancelInput = (epoch = this.inputEpoch) => this.call('cancel', { epoch }, 3000);
  focusedElement = () => this.call<{ role: string; name: string; aid: string; className: string; framework: string; pid: number }>('focused_element', {}, 3000);
  invoke = (id: number) => this.call('invoke', { id });
  setValue = (id: number, value: string) => this.call('set_value', { id, value });
  focusElement = (id: number) => this.call('focus_element', { id });
  foreground = (hwnd: number) => this.call<{ ok: boolean; foreground: number }>('foreground', { hwnd });
  setHookEnabled = (enabled: boolean) => this.call('set_hook_enabled', { enabled });
  cursorPos = () => this.call<{ x: number; y: number }>('cursor_pos');
  /** Round 8: Focus / full-screen / presentation state and speaker mute (read-only). */
  presence = () => this.call<{ notificationState: string; speakerMuted: boolean | null }>('presence', {}, 3000);
  /** Round 8: "lock my PC" (LockWorkStation, exactly like Win+L). */
  lockWorkstation = () => this.call('lock_workstation', {}, 3000);
  /** Round 10.5: other apps' audio sessions with their peak meter (read-only). */
  audioSessions = (exclude: number[]) => this.call<{ sessions: { exe: string; peak: number; pid: number }[] }>('audio_sessions', { exclude }, 2000);
  /** Round 10: report the next keyboard / mouse input once ('activity' event). `hooks` false = no hooks (test runs). */
  armActivity = (on: boolean) => this.call<{ hooks: boolean }>('arm_activity', { on }, 2000);
  /** Cursor visibility + idle time (software-KVM hint). Read-only. */
  inputState = () => this.call<{ cursorShowing: boolean; idleMs: number }>('input_state', {}, 2000);
  elementAt = (x: number, y: number) => this.call<UiNode>('element_at', { x, y }, 5000);
  windowAt = (x: number, y: number) => this.call<{ hwnd: number; title: string; process: string; className?: string; owner?: number }>('window_at', { x, y }, 5000);
  describeForeground = () => this.call<{ hwnd: number; title: string; process: string; className?: string; rect: Rect; elevated?: boolean | null }>('foreground_window', {}, 5000).catch(() => null);
}
