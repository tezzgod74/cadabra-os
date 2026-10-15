// Round 8 (user request): spoken welcome quips — no panel — when the user signs
// in, unlocks, or comes back after being away. Playful, varied, in the user's
// tone; the name is used sparingly; no repeats until a pool is exhausted.
// Pure; unit-tested. The "is it rude to speak now?" checks live in main/greeter.ts.

export type GreetTrigger = 'login' | 'unlock' | 'return';
export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'late';

export interface GreetLine {
  id: string;
  text: string;
  triggers: GreetTrigger[];
  /** Omitted = any time of day. */
  times?: TimeOfDay[];
  /** 1 = Monday … 5 = Friday (Date.getDay()). */
  day?: number;
  /** Only with dialect phrasing on and a matching voice. */
  dialect?: 'british' | 'southern';
}

const L = (id: string, text: string, triggers: GreetTrigger[], times?: TimeOfDay[], extra: Partial<GreetLine> = {}): GreetLine => ({ id, text, triggers, ...(times ? { times } : {}), ...extra });
const ALL: GreetTrigger[] = ['login', 'unlock'];
const RET: GreetTrigger[] = ['return'];

export const GREETINGS: GreetLine[] = [
  // ---- sign-in / unlock: morning
  L('m1', "Good morning, {name}. Welcome back. Let me know if you need anything.", ALL, ['morning']),
  L('m2', "Morning! Coffee first, then world domination?", ALL, ['morning']),
  L('m3', "Good morning. I've been keeping your desktop warm.", ALL, ['morning']),
  L('m4', "Rise and shine, {name}. I'm here when you need me.", ALL, ['morning']),
  L('m5', "Morning. Fresh day, clean slate. I'm around if you need me.", ALL, ['morning']),
  L('m6', "Good morning! Let's make today look easy.", ALL, ['morning']),
  L('m7', "Hey, early bird. I'm up too, obviously.", ALL, ['morning']),
  L('m8', "Morning, {name}. Ready when you are.", ALL, ['morning']),
  L('m9', "Good morning. Shall we pretend that inbox doesn't exist for five more minutes?", ALL, ['morning']),
  L('m10', "Morning! I did absolutely nothing while you were gone. Very relaxing.", ALL, ['morning']),
  // ---- sign-in / unlock: afternoon
  L('a1', "Good afternoon, {name}. Welcome back.", ALL, ['afternoon']),
  L('a2', "What's up? Couldn't stay away? I'm here if something comes up.", ALL, ['afternoon']),
  L('a3', "Afternoon! Back to it, then.", ALL, ['afternoon']),
  L('a4', "Hey there. The afternoon shift has arrived.", ALL, ['afternoon']),
  L('a5', "Welcome back. I kept your seat warm.", ALL, ['afternoon']),
  L('a6', "Good afternoon. Say the word if you need a hand.", ALL, ['afternoon']),
  L('a7', "Oh hey, {name}. Missed you. A little.", ALL, ['afternoon']),
  L('a8', "Afternoon. Lunch treat you well?", ALL, ['afternoon']),
  L('a9', "Back again? I'll pretend I wasn't waiting.", ALL, ['afternoon', 'evening']),
  L('a10', "Hello again. Let's get things done.", ALL, ['afternoon']),
  // ---- sign-in / unlock: evening
  L('e1', "Good evening, {name}. Welcome back.", ALL, ['evening']),
  L('e2', "Evening! Clocking in or clocking out?", ALL, ['evening']),
  L('e3', "Hey, night owl in training. I'm here if you need me.", ALL, ['evening']),
  L('e4', "Good evening. Let's keep it short and sweet tonight.", ALL, ['evening']),
  L('e5', "Evening, {name}. What are we getting up to?", ALL, ['evening']),
  L('e6', "Welcome back. The evening crew is ready.", ALL, ['evening']),
  L('e7', "Hello, hello. Evening mode activated.", ALL, ['evening']),
  L('e8', "Good evening. I'll be over here, being helpful.", ALL, ['evening']),
  // ---- sign-in / unlock: late night
  L('n1', "Burning the midnight oil, {name}?", ALL, ['late']),
  L('n2', "It's late. I won't tell anyone.", ALL, ['late']),
  L('n3', "Hey. Couldn't sleep either?", ALL, ['late']),
  L('n4', "Late shift? I'm here. Quietly.", ALL, ['late']),
  L('n5', "Welcome back. Bed is overrated anyway, right?", ALL, ['late']),
  L('n6', "Still up? Respect. Let me know if you need anything.", ALL, ['late']),
  // ---- any time
  L('g1', "Welcome back, {name}.", ALL),
  L('g2', "Hey, you're back. I'm here if you need me.", ALL),
  L('g3', "There you are. Let me know if anything comes up.", ALL),
  L('g4', "Oh good, it's you. Ready when you are.", ALL),
  L('g5', "Look who's back.", ALL),
  L('g6', "Hello again! I'm all ears.", ALL),
  // ---- day-specific
  L('d1', "Happy Monday, {name}. Let's ease into it.", ALL, ['morning', 'afternoon'], { day: 1 }),
  L('d2', "Monday again? Bold of it to show up. I'm here if you need me.", ALL, undefined, { day: 1 }),
  L('d3', "It's Friday! Let's land this week gently.", ALL, undefined, { day: 5 }),
  L('d4', "Happy Friday, {name}. Nearly there.", ALL, ['morning', 'afternoon'], { day: 5 }),
  L('d5', "Friday evening? Shouldn't you be somewhere fun?", ALL, ['evening', 'late'], { day: 5 }),
  // ---- dialect touches (only with phrasing on)
  L('b1', "Morning! Kettle's on, figuratively speaking.", ALL, ['morning'], { dialect: 'british' }),
  L('b2', "Alright? Welcome back, {name}.", ALL, undefined, { dialect: 'british' }),
  L('s1', "Howdy, {name}. Welcome back.", ALL, undefined, { dialect: 'southern' }),
  L('s2', "Well, look who's back. Y'all need anything, just holler.", ALL, undefined, { dialect: 'southern' }),
  // ---- back after being away (no lock)
  L('r1', "Back already?", RET),
  L('r2', "Oh, hi! I was just about to start a podcast.", RET),
  L('r3', "Welcome back. Did you miss me? Don't answer that.", RET),
  L('r4', "And we're back.", RET),
  L('r5', "Hey, {name}. Good break?", RET),
  L('r6', "There you are. I was getting lonely.", RET),
  L('r7', "Welcome back. Everything's just where you left it.", RET),
  L('r8', "Ah, the return of the {name}.", RET),
  L('r9', "Look who decided to come back.", RET),
  L('r10', "Hi again. Recharged?", RET),
  L('r11', "Back so soon? I'd barely started daydreaming.", RET, ['morning', 'afternoon']),
  L('r12', "Snack break, was it? Very wise.", RET, ['afternoon', 'evening']),
  L('r13', "Welcome back. The screen missed you.", RET),
  L('r14', "Hey! Right where we left off.", RET),
  L('r15', "Still up and back for more? Respect.", RET, ['late']),
];

/** Short comebacks when the user banters back after a greeting. */
export const COMEBACKS = ["I try.", "I'll be here all week.", "Thank you, I've been practising.", "You're too kind.", "Tough crowd.", "Happy to help. Mostly with jokes."];

export function timeOfDay(d: Date): TimeOfDay {
  const h = d.getHours();
  return h >= 5 && h < 12 ? 'morning' : h < 17 && h >= 12 ? 'afternoon' : h >= 17 && h < 22 ? 'evening' : 'late';
}

export interface PickOptions {
  trigger: GreetTrigger;
  now: Date;
  /** First name, or '' (lines with {name} are then said without it). */
  name: string;
  /** Ids used recently (oldest first); lines aren't repeated until their pool is exhausted. */
  recent: readonly string[];
  /** Dialect phrasing layer. */
  dialect?: 'british' | 'southern' | null;
  rng?: () => number;
}

function fill(text: string, name: string): string {
  if (name) return text.replace(/\{name\}/g, name);
  // No name: drop it gracefully ("Good morning, {name}." → "Good morning.").
  return text
    .replace(/,\s*\{name\}(?=[.?!,])/g, '')
    .replace(/\s*\{name\},?\s*/g, ' ')
    .replace(/\bthe \.$/, '.')
    .replace(/\s+([.?!,])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Pick a line for this trigger / time / day, avoiding recent ones. */
export function pickGreeting(o: PickOptions): { id: string; text: string } {
  const tod = timeOfDay(o.now);
  const dow = o.now.getDay();
  const pool = GREETINGS.filter(
    (g) =>
      g.triggers.includes(o.trigger) &&
      (!g.times || g.times.includes(tod)) &&
      (g.day == null || g.day === dow) &&
      (!g.dialect || g.dialect === o.dialect) &&
      // "Ah, the return of the {name}" only works with a name.
      (o.name || !/the \{name\}/.test(g.text)),
  );
  const fresh = pool.filter((g) => !o.recent.includes(g.id));
  const from = fresh.length ? fresh : pool; // pool exhausted → start over
  // Day-specific lines win on their day (once).
  const special = from.filter((g) => g.day === dow);
  const choices = special.length ? special : from;
  const rng = o.rng ?? Math.random;
  const g = choices[Math.floor(rng() * choices.length)] ?? GREETINGS[0];
  // Use the name sparingly: in about a third of the lines that have a slot.
  const useName = !!o.name && rng() < 0.6;
  return { id: g.id, text: fill(g.text, useName ? o.name : '') };
}

/** What the user said in the short window after a greeting. */
export function classifyGreetingReply(text: string): 'playful' | 'closing' | 'request' | 'empty' {
  let t = text.toLowerCase().replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return 'empty';
  // "haha very funny", "lol thanks": a laugh in front doesn't make it a request.
  if (/^(ha(ha)*|lol|lmao|heh)( |$)/.test(t)) t = t.replace(/^(ha(ha)*|lol|lmao|heh)\s*/, '') || 'ha';
  if (/^(ha(ha)*|lol|lmao|very funny|you'?re (so )?funny|funny|nice (one|try)|good one|hilarious|cute|hi|hello|hey|hey you|hiya|morning|good morning|good (afternoon|evening)|yo|sup|what'?s up|missed you( too)?|i missed you( too)?|you too|same|ha you'?re funny|ha ha you'?re funny|cheeky|(oh )?stop( it)?|thanks?|thank you)( (cadabra|buddy|mate))?$/.test(t)) return 'playful';
  if (/^(no|nope|not now|nothing|i'?m good|all good|bye|goodbye|quiet|shh+|be quiet|later)( thanks?)?$/.test(t)) return 'closing';
  return 'request';
}
