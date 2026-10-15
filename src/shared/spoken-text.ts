// Text → what a British-English voice should actually say (round 3, natural
// voice). Applied after toSpeech() (which already drops Markdown, URLs, code):
//   "10:21 a.m." → "ten twenty-one a.m."   "8.8.8.8" → "eight dot eight dot eight dot eight"
//   "dns.google" → "D N S dot google"       "192.168.40.1" → "one nine two dot one six eight dot forty dot one"

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0–99 in words ("twenty-one"). */
export function smallNumber(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  return n % 10 ? `${t}-${ONES[n % 10]}` : t;
}

/** "10:21" → "ten twenty-one", "10:05" → "ten oh five", "10:00" → "ten". */
export function spokenClock(h: number, m: number, twelveHour = true): string {
  const hh = twelveHour ? (h % 12 === 0 ? 'twelve' : smallNumber(h % 12)) : smallNumber(h);
  if (m === 0) return hh;
  return m < 10 ? `${hh} oh ${ONES[m]}` : `${hh} ${smallNumber(m)}`;
}

const digits = (s: string) => s.split('').map((d) => ONES[+d]).join(' ');
const octet = (s: string) => (s.length <= 2 ? smallNumber(+s) : digits(s));

/** Letters-only tokens with no vowel read as letters ("dns" → "D N S"). */
function spellIfAcronym(w: string): string {
  return /^[a-z]{2,5}$/i.test(w) && !/[aeiouy]/i.test(w) ? w.toUpperCase().split('').join(' ') : w;
}

/** British (default) or American wording where it differs ("per cent" / "percent"). */
export function toSpokenText(text: string, dialect: 'british' | 'american' = 'british'): string {
  let t = text;
  // Times: "10:21 AM", "10:21 a.m.", "10:21am", "22:05".
  t = t.replace(/\b(\d{1,2}):(\d{2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)?(?=[\s.,!?;:)]|$)/gi, (_m, h, mm, ap) => {
    const hh = +h;
    const said = spokenClock(hh, +mm, !!ap || hh <= 12);
    if (ap) return `${said} ${/^a/i.test(ap) ? 'a.m.' : 'p.m.'}`;
    return said;
  });
  // IPv4 addresses.
  t = t.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (_m, a, b, c, d) => [a, b, c, d].map(octet).join(' dot '));
  // Host names: "dns.google", "example.co.uk" (not the end of a sentence: needs a letter after the dot).
  t = t.replace(/\b([a-z0-9-]{2,}(?:\.[a-z][a-z0-9-]+)+)\b/gi, (m) => (/^\d+(\.\d+)*$/.test(m) ? m : m.split('.').map(spellIfAcronym).join(' dot ')));
  // A few symbols voices stumble over.
  t = t.replace(/\s&\s/g, ' and ').replace(/(\d)\s?%/g, dialect === 'american' ? '$1 percent' : '$1 per cent');
  return t.replace(/\s+/g, ' ').trim();
}

/** Split into sentences for streaming synthesis (first sentence plays while the rest is made). */
export function speechSentences(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/(?<=[.!?])\s+(?=[A-Z0-9“"'])/)) {
    const p = part.trim();
    if (!p) continue;
    // Very short fragments ride along with the previous sentence.
    // Round 5 cadence: no tiny fragments ("Sure." rides with what follows / precedes).
    if (out.length && (p.length < 20 || out[out.length - 1].length < 12)) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}
