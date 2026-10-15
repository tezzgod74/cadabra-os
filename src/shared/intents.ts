// Fast local intent matcher for settings commands, so "switch to Copilot",
// "use the faster model", "turn off voice", "pause" work instantly and even
// when no backend is available. Only matches when the WHOLE utterance is a
// command (after stripping the wake word and politeness), so "use the faster
// model to summarize this" still goes to the AI.

import type { ModelOption, ProviderId } from './types';

export type Intent =
  | { kind: 'set-provider'; provider: ProviderId }
  | { kind: 'set-model'; model: string; label: string }
  | { kind: 'model-tier'; tier: 'fast' | 'smart' }
  | { kind: 'voice'; enabled: boolean }
  | { kind: 'speak-replies'; enabled: boolean }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'new-chat' }
  | { kind: 'shortcut' }
  | { kind: 'name'; name: string }
  /** Round 8: welcome greetings on / off ("stop greeting me"). */
  | { kind: 'greetings'; enabled: boolean }
  /** Round 8: "lock my PC" (LockWorkStation, like Win+L). */
  | { kind: 'lock-pc'; force: boolean }
  /** 0.9.5: "create a new skill called X" → Settings → Skills with the name filled in. */
  | { kind: 'new-skill'; name: string };

const PROVIDER_WORDS: [RegExp, ProviderId][] = [
  [/^(claude|clod|cloud|anthropic)$/, 'claude'],
  // ASR often splits it: "co-pilot", "co pilot", "c pilot"
  [/^(github )?(co+ ?-?pilots?|c pilot)$/, 'copilot'],
  [/^(codex|openai|open ai|chat ?gpt)$/, 'codex'],
  [/^(gemini|google|google gemini|jim ?in ?i)$/, 'gemini'],
  [/^(demo|offline|demo mode)$/, 'demo'],
];

export function normalizeUtterance(text: string, wakeWord = 'cadabra'): string {
  let t = text.toLowerCase().trim();
  t = t.replace(/[.!?,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  const wake = wakeWord.toLowerCase();
  for (const w of [`hey ${wake}`, `ok ${wake}`, `okay ${wake}`, wake, `abra${wake}`]) {
    if (t.startsWith(w + ' ') || t === w) {
      t = t.slice(w.length).trim();
      break;
    }
  }
  t = t.replace(/^(please|could you|can you|would you|kindly)\s+/, '').replace(/\s+(please|thanks|thank you|now|for me)$/g, '');
  return t.trim();
}

const FAST_WORDS = /\b(faster|fastest|quick|quicker|quickest|cheaper|cheapest|lighter|smaller)\b/;
const SMART_WORDS = /\b(smarter|smartest|best|better|stronger|strongest|most capable|more capable|bigger|biggest|powerful)\b/;

/** Rank models for a tier using common family names. Pure heuristic. */
export function pickModelForTier(models: ModelOption[], tier: 'fast' | 'smart'): ModelOption | undefined {
  const score = (m: ModelOption): number => {
    const s = `${m.id} ${m.label}`.toLowerCase();
    const fast = [/haiku/, /mini/, /flash/, /nano/, /luna/, /lite/, /fast/, /sonnet/];
    const smart = [/fable/, /opus/, /astra/, /\bpro\b/, /sol/, /sonnet/];
    const list = tier === 'fast' ? fast : smart;
    const i = list.findIndex((r) => r.test(s));
    return i === -1 ? 100 : i;
  };
  const ranked = models.filter((m) => m.id).map((m) => [score(m), m] as const).filter(([s]) => s < 100);
  ranked.sort((a, b) => a[0] - b[0]);
  return ranked[0]?.[1];
}

export function parseIntent(text: string, ctx: { models?: ModelOption[]; wakeWord?: string } = {}): Intent | null {
  const t = normalizeUtterance(text, ctx.wakeWord);
  if (!t || t.split(' ').length > 9) return null;

  // Provider switch: "switch to copilot", "use claude", "change to codex"
  const m = /^(?:switch(?:ed)?|change|swap|go|move)(?: over)?(?: back)? to (.+)$|^use (.+?)(?: instead)?$|^talk to (.+)$/.exec(t);
  if (m) {
    const target = (m[1] ?? m[2] ?? m[3] ?? '').replace(/^(the )/, '').replace(/ (backend|provider|instead)$/, '').trim();
    for (const [re, id] of PROVIDER_WORDS) if (re.test(target)) return { kind: 'set-provider', provider: id };
    // Tier: "use the faster model", "switch to the smartest model"
    if (/\bmodel\b/.test(target) || FAST_WORDS.test(target) || SMART_WORDS.test(target)) {
      if (FAST_WORDS.test(target)) return { kind: 'model-tier', tier: 'fast' };
      if (SMART_WORDS.test(target)) return { kind: 'model-tier', tier: 'smart' };
    }
    // Named model: "use opus", "switch to sonnet 5.5"
    const name = target.replace(/\bmodel\b/, '').trim();
    if (name && ctx.models?.length) {
      const hit = ctx.models.find((x) => x.label.toLowerCase() === name || x.id.toLowerCase() === name) ??
        ctx.models.find((x) => x.label.toLowerCase().includes(name) || x.id.toLowerCase().includes(name.replace(/ /g, '-')));
      if (hit) return { kind: 'set-model', model: hit.id, label: hit.label };
    }
  }
  if (/^(be |go )?(faster|quicker)$/.test(t)) return { kind: 'model-tier', tier: 'fast' };

  // Voice
  if (/^(turn|switch) (off|on) (the )?(voice|listening|wake word|microphone|mic)$/.test(t) || /^(turn|switch) (the )?(voice|listening|wake word|microphone|mic) (off|on)$/.test(t)) {
    return { kind: 'voice', enabled: /\bon\b/.test(t) };
  }
  if (/^(stop|quit) listening$|^(disable|mute) (the )?(voice|mic|microphone|wake word)$|^voice off$/.test(t)) return { kind: 'voice', enabled: false };
  if (/^(start listening|listen to me)$|^(enable|unmute) (the )?(voice|mic|microphone|wake word)$|^voice on$/.test(t)) return { kind: 'voice', enabled: true };

  // Round 8: greetings
  if (/^(stop|quit|don'?t (keep )?|no more) (greeting|welcoming) me$|^(turn|switch) off (the )?greetings$|^no more greetings$|^stop (the )?greetings$/.test(t)) return { kind: 'greetings', enabled: false };
  if (/^(start )?greet(ing)? me (again|when i (come back|log in))$|^(turn|switch) on (the )?greetings$|^you can greet me( again)?$/.test(t)) return { kind: 'greetings', enabled: true };
  // Round 8: lock the PC
  if (/^(please )?lock (my |the |this )?(pc|computer|laptop|screen|workstation|desktop|machine)( now| please| anyway)*$|^lock it( up)?( now| anyway)?$|^lock up$/.test(t)) return { kind: 'lock-pc', force: /\banyway\W*$/i.test(text) };

  // Spoken replies
  if (/^(read|speak|say) (your |the )?(answers|replies|responses)( out loud| aloud)?$|^talk back$|^(turn|switch) on (spoken|voice) (replies|answers)$/.test(t)) {
    return { kind: 'speak-replies', enabled: true };
  }
  if (/^(stop|quit) (talking|speaking|reading (answers|replies) aloud)$|^(be quiet|shush|hush)$|^(turn|switch) off (spoken|voice) (replies|answers)$/.test(t)) {
    return { kind: 'speak-replies', enabled: false };
  }

  // Pause / resume
  if (/^(pause|sleep|take a break|go to sleep|pause yourself|pause cadabra|disable yourself)$/.test(t)) return { kind: 'pause' };
  if (/^(resume|wake up|unpause|un-pause)$/.test(t)) return { kind: 'resume' };

  if (/^(new chat|start over|start a new chat|clear( the)? chat|reset)$/.test(t)) return { kind: 'new-chat' };
  const sk = /^(?:please )?(?:create|make|add|start|set up) (?:a |me a )?(?:new )?skill(?: (?:called|named) (.{1,48}))?$/.exec(t);
  if (sk) return { kind: 'new-skill', name: (sk[1] ?? '').trim() };
  // A1: "call me Alex" / "my name is Alex" / "don't use my name".
  const nm = /^(?:please )?(?:call me|my name is|my name's)\s+(\p{L}[\p{L}\p{M}' -]{0,30})$/u.exec(t);
  if (nm && !/^(back|later|tomorrow|when|if|a |an |the )/.test(nm[1])) return { kind: 'name', name: nm[1].trim() };
  if (/^(don'?t|do not|stop) (call(ing)? me by|us(e|ing)) my name$/.test(t)) return { kind: 'name', name: '' };
  if (/^(change|set|edit|customi[sz]e|rebind|remap)( my| the| your)? (summon |keyboard |hot ?)?(shortcut|hotkey|key ?binding|key)$/.test(t)) return { kind: 'shortcut' };
  return null;
}
