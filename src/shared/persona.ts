// Round 5: who the assistant is this turn (its chosen name) and, optionally,
// light dialect phrasing (research §9.5). Added to the per-turn context only;
// never applied to code, paths, UI labels or quoted errors.
import { displayName } from './assistant';
import type { VoiceSettings } from './types';
import { voiceById, type Dialect } from './voices';

export const PHRASING_RULES: Record<Dialect, string> = {
  american: '',
  british: 'Use British spelling (colour, organise) and, at most once per reply, a light British touch ("cheers", "brilliant", "right then").',
  southern:
    'At most once per reply, a light Southern touch: "Howdy" as a greeting, "y\'all" for plural you, "fixin\' to" for about to, or "reckon". Never in code, paths, commands or error text; never exaggerated.',
};

/** The dialect of the chosen voice. */
export function voiceDialect(v: Pick<VoiceSettings, 'ttsVoice'>): Dialect {
  return voiceById(v.ttsVoice).dialect;
}

export function personaContext(v: Pick<VoiceSettings, 'wakeWord' | 'ttsVoice' | 'phrasing'>): string {
  const parts: string[] = [];
  const name = displayName(v.wakeWord);
  if (name.toLowerCase() !== 'cadabra') parts.push(`Your name is ${name} (the user chose it; it is also your wake word). Cadabra OS is the app you live in.`);
  if (v.phrasing) {
    const rule = PHRASING_RULES[voiceDialect(v)];
    if (rule) parts.push(`Phrasing: ${rule}`);
  }
  return parts.join(' ');
}
