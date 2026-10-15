// Round 5 (research §9): Kokoro speaker ids come from the model's own metadata
// ("id2speaker" in the ONNX metadata_props, at the end of model.onnx), not a
// hard-coded table. The table in shared/voices.ts is only the fallback.
import fs from 'node:fs';

/** Parse "0->af_alloy,1->af_aoede,…" into name → id. */
export function parseId2Speaker(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of s.split(',')) {
    const m = /^\s*(\d+)->([a-z]{2}_[a-z]+)\s*$/.exec(part);
    if (m) out.set(m[2], Number(m[1]));
  }
  return out;
}

/** Find the id2speaker value inside a chunk of the ONNX file. */
export function findId2Speaker(buf: Buffer): Map<string, number> {
  const key = buf.indexOf('id2speaker');
  if (key < 0) return new Map();
  // protobuf: key string, then field 2 (0x12) + varint length + value
  let i = key + 'id2speaker'.length;
  if (buf[i] !== 0x12) return new Map();
  i++;
  let len = 0;
  let shift = 0;
  for (;;) {
    const b = buf[i++];
    len |= (b & 0x7f) << shift;
    if (b < 0x80) break;
    shift += 7;
  }
  return parseId2Speaker(buf.toString('utf8', i, i + len));
}

const cache = new Map<string, Map<string, number>>();

/** Speaker ids from model.onnx (reads only the last 256 KB). Empty map if unavailable. */
export function readKokoroSpeakers(modelPath: string): Map<string, number> {
  const hit = cache.get(modelPath);
  if (hit) return hit;
  let map = new Map<string, number>();
  try {
    const size = fs.statSync(modelPath).size;
    const n = Math.min(size, 256 * 1024);
    const fd = fs.openSync(modelPath, 'r');
    try {
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      map = findId2Speaker(buf);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* fall back to the table */
  }
  cache.set(modelPath, map);
  return map;
}
