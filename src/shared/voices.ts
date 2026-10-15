// Voices Cadabra offers, grouped by dialect (round 5, research §9).
// Kokoro v1.0 runs on this PC; speaker ids are read from the model's own
// metadata at runtime (main/voice/kokoro-meta.ts) and the `sid` here is only a
// fallback (it matches the model, checked 2026-10-13). The Southern voices are
// cloud-only (OpenAI gpt-4o-mini-tts with an accent instruction, the user's own
// key, off by default): no offline Southern voice exists (§9.2).

export type Dialect = 'british' | 'american' | 'southern';
export type Gender = 'male' | 'female';

export interface VoiceOption {
  id: string;
  /** Kokoro speaker id (fallback; the model's metadata wins). */
  sid: number;
  label: string;
  /** Kokoro pronunciation (espeak-ng language + lexicon). */
  accent: 'british' | 'american';
  dialect: Dialect;
  gender: Gender;
  engine: 'kokoro' | 'openai';
  /** OpenAI voice name (engine 'openai'). */
  openaiVoice?: string;
  /** Kokoro's own grade (VOICES.md), for the picker's ordering. */
  grade?: string;
}

export const KOKORO_VOICES: VoiceOption[] = [
  { id: 'bm_george', sid: 26, label: 'George — warm, measured', accent: 'british', dialect: 'british', gender: 'male', engine: 'kokoro', grade: 'C' },
  { id: 'bm_fable', sid: 25, label: 'Fable — bright, articulate', accent: 'british', dialect: 'british', gender: 'male', engine: 'kokoro', grade: 'C' },
  { id: 'bm_lewis', sid: 27, label: 'Lewis — deeper, calm', accent: 'british', dialect: 'british', gender: 'male', engine: 'kokoro', grade: 'D+' },
  { id: 'bf_emma', sid: 21, label: 'Emma — clear, composed', accent: 'british', dialect: 'british', gender: 'female', engine: 'kokoro', grade: 'B-' },
  { id: 'bf_isabella', sid: 22, label: 'Isabella — soft, friendly', accent: 'british', dialect: 'british', gender: 'female', engine: 'kokoro', grade: 'C' },
  { id: 'bf_alice', sid: 20, label: 'Alice — crisp', accent: 'british', dialect: 'british', gender: 'female', engine: 'kokoro', grade: 'D' },
  { id: 'af_heart', sid: 3, label: 'Heart — warm, natural', accent: 'american', dialect: 'american', gender: 'female', engine: 'kokoro', grade: 'A' },
  { id: 'af_bella', sid: 2, label: 'Bella — bright, lively', accent: 'american', dialect: 'american', gender: 'female', engine: 'kokoro', grade: 'A-' },
  { id: 'am_michael', sid: 16, label: 'Michael — steady, friendly', accent: 'american', dialect: 'american', gender: 'male', engine: 'kokoro', grade: 'C+' },
  { id: 'am_fenrir', sid: 14, label: 'Fenrir — deeper', accent: 'american', dialect: 'american', gender: 'male', engine: 'kokoro', grade: 'C+' },
  { id: 'am_puck', sid: 15, label: 'Puck — lighter', accent: 'american', dialect: 'american', gender: 'male', engine: 'kokoro', grade: 'C+' },
  // "More voices"
  { id: 'bm_daniel', sid: 24, label: 'Daniel', accent: 'british', dialect: 'british', gender: 'male', engine: 'kokoro', grade: 'D' },
  { id: 'bf_lily', sid: 23, label: 'Lily', accent: 'british', dialect: 'british', gender: 'female', engine: 'kokoro', grade: 'D' },
];

/** Cloud voices (Southern / Texas): OpenAI gpt-4o-mini-tts + the §9.4 accent instruction. */
export const CLOUD_VOICES: VoiceOption[] = [
  { id: 'openai_marin', sid: -1, label: 'Marin — Southern (cloud)', accent: 'american', dialect: 'southern', gender: 'female', engine: 'openai', openaiVoice: 'marin' },
  { id: 'openai_cedar', sid: -1, label: 'Cedar — Southern (cloud)', accent: 'american', dialect: 'southern', gender: 'male', engine: 'openai', openaiVoice: 'cedar' },
];

export const ALL_VOICES: VoiceOption[] = [...KOKORO_VOICES, ...CLOUD_VOICES];

/** research §9.4: identical for both genders; only the voice changes. */
export const SOUTHERN_INSTRUCTIONS =
  'Speak with a warm, natural Southern American accent, like someone from central Texas: relaxed pace, gentle drawl, open vowels, friendly and helpful. Keep it subtle and authentic, not a caricature. Pronounce technical terms clearly.';

/** OpenAI policy: users must be told the voice is AI-generated. */
export const CLOUD_VOICE_DISCLOSURE =
  'Cloud voice · the text of every spoken reply is sent to OpenAI to make the audio (replies can include what’s on your screen) · uses your OpenAI key · about $0.015 per minute (approx.) · this is an AI-generated voice, not a human.';

export const DIALECT_LABEL: Record<Dialect, string> = { british: 'British', american: 'American', southern: 'Southern' };

/** The curated set shown first in the picker (and rendered in docs/voice-samples). */
export const CURATED_VOICES = ['bm_george', 'bf_emma', 'am_michael', 'af_heart', 'bm_fable', 'bf_isabella', 'af_bella', 'am_fenrir'];
export const DEFAULT_VOICE = 'bm_george';
/** Round 5: the user found 0.95 "too slow"; 1.05 is natural for Kokoro. */
export const DEFAULT_SPEED = 1.05;
/** The old default, migrated to DEFAULT_SPEED once (settings.ts). */
export const OLD_DEFAULT_SPEED = 0.95;

export function voiceById(id: string | undefined): VoiceOption {
  return ALL_VOICES.find((v) => v.id === id) ?? KOKORO_VOICES[0];
}

/** The offline voice to use instead of a cloud voice (offline, no key, or an error): American, same gender. */
export function offlineFallback(v: VoiceOption): VoiceOption {
  if (v.engine === 'kokoro') return v;
  return voiceById(v.gender === 'female' ? 'af_heart' : 'am_michael');
}

/** espeak-ng language + lexicon for a voice's accent. */
export function accentConfig(v: VoiceOption): { lang: string; lexicon: string } {
  return v.accent === 'british' ? { lang: 'en-GB-x-rp', lexicon: 'lexicon-gb-en.txt' } : { lang: 'en-us', lexicon: 'lexicon-us-en.txt' };
}

/** A short sample line for the picker's Preview button. */
export const PREVIEW_LINE = "Good morning. It's ten twenty-one a.m. Anything I can help you with?";

/** Round 5: "Choose your assistant": a name + a voice. Users can still mix any name with any voice. */
export interface Persona {
  id: string;
  dialect: Dialect;
  gender: Gender;
  voice: string;
  /** Suggested assistant name (also the wake word). */
  name: string;
  blurb: string;
}

export const PERSONAS: Persona[] = [
  { id: 'british-male', dialect: 'british', gender: 'male', voice: 'bm_george', name: 'Cadabra', blurb: 'Refined, unhurried British English.' },
  { id: 'british-female', dialect: 'british', gender: 'female', voice: 'bf_emma', name: 'Rosalind', blurb: 'Clear, composed British English.' },
  { id: 'american-male', dialect: 'american', gender: 'male', voice: 'am_michael', name: 'Leopold', blurb: 'Steady, friendly American English.' },
  { id: 'american-female', dialect: 'american', gender: 'female', voice: 'af_heart', name: 'Octavia', blurb: 'Warm, natural American English.' },
  { id: 'southern-male', dialect: 'southern', gender: 'male', voice: 'openai_cedar', name: 'Lysander', blurb: 'Relaxed Texas drawl. Cloud voice: reply text is sent to OpenAI (your key).' },
  { id: 'southern-female', dialect: 'southern', gender: 'female', voice: 'openai_marin', name: 'Beatrix', blurb: 'Warm Southern charm. Cloud voice: reply text is sent to OpenAI (your key).' },
];

export function personaFor(voice: string): Persona | undefined {
  return PERSONAS.find((p) => p.voice === voice);
}
