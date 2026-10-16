// Types shared between main, preload and renderers.
import type { SummonBinding } from './binding';

export type ProviderId = 'claude' | 'copilot' | 'codex' | 'gemini' | 'demo';

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Info about the window the user summoned Cadabra on. Coordinates are PHYSICAL pixels. */
export interface TargetWindow {
  hwnd: number;
  /** true when the window runs at a higher integrity level (admin) — input can't reach it. */
  elevated?: boolean | null;
  title: string;
  process: string;
  className?: string;
  pid?: number;
  rect: Rect;
  dpi?: number;
}

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  default?: boolean;
}

export interface AuthStatus {
  ok: boolean;
  /** One-line human status, e.g. "Signed in via ANTHROPIC_API_KEY". */
  detail: string;
  /** How to fix when not ok. */
  howTo?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  models: ModelOption[];
  auth?: AuthStatus;
}

/** Events streamed from a provider adapter to the UI. */
export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; phase: 'start' | 'end'; summary?: string; ok?: boolean }
  | { type: 'status'; text: string }
  /** Round 8 (REVIEW-7 W7-1): URLs this turn's web search returned (fetching them needs no card). */
  | { type: 'web-results'; urls: string[] }
  | { type: 'session'; sessionId: string }
  | { type: 'done'; sessionId?: string; costUsd?: number }
  | { type: 'error'; message: string };

export interface DenyRule {
  /** Case-insensitive substring match against process name (e.g. "1password.exe"). */
  process?: string;
  /** Case-insensitive substring match against window title (e.g. "bank"). */
  title?: string;
  /** 'confirm' = every action needs explicit confirmation; 'block' = no seeing or acting at all. */
  mode: 'confirm' | 'block';
  label?: string;
}

export interface SafetySettings {
  denylist: DenyRule[];
  /** Words that make an action risky when they appear in the target element / keys / text. */
  riskyWords: string[];
  /** Processes where Enter / Ctrl+Enter may send a message. */
  messagingApps: string[];
  maxActionsPerRun: number;
  /** If true, every action (not only risky ones) requires confirmation. */
  confirmAllActions: boolean;
  /**
   * Round 11: how much Cadabra asks first.
   * - 'risky' (default): only risky actions (send / pay / delete…, shell commands,
   *   secrets, banking / trading / messaging, closing windows) get a card;
   * - 'every': a card before every action (= confirmAllActions);
   * - 'none': no cards at all (hard blocks still apply).
   */
  autonomy?: Autonomy;
  /** Round 11: "Always allow this in <app/site>" grants. */
  grants?: PermissionGrant[];
}

export type Autonomy = 'risky' | 'every' | 'none';

export interface PermissionGrant {
  /** Action class: click / type / keys / scroll. */
  cls: 'click' | 'type' | 'keys' | 'scroll' | 'open';
  /** "app:notepad" or "site:google.com". */
  scope: string;
  /** Shown in Settings → Permissions ("Clicks in Google Chrome on google.com"). */
  label: string;
  at: number;
}

export interface Settings {
  version: number;
  provider: ProviderId;
  models: Record<ProviderId, string>;
  launchAtLogin: boolean;
  paused: boolean;
  motion: 'system' | 'reduced' | 'full';
  safety: SafetySettings;
  cli: { claudePath?: string; copilotPath?: string; codexPath?: string; geminiPath?: string };
  /** How Cadabra addresses you (defaults to your Windows display name). */
  displayName: string;
  voice: VoiceSettings;
  /** Summon shortcut (default Ctrl+~). */
  summon: SummonBinding;
  /** First-run onboarding completed. */
  onboarded: boolean;
  /** How Claude is reached: Anthropic API key (default), Amazon Bedrock or Google Vertex AI. */
  claudeRoute: 'api-key' | 'claude-code' | 'bedrock' | 'vertex';
  /** Round 7: the AI may search / read the web (read-only), on by default. */
  webAccess: boolean;
  /** 0.9.3: web search for Claude's API-key / Bedrock / Vertex routes (runs Claude Code without --bare so Cadabra's web guard hook works). */
  claudeApiWeb: boolean;
  /** 0.9.5: skills the user turned on or off, by id ("user:quick-note"). Missing = default (built-ins on, others off). */
  skills: { enabled: Record<string, boolean> };
  /** 0.9.9: how long chat history is kept (it's mostly in memory anyway). */
  privacy: { keepHistory: 'until-cleared' | 'on-close' | 'idle-1h' };
  /** 0.9.6: announcements (spoken verbatim on the PC). */
  announcements: import('./announce').AnnouncementSettings;
  /** Round 7: "Your location" (a city) for weather; '' = ask once in conversation. Never guessed from the IP. */
  location: string;
  /** Round 8: spoken welcome greetings (no panel). */
  greetings: GreetingSettings;
  /** Round 9.5: always-on mic apps (mixers, NVIDIA Broadcast, OBS…) that are "not a call" (exe or Store package names, lower case). */
  micNotCall: string[];
  /** Round 8: read-only email (Gmail). */
  email: EmailSettings;
  /** Round 12: chat with the assistant on WhatsApp (remote access). */
  remote: RemoteSettings;
}

export interface GreetingSettings {
  enabled: boolean;
  /** Greet after the user was away (no input / locked) this long. */
  awayMinutes: number;
  /** "HH:MM" quiet hours (both empty = none). */
  quietStart: string;
  quietEnd: string;
  /** Recently used greeting ids (no repeats until a pool is exhausted). */
  recent: string[];
}

export interface RemoteSettings {
  /** Remote access over the WhatsApp Agent Platform (the token is a secret, not here). */
  enabled: boolean;
  /** How much the assistant asks before acting for a WhatsApp request ("YES"-style codes in the chat). */
  autonomy: Autonomy;
  /** next_offset from the last poll (null = only new traffic). Not renderer-writable. */
  offset: number | null;
  /** The paired owner's participant id ('' = not paired). Never shown or logged. Not renderer-writable. */
  pairedFrom: string;
  /** 0.9.8: wake a dark display for remote requests and keep it on during the request (default on). */
  wakeDisplay: boolean;
  /** 0.9.8: keep the PC from sleeping while remote access is on (default off; the display may still turn off). */
  keepAwake: boolean;
}

export interface EmailSettings {
  /** How Gmail is connected: not at all, the user's own Google OAuth client, or an IMAP app password. */
  mode: 'none' | 'gmail-oauth' | 'gmail-imap';
  /** The connected address (for the Gmail deep link). Never logged. */
  address: string;
  /** OAuth Desktop client id (not a secret for installed apps). */
  clientId: string;
  /** Send full message text to the AI when asked to read an email (headers + preview always). */
  allowBodies: boolean;
}

export interface VoiceSettings {
  /** Always-on local wake word listening. */
  enabled: boolean;
  /** Speak replies aloud: only when the conversation started by voice (default), always, or never. */
  speakReplies: 'voice' | 'always' | 'never';
  /** After a spoken reply, listen this many seconds for a follow-up without the wake word (0 = off). */
  followUpSeconds: number;
  wakeWord: string;
  /** 0 (strict) .. 1 (sensitive) wake-word detection. */
  sensitivity: number;
  /** Ignore the wake word; hold Ctrl+Win to talk instead. */
  pushToTalk: boolean;
  /** Spoken replies: natural (Kokoro, downloaded on opt-in) or the Windows voice. */
  ttsEngine: 'kokoro' | 'windows';
  /** Kokoro voice id (default bm_george, British). */
  ttsVoice: string;
  /** 0.8–1.2 (default 1.05 since round 5). */
  ttsSpeed: number;
  /** Round 5: light dialect phrasing in replies ("Cheers", "Howdy"): at most one touch per reply. */
  phrasing: boolean;
  /** Round 5: allow the cloud (Southern) voices; uses the user's own OpenAI key. Off by default. */
  cloudVoice: boolean;
  /** Round 5: voice turns use the backend's fast model (quicker replies). */
  fastModelForVoice: boolean;
  /** Round 7: the microphone to use, by its label ('' = the Windows default). */
  inputDevice: string;
}

/** off · idle (listening for the wake word) · listening (capturing a request) · transcribing · downloading (speech model) · error */
export type VoiceState = 'off' | 'idle' | 'listening' | 'followup' | 'transcribing' | 'downloading' | 'error';

/** Messages main -> panel renderer. */
export type PanelMessage =
  | {
      type: 'summon';
      /** Click point relative to the panel window (DIP), for transform-origin. */
      origin: Point;
      target: { title: string; process: string } | null;
      provider: ProviderInfo;
      model: string;
      reducedMotion: boolean;
      fresh: boolean;
      /** Set when summoned by voice: this text is being sent right away. */
      voicePrompt?: string;
      elevated?: boolean;
      /** Round 5: the assistant's chosen name (panel title, hints). */
      assistant?: string;
    }
  | { type: 'dismiss' }
  | { type: 'event'; event: ProviderEvent }
  | { type: 'confirm'; id: string; title: string; detail: string; risk: string; mono?: string; subtitle?: string; kind?: 'action' | 'question'; timeoutMs?: number; alwaysLabel?: string }
  | { type: 'confirm-resolved'; id: string; allowed: boolean }
  | { type: 'busy'; busy: boolean; run?: number }
  | { type: 'status'; text: string; run?: number }
  | { type: 'skills-changed' }
  | { type: 'model'; provider: ProviderInfo; model: string }
  | { type: 'voice'; state: VoiceState; level?: number; partial?: string }
  | { type: 'notice'; text: string; tone?: 'info' | 'warn' }
  | { type: 'view'; view: 'chat' | 'settings'; focus?: 'shortcut' | 'skills'; newSkill?: string }
  | { type: 'user-echo'; text: string; via: 'voice' | 'typed' }
  | { type: 'apps'; query: string; choices: { id: string; name: string; source: string; icon?: string }[] }
  | { type: 'launch'; name: string; icon?: string; status: 'opening' | 'opened' | 'focused' | 'error'; detail?: string }
  | { type: 'focus'; focused: boolean }
  | { type: 'account-status'; provider: ProviderId; text: string }
  | { type: 'voice-health'; state: string; text: string; problem: boolean }
  | { type: 'onboarding' }
  | { type: 'acting'; on: boolean; caption?: string; run?: number }
  | { type: 'prefill'; text: string; submit?: boolean }
  | { type: 'tts-progress'; pct: number }
  | { type: 'voice-progress'; pct: number }
  | { type: 'reset' };

/** Messages main -> overlay renderer. All coordinates are DIP relative to the overlay window. */
export type OverlayMessage =
  | { type: 'summon'; at: Point; panel: Rect; reducedMotion: boolean }
  | { type: 'scan'; rect: Rect; reducedMotion: boolean; avoid?: Rect }
  | { type: 'dismiss'; to: Point; panel: Rect; reducedMotion: boolean }
  | { type: 'highlight'; rings: { rect: Rect; label?: string }[]; reducedMotion: boolean; durationMs?: number }
  | { type: 'clear-highlights' }
  | { type: 'ghost-move'; to: Point; from?: Point; caption?: string; durationMs: number; reducedMotion: boolean; avoid?: Rect }
  | { type: 'ghost-click'; at: Point }
  | { type: 'ghost-hide' }
  | { type: 'launch'; from: Point; to: Point; icon?: string; name: string; reducedMotion: boolean }
  | { type: 'spark'; at: Point; reducedMotion: boolean }
  /** Round 12.5: "<name> (WhatsApp) is working" while a WhatsApp request runs. */
  | { type: 'remote-pill'; on: boolean; text?: string }
  | { type: 'clear' };

export interface PanelApi {
  onMessage(cb: (m: PanelMessage) => void): void;
  send(text: string): void;
  cancel(): void;
  dismiss(): void;
  resolveConfirm(id: string, allowed: boolean): void;
  listProviders(): Promise<ProviderInfo[]>;
  setModel(provider: ProviderId, model: string): Promise<void>;
  newChat(): void;
  openExternal(url: string): void;
  openSettings(): void;
  ready(): void;
}

export interface OverlayApi {
  onMessage(cb: (m: OverlayMessage) => void): void;
  ready(): void;
}
