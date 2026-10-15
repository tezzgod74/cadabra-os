// The promo video timeline (`npm run demo:video`). Plays the storyboard on the
// staged demo desktop in real time, with captions, keycaps, a generic phone mock
// and an outro card on top. Synthetic data only. Returns audio cue times.

import { sparkSvg } from '../shared/spark';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PromoDeps {
  toPanel(m: any): void;
  toOverlay(m: any): void;
  summon(): void;
  reset(): Promise<void>;
  rectOf(id: string, grow?: number): Rect;
  centerOf(id: string): { x: number; y: number };
  panel: Rect;
  panelFrame: HTMLIFrameElement;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What Cadabra says (rendered offline with the natural British voice by scripts/record-demo.ts). */
export const PROMO_LINES = {
  answer: 'That error means the workspace is over its storage quota. Saving the deck as a PDF will fix it.',
  done: 'Done. The deck is saved as a PDF.',
  notnow: 'Okay, I won’t send it.',
  announce: 'Dinner’s ready!',
};

const ANSWER_TEXT = `**\`E_QUOTA_EXCEEDED\`** means the workspace is **over its storage quota**: the upload would go past the plan's limit.

**Fix:** save the deck as a PDF (about 70% smaller), or free some space in *Settings → Storage*.`;

export function installPromo(d: PromoDeps): void {
  const durs: Record<string, number> = JSON.parse(new URLSearchParams(location.search).get('durs') || '{}');
  const dur = (k: string, fallback: number) => durs[k] ?? fallback;
  document.documentElement.classList.add('promo');
  const desktop = document.getElementById('desktop')!;

  // ---- layers ---------------------------------------------------------------
  const band = document.createElement('div');
  band.id = 'promo-band';
  band.innerHTML = `<div class="pb-cap"></div><div class="pb-sub"></div>`;
  document.body.append(band);
  const keys = document.createElement('div');
  keys.id = 'promo-keys';
  keys.innerHTML = `<kbd>Ctrl</kbd><span>+</span><kbd>~</kbd>`;
  desktop.append(keys);
  const phone = document.createElement('div');
  phone.id = 'promo-phone';
  phone.innerHTML = `<div class="ph-notch"></div><div class="ph-head">${sparkSvg(18, 'phs')}<div><b>Cadabra</b><small>your PC · from your phone</small></div></div><div class="ph-chat"></div><div class="ph-input"><span class="ph-typed"></span><i></i></div>`;
  desktop.append(phone);
  const toast = document.createElement('div');
  toast.id = 'promo-toast';
  desktop.append(toast);
  const outro = document.createElement('div');
  outro.id = 'promo-outro';
  outro.innerHTML = `<div class="po-mark">${sparkSvg(96, 'pos')}</div><h1>Cadabra OS</h1><p class="po-tag">Your AI sees your screen — and acts, safely.</p><p class="po-meta">public beta · open source (MIT) · Windows</p><p class="po-url">github.com/tezzgod74/cadabra-os</p>`;
  document.body.append(outro);

  const cap = band.querySelector<HTMLElement>('.pb-cap')!;
  const sub = band.querySelector<HTMLElement>('.pb-sub')!;
  const caption = (t: string) => {
    cap.classList.remove('in');
    void cap.offsetWidth;
    cap.textContent = t;
    cap.classList.add('in');
  };
  const subtitle = (t: string) => {
    sub.textContent = t ? `🔊 “${t}”` : '';
    sub.classList.toggle('in', !!t);
  };

  let t0 = 0;
  const cues: { id: string; t: number }[] = [];
  const cue = (id: string) => cues.push({ id, t: performance.now() - t0 });
  const say = async (id: keyof typeof PROMO_LINES, fallback: number) => {
    cue(id);
    subtitle(PROMO_LINES[id]);
    await sleep(dur(id, fallback) + 250);
    subtitle('');
  };
  const typeInto = async (text: string, cps = 22) => {
    for (let i = 1; i <= text.length; i++) {
      d.toPanel({ type: '__type', text: text.slice(0, i) });
      await sleep(1000 / cps);
    }
  };
  const stream = async (text: string, msPerWord = 40) => {
    for (const w of text.split(/(\s+)/)) {
      if (!w) continue;
      d.toPanel({ type: 'event', event: { type: 'text', delta: w } });
      if (w.trim()) await sleep(msPerWord);
    }
  };

  (window as any).promo = {
    async prepare() {
      await d.reset();
      d.panelFrame.classList.remove('show');
    },
    async run() {
      t0 = performance.now();
      // ---- 1. Press Ctrl+~ --------------------------------------------------
      caption('Press Ctrl + ~ anywhere');
      await sleep(700);
      keys.classList.add('in');
      await sleep(700);
      keys.classList.add('press');
      await sleep(250);
      d.summon();
      await sleep(450);
      keys.classList.remove('in', 'press');
      await sleep(1700);

      // ---- 2. Ask about the error -------------------------------------------
      caption('Ask about anything on your screen');
      await typeInto('What does this error mean?');
      await sleep(300);
      d.toPanel({ type: '__type', text: '' });
      d.toPanel({ type: 'user-echo', text: 'What does this error mean?', via: 'typed' });
      d.toPanel({ type: 'busy', busy: true });
      d.toPanel({ type: 'event', event: { type: 'tool', id: 'a', name: 'see_screen', phase: 'start' } });
      await sleep(700);
      d.toPanel({ type: 'event', event: { type: 'tool', id: 'a', name: '', phase: 'end', ok: true } });
      d.toPanel({ type: 'event', event: { type: 'tool', id: 'b', name: 'highlight', phase: 'start' } });
      d.toOverlay({ type: 'highlight', rings: [{ rect: d.rectOf('err-code', 3), label: 'E_QUOTA_EXCEEDED' }], reducedMotion: false, durationMs: 6500 });
      d.toPanel({ type: 'event', event: { type: 'tool', id: 'b', name: '', phase: 'end', ok: true } });
      const speaking = say('answer', 5200);
      await stream(ANSWER_TEXT, 55);
      d.toPanel({ type: 'event', event: { type: 'done' } });
      d.toPanel({ type: 'busy', busy: false });
      await speaking;
      await sleep(300);

      // ---- 3. Say its name: it acts ------------------------------------------
      caption('Or just say its name');
      d.toPanel({ type: 'voice', state: 'listening', level: 0.3 });
      for (let i = 0; i < 22; i++) {
        d.toPanel({ type: 'voice', state: 'listening', level: 0.25 + 0.6 * Math.abs(Math.sin(i * 0.9)) });
        await sleep(70);
      }
      d.toPanel({ type: 'voice', state: 'transcribing' });
      await sleep(350);
      d.toPanel({ type: 'voice', state: 'off' });
      d.toPanel({ type: 'user-echo', text: 'Cadabra, export the deck as PDF', via: 'voice' });
      d.toPanel({ type: 'busy', busy: true });
      await sleep(500);
      caption('It acts — you watch');
      d.toPanel({ type: '__acting', on: true, caption: 'Opening Export…' });
      d.panelFrame.style.height = '64px';
      const avoid = { ...d.panel, height: 64 };
      const exp = d.centerOf('btn-export');
      d.toOverlay({ type: 'ghost-move', from: { x: d.panel.x - 12, y: d.panel.y + 40 }, to: exp, durationMs: 900, reducedMotion: false, avoid });
      await sleep(1050);
      d.toOverlay({ type: 'ghost-click', at: exp });
      await sleep(250);
      document.getElementById('export-menu')!.classList.add('open');
      await sleep(450);
      d.toPanel({ type: '__acting', on: true, caption: 'Choosing PDF…' });
      const pdf = d.centerOf('menu-pdf');
      d.toOverlay({ type: 'ghost-move', from: exp, to: pdf, durationMs: 650, reducedMotion: false, avoid });
      await sleep(800);
      document.getElementById('menu-pdf')!.classList.add('hover');
      d.toOverlay({ type: 'ghost-click', at: pdf });
      await sleep(300);
      document.getElementById('export-menu')!.classList.remove('open');
      toast.innerHTML = '<b>Saved</b> Q3-launch.pdf · 1.3 MB';
      toast.classList.add('in');
      d.toPanel({ type: '__acting', on: false });
      d.panelFrame.style.height = `${d.panel.height}px`;
      d.toPanel({ type: 'event', event: { type: 'tool', id: 'c', name: 'click', phase: 'start' } });
      d.toPanel({ type: 'event', event: { type: 'tool', id: 'c', name: '', phase: 'end', ok: true } });
      void stream('Done — **Q3-launch.pdf** is saved next to the deck.', 50);
      await say('done', 2200);
      d.toPanel({ type: 'event', event: { type: 'done' } });
      d.toPanel({ type: 'busy', busy: false });
      d.toOverlay({ type: 'ghost-hide' });
      toast.classList.remove('in');

      // ---- 4. Risky actions ask ---------------------------------------------
      caption('Risky actions always ask first');
      await typeInto('Reply to Dana that it’s done and send it', 30);
      await sleep(200);
      d.toPanel({ type: '__type', text: '' });
      d.toPanel({ type: 'user-echo', text: 'Reply to Dana that it’s done and send it', via: 'typed' });
      d.toPanel({ type: 'busy', busy: true });
      d.toPanel({ type: 'event', event: { type: 'tool', id: 'd', name: 'type_text', phase: 'start' } });
      d.toPanel({ type: 'event', event: { type: 'tool', id: 'd', name: '', phase: 'end', ok: true } });
      await stream('I’ve written the reply. Sending it needs your OK:', 40);
      d.toPanel({ type: 'confirm', id: 'promo-c1', title: 'Send this message in Outlook?', detail: 'Message: “Hi Dana — the PDF is attached and the quota banner is fixed. See you at 2!”', mono: 'ctrl+enter', risk: 'This will send the message · keys ctrl+enter · in Inbox — Mail', subtitle: 'To: Dana Whitfield', kind: 'action', timeoutMs: 90_000 });
      await sleep(2600);
      d.toPanel({ type: '__click', selector: '.confirm [data-deny]' });
      d.toPanel({ type: 'confirm-resolved', id: 'promo-c1', allowed: false });
      await sleep(300);
      await say('notnow', 1300);
      d.toPanel({ type: 'event', event: { type: 'done' } });
      d.toPanel({ type: 'busy', busy: false });
      await sleep(400);

      // ---- 5. From your phone: an announcement ------------------------------
      caption('Text it from your phone');
      document.querySelector('.icons')?.classList.add('promo-hide');
      phone.classList.add('in');
      await sleep(700);
      const typed = phone.querySelector<HTMLElement>('.ph-typed')!;
      const msg = 'Announcement: Dinner’s ready 🍝';
      for (let i = 1; i <= [...msg].length; i++) {
        typed.textContent = [...msg].slice(0, i).join('');
        await sleep(45);
      }
      await sleep(250);
      typed.textContent = '';
      const chat = phone.querySelector<HTMLElement>('.ph-chat')!;
      const bubble = (cls: string, html: string) => {
        const b = document.createElement('div');
        b.className = `ph-msg ${cls}`;
        b.innerHTML = html;
        chat.append(b);
        return b;
      };
      bubble('out', 'Announcement: Dinner’s ready 🍝<small>6:58 PM ✓✓</small>');
      await sleep(500);
      toast.innerHTML = '<b>📢 Announcing</b> “Dinner’s ready 🍝”';
      toast.classList.add('in', 'ann');
      cue('chime');
      await sleep(dur('chime', 800) + 100);
      await say('announce', 1100);
      bubble('in', '📢 Announced on your PC.<small>6:58 PM</small>');
      toast.classList.remove('in');
      await sleep(1700);

      // ---- 6. Outro ----------------------------------------------------------
      caption('');
      outro.classList.add('in');
      await sleep(4200);
      return cues;
    },
  };
}
