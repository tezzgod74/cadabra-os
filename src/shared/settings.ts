import { DEFAULT_ANNOUNCEMENTS, mergeAnnouncements } from './announce';
import { DEFAULT_SAFETY } from './safety';
import { DEFAULT_BINDING, sanitizeBinding } from './binding';
import type { ProviderId, Settings } from './types';
import { ALL_VOICES, DEFAULT_SPEED, OLD_DEFAULT_SPEED } from './voices';
import { checkName } from './assistant';

/** Settings schema version (2 = round 5: speed default 1.05). */
export const SETTINGS_VERSION = 2;

export const PROVIDERS: ProviderId[] = ['claude', 'copilot', 'codex', 'gemini', 'demo'];

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  provider: 'claude',
  models: {
    claude: 'claude-sonnet-5-5',
    copilot: '',
    codex: '',
    gemini: '',
    demo: 'demo-sparkle',
  },
  launchAtLogin: false,
  paused: false,
  motion: 'system',
  safety: DEFAULT_SAFETY,
  cli: {},
  voice: { enabled: false, speakReplies: 'voice', followUpSeconds: 8, wakeWord: 'cadabra', sensitivity: 0.5, pushToTalk: false, ttsEngine: 'kokoro', ttsVoice: 'bm_george', ttsSpeed: DEFAULT_SPEED, phrasing: false, cloudVoice: false, fastModelForVoice: true, inputDevice: '' },
  displayName: '',
  summon: DEFAULT_BINDING,
  onboarded: false,
  claudeRoute: 'api-key',
  webAccess: true,
  claudeApiWeb: true,
  skills: { enabled: {} },
  announcements: { ...DEFAULT_ANNOUNCEMENTS },
  privacy: { keepHistory: 'until-cleared', showInRecordings: false },
  location: '',
  micNotCall: [],
  greetings: { enabled: true, awayMinutes: 20, quietStart: '', quietEnd: '', recent: [] },
  email: { mode: 'none', address: '', clientId: '', allowBodies: true },
  remote: { enabled: false, autonomy: 'risky', offset: null, pairedFrom: '', wakeDisplay: true, keepAwake: false },
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Merge a persisted (possibly old, partial or corrupt) settings object onto the
 * defaults, dropping fields with the wrong type.
 */
export function mergeSettings(raw: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
  const out: Settings = structuredClone(defaults);
  if (!isObj(raw)) return out;
  if (typeof raw.provider === 'string' && (PROVIDERS as string[]).includes(raw.provider)) out.provider = raw.provider as ProviderId;
  if (isObj(raw.models)) {
    for (const p of PROVIDERS) {
      const m = raw.models[p];
      if (typeof m === 'string') out.models[p] = m;
    }
  }
  if (typeof raw.launchAtLogin === 'boolean') out.launchAtLogin = raw.launchAtLogin;
  if (typeof raw.onboarded === 'boolean') out.onboarded = raw.onboarded;
  if (raw.claudeRoute === 'api-key' || raw.claudeRoute === 'claude-code' || raw.claudeRoute === 'bedrock' || raw.claudeRoute === 'vertex') out.claudeRoute = raw.claudeRoute;
  if (typeof raw.displayName === 'string') out.displayName = raw.displayName.trim().slice(0, 40);
  if (typeof raw.webAccess === 'boolean') out.webAccess = raw.webAccess;
  if (typeof raw.claudeApiWeb === 'boolean') out.claudeApiWeb = raw.claudeApiWeb;
  if (isObj(raw.announcements)) out.announcements = mergeAnnouncements(raw.announcements);
  if (isObj(raw.privacy)) {
    if (raw.privacy.keepHistory === 'until-cleared' || raw.privacy.keepHistory === 'on-close' || raw.privacy.keepHistory === 'idle-1h') out.privacy.keepHistory = raw.privacy.keepHistory;
    if (typeof raw.privacy.showInRecordings === 'boolean') out.privacy.showInRecordings = raw.privacy.showInRecordings;
  }
  if (isObj(raw.skills) && isObj(raw.skills.enabled)) {
    for (const [k, v] of Object.entries(raw.skills.enabled).slice(0, 500)) if (/^(builtin|install|user):[^\p{Cc}<>:"/\\|?*]{1,100}$/u.test(k) && typeof v === 'boolean') out.skills.enabled[k] = v;
  }
  if (Array.isArray(raw.micNotCall)) out.micNotCall = raw.micNotCall.filter((x): x is string => typeof x === 'string' && /^[\w .()+-]{1,120}$/i.test(x)).map((x) => x.toLowerCase()).slice(-30);
  if (isObj(raw.greetings)) {
    const g = raw.greetings;
    if (typeof g.enabled === 'boolean') out.greetings.enabled = g.enabled;
    if (typeof g.awayMinutes === 'number' && g.awayMinutes >= 5 && g.awayMinutes <= 240) out.greetings.awayMinutes = Math.round(g.awayMinutes);
    const hm = (v: unknown) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : '');
    if ('quietStart' in g) out.greetings.quietStart = hm(g.quietStart);
    if ('quietEnd' in g) out.greetings.quietEnd = hm(g.quietEnd);
    if (Array.isArray(g.recent)) out.greetings.recent = g.recent.filter((x): x is string => typeof x === 'string' && /^[a-z]\d{1,3}$/.test(x)).slice(-80);
  }
  if (isObj(raw.remote)) {
    const r = raw.remote;
    if (typeof r.enabled === 'boolean') out.remote.enabled = r.enabled;
    if (r.autonomy === 'risky' || r.autonomy === 'every' || r.autonomy === 'none') out.remote.autonomy = r.autonomy;
    if (typeof r.offset === 'number' && Number.isSafeInteger(r.offset) && r.offset >= 0) out.remote.offset = r.offset;
    if (typeof r.pairedFrom === 'string' && /^user:[\w-]{1,64}$/.test(r.pairedFrom)) out.remote.pairedFrom = r.pairedFrom;
    if (typeof r.wakeDisplay === 'boolean') out.remote.wakeDisplay = r.wakeDisplay;
    if (typeof r.keepAwake === 'boolean') out.remote.keepAwake = r.keepAwake;
  }
  if (isObj(raw.email)) {
    const e = raw.email;
    if (e.mode === 'none' || e.mode === 'gmail-oauth' || e.mode === 'gmail-imap') out.email.mode = e.mode;
    if (typeof e.address === 'string') out.email.address = e.address.trim().slice(0, 200);
    if (typeof e.clientId === 'string') out.email.clientId = e.clientId.trim().slice(0, 200);
    if (typeof e.allowBodies === 'boolean') out.email.allowBodies = e.allowBodies;
  }
  if (typeof raw.location === 'string') out.location = raw.location.replace(/[^\p{L}\p{N} ,.'-]/gu, '').trim().slice(0, 80);
  if (typeof raw.paused === 'boolean') out.paused = raw.paused;
  if (raw.motion === 'system' || raw.motion === 'reduced' || raw.motion === 'full') out.motion = raw.motion;
  if (isObj(raw.cli)) {
    if (typeof raw.cli.copilotPath === 'string') out.cli.copilotPath = raw.cli.copilotPath;
    if (typeof raw.cli.codexPath === 'string') out.cli.codexPath = raw.cli.codexPath;
    if (typeof raw.cli.claudePath === 'string') out.cli.claudePath = raw.cli.claudePath;
    if (typeof raw.cli.geminiPath === 'string') out.cli.geminiPath = raw.cli.geminiPath;
  }
  if (isObj(raw.voice)) {
    if (typeof raw.voice.enabled === 'boolean') out.voice.enabled = raw.voice.enabled;
    // Legacy boolean: true → always, false → only for voice conversations.
    if (typeof raw.voice.speakReplies === 'boolean') out.voice.speakReplies = raw.voice.speakReplies ? 'always' : 'voice';
    if (raw.voice.speakReplies === 'voice' || raw.voice.speakReplies === 'always' || raw.voice.speakReplies === 'never') out.voice.speakReplies = raw.voice.speakReplies;
    if (typeof raw.voice.followUpSeconds === 'number' && raw.voice.followUpSeconds >= 0 && raw.voice.followUpSeconds <= 30) out.voice.followUpSeconds = raw.voice.followUpSeconds;
    if (typeof raw.voice.wakeWord === 'string' && raw.voice.wakeWord.trim() && checkName(raw.voice.wakeWord).ok) out.voice.wakeWord = raw.voice.wakeWord.trim().replace(/\s+/g, ' ').toLowerCase();
    if (typeof raw.voice.sensitivity === 'number' && raw.voice.sensitivity >= 0 && raw.voice.sensitivity <= 1) out.voice.sensitivity = raw.voice.sensitivity;
    if (typeof raw.voice.pushToTalk === 'boolean') out.voice.pushToTalk = raw.voice.pushToTalk;
    if (raw.voice.ttsEngine === 'kokoro' || raw.voice.ttsEngine === 'windows') out.voice.ttsEngine = raw.voice.ttsEngine;
    if (typeof raw.voice.ttsVoice === 'string' && ALL_VOICES.some((v) => v.id === (raw.voice as Record<string, unknown>).ttsVoice)) out.voice.ttsVoice = raw.voice.ttsVoice;
    if (typeof raw.voice.ttsSpeed === 'number' && raw.voice.ttsSpeed >= 0.8 && raw.voice.ttsSpeed <= 1.2) out.voice.ttsSpeed = raw.voice.ttsSpeed;
    // Round 5 migration: the old default pace (0.95) felt too slow; move it to the new default once.
    if ((typeof raw.version !== 'number' || raw.version < 2) && raw.voice.ttsSpeed === OLD_DEFAULT_SPEED) out.voice.ttsSpeed = DEFAULT_SPEED;
    if (typeof raw.voice.phrasing === 'boolean') out.voice.phrasing = raw.voice.phrasing;
    if (typeof raw.voice.cloudVoice === 'boolean') out.voice.cloudVoice = raw.voice.cloudVoice;
    if (typeof raw.voice.fastModelForVoice === 'boolean') out.voice.fastModelForVoice = raw.voice.fastModelForVoice;
    if (typeof raw.voice.inputDevice === 'string') out.voice.inputDevice = raw.voice.inputDevice.slice(0, 200);
  }
  if (raw.summon !== undefined) {
    const b = sanitizeBinding(raw.summon);
    if (b) out.summon = b;
  }
  if (isObj(raw.safety)) {
    const s = raw.safety;
    // S11: the denylist / risky-word / messaging-app rules always come from the
    // current code defaults, so new rules shipped in an update reach existing
    // installs. Persisted lists are intentionally ignored. Only the two scalar
    // preferences are user-editable.
    if (typeof s.maxActionsPerRun === 'number' && s.maxActionsPerRun >= 1 && s.maxActionsPerRun <= 200) out.safety.maxActionsPerRun = Math.floor(s.maxActionsPerRun);
    if (typeof s.confirmAllActions === 'boolean') out.safety.confirmAllActions = s.confirmAllActions;
    // Round 11: autonomy level and "Always allow" grants.
    if (s.autonomy === 'risky' || s.autonomy === 'every' || s.autonomy === 'none') out.safety.autonomy = s.autonomy;
    else if (s.confirmAllActions === true) out.safety.autonomy = 'every';
    out.safety.confirmAllActions = out.safety.autonomy === 'every';
    if (Array.isArray(s.grants))
      out.safety.grants = s.grants
        .filter((g): g is { cls: 'click' | 'type' | 'keys' | 'scroll' | 'open'; scope: string; label: string; at: number } => isObj(g) && ['click', 'type', 'keys', 'scroll', 'open'].includes(g.cls as string) && typeof g.scope === 'string' && /^(app|site):[\w.-]{1,120}$/.test(g.scope))
        .map((g) => ({ cls: g.cls, scope: g.scope, label: typeof g.label === 'string' ? g.label.slice(0, 120) : g.scope, at: typeof g.at === 'number' ? g.at : 0 }))
        .slice(-100);
  }
  return out;
}

export function applyPatch(cur: Settings, patch: Partial<Settings>): Settings {
  return mergeSettings({
    ...cur,
    ...patch,
    models: { ...cur.models, ...(patch.models ?? {}) },
    voice: { ...cur.voice, ...(patch.voice ?? {}) },
    cli: { ...cur.cli, ...(patch.cli ?? {}) },
    safety: { ...cur.safety, ...(patch.safety ?? {}) },
    privacy: { ...cur.privacy, ...(patch.privacy ?? {}) },
  });
}

/**
 * S12: the renderer may only change user-preference keys. Security-relevant
 * settings (safety limits, CLI executable paths) can't be set from the panel,
 * so a renderer bug can't widen the gate or point Cadabra at an arbitrary exe.
 */
export function sanitizeRendererPatch(raw: unknown): Partial<Settings> {
  if (!isObj(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const k of ['provider', 'models', 'launchAtLogin', 'paused', 'motion', 'voice', 'summon', 'displayName', 'onboarded', 'webAccess', 'claudeApiWeb', 'location', 'greetings', 'announcements', 'privacy'] as const) {
    if (k in raw) out[k] = raw[k];
  }
  // Only the autonomy level is a renderer preference (grants have their own IPC). A partial
  // safety patch: applyPatch() merges it over the current safety settings.
  if (isObj(raw.safety)) {
    const a = raw.safety.autonomy ?? (typeof raw.safety.confirmAllActions === 'boolean' ? (raw.safety.confirmAllActions ? 'every' : 'risky') : undefined);
    if (a === 'risky' || a === 'every' || a === 'none') out.safety = { autonomy: a, confirmAllActions: a === 'every' };
  }
  return out as Partial<Settings>;
}
