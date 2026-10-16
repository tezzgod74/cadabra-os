import { BrowserWindow, screen, type Display } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OverlayMessage, PanelMessage, Point, Rect } from '../shared/types';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PRELOAD = path.join(here, '../preload/bridge.cjs');
export const PANEL_SIZE = { width: 420, height: 540 };
/** Summon glass grow time (overlay GLASS_GROW_MS minus a frame): the panel appears as it lands. */
export const SUMMON_GLASS_MS = 360;
/** UX4: height of the compact panel strip while Cadabra acts. */
export const ACTING_HUD_HEIGHT = 64;

export function rendererUrl(page: 'panel' | 'overlay' | 'demo' | 'mic'): { url?: string; file?: string } {
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev) return { url: `${dev}/${page}/index.html` };
  return { file: path.join(here, `../renderer/${page}/index.html`) };
}

export function load(win: BrowserWindow, page: 'panel' | 'overlay' | 'demo' | 'mic', query?: Record<string, string>) {
  const r = rendererUrl(page);
  if (r.url) {
    const u = new URL(r.url);
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
    return win.loadURL(u.toString());
  }
  return win.loadFile(r.file!, { query });
}

function lockDown(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

/**
 * The glass panel. Recipe from docs/research.md §3.1: frameless, acrylic
 * material, fully transparent background colour, NOT `transparent: true`.
 */
export function createPanel(opts: { onCreate: (win: BrowserWindow) => void }): BrowserWindow {
  const win = new BrowserWindow({
    ...PANEL_SIZE,
    show: false,
    frame: false,
    thickFrame: true,
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    roundedCorners: true,
    // No Win11 accent-coloured focus border; the panel draws its own rim.
    accentColor: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    title: 'Cadabra',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      additionalArguments: ['--cadabra-role=panel'],
    },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  // 0.9.11: content protection (kept out of recordings unless the user opts in) comes from CaptureVisibility.
  opts.onCreate(win);
  lockDown(win);
  void load(win, 'panel');
  return win;
}

/** One transparent, click-through, top-most overlay per display. */
export class OverlayManager {
  private wins = new Map<number, BrowserWindow>();
  private visibleUntil = new Map<number, number>();

  /** `onCreate` applies the current content protection (CaptureVisibility) to each new overlay window. */
  constructor(private readonly onCreate: (win: BrowserWindow) => void) {
    screen.on('display-added', () => this.rebuild());
    screen.on('display-removed', () => this.rebuild());
    screen.on('display-metrics-changed', () => this.rebuild());
  }

  rebuild() {
    const ids = new Set(screen.getAllDisplays().map((d) => d.id));
    for (const [id, w] of this.wins) {
      if (!ids.has(id)) {
        w.destroy();
        this.wins.delete(id);
      }
    }
    for (const d of screen.getAllDisplays()) {
      const w = this.wins.get(d.id);
      if (w && !w.isDestroyed()) w.setBounds(d.bounds);
      else this.create(d);
    }
  }

  private create(d: Display): BrowserWindow {
    const win = new BrowserWindow({
      ...d.bounds,
      show: false,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      enableLargerThanScreen: true,
      title: 'Cadabra overlay',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        additionalArguments: ['--cadabra-role=overlay'],
      },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    this.onCreate(win);
    lockDown(win);
    void load(win, 'overlay');
    this.wins.set(d.id, win);
    return win;
  }

  displayFor(p: Point): Display {
    return screen.getDisplayNearestPoint({ x: Math.round(p.x), y: Math.round(p.y) });
  }

  private winFor(d: Display): BrowserWindow {
    let w = this.wins.get(d.id);
    if (!w || w.isDestroyed()) w = this.create(d);
    return w;
  }

  /** Send to the overlay of display `d`, showing it (inactive) if needed. */
  send(d: Display, msg: OverlayMessage, keepVisibleMs = 4000) {
    const w = this.winFor(d);
    const until = Date.now() + keepVisibleMs;
    this.visibleUntil.set(d.id, Math.max(this.visibleUntil.get(d.id) ?? 0, until));
    if (!w.isVisible()) {
      w.showInactive();
      w.setAlwaysOnTop(true, 'screen-saver');
      w.moveTop();
    }
    w.webContents.send('overlay:msg', msg);
  }

  broadcast(msg: OverlayMessage) {
    for (const w of this.wins.values()) if (!w.isDestroyed()) w.webContents.send('overlay:msg', msg);
  }

  /** Renderer reports it has nothing left to draw. */
  idle(sender: Electron.WebContents) {
    for (const [id, w] of this.wins) {
      if (w.webContents === sender && Date.now() >= (this.visibleUntil.get(id) ?? 0)) w.hide();
    }
  }

  hideAll() {
    for (const w of this.wins.values()) if (!w.isDestroyed()) w.hide();
  }

  /** Convert a global DIP point/rect into overlay-local coordinates for display d. */
  local(d: Display, p: Point): Point {
    return { x: p.x - d.bounds.x, y: p.y - d.bounds.y };
  }
  localRect(d: Display, r: Rect): Rect {
    return { x: r.x - d.bounds.x, y: r.y - d.bounds.y, width: r.width, height: r.height };
  }

  all(): BrowserWindow[] {
    return [...this.wins.values()];
  }
}

/** Round 5: the assistant's display name, stamped on every summon message. */
let assistantLabel = 'Cadabra';
export function setAssistantLabel(name: string) {
  assistantLabel = name;
}

export function sendPanel(win: BrowserWindow | null, msg: PanelMessage) {
  if (msg.type === 'summon') msg = { ...msg, assistant: assistantLabel };
  if (win && !win.isDestroyed()) win.webContents.send('panel:msg', msg);
}
