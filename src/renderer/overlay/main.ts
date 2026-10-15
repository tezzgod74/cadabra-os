// Full-display, click-through overlay: summon ripple + sparks, window scan,
// highlight rings, ghost cursor, dismiss. Every effect is a pure function of
// elapsed time driven from one rAF loop (transforms/opacity + one canvas), so
// it stays at 60fps and can be frozen at an exact moment for screenshots.

import type { OverlayMessage, Point, Rect } from '../../shared/types';
import { placeCaption } from '../../shared/coords';
import { demoChannel, isDemo, postToStage } from '../shared/demo-bridge';

const api = isDemo()
  ? { onMessage: (cb: (m: any) => void) => demoChannel(cb), ready: () => postToStage('overlay-ready'), idle: () => undefined }
  : (window as any).cadabra;

const canvas = document.getElementById('fx') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const layer = document.getElementById('layer')!;
let dpr = 1;

function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
}
resize();
addEventListener('resize', resize);

// ----------------------------------------------------------------- clock --

let frozenAt: number | null = null;
const now = () => (frozenAt != null ? Math.min(performance.now(), frozenAt) : performance.now());

// --------------------------------------------------------------- easings --

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
const easeInOutCubic = (t: number) => {
  t = clamp01(t);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const easeInCubic = (t: number) => Math.pow(clamp01(t), 3);
/** Damped spring 0→1 (slight overshoot), t in "periods" ~[0..1]. */
const spring = (t: number) => (t <= 0 ? 0 : t >= 1.6 ? 1 : 1 - Math.exp(-6.5 * t) * Math.cos(8.5 * t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Gentle overshoot (~4%): the glass lands with a soft spring. */
const easeOutBack = (t: number) => {
  const c1 = 1.0;
  const u = clamp01(t) - 1;
  return 1 + (c1 + 1) * u * u * u + c1 * u * u;
};

// ---------------------------------------------------------------- engine --

interface Effect {
  start: number;
  /** Return false when finished. `t` = ms since start. */
  frame(t: number): boolean;
  destroy(): void;
  tag?: string;
}

const effects = new Set<Effect>();
let raf = 0;
let idleTimer = 0;

function add(e: Effect) {
  effects.add(e);
  kick();
}
function kick() {
  if (!raf) raf = requestAnimationFrame(loop);
  clearTimeout(idleTimer);
}
function loop() {
  raf = 0;
  const n = now();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  for (const e of [...effects]) {
    if (!e.frame(n - e.start)) {
      e.destroy();
      effects.delete(e);
    }
  }
  if (effects.size) raf = requestAnimationFrame(loop);
  else idleTimer = window.setTimeout(() => api.idle?.(), 400);
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = `abs ${cls}`;
  layer.append(d);
  return d;
}

const GOLD = [255, 210, 122];
const rgba = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// ---------------------------------------------------------------- sparks --

interface Spark {
  angle: number;
  speed: number;
  size: number;
  life: number;
  delay: number;
}

function sparkSet(n: number, seed: number, spread = 1): Spark[] {
  // Deterministic jitter (stable screenshots, no Math.random flicker).
  const rnd = (i: number) => {
    const x = Math.sin(seed * 97.13 + i * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };
  return Array.from({ length: n }, (_, i) => ({
    angle: (i / n) * Math.PI * 2 + (rnd(i) - 0.5) * 0.9,
    speed: (110 + rnd(i + 7) * 130) * spread,
    size: 1.9 + rnd(i + 3) * 2.4,
    life: 620 + rnd(i + 11) * 380,
    delay: rnd(i + 5) * 70,
  }));
}

function drawStar(x: number, y: number, r: number, a: number) {
  // Violet halo (gives contrast on light backgrounds) + warm core glow
  const halo = ctx.createRadialGradient(x, y, 0, x, y, r * 7);
  halo.addColorStop(0, rgba([150, 125, 255], 0.22 * a));
  halo.addColorStop(1, rgba([150, 125, 255], 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(x, y, r * 7, 0, Math.PI * 2);
  ctx.fill();
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3.6);
  g.addColorStop(0, rgba([255, 240, 200], 0.85 * a));
  g.addColorStop(0.4, rgba(GOLD, 0.35 * a));
  g.addColorStop(1, rgba(GOLD, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 3.6, 0, Math.PI * 2);
  ctx.fill();
  // Four-point twinkle
  ctx.fillStyle = rgba([255, 248, 226], a);
  ctx.beginPath();
  ctx.moveTo(x, y - r * 2.6);
  ctx.quadraticCurveTo(x + r * 0.28, y - r * 0.28, x + r * 2.6, y);
  ctx.quadraticCurveTo(x + r * 0.28, y + r * 0.28, x, y + r * 2.6);
  ctx.quadraticCurveTo(x - r * 0.28, y + r * 0.28, x - r * 2.6, y);
  ctx.quadraticCurveTo(x - r * 0.28, y - r * 0.28, x, y - r * 2.6);
  ctx.fill();
}

function burst(at: Point, n: number, seed: number, spread = 1, inward = false): Effect {
  const sparks = sparkSet(n, seed, spread);
  return {
    start: now(),
    frame(t) {
      let alive = false;
      for (const s of sparks) {
        const lt = t - s.delay;
        if (lt < 0) {
          alive = true;
          continue;
        }
        const p = lt / s.life;
        if (p >= 1) continue;
        alive = true;
        const k = 3.2;
        const dist = (s.speed * (1 - Math.exp((-k * lt) / 1000))) / k * 2.4;
        const d = inward ? (1 - easeOutCubic(p)) * s.speed * 0.6 : dist;
        const x = at.x + Math.cos(s.angle) * d;
        const y = at.y + Math.sin(s.angle) * d;
        const a = (1 - p) * (p < 0.12 ? p / 0.12 : 1);
        drawStar(x, y, s.size * (1 - p * 0.4), a);
      }
      return alive;
    },
    destroy() {},
  };
}

function ripple(at: Point): Effect {
  return {
    start: now(),
    frame(t) {
      const dur = 900;
      if (t > dur) return false;
      // Flash + core glow
      const cp = clamp01(t / 520);
      const cr = 22 + 46 * easeOutCubic(cp);
      const g = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, cr);
      g.addColorStop(0, rgba([255, 248, 225], 0.9 * Math.pow(1 - cp, 1.4)));
      g.addColorStop(0.35, rgba(GOLD, 0.4 * (1 - cp)));
      g.addColorStop(0.7, rgba([150, 125, 255], 0.18 * (1 - cp)));
      g.addColorStop(1, rgba([150, 125, 255], 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(at.x, at.y, cr, 0, Math.PI * 2);
      ctx.fill();
      // Two soft rings, each a violet haze under a crisp gold line
      for (const [delay, maxR, w] of [
        [0, 82, 2],
        [120, 132, 1.3],
      ] as const) {
        const p = clamp01((t - delay) / (dur - delay));
        if (p <= 0 || p >= 1) continue;
        const r = 6 + maxR * easeOutCubic(p);
        const a = Math.pow(1 - p, 1.5);
        ctx.strokeStyle = rgba([140, 115, 255], 0.22 * a);
        ctx.lineWidth = w * 5;
        ctx.beginPath();
        ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
        ctx.stroke();
        const grad = ctx.createLinearGradient(at.x - r, at.y - r, at.x + r, at.y + r);
        grad.addColorStop(0, rgba([255, 230, 165], 0.95 * a));
        grad.addColorStop(1, rgba([185, 165, 255], 0.85 * a));
        ctx.strokeStyle = grad;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      return true;
    },
    destroy() {},
  };
}

/**
 * A soft wash of light that travels from the click point to where the panel
 * opens (or back into the click on dismiss) — no hard edges, so it blends
 * with the real acrylic window fading in on top of it.
 */
function bloom(at: Point, panel: Rect, reverse: boolean): Effect {
  const c = { x: panel.x + panel.width / 2, y: panel.y + panel.height / 2 };
  const dur = reverse ? 300 : 460;
  return {
    start: now(),
    frame(t) {
      if (t > dur) return false;
      const p = clamp01(t / dur);
      const e = reverse ? easeInCubic(p) : easeOutCubic(p);
      const k = reverse ? 1 - e : e;
      const x = lerp(at.x, c.x, k);
      const y = lerp(at.y, c.y, k);
      const rx = lerp(18, panel.width * 0.62, k);
      const ry = lerp(18, panel.height * 0.56, k);
      const alpha = reverse ? 0.42 * (1 - p) : 0.5 * Math.sin(Math.PI * Math.min(1, p * 1.15));
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(rx / 100, ry / 100);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 100);
      g.addColorStop(0, rgba([255, 226, 170], alpha * 0.55));
      g.addColorStop(0.35, rgba([160, 135, 255], alpha * 0.5));
      g.addColorStop(1, rgba([110, 90, 230], 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 100, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return true;
    },
    destroy() {},
  };
}

/** Grow time of the summon glass; main shows the real panel right as it lands. */
export const GLASS_GROW_MS = 380;

function roundRect(x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * UX3: the summon glass. A small gold-rimmed droplet springs out of the
 * click point and grows into the panel's exact rect; the real acrylic panel
 * appears on top of it as it lands and the droplet cross-fades away. Reverse
 * collapses the panel back into the point on dismiss.
 */
/** A tileable frosted-grain texture (a transparent overlay can't blur the desktop, so fake frost). */
let grain: CanvasPattern | null = null;
function grainPattern(): CanvasPattern | null {
  if (grain) return grain;
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d')!;
  const img = g.createImageData(96, 96);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 180 + rnd() * 75;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = 255;
    img.data[i + 3] = rnd() * 26;
  }
  g.putImageData(img, 0, 0);
  grain = ctx.createPattern(c, 'repeat');
  return grain;
}

function glass(at: Point, panel: Rect, reverse: boolean): Effect {
  const grow = reverse ? 260 : GLASS_GROW_MS;
  const fade = reverse ? 80 : 160;
  return {
    start: now(),
    tag: 'glass',
    frame(t) {
      if (t > grow + fade) return false;
      const p = clamp01(t / grow);
      const k = reverse ? 1 - easeInCubic(p) : easeOutBack(p);
      const w = Math.max(16, lerp(16, panel.width, k));
      const h = Math.max(16, lerp(16, panel.height, k));
      const cx = lerp(at.x, panel.x + panel.width / 2, Math.min(1.02, k));
      const cy = lerp(at.y, panel.y + panel.height / 2, Math.min(1.02, k));
      const x = cx - w / 2;
      const y = cy - h / 2;
      const r = lerp(8, 14, clamp01(k));
      const a = t <= grow ? (reverse ? 1 - 0.3 * p : Math.min(1, 0.35 + p * 1.4)) : 1 - (t - grow) / fade;
      ctx.save();
      ctx.globalAlpha = clamp01(a);
      ctx.shadowColor = 'rgba(20, 10, 60, 0.45)';
      ctx.shadowBlur = 30;
      ctx.shadowOffsetY = 10;
      roundRect(x, y, w, h, r);
      // Frosted glass: translucent tinted body (the desktop shows through),
      // grain for frost, a bright top-left sheen, inner rim light and a gold edge.
      const fill = ctx.createLinearGradient(x, y, x + w * 0.4, y + h);
      fill.addColorStop(0, 'rgba(70, 54, 150, 0.62)');
      fill.addColorStop(0.55, 'rgba(36, 27, 90, 0.7)');
      fill.addColorStop(1, 'rgba(18, 13, 46, 0.78)');
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      const pat = grainPattern();
      if (pat) {
        ctx.fillStyle = pat;
        ctx.fill();
      }
      const sheen = ctx.createLinearGradient(x, y, x + w * 0.7, y + h * 0.6);
      sheen.addColorStop(0, 'rgba(255,255,255,0.22)');
      sheen.addColorStop(0.28, 'rgba(255,255,255,0.06)');
      sheen.addColorStop(0.6, 'rgba(255,255,255,0)');
      ctx.fillStyle = sheen;
      ctx.fill();
      // Inner rim light (1 px inside the edge).
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      roundRect(x + 2, y + 2, w - 4, h - 4, Math.max(0, r - 2));
      ctx.stroke();
      const rim = ctx.createLinearGradient(x, y, x + w, y + h);
      rim.addColorStop(0, rgba([255, 230, 165], 0.95));
      rim.addColorStop(0.5, rgba(GOLD, 0.55));
      rim.addColorStop(1, rgba([170, 150, 255], 0.6));
      ctx.strokeStyle = rim;
      ctx.lineWidth = 1.2;
      roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r);
      ctx.stroke();
      ctx.restore();
      return true;
    },
    destroy() {},
  };
}

// ------------------------------------------------------------------ scan --

const SVGNS = 'http://www.w3.org/2000/svg';

function roundedRectPath(w: number, h: number, r: number): string {
  // Starts at top-centre, clockwise, so the trace grows from the top.
  const cx = w / 2;
  return `M${cx},0 H${w - r} Q${w},0 ${w},${r} V${h - r} Q${w},${h} ${w - r},${h} H${r} Q0,${h} 0,${h - r} V${r} Q0,0 ${r},0 Z`;
}

function scan(rect: Rect, reduced: boolean, avoid?: Rect): Effect {
  const pad = 3;
  const w = rect.width + pad * 2;
  const h = rect.height + pad * 2;
  const host = div('scan');
  host.style.transform = `translate(${rect.x - pad}px, ${rect.y - pad}px)`;
  if (avoid) {
    // REVIEW-2 N9: never draw the outline over Cadabra's own panel.
    const ox = rect.x - pad;
    const oy = rect.y - pad;
    const ax = avoid.x - ox;
    const ay = avoid.y - oy;
    host.style.clipPath = `path(evenodd, 'M-60 -60 H${w + 60} V${h + 60} H-60 Z M${ax} ${ay} h${avoid.width} v${avoid.height} h${-avoid.width} Z')`;
  }
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', String(w + 20));
  svg.setAttribute('height', String(h + 20));
  svg.style.position = 'absolute';
  svg.style.left = '-10px';
  svg.style.top = '-10px';
  svg.style.overflow = 'visible';
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  svg.innerHTML = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe3a0"/><stop offset=".5" stop-color="#ffc862"/><stop offset="1" stop-color="#a996ff"/></linearGradient></defs>`;
  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('transform', 'translate(10,10)');
  const d = roundedRectPath(w, h, 9);
  const glow = document.createElementNS(SVGNS, 'path');
  glow.setAttribute('d', d);
  glow.setAttribute('pathLength', '1');
  glow.setAttribute('fill', 'none');
  glow.setAttribute('stroke', `url(#${id})`);
  glow.setAttribute('stroke-width', '7');
  glow.setAttribute('stroke-linecap', 'round');
  glow.style.opacity = '0.28';
  glow.style.filter = 'blur(4px)';
  const line = document.createElementNS(SVGNS, 'path');
  line.setAttribute('d', d);
  line.setAttribute('pathLength', '1');
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', `url(#${id})`);
  line.setAttribute('stroke-width', '1.6');
  line.setAttribute('stroke-linecap', 'round');
  g.append(glow, line);
  svg.append(g);
  host.append(svg);
  const clip = document.createElement('div');
  clip.className = 'sweep-clip';
  clip.style.position = 'absolute';
  clip.style.left = `${pad}px`;
  clip.style.top = `${pad}px`;
  clip.style.width = `${rect.width}px`;
  clip.style.height = `${rect.height}px`;
  const band = document.createElement('div');
  band.className = 'sweep-band';
  clip.append(band);
  host.append(clip);
  const total = line.getTotalLength();
  const head = { x: w / 2, y: 0 };
  return {
    start: now(),
    tag: 'scan',
    frame(t) {
      const trace = reduced ? 1 : easeInOutCubic(t / 720);
      for (const p of [glow, line]) {
        p.setAttribute('stroke-dasharray', `${trace} 1`);
      }
      // Bright head travelling along the outline
      if (!reduced && trace < 1 && total > 0) {
        const pt = line.getPointAtLength(trace * total);
        head.x = pt.x + rect.x - pad;
        head.y = pt.y + rect.y - pad;
        drawStar(head.x, head.y, 2.2, 0.9);
      }
      // Light sweep across the window
      const sp = reduced ? 1 : clamp01((t - 260) / 950);
      band.style.transform = `translateX(${lerp(-rect.width * 0.45, rect.width * 1.1, easeInOutCubic(sp))}px) skewX(-12deg)`;
      band.style.opacity = sp > 0 && sp < 1 ? '1' : '0';
      const fade = 1 - clamp01((t - (reduced ? 700 : 1500)) / 650);
      host.style.opacity = String(fade);
      return fade > 0;
    },
    destroy() {
      host.remove();
    },
  };
}

// ----------------------------------------------------------- highlights --

function highlightRing(rect: Rect, label: string | undefined, index: number, durationMs: number, reduced: boolean): Effect {
  const out = 4;
  const r = { x: rect.x - out, y: rect.y - out, width: rect.width + out * 2, height: rect.height + out * 2 };
  const ring = div('ring');
  const pulse = div('ring-pulse');
  for (const d of [ring, pulse]) {
    d.style.width = `${r.width}px`;
    d.style.height = `${r.height}px`;
    d.style.transformOrigin = '50% 50%';
    d.style.opacity = '0';
  }
  let lab: HTMLDivElement | null = null;
  if (label) {
    lab = div('ring-label');
    lab.textContent = label;
    lab.style.opacity = '0';
  }
  const delay = index * 90;
  let exitAt = durationMs;
  const e: Effect & { exit(): void } = {
    start: now(),
    tag: 'ring',
    exit() {
      exitAt = Math.min(exitAt, now() - e.start);
    },
    frame(t) {
      const lt = t - delay;
      const inP = reduced ? 1 : clamp01(lt / 420);
      const s = reduced ? 1 : lerp(1.22, 1, spring(lt / 420));
      const outP = clamp01((t - exitAt) / 320);
      const a = (lt < 0 ? 0 : Math.min(1, inP * 2.2)) * (1 - outP);
      ring.style.transform = `translate(${r.x}px, ${r.y}px) scale(${lt < 0 ? 1.22 : s})`;
      ring.style.opacity = String(a);
      if (!reduced && lt > 300) {
        const cyc = ((lt - 300) % 1700) / 1700;
        pulse.style.transform = `translate(${r.x}px, ${r.y}px) scale(${1 + 0.16 * easeOutCubic(cyc)})`;
        pulse.style.opacity = String((1 - cyc) * 0.55 * (1 - outP));
      } else pulse.style.opacity = '0';
      if (lab) {
        const lp = reduced ? 1 : easeOutCubic((lt - 140) / 360);
        const above = r.y > 34;
        const ly = above ? r.y - 30 : r.y + r.height + 8;
        lab.style.transform = `translate(${r.x}px, ${ly + (1 - lp) * (above ? 5 : -5)}px)`;
        lab.style.opacity = String(clamp01(lp) * (1 - outP));
      }
      return outP < 1;
    },
    destroy() {
      ring.remove();
      pulse.remove();
      lab?.remove();
    },
  };
  return e;
}

// ----------------------------------------------------------------- ghost --

const ghost = {
  el: null as HTMLDivElement | null,
  halo: null as HTMLDivElement | null,
  cap: null as HTMLDivElement | null,
  x: 0,
  y: 0,
  from: { x: 0, y: 0 },
  to: { x: 0, y: 0 },
  ctrl: { x: 0, y: 0 },
  moveStart: 0,
  dur: 0,
  appearAt: 0,
  hideAt: Infinity,
  clickAt: -Infinity,
  trail: [] as { x: number; y: number; t: number }[],
  effect: null as Effect | null,
  reduced: false,
  /** C5: keep the caption off Cadabra's own panel. */
  avoid: null as Rect | null,
};



function ensureGhost(): void {
  if (ghost.effect) return;
  ghost.halo = div('ghost-halo');
  ghost.el = div('ghost');
  ghost.cap = div('caption');
  ghost.cap.style.opacity = '0';
  ghost.trail = [];
  ghost.hideAt = Infinity;
  ghost.appearAt = now();
  const eff: Effect = {
    start: now(),
    tag: 'ghost',
    frame() {
      const n = now();
      // Position along a gentle arc
      let moving = false;
      if (ghost.dur > 0) {
        const p = clamp01((n - ghost.moveStart) / ghost.dur);
        const e = easeInOutCubic(p);
        const u = 1 - e;
        ghost.x = u * u * ghost.from.x + 2 * u * e * ghost.ctrl.x + e * e * ghost.to.x;
        ghost.y = u * u * ghost.from.y + 2 * u * e * ghost.ctrl.y + e * e * ghost.to.y;
        moving = p < 1;
      } else {
        ghost.x = ghost.to.x;
        ghost.y = ghost.to.y;
      }
      if (moving && !ghost.reduced) ghost.trail.push({ x: ghost.x, y: ghost.y, t: n });
      ghost.trail = ghost.trail.filter((q) => n - q.t < 320);
      // Trail
      for (let i = 1; i < ghost.trail.length; i++) {
        const a = ghost.trail[i - 1];
        const b = ghost.trail[i];
        const k = 1 - (n - b.t) / 320;
        ctx.strokeStyle = rgba([255, 214, 140], 0.45 * k * k);
        ctx.lineWidth = 2 + 7 * k;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      const appear = ghost.reduced ? 1 : easeOutCubic((n - ghost.appearAt) / 220);
      const vanish = 1 - clamp01((n - ghost.hideAt) / 260);
      const ct = n - ghost.clickAt;
      const squash = ct >= 0 && ct < 420 ? 1 - 0.24 * Math.sin(Math.PI * clamp01(ct / 180)) * (ct < 180 ? 1 : 0) : 1;
      const breathe = ghost.reduced ? 1 : 1 + 0.035 * Math.sin(n / 260);
      const s = appear * squash * breathe;
      const a = Math.min(appear, vanish);
      ghost.el!.style.transform = `translate(${ghost.x}px, ${ghost.y}px) scale(${s})`;
      ghost.el!.style.opacity = String(a);
      ghost.halo!.style.transform = `translate(${ghost.x}px, ${ghost.y}px) scale(${breathe * (moving ? 1.15 : 1)})`;
      ghost.halo!.style.opacity = String(a * 0.9);
      if (ghost.cap!.textContent) {
        const pos = placeCaption(ghost.x, ghost.y, ghost.cap!.offsetWidth, ghost.cap!.offsetHeight, ghost.avoid, innerWidth, innerHeight);
        ghost.cap!.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
        ghost.cap!.style.opacity = String(a);
      }
      // Click pulse
      if (ct >= 0 && ct < 520) {
        const p = ct / 520;
        ctx.strokeStyle = rgba([255, 226, 160], (1 - p) * 0.95);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(ghost.to.x, ghost.to.y, 8 + 30 * easeOutCubic(p), 0, Math.PI * 2);
        ctx.stroke();
        const g = ctx.createRadialGradient(ghost.to.x, ghost.to.y, 0, ghost.to.x, ghost.to.y, 30);
        g.addColorStop(0, rgba([255, 240, 200], 0.5 * (1 - p)));
        g.addColorStop(1, rgba(GOLD, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(ghost.to.x, ghost.to.y, 30, 0, Math.PI * 2);
        ctx.fill();
      }
      return vanish > 0;
    },
    destroy() {
      ghost.el?.remove();
      ghost.halo?.remove();
      ghost.cap?.remove();
      ghost.el = ghost.halo = ghost.cap = null;
      ghost.effect = null;
      ghost.dur = 0;
    },
  };
  ghost.effect = eff;
  add(eff);
}

function ghostMove(to: Point, from: Point | undefined, caption: string | undefined, dur: number, reduced: boolean, avoid?: Rect) {
  const fresh = !ghost.effect;
  ghost.reduced = reduced;
  ghost.avoid = avoid ?? null;
  ensureGhost();
  ghost.hideAt = Infinity;
  const start = fresh ? (from ?? to) : { x: ghost.x, y: ghost.y };
  if (fresh) {
    ghost.x = start.x;
    ghost.y = start.y;
  }
  ghost.from = start;
  ghost.to = to;
  const dx = to.x - start.x;
  const dy = to.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const bend = Math.min(80, len * 0.16);
  ghost.ctrl = { x: (start.x + to.x) / 2 - (dy / len) * bend, y: (start.y + to.y) / 2 + (dx / len) * bend };
  ghost.moveStart = now();
  ghost.dur = reduced ? 0 : dur;
  if (caption != null) ghost.cap!.textContent = caption;
  kick();
}


// ---------------------------------------------------------------- launch --

/** The app's icon flies out of the panel toward where the window will appear and dissolves into light. */
function launchFlight(from: Point, to: Point, icon: string | undefined, reduced: boolean): Effect {
  const el = document.createElement(icon ? 'img' : 'div') as HTMLImageElement;
  el.className = 'abs launch-ico';
  if (icon) el.src = icon;
  layer.append(el);
  const dur = reduced ? 1 : 720;
  const ctrl = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - 120 };
  let burstDone = false;
  return {
    start: now(),
    frame(t) {
      const p = clamp01(t / dur);
      const e = easeInOutCubic(p);
      const u = 1 - e;
      const x = u * u * from.x + 2 * u * e * ctrl.x + e * e * to.x;
      const y = u * u * from.y + 2 * u * e * ctrl.y + e * e * to.y;
      const s = 1 + 1.6 * easeInCubic(p);
      el.style.transform = `translate(${x - 24}px, ${y - 24}px) scale(${s})`;
      el.style.opacity = String(p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25);
      el.style.filter = p > 0.6 ? `blur(${(p - 0.6) * 10}px)` : '';
      if (!reduced) {
        // glowing wake behind the icon
        const g = ctx.createRadialGradient(x, y, 0, x, y, 40);
        g.addColorStop(0, rgba([255, 236, 190], 0.35 * (1 - p)));
        g.addColorStop(1, rgba([150, 125, 255], 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, 40, 0, Math.PI * 2);
        ctx.fill();
      }
      if (p >= 1 && !burstDone) {
        burstDone = true;
        if (!reduced) add(burst(to, 10, 21, 0.9));
      }
      return p < 1;
    },
    destroy() {
      el.remove();
    },
  };
}

// ------------------------------------------------------------ remote pill --
// Round 12.5: a small top-center pill while the assistant works on a WhatsApp request.
// The overlay is click-through, so it says how to stop her (Esc) instead of
// offering a button.

let pillOn = false;
function remotePill(text: string): Effect {
  const el = document.createElement('div');
  el.className = 'remote-pill';
  el.textContent = text;
  Object.assign(el.style, {
    position: 'fixed',
    top: '14px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '7px 16px',
    borderRadius: '999px',
    background: 'rgba(20, 16, 40, 0.88)',
    color: '#fff',
    font: '600 13px system-ui, sans-serif',
    boxShadow: '0 0 0 1px rgba(255, 210, 120, 0.55), 0 6px 22px rgba(0, 0, 0, 0.35)',
    zIndex: '50',
    pointerEvents: 'none',
  } as Partial<CSSStyleDeclaration>);
  document.body.append(el);
  return {
    start: now(),
    tag: 'remote-pill',
    frame: () => pillOn,
    destroy: () => el.remove(),
  };
}

// --------------------------------------------------------------- messages --

function clearTag(tag: string) {
  for (const e of effects) if (e.tag === tag) (e as any).exit?.();
}

function handle(m: OverlayMessage | any) {
  switch (m.type) {
    case 'summon':
      if (!m.reducedMotion) {
        add(ripple(m.at));
        add(burst(m.at, 10, 7));
        add(bloom(m.at, m.panel, false));
        add(glass(m.at, m.panel, false));
      }
      break;
    case 'scan':
      for (const e of [...effects]) if (e.tag === 'scan') {
        e.destroy();
        effects.delete(e);
      }
      add(scan(m.rect, m.reducedMotion, m.avoid));
      break;
    case 'dismiss':
      if (!m.reducedMotion) {
        add(glass(m.to, m.panel, true));
        add(bloom(m.to, m.panel, true));
        add(burst(m.to, 7, 3, 0.7, true));
      }
      break;
    case 'highlight':
      clearTag('ring');
      m.rings.forEach((r: { rect: Rect; label?: string }, i: number) => add(highlightRing(r.rect, r.label, i, m.durationMs ?? 8000, m.reducedMotion)));
      break;
    case 'clear-highlights':
      clearTag('ring');
      break;
    case 'ghost-move':
      ghostMove(m.to, m.from, m.caption, m.durationMs, m.reducedMotion, m.avoid);
      break;
    case 'ghost-click':
      ensureGhost();
      ghost.to = m.at;
      ghost.clickAt = now();
      if (!ghost.reduced) {
        const b = burst(m.at, 5, 11, 0.5);
        add(b);
      }
      kick();
      break;
    case 'launch':
      add(launchFlight(m.from, m.to, m.icon, m.reducedMotion));
      break;
    case 'spark':
      if (!m.reducedMotion) {
        add(ripple(m.at));
        add(burst(m.at, 12, 5, 1));
      }
      break;
    case 'remote-pill':
      clearTag('remote-pill');
      for (const e of [...effects]) if (e.tag === 'remote-pill') {
        e.destroy();
        effects.delete(e);
      }
      pillOn = !!m.on;
      if (m.on) add(remotePill(m.text || 'Cadabra (WhatsApp) is working · Esc stops it'));
      break;
    case 'ghost-hide':
      if (ghost.effect) {
        ghost.hideAt = now();
        kick();
      }
      break;
    case 'clear':
    case '__reset':
      for (const e of effects) e.destroy();
      effects.clear();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (m.type === '__reset') frozenAt = null;
      break;
    case '__freeze':
      frozenAt = performance.now() + (m.after ?? 0);
      break;
  }
}

api.onMessage(handle);
api.ready();
