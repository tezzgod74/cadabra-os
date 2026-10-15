import { describe, expect, it } from 'vitest';
import { dipToPhysical, imageRectToPhysical, imageToPhysical, physicalRectToDip, physicalToDip, physicalToImage, placePanel, type DisplayMap, placeCaption } from '../src/shared/coords';
import { frameForRect } from '../src/main/tools';

// Primary 2560x1440 @150% (DIP 1707x960) at origin; secondary 1920x1080 @100%
// to the right. Electron lays DIP displays edge to edge.
const displays: DisplayMap[] = [
  { bounds: { x: 0, y: 0, width: 1707, height: 960 }, physical: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.5 },
  { bounds: { x: 1707, y: 0, width: 1920, height: 1080 }, physical: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
];

describe('physical <-> DIP', () => {
  it('converts per display with its own scale', () => {
    expect(physicalToDip({ x: 1500, y: 300 }, displays)).toEqual({ x: 1000, y: 200 });
    expect(physicalToDip({ x: 2660, y: 100 }, displays)).toEqual({ x: 1807, y: 100 });
  });
  it('round-trips', () => {
    for (const p of [
      { x: 10, y: 20 },
      { x: 2559, y: 1439 },
      { x: 3000, y: 500 },
    ]) {
      const back = dipToPhysical(physicalToDip(p, displays), displays);
      expect(Math.abs(back.x - p.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.y - p.y)).toBeLessThanOrEqual(1);
    }
  });
  it('uses the nearest display for points outside all displays', () => {
    const p = physicalToDip({ x: -30, y: 15 }, displays);
    expect(p.x).toBeCloseTo(-20);
  });
  it('converts rects using the display at their centre', () => {
    expect(physicalRectToDip({ x: 300, y: 150, width: 600, height: 300 }, displays)).toEqual({ x: 200, y: 100, width: 400, height: 200 });
    expect(physicalRectToDip({ x: 2600, y: 10, width: 100, height: 50 }, displays)).toEqual({ x: 1747, y: 10, width: 100, height: 50 });
  });
});

describe('screenshot image <-> physical', () => {
  const cap = { rect: { x: 100, y: 50, width: 3136, height: 1000 }, scale: 2, width: 1568, height: 500 };
  it('maps image pixels to physical pixels', () => {
    expect(imageToPhysical({ x: 0, y: 0 }, cap)).toEqual({ x: 100, y: 50 });
    expect(imageToPhysical({ x: 10, y: 20 }, cap)).toEqual({ x: 120, y: 90 });
    expect(physicalToImage({ x: 120, y: 90 }, cap)).toEqual({ x: 10, y: 20 });
  });
  it('maps rects', () => {
    expect(imageRectToPhysical({ x: 5, y: 5, width: 10, height: 4 }, cap)).toEqual({ x: 110, y: 60, width: 20, height: 8 });
  });
  it('frameForRect matches the helper capture downscale rule (long side <= 1568)', () => {
    const f = frameForRect({ x: 0, y: 0, width: 3136, height: 1000 });
    expect(f.scale).toBe(2);
    expect(f.width).toBe(1568);
    expect(f.height).toBe(500);
    expect(frameForRect({ x: 0, y: 0, width: 800, height: 600 }).scale).toBe(1);
  });
});

describe('placePanel', () => {
  const work = { x: 0, y: 0, width: 1280, height: 752 };
  const size = { width: 420, height: 540 };
  it('opens below-right of the cursor when there is room', () => {
    expect(placePanel({ x: 100, y: 100 }, size, work)).toEqual({ x: 114, y: 114, width: 420, height: 540 });
  });
  it('flips left/up near the right/bottom edges', () => {
    const r = placePanel({ x: 1200, y: 700 }, size, work);
    expect(r.x).toBe(1200 - 14 - 420);
    expect(r.y).toBe(700 - 14 - 540);
  });
  it('always stays inside the work area', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 1279, y: 0 },
      { x: 640, y: 380 },
      { x: 1279, y: 751 },
    ]) {
      const r = placePanel(p, size, work);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(1280);
      expect(r.y + r.height).toBeLessThanOrEqual(752);
    }
  });
  it('respects a work area on a secondary monitor', () => {
    const r = placePanel({ x: 1800, y: 900 }, size, { x: 1707, y: 0, width: 1920, height: 1040 });
    expect(r.x).toBeGreaterThanOrEqual(1707);
    expect(r.y + r.height).toBeLessThanOrEqual(1040);
  });
});

describe('placeCaption (C5)', () => {
  it('keeps the ghost caption off the panel and on screen', () => {
    const panel = { x: 500, y: 100, width: 420, height: 540 };
    // Ghost just left of the panel: right-side caption would cover the panel -> flips left.
    expect(placeCaption(488, 164, 120, 24, panel, 1920, 1080)).toEqual({ x: 488 - 22 - 120, y: 180 });
    // Far from the panel: default bottom-right.
    expect(placeCaption(100, 700, 120, 24, panel, 1920, 1080)).toEqual({ x: 122, y: 716 });
    // Near the right screen edge: flips left.
    expect(placeCaption(1900, 700, 120, 24, null, 1920, 1080).x).toBe(1900 - 22 - 120);
  });
});
