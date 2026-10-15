// Round 5: the assistant's name doubles as the wake word. The app stays
// "Cadabra OS"; the assistant can be called something the user likes saying.

import type { KeywordTuning } from './kws-tokens';

export type NameGender = 'masculine' | 'feminine' | 'neutral';

export interface AssistantName {
  name: string;
  gender: NameGender;
  /** Near-words that should NOT wake it (added to the KWS file as decoys). */
  decoys: string[];
  note?: string;
  /** KWS tuning from the test matrix (boost, threshold, spoken variants). */
  tune?: KeywordTuning;
}

/**
 * Curated names: 2–3 syllables, distinctive, rarely said in everyday speech,
 * not another assistant's trademark, and segmenting into several pieces for
 * the KWS model. Kept only if they passed the KWS matrix (docs/BUILD_NOTES.md:
 * Windows-TTS male + female voices, positives and near-word negatives).
 */
export const CURATED_NAMES: AssistantName[] = [
  // REVIEW-5 V5-5: Cadabra keeps its round-4 line (one path, threshold 0.28 at
  // Medium), which worked for the user, until a long TV/podcast negative soak passes.
  { name: 'Cadabra', gender: 'neutral', decoys: ['Abracadabra'], note: 'The original', tune: { paths: 1, thresholdOffset: 0 } },
  { name: 'Vesper', gender: 'neutral', decoys: ['Whisper', 'West pier'] },
  { name: 'Indigo', gender: 'neutral', decoys: ['India', 'Indie'] },
  { name: 'Octavia', gender: 'feminine', decoys: ['Octave', 'Octagon'] },
  { name: 'Rosalind', gender: 'feminine', decoys: ['Rosalie', 'Roslyn'] },
  { name: 'Beatrix', gender: 'feminine', decoys: ['Beat the tricks'] },
  { name: 'Bramwell', gender: 'masculine', decoys: ['Bramble', 'Brand new'] },
  { name: 'Leopold', gender: 'masculine', decoys: ['Leopard'] },
  { name: 'Lysander', gender: 'masculine', decoys: ['Leander', 'Lavender'] },
];

export const DEFAULT_NAME = 'Cadabra';

/** Other assistants' names / trademarks: never offered, refused as custom names. */
export const RESERVED_NAMES = ['alexa', 'siri', 'cortana', 'jarvis', 'gemini', 'copilot', 'claude', 'echo', 'bixby', 'google', 'chatgpt', 'computer', 'hey'];

/** Common English words that make poor wake words (constant false wakes). */
const COMMON = new Set(
  'about after again also another because before being between could every first from good great have here home just know like little look make many more most much never next nothing other people place really right same should something still such take than that their them then there these they thing think this those time today very want water what when where which while will with without work would year your hello thanks okay sorry please maybe later never always morning evening tonight window screen button mouse music movie phone email message coffee dinner number letter paper money table person family friend children answer question problem system program network server office market garden yellow purple orange banana tomato potato happy funny simple open close start stop play pause again'.split(
    ' ',
  ),
);

/** Rough English syllable count (vowel groups, silent final e). */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  const groups = w.replace(/e$/, '').match(/[aeiouy]+/g)?.length ?? 0;
  return Math.max(1, groups);
}

export interface NameCheck {
  ok: boolean;
  /** Normalised display form ("juniper" → "Juniper"). */
  name: string;
  error?: string;
  warnings: string[];
}

/** Validate a custom assistant name (used as the wake word). */
export function checkName(raw: string): NameCheck {
  const t = raw.trim().replace(/\s+/g, ' ');
  const name = t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : '';
  const warnings: string[] = [];
  if (!t) return { ok: false, name, error: 'Type a name.', warnings };
  if (!/^[A-Za-z]+( [A-Za-z]+)?$/.test(t)) return { ok: false, name, error: 'Letters only (one or two words).', warnings };
  if (RESERVED_NAMES.includes(t.toLowerCase().replace(/^hey /, ''))) return { ok: false, name, error: 'That’s another assistant’s name. Pick something of your own.', warnings };
  const syl = t.split(' ').reduce((a, w) => a + syllables(w), 0);
  if (syl < 2) return { ok: false, name, error: 'Too short to recognise reliably: use 2–4 syllables.', warnings };
  if (syl > 4) return { ok: false, name, error: 'A bit long to say every time: use 2–4 syllables.', warnings };
  if (t.length < 4) warnings.push('Very short names wake by mistake more often.');
  if (t.split(' ').some((w) => COMMON.has(w.toLowerCase()))) warnings.push('That’s an everyday word, so it may wake up when you didn’t mean it.');
  return { ok: true, name, warnings };
}

/** The display form of the configured wake word / name. */
export function displayName(wakeWord: string | undefined): string {
  const w = (wakeWord || DEFAULT_NAME).trim();
  return w
    .split(/\s+/)
    .map((x) => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase())
    .join(' ');
}

export function curatedName(name: string): AssistantName | undefined {
  return CURATED_NAMES.find((n) => n.name.toLowerCase() === name.trim().toLowerCase());
}

/** A loose phonetic key: ASR spells unusual names many ways ("Kadaborra", "Marlo"). */
export function phoneticKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f')
    .replace(/ck|q|c(?=[aou])|c$/g, 'k')
    .replace(/c/g, 's')
    .replace(/[yi]/g, 'i')
    .replace(/w$|e$|h$/g, '')
    .replace(/(.)\1+/g, '$1');
}

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/**
 * Second-stage wake check on the transcript: does it start with the name
 * (fuzzily)? Returns the request after it, or null.
 */
export function matchWake(text: string, name: string): { request: string } | null {
  const target = phoneticKey(name);
  if (!target) return null;
  const words = text.trim().split(/\s+/);
  let skip = 0;
  if (/^(hey|ok|okay|oi|hi)[,.!]?$/i.test(words[0] ?? '')) skip = 1;
  const allowed = Math.max(1, Math.floor(target.length / 3));
  // The name may come out as 1–3 words ("Cada bra", "Percy val").
  for (let n = 1; n <= 3 && skip + n <= words.length; n++) {
    const cand = phoneticKey(words.slice(skip, skip + n).join(''));
    if (!cand) continue;
    if (lev(cand, target) <= allowed) {
      const rest = words.slice(skip + n).join(' ').replace(/^[\s,.!?:;-]+/, '').trim();
      return { request: rest };
    }
  }
  return null;
}
