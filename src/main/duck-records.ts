// 0.9.7 (REVIEW-0.9.6 A1): the crash-recovery file for apps lowered during an
// announcement. Several announcements can overlap, so records are merged and
// each announcement removes only its own entries (never the whole file).

import fs from 'node:fs';
import type { DuckedSession } from './helper';

export function readDuckRecords(file: string): DuckedSession[] {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j) ? j.filter((x) => typeof x?.id === 'string' && typeof x?.volume === 'number') : [];
  } catch {
    return [];
  }
}

function write(file: string, list: DuckedSession[]): void {
  if (list.length) fs.writeFileSync(file, JSON.stringify(list));
  else fs.rmSync(file, { force: true });
}

/** Add one announcement's sessions (an id already recorded keeps its first, original volume). */
export function addDuckRecords(file: string, add: DuckedSession[]): void {
  if (!add.length) return;
  const cur = readDuckRecords(file);
  for (const s of add) if (!cur.some((c) => c.id === s.id)) cur.push(s);
  write(file, cur);
}

/** Remove one announcement's sessions after they were restored; others stay. */
export function removeDuckRecords(file: string, done: DuckedSession[]): void {
  const ids = new Set(done.map((d) => d.id));
  write(file, readDuckRecords(file).filter((c) => !ids.has(c.id)));
}

/**
 * 0.9.7 (A3): hold the wake word muted for an announcement, then put back
 * whatever state it was in before (not a guess from settings).
 */
export class WakeMuteHold {
  constructor(
    private readonly get: () => boolean,
    private readonly set: (muted: boolean) => void,
  ) {}
  hold(): () => void {
    const before = this.get();
    this.set(true);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.set(before);
    };
  }
}
