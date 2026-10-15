// First-run onboarding (REVIEW-1 #7): welcome + shortcut, your name, your AI
// backend (sign-in / key with a live test), voice opt-in with download
// progress, microphone permission, and a "Cadabra, hello" calibration.

import { bindingKeycaps } from '../../shared/binding';
import { looksLikeHandle, tidyName } from '../../shared/names';
import { sparkSvg } from '../shared/spark';
import { BACKEND_BLURB, renderAccount, type AccountApi } from './accounts';
import { renderNamePicker, renderPersonaCards } from './persona-ui';
import { displayName } from '../../shared/assistant';
import { AUTONOMY_OPTIONS } from './autonomy';

export interface OnboardApi extends AccountApi {
  getSettings(): Promise<any>;
  setSettings(patch: unknown): Promise<any>;
  micStatus(): Promise<string | null>;
  openMicSettings(): void;
  ttsStatus?(): Promise<any>;
  ttsDownload?(): Promise<{ ok: boolean; error?: string }>;
  previewVoice?(voice: string, speed: number): Promise<boolean>;
  setSecret?(key: string, value: string | null): Promise<boolean>;
}

const STEPS = ['welcome', 'name', 'backend', 'autonomy', 'voice', 'assistant', 'calibrate', 'done'] as const;
type Step = (typeof STEPS)[number];

const BACKENDS: { id: string; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'OpenAI (Codex)' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'demo', label: 'Demo (offline)' },
];

let active: { el: HTMLElement; voiceState(st: string): void; voiceProgress(pct: number): void } | null = null;

export function onboardingVoiceState(st: string) {
  active?.voiceState(st);
}
export function onboardingVoiceProgress(pct: number) {
  active?.voiceProgress(pct);
}
let ttsHook: ((pct: number) => void) | null = null;
export function onboardingTtsProgress(pct: number) {
  ttsHook?.(pct);
}

export function onboardingOpen(): boolean {
  return !!active;
}

export async function startOnboarding(host: HTMLElement, api: OnboardApi, opts: { step?: Step; onDone?: () => void } = {}) {
  active?.el.remove();
  const data = await api.getSettings();
  let s = data.settings;
  const el = document.createElement('section');
  el.className = 'settings onboard';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Set up Cadabra');
  host.appendChild(el);
  let step: Step = opts.step ?? 'welcome';
  let backend = s.provider ?? 'claude';
  let voicePct = -1;
  let heard = false;

  const save = async (patch: unknown) => {
    const next = await api.setSettings(patch);
    if (next) s = next;
  };

  const dots = () => `<div class="ob-dots" aria-hidden="true">${STEPS.map((x) => `<span class="${x === step ? 'on' : STEPS.indexOf(x) < STEPS.indexOf(step) ? 'past' : ''}"></span>`).join('')}</div>`;
  const caps = () => bindingKeycaps(s.summon).map((k: string) => `<kbd class="cap">${escapeHtml(k)}</kbd>`).join('<span class="plus">+</span>');

  function go(next: Step) {
    step = next;
    render();
  }

  function finish() {
    void save({ onboarded: true });
    active = null;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
    opts.onDone?.();
  }

  function render() {
    const nav = (back: Step | null, nextLabel: string, skip?: string) => `
      <div class="ob-nav">
        ${back ? `<button type="button" class="btn ghost ob-back">Back</button>` : '<span></span>'}
        <div class="ob-nav-r">${skip ? `<button type="button" class="btn ghost ob-skip">${skip}</button>` : ''}<button type="button" class="btn primary ob-next">${nextLabel}</button></div>
      </div>`;
    let body = '';
    switch (step) {
      case 'welcome':
        body = `
          <div class="ob-hero">${sparkSvg(54, 'obsg')}<div class="ob-halo"></div></div>
          <h2>Hi, I’m Cadabra.</h2>
          <p class="ob-lead">I see what’s on your screen and help with it. Ask a question, or tell me what to do. I’ll show you every step and ask before anything risky.</p>
          <div class="ob-try"><span>Summon me anywhere with</span><div class="keycaps">${caps()}</div><small>Press it again (or <kbd class="cap">Esc</kbd>) to close. You can change it in Settings.</small></div>
          ${nav(null, 'Let’s set up', 'Skip setup')}`;
        break;
      case 'name': {
        body = `
          <h2>What should I call you?</h2>
          <p class="ob-lead">Just a first name. I use it now and then, never more than that.</p>
          <input id="ob-name" class="ob-input" type="text" maxlength="40" placeholder="Your first name" autocomplete="given-name" />
          <p class="ob-hint" id="ob-name-hint" aria-live="polite"></p>
          <p class="ob-lead small">Your city, for weather (optional): only the city goes to the weather service, never your IP address.</p>
          <input id="ob-city" class="ob-input" type="text" maxlength="80" placeholder="e.g. Seattle, Washington" autocomplete="address-level2" />
          ${nav('welcome', 'Continue', 'Don’t use a name')}`;
        break;
      }
      case 'backend':
        body = `
          <h2>Pick your AI</h2>
          <p class="ob-lead">Cadabra works with the AI account you already have. You can switch any time. Web access is on: your AI can search the web (read-only) for news and sports, through the AI you pick here. Cadabra blocks codes and card numbers from your screen and asks before opening unfamiliar pages (Settings → Web access to turn it off).</p>
          <div class="ob-backends" role="radiogroup">${BACKENDS.map((b) => `<button type="button" role="radio" aria-checked="${b.id === backend}" class="ob-backend${b.id === backend ? ' on' : ''}" data-id="${b.id}"><b>${b.label}</b><small>${BACKEND_BLURB[b.id] ?? ''}</small></button>`).join('')}</div>
          <div id="ob-acct"></div>
          ${nav('name', 'Continue', 'Skip for now')}`;
        break;
      case 'autonomy': {
        const cur = s.safety?.autonomy ?? (s.safety?.confirmAllActions ? 'every' : 'risky');
        body = `
          <h2>How much should I ask first?</h2>
          <p class="ob-lead">When I act on your screen, I can check with you first. You can change this any time in Settings → Safety, and on any card you can say “Always allow this here”.</p>
          <div class="ob-backends" role="radiogroup">${AUTONOMY_OPTIONS.map((o) => `<button type="button" role="radio" aria-checked="${o.id === cur}" class="ob-backend ob-auto${o.id === cur ? ' on' : ''}" data-id="${o.id}"><b>${o.label}</b><small>${o.blurb}</small></button>`).join('')}</div>
          ${nav('backend', 'Continue')}`;
        break;
      }
      case 'voice': {
        const on = !!s.voice?.enabled;
        body = `
          <h2>Talk to me?</h2>
          <p class="ob-lead">Say my name and ask out loud (you’ll pick my name and voice next). Listening for the wake word happens entirely on this PC; nothing is sent anywhere until you say it. (If you pick a Southern cloud voice, the text of spoken replies is sent to OpenAI to make the audio.)</p>
          <div class="s-row"><div class="s-label">Voice<small>Downloads a ~100 MB speech-recognition model once.</small></div><button type="button" class="toggle ${on ? 'on' : ''}" role="switch" aria-checked="${on}" id="ob-voice"></button></div>
          <div class="ob-progress" id="ob-prog" ${on && voicePct >= 0 && voicePct < 100 ? '' : 'hidden'}><div class="bar"><span style="width:${Math.max(0, voicePct)}%"></span></div><small id="ob-prog-t">Downloading the speech model… ${Math.max(0, voicePct)}%</small></div>
          <div class="s-row"><div class="s-label">Natural voices<small>British and American voices for spoken replies. One-time ~350 MB download, includes espeak-ng pronunciation data (GPL-3.0); runs on this PC.</small></div><button type="button" class="toggle" role="switch" aria-checked="false" id="ob-tts"></button></div>
          <div class="ob-progress" id="ob-tts-prog" hidden><div class="bar"><span></span></div><small></small></div>
          <div class="ob-mic" id="ob-mic"></div>
          ${nav('autonomy', on ? 'Continue' : 'Not now')}`;
        break;
      }
      case 'assistant':
        body = `
          <h2>Choose your assistant</h2>
          <p class="ob-lead">A name you like saying (it’s also the wake word) and a voice. Mix and match any time in Settings.</p>
          <div class="s-row"><div class="s-label">Name<small>Also the wake word. 2–4 syllables, not a word you say all day.</small><div id="ob-namepick"></div></div></div>
          <h4 class="ob-sub">Voice</h4>
          <div id="ob-personas"></div>
          ${nav('voice', 'Continue')}`;
        break;
      case 'calibrate':
        body = `
          <div class="ob-hero mic ${heard ? 'heard' : 'listening'}"><div class="ob-ring"></div><div class="ob-ring r2"></div>${sparkSvg(40, 'obsg2')}</div>
          <h2>${heard ? 'I heard you!' : `Say “${escapeHtml(displayName(s.voice?.wakeWord))}, hello”`}</h2>
          <p class="ob-lead">${heard ? 'Wake word works. Speak normally; I’ll answer out loud when you talk to me.' : 'Speak at your normal volume from where you usually sit. If I don’t react, try Settings → wake-word sensitivity.'}</p>
          ${nav('assistant', heard ? 'Continue' : 'Skip', undefined)}`;
        break;
      case 'done':
        body = `
          <div class="ob-hero">${sparkSvg(54, 'obsg3')}<div class="ob-halo"></div></div>
          <h2>You’re all set${s.displayName ? `, ${escapeHtml(s.displayName)}` : ''}.</h2>
          <p class="ob-lead">Press <span class="keycaps inline">${caps()}</span> anywhere${s.voice?.enabled ? ` or say “${escapeHtml(displayName(s.voice?.wakeWord))}”` : ''}. Try: “What’s on my screen?”</p>
          <p class="ob-lead small">Want to chat with me from your phone? Settings → WhatsApp (optional; uses your own WhatsApp agent key).</p>
          ${nav('backend', 'Start using Cadabra')}`;
        break;
    }
    // N13: the footer lives OUTSIDE the scrolling body, so content never slides under it.
    const cut = body.indexOf('<div class="ob-nav">');
    const main = cut >= 0 ? body.slice(0, cut) : body;
    const foot = cut >= 0 ? body.slice(cut) : '';
    el.innerHTML = `<div class="s-head">${sparkSvg(16, 'obh')}<span>Set up Cadabra</span>${dots()}</div><div class="ob-body ob-step-${step}">${main}</div>${foot}`;
    wire();
  }

  function wire() {
    const back = el.querySelector<HTMLButtonElement>('.ob-back');
    const next = el.querySelector<HTMLButtonElement>('.ob-next')!;
    const skip = el.querySelector<HTMLButtonElement>('.ob-skip');
    const idx = STEPS.indexOf(step);
    if (back) back.onclick = () => go(STEPS[Math.max(0, idx - 1)]);
    switch (step) {
      case 'welcome':
        next.onclick = () => go('name');
        skip!.onclick = finish;
        break;
      case 'name': {
        const input = el.querySelector<HTMLInputElement>('#ob-name')!;
        const hint = el.querySelector<HTMLElement>('#ob-name-hint')!;
        input.value = s.displayName ?? '';
        // REVIEW-2 N7: a soft warning only; any script is fine and the user decides.
        const check = () => {
          const v = input.value.trim();
          const bad = !!v && looksLikeHandle(v);
          hint.textContent = bad ? `“${v}” looks like a username. What do friends call you? (Or keep it.)` : '';
          hint.classList.toggle('warn', bad);
          input.classList.toggle('warn', bad);
          next.disabled = !v;
          next.textContent = bad ? 'Use it anyway' : 'Continue';
          return !!v;
        };
        check();
        input.oninput = check;
        input.onkeydown = (e) => {
          if (e.key === 'Enter' && check()) next.click();
        };
        const city = el.querySelector<HTMLInputElement>('#ob-city')!;
        city.value = s.location ?? '';
        next.onclick = async () => {
          if (!check()) return;
          await save({ displayName: tidyName(input.value), location: city.value.trim() });
          go('backend');
        };
        skip!.onclick = async () => {
          await save({ displayName: '' });
          go('backend');
        };
        setTimeout(() => {
          input.focus();
          input.select();
        }, 50);
        break;
      }
      case 'backend': {
        const acct = el.querySelector<HTMLElement>('#ob-acct')!;
        const show = () => {
          next.disabled = backend !== 'demo';
          if (backend === 'demo') {
            acct.innerHTML = '<p class="s-note">No account needed. Answers are canned; nothing leaves your PC.</p>';
            return;
          }
          void renderAccount(acct, api, backend, () => (next.disabled = false)).then(() => {
            if (acct.querySelector('.chip.ok')) next.disabled = false;
          });
        };
        el.querySelectorAll<HTMLButtonElement>('.ob-backend').forEach((b) => {
          b.onclick = () => {
            backend = b.dataset.id!;
            el.querySelectorAll('.ob-backend').forEach((x) => {
              x.classList.toggle('on', x === b);
              x.setAttribute('aria-checked', String(x === b));
            });
            show();
            // Bring the choices for this backend into view.
            setTimeout(() => acct.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120);
          };
        });
        show();
        next.onclick = async () => {
          await save({ provider: backend });
          go('autonomy');
        };
        skip!.onclick = () => go('autonomy');
        break;
      }
      case 'voice': {
        const t = el.querySelector<HTMLButtonElement>('#ob-voice')!;
        t.onclick = async () => {
          const on = !t.classList.contains('on');
          await save({ voice: { ...s.voice, enabled: on } });
          if (on && voicePct < 0) voicePct = 0;
          render();
        };
        void checkMic();
        const tt = el.querySelector<HTMLButtonElement>('#ob-tts')!;
        const tp = el.querySelector<HTMLElement>('#ob-tts-prog')!;
        void api.ttsStatus?.().then((st) => {
          if (st?.installed) {
            tt.classList.add('on');
            tt.setAttribute('aria-checked', 'true');
          }
        });
        ttsHook = (pct) => {
          tp.hidden = pct >= 100;
          tp.querySelector<HTMLElement>('.bar span')!.style.width = `${pct}%`;
          tp.querySelector('small')!.textContent = pct >= 100 ? 'Natural voice ready.' : `Downloading the natural voice… ${pct}%`;
        };
        tt.onclick = async () => {
          if (tt.classList.contains('on')) return;
          tt.classList.add('on');
          tt.setAttribute('aria-checked', 'true');
          tp.hidden = false;
          const r = await api.ttsDownload?.();
          if (r && !r.ok) tp.querySelector('small')!.textContent = `Download failed: ${r.error}`;
        };
        next.onclick = () => go('assistant');
        break;
      }
      case 'autonomy': {
        el.querySelectorAll<HTMLButtonElement>('.ob-auto').forEach((b) => {
          b.onclick = async () => {
            const id = b.dataset.id!;
            const updated = await api.setSettings({ safety: { autonomy: id, confirmAllActions: id === 'every' } });
            if (updated) s = updated;
            el.querySelectorAll<HTMLButtonElement>('.ob-auto').forEach((x) => {
              x.classList.toggle('on', x === b);
              x.setAttribute('aria-checked', String(x === b));
            });
          };
        });
        next.onclick = () => go('voice');
        break;
      }
      case 'assistant': {
        const cards = el.querySelector<HTMLElement>('#ob-personas')!;
        const namePick = el.querySelector<HTMLElement>('#ob-namepick')!;
        const redrawName = () => renderNamePicker(namePick, s, api, (n) => (s = n));
        void renderPersonaCards(cards, s, api, (n) => {
          s = n;
          redrawName();
        });
        redrawName();
        next.onclick = () => go(s.voice?.enabled ? 'calibrate' : 'done');
        break;
      }
      case 'calibrate':
        next.onclick = () => go('done');
        break;
      case 'done':
        next.onclick = finish;
        break;
    }
  }

  async function checkMic() {
    const box = el.querySelector<HTMLElement>('#ob-mic');
    if (!box || !s.voice?.enabled) return;
    const st = await api.micStatus();
    if (step !== 'voice') return;
    if (st === 'denied' || st === 'restricted') {
      box.innerHTML = `<p class="ob-hint warn">Windows is blocking microphone access for desktop apps.</p><button type="button" class="btn ghost" id="ob-mic-open">Open microphone settings</button>`;
      box.querySelector<HTMLButtonElement>('#ob-mic-open')!.onclick = () => api.openMicSettings();
    } else box.innerHTML = `<p class="ob-hint ok">Microphone access is allowed.</p>`;
  }

  active = {
    el,
    voiceState(st) {
      if (step === 'calibrate' && !heard && (st === 'listening' || st === 'transcribing')) {
        heard = true;
        render();
      }
    },
    voiceProgress(pct) {
      voicePct = pct;
      if (step !== 'voice') return;
      const prog = el.querySelector<HTMLElement>('#ob-prog');
      if (!prog) return;
      prog.hidden = pct >= 100;
      prog.querySelector<HTMLElement>('.bar span')!.style.width = `${pct}%`;
      prog.querySelector<HTMLElement>('#ob-prog-t')!.textContent = pct >= 100 ? 'Speech model ready.' : `Downloading the speech model… ${pct}%`;
    },
  };
  render();
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
