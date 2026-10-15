// REVIEW-4 TTS-1 residual: is this PC fast enough for the natural voice?
// The verdict is measured over a sliding window (one busy moment can't flip
// it), persisted per machine (a slow PC doesn't stutter for 4 s at every
// start), and expires after a cool-down so it is re-tested later.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_RTF = 0.6;
/** A "too slow" verdict is trusted for this long, then the natural voice is tried again. */
export const SLOW_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const WINDOW_CHUNKS = 6;
const MIN_AUDIO_SEC = 4;
const MIN_CHUNKS = 3;

export interface SpeedSample {
  synthSec: number;
  audioSec: number;
}

export interface SpeedVerdict {
  rtf: number | null;
  /** null = not enough audio yet to decide. */
  tooSlow: boolean | null;
}

/** Decide from the most recent sentences (warm-up sentence already excluded by the caller). */
export function speedVerdict(samples: SpeedSample[]): SpeedVerdict {
  const recent = samples.slice(-WINDOW_CHUNKS);
  const audio = recent.reduce((a, s) => a + s.audioSec, 0);
  const synth = recent.reduce((a, s) => a + s.synthSec, 0);
  const rtf = audio > 0 ? synth / audio : null;
  if (rtf == null || audio < MIN_AUDIO_SEC || recent.length < MIN_CHUNKS) return { rtf, tooSlow: null };
  // Every sentence in the window must be slow-ish too: a single long stall
  // (a build, a game loading) shouldn't decide on its own.
  const slowOnes = recent.filter((s) => s.audioSec > 0 && s.synthSec / s.audioSec > MAX_RTF).length;
  return { rtf, tooSlow: rtf > MAX_RTF && slowOnes >= Math.ceil(recent.length / 2) };
}

export function machineId(): string {
  const c = os.cpus();
  return `${c[0]?.model ?? 'cpu'}|${c.length}|${Math.round(os.totalmem() / 2 ** 30)}`;
}

interface Stored {
  machine: string;
  rtf: number | null;
  tooSlow: boolean;
  at: number;
}

export class SpeedStore {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  static for(userData: string) {
    return new SpeedStore(path.join(userData, 'tts-speed.json'));
  }

  /** The persisted "too slow" verdict, if it's for this machine and still fresh. */
  load(): { rtf: number | null; tooSlow: boolean } {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Stored;
      if (s.machine !== machineId()) return { rtf: null, tooSlow: false };
      if (s.tooSlow && this.now() - s.at > SLOW_COOLDOWN_MS) return { rtf: s.rtf, tooSlow: false };
      return { rtf: s.rtf, tooSlow: !!s.tooSlow };
    } catch {
      return { rtf: null, tooSlow: false };
    }
  }

  save(rtf: number | null, tooSlow: boolean) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ machine: machineId(), rtf, tooSlow, at: this.now() } satisfies Stored));
    } catch {
      /* best effort */
    }
  }
}
