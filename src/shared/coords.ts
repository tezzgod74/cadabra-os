// Coordinate spaces used by Cadabra OS
// -----------------------------------
// PHYSICAL  – virtual-desktop pixels. The native helper is Per-Monitor-V2 DPI
//             aware, so every point/rect it sends or receives (hook events,
//             UIA bounding rects, capture rects, click targets) is physical.
// DIP       – Electron's device-independent pixels (screen API, BrowserWindow
//             bounds). On a 150% monitor 1 DIP = 1.5 physical px. Each display
//             has its DIP origin (`bounds.x/y`) and its physical origin; mixed
//             DPI layouts mean the mapping is per-display, not a single scale.
// IMAGE     – pixels of a screenshot returned by `see_screen`. Captures are
//             downscaled; image -> physical is `rect.origin + img * scale`.
// OVERLAY   – DIP relative to one display's overlay window (overlay windows
//             are per display and cover `display.bounds`).
//
// In the running app we prefer Electron's own `screen.screenToDipPoint` /
// `dipToScreenPoint` (Windows only); these pure functions are the fallback and
// are what the unit tests exercise.

import type { Point, Rect } from './types';

export interface DisplayMap {
  /** DIP bounds as reported by Electron. */
  bounds: Rect;
  /** Physical bounds as reported by the helper (`monitors`). */
  physical: Rect;
  scaleFactor: number;
}

export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

function nearestBy<T>(items: T[], rectOf: (t: T) => Rect, p: Point): T | undefined {
  let best: T | undefined;
  let bestD = Infinity;
  for (const it of items) {
    const r = rectOf(it);
    if (rectContains(r, p)) return it;
    const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
    const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}

export function physicalToDip(p: Point, displays: DisplayMap[]): Point {
  const d = nearestBy(displays, (x) => x.physical, p);
  if (!d) return { ...p };
  return {
    x: d.bounds.x + (p.x - d.physical.x) / d.scaleFactor,
    y: d.bounds.y + (p.y - d.physical.y) / d.scaleFactor,
  };
}

export function dipToPhysical(p: Point, displays: DisplayMap[]): Point {
  const d = nearestBy(displays, (x) => x.bounds, p);
  if (!d) return { ...p };
  return {
    x: Math.round(d.physical.x + (p.x - d.bounds.x) * d.scaleFactor),
    y: Math.round(d.physical.y + (p.y - d.bounds.y) * d.scaleFactor),
  };
}

/** Converts a physical rect using the display that contains its center. */
export function physicalRectToDip(r: Rect, displays: DisplayMap[]): Rect {
  const center = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  const d = nearestBy(displays, (x) => x.physical, center);
  if (!d) return { ...r };
  return {
    x: d.bounds.x + (r.x - d.physical.x) / d.scaleFactor,
    y: d.bounds.y + (r.y - d.physical.y) / d.scaleFactor,
    width: r.width / d.scaleFactor,
    height: r.height / d.scaleFactor,
  };
}

export interface CaptureFrame {
  /** Physical rect that was captured. */
  rect: Rect;
  /** Physical px per image px (>= 1). */
  scale: number;
  width: number;
  height: number;
}

export function imageToPhysical(p: Point, cap: CaptureFrame): Point {
  return {
    x: Math.round(cap.rect.x + p.x * cap.scale),
    y: Math.round(cap.rect.y + p.y * cap.scale),
  };
}

export function imageRectToPhysical(r: Rect, cap: CaptureFrame): Rect {
  return {
    x: Math.round(cap.rect.x + r.x * cap.scale),
    y: Math.round(cap.rect.y + r.y * cap.scale),
    width: Math.round(r.width * cap.scale),
    height: Math.round(r.height * cap.scale),
  };
}

export function physicalToImage(p: Point, cap: CaptureFrame): Point {
  return {
    x: Math.round((p.x - cap.rect.x) / cap.scale),
    y: Math.round((p.y - cap.rect.y) / cap.scale),
  };
}

export function imagePointInFrame(p: Point, cap: CaptureFrame): boolean {
  return p.x >= 0 && p.y >= 0 && p.x <= cap.width && p.y <= cap.height;
}

/**
 * Place the panel near the cursor (DIP), preferring below-right of the click,
 * flipping left/up when it would leave the work area, and finally clamping.
 */
export function placePanel(cursor: Point, size: { width: number; height: number }, work: Rect, gap = 14): Rect {
  let x = cursor.x + gap;
  let y = cursor.y + gap;
  if (x + size.width > work.x + work.width) x = cursor.x - gap - size.width;
  if (y + size.height > work.y + work.height) y = cursor.y - gap - size.height;
  x = Math.min(Math.max(x, work.x + 8), work.x + work.width - size.width - 8);
  y = Math.min(Math.max(y, work.y + 8), work.y + work.height - size.height - 8);
  return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height };
}

export function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function translate(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height };
}

/** Caption position next to the ghost that stays on screen and off `avoid`. */
export function placeCaption(x: number, y: number, w: number, h: number, avoid: { x: number; y: number; width: number; height: number } | null, screenW: number, screenH: number): { x: number; y: number } {
  const options = [
    { x: x + 22, y: y + 16 },
    { x: x - 22 - w, y: y + 16 },
    { x: x + 22, y: y - 16 - h },
    { x: x - 22 - w, y: y - 16 - h },
  ];
  const fits = (o: { x: number; y: number }) => o.x >= 0 && o.y >= 0 && o.x + w <= screenW && o.y + h <= screenH;
  const clear = (o: { x: number; y: number }) => !avoid || o.x + w <= avoid.x || o.x >= avoid.x + avoid.width || o.y + h <= avoid.y || o.y >= avoid.y + avoid.height;
  return options.find((o) => fits(o) && clear(o)) ?? options.find(fits) ?? options[0];
}
