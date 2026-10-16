import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerSaveBlocker, safeStorage, screen, shell, systemPreferences, Tray, type Display } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { physicalRectToDip, placePanel, rectContains, type DisplayMap } from '../shared/coords';
import { parseIntent, pickModelForTier, type Intent } from '../shared/intents';
import { sanitizeRendererPatch } from '../shared/settings';
import { checkObservation } from '../shared/safety';
import type { AuthStatus, ModelOption, Point, ProviderEvent, ProviderId, ProviderInfo, Rect, Settings, TargetWindow, VoiceState } from '../shared/types';
import { HelperClient, type SummonEvent } from './helper';
import { startMcpHttp, type McpHttpHandle } from './mcp-http';
import { ClaudeProvider } from './providers/claude';
import { CodexProvider } from './providers/codex';
import { CopilotProvider } from './providers/copilot';
import { DemoProvider, type DemoEffects } from './providers/demo';
import { GeminiProvider } from './providers/gemini';
import type { ProviderAdapter } from './providers/types';
import { SafetyGate, type ConfirmPrompt } from './safety-gate';
import { SettingsStore, type SecretKey } from './settings-store';
import { looksLikeHandle, tidyName } from '../shared/names';
import { CLI_INSTALLS, installBlocker, installCli, openLoginTerminal, type CliId } from './cli-setup';
import { resolveUserClaudeCode } from './providers/claude';
import { resolveCodexExecutable } from './providers/codex';
import { resolveGeminiExecutable } from './providers/gemini';
import { fenceScreen, newFenceNonce } from '../shared/fence';
import { diagnosticsText, installLogCapture, rememberWindowTitle } from './diagnostics';
import { runningKvmTools } from './kvm';
import { parseWeatherQuery, WeatherService, type WeatherDay } from './weather';
import { HEALTH_TEXT, healthIsProblem, type VoiceHealth } from './voice/health';
import { personaContext, voiceDialect } from '../shared/persona';
import { Greeter, inQuietHours } from './greeter';
import { Announcer, announceReply } from './announce';
import { LOCKED_REPLY, RemotePresence } from './remote-presence';
import { CLEAR_HISTORY_NOTE, clearHistoryFiles, idleClearDue, ORPHAN_AGE_MS, type HistoryPaths } from './history';
import { addDuckRecords, readDuckRecords, removeDuckRecords } from './duck-records';
import { parseLocalAnnouncement } from '../shared/announce';
import { WhatsAppClient } from './whatsapp/client';
import { RemoteBridge } from './whatsapp/bridge';
import { launcherDepsFor, sessionHelperFor, skillDirs, skillRegistryFor, toolHelperFor } from './composition';
import type { SkillRegistry } from './skills';
import { acceptGreetingReply, followUpLooksLikeMedia, MediaWatch } from './media-watch';
import { EmailService } from './email/service';
import { browserName, openInBrowser } from './open-url';
import { chooseUrl, displayUrl, PENDING_URL_MS, spokenUrlCandidates } from '../shared/spoken-url';
import { hostProblem } from '../shared/web-guard';
import { connectGmailOAuth, looksLikeClientId, parseClientJson, revokeGmailToken } from './email/gmail-api';
import { ImapBackend } from './email/imap';
import { isPersonalGmail } from '../shared/email';
import { appLabel, exeName, micUsersNow } from './mic-usage';
import { classifyGreetingReply, COMEBACKS } from '../shared/greetings';
import { displayName as assistantName } from '../shared/assistant';
import { toSpokenText } from '../shared/spoken-text';
import { ALL_VOICES, CURATED_VOICES, PREVIEW_LINE, voiceById } from '../shared/voices';
import { resolveAppIcon } from './apps/icons';
import { ToolHost, frameForRect, type Controls, type Effects, type RunState } from './tools';
import { UnavailableVoiceEngine, type VoiceEngine, type VoiceUtterance } from './voice/engine';
import { SherpaVoiceEngine } from './voice/sherpa-engine';
import { ConversationController } from './conversation';
import { ACTING_HUD_HEIGHT, createPanel, OverlayManager, PANEL_SIZE, sendPanel, setAssistantLabel, SUMMON_GLASS_MS } from './windows';
import { AppIndex } from './apps/app-index';
import { launchApp, type WinInfo } from './apps/launcher';
import { isConfident, parseLaunchIntent, type AppEntry } from '../shared/apps';
import { bindingAccelerator, bindingToHelper, formatBinding } from '../shared/binding';
import { greeting } from '../shared/smalltalk';
import { runInTerminal } from './terminal-runner';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { ActivityRouter, type ActivityChannel } from './activity';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AppOptions {
  demoLive: boolean;
  hidden: boolean;
  /** Automated visual self-test: no content protection so the helper can screenshot Cadabra's own windows. */
  selftest?: boolean;
  /** Live-readiness harness (`npm run e2e:live`): real backend, no onboarding. */
  e2e?: boolean;
  /** Round 10: `--greettest` (greeting timings; fake mic, muted). */
  greetTest?: boolean;
  /**
   * Where the Codex/Gemini private homes (their own sign-ins) live. The harness
   * runs on its OWN userData (AUTH-2) but may reuse those logins.
   */
  providerHomes?: string;
}

export function resourcePath(...p: string[]): string {
  return app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(here, '../../resources', ...p);
}

export function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'cadabra-helper.exe')
    : path.join(here, '../../native/cadabra-helper/target/release/cadabra-helper.exe');
}

export class CadabraApp {
  readonly settings: SettingsStore;
  helper: HelperClient | null = null;
  panel: BrowserWindow | null = null;
  overlays!: OverlayManager;
  tray: Tray | null = null;
  readonly gate: SafetyGate;
  readonly tools: ToolHost;
  readonly providers: Record<ProviderId, ProviderAdapter>;
  readonly appIndex: AppIndex;
  private iconCache = new Map<string, string | null>();
  voice: VoiceEngine;
  voiceState: VoiceState = 'off';

  private mcp: McpHttpHandle | null = null;
  private target: TargetWindow | null = null;
  private summonShot: { data: string; width: number; height: number; rect: Rect; scale: number } | null = null;
  /** The conversation state machine (testable without Electron). */
  readonly conv: ConversationController;
  private confirms = new Map<string, (ok: boolean | 'always') => void>();
  private panelVisible = false;
  private panelOrigin: Point = { x: 0, y: 0 };
  private ghostPos: Point | null = null;
  private ghostDisplay: number | null = null;
  private authCache = new Map<ProviderId, { at: number; auth: AuthStatus; models: ModelOption[] }>();
  private quitting = false;
  /** Round 8: spoken welcome greetings (sign-in, unlock, back after being away). */
  readonly greeter: Greeter;
  /** Until when a voice follow-up is a reply to a greeting (voice-only, no panel). */
  private greetWindowUntil = 0;
  private sessionLocked = false;
  /** Round 12: WhatsApp remote access. */
  readonly waClient: WhatsAppClient;
  readonly remote: RemoteBridge;
  readonly remoteConv: ConversationController;
  private remoteReply = '';
  private remoteImage: { data: string; mimeType: string } | undefined;
  /** Which conversation last used the backend session (local panel/voice or WhatsApp). */
  private lastChannel: 'local' | 'remote' = 'local';
  /** Round 11: the "Don't ask" reminder was shown this session. */
  private trustReminded = false;
  /** Round 10.5: is another app playing sound (a video) around the wake-free windows? */
  /** Round 11.6: helper-backed session lookups (tested factory; explicit nulls without a helper). */
  readonly session = sessionHelperFor(() => this.helper);
  readonly media = new MediaWatch(() => this.session.audioSessions(app.getAppMetrics().map((m) => m.pid)));
  /** When the current wake-free window opened (for "started late" checks). */
  private followArmedAt = 0;

  /** Round 10.5: true (and logged) when a wake-free window must not open because media is playing. */
  private mediaBlocksWindow(what: string): boolean {
    const exe = this.media.playing();
    if (!exe) return false;
    console.log(`[voice] ${what} skipped: media playing (${exe})`);
    return true;
  }
  /** Round 8: read-only Gmail. */
  readonly email: EmailService;

  constructor(private readonly opts: AppOptions) {
    installLogCapture(app.getPath('userData'));
    this.settings = new SettingsStore(app.getPath('userData'), safeStorage);
    setAssistantLabel(assistantName(this.settings.get().voice.wakeWord));
    // Round 12.5: a WhatsApp run carries its own autonomy level (GateRun.autonomy); no global flag here.
    this.gate = new SafetyGate(() => this.settings.get().safety, { confirm: (p, s) => this.confirm(p, s) }, Date.now, {
      add: (g) => {
        const s = this.settings.get().safety;
        this.settings.update({ safety: { ...s, grants: [...(s.grants ?? []).filter((x) => !(x.scope === g.scope && x.cls === g.cls)), g] } });
        console.log(`[gate] "always allow" granted (${g.cls})`);
      },
    });
    this.appIndex = new AppIndex(app.getPath('userData'), { readShortcutLink: (p) => shell.readShortcutLink(p) });
    this.greeter = new Greeter({
      now: () => Date.now(),
      settings: () => this.settings.get().greetings,
      name: () => {
        const n = this.settings.get().displayName;
        return n && !looksLikeHandle(n) ? n.split(/\s+/)[0] : '';
      },
      dialect: () => {
        const v = this.settings.get().voice;
        if (!v.phrasing) return null;
        const d = voiceDialect(v);
        return d === 'british' || d === 'southern' ? d : null;
      },
      // Test / demo / e2e runs never greet (they must stay silent).
      voiceReady: () => {
        const s = this.settings.get();
        return (!this.opts.demoLive || !!this.opts.greetTest) && !this.opts.e2e && !this.opts.selftest && s.voice.enabled && !s.paused && s.voice.speakReplies !== 'never' && this.voice instanceof SherpaVoiceEngine && !this.sessionLocked;
      },
      // 0.9.8: also while a WhatsApp request runs (waking the display looks like "back at the PC").
      userBusy: () => this.panelVisible || this.conv.busy || !!this.remote?.busy || this.voiceState === 'transcribing' || this.voiceState === 'followup',
      presence: () => this.session.presence(),
      micUsers: () => this.micUsers(),
      speak: async (t) => {
        // Round 10: play the pre-rendered line if it's ready, else synthesise live.
        if (this.voice instanceof SherpaVoiceEngine && (await this.voice.playPrerendered(t))) return;
        await this.speakAndWait(t);
      },
      prerender: async (t) => (this.voice instanceof SherpaVoiceEngine ? this.voice.prerender(t) : false),
      armActivity: (on) => void this.armActivity(on),
      openWindow: (ms) => {
        if (!(this.voice instanceof SherpaVoiceEngine)) return;
        // Round 10.5: with a video / music playing, the greeting just plays (no banter window).
        if (this.mediaBlocksWindow('greeting window')) return;
        this.greetWindowUntil = Date.now() + ms + 1500;
        // R8-5: strict — only speech near the user's own level starts a reply.
        this.voice.armFollowUp(ms, true);
      },
      saveRecent: (recent) => this.settings.update({ greetings: { ...this.settings.get().greetings, recent } }),
      log: (m) => console.log(m),
    });
    this.tools = new ToolHost(
      // Round 11.6: built by a tested factory (every member reaches the helper).
      toolHelperFor(() => this.h()),
      this.gate,
      this.effects(),
      this.controls(),
      {
        find: async (q, limit) => {
          await this.appIndex.ready();
          return this.appIndex.find(q, limit).map((m) => ({ id: m.app.id, name: m.app.name, source: m.app.source, score: m.score }));
        },
        launch: async (id, o) => {
          const a = this.appIndex.get(id);
          if (!a) return `Unknown app id ${id}; call find_apps.`;
          return this.launchIndexedEx(a, o.focusExisting);
        },
        launchPath: async (file, args) => {
          // Only reached after the safety gate got the user's OK. Never elevated.
          const p = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
          p.unref();
          return `Started ${path.basename(file)}.`;
        },
      },
      {
        run: async (command, caption, signal) => {
          const res = await runInTerminal(command, {
            signal,
            listWindows: () => this.h().call<WinInfo[]>('list_windows'),
            onWindow: (w) => {
              // Ghost cursor glides to the new terminal while the command runs.
              const p = { x: Math.round(w.rect.x + Math.min(w.rect.width / 2, 260)), y: Math.round(w.rect.y + Math.min(w.rect.height / 2, 120)) };
              void this.effects().ghostMoveTo(p, caption, signal).then(() => this.effects().ghostClick(p));
            },
          });
          return { output: res.output, exitCode: res.exitCode, terminal: res.terminal, timedOut: res.timedOut };
        },
      },
    );
    this.providers = { claude: this.makeProvider('claude'), copilot: this.makeProvider('copilot'), codex: this.makeProvider('codex'), gemini: this.makeProvider('gemini'), demo: this.makeProvider('demo') };
    // Round 7: web access + weather for the tools (get_weather) and the web guard.
    this.tools.web = {
      enabled: () => this.settings.get().webAccess,
      weather: async (city, day) => {
        const c = city ?? this.settings.get().location;
        if (!c) return 'No location is set. Ask the user which city to use.';
        const r = await this.weather.lookup(c, day);
        return 'error' in r ? r.error : r.text;
      },
    };
    // Round 8: lock the PC, open web pages, read-only email.
    this.tools.system = {
      lockPc: () => this.lockPc(true),
      micInUse: async () => (await this.micUsers()).length > 0,
      resolves: (host) => this.hostResolves(host),
      openUrl: (url, browser) => {
        if (this.opts.demoLive || this.opts.e2e) return Promise.resolve('Not opened: this is a test run.');
        console.log(`[open_url] opening${browser ? ` in ${browser}` : ''}`);
        return openInBrowser(url, browser, (u) => shell.openExternal(u));
      },
    };
    this.email = new EmailService({
      settings: () => this.settings.get().email,
      secrets: () => ({ refreshToken: this.settings.getSecret('gmailRefreshToken'), clientSecret: this.settings.getSecret('gmailClientSecret'), appPassword: this.settings.getSecret('gmailAppPassword') }),
      now: () => new Date(),
      log: (m) => console.log(m),
    });
    this.tools.email = {
      connected: () => this.email.connected(),
      allowBodies: () => this.settings.get().email.allowBodies,
      search: (q) => this.email.search(q),
      read: (id) => this.email.read(id),
      link: (id) => this.email.link(id),
    };
    this.conv = new ConversationController(this.convHost());
    // Round 12: WhatsApp (remote access). Same backend and tools, its own conversation.
    this.waClient = new WhatsAppClient(() => this.settings.getSecret('whatsappToken'));
    this.remoteConv = new ConversationController(this.remoteConvHost());
    this.remote = new RemoteBridge({
      client: this.waClient,
      active: () => {
        const s = this.settings.get();
        return s.remote.enabled && !s.paused && this.settings.hasSecret('whatsappToken') && !this.opts.demoLive && !this.opts.e2e;
      },
      state: () => ({ offset: this.settings.get().remote.offset, pairedFrom: this.settings.get().remote.pairedFrom }),
      saveState: (p) => this.settings.update({ remote: { ...this.settings.get().remote, ...p } }),
      log: (m) => console.log(m),
      showPairingCode: (code) => {
        const text = `WhatsApp pairing code: ${code}. Send it in your agent chat in WhatsApp (valid 5 minutes).`;
        if (this.panelVisible) sendPanel(this.panel, { type: 'notice', text, tone: 'info' });
        this.tray?.displayBalloon?.({ title: 'Cadabra — WhatsApp', content: text, noSound: true });
      },
      locked: () => this.sessionLocked,
      busyLocal: () => this.conv.busy,
      handle: (text, ctx) => this.handleRemote(text, ctx),
      announce: async (text, signal) => announceReply(await this.announcer.announce(text, 'whatsapp', signal)),
      stop: () => {
        // Round 12.6 (F1): a remote "stop" also cancels in-progress typing / clicks, like Esc.
        void this.helper?.cancelInput(this.tools.runOf('whatsapp')?.id ?? this.helper.inputEpoch).catch(() => undefined);
        this.remoteConv.cancel('Stopped from WhatsApp.');
      },
      name: () => assistantName(this.settings.get().voice.wakeWord),
      transcribe: async (bytes) => (this.voice instanceof SherpaVoiceEngine ? this.voice.transcribeAudio(bytes) : null),
    });
    this.tools.remote = { sendScreenshot: (caption) => this.sendScreenshotToWhatsApp(caption) };
    // 0.9.5: skills (built-in + the user's own folder), hot-reloaded, offered to every backend.
    this.skills = skillRegistryFor({
      dirs: this.skillDirs(),
      settings: this.settings,
      toolNames: () => this.tools.definitions().map((d) => d.name),
      log: (l) => console.log(l),
    });
    try {
      this.skills.ensureUserFolder();
    } catch (e) {
      console.warn(`[skills] couldn't create the skills folder: ${(e as Error).message}`);
    }
    this.skills.reload();
    this.skills.watch();
    this.skills.onChange(() => sendPanel(this.panel, { type: 'skills-changed' }));
    this.tools.skills = this.skills;
    this.tools.announcer = this.announcer;
    this.tools.presence = { screen: () => this.presence.ensureScreen(), state: async () => (this.helper ? this.helper.desktopState().catch(() => null) : null) };
    this.applyKeepAwake();
    this.settings.onChange(() => this.applyKeepAwake());
    this.startupHistoryCleanup();
    const models = resourcePath('models');
    this.voice = fs.existsSync(path.join(models, 'kws'))
      ? new SherpaVoiceEngine({ modelsDir: models, userData: app.getPath('userData'), settings: () => this.settings.get().voice, asrDirOverride: process.env.CADABRA_ASR_DIR, openaiKey: () => this.settings.getSecret('openaiApiKey') })
      : new UnavailableVoiceEngine('Voice models are missing from this build (resources/models).');
  }

  /** One provider instance (also used for isolated connection tests, N8). */
  private makeProvider(id: ProviderId): ProviderAdapter {
    const work = path.join(app.getPath('userData'), 'agent-work');
    const version = app.getVersion();
    const s = () => this.settings.get();
    switch (id) {
      case 'claude':
        return new ClaudeProvider({
          tools: () => this.tools.definitions(),
          apiKey: () => this.settings.getSecret('anthropicApiKey'),
          exePath: () => s().cli.claudePath,
          workDir: work,
          version,
          route: () => s().claudeRoute,
          apiWeb: () => s().claudeApiWeb,
          // AUTH-1 layer 3: an empty, Cadabra-owned config dir for the API-key runtime.
          configDir: path.join(app.getPath('userData'), 'claude-api-config'),
          mcp: () => this.ensureMcp(),
          revokeSession: (k) => this.tools.revokeSession(k),
          issueSession: (k) => this.tools.issueSession(k),
          openLoginTerminal: (exe) => openLoginTerminal(exe),
          webAccess: () => s().webAccess,
          webGuard: (t, x) => this.tools.webGuard(t, x),
        });
      case 'copilot':
        return new CopilotProvider({ tools: () => this.tools.definitions(), exePath: () => s().cli.copilotPath, workDir: work });
      case 'codex':
        return new CodexProvider({
          exePath: () => s().cli.codexPath,
          mcp: () => this.ensureMcp(),
          workDir: work,
          homeDir: path.join(this.opts.providerHomes ?? app.getPath('userData'), 'codex-home'),
          version,
          revokeSession: (k) => this.tools.revokeSession(k),
          issueSession: (k) => this.tools.issueSession(k),
          webAccess: () => s().webAccess,
          webGuard: (t, x) => this.tools.webGuard(t, x),
        });
      case 'gemini':
        return new GeminiProvider({
          exePath: () => s().cli.geminiPath,
          mcp: () => this.ensureMcp(),
          workDir: work,
          homeDir: path.join(this.opts.providerHomes ?? app.getPath('userData'), 'gemini-home'),
          apiKey: () => this.settings.getSecret('geminiApiKey'),
          version,
          revokeSession: (k) => this.tools.revokeSession(k),
          issueSession: (k) => this.tools.issueSession(k),
          webAccess: () => s().webAccess,
          webGuard: (t, x) => this.tools.webGuard(t, x),
        });
      case 'demo':
        return new DemoProvider(() => this.demoEffects());
    }
  }

  private h(): HelperClient {
    if (!this.helper?.running) throw new Error('Native helper is not running');
    return this.helper;
  }

  private async ensureMcp() {
    if (!this.mcp)
      this.mcp = await startMcpHttp(
        () => this.tools.definitions(),
        app.getVersion(),
        (k) => this.tools.checkSession(k),
        // Round 7: Claude Code's web tools ask here first (fail-closed).
        (name, input) => (name === 'WebSearch' ? this.tools.webGuard('search', String(input?.query ?? '')) : name === 'WebFetch' ? this.tools.webGuard('fetch', String(input?.url ?? '')) : Promise.resolve({ allow: false, reason: 'Only web search and web fetch are allowed.' })),
      );
    return this.mcp;
  }

  reducedMotion(): boolean {
    const m = this.settings.get().motion;
    if (m === 'reduced') return true;
    if (m === 'full') return false;
    try {
      return systemPreferences.getAnimationSettings().prefersReducedMotion;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ init --

  async init(): Promise<void> {
    if (this.opts.demoLive) this.settings.update({ provider: 'demo' });
    this.overlays = new OverlayManager(!this.opts.selftest);
    this.overlays.rebuild();
    this.panel = createPanel({ contentProtection: !this.opts.demoLive && !this.opts.selftest });
    this.wirePanel();
    this.wireIpc();
    this.createTray();
    this.settings.onChange(() => this.refreshTray());
    app.setLoginItemSettings({ openAtLogin: this.settings.get().launchAtLogin, args: ['--hidden'] });

    console.log(`[app] Cadabra ${app.getVersion()} starting (Electron ${process.versions.electron}, ${os.release()}, ${app.isPackaged ? 'installed' : 'dev'}${this.opts.demoLive ? ', demo/test mode' : ''})`);
    this.cleanStaleSessionFiles();
    const exe = helperPath();
    if (fs.existsSync(exe)) {
      // Test, demo and e2e runs never install the summon hook (they mustn't fight the user's own Cadabra for Ctrl+~).
      this.helper = new HelperClient(exe, this.opts.demoLive || this.opts.e2e ? ['--no-hook'] : []);
      this.helper.on('summon', (ev: SummonEvent) => void this.onSummon(ev));
      this.helper.on('escape', () => this.onEscape());
      this.helper.on('ptt', (down: boolean) => {
        const v = this.settings.get().voice;
        if (!(v.enabled && v.pushToTalk && !this.settings.get().paused && this.voice instanceof SherpaVoiceEngine)) return;
        console.log(`[voice] push-to-talk ${down ? 'down' : 'up'} (voice ${this.voice.health})`);
        // Round 4.5: never pretend to listen. If voice isn't hearing the mic, say why.
        if (!this.voice.setPushToTalk(down) && down) this.voiceProblemNotice(true);
      });
      this.helper.on('log', (m: string) => console.log(m));
      this.helper.on('session', (kind: string) => void this.onSessionEvent(kind));
      this.helper.on('activity', (src: string) => this.onInputActivity(src));
      this.helper.on('hook', (m: any) => {
        if (m.status !== 'installed') console.warn('hook:', m);
        void this.helper?.setHookEnabled(!this.settings.get().paused).catch(() => undefined);
      });
      // H1: re-apply all helper-side state on EVERY (re)start, not just the first.
      this.helper.on('ready', () => {
        this.helperState = 'ok';
        void this.applyHelperState();
        void this.restoreDuckedAudio();
      });
      this.helper.on('restarting', () => {
        this.helperState = 'restarting';
        this.refreshTray();
      });
      this.helper.on('dead', () => {
        this.helperState = 'dead';
        this.refreshTray();
      });
      try {
        await this.helper.start();
      } catch (e) {
        console.error('helper failed to start', e);
      }
    } else {
      console.error('native helper missing:', exe);
    }
    // Round 12: the WhatsApp long-poll loop (idle unless remote access is on and a token is stored).
    this.remote.start();
    // Demo/test modes never start voice on their own (the voice tests enable it explicitly).
    if (this.settings.get().voice.enabled && !this.opts.demoLive) void this.startVoice();
    // Natural voice: warm the model in its worker so the first spoken reply is quick.
    if (this.voice instanceof SherpaVoiceEngine && this.settings.get().voice.enabled && this.settings.get().voice.speakReplies !== 'never') this.voice.tts.prewarm(this.settings.get().voice.ttsVoice);
    // Handle-like account names ("jdoe") are never used to greet; onboarding asks instead.
    if (!this.settings.get().displayName) void detectDisplayName().then((n) => n && !looksLikeHandle(n, os.userInfo().username) && !this.settings.get().displayName && this.settings.update({ displayName: n }));
    // #7: first run opens the onboarding flow.
    if (!this.settings.get().onboarded && !this.opts.demoLive && !this.opts.selftest && !this.opts.e2e) setTimeout(() => void this.openOnboarding(), 600);
    // App index: refresh in the background (cached between runs).
    setTimeout(
      () => {
        if (this.appIndex.stale || !this.appIndex.apps.length) void this.appIndex.refresh();
      },
      this.appIndex.apps.length ? 15_000 : 3_000,
    );
    setInterval(() => void this.appIndex.refresh(), 6 * 3600_000).unref();
    if (this.opts.demoLive && !this.opts.selftest) setTimeout(() => void this.openAtCursor(), 800);
    // Round 8: greetings. Started at sign-in (launch at login passes --hidden): greet once voice is up.
    if (this.opts.hidden && !this.opts.e2e && !this.opts.demoLive && process.uptime() < 600) setTimeout(() => void this.greeter.onLogin(), 12_000);
    // Away detection: input idle time (GetLastInputInfo). With Input Director,
    // working on another PC counts as away from this one.
    setInterval(() => {
      if (!this.helper || this.sessionLocked || this.opts.demoLive || this.opts.e2e) return;
      void this.session
        .inputState()
        .then((st) => st && void this.greeter.tick(st.idleMs))
        .catch(() => undefined);
    }, 30_000).unref();
  }

  /** Round 10: when the first greeting audio plays after an event (latency log). */
  private greetEventAt = 0;
  /** Round 10: polling fallback for return detection when the helper has no hooks (test runs). */
  private activityPoll: NodeJS.Timeout | null = null;

  /** Round 10: ask the helper for the first input once (hooks), or poll quickly without hooks. */
  private async armActivity(on: boolean) {
    if (this.activityPoll) clearInterval(this.activityPoll);
    this.activityPoll = null;
    const hooks = await this.session
      .armActivity(on)
      .then((r) => !!r?.hooks)
      .catch(() => false);
    if (!on || hooks || !this.helper) return;
    this.activityPoll = setInterval(() => {
      void this.session
        .inputState()
        .then((st) => {
          if (st && st.idleMs < 1000) this.onInputActivity('poll');
        })
        .catch(() => undefined);
    }, 250);
    this.activityPoll.unref();
  }

  /** Round 10: the user is back (first keyboard / mouse input after being away). */
  onInputActivity(source: string) {
    if (this.activityPoll) clearInterval(this.activityPoll);
    this.activityPoll = null;
    const at = Date.now();
    if (!this.greeter.isAway) return;
    console.log(`[greet] back (first input: ${source})`);
    this.greetEventAt = at;
    void this.greeter.onActivity(at);
  }

  /** Round 8: Windows session changes (lock / unlock / sign-in) from the helper. */
  private async onSessionEvent(kind: string) {
    const at = Date.now();
    console.log(`[session] ${kind}`);
    if (kind === 'lock') {
      this.sessionLocked = true;
      this.greetWindowUntil = 0;
      // Pause voice while locked: nobody should be able to talk to the PC through the lock screen.
      if (this.panelVisible) this.dismiss();
      if (this.settings.get().voice.enabled) await this.stopVoice();
      // The speech model stays loaded while locked (the next greeting is pre-rendered).
      this.greeter.onSession('lock');
      return;
    }
    if (kind === 'unlock') {
      this.sessionLocked = false;
      // Round 10: greet first (pre-rendered audio plays at once); listening restarts in parallel.
      this.greetEventAt = at;
      void this.greeter.onSession('unlock', at);
      if (this.settings.get().voice.enabled && !this.settings.get().paused && (!this.opts.demoLive || this.opts.greetTest)) void this.startVoice();
      return;
    }
    if (kind === 'logon') void this.greeter.onSession('logon');
  }

  /** Round 8: what the user said right after a greeting. */
  private async onGreetingReply(req: string): Promise<void> {
    this.greetWindowUntil = 0;
    const kind = classifyGreetingReply(req);
    console.log(`[greet] reply: ${kind}`);
    if (kind === 'playful') {
      await this.speakAndWait(COMEBACKS[Math.floor(Math.random() * COMEBACKS.length)]);
      return;
    }
    if (kind === 'request') {
      const intent = parseIntent(req, { models: (await this.providerInfo(this.settings.get().provider, false)).models });
      if (intent) {
        const msg = await this.applyIntent(intent);
        this.tray?.displayBalloon?.({ title: 'Cadabra', content: msg.replace(/\*\*/g, ''), noSound: true });
        return;
      }
      await this.openAtCursor(req);
    }
    // closing / empty: silence; the window just ends.
  }

  // ------------------------------------------------------------- summon ----

  private toDip(p: Point): Point {
    try {
      return screen.screenToDipPoint(p);
    } catch {
      return p;
    }
  }

  private physRectToDip(r: Rect): Rect {
    try {
      return screen.screenToDipRect(null, r);
    } catch {
      const maps: DisplayMap[] = screen.getAllDisplays().map((d) => ({
        bounds: d.bounds,
        physical: { x: d.bounds.x * d.scaleFactor, y: d.bounds.y * d.scaleFactor, width: d.size.width * d.scaleFactor, height: d.size.height * d.scaleFactor },
        scaleFactor: d.scaleFactor,
      }));
      return physicalRectToDip(r, maps);
    }
  }

  private isOwnWindow(ev: { pid?: number; hwnd: number }): boolean {
    if (ev.pid && (ev.pid === process.pid || app.getAppMetrics().some((m) => m.pid === ev.pid))) return true;
    return false;
  }

  async onSummon(ev: SummonEvent, voicePrompt?: string): Promise<void> {
    if (this.settings.get().paused && !voicePrompt) return;
    const byKey = (ev as any).trigger === 'key';
    // The shortcut toggles: pressing it again while the panel is open closes it.
    if (byKey && this.panelVisible && !voicePrompt) {
      if (this.conv.busy) this.cancelRun('Stopped.');
      this.dismiss();
      return;
    }
    if (byKey) {
      // REVIEW-2 #6: hold any keystrokes typed right after the shortcut until the
      // panel has focus; they are moved into its input (none reach the user's app).
      void this.helper?.call('buffer_keys', { ms: 900 }).catch(() => undefined);
      this.bufferedSummon = true;
      await this.summonFromKeyboard(ev);
      return;
    }
    if (this.isOwnWindow(ev)) return;
    const target: TargetWindow | null = ev.hwnd
      ? {
          hwnd: ev.hwnd,
          title: ev.title ?? '',
          process: ev.process ?? '',
          className: ev.className,
          pid: ev.pid,
          rect: ev.rect ?? { x: ev.x, y: ev.y, width: 1, height: 1 },
          dpi: ev.dpi,
          elevated: (ev as any).elevated ?? null,
        }
      : null;
    await this.showPanelAt({ x: ev.x, y: ev.y }, target, voicePrompt);
  }

  /**
   * Keyboard summon has no click point: open near the mouse if it's over the
   * foreground window, else at the text caret (Win32 caret or UIA focused
   * element), else centered in the foreground window. The scan traces the
   * foreground window; the ripple starts wherever the panel springs from.
   */
  private async summonFromKeyboard(ev: SummonEvent) {
    const cursor = { x: ev.x, y: ev.y };
    const fgValid = !!ev.hwnd && !this.isOwnWindow(ev) && !/^(Progman|WorkerW|Shell_TrayWnd|Shell_SecondaryTrayWnd)$/.test(ev.className ?? '');
    if (!fgValid) {
      await this.showPanelAt(cursor, null);
      return;
    }
    const r = ev.rect ?? { x: ev.x, y: ev.y, width: 1, height: 1 };
    const target: TargetWindow = { hwnd: ev.hwnd, title: ev.title ?? '', process: ev.process ?? '', className: ev.className, pid: ev.pid, rect: r, dpi: ev.dpi, elevated: (ev as any).elevated ?? null };
    const inside = cursor.x >= r.x && cursor.y >= r.y && cursor.x < r.x + r.width && cursor.y < r.y + r.height;
    let anchor = cursor;
    if (!inside) {
      anchor = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      try {
        const caret = await this.h().call<{ rect: Rect } | null>('caret_rect', { hwnd: ev.hwnd }, 1500);
        const c = caret?.rect;
        if (c && c.x >= r.x - 4 && c.y >= r.y - 4 && c.x <= r.x + r.width && c.y <= r.y + r.height) anchor = { x: c.x + Math.min(c.width, 40), y: c.y + c.height };
      } catch {
        /* centered in the window */
      }
    }
    await this.showPanelAt(anchor, target);
  }

  /** Helper process health, for the tray (H4). */
  helperState: 'ok' | 'restarting' | 'dead' = 'ok';

  /** Everything the helper must know; re-sent after every helper restart (H1). */
  async applyHelperState() {
    const h = this.helper;
    if (!h?.running) return;
    const s = this.settings.get();
    await h.setHookEnabled(!s.paused).catch(() => undefined);
    await this.applyBinding();
    await h.call('set_ptt_enabled', { enabled: s.voice.enabled && s.voice.pushToTalk }).catch(() => undefined);
    if (this.panel && !this.panel.isDestroyed()) {
      const hwnd = Number(this.panel.getNativeWindowHandle().readBigUInt64LE(0));
      await h.call('style_window', { hwnd, border: 'none', round: true }).catch(() => undefined);
    }
    this.refreshTray();
  }

  /** Push the configured summon shortcut to the helper (applies instantly). */
  async applyBinding() {
    try {
      await this.helper?.call('set_binding', bindingToHelper(this.settings.get().summon));
    } catch (e) {
      console.warn('set_binding failed', (e as Error).message);
    }
    this.refreshTray();
  }

  /** Tray "Open" / demo: summon at the mouse on whatever window is under it. */
  async openAtCursor(voicePrompt?: string): Promise<void> {
    let phys: Point;
    try {
      phys = await this.h().cursorPos();
    } catch {
      phys = screen.dipToScreenPoint(screen.getCursorScreenPoint());
    }
    let info: any = null;
    try {
      info = await this.h().call('window_at', { ...phys });
    } catch {
      /* no helper */
    }
    if (info?.hwnd && !this.isOwnWindow(info) && !/^(Shell_TrayWnd|Shell_SecondaryTrayWnd|NotifyIconOverflowWindow)$/.test(info.className ?? '')) {
      await this.onSummon({ event: 'summon', x: phys.x, y: phys.y, ...info }, voicePrompt);
    } else {
      await this.showPanelAt(phys, null, voicePrompt);
    }
  }

  async showPanelAt(phys: Point, target: TargetWindow | null, voicePrompt?: string): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    if (this.conv.busy) {
      // Busy: bring the panel back where it was (keeps the run going).
      const info = await this.providerInfo(this.settings.get().provider, false);
      sendPanel(panel, { type: 'summon', origin: this.panelOrigin, target: this.target ? { title: this.target.title, process: this.target.process } : null, provider: info, model: this.currentModel(), reducedMotion: this.reducedMotion(), fresh: false });
      await this.revealPanel(this.reducedMotion());
      this.panelVisible = true;
      this.deliverBufferedKeys();
      return;
    }
    const reduced = this.reducedMotion();
    const cursor = this.toDip(phys);
    const display = screen.getDisplayNearestPoint({ x: Math.round(cursor.x), y: Math.round(cursor.y) });
    const rect = placePanel(cursor, PANEL_SIZE, display.workArea);
    this.panelOrigin = { x: cursor.x - rect.x, y: cursor.y - rect.y };
    const fresh = this.conv.summon(target?.hwnd ?? null, { voice: !!voicePrompt });
    this.target = target;
    rememberWindowTitle(target?.title, target?.process);
    this.summonShot = null;

    // Magic: ripple + sparks at the click, outline scan around the window.
    this.overlays.send(display, { type: 'summon', at: this.overlays.local(display, cursor), panel: this.overlays.localRect(display, rect), reducedMotion: reduced });
    const glassStart = Date.now();
    if (target && target.rect.width > 4) {
      const wr = this.physRectToDip(target.rect);
      const wd = screen.getDisplayMatching({ x: Math.round(wr.x), y: Math.round(wr.y), width: Math.round(wr.width), height: Math.round(wr.height) });
      setTimeout(() => this.overlays.send(wd, { type: 'scan', rect: this.overlays.localRect(wd, wr), reducedMotion: reduced, avoid: this.overlays.localRect(wd, rect) }), reduced ? 0 : 90);
    }

    const info = await this.providerInfo(this.settings.get().provider, false);
    panel.setBounds(rect);
    sendPanel(panel, {
      type: 'summon',
      origin: this.panelOrigin,
      target: target ? { title: target.title, process: target.process } : null,
      provider: info,
      model: this.currentModel(),
      reducedMotion: reduced,
      fresh,
      voicePrompt,
      elevated: !!target?.elevated,
    });
    // REVIEW-2 #6: show and focus the real panel IMMEDIATELY (transparent while
    // the overlay grows the glass on top of it), then make it visible as the
    // glass lands. Typing goes into the panel from the first keystroke.
    if (!reduced) panel.setOpacity(0);
    await this.revealPanel(reduced, !voicePrompt);
    this.panelVisible = true;
    if (this.settings.get().voice.enabled) this.voiceProblemNotice();
    // Round 11: a gentle once-per-session reminder in "Don't ask" mode.
    if (this.settings.get().safety.autonomy === 'none' && !this.trustReminded) {
      this.trustReminded = true;
      sendPanel(this.panel, { type: 'notice', text: 'Full trust is on: I won’t ask before running commands, opening programs or sending anything, even if a web page or email tries to trick me (Settings → Safety). Esc stops me any time.', tone: 'info' });
    }
    this.deliverBufferedKeys();
    if (!reduced) {
      await sleep(Math.max(0, SUMMON_GLASS_MS - (Date.now() - glassStart)));
      if (!panel.isDestroyed()) panel.setOpacity(1);
    }

    // Capture what the user is looking at (Cadabra's windows are excluded from capture).
    if (target) void this.captureTarget(target);
    void this.providers[this.settings.get().provider].prewarm?.(this.currentModel()).catch(() => undefined);
    if (voicePrompt) void this.send(voicePrompt, 'voice');
  }

  /**
   * Show the panel. The fade never waits on the helper (H3); taking focus is
   * best-effort and capped at 300 ms. Voice summons don't steal focus (C2).
   */
  private async revealPanel(reduced: boolean, takeFocus = true) {
    const panel = this.panel!;
    const hwnd = Number(panel.getNativeWindowHandle().readBigUInt64LE(0));
    panel.setOpacity(1);
    if (takeFocus) panel.show();
    else panel.showInactive();
    panel.moveTop();
    if (takeFocus) {
      const focus = this.helper?.foreground(hwnd).catch(() => undefined);
      await Promise.race([focus, sleep(300)]);
      panel.focus();
    }
    // Drop the Win11 accent focus border (re-applied by the system on activation).
    void this.helper?.call('style_window', { hwnd, border: 'none' }).catch(() => undefined);
    void reduced;
  }

  private async captureTarget(target: TargetWindow) {
    const v = checkObservation(this.settings.get().safety, target.process, target.title);
    if (v.decision === 'block') {
      sendPanel(this.panel, { type: 'notice', text: `${v.reasons[0]}.`, tone: 'warn' });
      return;
    }
    try {
      await sleep(40); // let content protection apply before capturing
      const cap = await this.h().capture({ hwnd: target.hwnd, maxSize: 1568 });
      if (this.target === target) this.summonShot = { data: cap.png, width: cap.width, height: cap.height, rect: cap.rect, scale: cap.scale };
    } catch (e) {
      console.warn('capture failed', (e as Error).message);
    }
  }

  dismiss(): void {
    const panel = this.panel;
    if (!panel || !this.panelVisible) return;
    this.panelVisible = false;
    const reduced = this.reducedMotion();
    sendPanel(panel, { type: 'dismiss' });
    const b = panel.getBounds();
    const d = screen.getDisplayMatching(b);
    this.overlays.send(d, {
      type: 'dismiss',
      to: this.overlays.local(d, { x: b.x + this.panelOrigin.x, y: b.y + this.panelOrigin.y }),
      panel: this.overlays.localRect(d, b),
      reducedMotion: reduced,
    }, 900);
    this.overlays.broadcast({ type: 'clear-highlights' });
    // UX3: the panel steps aside at once and the overlay collapses the glass
    // back into the summon point (no setOpacity stepping on the main thread).
    const full = this.actingFull;
    this.actingFull = null;
    void (async () => {
      if (!reduced) await sleep(40);
      if (!panel.isDestroyed() && !this.panelVisible) panel.hide();
      if (full && !panel.isDestroyed()) {
        panel.setBounds(full, false);
        sendPanel(panel, { type: 'acting', on: false });
      }
    })();
  }

  private onEscape(): void {
    // 0.9.6: Esc cuts an announcement short.
    if (this.announcer.busy) {
      this.announcer.stop();
      if (this.voice instanceof SherpaVoiceEngine) this.voice.stopSpeaking();
      return;
    }
    if (this.voice instanceof SherpaVoiceEngine) {
      this.voice.stopSpeaking();
      if (this.voiceState === 'listening') {
        this.voice.cancelCapture();
        return;
      }
    }
    // C4: when the panel itself has focus its renderer handles Esc; acting on
    // the hook's copy too would post a second "Stopped".
    if (this.panel?.isFocused()) return;
    if (this.conv.busy || this.conv.speaking) {
      this.cancelRun('Stopped.');
      return;
    }
    // Round 12: Esc at the PC also stops a WhatsApp request.
    if (this.remoteConv.busy) {
      console.log('[remote] stopped at the PC (Esc)');
      this.remoteConv.cancel('Stopped at the PC.');
      return;
    }
    if (this.panelVisible) this.dismiss();
  }

  private lastCancelAt = 0;

  cancelRun(note = 'Stopped.'): void {
    if (Date.now() - this.lastCancelAt < 400) return; // C4: one Esc, one stop
    this.lastCancelAt = Date.now();
    // Stop in-flight helper input immediately (B1), and refuse any later input
    // of this run's epoch (REVIEW-2 #7), then the run itself.
    void this.helper?.cancelInput(this.tools.run?.id ?? this.helper.inputEpoch).catch(() => undefined);
    this.conv.cancel(note);
    // Round 12.5: Esc (or the panel's Stop) also ends a WhatsApp request.
    if (this.remoteConv?.busy) {
      console.log('[remote] stopped at the PC (Esc)');
      this.remoteConv.cancel('Stopped at the PC.');
    }
    this.overlays.broadcast({ type: 'ghost-hide' });
  }

  // --------------------------------------------------------------- send -----

  currentModel(p: ProviderId = this.settings.get().provider): string {
    return this.settings.get().models[p] ?? '';
  }

  private bufferedSummon = false;

  /** Move keystrokes the helper held during the summon into the panel's input. */
  private deliverBufferedKeys() {
    if (!this.bufferedSummon) return;
    this.bufferedSummon = false;
    const panel = this.panel;
    void this.helper
      ?.call<{ text: string; submit?: boolean }>('take_buffered_keys', {}, 2000)
      .then((r) => r?.text && sendPanel(panel, { type: 'prefill', text: r.text, submit: !!r.submit }))
      .catch(() => undefined);
  }
  private runSeq = Math.floor(Date.now() / 1000); // monotonic across helper restarts

  private contextText(conv: { turns: number; lastReply?: string } | null, voiceTurn: boolean, nonce = newFenceNonce()): string {
    const t = this.target;
    const parts = ['[Cadabra context]'];
    if (t) {
      parts.push(`The user summoned you on a window (process ${t.process}). Its title, as screen data: ${fenceScreen(t.title, nonce)}`);
      if (this.summonShot) parts.push(`A screenshot of it is attached (${this.summonShot.width}x${this.summonShot.height} image px; use these coordinates for click/highlight x,y).`);
      if (t.elevated) parts.push('This window runs as administrator: you can look but cannot click or type in it.');
    } else parts.push('No specific window was targeted; use see_screen with scope "screen" if you need to look.');
    parts.push(`Local time: ${new Date().toLocaleString()}.`);
    const c = conv;
    const dn = this.settings.get().displayName;
    const name = dn && !looksLikeHandle(dn, os.userInfo().username) ? dn : '';
    if (c && !c.turns && name) parts.push(`First turn of this conversation: you may greet the user once as "${greeting(new Date())} ${name}".`);
    if (voiceTurn) parts.push('Voice turn: the user is listening, not reading — reply in 1-2 short spoken sentences, no markdown, no URLs/code; summarize results; end naturally (no "Anything else?").');
    // Round 10: never two replies in a row ending with a question.
    if (c?.lastReply && /\?\s*$/.test(c.lastReply.trim())) parts.push('Your previous reply ended with a question, so end this one without a question.');
    const st = this.settings.get();
    if (!st.webAccess) parts.push('Web access is OFF in Settings: you cannot search the web. If the user needs current information, say so and suggest turning on Settings → Web access.');
    else if (st.provider === 'claude' && st.claudeRoute !== 'claude-code' && !st.claudeApiWeb) parts.push('Web search is not available with this Claude connection (API key, Bedrock or Vertex). If the user needs current information from the web, say so plainly; it can be turned on in Settings → Web access ("Web search with your Claude API key"). Weather still works through your weather tool.');
    const persona = personaContext(this.settings.get().voice);
    if (persona) parts.push(persona);
    return parts.join(' ');
  }

  /** Typed or spoken message → the conversation controller. */
  async send(text: string, via: 'typed' | 'voice' = 'typed'): Promise<void> {
    await this.conv.send(text, via);
    this.refreshTray();
  }

  /**
   * Round 5: voice turns use the backend's fast model (quicker first words)
   * unless the user turned that off or picked a model by voice this session.
   */
  private turnModel(id: ProviderId, voice: boolean): string {
    const cur = this.currentModel(id);
    if (!voice || !this.settings.get().voice.fastModelForVoice) return cur;
    const models = this.authCache.get(id)?.models ?? [];
    return pickModelForTier(models, 'fast')?.id ?? cur;
  }

  /** Speak and resolve when the speech has ended (V3). */
  private async speakAndWait(text: string): Promise<void> {
    if (!(this.voice instanceof SherpaVoiceEngine)) return;
    await this.voice.speakAndWait(text);
  }

  /** Glue between the Electron app and the testable conversation controller. */
  private convHost(): import('./conversation').ConvHost {
    return {
      settings: () => this.settings.get(),
      provider: (id) => this.providers[id],
      ui: {
        event: (ev) => {
          // UX4: words for the user expand the HUD back into the panel, once the
          // hands have been still for a moment (no flicker between steps).
          if (ev.type === 'text' && this.actingFull) this.expandSoon();
          this.eventTap?.(ev);
          sendPanel(this.panel, { type: 'event', event: ev });
        },
        busy: (b) => {
          if (!b) this.setActing(false);
          sendPanel(this.panel, { type: 'busy', busy: b, run: this.tools.runOf('pc')?.id });
          this.refreshTray();
        },
        userEcho: (text, via) => sendPanel(this.panel, { type: 'user-echo', text, via }),
        notice: (text, tone) => sendPanel(this.panel, { type: 'notice', text, tone }),
        dismiss: () => this.dismiss(),
        panelVisible: () => this.panelVisible,
        panelFocused: () => !!this.panel?.isFocused(),
      },
      voice: {
        enabled: () => this.voice instanceof SherpaVoiceEngine && this.settings.get().voice.enabled && this.voiceState !== 'off' && this.voiceState !== 'error',
        speak: (text) => this.speakAndWait(text),
        stopSpeaking: () => {
          if (this.voice instanceof SherpaVoiceEngine) this.voice.stopSpeaking();
        },
        armFollowUp: (ms) => {
          if (!(this.voice instanceof SherpaVoiceEngine)) return;
          // Round 10.5: while media plays, continuing needs the wake word.
          if (ms > 0 && this.mediaBlocksWindow('follow-up')) {
            // No wake-free window; the panel still goes away when it would have expired.
            setTimeout(() => this.conv.followUpExpired(), ms).unref?.();
            if (this.panelVisible) sendPanel(this.panel, { type: 'notice', text: `Say “${assistantName(this.settings.get().voice.wakeWord)}” to continue — media is playing.`, tone: 'info' });
            return;
          }
          this.voice.armFollowUp(ms);
        },
        openStream: async () => {
          const v = this.voice;
          if (!(v instanceof SherpaVoiceEngine)) return { push: () => undefined, end: async () => undefined, cancel: () => undefined };
          const st = await v.openSpeech();
          const dialect = v.dialectOf(st.voice);
          return {
            push: (xs: string[]) => st.push(xs.map((x) => toSpokenText(x, dialect))),
            end: async () => {
              st.end();
              await st.done;
            },
            cancel: () => st.cancel(),
          };
        },
      },
      gate: { beginRun: () => this.gate.beginRun('pc'), stop: () => this.gate.stop('pc') },
      // Round 12.5: a PC turn while WhatsApp is working is refused, not run concurrently.
      blocked: () => (this.remote?.busy ? `${assistantName(this.settings.get().voice.wakeWord)} is busy with a request from your WhatsApp right now. Press Esc to stop it, then ask again.` : null),
      // Round 12.6: offer "Stop it and continue" instead of just refusing.
      takeOver: async () => {
        const ok = await this.confirm({ title: `${assistantName(this.settings.get().voice.wakeWord)} is working on a request from your WhatsApp. Stop it and continue here?`, detail: 'The phone is told you took over.', risk: '', kind: 'question', channel: 'pc', timeoutMs: 60_000 }, new AbortController().signal);
        if (ok !== true && ok !== 'always') return false;
        await this.remote.takeOver();
        for (let i = 0; i < 50 && this.remote.busy; i++) await sleep(100);
        console.log(`[remote] taken over at the PC${this.remote.busy ? ' (still winding down)' : ''}`);
        return !this.remote.busy;
      },
      setRun: (run) => {
        this.tools.setRunFor('pc', run);
        if (run) {
          this.ghostPos = null;
          // REVIEW-2 #7: every helper input call of this run carries its epoch.
          if (this.helper && run.id) this.helper.inputEpoch = run.id;
        }
      },
      buildTurn: (text, signal, conv, voiceTurn) => {
        // Round 12: the backend session was last used by WhatsApp: start clean (the local conversation resumes its own).
        if (this.lastChannel !== 'local') {
          this.providers[this.settings.get().provider].reset?.();
          this.lastChannel = 'local';
        }
        const shot = this.summonShot;
        this.summonShot = null; // attach the summon screenshot once
        const run: RunState = {
          target: this.target,
          signal,
          frame: shot ? { rect: shot.rect, scale: shot.scale, width: shot.width, height: shot.height } : this.target ? frameForRect(this.target.rect) : null,
          nodes: new Map(),
          prompt: text,
          id: ++this.runSeq,
          nonce: newFenceNonce(),
          screen: this.target ? [this.target.title] : [],
        };
        return {
          run,
          request: {
            contextText: this.contextText(conv, voiceTurn, run.nonce!) + this.skillContext(text, run.nonce!, run),
            image: shot ? { data: shot.data, mimeType: 'image/png' as const, width: shot.width, height: shot.height } : undefined,
          },
        };
      },
      model: (id, o) => this.turnModel(id, !!o?.voice),
      localWeather: (text) => this.localWeather(text),
      rememberLocation: (city) => this.rememberLocation(city),
      localLaunch: (text) => this.tryLocalLaunch(text),
      localIntent: async (text) => {
        this.noteHistoryActivity();
        // 0.9.6: announcements are spoken verbatim, never sent to the AI.
        const ann = await this.localAnnouncement(text);
        if (ann != null) return ann;
        const intent = parseIntent(text, { models: (await this.providerInfo(this.settings.get().provider, false)).models, wakeWord: this.settings.get().voice.wakeWord });
        return intent ? this.applyIntent(intent) : null;
      },
      hasPendingConfirm: () => this.confirms.size > 0,
      resolveConfirm: (allowed) => {
        const first = [...this.confirms.entries()][0];
        if (!first) return;
        const [id, r] = first;
        this.confirms.delete(id);
        sendPanel(this.panel, { type: 'confirm-resolved', id, allowed });
        r(allowed);
      },
      rejectConfirms: () => {
        for (const [id, r] of this.confirms) {
          sendPanel(this.panel, { type: 'confirm-resolved', id, allowed: false });
          r(false);
        }
        this.confirms.clear();
      },
      afterRun: () => {
        setTimeout(() => {
          if (!this.conv.busy) this.overlays.broadcast({ type: 'ghost-hide' });
        }, 1600);
      },
      now: () => Date.now(),
    };
  }

  // ------------------------------------------------------------- apps -----

  private async iconFor(a: AppEntry): Promise<string | undefined> {
    if (this.iconCache.has(a.id)) return this.iconCache.get(a.id) ?? undefined;
    const url = await resolveAppIcon(a).catch(() => null);
    this.iconCache.set(a.id, url);
    return url ?? undefined;
  }

  /** "open spotify" -> launch instantly (no AI round-trip), or offer choices. */
  /** Round 10: "Did you mean tv.youtube.com?" waiting for a yes / no. */
  private pendingUrl: { url: string; browser?: string; at: number } | null = null;

  /** Does this host resolve? (2 s cap; never throws.) */
  async hostResolves(host: string): Promise<boolean> {
    try {
      const dns = await import('node:dns');
      const r = await Promise.race([dns.promises.lookup(host, { all: true }).then((xs) => xs.length > 0), new Promise<boolean>((res) => setTimeout(() => res(false), 2000))]);
      return r;
    } catch {
      return false;
    }
  }

  /** Open an address the USER spoke or typed, showing it in the panel as it opens. */
  private async openSpokenUrl(url: string, browser?: string): Promise<string> {
    const shown = displayUrl(url);
    const problem = hostProblem(url);
    if (problem) return `I can’t open ${shown}: ${problem}`;
    console.log(`[open_url] spoken address (${browser ? browserName(browser) ?? 'default' : 'default'} browser)`);
    sendPanel(this.panel, { type: 'launch', name: shown, status: 'opening' });
    if (this.opts.demoLive || this.opts.e2e) return `Opening **${shown}** (not really: this is a test run).`;
    const res = await openInBrowser(url, browserName(browser), (u) => shell.openExternal(u));
    // Round 12.7: app-side actions back the reply's claims (honesty check), like a tool.
    if (this.tools.run) (this.tools.run.localActions ??= []).push('open');
    sendPanel(this.panel, { type: 'launch', name: shown, status: 'opened' });
    const label = browserName(browser);
    return /isn’t installed/.test(res) ? `Opening **${shown}**. ${res}` : `Opening **${shown}**${label ? ` in ${label[0].toUpperCase()}${label.slice(1)}` : ''}.`;
  }

  /**
   * Round 10: spoken web addresses ("open up tv dot youtube dot com",
   * "go to bbc.co.uk", "open my gmail"). The first candidate whose host
   * resolves wins; if a glued "up" makes it ambiguous, ask.
   */
  private async tryLocalUrl(text: string, knownSites: boolean): Promise<string | null> {
    // A pending "Did you mean …?"
    // REVIEW-10 #3: a "Did you mean …?" stays open for 20 s.
    if (this.pendingUrl && Date.now() - this.pendingUrl.at < PENDING_URL_MS) {
      const p = this.pendingUrl;
      if (/^(yes|yeah|yep|yup|sure|correct|right|that'?s (it|right)|please( do)?|do it|open it)\b/i.test(text.trim())) {
        this.pendingUrl = null;
        return this.openSpokenUrl(p.url, p.browser);
      }
      if (/^(no|nope|nah|wrong|not that|cancel)\b/i.test(text.trim())) {
        this.pendingUrl = null;
        return 'Okay, I won’t open it. Say the address again, maybe spelling it with “dot”.';
      }
    }
    this.pendingUrl = null;
    const c = spokenUrlCandidates(text, { wakeWord: this.settings.get().voice.wakeWord, knownSites });
    if (!c) return null;
    const pick = await chooseUrl(c, (h) => this.hostResolves(h));
    if ('open' in pick) return this.openSpokenUrl(pick.open, c.browser);
    if ('ask' in pick) {
      this.pendingUrl = { url: pick.ask, browser: c.browser, at: Date.now() };
      console.log('[open_url] spoken address ambiguous: asking');
      return `Did you mean ${displayUrl(pick.ask)}?`;
    }
    console.log('[open_url] spoken address does not resolve');
    this.pendingUrl = { url: pick.none, browser: c.browser, at: Date.now() };
    return `I couldn’t find ${displayUrl(pick.none)}. Do you want me to try opening it anyway?`;
  }

  private async tryLocalLaunch(text: string): Promise<string | null> {
    const url = await this.tryLocalUrl(text, false);
    if (url != null) return url;
    const q = parseLaunchIntent(text);
    if (!q) return null;
    await this.appIndex.ready();
    const ms = this.appIndex.find(q, 4);
    // "open my gmail": no app by that name → the well-known site.
    if (!ms.length || !isConfident(ms)) {
      const site = await this.tryLocalUrl(text, true);
      if (site != null) return site;
    }
    if (!ms.length) return null; // let the AI handle it ("open the file menu"...)
    if (isConfident(ms)) return this.launchIndexed(ms[0].app, true);
    const choices = await Promise.all(ms.slice(0, 3).map(async (m) => ({ id: m.app.id, name: m.app.name, source: m.app.source, icon: await this.iconFor(m.app) })));
    sendPanel(this.panel, { type: 'apps', query: q, choices });
    return '';
  }

  /** Launch (or focus) an indexed app with the launch magic. */
  async launchIndexed(a: AppEntry, focusExisting = true): Promise<string> {
    return (await this.launchIndexedEx(a, focusExisting)).text;
  }

  /** Round 11: launch and also report the app's window (the AI's next typing / clicks go there). */
  async launchIndexedEx(a: AppEntry, focusExisting = true): Promise<{ text: string; window?: WinInfo | null }> {
    const res = await this.launchIndexedRaw(a, focusExisting);
    return res;
  }

  private async launchIndexedRaw(a: AppEntry, focusExisting: boolean): Promise<{ text: string; window?: WinInfo | null }> {
    const reduced = this.reducedMotion();
    const icon = await this.iconFor(a);
    sendPanel(this.panel, { type: 'launch', name: a.name, icon, status: 'opening' });
    const cursor = screen.getCursorScreenPoint();
    const pb = this.panel?.isVisible() ? this.panel.getBounds() : null;
    const from = pb ? { x: pb.x + 40, y: pb.y + pb.height - 120 } : cursor;
    const d = screen.getDisplayNearestPoint(from);
    const to = { x: d.workArea.x + d.workArea.width / 2, y: d.workArea.y + d.workArea.height / 2 };
    const res = await launchApp(
      a,
      launcherDepsFor(() => this.h(), shell),
      {
        focusExisting,
        onLaunched: () =>
          this.overlays.send(d, { type: 'launch', from: this.overlays.local(d, from), to: this.overlays.local(d, to), icon, name: a.name, reducedMotion: reduced }, 6000),
      },
    );
    if (res.status === 'error') {
      sendPanel(this.panel, { type: 'launch', name: a.name, icon, status: 'error', detail: res.message });
      return { text: `Couldn't open **${a.name}**: ${res.message}` };
    }
    this.appIndex.recordLaunch(a.id);
    if (this.tools.run) (this.tools.run.localActions ??= []).push('open');
    if (res.window) {
      const wr = this.physRectToDip(res.window.rect);
      const wd = screen.getDisplayMatching({ x: Math.round(wr.x), y: Math.round(wr.y), width: Math.max(1, Math.round(wr.width)), height: Math.max(1, Math.round(wr.height)) });
      this.overlays.send(wd, { type: 'scan', rect: this.overlays.localRect(wd, wr), reducedMotion: reduced });
      this.overlays.send(wd, { type: 'spark', at: this.overlays.local(wd, { x: wr.x + wr.width / 2, y: wr.y + 18 }), reducedMotion: reduced });
    }
    sendPanel(this.panel, { type: 'launch', name: a.name, icon, status: res.status === 'focused' ? 'focused' : 'opened' });
    if (res.status === 'focused') return { text: `**${a.name}** was already open, so I brought it to the front.`, window: res.window };
    return { text: res.window ? `Opened **${a.name}**.` : `Starting **${a.name}**... (it may take a moment to appear).`, window: res.window };
  }

  // ------------------------------------------------------------ confirm ----

  /** e2e harness hooks: answer cards programmatically and observe events. */
  confirmOverride: ((p: ConfirmPrompt) => Promise<boolean>) | null = null;
  eventTap: ((ev: ProviderEvent) => void) | null = null;

  private confirm(p: ConfirmPrompt, signal: AbortSignal): Promise<boolean | 'always'> {
    if (this.confirmOverride) return this.confirmOverride(p);
    // Round 12.5: routed by the RUN's channel: a WhatsApp run asks in the chat (one-time code).
    if (p.channel === 'whatsapp') return this.remote.confirm({ title: p.title, mono: p.mono, risk: p.risk, kind: p.actionKind });
    return new Promise((resolve) => {
      const id = randomUUID();
      this.confirms.set(id, resolve);
      if (this.panel && !this.panel.isVisible()) {
        this.panel.showInactive();
        this.panelVisible = true;
      }
      this.setActing(false); // a confirm card always gets the full panel
      sendPanel(this.panel, { type: 'confirm', id, title: p.title, detail: p.detail, risk: p.risk, mono: p.mono, subtitle: p.subtitle, kind: p.kind, timeoutMs: p.timeoutMs, alwaysLabel: p.alwaysLabel });
      signal.addEventListener('abort', () => {
        if (this.confirms.delete(id)) {
          sendPanel(this.panel, { type: 'confirm-resolved', id, allowed: false });
          resolve(false);
        }
      });
      // REVIEW-2 #5: in a voice conversation the card is spoken and a wake-free
      // yes/no window opens (answers arrive as busy-time "yes"/"no").
      if (p.spoken) void this.conv.speakConfirm(p.spoken);
    });
  }

  // ---------------------------------------------------------- acting HUD ----

  private actingFull: Electron.Rectangle | null = null;
  /** 0.9.4: progress captions go to the channel that produced them (activity.ts). */
  private readonly activity = new ActivityRouter({
    panel: (m) => sendPanel(this.panel, m),
    remotePill: (caption) => {
      if (!this.remotePillShown) return;
      const nm = assistantName(this.settings.get().voice.wakeWord);
      const text = caption ? `${nm} (WhatsApp) · ${caption.slice(0, 80)} · Esc stops it` : `${nm} (WhatsApp) is working · Esc stops it`;
      this.overlays.send(screen.getPrimaryDisplay(), { type: 'remote-pill', on: true, text }, 10 * 60_000);
    },
  });
  /** Only for the on-screen pill text (not a gate or routing flag). */
  private remotePillShown = false;
  skills!: SkillRegistry;

  // ------------------------------------------------- remote presence (0.9.8)
  /** Is the screen usable for a WhatsApp request? Wakes a dark display, never unlocks. */
  readonly presence = new RemotePresence({
    desktopState: async () => (this.helper ? this.helper.desktopState() : null),
    wakeDisplay: async () => void (await this.helper?.wakeDisplay()),
    holdDisplay: () => {
      const id = powerSaveBlocker.start('prevent-display-sleep');
      return () => {
        if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
      };
    },
    wakeEnabled: () => this.settings.get().remote.wakeDisplay !== false,
    log: (l) => console.log(l),
  });
  private keepAwakeId: number | null = null;

  // ------------------------------------------------------ chat history (0.9.9)
  /** Cadabra's own folders that can hold conversation content (history.ts). */
  historyPaths(): HistoryPaths {
    const ud = app.getPath('userData');
    const homes = this.opts.providerHomes ?? ud;
    return {
      userData: ud,
      agentWork: path.join(ud, 'agent-work'),
      codexHome: path.join(homes, 'codex-home'),
      geminiHome: path.join(homes, 'gemini-home'),
      claudeConfig: path.join(ud, 'claude-api-config'),
      e2eReports: path.join(ud, 'e2e-live'),
      temp: os.tmpdir(),
    };
  }

  private lastHistoryActivity: number | null = null;
  private historyTimer: NodeJS.Timeout | null = null;

  /** Note conversation activity (for "Clear after 1 hour of inactivity"). */
  noteHistoryActivity(): void {
    this.lastHistoryActivity = Date.now();
  }

  /**
   * "Clear chat history": everything Cadabra holds that contains conversation
   * content, in memory and in its own folders. Keeps settings, skills, grants,
   * keys and pairing. Never touches the user's own CLI folders.
   */
  async clearHistory(reason: string, from?: 'pc' | 'whatsapp'): Promise<number> {
    // The turn that asked (a local "clear my history") ends by itself; stop any other work.
    if (from !== 'pc' && this.conv.busy) this.cancelRun('History cleared.');
    if (from !== 'whatsapp' && this.remoteConv.busy) this.remoteConv.cancel('History cleared.');
    for (const resolve of this.confirms.values()) resolve(false);
    this.confirms.clear();
    this.conv.newChat();
    this.remoteConv.newChat();
    this.remoteReply = '';
    this.remoteImage = undefined;
    await Promise.all(Object.values(this.providers).map((p) => (p.dispose ? p.dispose().catch(() => undefined) : Promise.resolve(p.reset?.()))));
    const removed = clearHistoryFiles(this.historyPaths());
    this.lastHistoryActivity = null;
    sendPanel(this.panel, { type: 'reset' });
    sendPanel(this.panel, { type: 'notice', text: 'History cleared.', tone: 'info' });
    console.log(`[history] cleared (${reason}; ${removed.length} file(s) removed)`);
    return removed.length;
  }

  /** Ask first (panel card / spoken yes-no on the PC; a one-time code in WhatsApp), then clear. */
  async askClearHistory(channel: 'pc' | 'whatsapp', spoken = false, fromTurn = true): Promise<string> {
    const ok = await this.confirm(
      {
        title: 'Clear all chat history?',
        detail: CLEAR_HISTORY_NOTE,
        risk: 'This can’t be undone',
        kind: 'question',
        channel,
        timeoutMs: 60_000,
        ...(spoken ? { spoken: 'Clear all chat history? Say yes to confirm.' } : {}),
      },
      new AbortController().signal,
    );
    if (ok !== true && ok !== 'always') return 'Okay, I kept your history.';
    await this.clearHistory(channel === 'whatsapp' ? 'asked from WhatsApp' : 'asked at the PC', fromTurn ? channel : undefined);
    return channel === 'whatsapp'
      ? 'Done — history cleared on your PC. This chat stays on your phone: delete it in WhatsApp if you want it gone there too.'
      : 'Done — history cleared.';
  }

  /** Startup: orphaned temp files (> 1 day) always; everything if "Clear when Cadabra closes". */
  private startupHistoryCleanup(): void {
    const mode = this.settings.get().privacy?.keepHistory ?? 'until-cleared';
    const removed = clearHistoryFiles(this.historyPaths(), mode === 'on-close' ? {} : { olderThanMs: ORPHAN_AGE_MS });
    if (removed.length) console.log(`[history] startup clean-up: ${removed.length} old file(s) removed`);
    this.historyTimer = setInterval(() => {
      const m = this.settings.get().privacy?.keepHistory ?? 'until-cleared';
      if (idleClearDue(m, this.lastHistoryActivity, Date.now(), this.conv.busy || !!this.remote?.busy)) void this.clearHistory('1 hour without activity');
    }, 60_000);
    this.historyTimer.unref?.();
  }

  /** "Keep this PC awake while remote access is on" (prevents sleep; the display may still turn off). */
  private applyKeepAwake(): void {
    const r = this.settings.get().remote;
    const want = r.enabled && r.keepAwake;
    if (want && this.keepAwakeId == null) {
      this.keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
      console.log('[remote] keeping the PC awake while remote access is on');
    } else if (!want && this.keepAwakeId != null) {
      if (powerSaveBlocker.isStarted(this.keepAwakeId)) powerSaveBlocker.stop(this.keepAwakeId);
      this.keepAwakeId = null;
      console.log('[remote] no longer keeping the PC awake');
    }
  }

  // ---------------------------------------------------------- announcements (0.9.6)
  readonly announcer = new Announcer({
    settings: () => this.settings.get().announcements,
    muted: async () => (this.helper ? ((await this.helper.presence().catch(() => null))?.speakerMuted ?? null) : null),
    inQuietHours: () => {
      const g = this.settings.get().greetings;
      return inQuietHours(new Date(), g.quietStart, g.quietEnd);
    },
    speak: async (text, o) => (this.voice instanceof SherpaVoiceEngine ? this.voice.announce(text, o) : 'unavailable'),
    duck: async () => this.duckOtherAudio(),
    log: (l) => console.log(l),
  });

  private duckFile() {
    return path.join(app.getPath('userData'), 'ducked-audio.json');
  }

  /**
   * Lower other apps while announcing. The helper restores them when Cadabra
   * goes away; a copy on disk restores them on the next start if both crashed.
   */
  private async duckOtherAudio(): Promise<() => Promise<void>> {
    const h = this.helper;
    if (!h) return async () => undefined;
    const r = await h.duckAudio(app.getAppMetrics().map((m) => m.pid), 0.25).catch(() => null);
    const list = r?.ducked ?? [];
    // A1: merged with other announcements' records; each removes only its own.
    addDuckRecords(this.duckFile(), list);
    return async () => {
      if (!list.length) return;
      // A2: the helper restores only apps still at the lowered level (keeps user changes).
      await h.unduckAudio(list).catch(() => undefined);
      removeDuckRecords(this.duckFile(), list);
    };
  }

  /** On helper start: undo a ducking left over from a crash. */
  private async restoreDuckedAudio(): Promise<void> {
    const list = readDuckRecords(this.duckFile());
    if (!list.length) return;
    const r = await this.helper?.unduckAudio(list).catch(() => null);
    console.log(`[announce] restored ${r?.restored ?? 0} app volume(s) left lowered by an interrupted announcement${r?.keptUserChange ? ` (${r.keptUserChange} changed since, left as they are)` : ''}`);
    if (r) removeDuckRecords(this.duckFile(), list);
  }

  /** "Cadabra, make an announcement: …" at the PC (voice or typed). */
  private async localAnnouncement(text: string): Promise<string | null> {
    const wake = this.settings.get().voice.wakeWord;
    const said = parseLocalAnnouncement(text, [assistantName(wake), wake, 'cadabra']);
    if (said == null) return null;
    const r = await this.announcer.announce(said, 'pc');
    return r.ok ? `Announced${r.truncated ? ' (the first 500 characters)' : ''}.` : (r.reason ?? 'Not announced.');
  }

  private skillDirs() {
    return skillDirs({ resources: resourcePath(), documents: app.getPath('documents'), userData: app.getPath('userData'), isolated: !!(this.opts.demoLive || this.opts.selftest || this.opts.e2e) });
  }

  /** "New skill from template": copy the template into the user's folder and open it in Notepad. */
  newSkill(name: string): { ok: boolean; error?: string; name?: string } {
    if (!this.skills) return { ok: false, error: 'Skills aren’t available.' };
    const r = this.skills.createFromTemplate(name);
    if (!r.ok) return r;
    // S4: by full path, so a notepad.exe in the working folder or on PATH is never used.
    spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe'), [r.file], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, name: r.name };
  }

  /** Open Settings → Skills (tray "Skills…", "create a new skill called X"). */
  openSkills(newName?: string) {
    void this.showPanelCentered().then(() => sendPanel(this.panel, { type: 'view', view: 'settings', focus: 'skills', newSkill: newName }));
  }

  /**
   * 0.9.5: skill context for one turn: the enabled skills' names + descriptions,
   * and, when the request closely matches a skill's examples (local fast path),
   * that skill's instructions preloaded. Never added to run.prompt.
   */
  private skillContext(text: string, nonce: string, run?: RunState): string {
    if (!this.skills) return '';
    const parts: string[] = [];
    const sum = this.skills.summary();
    if (sum) parts.push(sum);
    const hit = this.skills.match(text, this.settings.get().voice.wakeWord);
    if (hit) {
      const ins = this.skills.instructions(hit.name, nonce);
      if (ins) {
        // S3: the skill's reference files are data (the "screen" corpus), not the owner's words.
        if (run) run.screen = [...(run.screen ?? []), ...this.skills.referenceTexts(hit.name)];
        console.log(`[skills] fast path: ${hit.name}`);
        parts.push(`This request matches the owner's skill "${hit.name}"; it's loaded below, so follow it (no need to call use_skill).\n${ins}`);
      }
    }
    return parts.length ? ` ${parts.join('\n')}` : '';
  }

  /** Which channel a tool effect belongs to: the WhatsApp run's signal, else the active run. */
  private fxChannel(signal?: AbortSignal): ActivityChannel {
    const wa = this.tools?.runOf('whatsapp');
    if (wa && (signal ? wa.signal === signal : this.tools.run === wa)) return 'whatsapp';
    return 'pc';
  }
  private lastActAt = 0;
  private expandTimer: NodeJS.Timeout | null = null;

  private expandSoon() {
    if (this.expandTimer) return;
    const wait = Math.max(0, this.lastActAt + 1200 - Date.now());
    this.expandTimer = setTimeout(() => {
      this.expandTimer = null;
      if (Date.now() - this.lastActAt >= 1150) this.setActing(false);
      else this.expandSoon();
    }, wait);
  }

  /**
   * UX4: while Cadabra is clicking/typing, the panel collapses to a compact
   * HUD strip (caption + Stop) so it doesn't cover the work; it expands back
   * for the answer or for a confirm card.
   */
  private setActing(on: boolean, caption?: string) {
    const panel = this.panel;
    if (!panel || panel.isDestroyed()) return;
    if (on) {
      this.lastActAt = Date.now();
      this.activity.caption('pc', this.tools.runOf('pc')?.id, caption ?? '');
      if (this.actingFull || !this.panelVisible) return;
      const b = panel.getBounds();
      this.actingFull = b;
      panel.setBounds({ x: b.x, y: b.y, width: b.width, height: ACTING_HUD_HEIGHT }, false);
    } else {
      if (this.actingFull) {
        const full = this.actingFull;
        this.actingFull = null;
        panel.setBounds(full, false);
      }
      // 0.9.4: always clear a caption that was sent, even if the panel was hidden
      // when it arrived (the HUD never collapsed, so actingFull was never set).
      this.activity.clearPcCaption(this.tools.runOf('pc')?.id);
    }
  }

  // ------------------------------------------------------------- effects ----

  private effects(): Effects {
    return {
      ghostMoveTo: async (p, caption, signal) => {
        // 0.9.4: a WhatsApp run's caption goes to the WhatsApp pill, never the PC panel.
        if (this.fxChannel(signal) === 'whatsapp') this.activity.caption('whatsapp', this.tools.runOf('whatsapp')?.id, caption);
        else this.setActing(true, caption);
        const dip = this.toDip(p);
        const d = this.overlays.displayFor(dip);
        const reduced = this.reducedMotion();
        let from = this.ghostPos;
        const pb = this.panel && this.panelVisible ? this.panel.getBounds() : null;
        if (!from && pb) from = { x: pb.x - 12, y: pb.y + Math.min(64, pb.height / 2) };
        const dist = from ? Math.hypot(dip.x - from.x, dip.y - from.y) : 0;
        const duration = reduced ? 0 : Math.round(Math.min(900, Math.max(340, 300 + dist * 0.45)));
        if (this.ghostDisplay != null && this.ghostDisplay !== d.id) this.overlays.broadcast({ type: 'ghost-hide' });
        this.overlays.send(
          d,
          // N9: the HUD shows the caption; the ghost doesn't repeat it.
          { type: 'ghost-move', to: this.overlays.local(d, dip), from: from ? this.overlays.local(d, from) : undefined, caption: this.actingFull ? undefined : caption, durationMs: duration, reducedMotion: reduced, avoid: pb ? this.overlays.localRect(d, pb) : undefined },
          duration + 8000,
        );
        this.ghostPos = dip;
        this.ghostDisplay = d.id;
        await new Promise<void>((r) => {
          const t = setTimeout(r, duration + 80);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            r();
          });
        });
      },
      ghostClick: (p) => {
        const dip = this.toDip(p);
        const d = this.overlays.displayFor(dip);
        this.overlays.send(d, { type: 'ghost-click', at: this.overlays.local(d, dip) }, 8000);
      },
      ghostHide: () => this.overlays.broadcast({ type: 'ghost-hide' }),
      highlight: (rings, durationMs) => {
        const byDisplay = new Map<number, { d: Display; rings: { rect: Rect; label?: string }[] }>();
        for (const r of rings) {
          const dr = this.physRectToDip(r.rect);
          const d = screen.getDisplayMatching({ x: Math.round(dr.x), y: Math.round(dr.y), width: Math.max(1, Math.round(dr.width)), height: Math.max(1, Math.round(dr.height)) });
          const e = byDisplay.get(d.id) ?? { d, rings: [] };
          e.rings.push({ rect: this.overlays.localRect(d, dr), label: r.label });
          byDisplay.set(d.id, e);
        }
        for (const { d, rings: rs } of byDisplay.values()) {
          this.overlays.send(d, { type: 'highlight', rings: rs, reducedMotion: this.reducedMotion(), durationMs }, (durationMs ?? 8000) + 1500);
        }
      },
      clearPoint: async (p) => {
        const panel = this.panel;
        if (!panel || !panel.isVisible()) return () => {};
        const dip = this.toDip(p);
        if (!rectContains(panel.getBounds(), dip)) return () => {};
        panel.setIgnoreMouseEvents(true);
        panel.setOpacity(0.0);
        await sleep(60);
        return () => {
          if (panel.isDestroyed()) return;
          panel.setIgnoreMouseEvents(false);
          panel.setOpacity(1);
        };
      },
      status: (text) => {
        const ch = this.fxChannel();
        this.activity.status(ch, this.tools.runOf(ch)?.id, text);
      },
    };
  }

  private demoEffects(): DemoEffects {
    return {
      pointAtSomething: () => {
        const b = this.panel?.getBounds();
        if (!b) return;
        const d = screen.getDisplayMatching(b);
        const left = b.x - d.bounds.x > d.bounds.width / 2;
        const x = left ? b.x - 260 : b.x + b.width + 40;
        const rect = { x, y: b.y + 120, width: 200, height: 44 };
        const rect2 = { x: x + 30, y: b.y + 200, width: 140, height: 36 };
        this.overlays.send(d, {
          type: 'highlight',
          rings: [
            { rect: this.overlays.localRect(d, rect), label: 'This one' },
            { rect: this.overlays.localRect(d, rect2), label: 'and here' },
          ],
          reducedMotion: this.reducedMotion(),
          durationMs: 6000,
        }, 7500);
      },
      ghostTour: async (signal) => {
        const b = this.panel?.getBounds();
        if (!b) return;
        const d = screen.getDisplayMatching(b);
        const left = b.x - d.bounds.x > d.bounds.width / 2;
        const baseX = left ? b.x - 340 : b.x + b.width + 80;
        const stops = [
          { x: baseX, y: b.y + 90, c: 'Opening the File menu…' },
          { x: baseX + 180, y: b.y + 220, c: 'Clicking “Export”' },
          { x: baseX + 60, y: b.y + 330, c: 'Typing into Subject…' },
        ];
        for (const s of stops) {
          if (signal.aborted) break;
          await this.effects().ghostMoveTo(screen.dipToScreenPoint(s), s.c, signal);
          this.effects().ghostClick(screen.dipToScreenPoint(s));
          await sleep(350);
        }
      },
    };
  }

  // ------------------------------------------------------------- controls ---

  private controls(): Controls {
    return {
      setProvider: async (id) => this.applyIntent({ kind: 'set-provider', provider: id }),
      setModel: async (model) => {
        const m = model.toLowerCase();
        if (/fast|quick|cheap|light|small/.test(m)) return this.applyIntent({ kind: 'model-tier', tier: 'fast' });
        if (/smart|best|capable|strong|power/.test(m)) return this.applyIntent({ kind: 'model-tier', tier: 'smart' });
        const models = (await this.providerInfo(this.settings.get().provider, false)).models;
        const hit = models.find((x) => x.id === model) ?? models.find((x) => x.label.toLowerCase().includes(m) || x.id.toLowerCase().includes(m));
        if (!hit) return `No model matching "${model}". Available: ${models.map((x) => x.label).join(', ')}`;
        return this.applyIntent({ kind: 'set-model', model: hit.id, label: hit.label });
      },
      setVoice: async (p) => {
        const out: string[] = [];
        if (p.enabled != null) out.push(await this.applyIntent({ kind: 'voice', enabled: p.enabled }));
        if (p.speak_replies != null) out.push(await this.applyIntent({ kind: 'speak-replies', enabled: p.speak_replies }));
        return out.join(' ') || 'Nothing changed.';
      },
      pause: async () => this.applyIntent({ kind: 'pause' }),
      changeShortcut: async () => this.applyIntent({ kind: 'shortcut' }),
    };
  }

  async applyIntent(i: Intent): Promise<string> {
    const s = this.settings.get();
    switch (i.kind) {
      case 'set-provider': {
        if (s.provider === i.provider) return `Already using ${this.providers[i.provider].label}.`;
        this.settings.update({ provider: i.provider });
        this.conv.newChat();
        const info = await this.providerInfo(i.provider, false);
        sendPanel(this.panel, { type: 'model', provider: info, model: this.currentModel(i.provider) });
        return `Switched to **${info.label}**${info.auth && !info.auth.ok ? ` — ${info.auth.detail.toLowerCase()}. ${info.auth.howTo ?? ''}` : '.'}`;
      }
      case 'model-tier': {
        const info = await this.providerInfo(s.provider, false);
        const pick = pickModelForTier(info.models, i.tier);
        if (!pick) return `I couldn't tell which ${info.label} model is ${i.tier === 'fast' ? 'faster' : 'smarter'}.`;
        return this.applyIntent({ kind: 'set-model', model: pick.id, label: pick.label });
      }
      case 'set-model': {
        this.settings.update({ models: { ...s.models, [s.provider]: i.model } });
        const info = await this.providerInfo(s.provider, false);
        sendPanel(this.panel, { type: 'model', provider: info, model: i.model });
        return `Now using **${i.label}**.`;
      }
      case 'voice':
        this.settings.update({ voice: { ...s.voice, enabled: i.enabled } });
        if (i.enabled) void this.startVoice();
        else void this.stopVoice();
        return i.enabled ? `Voice is on — say “${cap(s.voice.wakeWord)}, …” any time.` : 'Voice is off.';
      case 'speak-replies':
        this.settings.update({ voice: { ...s.voice, speakReplies: i.enabled ? 'always' : 'never' } });
        return i.enabled ? 'I’ll read my answers aloud.' : 'I’ll stay quiet.';
      case 'pause':
        this.setPaused(true);
        return 'Paused. Resume from the tray icon.';
      case 'resume':
        this.setPaused(false);
        return 'I’m back.';
      case 'new-chat':
        this.newChat();
        return 'Fresh start.';
      case 'shortcut':
        if (this.panelVisible) sendPanel(this.panel, { type: 'view', view: 'settings', focus: 'shortcut' });
        else this.openShortcutRecorder();
        return `Press your new shortcut (currently ${formatBinding(s.summon)}).`;
      case 'name': {
        const name = tidyName(i.name.split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
        this.settings.update({ displayName: name });
        return name ? `Got it, ${name}.` : 'Okay, I won’t use your name.';
      }
      case 'greetings':
        this.settings.update({ greetings: { ...s.greetings, enabled: i.enabled } });
        this.refreshTray();
        return i.enabled ? 'Okay, I’ll say hello when you come back.' : 'Okay, no more greetings.';
      case 'lock-pc':
        return this.lockPc(i.force);
      case 'clear-history':
        return this.askClearHistory('pc', this.conv.speaking || this.voiceState !== 'idle');
      case 'new-skill':
        this.openSkills(i.name || undefined);
        return i.name ? `Opening Settings → Skills to create “${i.name}”.` : 'Opening Settings → Skills: give your new skill a name there.';
    }
  }

  /** R9-3: apps using the mic now, minus the ones the user marked "not a call". */
  async micUsers(): Promise<string[]> {
    const notCall = new Set(this.settings.get().micNotCall);
    return (await micUsersNow()).filter((p) => !notCall.has(exeName(p)));
  }

  // ------------------------------------------------------------ WhatsApp ----

  /** Round 12: the conversation host for WhatsApp turns (no panel, no voice; replies collected as text). */
  private remoteConvHost(): import('./conversation').ConvHost {
    const base = this.convHost();
    return {
      ...base,
      buildTurn: (text, signal, conv) => {
        if (this.lastChannel !== 'remote') {
          this.providers[this.settings.get().provider].reset?.();
          this.lastChannel = 'remote';
        }
        const nonce = newFenceNonce();
        const run: RunState = { target: null, signal, frame: null, nodes: new Map(), prompt: text, id: ++this.runSeq, nonce, screen: [], remote: true, channel: 'whatsapp', autonomy: this.settings.get().remote.autonomy };
        const image = this.remoteImage;
        this.remoteImage = undefined;
        return {
          run,
          request: {
            contextText: `${this.contextText(conv, false, nonce)} REMOTE turn: the owner is chatting from WhatsApp on their phone, away from the PC. Short plain-text replies.${this.skillContext(text, nonce, run)}`,
            image: image ? { data: image.data, mimeType: image.mimeType as 'image/png', width: 0, height: 0 } : undefined,
          },
        };
      },
      localLaunch: async () => null,
      localWeather: async () => null,
      // 0.9.9: "clear my history" from WhatsApp asks with a one-time code in the chat.
      localIntent: async (text) => {
        this.noteHistoryActivity();
        const intent = parseIntent(text, { models: [], wakeWord: this.settings.get().voice.wakeWord });
        if (intent?.kind === 'clear-history') return this.askClearHistory('whatsapp');
        return base.localIntent ? base.localIntent(text) : null;
      },
      gate: { beginRun: () => this.gate.beginRun('whatsapp'), stop: () => this.gate.stop('whatsapp') },
      blocked: () => null,
      setRun: (run) => {
        this.tools.setRunFor('whatsapp', run);
        // Round 12.6 (F1): WhatsApp runs advance the helper's input epoch like PC runs,
        // so an earlier Esc at the PC (which cancels older epochs) doesn't block them.
        if (run && this.helper && run.id) this.helper.inputEpoch = run.id;
      },
      ui: {
        busy: () => undefined,
        event: (ev) => {
          if (ev.type === 'text') this.remoteReply += ev.delta;
          else if (ev.type === 'error') this.remoteReply += `\n${ev.message}`;
        },
        notice: (t) => void (this.remoteReply += `\n${t}`),
        userEcho: () => undefined,
        panelVisible: () => false,
        dismiss: () => undefined,
      },
      voice: { enabled: () => false, speak: async () => undefined, stopSpeaking: () => undefined, armFollowUp: () => undefined },
    };
  }

  /** One WhatsApp turn: same backend and tools, remote autonomy, visible on the PC. */
  private async handleRemote(text: string, ctx: { image?: { data: string; mimeType: string }; voice?: boolean; signal: AbortSignal }): Promise<string> {
    this.remoteReply = '';
    this.remoteImage = ctx.image;
    this.remotePillShown = true;
    console.log('[remote] turn start');
    // 0.9.8: a locked PC can't be seen or used (never unlocked); a dark display is
    // woken and kept on for this request.
    const ready = await this.presence.beginTurn();
    if (!ready.ok && ready.code === 'desktop-locked') {
      console.log('[remote] PC locked: not acting (told the phone)');
      this.remotePillShown = false;
      this.presence.endTurn();
      return LOCKED_REPLY;
    }
    this.tray?.setToolTip('Cadabra — working on a WhatsApp request (Esc stops it)');
    // Round 12.5: a visible pill on the screen while the assistant works for WhatsApp.
    const nm = assistantName(this.settings.get().voice.wakeWord);
    this.overlays.send(screen.getPrimaryDisplay(), { type: 'remote-pill', on: true, text: `${nm} (WhatsApp) is working · Esc stops it` }, 10 * 60_000);
    this.tray?.displayBalloon?.({ title: 'Cadabra — WhatsApp', content: `${nm} is working on a request from your WhatsApp. Press Esc to stop it.`, noSound: true });
    const onAbort = () => this.remoteConv.cancel('Stopped.');
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (this.remoteConv.shouldStartFresh(null)) this.remoteConv.summon(null);
      await this.remoteConv.send(text, 'typed');
      return this.remoteReply.trim();
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      console.log('[remote] turn end');
      this.presence.endTurn();
      this.activity.runEnd('whatsapp');
      this.remotePillShown = false;
      this.overlays.broadcast({ type: 'remote-pill', on: false });
      this.refreshTray();
    }
  }

  /** The owner asked to see the screen: a compressed JPEG preview, deleted from the service after sending. */
  private async sendScreenshotToWhatsApp(caption: string): Promise<string> {
    const cap = await this.h().capture({ maxSize: 1600 });
    let img = nativeImage.createFromBuffer(Buffer.from(cap.png, 'base64'));
    if (img.getSize().width > 1280) img = img.resize({ width: 1280 });
    const jpeg = img.toJPEG(60);
    await this.remote.sendImage(jpeg, caption);
    console.log(`[remote] screenshot sent (${Math.round(jpeg.length / 1024)} KB)`);
    return 'Sent a picture of the screen to WhatsApp.';
  }

  /** Settings → WhatsApp status (never the token or the owner id). */
  waStatus() {
    const r = this.settings.get().remote;
    return { enabled: r.enabled, hasToken: this.settings.hasSecret('whatsappToken'), paired: !!r.pairedFrom, status: this.remote.status, autonomy: r.autonomy, encryption: safeStorage.isEncryptionAvailable(), wakeDisplay: r.wakeDisplay !== false, keepAwake: !!r.keepAwake };
  }

  /** Round 8: Settings → Email status (the address is shown only in the user's own Settings). */
  emailStatus() {
    const s = this.settings.get().email;
    return { mode: s.mode, address: s.address, connected: this.email.connected(), allowBodies: s.allowBodies, encryption: safeStorage.isEncryptionAvailable() };
  }

  /** "Disconnect": revoke at Google (own key) and delete every stored email secret. */
  async disconnectEmail() {
    const s = this.settings.get().email;
    const token = this.settings.getSecret('gmailRefreshToken');
    let revoked = false;
    if (s.mode === 'gmail-oauth' && token && s.clientId && !this.opts.demoLive && !this.opts.e2e) revoked = await revokeGmailToken({ clientId: s.clientId, clientSecret: this.settings.getSecret('gmailClientSecret') }, token);
    this.settings.setSecret('gmailRefreshToken', null);
    this.settings.setSecret('gmailClientSecret', null);
    this.settings.setSecret('gmailAppPassword', null);
    this.settings.update({ email: { ...s, mode: 'none', address: '', clientId: '' } });
    await this.email.reset();
    console.log(`[email] disconnected${s.mode === 'gmail-oauth' ? (revoked ? ' (access revoked at Google)' : ' (revoke failed; remove it at myaccount.google.com/permissions)') : ''}`);
    return { ...this.emailStatus(), revoked, wasImap: s.mode === 'gmail-imap' };
  }

  /** Round 8: "lock my PC" — exactly like Win+L. Unlocking stays with Windows (Hello / PIN / password). */
  async lockPc(force = false): Promise<string> {
    if (this.opts.demoLive || this.opts.e2e) return 'Not locking: this is a test run.';
    // R8-4 / R9-2: never cut into a call without asking; only "lock my PC anyway" locks regardless.
    const onCall = force ? [] : await this.micUsers();
    if (onCall.length) {
      console.log(`[session] lock skipped: microphone in use (${onCall.map(exeName).join(', ')})`);
      return `You seem to be on a call (${onCall.map(appLabel).join(', ')} is using the microphone), so I didn’t lock. Say “lock my PC anyway” to lock it. If that app is always on, mark it “Not a call” in Settings → Voice.`;
    }
    try {
      this.dismiss();
      await this.session.lockWorkstation();
      console.log('[session] locked by request');
      return 'Locked.';
    } catch (e) {
      return `I couldn’t lock the PC (${(e as Error).message}).`;
    }
  }

  setPaused(paused: boolean) {
    this.settings.update({ paused });
    void this.helper?.setHookEnabled(!paused).catch(() => undefined);
    if (paused) void this.stopVoice();
    else if (this.settings.get().voice.enabled) void this.startVoice();
  }

  newChat() {
    this.conv.newChat();
    sendPanel(this.panel, { type: 'reset' });
  }

  // ---------------------------------------------------------------- voice ---

  setVoiceEngine(engine: VoiceEngine) {
    void this.voice.stop();
    this.voice = engine;
    if (this.settings.get().voice.enabled && !this.settings.get().paused) void this.startVoice();
  }

  private voiceWired = new WeakSet<object>();
  /** Round 5 latency bookkeeping (end of the user's speech → first audio). */
  private speechEndedAt = 0;
  private firstAudioLogged = true;
  lastLatencyMs: number | null = null;
  /** Test hook (voice soak measurements). */
  emit?: (ev: string, v: unknown) => void;

  private wireVoice(v: VoiceEngine) {
    if (this.voiceWired.has(v)) return;
    this.voiceWired.add(v);
    v.on('health', (h: { state: VoiceHealth; detail: string }) => {
      console.log(`[voice] health ${h.state}${h.detail ? ` (${h.detail})` : ''}`);
      sendPanel(this.panel, { type: 'voice-health', state: h.state, text: HEALTH_TEXT[h.state], problem: healthIsProblem(h.state) });
      this.refreshTray();
    });
    v.on('rejected', (m: { reason: string }) => {
      // Round 10.5: the follow-up heard only noise → treat as silence (the panel goes away).
      if (/empty follow-up/.test(m.reason) && this.greetWindowUntil < Date.now()) this.conv.followUpExpired(true);
      if (/push-to-talk/.test(m.reason)) {
        if (this.panelVisible) sendPanel(this.panel, { type: 'notice', text: 'I didn’t hear anything. Hold Ctrl+Win while you speak.', tone: 'info' });
        else this.tray?.displayBalloon?.({ title: 'Cadabra', content: 'I didn’t hear anything. Hold Ctrl+Win while you speak.', noSound: true });
      }
    });
    v.on('state', (st: VoiceState) => {
      this.voiceState = st;
      sendPanel(this.panel, { type: 'voice', state: st });
      this.refreshTray();
    });
    v.on('level', (level: number) => {
      if (this.panelVisible) sendPanel(this.panel, { type: 'voice', state: this.voiceState, level });
    });
    v.on('partial', (partial: string) => sendPanel(this.panel, { type: 'voice', state: 'transcribing', partial }));
    v.on('utterance', (u: VoiceUtterance) => {
      // Round 5 latency: end of speech ≈ now − ASR time − the endpoint silence waited.
      this.speechEndedAt = Date.now() - ((u as any).asrMs ?? 0) - ((u as any).silenceMs ?? 0);
      this.firstAudioLogged = false;
      void this.onVoice(u);
    });
    v.on('wake', () => {
      // Round 5: start the backend session while the user is still talking.
      const s = this.settings.get();
      if (!s.paused) this.providers[s.provider].prewarm?.(this.turnModel(s.provider, true));
    });
    v.on('tts', (state: string) => {
      if (state === 'start' && this.greetEventAt) {
        console.log(`[greet] first audio ${Date.now() - this.greetEventAt} ms after the event`);
        this.greetEventAt = 0;
      }
    });
    v.on('tts', (state: string) => {
      if (state !== 'start' || this.firstAudioLogged || !this.speechEndedAt) return;
      this.firstAudioLogged = true;
      const ms = Date.now() - this.speechEndedAt;
      this.lastLatencyMs = ms;
      console.log(`[latency] end of speech → first audio: ${ms} ms`);
      this.emit?.('latency', ms);
    });
    v.on('followup', (st: string) => {
      if (st === 'armed') this.followArmedAt = Date.now();
      // Round 10.5: silence after a reply ends the conversation on screen (context kept 3 min).
      if (st === 'expired') this.conv.followUpExpired();
      if (st === 'heard') this.conv.followUpHeard();
    });
    // Round 10.5: watch other apps' audio while we speak and through the window that follows.
    v.on('tts', (state: string) => {
      if (state === 'start') this.media.watchFor(20_000);
    });
    v.on('error', (e: Error) => {
      console.warn('[voice] error:', e.message);
      if (this.panelVisible) sendPanel(this.panel, { type: 'notice', text: `Voice: ${e.message}`, tone: 'warn' });
      this.tray?.setToolTip(`Cadabra — voice error: ${e.message}`.slice(0, 120));
    });
    v.on('tts-progress', (pct: number) => sendPanel(this.panel, { type: 'tts-progress', pct }));
    v.on('tts-slow', (rtf: number) => {
      console.warn(`[tts] natural voice too slow on this PC (RTF ${rtf.toFixed(2)}); using the Windows voice`);
      sendPanel(this.panel, { type: 'notice', text: 'This PC is a little slow for the natural voice, so Cadabra switched to the Windows voice for now.', tone: 'info' });
    });
    v.on('progress', (pct: number) => {
      this.tray?.setToolTip(`Cadabra — downloading the speech model… ${pct}%`);
      sendPanel(this.panel, { type: 'voice-progress', pct });
      if (pct === 0 || pct === 100) this.refreshTray();
    });
    // Round 4.5: the voice pipeline always logs (to %APPDATA%\Cadabra OS\logs\cadabra.log, redacted).
    v.on('debug', (m: string) => console.log('[voice]', m));
  }

  async startVoice() {
    const v = this.voice;
    this.wireVoice(v);
    const vs = this.settings.get().voice;
    void this.helper?.call('set_ptt_enabled', { enabled: vs.pushToTalk }).catch(() => undefined);
    console.log(`[voice] starting (push-to-talk ${vs.pushToTalk ? 'on' : 'off'}, sensitivity ${vs.sensitivity})`);
    try {
      await v.start();
    } catch (e) {
      console.warn('voice start failed', e);
    }
  }

  /** Settings → Voice changed (also used by the voice soak test). */
  onVoiceSettingsChanged(before: Settings, after: Settings) {
    if (before.voice.wakeWord !== after.voice.wakeWord) {
      setAssistantLabel(assistantName(after.voice.wakeWord));
      console.log('[voice] assistant name / wake word changed');
      this.refreshTray();
    }
    if (before.voice.enabled !== after.voice.enabled) void (after.voice.enabled ? this.startVoice() : this.stopVoice());
    // Round 7: another microphone was picked: reopen the capture on it.
    if (after.voice.enabled && before.voice.inputDevice !== after.voice.inputDevice) {
      console.log('[voice] microphone choice changed');
      void this.restartVoice();
      return;
    }
    // Sensitivity or the wake word itself: the keyword spotter is rebuilt.
    else if (after.voice.enabled && (before.voice.sensitivity !== after.voice.sensitivity || before.voice.wakeWord !== after.voice.wakeWord)) {
      void this.stopVoice().then(() => this.startVoice());
    } else if (after.voice.enabled && before.voice.pushToTalk !== after.voice.pushToTalk) {
      // Round 4.5: no full restart (each restart re-opens the microphone).
      void this.helper?.call('set_ptt_enabled', { enabled: after.voice.pushToTalk }).catch(() => undefined);
      if (this.voice instanceof SherpaVoiceEngine) this.voice.setWakeMuted(after.voice.pushToTalk);
      console.log(`[voice] push-to-talk ${after.voice.pushToTalk ? 'on' : 'off'}`);
      this.refreshTray();
    }
  }

  // ------------------------------------------------------------ web / weather --

  readonly weather = new WeatherService({ locale: () => app.getLocale() });

  /** Round 7: backends start their sessions with web tools on or off; restart them. */
  onWebAccessChanged() {
    console.log(`[web] web access ${this.settings.get().webAccess ? 'on' : 'off'}; with a Claude API key ${this.settings.get().claudeApiWeb ? 'on' : 'off'}`);
    for (const p of Object.values(this.providers)) {
      p.reset?.();
      void p.dispose?.();
    }
    this.refreshTray();
  }

  /**
   * Round 7: the weather fast path ("what's the weather", "rain this weekend").
   * Returns null when the text isn't a plain weather question.
   */
  async localWeather(text: string): Promise<{ text: string; askCity?: WeatherDay } | null> {
    const q = parseWeatherQuery(text, this.settings.get().voice.wakeWord);
    if (!q) return null;
    const city = q.city ?? this.settings.get().location;
    if (!city) return { text: 'Which city should I use for weather?', askCity: q.day };
    const r = await this.weather.lookup(city, q.day);
    console.log(`[weather] ${'error' in r ? 'failed' : 'ok'} (${q.day})`);
    // Not a place Open-Meteo knows ("how cold is it in space"): let the AI answer.
    if ('error' in r && r.notFound && q.city) return null;
    return { text: 'error' in r ? r.error : r.text };
  }

  /** Remember "Your location" (asked once in conversation, or from Settings / onboarding). */
  rememberLocation(city: string) {
    const c = city.replace(/^(in|for|at|it'?s|i'?m in|use)\s+/i, '').replace(/[.!?]+$/, '').trim();
    if (c) this.settings.update({ location: c.charAt(0).toUpperCase() + c.slice(1) });
    return this.settings.get().location;
  }

  /** Tray → "Restart voice" (and the panel notice's action). */
  async restartVoice() {
    console.log('[voice] restart requested');
    if (!this.settings.get().voice.enabled || this.settings.get().paused) return;
    if (this.voice instanceof SherpaVoiceEngine) {
      this.voice.watch.manualRestart();
      await this.voice.restart();
    } else await this.stopVoice().then(() => this.startVoice());
  }

  /** Voice is on but not hearing anything: tell the user plainly (panel notice, or a tray balloon). */
  private voiceProblemNotice(fromPtt = false) {
    const v = this.voice instanceof SherpaVoiceEngine ? this.voice : null;
    if (!v || !healthIsProblem(v.health)) return;
    const fix = v.health === 'no-mic-access' ? 'Settings → Voice → Open microphone settings to allow it.' : 'Tray → Restart voice if it doesn’t recover.';
    const t0 = HEALTH_TEXT[v.health];
    const text = `${/[.!?…)]$/.test(t0) ? t0 : `${t0}.`}${fromPtt ? ' Push-to-talk can’t hear you right now.' : ''} ${fix}`;
    if (this.panelVisible) sendPanel(this.panel, { type: 'notice', text, tone: 'warn' });
    else this.tray?.displayBalloon?.({ title: 'Cadabra voice', content: text, noSound: true });
  }

  /** Old per-process MCP config files (they hold a localhost bearer token) left by a crash or kill. */
  private cleanStaleSessionFiles() {
    const dir = path.join(app.getPath('userData'), 'agent-work');
    try {
      for (const f of fs.readdirSync(dir)) if (/^claude-(mcp|prompt)-[0-9a-f]+\.(json|txt)$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
    } catch {
      /* none */
    }
  }

  async stopVoice() {
    console.log('[voice] stopping');
    void this.helper?.call('set_ptt_enabled', { enabled: false }).catch(() => undefined);
    await this.voice.stop().catch(() => undefined);
    this.voiceState = 'off';
    this.refreshTray();
  }

  private async onVoice(u: VoiceUtterance) {
    console.log(`[voice] handling utterance (${u.request.length} chars)`);
    if (this.settings.get().paused) return;
    const req = u.request.trim();
    // B3: while acting, speech is "stop" / "yes" / "no" or gets queued — never dropped.
    if (this.conv.busy) {
      await this.send(req, 'voice');
      return;
    }
    // Round 10.5: when did this wake-free utterance start, relative to the window opening?
    const startLagMs = Date.now() - ((u as any).asrMs ?? 0) - ((u as any).audioMs ?? 0) - this.followArmedAt;
    if ((u as any).followUp && this.greetWindowUntil > Date.now()) {
      this.conv.followUpEnded();
      // Only a short reply that starts right away counts; anything else is ignored silently.
      if (!acceptGreetingReply({ text: req, startLagMs })) {
        this.greetWindowUntil = 0;
        console.log(`[greet] reply ignored (${req.split(/\s+/).filter(Boolean).length} words, started ${Math.round(startLagMs)} ms in)`);
        return;
      }
      await this.onGreetingReply(req);
      return;
    }
    if ((u as any).followUp) {
      this.conv.followUpEnded();
      // Round 10.5: nothing valid was said in the window → the conversation goes away (context kept).
      if (!req) return this.conv.followUpExpired(true);
      if (followUpLooksLikeMedia({ text: (u as any).text ?? req, audioMs: (u as any).audioMs ?? 0, startLagMs, name: assistantName(this.settings.get().voice.wakeWord) })) {
        console.log(`[voice] follow-up ignored: looks like media (${Math.round(((u as any).audioMs ?? 0) / 1000)} s of speech, started ${Math.round(startLagMs)} ms in)`);
        return this.conv.followUpExpired(true);
      }
      // N11: filter echo and noise BEFORE anything is shown.
      const startedAt = Date.now() - ((u as any).audioMs ?? 0);
      if (!this.conv.acceptVoice(req, true, startedAt)) return this.conv.followUpExpired(true);
      // V4: the follow-up outlives the panel; bring it back without stealing focus.
      if (!this.panelVisible) await this.reshowPanel();
      await this.conv.onVoice(req, true, startedAt);
      this.refreshTray();
      return;
    }
    if (!req) {
      // Round 4.5: "Cadabra … (pause) … what time is it" lost the request: the
      // capture ended after the wake word and the panel opened deaf. Now the
      // panel opens AND listens for the request (no wake word needed).
      await this.openAtCursor();
      if (this.voice instanceof SherpaVoiceEngine && !(u as any).manual) {
        console.log('[voice] wake word without a request: listening for it');
        this.voice.armFollowUp(Math.max(6, this.settings.get().voice.followUpSeconds) * 1000);
      }
      return;
    }
    // "Cadabra, open Spotify" -> launch right away, no panel needed.
    const launchQ = parseLaunchIntent(req);
    // Round 10: web addresses go through the panel (it shows the parsed address).
    if (!this.panelVisible && launchQ && !spokenUrlCandidates(req, { wakeWord: this.settings.get().voice.wakeWord })) {
      await this.appIndex.ready();
      const ms = this.appIndex.find(launchQ, 4);
      if (ms.length && isConfident(ms)) {
        await this.launchIndexed(ms[0].app, true);
        return;
      }
    }
    // Settings commands work instantly without opening the panel.
    const intent = parseIntent(req, { models: (await this.providerInfo(this.settings.get().provider, false)).models });
    if (intent && !this.panelVisible) {
      const msg = await this.applyIntent(intent);
      this.tray?.displayBalloon?.({ title: 'Cadabra', content: msg.replace(/\*\*/g, ''), noSound: true });
      return;
    }
    if (this.panelVisible) {
      await this.conv.onVoice(req, false);
      return;
    }
    // V1: a wake word within a few minutes continues the conversation, whatever window is under the cursor.
    if (this.conv.conversation?.voice && !this.conv.shouldStartFresh(null, { voice: true })) {
      await this.reshowPanel();
      await this.conv.onVoice(req, false);
      return;
    }
    await this.openAtCursor(req);
  }

  /** Bring the panel back where it was (no fresh conversation, no focus steal). */
  private async reshowPanel() {
    const panel = this.panel;
    if (!panel || this.panelVisible) return;
    const info = await this.providerInfo(this.settings.get().provider, false);
    sendPanel(panel, { type: 'summon', origin: this.panelOrigin, target: this.target ? { title: this.target.title, process: this.target.process } : null, provider: info, model: this.currentModel(), reducedMotion: this.reducedMotion(), fresh: false });
    await this.revealPanel(this.reducedMotion(), false);
    this.panelVisible = true;
  }

  // ------------------------------------------------------------- providers --

  /** Honest tray labels for how each backend is reached. */
  providerLabel(id: ProviderId): string {
    const s = this.settings.get();
    if (id === 'claude') return s.claudeRoute === 'claude-code' ? 'Claude · via Claude Code login' : s.claudeRoute === 'bedrock' ? 'Claude · Amazon Bedrock' : s.claudeRoute === 'vertex' ? 'Claude · Vertex AI' : 'Claude · API key';
    if (id === 'codex') return 'OpenAI · via Codex';
    if (id === 'gemini') return 'Gemini · via Gemini CLI';
    return this.providers[id].label;
  }

  async providerInfo(id: ProviderId, refresh: boolean): Promise<ProviderInfo> {
    const p = this.providers[id];
    const cached = this.authCache.get(id);
    if (cached && !refresh && Date.now() - cached.at < 120_000) return { id, label: p.label, models: cached.models, auth: cached.auth };
    if (!refresh && (id === 'copilot' || id === 'codex' || id === 'gemini') && !cached) {
      // Don't spawn heavy runtimes just to render a pill (N12); only the selected
      // backend is checked in the background.
      if (id === this.settings.get().provider) void this.providerInfo(id, true).then(() => this.refreshTray());
      return { id, label: p.label, models: [], auth: undefined };
    }
    const [auth, models] = await Promise.all([p.checkAuth().catch((e) => ({ ok: false, detail: String(e?.message ?? e) })), p.listModels().catch(() => [])]);
    this.authCache.set(id, { at: Date.now(), auth, models });
    // Fill in a default model if none chosen yet.
    const s = this.settings.get();
    if (!s.models[id] && models.length) {
      const def = models.find((m) => m.default) ?? models[0];
      if (def.id) this.settings.update({ models: { ...s.models, [id]: def.id } });
    }
    return { id, label: p.label, models, auth };
  }

  // -------------------------------------------------------------- accounts --

  private async accountOptions(id: ProviderId) {
    const p = this.providers[id];
    this.authCache.delete(id);
    const auth = await p.checkAuth().catch((e) => ({ ok: false, detail: String(e?.message ?? e) }));
    const s = this.settings.get();
    // Neither Claude choice is pre-selected until one is actually connected.
    const active = !auth.ok ? undefined : id === 'claude' ? s.claudeRoute : id === 'gemini' && this.settings.hasSecret('geminiApiKey') ? 'gemini-api-key' : undefined;
    return { id, label: p.label, auth, options: p.signInOptions?.() ?? [], active, canSignOut: !!p.signOut || id === 'gemini' || id === 'claude', install: await this.installInfo(id) };
  }

  /** Part B: install offer for a missing CLI (exact command shown before consent). */
  private async installInfo(id: ProviderId) {
    const cli = (id === 'claude' || id === 'codex' || id === 'gemini' ? id : null) as CliId | null;
    if (!cli) return undefined;
    const s = this.settings.get();
    const installed = cli === 'claude' ? !!resolveUserClaudeCode(s.cli.claudePath) : cli === 'codex' ? !!resolveCodexExecutable(s.cli.codexPath) : !!resolveGeminiExecutable(s.cli.geminiPath);
    if (installed) return { installed: true };
    const spec = CLI_INSTALLS[cli];
    return { installed: false, name: spec.name, command: spec.displayCommand, manual: spec.manual, docsUrl: spec.docsUrl, blocker: await installBlocker(spec) };
  }

  private installing = new Set<CliId>();

  /** Runs the official installer after the user agreed to the exact command. */
  private async installCliFor(id: ProviderId) {
    const cli = id as CliId;
    const spec = CLI_INSTALLS[cli];
    if (!spec || this.installing.has(cli)) return null;
    this.installing.add(cli);
    try {
      const res = await installCli(spec, { line: (t) => sendPanel(this.panel, { type: 'account-status', provider: id, text: t }) });
      this.authCache.delete(id);
      return { ...res, output: res.output.slice(-2000), view: await this.accountOptions(id) };
    } finally {
      this.installing.delete(cli);
    }
  }

  private async signIn(id: ProviderId, optionId: string, key?: string) {
    const p = this.providers[id];
    const status = (text: string) => sendPanel(this.panel, { type: 'account-status', provider: id, text });
    try {
      if (id === 'claude') {
        const route = optionId === 'bedrock' || optionId === 'vertex' || optionId === 'claude-code' ? optionId : 'api-key';
        if (route === 'api-key' && key?.trim()) this.settings.setSecret('anthropicApiKey', key.trim());
        this.settings.update({ claudeRoute: route });
      }
      if (id === 'gemini' && optionId === 'gemini-api-key' && key?.trim()) this.settings.setSecret('geminiApiKey', key.trim());
      if (id === 'gemini' && optionId !== 'gemini-api-key' && this.settings.hasSecret('geminiApiKey')) this.settings.setSecret('geminiApiKey', null);
      if (!p.signIn) throw new Error(`${p.label} signs in with its own CLI.`);
      const auth = await p.signIn(optionId, {
        apiKey: key,
        status,
        // Vendor pages only open in the user's own browser, and only over https.
        openUrl: (url) => {
          if (/^https:\/\//i.test(url)) void shell.openExternal(url);
        },
      });
      this.authCache.delete(id);
      this.refreshTray();
      return { ...(await this.accountOptions(id)), auth };
    } catch (e) {
      return { ...(await this.accountOptions(id)), error: (e as Error).message };
    }
  }

  private async signOut(id: ProviderId) {
    if (id === 'claude') this.settings.setSecret('anthropicApiKey', null);
    if (id === 'gemini') this.settings.setSecret('geminiApiKey', null);
    await this.providers[id].signOut?.().catch(() => undefined);
    this.providers[id].reset?.();
    this.authCache.delete(id);
  }

  /** Live test: one tiny real request through the backend (onboarding / settings). */
  private async testProvider(id: ProviderId): Promise<{ ok: boolean; text?: string; error?: string }> {
    // N8: never touch the live conversation: refuse while busy and use a
    // throwaway provider instance that is disposed afterwards.
    if (this.conv.busy) return { ok: false, error: 'Cadabra is working on a request; try the test when it finishes.' };
    const p = this.makeProvider(id);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 45_000);
    let text = '';
    try {
      for await (const ev of p.send({ prompt: 'Connection test from Cadabra setup. Reply with just: Ready.', contextText: '', model: this.settings.get().models[id], signal: ac.signal })) {
        if (ev.type === 'text') text += ev.delta;
        if (ev.type === 'error') return { ok: false, error: ev.message };
        if (ev.type === 'done') break;
      }
      return ac.signal.aborted ? { ok: false, error: 'No answer within 45 seconds.' } : { ok: true, text: text.trim().slice(0, 200) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      clearTimeout(timer);
      p.reset?.();
      await p.dispose?.().catch(() => undefined);
    }
  }

  async allProviders(): Promise<ProviderInfo[]> {
    return Promise.all((['claude', 'copilot', 'codex', 'gemini', 'demo'] as ProviderId[]).map((id) => this.providerInfo(id, id === 'claude' || id === 'demo')));
  }

  async setModel(provider: ProviderId, model: string) {
    const s = this.settings.get();
    if (provider !== s.provider) this.conv.newChat();
    this.settings.update({ provider, models: { ...s.models, [provider]: model } });
    const info = await this.providerInfo(provider, false);
    sendPanel(this.panel, { type: 'model', provider: info, model });
  }

  // ------------------------------------------------------------------ IPC ---

  private wirePanel() {
    const panel = this.panel!;
    // Windows draws inactive acrylic as a flat fallback colour; let the renderer
    // switch to its own deep-indigo glass so it never looks grey.
    panel.on('focus', () => sendPanel(panel, { type: 'focus', focused: true }));
    panel.on('blur', () => sendPanel(panel, { type: 'focus', focused: false }));
    panel.on('blur', () => {
      // Click-away dissolves the panel — unless Cadabra is busy acting or asking.
      if (this.panelVisible && this.conv.blurMayDismiss() && !this.opts.demoLive) this.dismiss();
    });
    panel.on('close', (e) => {
      if (!this.quitting) {
        e.preventDefault();
        this.dismiss();
      }
    });
  }

  private wireIpc() {
    const fromPanel = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => e.sender === this.panel?.webContents;
    ipcMain.on('panel:send', (e, text: string) => fromPanel(e) && void this.send(text, 'typed'));
    ipcMain.on('panel:cancel', (e) => fromPanel(e) && this.cancelRun('Stopped.'));
    ipcMain.on('panel:dismiss', (e) => {
      if (!fromPanel(e)) return;
      if (this.conv.busy) this.cancelRun('Stopped.');
      else this.dismiss();
    });
    ipcMain.on('panel:confirm', (e, id: string, allowed: boolean, always?: boolean) => {
      if (!fromPanel(e)) return;
      const r = this.confirms.get(id);
      if (r) {
        this.confirms.delete(id);
        sendPanel(this.panel, { type: 'confirm-resolved', id, allowed: !!allowed });
        r(allowed && always ? 'always' : !!allowed);
      }
    });
    // Round 11: Settings → Permissions ("Always allow" grants).
    ipcMain.handle('perm:list', (e) => (fromPanel(e) ? (this.settings.get().safety.grants ?? []) : null));
    ipcMain.handle('perm:revoke', (e, scope: string, cls: string) => {
      if (!fromPanel(e)) return null;
      const s = this.settings.get().safety;
      this.settings.update({ safety: { ...s, grants: (s.grants ?? []).filter((g) => !(g.scope === scope && g.cls === cls)) } });
      console.log('[gate] an "always allow" grant was revoked');
      return this.settings.get().safety.grants ?? [];
    });
    ipcMain.handle('panel:providers', (e) => (fromPanel(e) ? this.allProviders() : []));
    ipcMain.handle('panel:set-model', (e, p: ProviderId, m: string) => (fromPanel(e) ? this.setModel(p, m) : undefined));
    ipcMain.on('panel:new-chat', (e) => fromPanel(e) && this.newChat());
    // 0.9.9: "Clear chat history…" (panel button, Settings → Privacy): asks with a card first.
    ipcMain.handle('history:clear', async (e) => (fromPanel(e) ? this.askClearHistory('pc', false, false) : null));
    ipcMain.on('panel:launch-app', (e, id: string) => {
      if (!fromPanel(e)) return;
      const a = this.appIndex.get(id);
      if (!a) return;
      void this.launchIndexed(a, true).then((msg) => {
        sendPanel(this.panel, { type: 'event', event: { type: 'text', delta: msg } });
        sendPanel(this.panel, { type: 'event', event: { type: 'done' } });
      sendPanel(this.panel, { type: 'busy', busy: false });
      });
    });
    ipcMain.on('panel:open-external', (e, url: string) => {
      if (fromPanel(e) && /^https:\/\//i.test(url)) void shell.openExternal(url);
    });
    ipcMain.on('panel:open-settings', (e) => fromPanel(e) && sendPanel(this.panel, { type: 'view', view: 'settings' }));
    ipcMain.on('panel:ready', () => undefined);
    ipcMain.handle('settings:get', (e) => {
      if (!fromPanel(e)) return null;
      return {
        settings: this.settings.get(),
        secrets: { anthropicApiKey: this.settings.hasSecret('anthropicApiKey') },
        encryption: safeStorage.isEncryptionAvailable(),
        voice: { state: this.voiceState, engine: this.voice.name },
        version: app.getVersion(),
      };
    });
    ipcMain.handle('settings:set', (e, raw: Partial<Settings>) => {
      if (!fromPanel(e)) return null;
      const patch = sanitizeRendererPatch(raw);
      const before = this.settings.get();
      const after = this.settings.update(patch);
      if (before.launchAtLogin !== after.launchAtLogin) app.setLoginItemSettings({ openAtLogin: after.launchAtLogin, args: ['--hidden'] });
      if (before.paused !== after.paused) this.setPaused(after.paused);
      this.onVoiceSettingsChanged(before, after);
      if (before.provider !== after.provider) this.conv.newChat();
      if (before.webAccess !== after.webAccess || before.claudeApiWeb !== after.claudeApiWeb) this.onWebAccessChanged();
      if (JSON.stringify(before.summon) !== JSON.stringify(after.summon)) void this.applyBinding();
      this.authCache.clear();
      return after;
    });
    ipcMain.handle('secret:set', (e, key: SecretKey, value: string | null) => {
      if (!fromPanel(e) || !['anthropicApiKey', 'geminiApiKey', 'openaiApiKey'].includes(key)) return false;
      this.settings.setSecret(key, value && value.trim() ? value.trim() : null);
      if (key === 'openaiApiKey') {
        console.log(`[voice] OpenAI key for the cloud voices ${value && value.trim() ? 'saved' : 'removed'}`);
        return true;
      }
      const id: ProviderId = key === 'geminiApiKey' ? 'gemini' : 'claude';
      this.authCache.delete(id);
      if (id === 'gemini') void this.providers.gemini.dispose?.();
      else this.providers.claude.reset?.();
      return true;
    });
    // ---- Accounts (Priority 2): vendor logins run in the vendor's own flow. ----
    ipcMain.handle('account:options', async (e, id: ProviderId) => {
      if (!fromPanel(e) || !this.providers[id]) return null;
      return this.accountOptions(id);
    });
    ipcMain.handle('account:sign-in', async (e, id: ProviderId, optionId: string, key: string | null) => {
      if (!fromPanel(e) || !this.providers[id]) return null;
      return this.signIn(id, String(optionId), key ? String(key) : undefined);
    });
    ipcMain.handle('account:sign-out', async (e, id: ProviderId) => {
      if (!fromPanel(e) || !this.providers[id]) return null;
      await this.signOut(id);
      return this.accountOptions(id);
    });
    // "Browse…": the user picks the CLI executable in an OS dialog (main-side, so
    // the renderer still can't set executable paths itself: S12).
    ipcMain.handle('account:browse-cli', async (e, id: ProviderId) => {
      if (!fromPanel(e) || !['claude', 'codex', 'gemini'].includes(id)) return null;
      const r = await dialog.showOpenDialog(this.panel!, {
        title: id === 'claude' ? 'Find the Claude Code app (claude.exe)' : `Choose the ${id === 'codex' ? 'Codex' : 'Gemini'} executable`,
        properties: ['openFile'],
        filters: [{ name: 'Programs', extensions: ['exe', 'cmd'] }],
      });
      const file = r.canceled ? undefined : r.filePaths[0];
      if (file && /\.(exe|cmd)$/i.test(file)) {
        const key = id === 'claude' ? 'claudePath' : id === 'codex' ? 'codexPath' : 'geminiPath';
        this.settings.update({ cli: { ...this.settings.get().cli, [key]: file } });
        this.providers[id].reset?.();
        await this.providers[id].dispose?.().catch(() => undefined);
      }
      return this.accountOptions(id);
    });
    ipcMain.handle('account:install', async (e, id: ProviderId) => (fromPanel(e) && this.providers[id] ? this.installCliFor(id) : null));
    ipcMain.handle('account:test', async (e, id: ProviderId) => (fromPanel(e) && this.providers[id] ? this.testProvider(id) : null));
    ipcMain.handle('onboard:mic', (e) => {
      if (!fromPanel(e)) return null;
      try {
        return systemPreferences.getMediaAccessStatus('microphone');
      } catch {
        return 'unknown';
      }
    });
    ipcMain.on('onboard:open-mic-settings', (e) => fromPanel(e) && void shell.openExternal('ms-settings:privacy-microphone'));
    // ---- Round 12: WhatsApp (remote access). The token goes to safeStorage and never comes back to the renderer. ----
    ipcMain.handle('wa:status', (e) => (fromPanel(e) ? this.waStatus() : null));
    ipcMain.handle('wa:set-token', async (e, token: string | null) => {
      if (!fromPanel(e)) return null;
      const t = typeof token === 'string' ? token.trim() : '';
      if (t && !safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Windows encryption is unavailable, so Cadabra can’t store the key safely.' };
      if (t && (t.length < 8 || t.length > 4096 || /\s/.test(t))) return { ok: false, error: 'That doesn’t look like an API key. Copy it again from WhatsApp → the agent chat → Chat info → API key.' };
      this.settings.setSecret('whatsappToken', t || null);
      if (!t) this.settings.update({ remote: { ...this.settings.get().remote, enabled: false, offset: null } });
      console.log(`[whatsapp] API key ${t ? 'saved' : 'removed'}`);
      return { ok: true, status: this.waStatus() };
    });
    ipcMain.handle('wa:test', async (e) => {
      if (!fromPanel(e)) return null;
      if (this.opts.demoLive || this.opts.e2e) return { ok: false, error: 'Not available in a test run.' };
      try {
        // A zero-timeout poll: proves the key works; nothing is consumed.
        await this.waClient.poll(this.settings.get().remote.offset ?? undefined, 0);
        console.log('[whatsapp] connection test ok');
        return { ok: true };
      } catch (err) {
        console.log('[whatsapp] connection test failed');
        return { ok: false, error: (err as Error).message };
      }
    });
    ipcMain.handle('wa:enable', (e, on: boolean) => {
      if (!fromPanel(e)) return null;
      this.settings.update({ remote: { ...this.settings.get().remote, enabled: !!on } });
      console.log(`[whatsapp] remote access ${on ? 'on' : 'off'}`);
      if (on && !this.settings.get().remote.pairedFrom) this.remote.beginPairing();
      this.refreshTray();
      return this.waStatus();
    });
    ipcMain.handle('wa:pair', (e) => (fromPanel(e) ? { code: this.remote.beginPairing() } : null));
    ipcMain.handle('wa:unpair', (e) => {
      if (!fromPanel(e)) return null;
      this.remote.unpair();
      return this.waStatus();
    });
    ipcMain.handle('wa:power', (e, p: { wakeDisplay?: boolean; keepAwake?: boolean }) => {
      if (!fromPanel(e) || !p || typeof p !== 'object') return null;
      const r = this.settings.get().remote;
      this.settings.update({ remote: { ...r, ...(typeof p.wakeDisplay === 'boolean' ? { wakeDisplay: p.wakeDisplay } : {}), ...(typeof p.keepAwake === 'boolean' ? { keepAwake: p.keepAwake } : {}) } });
      return this.waStatus();
    });
    ipcMain.handle('wa:autonomy', (e, a: string) => {
      if (!fromPanel(e) || !['risky', 'every', 'none'].includes(a)) return null;
      this.settings.update({ remote: { ...this.settings.get().remote, autonomy: a as 'risky' | 'every' | 'none' } });
      return this.waStatus();
    });
    // ---- Round 8: Email (read-only Gmail). Secrets go to safeStorage; nothing is logged but the outcome. ----
    ipcMain.handle('email:status', (e) => (fromPanel(e) ? this.emailStatus() : null));
    // 0.9.6: Settings → Announcements.
    ipcMain.handle('announce:outputs', async (e) => (fromPanel(e) && this.voice instanceof SherpaVoiceEngine ? this.voice.outputDevices().catch(() => []) : []));
    ipcMain.handle('announce:test', async (e) => {
      if (!fromPanel(e)) return null;
      const r = await this.announcer.announce('This is a test announcement from Cadabra.', 'pc');
      return { ok: r.ok, reason: r.reason };
    });
    // 0.9.5: Settings → Skills.
    ipcMain.handle('skills:list', (e) => (fromPanel(e) && this.skills ? { skills: this.skills.list(), userDir: this.skillDirs().userDir, builtinDir: this.skillDirs().builtinDir } : null));
    ipcMain.handle('skills:set-enabled', (e, id: string, on: boolean) => (fromPanel(e) && this.skills ? this.skills.setEnabled(String(id), !!on) : false));
    ipcMain.handle('skills:view', (e, id: string) => (fromPanel(e) && this.skills ? this.skills.view(String(id)) : null));
    ipcMain.handle('skills:open-folder', (e, which: string) => {
      if (!fromPanel(e) || !this.skills) return false;
      const dirs = this.skillDirs();
      // "How to make a skill" opens the README.txt in the user's skills folder.
      const target = which === 'guide' ? path.join(dirs.userDir, 'README.txt') : which === 'builtin' ? dirs.builtinDir : dirs.userDir;
      if (which === 'guide' || which === 'user') this.skills.ensureUserFolder();
      void shell.openPath(target);
      return true;
    });
    ipcMain.handle('skills:new', (e, name: string) => (fromPanel(e) ? this.newSkill(String(name)) : null));
    ipcMain.handle('skills:reload', (e) => {
      if (!fromPanel(e) || !this.skills) return null;
      this.skills.reload();
      return this.skills.list();
    });
    ipcMain.handle('email:set-bodies', (e, on: boolean) => {
      if (!fromPanel(e)) return null;
      this.settings.update({ email: { ...this.settings.get().email, allowBodies: !!on } });
      return this.emailStatus();
    });
    ipcMain.on('email:open-help', (e, which: string) => {
      if (!fromPanel(e)) return;
      const urls: Record<string, string> = {
        project: 'https://console.cloud.google.com/projectcreate',
        api: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
        audience: 'https://console.cloud.google.com/auth/audience',
        clients: 'https://console.cloud.google.com/auth/clients',
        apppasswords: 'https://myaccount.google.com/apppasswords',
        twostep: 'https://myaccount.google.com/signinoptions/twosv',
        permissions: 'https://myaccount.google.com/permissions',
      };
      if (urls[which]) void shell.openExternal(urls[which]);
    });
    ipcMain.handle('email:connect-oauth', async (e, clientIdOrJson: string, clientSecret: string | null) => {
      if (!fromPanel(e)) return null;
      if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Windows encryption is unavailable, so Cadabra can’t store the sign-in safely.' };
      const raw = String(clientIdOrJson ?? '').trim();
      const client = parseClientJson(raw) ?? (looksLikeClientId(raw) ? { clientId: raw, clientSecret: clientSecret?.trim() || undefined } : null);
      if (!client) return { ok: false, error: 'That doesn’t look like a Desktop client ID (it ends in .apps.googleusercontent.com). You can also paste the downloaded JSON file’s contents.' };
      if (this.opts.demoLive || this.opts.e2e) return { ok: false, error: 'Not available in a test run.' };
      try {
        const r = await connectGmailOAuth({ client, openBrowser: (u) => shell.openExternal(u), timeoutMs: 10 * 60_000 });
        this.settings.setSecret('gmailRefreshToken', r.refreshToken);
        this.settings.setSecret('gmailClientSecret', client.clientSecret ?? null);
        this.settings.setSecret('gmailAppPassword', null);
        this.settings.update({ email: { ...this.settings.get().email, mode: 'gmail-oauth', clientId: client.clientId, address: r.address } });
        await this.email.reset();
        console.log('[email] connected (own Google key)');
        return { ok: true, status: this.emailStatus() };
      } catch (err) {
        console.log('[email] connect failed (own Google key)');
        return { ok: false, error: (err as Error).message.slice(0, 300) };
      }
    });
    ipcMain.handle('email:connect-imap', async (e, address: string, appPassword: string) => {
      if (!fromPanel(e)) return null;
      if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Windows encryption is unavailable, so Cadabra can’t store the password safely.' };
      const addr = String(address ?? '').trim();
      const pass = String(appPassword ?? '').replace(/\s+/g, '');
      if (!isPersonalGmail(addr)) return { ok: false, error: 'App passwords only work for personal @gmail.com addresses (Google turned them off for work and school accounts). Use “Your own Google key” instead.' };
      if (!/^[a-z]{16}$/i.test(pass)) return { ok: false, error: 'An app password is 16 letters (spaces don’t matter). Create one at myaccount.google.com/apppasswords.' };
      if (this.opts.demoLive || this.opts.e2e) return { ok: false, error: 'Not available in a test run.' };
      const b = new ImapBackend(addr, pass);
      try {
        await b.verify();
      } catch (err) {
        console.log('[email] connect failed (app password)');
        return { ok: false, error: /auth|invalid|credential/i.test((err as Error).message) ? 'Google didn’t accept that address and app password.' : 'Couldn’t reach Gmail. Check the connection and try again.' };
      } finally {
        await b.close();
      }
      this.settings.setSecret('gmailAppPassword', pass);
      this.settings.setSecret('gmailRefreshToken', null);
      this.settings.setSecret('gmailClientSecret', null);
      this.settings.update({ email: { ...this.settings.get().email, mode: 'gmail-imap', address: addr, clientId: '' } });
      await this.email.reset();
      console.log('[email] connected (app password)');
      return { ok: true, status: this.emailStatus() };
    });
    ipcMain.handle('email:disconnect', async (e) => {
      if (!fromPanel(e)) return null;
      return this.disconnectEmail();
    });
    // Natural voice (Kokoro): status, opt-in download, user-initiated preview.
    ipcMain.handle('voice:tts-status', (e) => {
      if (!fromPanel(e)) return null;
      const v = this.voice instanceof SherpaVoiceEngine ? this.voice : null;
      return { available: !!v, installed: !!v?.tts.installed, downloading: !!v?.tts.isDownloading, sizeMb: 350, tooSlow: !!v?.tts.tooSlow, rtf: v?.tts.rtf ?? null, voices: ALL_VOICES, curated: CURATED_VOICES, cloudKey: this.settings.hasSecret('openaiApiKey'), cloudVoice: !!this.settings.get().voice.cloudVoice };
    });
    ipcMain.handle('voice:tts-download', async (e) => {
      if (!fromPanel(e) || !(this.voice instanceof SherpaVoiceEngine)) return { ok: false, error: 'Voice is unavailable in this build.' };
      try {
        this.wireVoice(this.voice);
        await this.voice.tts.download();
        this.voice.tts.prewarm(this.settings.get().voice.ttsVoice);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
    // Round 6 (REVIEW-5 #5): Settings → Voice status row.
    ipcMain.handle('voice:status', async (e) => {
      if (!fromPanel(e)) return null;
      const s = this.settings.get();
      // R9-3: which other apps hold the microphone (blocks greetings / lock as "a call").
      const notCall = new Set(s.micNotCall);
      const micApps = [...new Set((await micUsersNow()).map(exeName))].map((exe) => ({ exe, notCall: notCall.has(exe) }));
      const marked = s.micNotCall.filter((x) => !micApps.some((m) => m.exe === x)).map((exe) => ({ exe, notCall: true }));
      if (!(this.voice instanceof SherpaVoiceEngine)) return { enabled: s.voice.enabled, health: 'off', text: 'Voice is unavailable in this build', detail: '', device: '', lastRestartReason: '', lastRestartAt: null, restarts: { mic: 0, engine: 0 }, micApps: [...micApps, ...marked] };
      return { enabled: s.voice.enabled && !s.paused, ...this.voice.watch.status(), micApps: [...micApps, ...marked] };
    });
    ipcMain.handle('voice:mic-not-call', (e, exe: string, on: boolean) => {
      if (!fromPanel(e) || typeof exe !== 'string' || !/^[\w .()+-]{1,120}$/i.test(exe)) return false;
      const x = exe.toLowerCase();
      const list = this.settings.get().micNotCall.filter((y) => y !== x);
      this.settings.update({ micNotCall: on ? [...list, x].slice(-30) : list });
      console.log(`[voice] ${x} ${on ? 'marked' : 'unmarked'} "not a call"`);
      return true;
    });
    ipcMain.handle('voice:devices', async (e) => {
      if (!fromPanel(e) || !(this.voice instanceof SherpaVoiceEngine)) return { inputs: [], defaultInput: '', chosen: '' };
      const r = await this.voice.listDevices();
      return { ...r, chosen: this.settings.get().voice.inputDevice };
    });
    ipcMain.handle('voice:use-device', async (e, label: string) => {
      if (!fromPanel(e) || typeof label !== 'string') return false;
      const before = this.settings.get();
      const after = this.settings.update({ voice: { ...before.voice, inputDevice: label.slice(0, 200) } });
      if (this.voice instanceof SherpaVoiceEngine) this.voice.watch.pendingDefault = '';
      this.onVoiceSettingsChanged(before, after);
      return true;
    });
    ipcMain.handle('voice:restart', async (e) => {
      if (!fromPanel(e)) return false;
      await this.restartVoice();
      return true;
    });
    ipcMain.handle('voice:preview', async (e, voice: string, speed: number) => {
      if (!fromPanel(e) || !(this.voice instanceof SherpaVoiceEngine)) return false;
      if (!ALL_VOICES.some((v) => v.id === voice) || !(speed >= 0.8 && speed <= 1.2)) return false;
      // Cloud (Southern) voices don't need the local model; everything else does.
      if (voiceById(voice).engine !== 'openai' && !this.voice.tts.installed) return false;
      await this.voice.preview(voice, speed, PREVIEW_LINE);
      return true;
    });
    // While the shortcut recorder is open, pause the hook so the current binding doesn't fire.
    ipcMain.on('binding:recording', (e, on: boolean) => {
      if (!fromPanel(e)) return;
      void this.helper?.setHookEnabled(!on && !this.settings.get().paused).catch(() => undefined);
    });
    ipcMain.on('overlay:ready', () => undefined);
    ipcMain.on('overlay:idle', (e) => this.overlays.idle(e.sender));
  }

  openShortcutRecorder() {
    void this.showPanelCentered().then(() => sendPanel(this.panel, { type: 'view', view: 'settings', focus: 'shortcut' }));
  }

  /** Tray → "Export diagnostics…": a redacted text bundle the user can attach to a report. */
  async exportDiagnostics() {
    const providers = (['claude', 'codex', 'gemini', 'copilot'] as ProviderId[]).map((id) => ({ id, auth: this.authCache.get(id)?.auth }));
    const v = this.voice instanceof SherpaVoiceEngine ? this.voice : null;
    const kvm = await runningKvmTools(0);
    const text = diagnosticsText({
      kvm,
      version: app.getVersion(),
      settings: this.settings.get(),
      providers,
      helper: this.helperState,
      voice: v
        ? `${this.voiceState}, health ${v.health}${v.healthDetail ? ` (${v.healthDetail})` : ''}, input [${v.watch.device}], restarts mic ${v.watch.restarts.mic} / engine ${v.watch.restarts.engine}${v.watch.lastRestartReason ? `, last: ${v.watch.lastRestartReason}` : ''}, push-to-talk ${this.settings.get().voice.pushToTalk ? 'on' : 'off'}`
        : this.voiceState,
      tts: v ? { installed: v.tts.installed, rtf: v.tts.rtf, tooSlow: v.tts.tooSlow } : undefined,
      displayName: this.settings.get().displayName,
    });
    const r = await dialog.showSaveDialog({
      title: 'Save Cadabra diagnostics',
      defaultPath: path.join(app.getPath('desktop'), `cadabra-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`),
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (!r.canceled && r.filePath) fs.writeFileSync(r.filePath, text);
  }

  async openOnboarding() {
    await this.showPanelCentered();
    sendPanel(this.panel, { type: 'onboarding' });
  }

  openSettings() {
    void this.showPanelCentered().then(() => sendPanel(this.panel, { type: 'view', view: 'settings' }));
  }

  private async showPanelCentered() {
    const d = screen.getPrimaryDisplay();
    const rect = { x: Math.round(d.workArea.x + (d.workArea.width - PANEL_SIZE.width) / 2), y: Math.round(d.workArea.y + (d.workArea.height - PANEL_SIZE.height) / 2), ...PANEL_SIZE };
    this.panelOrigin = { x: PANEL_SIZE.width / 2, y: PANEL_SIZE.height / 2 };
    this.panel?.setBounds(rect);
    const info = await this.providerInfo(this.settings.get().provider, false);
    sendPanel(this.panel, {
      type: 'summon',
      origin: this.panelOrigin,
      target: null,
      provider: info,
      model: this.currentModel(),
      reducedMotion: this.reducedMotion(),
      fresh: false,
    });
    await this.revealPanel(this.reducedMotion());
    this.panelVisible = true;
  }

  // ----------------------------------------------------------------- tray ---

  private trayIcon(): Electron.NativeImage {
    const v = this.voiceState;
    // Round 4.5: the "listening" icon only when voice is really hearing the mic.
    const healthy = this.voice instanceof SherpaVoiceEngine ? this.voice.healthy : true;
    const state = this.settings.get().paused ? 'paused' : !healthy ? 'normal' : v === 'listening' || v === 'transcribing' || v === 'followup' ? 'capturing' : v === 'idle' ? 'listening' : 'normal';
    const file = resourcePath('icons', `tray-${state}.png`);
    const img = nativeImage.createFromPath(file);
    return img.isEmpty() ? nativeImage.createFromPath(resourcePath('icons', 'tray-normal.png')) : img;
  }

  private createTray() {
    this.tray = new Tray(this.trayIcon());
    this.tray.setToolTip(`Cadabra — press ${formatBinding(this.settings.get().summon)} anywhere`);
    this.tray.on('click', () => void this.openAtCursor());
    this.tray.on('right-click', () => {
      // Refresh provider states in the background for next time.
      void this.allProviders().then(() => this.refreshTray());
    });
    this.refreshTray();
  }

  private voiceStatusLabel(): string {
    const s = this.settings.get();
    if (!s.voice.enabled) return 'Voice is off';
    switch (this.voiceState) {
      case 'idle':
        return s.voice.pushToTalk ? 'Ready — hold Ctrl+Win and speak' : 'Listening for “Cadabra” (on this PC only)';
      case 'listening':
        return 'Heard you — capturing…';
      case 'followup':
        return 'Listening for your follow-up…';
      case 'transcribing':
        return 'Transcribing…';
      case 'downloading':
        return 'Downloading the speech model…';
      case 'error':
        return 'Voice error — see tooltip';
      default:
        return 'Starting…';
    }
  }

  updateVoice(patch: Partial<Settings['voice']>) {
    const before = this.settings.get();
    const after = this.settings.update({ voice: { ...before.voice, ...patch } });
    this.onVoiceSettingsChanged(before, after);
  }

  refreshTray() {
    if (!this.tray || this.tray.isDestroyed()) return;
    const s = this.settings.get();
    this.tray.setImage(this.trayIcon());
    const vh = this.voice instanceof SherpaVoiceEngine ? this.voice.health : 'off';
    const voiceTip = !s.voice.enabled ? '' : healthIsProblem(vh) ? ` · ⚠ ${HEALTH_TEXT[vh]}` : vh === 'ok' ? (s.voice.pushToTalk ? ' · hold Ctrl+Win to talk' : ` · listening for “${assistantName(s.voice.wakeWord)}”`) : ` · ${HEALTH_TEXT[vh]}`;
    this.tray.setToolTip(`${s.paused ? 'Cadabra — paused' : `Cadabra — ${this.providers[s.provider].label}${voiceTip}`}`.slice(0, 127));
    const providerItems: Electron.MenuItemConstructorOptions[] = (['claude', 'copilot', 'codex', 'gemini', 'demo'] as ProviderId[]).map((id) => {
      const c = this.authCache.get(id);
      const suffix = c ? (c.auth.ok ? '' : ` — ${c.auth.detail.toLowerCase()}`) : '';
      return { label: `${this.providerLabel(id)}${suffix}`, type: 'radio', checked: s.provider === id, click: () => void this.applyIntent({ kind: 'set-provider', provider: id }) };
    });
    const models = this.authCache.get(s.provider)?.models ?? [];
    const modelItems: Electron.MenuItemConstructorOptions[] = models.length
      ? models.map((m) => ({ label: m.label + (m.description ? `  ·  ${m.description}` : ''), type: 'radio', checked: s.models[s.provider] === m.id, click: () => void this.setModel(s.provider, m.id) }))
      : [{ label: 'Loading models…', enabled: false }];
    const menu = Menu.buildFromTemplate([
      {
        label: 'Open Cadabra',
        ...(bindingAccelerator(s.summon) ? { accelerator: bindingAccelerator(s.summon)!, registerAccelerator: false } : { sublabel: formatBinding(s.summon) }),
        click: () => void this.openAtCursor(),
      },
      { label: `Change shortcut (${formatBinding(s.summon)})…`, click: () => this.openShortcutRecorder() },
      { label: this.conv.busy ? 'Stop agent (Esc)' : 'Agent idle', enabled: this.conv.busy, click: () => this.cancelRun() },
      ...(this.helperState !== 'ok'
        ? ([
            { label: this.helperState === 'dead' ? '⚠ Helper stopped — shortcut and actions unavailable' : 'Helper stopped — restarting…', enabled: false },
            { label: 'Restart helper', enabled: this.helperState === 'dead', click: () => void this.helper?.restart().catch(() => undefined) },
          ] as Electron.MenuItemConstructorOptions[])
        : []),
      { type: 'separator' },
      { label: `Provider: ${this.providerLabel(s.provider)}`, submenu: providerItems },
      { label: 'Model', submenu: modelItems },
      { type: 'separator' },
      {
        label: s.voice.pushToTalk ? 'Voice — hold Ctrl+Win to talk' : `Voice — say “${cap(s.voice.wakeWord)}, …”`,
        type: 'checkbox',
        checked: s.voice.enabled,
        click: (i) => void this.applyIntent({ kind: 'voice', enabled: i.checked }),
      },
      ...(s.voice.enabled && !s.paused
        ? ([
            { label: `Voice status: ${HEALTH_TEXT[vh]}`, enabled: false },
            { label: 'Restart voice', click: () => void this.restartVoice() },
          ] as Electron.MenuItemConstructorOptions[])
        : []),
      {
        label: 'Voice options',
        submenu: [
          { label: this.voiceStatusLabel(), enabled: false },
          { type: 'separator' },
          ...([
            ['Low (fewer false wakes)', 0.25],
            ['Medium', 0.5],
            ['High (wakes more easily)', 0.8],
          ] as const).map(([label, val]) => ({
            label: `Sensitivity: ${label}`,
            type: 'radio' as const,
            checked: Math.abs(s.voice.sensitivity - val) < 0.13,
            click: () => this.updateVoice({ sensitivity: val }),
          })),
          { type: 'separator' },
          { label: 'Push-to-talk only (hold Ctrl+Win)', type: 'checkbox', checked: s.voice.pushToTalk, click: (i) => this.updateVoice({ pushToTalk: i.checked }) },
          { type: 'separator' },
          ...([
            ['Speak replies when I use voice', 'voice'],
            ['Always speak replies', 'always'],
            ['Never speak replies', 'never'],
          ] as const).map(([label, mode]) => ({ label, type: 'radio' as const, checked: s.voice.speakReplies === mode, click: () => this.updateVoice({ speakReplies: mode }) })),
        ],
      },
      {
        label: 'Web access',
        type: 'checkbox',
        checked: s.webAccess,
        click: (i) => {
          this.settings.update({ webAccess: i.checked });
          this.onWebAccessChanged();
        },
      },
      ...(this.settings.hasSecret('whatsappToken')
        ? ([
            {
              label: 'Remote access (WhatsApp)',
              type: 'checkbox',
              checked: s.remote.enabled,
              click: (i: Electron.MenuItem) => {
                this.settings.update({ remote: { ...this.settings.get().remote, enabled: i.checked } });
                console.log(`[whatsapp] remote access ${i.checked ? 'on' : 'off'} (tray)`);
                if (i.checked && !this.settings.get().remote.pairedFrom) this.remote.beginPairing();
                this.refreshTray();
              },
            },
          ] as Electron.MenuItemConstructorOptions[])
        : []),
      {
        // Round 11: how much Cadabra asks before acting.
        label: 'When acting on screen',
        submenu: (
          [
            ['Ask only for risky actions', 'risky'],
            ['Ask before every action', 'every'],
            ['Don’t ask (full trust)', 'none'],
          ] as const
        ).map(([label, id]) => ({
          label,
          type: 'radio' as const,
          checked: (s.safety.autonomy ?? (s.safety.confirmAllActions ? 'every' : 'risky')) === id,
          click: () => {
            this.settings.update({ safety: { ...this.settings.get().safety, autonomy: id, confirmAllActions: id === 'every' } });
            console.log(`[gate] autonomy: ${id}`);
            this.refreshTray();
          },
        })),
      },
      {
        label: 'Greetings',
        type: 'checkbox',
        checked: s.greetings.enabled,
        click: (i) => void this.applyIntent({ kind: 'greetings', enabled: i.checked }),
      },
      { label: 'Pause Cadabra', type: 'checkbox', checked: s.paused, click: (i) => this.setPaused(i.checked) },
      {
        label: 'Launch at login',
        type: 'checkbox',
        checked: s.launchAtLogin,
        click: (i) => {
          this.settings.update({ launchAtLogin: i.checked });
          app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--hidden'] });
        },
      },
      { label: 'Settings…', click: () => this.openSettings() },
      { label: 'Skills…', click: () => this.openSkills() },
      { label: 'Clear chat history…', click: () => void this.showPanelCentered().then(() => this.askClearHistory('pc', false, false)) },
      { label: 'Set up Cadabra…', click: () => void this.openOnboarding() },
      { label: 'Export diagnostics…', click: () => void this.exportDiagnostics() },
      { type: 'separator' },
      { label: `Cadabra OS ${app.getVersion()}`, enabled: false },
      { label: 'Quit Cadabra', click: () => app.quit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  // ----------------------------------------------------------------- quit ---

  async shutdown() {
    this.quitting = true;
    this.cancelRun();
    this.remote.stopLoop();
    if (this.historyTimer) clearInterval(this.historyTimer);
    await this.stopVoice();
    await Promise.all(Object.values(this.providers).map((p) => p.dispose?.().catch(() => undefined)));
    this.providers.claude.reset?.();
    // 0.9.9: "Clear when Cadabra closes".
    if ((this.settings.get().privacy?.keepHistory ?? 'until-cleared') === 'on-close') {
      const n = clearHistoryFiles(this.historyPaths()).length;
      console.log(`[history] cleared on close (${n} file(s) removed)`);
    }
    await this.mcp?.close().catch(() => undefined);
    await this.helper?.stop();
    this.tray?.destroy();
  }
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** First name from the Windows account (Microsoft account / local full name), else the username. */
export function detectDisplayName(): Promise<string> {
  const fallback = () => {
    const u = os.userInfo().username.replace(/[._-]+/g, ' ').trim();
    return u ? u.charAt(0).toUpperCase() + u.slice(1).split(' ')[0] : '';
  };
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI' -ErrorAction SilentlyContinue).LastLoggedOnDisplayName; (Get-CimInstance Win32_UserAccount -Filter \"Name='$env:USERNAME' AND LocalAccount=True\" -ErrorAction SilentlyContinue).FullName; ([ADSI]\"WinNT://$env:USERDOMAIN/$env:USERNAME,user\").FullName"],
      { windowsHide: true, timeout: 8000 },
      (_e, stdout) => {
        const full = String(stdout ?? '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l && !/[@\\]/.test(l));
        resolve(full ? full.split(/\s+/)[0] : fallback());
      },
    );
  });
}
