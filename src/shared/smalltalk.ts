// Local, sub-second answers that never need a backend: presence checks,
// time/date, greetings and conversation closers ("no thanks"). Mixed
// utterances ("are you there? what time is it") are answered only when EVERY
// clause is local; otherwise the whole thing goes to the AI.

export type LocalAnswer = { kind: 'answer'; text: string } | { kind: 'close'; text: string };

export interface SmalltalkCtx {
  now: Date;
  name?: string;
  /** First turn of a conversation → greet by name. */
  firstTurn: boolean;
  /** Voice turn → end with a short "Anything I can help you with?". */
  voice: boolean;
  wakeWord?: string;
}

export function greeting(now: Date): string {
  const h = now.getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** "10:21 a.m." (British style; the voice says "ten twenty-one a.m."). */
export function formatTime(now: Date): string {
  const h = now.getHours();
  const m = now.getMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Sunday 11 October 2026". */
export function formatDate(now: Date): string {
  return now.toLocaleDateString('en-GB', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).replace(',', '');
}

function stripWake(t: string, wake = 'cadabra'): string {
  return t
    .replace(new RegExp(`^\\s*(hey |ok |okay )?(${wake}|kadabra|ka dabra)\\b[\\s,.!?:;-]*`, 'i'), '')
    .trim();
}

const PRESENCE = /^(are you (there|here|around|awake|listening)|you there|anybody (there|home)|hello|hi|hey( there)?|yo|cadabra)$/;
const TIME = /^(what('?s| is) the time( now| right now)?|what time is it( now| right now)?|(tell me )?the time|time( please)?|do you (know|have) the time)$/;
const DATE = /^(what('?s| is) (the date|today('?s date)?)|what day is (it|today)|what('?s| is) today|today('?s)? date|(tell me )?the date)$/;
/**
 * Round 7 (the user's spec): a closing phrase ends the conversation. Broad on
 * purpose, but only when EVERY clause is a closer or a filler, so "thanks, and
 * also open Spotify" never closes.
 */
const CLOSE =
  /^((no|nope|nah|no no)( thanks?( you)?| that'?s (it|all|everything))?|(no |nope |nah )?(thanks?|thank you|thx|cheers|ty|ta)( (cadabra|so much|very much|a lot|again|anyway|for (that|the help|your help)))?|(that('?s| is)|that'?ll be|this is) (all|it|everything)( for now| thanks?| for today)?|never ?mind|nothing( else)?( thanks?)?|i'?m (good|fine|all set|done|ok(ay)?)|(all|we'?re) (good|set|done)|we'?re done|(good)?bye( bye)?|bye for now|see (you|ya)( later| soon)?|later|take care|have a good (one|day|night|evening)|talk (to you )?later|ttyl|dismiss|close|go away|got it|gotcha|understood|appreciate (it|that|you)|much appreciated|good ?night|night night|that'?s (what|all) i needed|that'?s all i (wanted|need)|i'?m all set|all set|we'?re good|i'?m good( now)?|(ok(ay)? )?(i'?ll )?talk (to you )?(later|soon)|catch you later|that'?ll do( it)?|good ?(night|nite)( night)?|night( night)?|nite|nighty night|sleep well)$/;

/**
 * REVIEW-7 W7-4: these also mean "OK, I follow" in the middle of a task, so on
 * their own they close only right after an open "Anything else?".
 */
const SOFT = /^(got it|gotcha|understood|later|close|dismiss|ok(ay)? got it)$/;

/**
 * Round 10.5 (user: "when I naturally end a conversation, the assistant should stop
 * listening and go away"): acknowledgements that end a conversation after a
 * FINISHED answer ("cool", "perfect", "sounds good", "good to know"), but not
 * after a question that expects an answer, and never when a request follows.
 * "yes" / "sure" / "right" are answers, not acknowledgements, so they're not here.
 */
const ACK = /^(ok(ay)?|alright|all right|cool|ok(ay)? cool|cool cool|perfect|awesome|great|nice|lovely|brilliant|excellent|sweet|wonderful|fantastic|neat|sounds good|that works|works for me|good to know|noted|fair enough|makes sense|gotcha|got it|understood|that'?s (great|perfect|awesome|cool|helpful|fine|good|nice|interesting)|(very|super|really) helpful|nice one|good stuff)$/;

/** Acknowledgements that may ride along with a closer ("okay, thank you", "perfect, thanks"). */
const FILLER = /^(ok(ay)?|alright|all right|great|perfect|awesome|cool|nice|lovely|brilliant|excellent|good|sounds good|wonderful|fantastic|sweet|right|yes|yeah|yep|sure|that'?s (great|perfect|awesome|good|fine|fantastic|brilliant|lovely|helpful)|(very|super) helpful)$/;

/** "okay perfect thank you" → "thank you" (leading acknowledgements dropped). */
function stripFillers(c: string): string {
  let t = c;
  for (let i = 0; i < 4; i++) {
    const m = /^(ok(ay)?|alright|all right|great|perfect|awesome|cool|nice|lovely|brilliant|excellent|good|wonderful|fantastic|sweet|right|yes|yeah|yep|sure|well|oh) /.exec(t);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  return t;
}

/** "thanks octavia" → "thanks" (closers know the configured assistant name). */
function stripName(c: string, wake?: string): string {
  const names = ['cadabra', ...(wake ? [wake.toLowerCase()] : [])].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return c.replace(new RegExp(`\\s+(${names.join('|')})$`), '').replace(new RegExp(`^(${names.join('|')})\\s+`), '');
}

const isCloser = (c: string, wake?: string) => CLOSE.test(stripFillers(stripName(c, wake)));
const isSoftOnly = (c: string, wake?: string) => SOFT.test(stripFillers(stripName(c, wake))) || ACK.test(stripName(c, wake));
const isAck = (c: string, wake?: string) => ACK.test(stripName(c, wake));

/** The utterance closes only via "got it / understood / later" (needs an open question first). */
export function isSoftClose(text: string, wake?: string): boolean {
  const cs = clauses(text, wake);
  return cs.length > 0 && cs.every((c) => isSoftOnly(c, wake) || FILLER.test(c)) && cs.some((c) => isSoftOnly(c, wake)) && !cs.some((c) => isCloser(c, wake) && !isSoftOnly(c, wake));
}

/** Round 10.5: the whole utterance is only acknowledgements ("cool", "okay perfect"). */
export function isAckOnly(text: string, wake?: string): boolean {
  const cs = clauses(text, wake);
  return cs.length > 0 && cs.every((c) => isAck(c, wake) || isSoftOnly(c, wake));
}

/** Is the whole utterance a conversation-closer? (Fillers alone don't close.) */
export function isClosing(text: string, wake?: string): boolean {
  const cs = clauses(text, wake);
  return cs.length > 0 && cs.every((c) => isCloser(c, wake) || FILLER.test(c)) && cs.some((c) => isCloser(c, wake));
}

/**
 * Looser than isClosing(): starts like a thank-you / goodbye and asks for
 * nothing ("cheers mate, thanks a bunch"). Only used to recognise that a
 * backend's sign-off reply should end the conversation.
 */
export function looksLikeGoodbye(text: string): boolean {
  const t = text.toLowerCase().trim();
  return /^(ok(ay)?[, ]+)?(thanks|thank you|cheers|ta|bye|goodbye|see you|that'?s (all|it)|much appreciated|appreciate it)\b/.test(t) && !/\b(open|search|what|how|when|why|who|where|tell|show|find|send|play|set|turn|can you|could you|please)\b/.test(t);
}

/** The user's own farewell, "Anytime.", varied sparingly (every fourth close). */
export function farewell(n: number): string {
  return n % 4 === 3 ? 'My pleasure.' : 'Anytime.';
}

/**
 * Round 10.5: a short farewell that fits what the user said — or none at all
 * (just the dissolve) after a plain acknowledgement like "cool".
 */
export function farewellFor(text: string, n: number, wake?: string): string {
  const t = clauses(text, wake).join(' ');
  if (/\b(good ?(night|nite)|night( night)?|nite|nighty night|sleep well)\b/.test(t)) return 'Goodnight.';
  if (/\b(bye|goodbye|see (you|ya)|later|talk (to you )?(later|soon)|take care|ttyl|catch you)\b/.test(t)) return ['Bye!', 'Talk soon.', 'See you.'][n % 3];
  if (/\b(thanks?|thank you|thx|cheers|ty|ta|appreciate|appreciated)\b/.test(t)) return farewell(n);
  if (isAckOnly(text, wake)) return n % 3 === 2 ? 'Anytime.' : '';
  return farewell(n);
}

/** Round 10.5: a reply that is ONLY a farewell ("Have a great evening!", "Goodnight!"). */
const FAREWELL_LEAD = /^(you'?re (very )?welcome|anytime|my pleasure|no problem|no worries|glad (i could|to) help|happy to help|have a (great|good|nice|lovely|wonderful) (day|one|evening|night|weekend)|enjoy (your|the) (day|evening|night|weekend|show|game|movie)|take care|bye( bye)?|goodbye|good ?(night|nite)|night night|sleep well|see (you|ya)( soon| later)?|talk (to you )?soon|cheers)\b/i;
/** Words that may follow a farewell lead without making it informational ("Bye for now, Sam!"). */
const FAREWELL_TAIL = new Set(['for', 'now', 'then', 'there', 'mate', 'friend', 'again', 'and', 'you', 'too', 'take', 'care', 'have', 'a', 'great', 'good', 'nice', 'lovely', 'wonderful', 'day', 'night', 'evening', 'weekend', 'one', 'sleep', 'well', 'soon', 'talk', 'to', 'see', 'ya', 'later', 'bye', 'goodbye', 'cheers', 'rest', 'of', 'the', 'your', 'enjoy', 'it', 'was', 'pleasure', 'my', 'anytime', 'welcome']);

export function isPureFarewell(reply: string): boolean {
  const t = reply.trim();
  if (!t || t.length > 90 || /\?/.test(t)) return false;
  return t.split(/(?<=[.!?])\s+/).every((sentence) => {
    const m = FAREWELL_LEAD.exec(sentence.trim());
    if (!m) return false;
    // Round 10.6: "Bye, the meeting moved to 3." is information, not a farewell.
    const rest = sentence.trim().slice(m[0].length).replace(/[.!,;:]/g, ' ').trim();
    const words = rest ? rest.split(/\s+/) : [];
    const names = words.filter((w) => /^[A-Z][a-z]+$/.test(w) && !FAREWELL_TAIL.has(w.toLowerCase()));
    return names.length <= 1 && words.every((w) => FAREWELL_TAIL.has(w.toLowerCase()) || names.includes(w));
  });
}

/** A backend reply that is itself a sign-off ("You're welcome, have a great day!"). */
export function isSignOff(reply: string): boolean {
  const t = reply.trim();
  if (!t || t.length > 140 || /\?\s*$/.test(t)) return false;
  return /^(you'?re (very )?welcome|anytime|my pleasure|no problem|no worries|glad (i could|to) help|happy to help|have a (great|good|nice|lovely) (day|one|evening|night|weekend)|take care|bye|goodbye|cheers)\b/i.test(t);
}

/** Split "are you there? what time is it and the date" into normalized clauses. */
export function clauses(text: string, wake?: string): string[] {
  return stripWake(text, wake)
    .toLowerCase()
    .split(/[?.!;]+|,\s*(?=(?:and |also )?(?:what|are|is|do|tell|thanks?|thank|no|nope)\b)|\band also\b|\b(?:and|also) (?=what|tell|the date|the time)/)
    .map((c) =>
      c
        .replace(/[,]+/g, ' ')
        .replace(/^(and|also|so|um|uh|oh|well|please)\s+/, '')
        .replace(/\s+(please|now|for me)$/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

export function answerLocally(text: string, ctx: SmalltalkCtx): LocalAnswer | null {
  const cs = clauses(text, ctx.wakeWord);
  if (!cs.length) return null;
  if (cs.every((c) => isCloser(c, ctx.wakeWord) || FILLER.test(c)) && cs.some((c) => isCloser(c, ctx.wakeWord))) return { kind: 'close', text: 'Anytime.' };
  // Round 10.5: "cool", "perfect", "sounds good" — the caller decides (only after a finished answer).
  if (isAckOnly(text, ctx.wakeWord)) return { kind: 'close', text: '' };
  const kinds = cs.map((c) => (PRESENCE.test(c) ? 'presence' : TIME.test(c) ? 'time' : DATE.test(c) ? 'date' : null));
  if (kinds.some((k) => k === null)) return null;
  // The user's own acceptance wording (Scenario A) wins over persona tweaks:
  // "Good morning, Alex. It's 10:21 AM. Anything I can help you with?" / "Anytime.".
  const parts: string[] = [];
  if (ctx.firstTurn) parts.push(`${greeting(ctx.now)}${ctx.name ? `, ${ctx.name}` : ''}.`);
  const facts: string[] = [];
  if (kinds.includes('time')) facts.push(`it's ${formatTime(ctx.now)}`);
  if (kinds.includes('date')) facts.push(`${kinds.includes('time') ? 'and today is' : 'today is'} ${formatDate(ctx.now)}`);
  if (facts.length) parts.push(`${cap(facts.join(' '))}${/\.$/.test(facts.join(' ')) ? '' : '.'}`);
  else parts.push(`I'm here.`);
  // Round 10: the user's Scenario A line only on the first (greeting / presence) turn.
  parts.push(ctx.firstTurn && (ctx.voice || !facts.length) ? 'Anything I can help you with?' : '');
  return { kind: 'answer', text: parts.filter(Boolean).join(' ') };
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * B3: what a spoken/typed utterance means while Cadabra is busy acting.
 * "stop" cancels the run; "yes"/"no" answer an open confirm card; anything
 * else is queued for after the current run.
 */
export function classifyBusyUtterance(text: string, wakeWord?: string): 'stop' | 'yes' | 'no' | 'other' {
  const t = stripWake(text, wakeWord)
    .toLowerCase()
    .replace(/[.!?,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(stop|cancel|wait|hold on|hang on|halt|abort|never ?mind|forget it|don'?t|stop it|stop that|quit|enough)( it| that| now| please)*$/.test(t)) return 'stop';
  if (/^(yes|yeah|yep|yup|sure|ok|okay|allow( it)?|go ahead|do it|confirm|approved?|please do|send it)( please| now)?$/.test(t)) return 'yes';
  if (/^(no|nope|nah|not now|deny|don'?t do it|cancel that|decline)( thanks?| thank you)?$/.test(t)) return 'no';
  return 'other';
}

/** A bare "no" is only a conversation-closer after an open question (V6). */
export function isBareNo(text: string): boolean {
  return /^(no|nope|nah)[.!]?$/i.test(text.trim());
}

/**
 * Did Cadabra's last reply end with an OPEN question — an invitation to ask
 * for more ("Anything I can help you with?", "What else can I do?", "Need
 * anything?")? A specific yes/no question ("Should I archive it?", "Did you
 * mean …?") is not open: "no" answers it rather than ending the conversation.
 */
export function endsWithOpenQuestion(reply: string): boolean {
  return /(anything else|something else|can i help|help you with|do for you|what else|need anything|anything i can)[^.!?]{0,20}\?\s*$/i.test(reply.trim());
}

/**
 * Round 10: replies no longer end with "Anything else?", so "got it" /
 * "understood" / "later" also close after a FINISHED answer (a statement), but
 * not after step-by-step instructions the user is following, nor after a
 * specific question.
 */
export function invitesClose(reply: string): boolean {
  const t = reply.trim();
  if (!t) return false;
  if (endsWithOpenQuestion(t)) return true;
  if (/\?\s*$/.test(t)) return false;
  return !/\b(first|then|next|step \d|after that|now (click|press|open|type|select)|go to|click|press|select|type)\b/i.test(t);
}

/** A generic closing question the model shouldn't add (filtered from speech). */
export function isGenericCloser(sentence: string): boolean {
  return /^(is there )?anything else( (i can|i could|you need|you'?d like)[^?]*)?\?$|^(let me know|just let me know) if (you need|there'?s) anything( else)?[.!]?$|^what else can i (do|help with)[^?]*\?$|^can i help (you )?with anything else\?$/i.test(sentence.trim());
}

/** Drop a trailing generic closer ("… Anything else?") from a reply before it is spoken. */
export function stripGenericCloser(reply: string): string {
  const parts = reply.trim().split(/(?<=[.!?])\s+/);
  while (parts.length > 1 && isGenericCloser(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

/** Round 10: "Did you mean tv.youtube.com?" — a bare "no" answers it (it doesn't end the conversation). */
export function asksToConfirm(reply: string): boolean {
  const last = reply.trim().split(/(?<=[.!?])\s+/).pop() ?? '';
  return /^(did you mean|do you want me to try)\b.*\?$/i.test(last);
}

/** REVIEW-10 #4: an offer ("Want me to open it?", "Should I read the rest?") that a bare "no" declines. */
export function offersSomething(reply: string): boolean {
  const last = reply.trim().split(/(?<=[.!?])\s+/).pop() ?? '';
  return /^(want me to|do you want me to|would you like me to|should i|shall i|can i)\b.*\?$/i.test(last) && !asksToConfirm(reply);
}
