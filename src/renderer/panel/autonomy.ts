// Round 11: the Autonomy choice (onboarding, Settings, tray) — one place for the copy.
export const AUTONOMY_OPTIONS: { id: 'risky' | 'every' | 'none'; label: string; blurb: string }[] = [
  {
    id: 'risky',
    label: 'Ask only for risky actions (recommended)',
    blurb: 'Clicks, typing, scrolling and opening apps or pages just happen. I still ask before anything that sends, posts, submits, deletes, buys, pays or transfers; before terminal commands; before typing codes or numbers I read on screen; in banking, trading and messaging apps; and after reading an email. Password managers and Windows security prompts are always off-limits.',
  },
  {
    id: 'every',
    label: 'Ask before every action',
    blurb: 'A card before each click, keystroke or app I open. Slower, but you see everything first.',
  },
  {
    id: 'none',
    label: 'Don’t ask',
    blurb: 'Full trust: I never ask first. That means I will run terminal commands, open programs, click Send, post, delete and buy things without checking with you. Web pages, documents and emails can contain hidden instructions meant to trick me (prompt injection), and in this mode I would not stop to ask you before acting on them. Password managers and Windows security prompts stay off-limits, and Esc always stops me.',
  },
];
