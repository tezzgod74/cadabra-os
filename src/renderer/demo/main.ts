// Visual preview stage: a fake desktop with the REAL panel and overlay
// renderers in iframes, driven through every state. Used by `npm run demo`
// (interactive buttons) and `npm run screenshots` (frozen captures).

import { placePanel } from '../../shared/coords';
import { classifyAction, DEFAULT_SAFETY, describeAction } from '../../shared/safety';
import type { ProviderInfo, Rect } from '../../shared/types';
import { installPromo } from './promo';

const STAGE = { width: 1280, height: 800 };
const WORK = { x: 0, y: 0, width: 1280, height: 752 };
const CLICK = { x: 560, y: 150 };
const PANEL = placePanel(CLICK, { width: 420, height: 540 }, WORK);
const MAIL = { x: 40, y: 40, width: 760, height: 620 };

const capture = new URLSearchParams(location.search).has('capture');
const bare = new URLSearchParams(location.search).has('bare');
if (bare) {
  // Backdrop for the live self-test: just the mock desktop.
  document.getElementById('panel')!.remove();
  document.getElementById('overlay')!.remove();
}
if (capture) document.documentElement.classList.add('capture');

const panelFrame = document.getElementById('panel') as HTMLIFrameElement;
const overlayFrame = document.getElementById('overlay') as HTMLIFrameElement;
Object.assign(panelFrame.style, { left: `${PANEL.x}px`, top: `${PANEL.y}px`, width: `${PANEL.width}px`, height: `${PANEL.height}px` });

let provider: ProviderInfo | null = null;
const PROVIDER: ProviderInfo = {
  id: 'claude',
  label: 'Claude',
  auth: { ok: true, detail: 'API key saved' },
  models: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }],
};

const readyResolvers: Record<string, () => void> = {};
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d?.cadabraDemoOut) return;
  if (d.kind === 'ready') readyResolvers.panel?.();
  if (d.kind === 'overlay-ready') readyResolvers.overlay?.();
});

function loadFrame(frame: HTMLIFrameElement, page: string, key: string): Promise<void> {
  return new Promise((resolve) => {
    readyResolvers[key] = resolve;
    frame.src = `../${page}/index.html?demo=1&t=${Date.now()}`;
  });
}

const toPanel = (msg: any) => panelFrame.contentWindow!.postMessage({ cadabraDemo: true, msg }, '*');
const toOverlay = (msg: any) => overlayFrame.contentWindow!.postMessage({ cadabraDemo: true, msg }, '*');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rectOf(id: string, grow = 0): Rect {
  const r = document.getElementById(id)!.getBoundingClientRect();
  // Relative to the desktop (the overlay's coordinate space), which the promo layout offsets.
  const o = document.getElementById('desktop')!.getBoundingClientRect();
  return { x: r.x - o.x - grow, y: r.y - o.y - grow, width: r.width + grow * 2, height: r.height + grow * 2 };
}
function centerOf(id: string) {
  const r = rectOf(id);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Freeze every animation (stage CSS, panel CSS, overlay clock) `after` ms from now. */
function freezeAll(after: number) {
  toOverlay({ type: '__freeze', after });
  toPanel({ type: '__freeze', after });
  setTimeout(() => {
    for (const a of document.getAnimations()) a.pause();
  }, after);
}

const ANSWER = `That banner means **the workspace hit its storage quota** — \`E_QUOTA_EXCEEDED\` is thrown when an upload would go over the plan's limit.

To fix it:
1. Open **Export** (top right of the message) and save the deck as PDF — it's ~70% smaller.
2. Or free space in *Settings → Storage*.

Want me to export it for you?`;

function summon(reduced = false) {
  // Like the app: the overlay grows the glass from the click and the panel
  // appears as it lands (SUMMON_GLASS_MS).
  const showPanel = () => {
    panelFrame.classList.remove('hide');
    panelFrame.classList.add('show');
  };
  if (reduced) showPanel();
  else setTimeout(showPanel, 360);
  toOverlay({ type: 'summon', at: CLICK, panel: PANEL, reducedMotion: reduced });
  toPanel({
    type: 'summon',
    origin: { x: CLICK.x - PANEL.x, y: CLICK.y - PANEL.y },
    target: { title: 'Inbox — Mail', process: 'olk.exe' },
    provider: provider ?? PROVIDER,
    model: provider ? '' : 'claude-sonnet-5-5',
    reducedMotion: reduced,
    fresh: true,
  });
  setTimeout(() => toOverlay({ type: 'scan', rect: MAIL, reducedMotion: reduced, avoid: PANEL }), reduced ? 0 : 90);
}

function streamText(text: string) {
  for (const w of text.split(/(\s+)/)) if (w) toPanel({ type: 'event', event: { type: 'text', delta: w } });
}

async function reset() {
  for (const a of document.getAnimations()) a.cancel();
  panelFrame.style.height = `${PANEL.height}px`;
  panelFrame.classList.remove('show', 'hide');
  await Promise.all([loadFrame(panelFrame, 'panel', 'panel'), loadFrame(overlayFrame, 'overlay', 'overlay')]);
  await sleep(60);
}

async function show(state: string, opts: { reducedMotion?: boolean } = {}) {
  await reset();
  const reduced = !!opts.reducedMotion;
  switch (state) {
    case 'summon-ripple':
      summon();
      freezeAll(100);
      await sleep(260);
      break;
    case 'window-scan':
      summon();
      freezeAll(640);
      await sleep(760);
      break;
    case 'panel-idle':
      summon(reduced);
      await sleep(2600);
      break;
    case 'panel-thinking':
      summon();
      await sleep(2300);
      toPanel({ type: 'user-echo', text: 'What does the error on slide 4 mean?', via: 'typed' });
      toPanel({ type: 'event', event: { type: 'tool', id: 'a', name: 'see_screen', phase: 'start' } });
      toPanel({ type: 'event', event: { type: 'status', text: 'Looking…' } });
      await sleep(900);
      break;
    case 'panel-streaming':
      summon();
      await sleep(2300);
      toPanel({ type: 'user-echo', text: 'What does the error on slide 4 mean?', via: 'typed' });
      toPanel({ type: 'event', event: { type: 'tool', id: 'a', name: 'see_screen', phase: 'start' } });
      toPanel({ type: 'event', event: { type: 'tool', id: 'a', name: '', phase: 'end', ok: true } });
      toPanel({ type: 'event', event: { type: 'tool', id: 'b', name: 'read_ui', phase: 'start' } });
      toPanel({ type: 'event', event: { type: 'tool', id: 'b', name: '', phase: 'end', ok: true } });
      streamText(ANSWER.slice(0, 150));
      await sleep(420);
      freezeAll(0);
      await sleep(60);
      break;
    case 'panel-answer':
      summon(reduced);
      await sleep(reduced ? 300 : 2300);
      toPanel({ type: 'user-echo', text: 'What does the error on slide 4 mean?', via: 'typed' });
      toPanel({ type: 'event', event: { type: 'tool', id: 'a', name: 'see_screen', phase: 'start' } });
      toPanel({ type: 'event', event: { type: 'tool', id: 'a', name: '', phase: 'end', ok: true } });
      streamText(ANSWER);
      toPanel({ type: 'event', event: { type: 'done' } });
      toPanel({ type: 'busy', busy: false });
      await sleep(1800);
      break;
    case 'highlight-rings':
      summon();
      await sleep(2300);
      toPanel({ type: 'user-echo', text: 'Where do I export this?', via: 'typed' });
      toPanel({ type: 'event', event: { type: 'tool', id: 'a', name: 'read_ui', phase: 'start' } });
      toPanel({ type: 'event', event: { type: 'tool', id: 'a', name: '', phase: 'end', ok: true } });
      toPanel({ type: 'event', event: { type: 'tool', id: 'b', name: 'highlight', phase: 'start' } });
      toPanel({ type: 'event', event: { type: 'tool', id: 'b', name: '', phase: 'end', ok: true } });
      streamText('Right here — **Export** is in the message toolbar. The attachment it will convert is highlighted too.');
      toPanel({ type: 'event', event: { type: 'done' } });
      toPanel({ type: 'busy', busy: false });
      toOverlay({
        type: 'highlight',
        rings: [
          { rect: rectOf('btn-export', 2), label: 'Export' },
          { rect: rectOf('attach', 2), label: 'Q3-launch.pptx' },
        ],
        reducedMotion: false,
        durationMs: 9000,
      });
      freezeAll(1500);
      await sleep(1650);
      break;
    case 'ghost-moving':
    case 'ghost-click': {
      summon();
      await sleep(2300);
      toPanel({ type: 'user-echo', text: 'Yes — export it as PDF', via: 'typed' });
      toPanel({ type: 'event', event: { type: 'tool', id: 'a', name: 'read_ui', phase: 'start' } });
      toPanel({ type: 'event', event: { type: 'tool', id: 'a', name: '', phase: 'end', ok: true } });
      toPanel({ type: 'event', event: { type: 'tool', id: 'b', name: 'click', phase: 'start' } });
      toPanel({ type: 'event', event: { type: 'status', text: 'On it' } });
      const to = centerOf('btn-export');
      toOverlay({ type: 'ghost-move', from: { x: PANEL.x - 12, y: PANEL.y + 70 }, to, caption: 'Opening Export…', durationMs: 820, reducedMotion: false, avoid: PANEL });
      if (state === 'ghost-moving') {
        freezeAll(470);
        await sleep(600);
      } else {
        await sleep(900);
        toOverlay({ type: 'ghost-click', at: to });
        freezeAll(130);
        await sleep(260);
      }
      break;
    }
    case 'confirm':
      summon();
      await sleep(2300);
      toPanel({ type: 'user-echo', text: 'Reply to Dana that it’s done and send it', via: 'typed' });
      toPanel({ type: 'event', event: { type: 'tool', id: 'a', name: 'click', phase: 'start' } });
      toPanel({ type: 'event', event: { type: 'tool', id: 'a', name: '', phase: 'end', ok: true } });
      toPanel({ type: 'event', event: { type: 'tool', id: 'b', name: 'type_text', phase: 'start' } });
      toPanel({ type: 'event', event: { type: 'tool', id: 'b', name: '', phase: 'end', ok: true } });
      streamText('I’ve written the reply. One last step needs your OK:');
      toPanel({ type: 'event', event: { type: 'tool', id: 'c', name: 'press_keys', phase: 'start' } });
      // Exactly what the safety gate renders for this action (describeAction).
      {
        const req = { kind: 'press_keys' as const, keys: 'ctrl+enter', process: 'olk.exe', title: 'Inbox — Mail', composeText: 'Hi Dana — the PDF is attached and the quota banner is fixed. See you at 2!' };
        const v = classifyAction(req, DEFAULT_SAFETY);
        const card = describeAction(req, v.reasons);
        toPanel({ type: 'confirm', id: 'c1', ...card, subtitle: 'Send the reply to Dana', kind: 'action', timeoutMs: 90_000 });
      }
      await sleep(1100);
      break;
    case 'model-picker':
      summon();
      await sleep(2300);
      toPanel({ type: '__picker' });
      await sleep(700);
      break;
    case 'voice-listening':
      summon();
      await sleep(2300);
      // V5: truthful: the live state is "listening" with the level meter; the
      // words appear once Parakeet finishes the utterance (no partials).
      toPanel({ type: 'voice', state: 'listening', level: 0.75 });
      await sleep(500);
      freezeAll(0);
      await sleep(60);
      break;
    case 'settings':
      summon();
      await sleep(2300);
      toPanel({ type: '__settings' });
      await sleep(700);
      break;
    case 'shortcut-recorder':
      summon();
      await sleep(2300);
      toPanel({ type: '__settings', focus: 'shortcut' });
      await sleep(500);
      freezeAll(0);
      await sleep(60);
      break;
    case 'app-choices':
      summon();
      await sleep(2300);
      toPanel({ type: 'user-echo', text: 'open visual studio', via: 'typed' });
      toPanel({
        type: 'apps',
        query: 'visual studio',
        choices: [
          { id: 'a', name: 'Visual Studio Code', source: 'startmenu' },
          { id: 'b', name: 'Visual Studio 2022', source: 'startmenu' },
          { id: 'c', name: 'Visual Studio Installer', source: 'startmenu' },
        ],
      });
      toPanel({ type: 'event', event: { type: 'done' } });
      toPanel({ type: 'busy', busy: false });
      await sleep(900);
      break;
    case 'app-launch': {
      summon();
      await sleep(2300);
      toPanel({ type: 'voice', state: 'off' });
      toPanel({ type: 'user-echo', text: 'Cadabra, open Spotify', via: 'voice' });
      toPanel({ type: 'launch', name: 'Spotify', status: 'opening' });
      const from = { x: PANEL.x + 40, y: PANEL.y + 250 };
      toOverlay({ type: 'launch', from, to: { x: 330, y: 330 }, name: 'Spotify', reducedMotion: false });
      freezeAll(430);
      await sleep(560);
      break;
    }
    case 'onboarding-welcome':
    case 'onboarding-name':
    case 'onboarding-backend':
    case 'onboarding-voice':
    case 'onboarding-done':
    case 'onboarding-assistant': {
      summon(true);
      await sleep(300);
      const step = state.replace('onboarding-', '');
      toPanel({ type: '__onboarding', step, name: step === 'name' ? 'jdoe42' : undefined, backend: step === 'backend' ? 'codex' : undefined, pct: step === 'voice' ? 42 : undefined });
      await sleep(900);
      freezeAll(0);
      await sleep(60);
      break;
    }
    case 'sign-in-gemini':
    case 'settings-accounts':
      summon(true);
      await sleep(300);
      toPanel({ type: '__settings' });
      await sleep(400);
      if (state === 'sign-in-gemini') toPanel({ type: '__account-tab', id: 'gemini' });
      await sleep(500);
      break;
    case 'onboarding-claude':
      summon(true);
      await sleep(300);
      toPanel({ type: '__onboarding', step: 'backend', backend: 'claude' });
      await sleep(900);
      freezeAll(0);
      await sleep(60);
      break;
    case 'claude-install-consent':
    case 'claude-install-progress':
    case 'claude-install-manual':
    case 'claude-connect':
    case 'claude-signed-in':
    case 'claude-test-ok':
      summon(true);
      await sleep(300);
      toPanel({ type: '__settings' });
      await sleep(400);
      toPanel({ type: '__account-tab', id: 'claude' });
      await sleep(400);
      if (state === 'claude-install-manual') {
        toPanel({ type: '__click', selector: '.cl-manual summary' });
        await sleep(150);
        toPanel({ type: '__scroll', selector: '.cl-howto' });
        await sleep(200);
      } else {
        toPanel({ type: '__click', selector: '.cl-install' });
        await sleep(150);
        if (state !== 'claude-install-consent') {
          toPanel({ type: '__click', selector: '.cl-run' });
          // The demo installer takes ~1.5 s, so the progress state can be captured.
          await sleep(state === 'claude-install-progress' ? 250 : 1900);
        }
        if (state === 'claude-connect') {
          toPanel({ type: '__scroll', selector: '.cl-step.current' });
          await sleep(200);
        }
        if (state === 'claude-signed-in' || state === 'claude-test-ok') {
          toPanel({ type: '__click', selector: '.cl-choice[data-opt="claude-code"] .acct-go' });
          await sleep(500);
          if (state === 'claude-test-ok') {
            toPanel({ type: '__click', selector: '.cl-setup .acct-test' });
            await sleep(400);
            toPanel({ type: '__scroll', selector: '.cl-setup .acct-progress' });
          } else toPanel({ type: '__scroll', selector: '.cl-step.current' });
          await sleep(200);
        }
      }
      freezeAll(0);
      await sleep(60);
      break;
    case 'settings-privacy':
      summon(true);
      await sleep(300);
      toPanel({ type: '__settings' });
      await sleep(600);
      toPanel({ type: '__scroll', selector: '#s-privacy-group' });
      await sleep(250);
      freezeAll(0);
      await sleep(60);
      break;
    case 'settings-announcements':
      summon(true);
      await sleep(300);
      toPanel({ type: '__settings' });
      await sleep(600);
      toPanel({ type: '__scroll', selector: '#s-ann-group' });
      await sleep(250);
      freezeAll(0);
      await sleep(60);
      break;
    case 'settings-skills':
      summon(true);
      await sleep(300);
      toPanel({ type: '__settings' });
      await sleep(500);
      toPanel({ type: '__click', selector: '.sk-row[data-id="builtin:morning-briefing"] .sk-view summary' });
      await sleep(250);
      toPanel({ type: '__scroll', selector: '#s-skills-group' });
      await sleep(250);
      freezeAll(0);
      await sleep(60);
      break;
    case 'voice-status-ok':
    case 'voice-status-reconnecting':
    case 'voice-status-blocked': {
      summon(true);
      await sleep(300);
      const status =
        state === 'voice-status-ok'
          ? { health: 'ok', text: 'Voice: listening', detail: '', device: 'Microphone (USB Audio Interface)', lastRestartReason: 'the default microphone changed', lastRestartAt: Date.now() - 12 * 60_000, restarts: { mic: 1, engine: 0 } }
          : state === 'voice-status-reconnecting'
            ? { health: 'mic-lost', text: 'The microphone stopped; reconnecting…', detail: 'capture ended', device: 'Headset Microphone (Bluetooth)', lastRestartReason: 'the capture ended (device lost or changed)', lastRestartAt: Date.now() - 5_000, restarts: { mic: 2, engine: 0 } }
            : { health: 'no-mic-access', text: 'Microphone access is blocked (Windows Settings → Privacy & security → Microphone)', detail: '', device: '', lastRestartReason: 'microphone access blocked', lastRestartAt: Date.now() - 30_000, restarts: { mic: 1, engine: 0 } };
      toPanel({ type: '__voiceStatus', status });
      toPanel({ type: '__settings' });
      await sleep(500);
      toPanel({ type: '__scroll', selector: '#s-vstatus' });
      if (state !== 'voice-status-ok') toPanel({ type: '__voiceStatus', status: {}, notice: `${/[.!?…)]$/.test(status.text) ? status.text : `${status.text}.`} ${status.health === 'no-mic-access' ? 'Settings → Voice → Open microphone settings to allow it.' : 'Tray → Restart voice if it doesn’t recover.'}` });
      await sleep(400);
      break;
    }
    case 'settings-web':
      summon(true);
      await sleep(300);
      toPanel({ type: '__settings' });
      await sleep(500);
      toPanel({ type: '__scroll', selector: '#s-location' });
      await sleep(300);
      break;
    case 'settings-email':
    case 'settings-greetings':
      summon(true);
      await sleep(300);
      toPanel({ type: '__settings' });
      await sleep(600);
      toPanel({ type: '__scroll', selector: state === 'settings-email' ? '#s-email .em-path' : '#s-greetaway' });
      await sleep(300);
      break;
    case 'voice-status-headset':
      summon(true);
      await sleep(300);
      toPanel({ type: '__voiceStatus', status: { health: 'ok', text: 'Voice: listening', device: 'Microphone (USB Audio Interface)', pendingDefault: 'Headset (Bluetooth Hands-Free)', lastRestartReason: '', lastRestartAt: null, restarts: { mic: 0, engine: 0 } } });
      toPanel({ type: '__settings' });
      await sleep(500);
      toPanel({ type: '__scroll', selector: '#s-vstatus' });
      await sleep(400);
      break;
    case 'voice-ptt-not-working':
      summon(true);
      await sleep(300);
      toPanel({ type: '__voiceStatus', status: { health: 'mic-lost', text: 'The microphone stopped; reconnecting…' }, notice: 'The microphone stopped; reconnecting… Push-to-talk can’t hear you right now. Tray → Restart voice if it doesn’t recover.' });
      await sleep(400);
      break;
    case 'settings-voice':
      summon(true);
      await sleep(300);
      toPanel({ type: '__settings' });
      await sleep(500);
      toPanel({ type: '__scroll', selector: '#s-ttsvoice' });
      await sleep(300);
      break;
    case 'setup-card':
      provider = { id: 'codex', label: 'Codex', auth: { ok: false, detail: 'Not signed in', howTo: 'Sign in with ChatGPT, or use an OpenAI API key.' }, models: [] };
      summon(true);
      provider = PROVIDER;
      await sleep(900);
      break;
    case 'acting-hud':
      summon(true);
      await sleep(300);
      toPanel({ type: 'user-echo', text: 'Export it as PDF', via: 'typed' });
      toPanel({ type: '__acting', on: true, caption: 'Opening Export…' });
      panelFrame.style.height = '64px';
      toOverlay({ type: 'ghost-move', from: { x: PANEL.x - 12, y: PANEL.y + 40 }, to: centerOf('btn-export'), durationMs: 820, reducedMotion: false, avoid: { ...PANEL, height: 64 } });
      freezeAll(600);
      await sleep(700);
      break;
    case 'dismiss':
      summon();
      await sleep(2600);
      panelFrame.classList.remove('show');
      panelFrame.classList.add('hide');
      toPanel({ type: 'dismiss' });
      toOverlay({ type: 'dismiss', to: CLICK, panel: PANEL, reducedMotion: false });
      freezeAll(95);
      await sleep(200);
      break;
  }
}

// Keep in sync with DEMO_STATES in src/main/demo-stage.ts.
const DEMO_STATE_NAMES = ['summon-ripple', 'window-scan', 'panel-idle', 'panel-thinking', 'panel-streaming', 'panel-answer', 'highlight-rings', 'ghost-moving', 'ghost-click', 'confirm', 'model-picker', 'voice-listening', 'settings', 'dismiss', 'app-choices', 'app-launch', 'shortcut-recorder', 'onboarding-welcome', 'onboarding-name', 'onboarding-backend', 'onboarding-voice', 'onboarding-done', 'settings-accounts', 'sign-in-gemini', 'setup-card', 'acting-hud', 'onboarding-claude', 'claude-install-consent', 'claude-signed-in', 'settings-voice', 'onboarding-assistant', 'voice-status-ok', 'voice-status-reconnecting', 'voice-status-blocked', 'voice-ptt-not-working', 'settings-web', 'voice-status-headset', 'settings-email', 'settings-greetings', 'claude-install-progress', 'claude-install-manual', 'claude-connect', 'claude-test-ok', 'settings-skills', 'settings-announcements', 'settings-privacy'];
(window as any).demo = { show, states: DEMO_STATE_NAMES };
// `npm run demo:video`: the promo timeline (scripts/record-demo.ts).
if (new URLSearchParams(location.search).has('promo')) installPromo({ toPanel, toOverlay, summon: () => summon(), reset, rectOf, centerOf, panel: PANEL, panelFrame });
(window as any).demoReady = Promise.resolve();

if (!capture && !bare) {
  const box = document.getElementById('controls')!;
  const states = DEMO_STATE_NAMES;
  for (const s of states) {
    const b = document.createElement('button');
    b.textContent = s;
    b.onclick = () => void show(s);
    box.append(b);
  }
  // Live loop (no freezing) so you can watch the motion.
  const live = document.createElement('button');
  live.textContent = '▶ live summon';
  live.onclick = async () => {
    await reset();
    summon();
  };
  box.append(live);
  void show('panel-idle');
}
void STAGE;
