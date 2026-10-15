// Rasterizes the Cadabra spark mark (no dependencies) into:
//   build/icon.ico + build/icon.png        app / installer icon (indigo tile + gold spark)
//   resources/icons/tray-{normal,paused,listening}.png (+ @2x)
//   resources/icons/spark.svg
// Run: node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');

// ---- PNG encoder -----------------------------------------------------------
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- shapes ------------------------------------------------------------------
// Four-point spark: concave "astroid" |x|^p + |y|^p <= 1 with p < 1.
const sparkInside = (x, y, p = 0.62) => Math.pow(Math.abs(x), p) + Math.pow(Math.abs(y), p) <= 1;
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => c1.map((v, i) => lerp(v, c2[i], t));

function render(size, { tile, palette, dot }) {
  const ss = 4; // supersampling
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (px + (sx + 0.5) / ss) / size; // 0..1
          const v = (py + (sy + 0.5) / ss) / size;
          let col = [0, 0, 0];
          let al = 0;
          if (tile) {
            // rounded square tile, deep indigo gradient with violet glow
            const m = 0.06, rad = 0.22;
            const qx = Math.max(Math.abs(u - 0.5) - (0.5 - m - rad), 0);
            const qy = Math.max(Math.abs(v - 0.5) - (0.5 - m - rad), 0);
            if (Math.hypot(qx, qy) <= rad) {
              const glow = Math.max(0, 1 - Math.hypot(u - 0.32, v - 0.28) / 0.75);
              col = mix([22, 15, 52], [84, 62, 190], glow * 0.85);
              al = 1;
            }
          }
          // main spark
          const scale = tile ? 0.36 : 0.47;
          const cx = tile ? 0.5 : 0.47, cy = tile ? 0.52 : 0.53;
          const x = (u - cx) / scale, y = (v - cy) / scale;
          if (sparkInside(x, y)) {
            const t = Math.min(1, Math.max(0, (u - cx + v - cy) / (2 * scale) + 0.5));
            col = mix(palette[0], palette[1], t);
            al = 1;
          }
          // small companion twinkle (top-right)
          const s2 = tile ? 0.1 : 0.15;
          const x2 = (u - (tile ? 0.76 : 0.83)) / s2, y2 = (v - (tile ? 0.26 : 0.18)) / s2;
          if (sparkInside(x2, y2, 0.6)) {
            col = palette[0];
            al = 1;
          }
          if (dot) {
            const d = Math.hypot(u - 0.82, v - 0.82);
            if (d < 0.17) {
              col = d < 0.12 ? dot : [255, 255, 255];
              al = 1;
            }
          }
          r += col[0] * al; g += col[1] * al; b += col[2] * al; a += al;
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      out[i + 3] = Math.round((a / n) * 255);
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
    }
  }
  return out;
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    dir[i * 16] = size >= 256 ? 0 : size;
    dir[i * 16 + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, i * 16 + 4);
    dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(data.length, i * 16 + 8);
    dir.writeUInt32LE(offset, i * 16 + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((x) => x.data)]);
}

const GOLD = [[255, 241, 196], [233, 162, 59]];
const GREY = [[214, 210, 228], [140, 134, 160]];

fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.mkdirSync(path.join(root, 'resources', 'icons'), { recursive: true });

const appSizes = [16, 24, 32, 48, 64, 128, 256];
const appImgs = appSizes.map((s) => ({ size: s, data: png(s, s, render(s, { tile: true, palette: GOLD })) }));
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico(appImgs));
fs.writeFileSync(path.join(root, 'build', 'icon.png'), png(512, 512, render(512, { tile: true, palette: GOLD })));
fs.writeFileSync(path.join(root, 'resources', 'icons', 'app.png'), png(256, 256, render(256, { tile: true, palette: GOLD })));

for (const [name, opts] of Object.entries({
  normal: { palette: GOLD },
  paused: { palette: GREY },
  listening: { palette: GOLD, dot: [111, 227, 165] },
  capturing: { palette: [[255, 250, 225], [255, 190, 80]], dot: [255, 120, 90] },
})) {
  fs.writeFileSync(path.join(root, 'resources', 'icons', `tray-${name}.png`), png(16, 16, render(16, opts)));
  fs.writeFileSync(path.join(root, 'resources', 'icons', `tray-${name}@2x.png`), png(32, 32, render(32, opts)));
}

fs.writeFileSync(
  path.join(root, 'resources', 'icons', 'spark.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF1C4"/><stop offset=".45" stop-color="#FFD27A"/><stop offset="1" stop-color="#E9A23B"/></linearGradient></defs><path d="M12 1.5c.9 6.1 4.4 9.6 10.5 10.5-6.1.9-9.6 4.4-10.5 10.5-.9-6.1-4.4-9.6-10.5-10.5C7.6 11.1 11.1 7.6 12 1.5Z" fill="url(#g)"/><path d="M20 2.2c.2 1.3.9 2 2.2 2.2-1.3.2-2 .9-2.2 2.2-.2-1.3-.9-2-2.2-2.2 1.3-.2 2-.9 2.2-2.2Z" fill="#FFE7A8"/></svg>\n`,
);
console.log('icons written');
