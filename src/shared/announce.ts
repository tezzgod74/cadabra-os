// 0.9.6: Announcements. The text is spoken on the PC exactly as written (only
// the usual speech normalisation for numbers and times): it never goes to the
// AI and is never reinterpreted. Pure parsing / limits here; playback in
// src/main/announce.ts.

/** Longest announcement spoken (characters). */
export const ANNOUNCE_MAX = 500;
/** At most this many announcements per minute (all sources together). */
export const ANNOUNCE_PER_MINUTE = 6;

export interface AnnouncementSettings {
  /** A short attention chime first. */
  chime: boolean;
  /** How many times the text is spoken (1–3). */
  repeat: number;
  /** Louder playback (natural voices). */
  boost: boolean;
  /** Output device label ('' = the system default). */
  device: string;
  /** Lower other apps' audio while announcing. */
  duck: boolean;
  /** Don't announce during the greeting quiet hours. */
  respectQuietHours: boolean;
}

export const DEFAULT_ANNOUNCEMENTS: AnnouncementSettings = { chime: true, repeat: 1, boost: false, device: '', duck: true, respectQuietHours: false };

export function mergeAnnouncements(raw: unknown): AnnouncementSettings {
  const out = { ...DEFAULT_ANNOUNCEMENTS };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of ['chime', 'boost', 'duck', 'respectQuietHours'] as const) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  if (typeof r.repeat === 'number' && Number.isFinite(r.repeat)) out.repeat = Math.min(3, Math.max(1, Math.round(r.repeat)));
  if (typeof r.device === 'string') out.device = r.device.slice(0, 200);
  return out;
}

/**
 * WhatsApp: "Announcement: …", "Announce: …" or "📢 …" (case-insensitive).
 * Returns the text after the prefix exactly as written (trimmed), or null.
 */
export function parseRemoteAnnouncement(message: string): string | null {
  const m = /^\s*(?:(?:announcement|announce)\s*[:：]|\u{1F4E2}\uFE0F?)\s*([\s\S]*)$/iu.exec(message);
  return m ? m[1].trim() : null;
}

/**
 * At the PC (voice or panel): "<name>, make an announcement: …", "announce …",
 * "announce that …". The wake word / name in front is removed; the rest is kept
 * exactly as said (case and punctuation included). Null if it isn't one.
 */
export function parseLocalAnnouncement(utterance: string, names: string[] = ['cadabra']): string | null {
  let t = utterance.trim();
  const lead = names
    .filter(Boolean)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  if (lead) t = t.replace(new RegExp(`^(?:(?:hey|ok|okay)\\s+)?(?:${lead})\\s*[,.!:;-]?\\s*`, 'i'), '');
  t = t.replace(/^(?:please\s+|can you\s+|could you\s+)/i, '');
  const m = /^(?:make|do|give|send)\s+(?:an?\s+)?announcement(?:\s*[:：,-]\s*|\s+that\s+|\s+saying\s+|\s+)([\s\S]+)$/i.exec(t) ?? /^announce(?:\s*[:：,-]\s*|\s+that\s+|\s+)([\s\S]+)$/i.exec(t);
  if (!m) return null;
  const text = m[1].trim().replace(/^["“](.*)["”]$/s, '$1').trim();
  return text || null;
}

/** Cap the length; says whether it was cut. */
export function capAnnouncement(text: string, max = ANNOUNCE_MAX): { text: string; truncated: boolean } {
  const t = text.trim();
  if (t.length <= max) return { text: t, truncated: false };
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return { text: (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim(), truncated: true };
}

/** Sliding one-minute window. */
export class AnnounceRateLimit {
  private times: number[] = [];
  constructor(
    private readonly perMinute = ANNOUNCE_PER_MINUTE,
    private readonly now: () => number = Date.now,
  ) {}
  /** True (and counted) if another announcement is allowed now. */
  take(): boolean {
    const t = this.now();
    this.times = this.times.filter((x) => t - x < 60_000);
    if (this.times.length >= this.perMinute) return false;
    this.times.push(t);
    return true;
  }
}
