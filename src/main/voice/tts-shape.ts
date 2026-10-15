// Round 5 cadence: each synthesised sentence is trimmed of long leading /
// trailing silence (Kokoro pads both ends, which made replies sound halting),
// given 6 ms fades (no clicks where chunks meet) and an optional short pause so
// sentence boundaries sound natural. Pure; unit-tested.

const SILENCE = 0.004;

export function shapeChunk(samples: Float32Array, sampleRate: number, o: { pauseMs?: number; keepMs?: number; fadeMs?: number } = {}): Float32Array {
  const keep = Math.round(((o.keepMs ?? 40) / 1000) * sampleRate);
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) < SILENCE) start++;
  let end = samples.length;
  while (end > start && Math.abs(samples[end - 1]) < SILENCE) end--;
  if (end <= start) return new Float32Array(Math.round(((o.pauseMs ?? 0) / 1000) * sampleRate));
  start = Math.max(0, start - keep);
  end = Math.min(samples.length, end + keep);
  const body = samples.subarray(start, end);
  const pause = Math.round(((o.pauseMs ?? 0) / 1000) * sampleRate);
  const out = new Float32Array(body.length + pause);
  out.set(body);
  const fade = Math.min(Math.round(((o.fadeMs ?? 6) / 1000) * sampleRate), Math.floor(body.length / 2));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[i] *= g;
    out[body.length - 1 - i] *= g;
  }
  return out;
}
