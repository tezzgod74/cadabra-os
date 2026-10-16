import { AUTONOMY_OPTIONS } from './autonomy';
import type { PanelMessage, ProviderEvent, ProviderInfo, VoiceState } from '../../shared/types';
import { demoChannel, freezeCssAfter, isDemo, postToStage } from '../shared/demo-bridge';
import { sparkSvg } from '../shared/spark';
import { renderStreaming } from './markdown';
import { bindingFromKeyEvent, bindingFromMouseEvent, bindingKeycaps, DEFAULT_BINDING, validateBinding, type SummonBinding } from '../../shared/binding';
import { renderAccount, showAccountStatus, type AccountView } from './accounts';
import { onboardingOpen, onboardingTtsProgress, onboardingVoiceProgress, onboardingVoiceState, startOnboarding } from './onboarding';
import { KOKORO_VOICES } from '../../shared/voices';
import { personaVoiceState, renderNamePicker, renderPersonaCards, voiceOptions, waitForWake } from './persona-ui';
import { displayName as assistantName } from '../../shared/assistant';
import { initialPanelStatus, reducePanelStatus, type PanelStatusMsg } from '../../shared/panel-status';

const DEMO_VOICES = KOKORO_VOICES;

// ---------------------------------------------------------------- bridge --

interface Api {
  onMessage(cb: (m: PanelMessage) => void): void;
  send(text: string): void;
  cancel(): void;
  dismiss(): void;
  resolveConfirm(id: string, allowed: boolean, always?: boolean): void;
  permList?(): Promise<{ cls: string; scope: string; label: string; at: number }[] | null>;
  permRevoke?(scope: string, cls: string): Promise<unknown>;
  listProviders(): Promise<ProviderInfo[]>;
  setModel(provider: string, model: string): Promise<void>;
  newChat(): void;
  launchApp(id: string): void;
  openExternal(url: string): void;
  openSettings(): void;
  getSettings(): Promise<any>;
  setSettings(patch: unknown): Promise<any>;
  setSecret(key: string, value: string | null): Promise<boolean>;
  setRecording(on: boolean): void;
  ready(): void;
  accountOptions(provider: string): Promise<AccountView | null>;
  signIn(provider: string, optionId: string, key: string | null): Promise<AccountView | null>;
  signOut(provider: string): Promise<AccountView | null>;
  testProvider(provider: string): Promise<{ ok: boolean; text?: string; error?: string } | null>;
  installCli(provider: string): Promise<{ ok: boolean; error?: string; view?: AccountView } | null>;
  browseCli?(provider: string): Promise<AccountView | null>;
  ttsStatus?(): Promise<any>;
  ttsDownload?(): Promise<{ ok: boolean; error?: string }>;
  previewVoice?(voice: string, speed: number): Promise<boolean>;
  voiceStatus?(): Promise<any>;
  restartVoice?(): Promise<boolean>;
  voiceDevices?(): Promise<{ inputs: string[]; defaultInput: string; chosen: string }>;
  useVoiceDevice?(label: string): Promise<boolean>;
  markMicNotCall?(exe: string, on: boolean): Promise<boolean>;
  micStatus(): Promise<string | null>;
  openMicSettings(): void;
  emailStatus?(): Promise<EmailStatus | null>;
  announceOutputs?(): Promise<string[]>;
  clearHistory?(): Promise<string | null>;
  announceTest?(): Promise<{ ok: boolean; reason?: string } | null>;
  skillsList?(): Promise<{ skills: SkillView[]; userDir: string; builtinDir: string } | null>;
  skillsSetEnabled?(id: string, on: boolean): Promise<boolean>;
  skillsView?(id: string): Promise<string | null>;
  skillsOpenFolder?(which: string): Promise<boolean>;
  skillsNew?(name: string): Promise<{ ok: boolean; error?: string; name?: string } | null>;
  skillsReload?(): Promise<unknown>;
  waStatus?(): Promise<WaStatus | null>;
  waSetToken?(t: string | null): Promise<{ ok: boolean; error?: string } | null>;
  waTest?(): Promise<{ ok: boolean; error?: string } | null>;
  waEnable?(on: boolean): Promise<WaStatus | null>;
  waPair?(): Promise<{ code: string } | null>;
  waUnpair?(): Promise<WaStatus | null>;
  waAutonomy?(a: string): Promise<WaStatus | null>;
  waPower?(p: { wakeDisplay?: boolean; keepAwake?: boolean }): Promise<WaStatus | null>;
  emailSetBodies?(on: boolean): Promise<EmailStatus | null>;
  emailOpenHelp?(which: string): void;
  emailConnectOAuth?(clientIdOrJson: string, clientSecret: string | null): Promise<{ ok: boolean; error?: string; status?: EmailStatus } | null>;
  emailConnectImap?(address: string, appPassword: string): Promise<{ ok: boolean; error?: string; status?: EmailStatus } | null>;
  emailDisconnect?(): Promise<(EmailStatus & { revoked?: boolean; wasImap?: boolean }) | null>;
}

interface WaStatus {
  enabled: boolean;
  hasToken: boolean;
  paired: boolean;
  status: string;
  autonomy: string;
  encryption: boolean;
  wakeDisplay?: boolean;
  keepAwake?: boolean;
}

interface EmailStatus {
  mode: 'none' | 'gmail-oauth' | 'gmail-imap';
  address: string;
  connected: boolean;
  allowBodies: boolean;
  encryption: boolean;
}

const DEMO_PROVIDERS: ProviderInfo[] = [
  {
    id: 'claude',
    label: 'Claude',
    auth: { ok: true, detail: 'API key saved in Settings' },
    models: [
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: 'Fast and smart — great default' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5', description: 'Best for long multi-step tasks' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5', description: 'Fastest answers' },
    ],
  },
  { id: 'copilot', label: 'GitHub Copilot', auth: { ok: false, detail: 'Not signed in', howTo: 'Run `copilot` and /login' }, models: [] },
  { id: 'codex', label: 'Codex', auth: { ok: false, detail: 'Not signed in', howTo: 'Sign in with ChatGPT (via Codex)' }, models: [] },
  { id: 'gemini', label: 'Gemini', auth: { ok: false, detail: 'Not signed in', howTo: 'Sign in with Google (via Gemini CLI)' }, models: [] },
  { id: 'demo', label: 'Demo', auth: { ok: true, detail: 'Offline' }, models: [{ id: 'demo-sparkle', label: 'Sparkle (offline)' }] },
];

function makeDemoApi(): Api {
  let settings: any = {
    settings: {
      provider: 'claude',
      models: { claude: 'claude-sonnet-5-5' },
      launchAtLogin: true,
      paused: false,
      motion: 'system',
      voice: { enabled: true, speakReplies: 'voice', followUpSeconds: 8, wakeWord: 'cadabra', sensitivity: 0.5, pushToTalk: false, ttsEngine: 'kokoro', ttsVoice: 'bm_george', ttsSpeed: 1.05, phrasing: false, cloudVoice: false, fastModelForVoice: true, inputDevice: '' },
      displayName: 'Alex',
      summon: DEFAULT_BINDING,
      safety: { confirmAllActions: false, denylist: new Array(21).fill(0), maxActionsPerRun: 40 },
      greetings: { enabled: true, awayMinutes: 20, quietStart: '22:30', quietEnd: '07:00', recent: [] },
    },
    secrets: { anthropicApiKey: true },
    encryption: true,
    voice: { state: 'idle', engine: 'sherpa-onnx' },
    version: '0.9.11',
  };
  return {
    onMessage: (cb) => demoChannel(cb),
    send: (t) => postToStage('send', t),
    cancel: () => postToStage('cancel'),
    dismiss: () => postToStage('dismiss'),
    resolveConfirm: (id, ok) => postToStage('confirm', { id, ok }),
    listProviders: async () => DEMO_PROVIDERS,
    setModel: async () => undefined,
    newChat: () => postToStage('new-chat'),
    launchApp: (id) => postToStage('launch-app', id),
    openExternal: () => undefined,
    openSettings: () => showSettings(),
    getSettings: async () => settings,
    setSettings: async (p: any) => {
      settings = { ...settings, settings: { ...settings.settings, ...p } };
      return settings.settings;
    },
    setSecret: async () => true,
    setRecording: () => undefined,
    ready: () => postToStage('ready'),
    accountOptions: async (id) => DEMO_ACCOUNTS[id] ?? null,
    signIn: async (id) => {
      postToStage('sign-in', id);
      const v = DEMO_ACCOUNTS[id];
      if (id === 'claude') {
        // Demo stage: what the real flow shows after Claude Code's own login finished.
        return { ...v, install: { installed: true }, active: 'claude-code', auth: { ok: true, detail: 'Signed in to Claude Code' } };
      }
      return v ? { ...v, auth: { ok: true, detail: id === 'codex' ? 'ChatGPT account (via Codex)' : 'Signed in via Gemini CLI' } } : null;
    },
    signOut: async (id) => DEMO_ACCOUNTS[id] ?? null,
    testProvider: async () => ({ ok: true, text: 'Ready.' }),
    installCli: async (id) => {
      postToStage('install', id);
      if (id === 'claude') await new Promise((r) => setTimeout(r, 1500)); // lets the demo stage show progress
      return { ok: true, view: DEMO_ACCOUNTS[id] ? { ...DEMO_ACCOUNTS[id], install: { installed: true } } : undefined };
    },
    micStatus: async () => 'granted',
    ttsStatus: async () => ({ available: true, installed: true, downloading: false, sizeMb: 350, voices: DEMO_VOICES, curated: DEMO_VOICES.slice(0, 6).map((v) => v.id) }),
    ttsDownload: async () => ({ ok: true }),
    previewVoice: async () => true,
    voiceStatus: async () => demoVoiceStatus,
    restartVoice: async () => true,
    voiceDevices: async () => ({ inputs: ['Microphone (USB Audio Interface)', 'Microphone Array (Built-in)', 'Headset (Bluetooth Hands-Free)'], defaultInput: demoVoiceStatus.pendingDefault || 'Microphone (USB Audio Interface)', chosen: '' }),
    useVoiceDevice: async () => true,
    openMicSettings: () => undefined,
    emailStatus: async () => demoEmail,
    emailSetBodies: async (on) => (demoEmail = { ...demoEmail, allowBodies: on }),
    emailOpenHelp: () => undefined,
    emailConnectOAuth: async () => ({ ok: true, status: (demoEmail = { ...demoEmail, mode: 'gmail-oauth', connected: true, address: 'you@gmail.com' }) }),
    emailConnectImap: async () => ({ ok: true, status: (demoEmail = { ...demoEmail, mode: 'gmail-imap', connected: true, address: 'you@gmail.com' }) }),
    emailDisconnect: async () => (demoEmail = { ...demoEmail, mode: 'none', connected: false, address: '' }),
    clearHistory: async () => 'Done — history cleared.',
    announceOutputs: async () => ['Speakers (High Definition Audio)', 'Living Room Speaker (Bluetooth)', 'Headphones (USB Audio)'],
    announceTest: async () => ({ ok: true }),
    skillsList: async () => ({ skills: demoSkills, userDir: 'C:\\Users\\you\\Documents\\Cadabra\\Skills', builtinDir: 'C:\\Program Files\\Cadabra OS\\resources\\skills' }),
    skillsSetEnabled: async (id, on) => {
      demoSkills = demoSkills.map((k) => (k.id === id ? { ...k, enabled: on, active: on && !k.errors.length } : k));
      return true;
    },
    skillsView: async (id) => (id === 'builtin:morning-briefing' ? '# Morning briefing\n\n1. Get today’s weather for the user’s location.\n2. Check today’s email.\n3. Find three top headlines.\n4. Finish with one friendly sentence.' : '# My skill\n\n1. …'),
    skillsOpenFolder: async () => true,
    skillsNew: async (name) => ({ ok: true, name }),
    skillsReload: async () => demoSkills,
  };
}

interface SkillView {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'install' | 'user';
  folder: string;
  enabled: boolean;
  active: boolean;
  errors: string[];
  warnings: string[];
  shadowedBy?: string;
  examples: string[];
  files: string[];
}
let demoSkills: SkillView[] = [
  { id: 'builtin:morning-briefing', name: 'morning-briefing', description: 'Use when the user asks for their morning briefing: weather, today’s new email and a few top headlines.', source: 'builtin', folder: '', enabled: true, active: true, errors: [], warnings: [], examples: ['morning briefing', 'start my day'], files: [] },
  { id: 'builtin:quick-note', name: 'quick-note', description: 'Use when the user asks to jot down a quick note. Saves it in Documents with the date and time.', source: 'builtin', folder: '', enabled: true, active: true, errors: [], warnings: [], examples: ['take a quick note'], files: [] },
  { id: 'builtin:work-setup', name: 'work-setup', description: 'Use when the user wants to set up for work: opens their usual apps and sites.', source: 'builtin', folder: '', enabled: false, active: false, errors: [], warnings: [], examples: ['set up for work'], files: ['sites.txt'] },
  { id: 'user:plan-my-trip', name: 'plan-my-trip', description: 'Use when I ask to plan a weekend trip: checks the weather and opens my travel sites.', source: 'user', folder: '', enabled: false, active: false, errors: [], warnings: [], examples: ['plan my trip'], files: [] },
  { id: 'user:dinner-ideas', name: 'dinner-ideas', description: '', source: 'user', folder: '', enabled: false, active: false, errors: ['Missing "description:" — one or two sentences saying when to use this skill.'], warnings: [], examples: [], files: [] },
];

let demoEmail: EmailStatus = { mode: 'none', address: '', connected: false, allowBodies: true, encryption: true };

// Demo-stage account states (screenshots): real option lists, fake status.
const DEMO_ACCOUNTS: Record<string, AccountView> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    auth: { ok: false, detail: 'Not set up yet' },
    canSignOut: true,
    options: [
      { id: 'claude-code', label: 'Use my Claude subscription (via Claude Code)', note: 'No extra cost: uses your Pro/Max limits through Anthropic’s Claude Code app on this PC. Anthropic’s terms may restrict use of subscriptions by third-party apps — use at your own risk.' },
      { id: 'api-key', label: 'Use an Anthropic API key', needsKey: true, keyPlaceholder: 'sk-ant-…', note: 'Billed per use by Anthropic, separately from any Claude subscription (console.anthropic.com). Clearly permitted for apps like Cadabra. Runs in the Claude Code app, but only your key is used, never your subscription.' },
      { id: 'bedrock', label: 'Use Amazon Bedrock', note: 'Runs in the Claude Code app with your AWS credentials from the environment (AWS_REGION, AWS_PROFILE).' },
      { id: 'vertex', label: 'Use Google Vertex AI', note: 'Runs in the Claude Code app with ANTHROPIC_VERTEX_PROJECT_ID / CLOUD_ML_REGION and your gcloud login.' },
    ],
    install: {
      installed: false,
      name: 'Claude Code',
      command: 'irm https://claude.ai/install.ps1 | iex',
      manual: ['irm https://claude.ai/install.ps1 | iex'],
      docsUrl: 'https://code.claude.com/docs/en/setup',
      blocker: null,
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    auth: { ok: false, detail: 'Not signed in', howTo: 'Sign in with ChatGPT, or use an OpenAI API key.' },
    canSignOut: true,
    options: [
      { id: 'chatgpt', label: 'Sign in with ChatGPT (via Codex)', note: 'Uses your ChatGPT plan through OpenAI’s official Codex app. OpenAI’s sign-in page opens in your browser; Cadabra never sees your password or tokens.' },
      { id: 'apiKey', label: 'Use an OpenAI API key', needsKey: true, keyPlaceholder: 'sk-…', note: 'Usage-based billing on your OpenAI account. The key is handed to Codex.' },
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    auth: { ok: false, detail: 'Not signed in', howTo: 'Choose “Sign in with Google (via Gemini CLI)” or paste a Gemini API key.' },
    canSignOut: true,
    options: [
      { id: 'oauth-personal', label: 'Sign in with Google (via Gemini CLI)', note: 'Uses your Google account through Google’s official Gemini CLI; Google’s sign-in opens in your browser and Cadabra never sees your credentials.' },
      { id: 'gemini-api-key', label: 'Use a Gemini API key', needsKey: true, keyPlaceholder: 'AIza…', note: 'From Google AI Studio. Stored encrypted on this PC.' },
      { id: 'vertex-ai', label: 'Use Vertex AI', note: 'Set GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION (and gcloud auth) in your environment, then choose this.' },
    ],
  },
};

const api: Api = isDemo() ? makeDemoApi() : (window as any).cadabra;

// ------------------------------------------------------------------- dom --

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const root = $('root');
const messages = $('messages');
const scroll = $('scroll');
const empty = $('empty');
const input = $<HTMLTextAreaElement>('input');
const form = $<HTMLFormElement>('composer');
const statusEl = $('status');
const statusText = $('status-text');
const pill = $('model-pill');
const modelLabel = $('model-label');
const picker = $('picker');
const targetEl = $('target');
const targetText = $('target-text');
const settingsEl = $('settings');
const wave = $<HTMLCanvasElement>('wave');

$('brand-mark').innerHTML = sparkSvg(17, 'brand');
$('empty-mark').innerHTML = sparkSvg(34, 'emptyg');

let busy = false;
let lastVoiceProblem = '';
/** Demo stage: the voice status Settings shows (screenshots of problem states). */
let demoVoiceStatus: any = { enabled: true, health: 'ok', text: 'Voice: listening', detail: '', device: 'Microphone (USB Audio Interface)', lastRestartReason: '', lastRestartAt: null, restarts: { mic: 0, engine: 0 } };
let assistantLabel = 'Cadabra';
let reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let provider: ProviderInfo | null = null;
let model = '';
let voiceState: VoiceState = 'off';
let voiceLevel = 0;

const SUGGESTIONS = [
  ['What am I looking at?', 'Explain'],
  ['Summarize this for me', 'Summarize'],
  ['Show me where to click to…', 'Point'],
];

function renderSuggestions() {
  const box = $('suggestions');
  box.innerHTML = '';
  for (const [text, tag] of SUGGESTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'suggestion';
    b.innerHTML = `<b>${tag}</b><span></span>`;
    b.querySelector('span')!.textContent = text;
    b.onclick = () => {
      if (text.endsWith('…')) {
        input.value = text.slice(0, -1) + ' ';
        input.focus();
        autosize();
      } else submit(text);
    };
    box.append(b);
  }
}
renderSuggestions();

function setEmpty() {
  empty.style.display = messages.children.length ? 'none' : '';
}

function scrollToEnd() {
  scroll.scrollTop = scroll.scrollHeight;
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 100) + 'px';
}

function setBusy(b: boolean, run?: number) {
  busy = b;
  root.classList.toggle('busy', b);
  applyStatus({ type: 'busy', busy: b, run });
}

// 0.9.4: the status line and the acting-HUD caption follow the pure reducer in
// shared/panel-status.ts: a run's end clears them, an idle summon shows none,
// and anything tagged with an older run is dropped.
let panelStatus = initialPanelStatus();
function applyStatus(m: PanelStatusMsg) {
  const before = panelStatus;
  panelStatus = reducePanelStatus(panelStatus, m);
  if (panelStatus === before) return;
  root.classList.toggle('acting', panelStatus.acting);
  $('hud-text').textContent = panelStatus.caption || 'Working…';
  if (panelStatus.status !== before.status || m.type === 'status') setStatus(panelStatus.status);
}

function setStatus(text: string | null) {
  if (text) {
    statusText.textContent = text;
    statusEl.classList.add('show');
  } else statusEl.classList.remove('show');
}

function shortModel(p: ProviderInfo | null, id: string) {
  const m = p?.models.find((x) => x.id === id);
  return m?.label ?? (id || 'default');
}

/** UX2: a backend that isn't connected gets a setup card right in the empty state. */
function renderSetup() {
  const el = $('setup');
  const need = !!provider && provider.id !== 'demo' && !!provider.auth && !provider.auth.ok;
  el.hidden = !need;
  $('suggestions').style.display = need ? 'none' : '';
  empty.classList.toggle('needs-setup', need);
  if (!need || el.dataset.provider === provider!.id) return;
  el.dataset.provider = provider!.id;
  el.innerHTML = `<p class="setup-title">Connect ${provider!.label} to get started</p><div class="setup-acct"></div>`;
  void renderAccount(el.querySelector<HTMLElement>('.setup-acct')!, api, provider!.id, async () => {
    const provs = await api.listProviders().catch(() => [] as ProviderInfo[]);
    const p = provs.find((x) => x.id === provider?.id);
    if (p) provider = p;
    renderPill();
    setTimeout(() => {
      el.hidden = true;
      $('suggestions').style.display = '';
      empty.classList.remove('needs-setup');
      delete el.dataset.provider;
    }, 900);
  });
}

function renderPill() {
  if (!provider) return;
  modelLabel.textContent = provider.id === 'demo' ? 'Demo · offline' : `${provider.label === 'GitHub Copilot' ? 'Copilot' : provider.label} · ${shortModel(provider, model)}`;
  pill.classList.toggle('warn', !!provider.auth && !provider.auth.ok);
  pill.title = provider.auth && !provider.auth.ok ? `${provider.auth.detail}${provider.auth.howTo ? ' — ' + provider.auth.howTo : ''}` : 'Switch AI model';
}

// ------------------------------------------------------------- messages --

function addUser(text: string, via?: 'voice' | 'typed') {
  const el = document.createElement('div');
  el.className = 'msg user';
  if (via === 'voice') {
    const v = document.createElement('span');
    v.className = 'via';
    v.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.2" y="1.5" width="5.6" height="8.6" rx="2.8" fill="currentColor"/><path d="M3 7.6a5 5 0 0 0 10 0M8 12.6v2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>said</span>`;
    v.setAttribute('aria-label', 'You said');
    el.append(v);
  }
  el.append(document.createTextNode(text));
  messages.append(el);
  setEmpty();
  scrollToEnd();
}

function addNotice(text: string, tone: 'info' | 'warn' = 'info') {
  const el = document.createElement('div');
  el.className = `msg notice ${tone === 'warn' ? 'warn' : ''}`;
  el.textContent = text;
  messages.append(el);
  setEmpty();
  scrollToEnd();
}

/** One assistant turn: tool chips + streamed markdown. */
class Turn {
  el = document.createElement('div');
  tools = document.createElement('div');
  body = document.createElement('div');
  src = '';
  shown = 0; // source chars revealed
  rendered = 0; // text chars rendered
  raf = 0;
  toolEls = new Map<string, HTMLElement>();
  constructor() {
    this.el.className = 'msg assistant';
    this.tools.className = 'tools';
    this.body.className = 'md';
    this.el.append(this.tools, this.body);
    messages.append(this.el);
    setEmpty();
  }
  push(delta: string) {
    this.src += delta;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.tick());
  }
  /** Reveal words at a calm pace that catches up when the backlog grows. */
  tick() {
    this.raf = 0;
    const backlog = this.src.length - this.shown;
    if (backlog <= 0) return;
    if (reduced) this.shown = this.src.length;
    else {
      const step = Math.max(3, Math.ceil(backlog / 10));
      let next = Math.min(this.src.length, this.shown + step);
      const ws = this.src.slice(next).search(/\s/);
      next = ws === -1 ? this.src.length : next + ws;
      this.shown = next;
    }
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
    this.rendered = renderStreaming(this.body, this.src.slice(0, this.shown), this.rendered);
    if (nearBottom) scrollToEnd();
    if (this.shown < this.src.length) this.raf = requestAnimationFrame(() => this.tick());
  }
  flush() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.shown < this.src.length) {
      this.shown = this.src.length;
      this.rendered = renderStreaming(this.body, this.src, this.rendered);
    }
  }
  tool(ev: Extract<ProviderEvent, { type: 'tool' }>) {
    const labels: Record<string, [string, string]> = {
      see_screen: ['Looking at the screen', 'Looked at the screen'],
      read_ui: ['Reading the window', 'Read the window'],
      highlight: ['Pointing it out', 'Pointed it out'],
      click: ['Clicking', 'Clicked'],
      type_text: ['Typing', 'Typed'],
      press_keys: ['Pressing keys', 'Pressed keys'],
      scroll: ['Scrolling', 'Scrolled'],
      confirm_with_user: ['Asking you', 'Asked you'],
      set_provider: ['Switching backend', 'Switched backend'],
      set_model: ['Switching model', 'Switched model'],
      set_voice: ['Updating voice', 'Updated voice'],
      pause_cadabra: ['Pausing', 'Paused'],
      find_apps: ['Finding apps', 'Found apps'],
      launch_app: ['Opening', 'Opened'],
      focus_app: ['Switching to the app', 'Switched apps'],
      run_in_terminal: ['Running in a terminal', 'Ran it'],
      change_shortcut: ['Changing your shortcut', 'Changed the shortcut'],
      get_weather: ['Checking the weather', 'Checked the weather'],
      search_email: ['Checking your email', 'Checked your email'],
      read_email: ['Reading the email', 'Read the email'],
      open_email: ['Opening Gmail', 'Opened Gmail'],
      open_url: ['Opening the page', 'Opened the page'],
      lock_pc: ['Locking the PC', 'Locked'],
      list_skills: ['Checking your skills', 'Checked your skills'],
      use_skill: ['Loading your skill', 'Loaded your skill'],
    };
    if (ev.phase === 'start') {
      const chip = document.createElement('span');
      chip.className = 'tool run';
      chip.dataset.name = ev.name;
      chip.innerHTML = '<i></i><span></span>';
      chip.querySelector('span')!.textContent = (labels[ev.name]?.[0] ?? ev.name) + '…';
      this.tools.append(chip);
      this.toolEls.set(ev.id, chip);
    } else {
      const chip = this.toolEls.get(ev.id);
      if (!chip) return;
      const name = chip.dataset.name ?? '';
      chip.className = `tool ${ev.ok === false ? 'fail' : 'ok'}`;
      chip.querySelector('span')!.textContent = labels[name]?.[1] ?? name;
      if (ev.ok === false && ev.summary) chip.title = ev.summary;
    }
    scrollToEnd();
  }
}

let turn: Turn | null = null;

function onEvent(ev: ProviderEvent) {
  switch (ev.type) {
    case 'text':
      setStatus(null);
      (turn ??= new Turn()).push(ev.delta);
      break;
    case 'tool':
      (turn ??= new Turn()).tool(ev);
      break;
    case 'status':
      applyStatus({ type: 'status', text: ev.text });
      break;
    case 'error': {
      turn?.flush();
      const el = document.createElement('div');
      el.className = 'msg error';
      el.textContent = ev.message;
      messages.append(el);
      setEmpty();
      scrollToEnd();
      turn = null;
      break;
    }
    case 'done':
      turn?.flush();
      if (turn && !turn.src && !turn.tools.children.length) turn.el.remove();
      turn = null;
      break;
  }
}

function addConfirm(m: Extract<PanelMessage, { type: 'confirm' }>) {
  const card = document.createElement('div');
  card.className = 'msg confirm';
  card.dataset.id = m.id;
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-label', m.title);
  // S1 residual: the model's own yes/no question looks different from a gate card.
  const question = m.kind === 'question';
  if (question) card.classList.add('question');
  card.innerHTML = `<div class="c-kicker">${question ? 'Question from Cadabra' : 'Needs your OK'}</div><div class="c-title"></div><pre class="c-mono"></pre><div class="c-detail"></div><div class="c-sub"></div><div class="c-risk"></div>
    <div class="c-actions"><button class="btn ghost" type="button" data-deny>Not now</button><button class="btn ghost" type="button" data-always disabled hidden></button><button class="btn primary" type="button" data-allow disabled>Allow</button></div>`;
  card.querySelector('.c-title')!.textContent = m.title;
  const mono = card.querySelector('.c-mono') as HTMLElement;
  if (m.mono) mono.textContent = m.mono;
  else mono.remove();
  const det = card.querySelector('.c-detail') as HTMLElement;
  if (m.detail) det.textContent = m.detail;
  else det.remove();
  const sub = card.querySelector('.c-sub') as HTMLElement;
  // The model's own words are shown only as a labelled note; the title/mono
  // above are written by the safety gate from the real action (S1).
  if (m.subtitle && m.subtitle !== m.detail) sub.textContent = `Cadabra’s note: ${m.subtitle}`;
  else sub.remove();
  card.querySelector('.c-risk')!.textContent = [m.risk, m.timeoutMs ? `No answer in ${Math.round(m.timeoutMs / 1000)} s means no.` : ''].filter(Boolean).join(' · ');
  const deny = card.querySelector('[data-deny]') as HTMLButtonElement;
  const allow = card.querySelector('[data-allow]') as HTMLButtonElement;
  allow.onclick = () => !allow.disabled && api.resolveConfirm(m.id, true);
  deny.onclick = () => api.resolveConfirm(m.id, false);
  // Round 11: "Always allow clicks in Google Maps".
  const always = card.querySelector('[data-always]') as HTMLButtonElement;
  if (m.alwaysLabel) {
    always.hidden = false;
    always.textContent = m.alwaysLabel;
    always.onclick = () => !always.disabled && api.resolveConfirm(m.id, true, true);
  } else always.remove();
  messages.append(card);
  setEmpty();
  scrollToEnd();
  setStatus('Waiting for your OK…');
  // S10: default focus "Not now", and Allow is disabled briefly so a stray
  // Enter/Space as the card appears can't approve a risky action.
  deny.focus();
  // The delay applies with reduced motion too; only the countdown text is skipped.
  let left = 12;
  allow.textContent = reduced ? 'Allow' : 'Allow (1)';
  const tick = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(tick);
      allow.disabled = false;
      if (m.alwaysLabel) always.disabled = false;
      allow.textContent = 'Allow';
    } else if (!reduced) allow.textContent = `Allow (${Math.ceil(left / 10)})`;
  }, 100);
}

// ---------------------------------------------------------------- picker --

async function openPicker() {
  picker.hidden = false;
  const provs = await api.listProviders();
  let sel = provider?.id ?? 'claude';
  const draw = () => {
    const pBox = $('providers');
    pBox.innerHTML = '';
    for (const p of provs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `prov ${p.id === sel ? 'sel' : ''}`;
      const ok = p.auth?.ok;
      const state = p.auth ? (ok ? p.auth.detail : p.auth.detail) : 'Checking…';
      b.innerHTML = `<div class="p-name"><span class="dot ${p.auth ? (ok ? '' : /install|found|available/i.test(p.auth.detail) ? 'off' : 'warn') : 'off'}"></span><span></span></div><div class="p-state"></div>`;
      b.querySelector('.p-name span:last-child')!.textContent = p.label;
      b.querySelector('.p-state')!.textContent = state;
      b.onclick = () => {
        sel = p.id;
        draw();
      };
      pBox.append(b);
    }
    const mBox = $('models');
    mBox.innerHTML = '';
    const p = provs.find((x) => x.id === sel)!;
    if (p.auth && !p.auth.ok) {
      const help = document.createElement('div');
      help.className = 'auth-help';
      help.textContent = `${p.auth.detail}. ${p.auth.howTo ?? ''}`;
      mBox.append(help);
    }
    const models = p.models.length ? p.models : [{ id: '', label: 'Default model', description: 'Let the backend choose' }];
    for (const m of models) {
      const b = document.createElement('button');
      b.type = 'button';
      const current = p.id === provider?.id && m.id === model;
      b.className = `model ${current ? 'sel' : ''}`;
      b.innerHTML = `<div><div class="m-name"></div><div class="m-desc"></div></div><span class="check">✓</span>`;
      b.querySelector('.m-name')!.textContent = m.label;
      b.querySelector('.m-desc')!.textContent = m.description ?? '';
      b.onclick = async () => {
        await api.setModel(p.id, m.id);
        provider = p;
        model = m.id;
        renderPill();
        picker.hidden = true;
        input.focus();
      };
      mBox.append(b);
    }
  };
  draw();
}

pill.onclick = () => (picker.hidden ? void openPicker() : (picker.hidden = true));
$('picker-close').onclick = () => (picker.hidden = true);
// 0.9.9: "Clear chat history…" asks first (a card from the app), then clears everything.
$('clear-history').onclick = () => void api.clearHistory?.();
$('new-chat').onclick = () => {
  api.newChat();
  resetChat();
};
$('settings-btn').onclick = () => void showSettings();

function resetChat() {
  messages.innerHTML = '';
  turn = null;
  setEmpty();
  setBusy(false);
}

// -------------------------------------------------------------- settings --


// -------------------------------------------------------- shortcut recorder --

function renderCaps(el: HTMLElement, caps: string[]) {
  el.innerHTML = '';
  for (const c of caps) {
    const k = document.createElement('kbd');
    k.className = 'cap';
    k.textContent = c;
    k.setAttribute('aria-label', c === '~' ? 'tilde key' : `${c} key`);
    el.append(k);
  }
}

let stopRecording: (() => void) | null = null;

function setupShortcutRecorder(root: HTMLElement, s: any, autoStart: boolean) {
  const row = root.querySelector<HTMLElement>('#sc-row')!;
  const caps = root.querySelector<HTMLElement>('#sc-caps')!;
  const msg = root.querySelector<HTMLElement>('#sc-msg')!;
  const change = root.querySelector<HTMLButtonElement>('#sc-change')!;
  const reset = root.querySelector<HTMLButtonElement>('#sc-reset')!;
  let current: SummonBinding = s.summon ?? DEFAULT_BINDING;
  const show = (b: SummonBinding, warnings: string[] = validateBinding(b).warnings) => {
    renderCaps(caps, bindingKeycaps(b));
    msg.className = 'sc-msg' + (warnings.length ? ' warn' : '');
    msg.textContent = warnings[0] ?? '';
  };
  show(current);

  const save = async (b: SummonBinding) => {
    const v = validateBinding(b);
    if (!v.ok) {
      msg.className = 'sc-msg err';
      msg.textContent = v.error ?? 'That shortcut cannot be used.';
      renderCaps(caps, bindingKeycaps(b));
      return false;
    }
    const updated = await api.setSettings({ summon: b });
    if (updated?.summon) {
      current = updated.summon;
      s.summon = current;
    } else current = b;
    show(current, v.warnings);
    return true;
  };

  const start = () => {
    stopRecording?.();
    row.classList.add('recording');
    change.textContent = 'Cancel';
    renderCaps(caps, ['Press your shortcut…']);
    msg.className = 'sc-msg';
    msg.textContent = 'Hold Ctrl or Alt and press a key — or click here with a mouse button while holding a modifier. Esc cancels.';
    api.setRecording(true);
    const onKey = async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== 'keydown') return;
      if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        end();
        show(current);
        return;
      }
      const b = bindingFromKeyEvent(e);
      if (!b) {
        const held = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean) as string[];
        renderCaps(caps, [...held, '…']);
        return;
      }
      if (await save(b)) end();
    };
    const onMouse = async (e: MouseEvent) => {
      if (!row.contains(e.target as Node) || (e.target as HTMLElement).closest('button')) return;
      const b = bindingFromMouseEvent(e);
      if (!b) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (await save(b)) end();
    };
    const noMenu = (e: Event) => row.contains(e.target as Node) && e.preventDefault();
    const end = () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('contextmenu', noMenu, true);
      row.classList.remove('recording');
      change.textContent = 'Change';
      api.setRecording(false);
      stopRecording = null;
    };
    stopRecording = end;
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('contextmenu', noMenu, true);
  };

  change.onclick = () => {
    if (stopRecording) {
      stopRecording();
      show(current);
    } else start();
  };
  reset.onclick = async () => {
    stopRecording?.();
    await save({ ...DEFAULT_BINDING });
  };
  if (autoStart) start();
}

/** Natural-voice picker: British voices first, "More voices", Preview, pace, opt-in download. */
async function setupVoicePicker(s: any) {
  const sel = settingsEl.querySelector<HTMLSelectElement>('#s-ttsvoice');
  if (!sel) return;
  const st = await api.ttsStatus?.().catch(() => null);
  // Round 5: grouped by dialect (British / American / Southern cloud voices).
  sel.innerHTML = voiceOptions() + `<option value="windows">Windows voice (no download)</option>`;
  sel.value = s.voice.ttsEngine === 'windows' ? 'windows' : s.voice.ttsVoice;
  const note = settingsEl.querySelector<HTMLElement>('#tts-note')!;
  const prev = settingsEl.querySelector<HTMLButtonElement>('#s-preview')!;
  const prog = settingsEl.querySelector<HTMLElement>('#tts-prog')!;
  const speed = settingsEl.querySelector<HTMLSelectElement>('#s-ttsspeed')!;
  speed.value = String([0.9, 1, 1.05, 1.1].reduce((a, b) => (Math.abs(b - s.voice.ttsSpeed) < Math.abs(a - s.voice.ttsSpeed) ? b : a)));
  const refresh = (installed: boolean, downloading: boolean) => {
    note.textContent = st?.tooSlow
      ? 'This PC was a little slow for the natural voice, so the Windows voice is speaking for now. Cadabra tries again later; press Preview to test it now.'
      : installed
        ? 'Natural voice, runs on this PC.'
        : downloading
          ? 'Downloading the natural voice…'
          : `Natural voices need a one-time ~${st?.sizeMb ?? 350} MB download (includes espeak-ng pronunciation data, GPL-3.0). Until then, the Windows voice speaks.`;
    prev.textContent = installed || sel.value === 'windows' ? 'Preview' : 'Download';
    prev.disabled = downloading;
  };
  refresh(!!st?.installed, !!st?.downloading);
  ttsProgressHook = (pct) => {
    prog.hidden = pct >= 100;
    prog.querySelector<HTMLElement>('.bar span')!.style.width = `${pct}%`;
    prog.querySelector('small')!.textContent = pct >= 100 ? 'Natural voice ready.' : `Downloading the natural voice… ${pct}%`;
  };
  sel.onchange = async () => {
    const updated = await api.setSettings({ voice: { ...s.voice, ...(sel.value === 'windows' ? { ttsEngine: 'windows' } : { ttsEngine: 'kokoro', ttsVoice: sel.value }) } });
    if (updated) Object.assign(s, updated);
  };
  speed.onchange = async () => {
    const updated = await api.setSettings({ voice: { ...s.voice, ttsSpeed: Number(speed.value) } });
    if (updated) Object.assign(s, updated);
  };
  prev.onclick = async () => {
    const now = await api.ttsStatus?.().catch(() => null);
    if (sel.value !== 'windows' && !now?.installed) {
      refresh(false, true);
      prog.hidden = false;
      const r = await api.ttsDownload?.();
      refresh(!!r?.ok, false);
      if (r && !r.ok) note.textContent = `Download failed: ${r.error}`;
      return;
    }
    prev.disabled = true;
    await api.previewVoice?.(sel.value === 'windows' ? 'bm_george' : sel.value, Number(speed.value)).catch(() => undefined);
    prev.disabled = false;
  };
}

let ttsProgressHook: ((pct: number) => void) | null = null;

/** Round 6 (REVIEW-5 #5): which microphone, is it working, why it last restarted. */
async function refreshVoiceStatus() {
  const row = settingsEl.querySelector<HTMLElement>('#s-vstatus');
  if (!row || settingsEl.hidden) return;
  const st = await api.voiceStatus?.().catch(() => null);
  if (!st) {
    row.hidden = true;
    return;
  }
  const problem = st.enabled && !['ok', 'off', 'starting'].includes(st.health);
  row.classList.toggle('problem', problem);
  row.querySelector<HTMLElement>('#vs-text')!.textContent = !st.enabled ? 'Voice is off' : `${problem ? '⚠ ' : '✓ '}${st.text}${st.detail && problem ? ` (${st.detail})` : ''}`;
  row.querySelector<HTMLElement>('#vs-dev')!.textContent = st.device ? `Listening on: ${st.device}` : '';
  const ago = st.lastRestartAt ? Math.max(0, Math.round((Date.now() - st.lastRestartAt) / 60_000)) : null;
  row.querySelector<HTMLElement>('#vs-last')!.textContent = st.lastRestartReason ? `Last restart: ${st.lastRestartReason}${ago != null ? ` (${ago ? `${ago} min ago` : 'just now'})` : ''} · restarts this session: ${st.restarts.mic + st.restarts.engine}` : '';
  // REVIEW-6: a blocked microphone can't be fixed by restarting; open the Windows page instead.
  const blocked = st.health === 'no-mic-access';
  row.querySelector<HTMLButtonElement>('#vs-restart')!.hidden = blocked;
  row.querySelector<HTMLButtonElement>('#vs-restart')!.disabled = !st.enabled;
  row.querySelector<HTMLButtonElement>('#vs-micsettings')!.hidden = !blocked;
  // REVIEW-6 N6-2: a new default mic (e.g. a Bluetooth headset) Cadabra didn't switch to.
  const pend = row.querySelector<HTMLElement>('#vs-pending')!;
  const use = row.querySelector<HTMLButtonElement>('#vs-use')!;
  pend.textContent = st.pendingDefault ? `Default microphone changed to ${st.pendingDefault} (Cadabra kept the current one)` : '';
  use.hidden = !st.pendingDefault;
  use.onclick = async () => {
    await api.useVoiceDevice?.(st.pendingDefault);
    setTimeout(() => void refreshVoiceStatus(), 1500);
  };
  // R9-3: other apps holding the mic count as "a call" (no greetings, lock asks) unless marked.
  const apps = row.querySelector<HTMLElement>('#vs-micapps')!;
  apps.innerHTML = '';
  for (const m of (st.micApps ?? []) as { exe: string; notCall: boolean }[]) {
    const line = document.createElement('small');
    line.className = 'vs-micapp';
    line.textContent = m.notCall ? `${m.exe}: marked “not a call” ` : `Microphone in use by ${m.exe} (counts as a call: no greetings, lock asks first) `;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost';
    b.textContent = m.notCall ? 'Undo' : 'Not a call';
    b.onclick = async () => {
      await api.markMicNotCall?.(m.exe, !m.notCall);
      void refreshVoiceStatus();
    };
    line.append(b);
    apps.append(line);
  }
}

/** Round 7: Settings → Voice → Microphone picker. */
async function setupMicPicker(s: any) {
  const sel = settingsEl.querySelector<HTMLSelectElement>('#s-mic');
  if (!sel) return;
  const d = await api.voiceDevices?.().catch(() => null);
  if (!d) return;
  // REVIEW-7 #10: when Cadabra kept the old mic after Windows switched its
  // default (e.g. to a Bluetooth headset), say so instead of a stale label.
  const st = await api.voiceStatus?.().catch(() => null);
  const kept = !d.chosen && st?.device && d.defaultInput && st.device !== d.defaultInput ? st.device : '';
  const esc = (x: string) => x.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  sel.innerHTML =
    `<option value="">${kept ? `Windows default (now ${esc(d.defaultInput)}) — Cadabra is still on ${esc(kept)}` : `Windows default${d.defaultInput ? ` (${esc(d.defaultInput)})` : ''}`}</option>` +
    d.inputs.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('') +
    (d.chosen && !d.inputs.includes(d.chosen) ? `<option value="${esc(d.chosen)}">${esc(d.chosen)} (not connected)</option>` : '');
  sel.value = d.chosen ?? '';
  sel.onchange = async () => {
    await api.useVoiceDevice?.(sel.value);
    s.voice.inputDevice = sel.value;
    setTimeout(() => void refreshVoiceStatus(), 1500);
  };
}

async function showSettings(focus?: 'shortcut' | 'skills', newSkillName?: string) {
  const data = await api.getSettings();
  const s = data.settings;
  settingsEl.hidden = false;
  picker.hidden = true;
  const toggle = (on: boolean, k: string) => `<button type="button" class="toggle ${on ? 'on' : ''}" role="switch" aria-checked="${on}" data-k="${k}"></button>`;
  const nm = assistantName(s.voice.wakeWord).replace(/[^A-Za-z ]/g, '');
  settingsEl.innerHTML = `
    <div class="s-head">${sparkSvg(16, 'setg')}<span>Settings</span><button class="icon-btn" id="s-close" type="button" title="Back">✕</button></div>
    <div class="s-body">
      <div class="s-group"><h4>Shortcut</h4>
        <div class="s-row sc-row" id="sc-row"><div class="s-label">Summon Cadabra<small>Press it anywhere; press again to close.</small>
          <div class="keycaps" id="sc-caps"></div><div class="sc-msg" id="sc-msg"></div></div>
          <div class="sc-btns"><button type="button" class="btn ghost" id="sc-change">Change</button><button type="button" class="btn ghost" id="sc-reset">Reset to default</button></div></div>
      </div>
      <div class="s-group"><h4>AI accounts</h4>
        <div class="acct-tabs" role="tablist">${['claude', 'codex', 'gemini', 'copilot'].map((id) => `<button type="button" role="tab" class="acct-tab" data-id="${id}">${({ claude: 'Claude', codex: 'OpenAI', gemini: 'Gemini', copilot: 'Copilot' } as Record<string, string>)[id]}</button>`).join('')}</div>
        <div id="s-acct"></div>
        <p class="s-note">Sign-ins happen in each company’s own app or web page; Cadabra never sees those passwords or tokens. Keys you paste are encrypted with Windows (DPAPI)${data.encryption ? '' : ' (unavailable on this PC: keys can’t be saved)'}.</p>
      </div>
      <div class="s-group"><h4>Voice</h4>
        <div class="s-row"><div class="s-label">Voice: wake word “${nm}”<small>Listens locally; nothing leaves your PC until you say it. Then your request goes to your chosen AI (${({ claude: 'Anthropic', codex: 'OpenAI', gemini: 'Google', copilot: 'GitHub', demo: 'nowhere: demo is offline' } as Record<string, string>)[s.provider] ?? s.provider}).</small></div>${toggle(s.voice.enabled, 'voice')}</div>
        <div class="s-row vstatus" id="s-vstatus"><div class="s-label">Voice status<small id="vs-text">Checking…</small><small id="vs-dev"></small><small id="vs-pending"></small><small id="vs-last"></small><div id="vs-micapps"></div></div>
          <div class="sc-btns"><button type="button" class="btn ghost" id="vs-restart">Restart voice</button><button type="button" class="btn ghost" id="vs-micsettings" hidden>Open microphone settings</button><button type="button" class="btn ghost" id="vs-use" hidden>Use it</button></div></div>
        <div class="s-row"><div class="s-label">Microphone<small>Which input Cadabra listens on.</small>
          <select id="s-mic"><option value="">Windows default</option></select></div></div>
        <div class="s-row"><div class="s-label">Assistant name<small>Also the wake word. The app stays “Cadabra OS”.</small><div id="s-namepick"></div>
          <div class="sc-btns"><button type="button" class="btn ghost" id="s-waketest">Test: say “${nm}, hello”</button></div></div></div>
        <details class="s-row persona-details"><summary class="s-label">Choose your assistant<small>A name and a voice: British, American or Southern; female or male.</small></summary><div id="s-personas"></div></details>
        <div class="s-row"><div class="s-label">Speak replies<small>Short spoken answers in the voice below.</small>
          <select id="s-speak"><option value="voice">When I use voice</option><option value="always">Always</option><option value="never">Never</option></select></div></div>
        <div class="s-row"><div class="s-label">Follow-up listening<small>After answering out loud, listen briefly without needing “${nm}”.</small>
          <select id="s-follow"><option value="0">Off</option><option value="5">5 seconds</option><option value="8">8 seconds</option><option value="12">12 seconds</option></select></div></div>
        <div class="s-row"><div class="s-label">Push-to-talk only<small>Ignore the wake word; hold Ctrl + Win and speak.</small></div>${toggle(s.voice.pushToTalk, 'ptt')}</div>
        <div class="s-row"><div class="s-label">Wake-word sensitivity
          <select id="s-sens"><option value="0.25">Low — fewer false wakes</option><option value="0.5">Medium</option><option value="0.8">High — wakes more easily</option></select></div></div>
        <div class="s-row tts-row"><div class="s-label">Voice<small id="tts-note">Natural voices run on this PC.</small>
          <div class="tts-pick"><select id="s-ttsvoice"></select><button type="button" class="btn ghost" id="s-preview">Preview</button></div>
          <div class="ob-progress" id="tts-prog" hidden><div class="bar"><span></span></div><small></small></div></div></div>
        <div class="s-row"><div class="s-label">Pace
          <select id="s-ttsspeed"><option value="0.9">Unhurried</option><option value="1">Measured</option><option value="1.05">Natural</option><option value="1.1">Brisk</option></select></div></div>
        <div class="s-row"><div class="s-label">Dialect phrasing<small>Now and then a light regional touch (“Cheers”, “Howdy”), never in code or errors.</small></div>${toggle(!!s.voice.phrasing, 'phrasing')}</div>
        <div class="s-row"><div class="s-label">Quicker spoken replies<small>Voice questions use your AI’s fast model.</small></div>${toggle(s.voice.fastModelForVoice !== false, 'fastvoice')}</div>
        <div class="s-row"><div class="s-label">Southern cloud voices<small>The text of each spoken reply is sent to OpenAI to make the audio (your own key, about $0.015 per minute; AI-generated voice). Off: the American voice speaks instead, on this PC.</small></div>${toggle(!!s.voice.cloudVoice, 'cloud')}</div>
        <p class="s-note">Downloads (once, on first use): speech recognition ~100 MB; the natural voice ~350 MB, which includes espeak-ng pronunciation data (GPL-3.0).</p>
      </div>
      <div class="s-group"><h4>Web &amp; weather</h4>
        <div class="s-row"><div class="s-label">Web access<small>Lets your AI search and read web pages (read-only) for news, sports and other current information. Searches go through your chosen AI${s.provider === 'claude' ? ' (with Claude, each page it reads also sends its domain to Anthropic for Claude Code’s own safety check)' : ''} (${({ claude: 'Anthropic', codex: 'OpenAI', gemini: 'Google', copilot: 'GitHub', demo: 'nowhere: demo is offline' } as Record<string, string>)[s.provider] ?? s.provider})${s.provider === 'claude' && s.claudeRoute !== 'claude-code' && s.claudeApiWeb === false ? '. <b>Note:</b> web search with your Claude API key is off below, so Claude can’t search the web right now (weather still works)' : ''}. Cadabra blocks codes, card numbers and keys from your screen, asks before sending other text copied from it, never opens addresses on your PC or home network, and asks before opening a page that didn’t come from you or the search. It can’t spot reworded screen text in a search.${s.provider === 'codex' ? ' With Codex, searches are checked as they happen (the request is stopped if needed), not before they’re sent.' : ''}</small></div>${toggle(s.webAccess !== false, 'web')}</div>
        <div class="s-row"><div class="s-label">Web search with your Claude API key<small>For Claude with an API key (also Amazon Bedrock or Google Vertex AI). Lets Claude search and read the web; Cadabra checks every search first. Web searches through the API are billed by Anthropic per search, on top of normal use. Each page Claude reads also sends its domain (only the domain) to Anthropic for Claude Code’s own safety check. The Claude subscription, Codex, Gemini and Copilot don’t need this.</small></div>${toggle(s.claudeApiWeb !== false, 'claudeweb')}</div>
        <div class="s-row"><div class="s-label">Your location<small>A city for weather (“What’s the weather?”). Weather comes from Open-Meteo; only the city name and its coordinates are sent. Never guessed from your IP address.</small>
          <input id="s-location" type="text" maxlength="80" placeholder="e.g. Seattle, Washington" /></div></div>
      </div>
      <div class="s-group"><h4>WhatsApp</h4><div id="s-wa"></div></div>
      <div class="s-group"><h4>Email</h4><div id="s-email"></div></div>
      <div class="s-group" id="s-privacy-group"><h4>Privacy</h4>
        <div class="s-row"><div class="s-label">Keep chat history<small>Your conversations are mostly kept in memory anyway; this also covers the AI session files ${nm} keeps on this PC.</small>
          <select id="s-keep-history"><option value="until-cleared">Until I clear it</option><option value="on-close">Clear when ${nm} closes</option><option value="idle-1h">Clear after 1 hour of inactivity</option></select></div></div>
        <div class="s-row"><div class="s-label">Show ${nm} in screen recordings and screen sharing<small>Off by default: ${nm}’s panel, cursor and cards stay out of recordings, screenshots and shared screens (Teams, Zoom, OBS, Game Bar, the Snipping Tool), so your chats never show on a screen you share. Turn it on to record a demo or present ${nm}: then anyone watching your shared screen or recording can read the panel, including your chat. ${nm}’s own screenshots (for the AI and for WhatsApp) still leave ${nm} out. Also in the tray menu as <i>Presenting mode</i>.</small></div>${toggle(s.privacy?.showInRecordings === true, 'recordings')}</div>
        <div class="s-row"><div class="s-label">Clear chat history<small>Removes your conversations from ${nm} on this PC (both the panel and WhatsApp), ends the AI sessions so they start fresh, and deletes ${nm}’s own session and temp files. Keeps your settings, skills, keys and WhatsApp pairing. It can’t remove copies elsewhere: the chat on your phone (delete it in WhatsApp; Meta keeps agent messages up to 30 days) or what your AI provider keeps under its own policy. GitHub Copilot keeps its sessions in your own ~/.copilot folder, which ${nm} doesn’t clear.</small></div><button type="button" class="btn ghost" id="s-clear-history">Clear…</button></div>
      </div>
      <div class="s-group" id="s-ann-group"><h4>Announcements</h4>
        <p class="s-note">Say “${nm}, make an announcement: dinner is ready”, or send <b>Announcement: …</b> from WhatsApp, and the PC says it out loud, word for word. It works while the PC is locked and even when spoken replies are off. Esc stops it.</p>
        <div class="s-row"><div class="s-label">Chime first<small>A short, soft chime before the announcement.</small></div>${toggle(s.announcements?.chime !== false, 'ann-chime')}</div>
        <div class="s-row"><div class="s-label">Say it<small>How many times each announcement is spoken.</small></div>
          <select id="s-ann-repeat"><option value="1">Once</option><option value="2">Twice</option><option value="3">Three times</option></select></div>
        <div class="s-row"><div class="s-label">Play announcements on<small>Pick a speaker system, or the PC’s normal output. (Needs the natural voice; the Windows voice always uses the normal output.)</small>
          <select id="s-ann-device"><option value="">The PC’s normal sound output</option></select></div></div>
        <div class="s-row"><div class="s-label">Louder announcements<small>A volume boost for the natural voice.</small></div>${toggle(!!s.announcements?.boost, 'ann-boost')}</div>
        <div class="s-row"><div class="s-label">Lower other sounds while announcing<small>Music and videos go quiet for the announcement, then come back.</small></div>${toggle(s.announcements?.duck !== false, 'ann-duck')}</div>
        <div class="s-row"><div class="s-label">Respect quiet hours<small>Don’t announce during the quiet hours set under Greetings.</small></div>${toggle(!!s.announcements?.respectQuietHours, 'ann-quiet')}</div>
        <div class="sk-actions"><button type="button" class="btn ghost" id="s-ann-test">Test announcement</button><span class="sk-msg" id="s-ann-msg" aria-live="polite"></span></div>
      </div>
      <div class="s-group" id="s-skills-group"><h4>Skills</h4><div id="s-skills"></div></div>
      <div class="s-group"><h4>Greetings</h4>
        <div class="s-row"><div class="s-label">Greetings<small>A short spoken hello when you sign in, unlock, or come back (voice only, no window). Never during a call, a full-screen game or presentation, Focus / Do not disturb, muted speakers or quiet hours. Say “stop greeting me” to turn off.</small></div>${toggle(s.greetings?.enabled !== false, 'greet')}</div>
        <div class="s-row"><div class="s-label">Greet after away for
          <select id="s-greetaway"><option value="10">10 minutes</option><option value="20">20 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option></select></div></div>
        <div class="s-row"><div class="s-label">Quiet hours<small>No greetings between these times (leave empty for none).</small>
          <div class="sc-btns"><input id="s-quiet1" type="time" /> <span>to</span> <input id="s-quiet2" type="time" /></div></div></div>
      </div>
      <div class="s-group"><h4>Behavior</h4>
        <div class="s-row"><div class="s-label">Your name<small>How Cadabra greets you (from your Windows account).</small>
          <input id="s-name" type="text" maxlength="40" placeholder="Your first name" /></div></div>
        <div class="s-row"><div class="s-label">Launch at login</div>${toggle(s.launchAtLogin, 'login')}</div>
        <div class="s-row"><div class="s-label">Pause Cadabra<small>Ignore the summon shortcut and the wake word.</small></div>${toggle(s.paused, 'paused')}</div>

        <div class="s-row"><div class="s-label">Motion
          <select id="s-motion"><option value="system">Follow Windows</option><option value="full">Full</option><option value="reduced">Reduced</option></select></div></div>
      </div>
      <div class="s-group"><h4>Safety</h4>
        <div class="s-row"><div class="s-label">When I act on your screen<small id="s-auto-blurb"></small>
          <select id="s-autonomy">${AUTONOMY_OPTIONS.map((o) => `<option value="${o.id}">${o.label}</option>`).join('')}</select></div></div>
        <div class="s-row perm-row"><div class="s-label">Permissions<small>Places where you chose “Always allow” on a card.</small><div id="s-perms"></div></div></div>
        <p class="s-note">${s.safety.denylist.length} protected-app rules (password managers blocked; banking, trading and checkout need your OK). Up to ${s.safety.maxActionsPerRun} actions per request. <kbd>Esc</kbd> stops everything.</p>
      </div>
      <p class="s-note" style="margin-top:14px">Cadabra OS ${data.version}</p>
    </div>`;
  const rows = settingsEl.querySelectorAll<HTMLButtonElement>('.toggle');
  const keys: Record<string, (v: boolean) => any> = {
    voice: (v) => ({ voice: { ...s.voice, enabled: v } }),
    ptt: (v) => ({ voice: { ...s.voice, pushToTalk: v } }),
    phrasing: (v) => ({ voice: { ...s.voice, phrasing: v } }),
    fastvoice: (v) => ({ voice: { ...s.voice, fastModelForVoice: v } }),
    cloud: (v) => ({ voice: { ...s.voice, cloudVoice: v } }),
    web: (v) => ({ webAccess: v }),
    claudeweb: (v) => ({ claudeApiWeb: v }),
    'ann-chime': (v) => ({ announcements: { ...s.announcements, chime: v } }),
    'ann-boost': (v) => ({ announcements: { ...s.announcements, boost: v } }),
    'ann-duck': (v) => ({ announcements: { ...s.announcements, duck: v } }),
    'ann-quiet': (v) => ({ announcements: { ...s.announcements, respectQuietHours: v } }),
    greet: (v) => ({ greetings: { ...s.greetings, enabled: v } }),
    login: (v) => ({ launchAtLogin: v }),
    paused: (v) => ({ paused: v }),
    recordings: (v) => ({ privacy: { ...s.privacy, showInRecordings: v } }),
  };
  rows.forEach((t) => {
    const k = t.dataset.k;
    if (!k || !keys[k]) return;
    t.onclick = async () => {
      const on = !t.classList.contains('on');
      t.classList.toggle('on', on);
      t.setAttribute('aria-checked', String(on));
      const updated = await api.setSettings(keys[k](on));
      if (updated) Object.assign(s, updated);
    };
  });
  const speak = settingsEl.querySelector<HTMLSelectElement>('#s-speak')!;
  speak.value = s.voice.speakReplies;
  speak.onchange = async () => {
    const updated = await api.setSettings({ voice: { ...s.voice, speakReplies: speak.value } });
    if (updated) Object.assign(s, updated);
  };
  const follow = settingsEl.querySelector<HTMLSelectElement>('#s-follow')!;
  follow.value = String([0, 5, 8, 12].reduce((a, b) => (Math.abs(b - s.voice.followUpSeconds) < Math.abs(a - s.voice.followUpSeconds) ? b : a)));
  follow.onchange = async () => {
    const updated = await api.setSettings({ voice: { ...s.voice, followUpSeconds: Number(follow.value) } });
    if (updated) Object.assign(s, updated);
  };
  const nameIn = settingsEl.querySelector<HTMLInputElement>('#s-name')!;
  nameIn.value = s.displayName ?? '';
  nameIn.onchange = () => void api.setSettings({ displayName: nameIn.value.trim() });
  const locIn = settingsEl.querySelector<HTMLInputElement>('#s-location')!;
  locIn.value = s.location ?? '';
  locIn.onchange = () => void api.setSettings({ location: locIn.value.trim() });
  void renderEmailSettings(settingsEl.querySelector<HTMLDivElement>('#s-email')!, s.provider);
  // 0.9.9: privacy.
  const keepSel = settingsEl.querySelector<HTMLSelectElement>('#s-keep-history')!;
  keepSel.value = s.privacy?.keepHistory ?? 'until-cleared';
  keepSel.onchange = async () => {
    const u = await api.setSettings({ privacy: { keepHistory: keepSel.value } });
    if (u) Object.assign(s, u);
  };
  settingsEl.querySelector<HTMLButtonElement>('#s-clear-history')!.onclick = () => {
    settingsEl.hidden = true; // the confirm card shows in the chat view
    void api.clearHistory?.();
  };
  // 0.9.6: announcements.
  const annRep = settingsEl.querySelector<HTMLSelectElement>('#s-ann-repeat')!;
  annRep.value = String(s.announcements?.repeat ?? 1);
  annRep.onchange = async () => {
    const u = await api.setSettings({ announcements: { ...s.announcements, repeat: Number(annRep.value) } });
    if (u) Object.assign(s, u);
  };
  const annDev = settingsEl.querySelector<HTMLSelectElement>('#s-ann-device')!;
  void api.announceOutputs?.().then((outs) => {
    const cur = s.announcements?.device ?? '';
    for (const o of new Set([...(outs ?? []), ...(cur ? [cur] : [])])) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = (outs ?? []).includes(o) ? o : `${o} (not connected)`;
      annDev.append(opt);
    }
    annDev.value = cur;
  });
  annDev.onchange = async () => {
    const u = await api.setSettings({ announcements: { ...s.announcements, device: annDev.value } });
    if (u) Object.assign(s, u);
  };
  settingsEl.querySelector<HTMLButtonElement>('#s-ann-test')!.onclick = async () => {
    const m = settingsEl.querySelector<HTMLElement>('#s-ann-msg')!;
    m.textContent = 'Announcing…';
    const r = await api.announceTest?.();
    m.textContent = r?.ok ? 'Done.' : (r?.reason ?? 'Couldn’t announce.');
  };
  void renderSkills(settingsEl.querySelector<HTMLDivElement>('#s-skills')!, newSkillName).then(() => {
    if (focus === 'skills') settingsEl.querySelector('#s-skills-group')?.scrollIntoView({ block: 'start' });
  });
  void renderWhatsApp(settingsEl.querySelector<HTMLDivElement>('#s-wa')!, s.provider, '', assistantName(s.voice.wakeWord).replace(/[^A-Za-z ]/g, ''));
  const gAway = settingsEl.querySelector<HTMLSelectElement>('#s-greetaway')!;
  gAway.value = String([10, 20, 30, 60].reduce((a, b) => (Math.abs(b - (s.greetings?.awayMinutes ?? 20)) < Math.abs(a - (s.greetings?.awayMinutes ?? 20)) ? b : a)));
  gAway.onchange = async () => {
    const updated = await api.setSettings({ greetings: { ...s.greetings, awayMinutes: Number(gAway.value) } });
    if (updated) Object.assign(s, updated);
  };
  const q1 = settingsEl.querySelector<HTMLInputElement>('#s-quiet1')!;
  const q2 = settingsEl.querySelector<HTMLInputElement>('#s-quiet2')!;
  q1.value = s.greetings?.quietStart ?? '';
  q2.value = s.greetings?.quietEnd ?? '';
  const saveQuiet = async () => {
    const updated = await api.setSettings({ greetings: { ...s.greetings, quietStart: q1.value, quietEnd: q2.value } });
    if (updated) Object.assign(s, updated);
  };
  q1.onchange = () => void saveQuiet();
  q2.onchange = () => void saveQuiet();
  // Round 11: autonomy level and "Always allow" grants.
  const auto = settingsEl.querySelector<HTMLSelectElement>('#s-autonomy')!;
  const autoBlurb = settingsEl.querySelector<HTMLElement>('#s-auto-blurb')!;
  auto.value = s.safety.autonomy ?? (s.safety.confirmAllActions ? 'every' : 'risky');
  const showBlurb = () => (autoBlurb.textContent = AUTONOMY_OPTIONS.find((o) => o.id === auto.value)?.blurb ?? '');
  showBlurb();
  auto.onchange = async () => {
    showBlurb();
    const updated = await api.setSettings({ safety: { autonomy: auto.value, confirmAllActions: auto.value === 'every' } });
    if (updated) Object.assign(s, updated);
  };
  void renderPerms(settingsEl.querySelector<HTMLElement>('#s-perms')!);
  const sens = settingsEl.querySelector<HTMLSelectElement>('#s-sens')!;
  sens.value = s.voice.sensitivity < 0.38 ? '0.25' : s.voice.sensitivity > 0.65 ? '0.8' : '0.5';
  sens.onchange = async () => {
    const updated = await api.setSettings({ voice: { ...s.voice, sensitivity: Number(sens.value) } });
    if (updated) Object.assign(s, updated);
  };
  void setupVoicePicker(s);
  void refreshVoiceStatus();
  void setupMicPicker(s);
  settingsEl.querySelector<HTMLButtonElement>('#vs-micsettings')!.onclick = () => api.openMicSettings();
  settingsEl.querySelector<HTMLButtonElement>('#vs-restart')!.onclick = async () => {
    const b = settingsEl.querySelector<HTMLButtonElement>('#vs-restart')!;
    b.disabled = true;
    b.textContent = 'Restarting…';
    await api.restartVoice?.().catch(() => undefined);
    setTimeout(() => {
      b.disabled = false;
      b.textContent = 'Restart voice';
      void refreshVoiceStatus();
    }, 1500);
  };
  // Round 5: name (= wake word) and persona cards.
  const namePick = settingsEl.querySelector<HTMLElement>('#s-namepick')!;
  renderNamePicker(namePick, s, api as any, (n) => Object.assign(s, n));
  const personaBox = settingsEl.querySelector<HTMLElement>('#s-personas')!;
  settingsEl.querySelector<HTMLDetailsElement>('.persona-details')!.ontoggle = (e) => {
    if ((e.target as HTMLDetailsElement).open && !personaBox.childElementCount)
      void renderPersonaCards(personaBox, s, api as any, (n) => {
        Object.assign(s, n);
        renderNamePicker(namePick, s, api as any, (x) => Object.assign(s, x));
      });
  };
  const wakeTest = settingsEl.querySelector<HTMLButtonElement>('#s-waketest')!;
  wakeTest.onclick = async () => {
    const name = assistantName(s.voice.wakeWord);
    if (!s.voice.enabled) {
      addNotice('Turn voice on first.', 'info');
      return;
    }
    wakeTest.disabled = true;
    wakeTest.textContent = `Listening… say “${name}, hello”`;
    const ok = await waitForWake(10_000);
    wakeTest.disabled = false;
    wakeTest.textContent = ok ? `Heard “${name}” ✓ (test again)` : `Didn’t hear it. Try again, or raise the sensitivity`;
  };
  const motion = settingsEl.querySelector<HTMLSelectElement>('#s-motion')!;
  motion.value = s.motion;
  motion.onchange = () => void api.setSettings({ motion: motion.value });
  const acctEl = settingsEl.querySelector<HTMLElement>('#s-acct')!;
  const tabs = settingsEl.querySelectorAll<HTMLButtonElement>('.acct-tab');
  const pick = (id: string) => {
    tabs.forEach((t) => {
      t.classList.toggle('on', t.dataset.id === id);
      t.setAttribute('aria-selected', String(t.dataset.id === id));
    });
    return renderAccount(acctEl, api, id, () => (provider = null));
  };
  tabs.forEach(
    (t) =>
      (t.onclick = () => {
        void pick(t.dataset.id!).then(() => acctEl.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' }));
      }),
  );
  pick(['claude', 'codex', 'gemini', 'copilot'].includes(s.provider) ? s.provider : 'claude');
  setupShortcutRecorder(settingsEl, s, focus === 'shortcut');
  settingsEl.querySelector<HTMLButtonElement>('#s-close')!.onclick = () => {
    stopRecording?.();
    settingsEl.hidden = true;
    input.focus();
  };
}


// ------------------------------------------------------------------ apps --

const SOURCE_LABEL: Record<string, string> = {
  startmenu: 'Start menu',
  desktop: 'Desktop',
  store: 'Microsoft Store',
  steam: 'Steam',
  epic: 'Epic Games',
  gog: 'GOG',
  apppaths: 'Installed app',
};

function appIcon(name: string, icon?: string): HTMLElement {
  if (icon) {
    const img = document.createElement('img');
    img.className = 'app-ico';
    img.src = icon;
    img.alt = '';
    return img;
  }
  const s = document.createElement('span');
  s.className = 'app-ico letter';
  s.textContent = (name.trim()[0] ?? '?').toUpperCase();
  return s;
}

function addAppChoices(m: { query: string; choices: { id: string; name: string; source: string; icon?: string }[] }) {
  const card = document.createElement('div');
  card.className = 'msg apps';
  const k = document.createElement('div');
  k.className = 'c-kicker';
  k.textContent = `Which “${m.query}”?`;
  card.append(k);
  for (const c of m.choices) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'app-choice';
    const label = document.createElement('div');
    label.innerHTML = '<div class="a-name"></div><div class="a-src"></div>';
    label.querySelector('.a-name')!.textContent = c.name;
    label.querySelector('.a-src')!.textContent = SOURCE_LABEL[c.source] ?? c.source;
    b.append(appIcon(c.name, c.icon), label);
    b.onclick = () => {
      card.classList.add('done');
      api.launchApp(c.id);
    };
    card.append(b);
  }
  messages.append(card);
  setEmpty();
  scrollToEnd();
  setBusy(false);
}

const launchChips = new Map<string, HTMLElement>();
function showLaunch(m: { name: string; icon?: string; status: string; detail?: string }) {
  let chip = launchChips.get(m.name);
  if (!chip || m.status === 'opening') {
    chip = document.createElement('div');
    chip.className = 'msg launch';
    chip.append(appIcon(m.name, m.icon));
    const t = document.createElement('span');
    t.className = 'l-text';
    chip.append(t);
    const spark = document.createElement('i');
    spark.className = 'l-spark';
    chip.append(spark);
    messages.append(chip);
    launchChips.set(m.name, chip);
    setEmpty();
  }
  chip.dataset.status = m.status;
  const label = { opening: `Opening ${m.name}…`, opened: `${m.name} is open`, focused: `Switched to ${m.name}`, error: `Couldn't open ${m.name}` }[m.status] ?? m.name;
  chip.querySelector('.l-text')!.textContent = label;
  if (m.detail) chip.title = m.detail;
  scrollToEnd();
}

// ----------------------------------------------------------------- voice --

function drawWave() {
  const ctx = wave.getContext('2d')!;
  const w = wave.width;
  const h = wave.height;
  let t0 = performance.now();
  let level = 0;
  const frame = (now: number) => {
    if (voiceState !== 'listening' && voiceState !== 'transcribing' && voiceState !== 'followup') {
      ctx.clearRect(0, 0, w, h);
      return;
    }
    const t = (now - t0) / 1000;
    level += (Math.max(voiceLevel, 0.12) - level) * 0.18;
    ctx.clearRect(0, 0, w, h);
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(255,210,122,0)');
    grad.addColorStop(0.2, 'rgba(255,210,122,0.9)');
    grad.addColorStop(0.8, 'rgba(180,160,255,0.85)');
    grad.addColorStop(1, 'rgba(180,160,255,0)');
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      for (let x = 0; x <= w; x += 3) {
        const env = Math.sin((Math.PI * x) / w);
        const y = h / 2 + Math.sin(x / (18 + k * 7) + t * (3.2 + k)) * env * level * (h * 0.42) * (1 - k * 0.28);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = grad;
      ctx.globalAlpha = 1 - k * 0.3;
      ctx.lineWidth = k === 0 ? 2 : 1.2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (!reduced) requestAnimationFrame(frame);
  };
  t0 = performance.now();
  requestAnimationFrame(frame);
}

function setVoice(state: VoiceState, level?: number, partial?: string) {
  const wasActive = voiceState === 'listening' || voiceState === 'transcribing' || voiceState === 'followup';
  voiceState = state;
  if (level != null) voiceLevel = level;
  const active = state === 'listening' || state === 'transcribing' || state === 'followup';
  root.classList.toggle('voice-on', active);
  if (partial) setStatus(`Listening… ${partial}`);
  else if (active && !busy) setStatus(state === 'followup' ? `Listening… (no need to say “${assistantLabel}”)` : 'Listening…');
  else if (!active && !busy) setStatus(null);
  if (!active) input.placeholder = placeholderFor();
  if (active && !wasActive) drawWave();
}

let currentTarget: { title: string; process: string } | null = null;
function placeholderFor() {
  return currentTarget ? 'Ask about this window, or tell me what to do…' : 'Ask me anything about your screen…';
}

// ------------------------------------------------------------ messages in --

function submit(text: string) {
  text = text.trim();
  if (!text || busy) return;
  addUser(text);
  input.value = '';
  autosize();
  setBusy(true);
  setStatus('Looking…');
  api.send(text);
}

api.onMessage((m: PanelMessage | any) => {
  switch (m.type) {
    case 'summon': {
      reduced = m.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
      document.documentElement.classList.toggle('reduced', reduced);
      root.style.setProperty('--ox', `${m.origin.x}px`);
      root.style.setProperty('--oy', `${m.origin.y}px`);
      if (m.fresh) resetChat();
      applyStatus({ type: 'summon' });
      if (m.assistant) {
        assistantLabel = m.assistant;
        const bn = document.querySelector<HTMLElement>('.brand-name');
        if (bn) bn.textContent = m.assistant;
      }
      settingsEl.hidden = true;
      picker.hidden = true;
      provider = m.provider;
      model = m.model;
      renderPill();
      renderSetup();
      currentTarget = m.target;
      targetEl.classList.toggle('warn', !!m.elevated);
      targetText.textContent = m.target
        ? `${m.elevated ? 'Admin window — view only · ' : ''}${m.target.title || m.target.process}`
        : 'Looking at your whole screen';
      input.placeholder = placeholderFor();
      // Restart the entrance animation from the click point.
      root.classList.remove('in', 'out');
      void root.offsetWidth;
      root.classList.add('in');
      if (onboardingOpen()) break;
      if (m.voicePrompt) {
        addUser(m.voicePrompt, 'voice');
        setBusy(true);
        setStatus('Looking…');
      }
      setTimeout(() => input.focus(), 30);
      break;
    }
    case 'dismiss':
      root.classList.remove('in');
      root.classList.add('out');
      picker.hidden = true;
      break;
    case 'event':
      onEvent(m.event);
      break;
    case 'busy':
      setBusy(m.busy, m.run);
      break;
    case 'status':
      applyStatus({ type: 'status', text: m.text, run: m.run });
      break;
    case 'confirm':
      addConfirm(m);
      break;
    case 'confirm-resolved': {
      const card = messages.querySelector<HTMLElement>(`.confirm[data-id="${CSS.escape(m.id)}"]`);
      if (card) {
        card.classList.add('done');
        card.querySelector('.c-kicker')!.textContent = m.allowed ? 'Allowed' : 'Declined';
      }
      if (busy) setStatus(m.allowed ? 'On it' : 'Okay, stopping');
      break;
    }
    case 'model':
      provider = m.provider;
      model = m.model;
      renderPill();
      renderSetup();
      break;
    case 'voice':
      setVoice(m.state, m.level, m.partial);
      onboardingVoiceState(m.state);
      personaVoiceState(m.state);
      break;
    case 'prefill':
      // Keystrokes typed while the panel was opening (held by the helper).
      if (!busy && !onboardingOpen()) {
        input.value = (input.value + m.text).slice(0, 4000);
        autosize();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        // KB-1: an Enter typed during the summon submits here, never in the app underneath.
        if (m.submit && input.value.trim()) submit(input.value);
      }
      break;
    case 'acting':
      applyStatus({ type: 'acting', on: m.on, caption: m.caption, run: m.run });
      break;
    case '__acting':
      root.classList.toggle('acting', m.on);
      $('hud-text').textContent = m.caption || 'Working…';
      break;
    case 'tts-progress':
      ttsProgressHook?.(m.pct);
      onboardingTtsProgress(m.pct);
      break;
    case 'voice-progress':
      onboardingVoiceProgress(m.pct);
      break;
    case 'account-status':
      showAccountStatus(root, m.provider, m.text);
      break;
    case 'onboarding':
    case '__onboarding':
      settingsEl.hidden = true;
      picker.hidden = true;
      void startOnboarding(root, api, { step: m.step, onDone: () => input.focus() }).then(() => {
        if (m.type === '__onboarding' && m.name !== undefined) {
          const n = root.querySelector<HTMLInputElement>('#ob-name');
          if (n) {
            n.value = m.name;
            n.dispatchEvent(new Event('input'));
          }
        }
        if (m.type === '__onboarding' && m.backend) root.querySelector<HTMLButtonElement>(`.ob-backend[data-id="${m.backend}"]`)?.click();
        if (m.type === '__onboarding' && typeof m.pct === 'number') setTimeout(() => onboardingVoiceProgress(m.pct), 50);
      });
      break;
    case 'notice':
      addNotice(m.text, m.tone);
      break;
    case '__voiceStatus':
      demoVoiceStatus = { ...demoVoiceStatus, ...m.status };
      void refreshVoiceStatus();
      if (m.notice) addNotice(m.notice, 'warn');
      break;
    case 'voice-health':
      void refreshVoiceStatus();
      // Round 4.5: voice is on but not hearing the mic; say so (once per change).
      if (m.problem && m.text !== lastVoiceProblem) addNotice(`${/[.!?…)]$/.test(m.text) ? m.text : `${m.text}.`} ${m.state === 'no-mic-access' ? 'Settings → Voice → Open microphone settings to allow it.' : 'Tray → Restart voice if it doesn’t recover.'}`, 'warn');
      lastVoiceProblem = m.problem ? m.text : '';
      break;
    case 'skills-changed': {
      const box = settingsEl.hidden ? null : settingsEl.querySelector<HTMLDivElement>('#s-skills');
      if (box && !box.querySelector('.sk-new input:focus')) void renderSkills(box);
      break;
    }
    case 'view':
      if (m.view === 'settings') void showSettings(m.focus, m.newSkill);
      else settingsEl.hidden = true;
      break;
    case 'user-echo':
      if (!messages.lastElementChild?.classList.contains('user') || messages.lastElementChild.textContent?.endsWith(m.text) === false) addUser(m.text, m.via);
      setBusy(true);
      setStatus('Looking…');
      break;
    case 'reset':
      resetChat();
      break;
    case 'recording-visible':
      $('rec-badge').hidden = !m.on;
      break;
    case 'apps':
      addAppChoices(m);
      break;
    case 'focus':
      root.classList.toggle('inactive', !m.focused);
      break;
    case 'launch':
      showLaunch(m);
      break;
    case '__freeze':
      freezeCssAfter(m.after ?? 0);
      break;
    case '__picker':
      void openPicker();
      break;
    case '__settings':
      void showSettings(m.focus);
      break;
    case '__scroll':
      root.querySelector<HTMLElement>(m.selector)?.scrollIntoView({ block: 'center' });
      break;
    case '__click':
      root.querySelector<HTMLElement>(m.selector)?.click();
      break;
    case '__account-status':
      showAccountStatus(root, m.provider, m.text);
      break;
    case '__account-tab':
      settingsEl.querySelector<HTMLButtonElement>(`.acct-tab[data-id="${m.id}"]`)?.click();
      break;
    case '__type':
      input.value = m.text;
      autosize();
      break;
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) api.cancel();
  else submit(input.value);
});
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!busy) submit(input.value);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!picker.hidden) picker.hidden = true;
    else if (!settingsEl.hidden) settingsEl.hidden = true;
    else api.dismiss();
  }
});
messages.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a[data-ext]') as HTMLAnchorElement | null;
  if (a) {
    e.preventDefault();
    api.openExternal(a.href);
  }
});

setEmpty();
api.ready();
$('hud-stop').addEventListener('click', () => api.cancel());

// ---- Round 8: Settings → Email (read-only Gmail, two ways to connect) ----
const PROVIDER_COMPANY: Record<string, string> = { claude: 'Anthropic', codex: 'OpenAI', gemini: 'Google', copilot: 'GitHub', demo: 'nowhere: demo is offline' };

async function renderEmailSettings(box: HTMLDivElement, provider: string, notice = ''): Promise<void> {
  const st = (await api.emailStatus?.().catch(() => null)) ?? null;
  if (!st) {
    box.innerHTML = '<p class="s-note">Email isn’t available in this build.</p>';
    return;
  }
  const company = PROVIDER_COMPANY[provider] ?? provider;
  const disclosure = `When you ask about email, the sender, subject, time and a short preview of the matching messages go to your chosen AI (${company}). The full text goes only when you ask Cadabra to read or summarize one${st.allowBodies ? '' : ' (turned off below)'}. Read-only: Cadabra can’t send, delete or change mail. Email text is treated as untrusted: its links are removed and nothing in an email can make Cadabra act without asking you.`;
  if (st.connected) {
    box.innerHTML = `
      <div class="s-row"><div class="s-label">Gmail: connected<small class="em-addr"></small><small>${st.mode === 'gmail-oauth' ? 'Your own Google key (read-only access).' : 'App password (this gives full mailbox access; Cadabra only reads).'}</small></div>
        <div class="sc-btns"><button type="button" class="btn ghost" id="em-disc">Disconnect</button></div></div>
      <div class="s-row"><div class="s-label">Send full email text when I ask<small>Off: Cadabra answers from the sender, subject and preview only.</small></div><button type="button" class="toggle${st.allowBodies ? ' on' : ''}" id="em-bodies" role="switch" aria-checked="${st.allowBodies}"></button></div>
      <p class="s-note">${disclosure}</p>
      ${notice ? `<p class="s-note em-msg">${notice}</p>` : ''}`;
    box.querySelector<HTMLElement>('.em-addr')!.textContent = st.address;
    box.querySelector<HTMLButtonElement>('#em-disc')!.onclick = async () => {
      const r = await api.emailDisconnect?.();
      const msg = r?.wasImap
        ? 'Disconnected. Also delete the app password at myaccount.google.com/apppasswords.'
        : r?.revoked
          ? 'Disconnected, and Cadabra’s access was removed at Google.'
          : 'Disconnected. To be sure, remove Cadabra at myaccount.google.com/permissions.';
      void renderEmailSettings(box, provider, msg);
    };
    const tb = box.querySelector<HTMLButtonElement>('#em-bodies')!;
    tb.onclick = async () => {
      const on = !tb.classList.contains('on');
      tb.classList.toggle('on', on);
      tb.setAttribute('aria-checked', String(on));
      await api.emailSetBodies?.(on);
    };
    return;
  }
  box.innerHTML = `
    <div class="s-row"><div class="s-label">Gmail: not connected<small>Ask “Did I get an email from Sam today?” and Cadabra checks, tells you, and can open it in Gmail.</small></div></div>
    <p class="s-note">${disclosure}</p>
    <details class="s-row em-path" open><summary class="s-label">Secure (recommended): your own Google key<small>About 10 minutes, once. Read-only access, and you can remove it any time.</small></summary>
      <ol class="em-steps">
        <li>Create a free Google Cloud project (any name, e.g. “Cadabra Mail”). <button type="button" class="btn ghost" data-help="project">Open</button></li>
        <li>Turn on the Gmail API for it. <button type="button" class="btn ghost" data-help="api">Open</button></li>
        <li>Audience: choose External, add your own address as a test user, then click <b>Publish app</b> so it is <b>In production</b> (otherwise Google signs you out every 7 days). Google will call it “unverified”; that’s expected for your own key. <button type="button" class="btn ghost" data-help="audience">Open</button></li>
        <li>Clients → Create client → <b>Desktop app</b>. Copy the client ID (or download the JSON). <button type="button" class="btn ghost" data-help="clients">Open</button></li>
        <li>Paste it here and click Connect. In the browser, choose your account; on “Google hasn’t verified this app” click Advanced → Continue; allow read-only access.</li>
      </ol>
      <textarea id="em-client" rows="2" placeholder="Client ID (…apps.googleusercontent.com) or the downloaded JSON"></textarea>
      <input id="em-secret" type="password" placeholder="Client secret (optional)" autocomplete="off" />
      <div class="sc-btns"><button type="button" class="btn primary" id="em-oauth">Connect</button></div>
    </details>
    <details class="s-row em-path"><summary class="s-label">Simple (personal Gmail, less secure)<small>About 2 minutes. Only for @gmail.com addresses.</small></summary>
      <p class="s-note em-warn">An app password gives <b>full access to your mailbox</b> (Google can’t limit it to reading). Cadabra only ever opens it read-only, but anyone who got the password could do more. Google recommends the secure option.</p>
      <ol class="em-steps">
        <li>Turn on 2-Step Verification for your Google account. <button type="button" class="btn ghost" data-help="twostep">Open</button></li>
        <li>Create an app password (name it “Cadabra”) and copy the 16 letters. <button type="button" class="btn ghost" data-help="apppasswords">Open</button></li>
      </ol>
      <input id="em-addr" type="email" placeholder="you@gmail.com" autocomplete="off" />
      <input id="em-pass" type="password" placeholder="16-letter app password" autocomplete="off" />
      <div class="sc-btns"><button type="button" class="btn primary" id="em-imap">Connect</button></div>
    </details>
    <p class="s-note em-msg" id="em-msg"></p>`;
  const msg = box.querySelector<HTMLElement>('#em-msg')!;
  if (notice) msg.textContent = notice;
  if (!st.encryption) msg.textContent = 'Windows encryption is unavailable on this PC, so Cadabra can’t store an email sign-in.';
  box.querySelectorAll<HTMLButtonElement>('[data-help]').forEach((b) => (b.onclick = () => api.emailOpenHelp?.(b.dataset.help!)));
  box.querySelector<HTMLButtonElement>('#em-oauth')!.onclick = async () => {
    const b = box.querySelector<HTMLButtonElement>('#em-oauth')!;
    b.disabled = true;
    msg.textContent = 'Finish signing in in your browser…';
    const r = await api.emailConnectOAuth?.(box.querySelector<HTMLTextAreaElement>('#em-client')!.value, box.querySelector<HTMLInputElement>('#em-secret')!.value || null);
    b.disabled = false;
    if (r?.ok) void renderEmailSettings(box, provider, 'Connected.');
    else msg.textContent = r?.error ?? 'Couldn’t connect.';
  };
  box.querySelector<HTMLButtonElement>('#em-imap')!.onclick = async () => {
    const b = box.querySelector<HTMLButtonElement>('#em-imap')!;
    b.disabled = true;
    msg.textContent = 'Checking with Gmail…';
    const r = await api.emailConnectImap?.(box.querySelector<HTMLInputElement>('#em-addr')!.value, box.querySelector<HTMLInputElement>('#em-pass')!.value);
    b.disabled = false;
    if (r?.ok) void renderEmailSettings(box, provider, 'Connected.');
    else msg.textContent = r?.error ?? 'Couldn’t connect.';
  };
}

// ---- Round 11: Settings → Safety → Permissions ----
async function renderPerms(box: HTMLElement): Promise<void> {
  const list = (await api.permList?.().catch(() => null)) ?? [];
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<small>None yet.</small>';
    return;
  }
  for (const g of list) {
    const line = document.createElement('small');
    line.className = 'perm-line';
    line.textContent = `${g.label} `;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost';
    b.textContent = 'Revoke';
    b.onclick = async () => {
      await api.permRevoke?.(g.scope, g.cls);
      void renderPerms(box);
    };
    line.append(b);
    box.append(line);
  }
}

// ---- 0.9.5: Settings → Skills ----
const SKILL_SOURCE: Record<string, string> = { builtin: 'Built-in', user: 'Yours', install: 'Install folder' };
async function renderSkills(box: HTMLDivElement, newName?: string): Promise<void> {
  const r = await api.skillsList?.().catch(() => null);
  if (!r) {
    box.innerHTML = '<p class="s-note">Skills aren’t available in this build.</p>';
    return;
  }
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const rows = r.skills
    .map((k) => {
      const blocked = k.errors.length > 0 || !!k.shadowedBy;
      return `<div class="s-row sk-row${k.active ? ' on' : ''}" data-id="${esc(k.id)}">
        <div class="s-label"><span class="sk-name">${esc(k.name)}</span> <span class="sk-src sk-${k.source}">${SKILL_SOURCE[k.source] ?? k.source}</span>
          <small>${k.description ? esc(k.description) : ''}</small>
          ${k.errors.map((e) => `<small class="sk-err">${esc(e)}</small>`).join('')}
          ${k.shadowedBy ? `<small class="sk-warn">Not used: your own skill with the same name replaces it.</small>` : ''}
          ${k.warnings.map((w) => `<small class="sk-warn">${esc(w)}</small>`).join('')}
          ${k.errors.length ? '' : `<details class="sk-view"><summary>View instructions</summary><pre class="sk-text">Loading…</pre></details>`}
        </div>
        <button type="button" class="toggle ${k.enabled && !blocked ? 'on' : ''}" role="switch" aria-checked="${k.enabled && !blocked}" aria-label="Use ${esc(k.name)}" ${blocked ? 'disabled' : ''}></button>
      </div>`;
    })
    .join('');
  box.innerHTML = `
    <p class="s-note">Skills teach ${esc(assistantLabel)} how to do things your way, like a morning briefing or your work setup. Your skills live in <b>${esc(r.userDir)}</b>, which updates never touch. New skills start switched off: turn them on here. A skill can’t switch off any safety check. <a href="#" class="sk-guide">How to make a skill</a></p>
    ${rows || '<p class="s-note">No skills yet.</p>'}
    <div class="sk-actions">
      <button type="button" class="btn ghost sk-open">Open my skills folder</button>
      <button type="button" class="btn ghost sk-new-btn">New skill from template</button>
      <button type="button" class="btn ghost sk-reload">Reload</button>
    </div>
    <div class="sk-new" hidden><input type="text" maxlength="48" placeholder="Name your skill, e.g. plan my trip" aria-label="New skill name" /><button type="button" class="btn primary sk-create">Create</button></div>
    <p class="sk-msg" aria-live="polite"></p>
    <p class="s-note">Skills you put in Cadabra’s install folder (${esc(r.builtinDir)}) also load, but updates may remove them.</p>`;
  const msg = box.querySelector<HTMLElement>('.sk-msg')!;
  box.querySelectorAll<HTMLElement>('.sk-row').forEach((row) => {
    const id = row.dataset.id!;
    const t = row.querySelector<HTMLButtonElement>('.toggle')!;
    t.onclick = async () => {
      if (t.disabled) return;
      const on = !t.classList.contains('on');
      t.classList.toggle('on', on);
      t.setAttribute('aria-checked', String(on));
      await api.skillsSetEnabled?.(id, on);
    };
    const det = row.querySelector<HTMLDetailsElement>('.sk-view');
    det?.addEventListener('toggle', async () => {
      if (!det.open) return;
      const txt = await api.skillsView?.(id);
      det.querySelector('pre')!.textContent = txt ?? '(not available)';
    });
  });
  box.querySelector<HTMLAnchorElement>('.sk-guide')!.onclick = (e) => {
    e.preventDefault();
    void api.skillsOpenFolder?.('guide');
  };
  box.querySelector<HTMLButtonElement>('.sk-open')!.onclick = () => void api.skillsOpenFolder?.('user');
  box.querySelector<HTMLButtonElement>('.sk-reload')!.onclick = async () => {
    await api.skillsReload?.();
    await renderSkills(box);
  };
  const nb = box.querySelector<HTMLElement>('.sk-new')!;
  const nameIn = nb.querySelector<HTMLInputElement>('input')!;
  const create = async () => {
    const name = nameIn.value.trim();
    if (!name) return nameIn.focus();
    const res = await api.skillsNew?.(name);
    if (res?.ok) {
      await renderSkills(box);
      box.querySelector<HTMLElement>('.sk-msg')!.textContent = `Created “${res.name}” in your skills folder and opened it in Notepad. Edit it, save, then turn it on here.`;
    } else msg.textContent = res?.error ?? 'Couldn’t create the skill.';
  };
  box.querySelector<HTMLButtonElement>('.sk-new-btn')!.onclick = () => {
    nb.hidden = false;
    nameIn.focus();
  };
  nb.querySelector<HTMLButtonElement>('.sk-create')!.onclick = () => void create();
  nameIn.onkeydown = (e) => {
    if (e.key === 'Enter') void create();
  };
  if (newName != null) {
    nb.hidden = false;
    nameIn.value = newName;
    setTimeout(() => nameIn.focus(), 50);
  }
}

// ---- Round 12: Settings → WhatsApp (chat with the assistant from your phone) ----
async function renderWhatsApp(box: HTMLDivElement, provider: string, notice = '', nm = 'Cadabra'): Promise<void> {
  const st = (await api.waStatus?.().catch(() => null)) ?? null;
  if (!st) {
    box.innerHTML = '<p class="s-note">WhatsApp isn’t available in this build.</p>';
    return;
  }
  const company = PROVIDER_COMPANY[provider] ?? provider;
  const chip = !st.hasToken ? 'Not set up' : !st.enabled ? 'Off' : st.status === 'ok' ? (st.paired ? 'Connected' : 'Waiting for pairing') : st.status === 'token-invalid' ? 'Key refused' : st.status === 'offline' ? 'Can’t reach WhatsApp' : 'Connecting…';
  box.innerHTML = `
    <div class="s-row"><div class="s-label">Chat with ${nm} on WhatsApp<small>Status: <b>${chip}</b>. Ask questions or have ${nm} act on this PC from your phone. Messages go to Meta’s agent service and then to your AI (${company}).</small></div>${st.hasToken ? `<button type="button" class="toggle${st.enabled ? ' on' : ''}" role="switch" aria-checked="${st.enabled}" id="wa-on"></button>` : ''}</div>
    <details class="s-row em-path"${st.hasToken ? '' : ' open'}><summary class="s-label">${st.hasToken ? 'API key saved' : 'Set up'}<small>About 1 minute.</small></summary>
      <ol class="em-steps">
        <li>In WhatsApp on your phone: <b>Settings → Agents → Create an agent</b>. Name it (e.g. “Ada”).</li>
        <li>Open the agent’s chat → <b>Chat info → API key</b>, and copy the key. (WhatsApp only lets this agent talk to you.)</li>
        <li>Paste it here and press Save, then turn the switch on and send the 6-digit code Cadabra shows into the agent chat.</li>
      </ol>
      <input id="wa-key" type="password" placeholder="${st.hasToken ? 'Paste a new key to replace the saved one' : 'API key'}" autocomplete="off" />
      <div class="sc-btns"><button type="button" class="btn primary" id="wa-save">Save</button>${st.hasToken ? '<button type="button" class="btn ghost" id="wa-test">Test connection</button><button type="button" class="btn ghost" id="wa-remove">Remove key</button>' : ''}</div>
    </details>
    ${st.hasToken ? `<div class="s-row"><div class="s-label">Paired phone<small>${st.paired ? 'Paired with your WhatsApp.' : 'Not paired yet.'}</small></div><div class="sc-btns"><button type="button" class="btn ghost" id="wa-pair">${st.paired ? 'Pair again' : 'Show pairing code'}</button>${st.paired ? '<button type="button" class="btn ghost" id="wa-unpair">Unpair</button>' : ''}</div></div>
    <div class="s-row"><div class="s-label">When ${nm} acts from WhatsApp
      <select id="wa-auto"><option value="risky">Ask only for risky actions (code in the chat)</option><option value="every">Ask before acting (every action)</option><option value="none">Don’t ask</option></select></div></div>
    <div class="s-row"><div class="s-label">Wake the display for WhatsApp requests<small>If the screen has gone dark, ${nm} turns it back on (and keeps it on during the request) so it can see and act. A locked PC stays locked: ${nm} can’t see or use it, but can still make announcements.</small></div><button type="button" class="toggle ${st.wakeDisplay !== false ? 'on' : ''}" role="switch" aria-checked="${st.wakeDisplay !== false}" id="wa-wake"></button></div>
    <div class="s-row"><div class="s-label">Keep this PC awake while remote access is on<small>Stops Windows from going to sleep (the display can still turn off), so WhatsApp messages reach ${nm}. Uses more power. A sleeping PC can’t receive messages.</small></div><button type="button" class="toggle ${st.keepAwake ? 'on' : ''}" role="switch" aria-checked="${!!st.keepAwake}" id="wa-awake"></button></div>` : ''}
    <p class="s-note">Privacy: chats with WhatsApp agents are <b>not end-to-end encrypted</b>. Meta’s agent service keeps messages and media for up to 30 days. ${nm} only sends a (compressed) picture of your screen when you ask for one, and deletes it from the service right after. You run this agent yourself, so under WhatsApp’s third-party agent terms you are its “agent provider” and responsible for what it does; use it only for your own PC and accounts. Say “stop” in the chat, or press Esc at the PC, to stop ${nm}.</p>
    <p class="s-note em-msg" id="wa-msg"></p>`;
  const msg = box.querySelector<HTMLElement>('#wa-msg')!;
  if (notice) msg.textContent = notice;
  if (!st.encryption) msg.textContent = 'Windows encryption is unavailable on this PC, so Cadabra can’t store the key.';
  box.querySelector<HTMLButtonElement>('#wa-save')!.onclick = async () => {
    const r = await api.waSetToken?.(box.querySelector<HTMLInputElement>('#wa-key')!.value);
    if (r?.ok) void renderWhatsApp(box, provider, 'Saved. Turn the switch on to connect.', nm);
    else msg.textContent = r?.error ?? 'Couldn’t save the key.';
  };
  const test = box.querySelector<HTMLButtonElement>('#wa-test');
  if (test)
    test.onclick = async () => {
      msg.textContent = 'Testing…';
      const r = await api.waTest?.();
      msg.textContent = r?.ok ? 'WhatsApp accepted the key.' : (r?.error ?? 'The test failed.');
    };
  const rm = box.querySelector<HTMLButtonElement>('#wa-remove');
  if (rm)
    rm.onclick = async () => {
      await api.waSetToken?.(null);
      void renderWhatsApp(box, provider, 'Key removed. Remote access is off.', nm);
    };
  const on = box.querySelector<HTMLButtonElement>('#wa-on');
  if (on)
    on.onclick = async () => {
      await api.waEnable?.(!on.classList.contains('on'));
      void renderWhatsApp(box, provider, '', nm);
    };
  const pair = box.querySelector<HTMLButtonElement>('#wa-pair');
  if (pair)
    pair.onclick = async () => {
      const r = await api.waPair?.();
      if (r) msg.textContent = `Send ${r.code} to your agent chat in WhatsApp (valid 5 minutes).`;
    };
  const unpair = box.querySelector<HTMLButtonElement>('#wa-unpair');
  if (unpair)
    unpair.onclick = async () => {
      await api.waUnpair?.();
      void renderWhatsApp(box, provider, 'Unpaired.', nm);
    };
  for (const [id, key] of [
    ['#wa-wake', 'wakeDisplay'],
    ['#wa-awake', 'keepAwake'],
  ] as const) {
    const t = box.querySelector<HTMLButtonElement>(id);
    if (t)
      t.onclick = async () => {
        const on = !t.classList.contains('on');
        t.classList.toggle('on', on);
        t.setAttribute('aria-checked', String(on));
        await api.waPower?.({ [key]: on });
      };
  }
  const auto = box.querySelector<HTMLSelectElement>('#wa-auto');
  if (auto) {
    auto.value = st.autonomy;
    auto.onchange = () => void api.waAutonomy?.(auto.value);
  }
}
