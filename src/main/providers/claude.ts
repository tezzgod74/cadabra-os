import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AsyncQueue } from '../../shared/async-queue';
import type { AuthStatus, ModelOption, ProviderEvent } from '../../shared/types';
import { execCli, firstExisting, npmGlobalRoots, whichSync } from '../exe-finder';
import type { ToolDef } from '../tools';
import { SYSTEM_PROMPT } from '../tools';
import { CLAUDE_MAX_TURNS, CLAUDE_SESSION_BUDGET_USD, mapClaudeMessage, newClaudeMapState } from './claude-events';
import { buildUserText, type ProviderAdapter, type SendRequest, type SignInIO, type SignInOption } from './types';
import { ClaudeCliSession, claudeAuthStatus, claudeCodeEnv, isSubscriptionLogin } from './claude-cli';

// Model ids from the Claude API reference / docs/research.md (2026-10). Used
// until the live list from `supportedModels()` is available.
export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: 'Fast and smart — great default for Cadabra', default: true },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', description: 'Most capable Opus — best for long multi-step tasks' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', description: 'Fastest — quick “what’s on screen” answers' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', description: 'Hardest reasoning (slower, pricier)' },
];

export interface ClaudeDeps {
  tools: () => ToolDef[];
  apiKey: () => string | undefined;
  /** User override for the Claude runtime executable (settings). */
  exePath: () => string | undefined;
  /** Working dir for the agent process (built-in tools are disabled; nothing is read from it). */
  workDir: string;
  version: string;
  /** 'api-key', 'claude-code' (user's subscription via Claude Code), 'bedrock' or 'vertex' (see signInOptions()). */
  route?: () => string | undefined;
  /** Cadabra-owned, empty config dir for the API-key runtime (AUTH-1 layer 3). */
  configDir?: string;
  /** Cadabra's HTTP MCP server (Claude Code mode attaches tools over HTTP). */
  mcp?: () => Promise<{ url: string; token: string }>;
  revokeSession?: (key: string) => void;
  issueSession?: (key: string) => void;
  /** Opens a visible terminal running `claude auth login` (Claude Code's own login). */
  openLoginTerminal?: (exe: string) => void;
  /** Round 7: web access setting. */
  webAccess?: () => boolean;
  /** Round 7: Cadabra's decision on one web search / fetch. */
  webGuard?: (tool: 'search' | 'fetch', text: string) => Promise<{ allow: boolean; reason?: string }>;
}

// ------------------------------------------------------------ auth boundary --
// REVIEW-3 AUTH-1: API-key mode must never be able to fall back to the user's
// claude.ai login. Four layers, each sufficient on its own:
//  1. no key → refuse to start (nothing is spawned);
//  2. the child's environment is scrubbed of every OAuth / alternative-auth
//     variable and carries only the chosen route's credentials;
//  3. CLAUDE_CONFIG_DIR points at a Cadabra-owned empty folder, so the
//     user's ~/.claude credentials are unreachable even if --bare regressed;
//  4. the runtime's own report (system/init apiKeySource) is checked and the
//     session is aborted unless the credential really is our API key.

/** Variables that could make the runtime authenticate some other way. */
export const AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
];

export type ClaudeRoute = 'api-key' | 'claude-code' | 'bedrock' | 'vertex';

/**
 * Environment for the Agent SDK runtime (API key / Bedrock / Vertex). Pure, so
 * the boundary is unit-tested. Throws when the API-key route has no key.
 */
export function claudeSdkEnv(base: NodeJS.ProcessEnv, o: { route: ClaudeRoute; key?: string; configDir: string; version: string }): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const k of Object.keys(env)) if (AUTH_ENV_VARS.includes(k) || /^CLAUDE_CODE_OAUTH/i.test(k)) delete env[k];
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `cadabra-os/${o.version}`;
  env.CLAUDE_CONFIG_DIR = o.configDir;
  if (o.route === 'bedrock') env.CLAUDE_CODE_USE_BEDROCK = '1';
  else if (o.route === 'vertex') env.CLAUDE_CODE_USE_VERTEX = '1';
  else {
    if (!o.key?.trim()) throw new NoApiKeyError();
    env.ANTHROPIC_API_KEY = o.key.trim();
  }
  return env;
}

export class NoApiKeyError extends Error {
  constructor() {
    super('Add an Anthropic API key in Settings → AI accounts → Claude (or choose “Use my Claude subscription”).');
  }
}

/** Layer 4: is the credential the runtime reports the one this route allows? */
export function authSourceAllowed(route: ClaudeRoute, init: { apiKeySource?: string }): boolean {
  if (route === 'api-key') return init.apiKeySource === 'ANTHROPIC_API_KEY';
  if (route === 'bedrock' || route === 'vertex') return init.apiKeySource === 'none' || init.apiKeySource == null;
  return true;
}

/**
 * REVIEW-4 (AUTH-1 layer 4, preventive): the runtime's account info, read
 * BEFORE the first user message is sent (no model request). Returns false when
 * it reports a credential other than the route's. Unknown (older runtime,
 * field missing) → true; the system/init check stays as the backstop.
 * Only the source fields are looked at (never the e-mail or organisation).
 */
export function accountAllowed(route: ClaudeRoute, info: { apiKeySource?: string; tokenSource?: string; apiProvider?: string } | null | undefined): boolean {
  if (!info) return true;
  if (route === 'api-key') {
    if (info.tokenSource && info.tokenSource !== 'none') return false;
    if (info.apiProvider && info.apiProvider !== 'firstParty') return false;
    return info.apiKeySource == null || info.apiKeySource === 'ANTHROPIC_API_KEY';
  }
  if (route === 'bedrock') return !info.apiProvider || info.apiProvider === 'bedrock' || info.apiProvider === 'anthropicAws';
  if (route === 'vertex') return !info.apiProvider || info.apiProvider === 'vertex' || info.apiProvider === 'anthropicGoogleCloud';
  return true;
}

/** The Agent SDK options for the API-key / cloud routes (pure; the lockdown is unit-tested). */
export function claudeSdkOptions(o: {
  model: string;
  server: unknown;
  resumeId?: string;
  workDir: string;
  env: Record<string, string | undefined>;
  exe?: string;
  /** Round 7: allow the read-only web tools, each one approved by this guard. */
  webGuard?: (tool: 'search' | 'fetch', text: string) => Promise<{ allow: boolean; reason?: string }>;
}) {
  const { model, server, resumeId, env } = o;
  const g = o.webGuard;
  return {
    model,
    // No built-in tools (no shell, no file access): only Cadabra's MCP tools,
    // plus (round 7, web access on) the read-only web tools.
    tools: g ? ['WebSearch', 'WebFetch'] : [],
    mcpServers: { cadabra: server },
    strictMcpConfig: true,
    allowedTools: ['mcp__cadabra__*'],
    // Web on: anything not pre-approved goes to canUseTool, which allows ONLY
    // web search / fetch that pass Cadabra's guard, and denies everything else.
    permissionMode: g ? 'default' : 'dontAsk',
    ...(g
      ? {
          canUseTool: async (name: string, input: any) => {
            if (name !== 'WebSearch' && name !== 'WebFetch') return { behavior: 'deny', message: 'Only Cadabra tools and read-only web access are allowed.' };
            const r = await g(name === 'WebSearch' ? 'search' : 'fetch', String(name === 'WebSearch' ? (input?.query ?? '') : (input?.url ?? '')));
            return r.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: r.reason ?? 'Not allowed.' };
          },
        }
      : {}),
    settingSources: [],
    systemPrompt: SYSTEM_PROMPT,
    includePartialMessages: true,
    // --bare: API-key auth only; never reads OAuth credentials / keychain.
    extraArgs: { bare: null },
    resume: resumeId,
    cwd: o.workDir,
    env,
    // The SDK counts turns across the whole streaming session, so this is a
    // per-process ceiling; hitting it reopens the session with resume (P4).
    maxTurns: CLAUDE_MAX_TURNS,
    // Per-chat spending cap; a capped chat is never resumed (P4).
    maxBudgetUsd: CLAUDE_SESSION_BUDGET_USD,
    pathToClaudeCodeExecutable: o.exe,
  };
}

/** Minimum Claude Code for the lockdown flags (`--permission-prompts none`). */
export const CLAUDE_CODE_MIN_VERSION = '2.1.0';
/** `--permission-prompts none` exists from 2.1.259 (docs); older builds get `dontAsk` alone. */
export const CLAUDE_CODE_PERMISSION_PROMPTS_VERSION = '2.1.259';

export function versionAtLeast(v: string, min: string): boolean {
  const a = (v.match(/\d+(\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export async function claudeVersion(exe: string): Promise<string | null> {
  const r = await execCli(exe, ['--version'], { env: claudeCodeEnv(), timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Locate a Claude Code runtime binary for the Agent SDK. We do NOT ship the
 * ~250 MB runtime in the installer (docs/research.md); order:
 *   settings override → SDK optional dependency (dev / if present) →
 *   user-installed `claude.exe` on PATH / ~/.local/bin / global npm.
 */
/**
 * Claude Code mode uses the user's OWN install (never the Agent SDK's bundled
 * runtime or the VS Code extension's binary). The official native installer
 * puts it in %USERPROFILE%\.local\bin, which is often NOT on PATH, so look
 * there explicitly, then PATH, then npm's global shim.
 */
export function resolveUserClaudeCode(override?: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | undefined {
  if (override && fs.existsSync(override)) return override;
  return firstExisting([
    path.join(home, '.local', 'bin', 'claude.exe'),
    whichSync('claude.exe', env.PATH ?? ''),
    path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm', 'claude.cmd'),
    ...npmGlobalRoots().map((r) => path.join(r, '..', 'claude.cmd')),
  ]);
}

/** A VS Code extension-bundled binary, if any (only mentioned, never used by default). */
export function findVsCodeBundledClaude(home = os.homedir()): string | undefined {
  const ext = path.join(home, '.vscode', 'extensions');
  try {
    const dir = fs.readdirSync(ext).filter((d) => /^anthropic\.claude-code-/.test(d)).sort().pop();
    const exe = dir ? path.join(ext, dir, 'resources', 'native-binary', 'claude.exe') : undefined;
    return exe && fs.existsSync(exe) ? exe : undefined;
  } catch {
    return undefined;
  }
}

export function resolveClaudeExecutable(override?: string): string | undefined {
  if (override && fs.existsSync(override)) return override;
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const exe = path.join(path.dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude');
    const unpacked = exe.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    const hit = firstExisting([unpacked, exe]);
    if (hit) return hit;
  } catch {
    /* not installed alongside the app */
  }
  const candidates = [
    whichSync('claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    ...npmGlobalRoots().flatMap((r) => [
      path.join(r, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      path.join(r, '@anthropic-ai', 'claude-code', 'claude.exe'),
      path.join(r, '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'),
      path.join(r, '@anthropic-ai', 'claude-code', 'node_modules', '@anthropic-ai', 'claude-code-win32-x64', 'claude.exe'),
    ]),
  ];
  return firstExisting(candidates);
}

interface LiveSession {
  q: any;
  inbox: AsyncQueue<any>;
  it: AsyncIterator<any>;
  model: string;
  sessionId?: string;
  dead: boolean;
  /** Hit the per-chat budget: never resume this session (that would reset the cap). */
  spent?: boolean;
  route?: ClaudeRoute;
  /** accountInfo() was checked before the first message. */
  preflighted?: boolean;
}

/**
 * Claude via @anthropic-ai/claude-agent-sdk, streaming-input mode: one
 * long-lived runtime process per chat (no per-message cold start), Cadabra's
 * tools registered in-process, every built-in tool disabled, API-key auth only
 * (`--bare`, never the user's claude.ai login — Anthropic terms).
 */
export class ClaudeProvider implements ProviderAdapter {
  readonly id = 'claude' as const;
  readonly label = 'Claude';
  private live: LiveSession | null = null;
  /** P3: one in-flight open shared by prewarm() and send(), never two runtimes. */
  private opening: Promise<LiveSession> | null = null;
  private spentSessions = new Set<string>();
  /** Claude Code (subscription) mode: one `claude -p` process per chat. */
  private cli: ClaudeCliSession | null = null;
  private liveModels: ModelOption[] | null = null;

  constructor(private readonly deps: ClaudeDeps) {}

  async listModels(): Promise<ModelOption[]> {
    return this.liveModels ?? CLAUDE_MODELS;
  }

  async checkAuth(): Promise<AuthStatus> {
    const exe = resolveClaudeExecutable(this.deps.exePath());
    if (!exe) {
      return {
        ok: false,
        detail: 'Claude runtime not found',
        howTo: 'Install Claude Code (winget install Anthropic.ClaudeCode, or npm i -g @anthropic-ai/claude-code), or set its path in Settings.',
      };
    }
    const route = this.deps.route?.() ?? 'api-key';
    if (route === 'claude-code') {
      const own = resolveUserClaudeCode(this.deps.exePath());
      if (!own) {
        return {
          ok: false,
          detail: 'Claude Code isn’t installed',
          howTo: findVsCodeBundledClaude()
            ? 'Only the VS Code extension’s private copy was found. Install Claude Code itself (Install Claude Code), or choose its claude.exe with Browse….'
            : 'Use “Install Claude Code”, or Browse… to your claude.exe.',
        };
      }
      return this.checkClaudeCode(own);
    }
    if (route === 'bedrock') return process.env.AWS_REGION || process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID ? { ok: true, detail: 'Amazon Bedrock' } : { ok: false, detail: 'Bedrock needs AWS credentials', howTo: 'Set AWS_REGION and AWS credentials (AWS_PROFILE or access keys) in your environment.' };
    if (route === 'vertex') return process.env.ANTHROPIC_VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT ? { ok: true, detail: 'Google Vertex AI' } : { ok: false, detail: 'Vertex needs a Google Cloud project', howTo: 'Set ANTHROPIC_VERTEX_PROJECT_ID and CLOUD_ML_REGION, and sign in with gcloud.' };
    if (this.deps.apiKey()) return { ok: true, detail: 'API key saved in Settings' };
    // AUTH-1: an inherited ANTHROPIC_API_KEY is deliberately ignored (the child env is scrubbed);
    // the key must be the one saved in Cadabra.
    return { ok: false, detail: 'Needs an Anthropic API key', howTo: 'Paste an Anthropic API key in Settings (console.anthropic.com → API keys).' };
  }

  /** Claude Code (subscription) mode status: installed, recent enough, signed in with a Claude plan. */
  private async checkClaudeCode(exe: string): Promise<AuthStatus> {
    const v = await claudeVersion(exe);
    if (v && !versionAtLeast(v, CLAUDE_CODE_MIN_VERSION)) {
      return { ok: false, detail: `Claude Code ${v} is too old`, howTo: `Update it (claude update) to ${CLAUDE_CODE_MIN_VERSION} or later.` };
    }
    const a = await claudeAuthStatus(exe);
    if (!a.loggedIn) return { ok: false, detail: 'Claude Code is not signed in', howTo: 'Choose “Sign in to Claude Code”: a terminal opens with Claude Code’s own login.' };
    if (!isSubscriptionLogin(a)) return { ok: false, detail: `Claude Code is signed in with ${a.authMethod}, not a Claude plan`, howTo: 'Use “Use an Anthropic API key” instead, or sign in to Claude Code with your Claude account.' };
    // Privacy: never show or log the account email / org; the plan is enough.
    const plan = a.subscription ? a.subscription.charAt(0).toUpperCase() + a.subscription.slice(1) : '';
    return { ok: true, detail: `Signed in to Claude Code${plan ? ` (${plan})` : ''}` };
  }

  /**
   * Two equal choices (user decision, round 3): your Claude subscription via
   * the official Claude Code CLI, or an Anthropic API key. Plus Bedrock/Vertex.
   * Cadabra never implements Anthropic's OAuth or reads Claude Code's files.
   */
  signInOptions(): SignInOption[] {
    return [
      {
        id: 'claude-code',
        label: 'Use my Claude subscription (via Claude Code)',
        note: 'No extra cost: uses your Pro/Max limits through the official Claude Code CLI on this PC. Anthropic’s terms may restrict use of subscriptions by third-party apps — use at your own risk.',
      },
      { id: 'api-key', label: 'Use an Anthropic API key', needsKey: true, keyPlaceholder: 'sk-ant-…', note: 'Billed per use, separately from any Claude subscription (console.anthropic.com). Clearly permitted for apps like Cadabra. Runs on Claude Code (installed once), but only your key is used, never your subscription.' },
      { id: 'bedrock', label: 'Use Amazon Bedrock', note: 'Uses your AWS credentials from the environment (AWS_REGION, AWS_PROFILE).' },
      { id: 'vertex', label: 'Use Google Vertex AI', note: 'Uses ANTHROPIC_VERTEX_PROJECT_ID / CLOUD_ML_REGION and your gcloud login.' },
    ];
  }

  /**
   * The app stores the key / route first. For Claude Code: if it isn't signed
   * in, open a terminal with `claude auth login` and poll `claude auth status`.
   */
  async signIn(optionId: string, io: SignInIO): Promise<AuthStatus> {
    this.reset();
    if (optionId !== 'claude-code') return this.checkAuth();
    const exe = resolveUserClaudeCode(this.deps.exePath());
    if (!exe) throw new Error('Claude Code isn’t installed yet. Use “Install Claude Code” first (or Browse… to claude.exe).');
    const first = await this.checkClaudeCode(exe);
    if (first.ok) return first;
    if (!/not signed in/i.test(first.detail)) return first;
    io.status?.('A terminal opened with Claude Code’s own sign-in. Finish it there…');
    this.deps.openLoginTerminal?.(exe);
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline && !io.signal?.aborted) {
      await new Promise((r) => setTimeout(r, 3000));
      const a = await claudeAuthStatus(exe);
      if (a.loggedIn) return this.checkClaudeCode(exe);
    }
    return { ok: false, detail: 'Claude Code is not signed in', howTo: 'Finish the sign-in in the terminal, then press Reconnect.' };
  }

  private canRun(): boolean {
    const route = this.deps.route?.() ?? 'api-key';
    if (route === 'claude-code') return false; // no prewarm of the CLI process before a real request
    return (route !== 'api-key' || !!this.deps.apiKey()) && !!resolveClaudeExecutable(this.deps.exePath());
  }

  /**
   * Spawn the runtime early so the first answer starts sooner. Round 5: also on
   * the wake word for Claude Code (the CLI sends nothing to the model until a
   * real message arrives).
   */
  async prewarm(model: string): Promise<void> {
    if ((this.deps.route?.() ?? 'api-key') === 'claude-code') {
      // Round 11: the wake word prewarms the voice (fast) model and the panel then
      // prewarmed the normal one, killing the first process; the turn then killed
      // the second and started cold ("process exited (code 1) after 0 turns", twice
      // per voice request). A warm, unused process is kept; only a real request
      // for another model replaces it.
      if (this.cli && !this.cli.dead && !this.cli.used) return;
      await this.ensureCli(model || CLAUDE_MODELS[0].id).catch(() => undefined);
      return;
    }
    if (this.live || this.opening || !this.canRun()) return;
    await this.ensureLive(model || CLAUDE_MODELS[0].id).catch(() => undefined);
  }

  /** P3: serialise prewarm/send so only one runtime process ever exists. */
  private async ensureLive(model: string, resumeId?: string): Promise<LiveSession> {
    while (this.opening) await this.opening.catch(() => undefined);
    if (this.live) return this.live;
    const p = this.open(model, resumeId && !this.spentSessions.has(resumeId) ? resumeId : undefined);
    this.opening = p;
    try {
      const l = await p;
      this.live = l;
      return l;
    } finally {
      if (this.opening === p) this.opening = null;
    }
  }

  /** Close the live session (new chat / provider switch / quit). */
  /** REVIEW-3 N4-R: a stopped Claude Code run's process (and its MCP session) is dropped. */
  onAbort(): void {
    if (this.cli) {
      const c = this.cli;
      this.cli = null;
      void c.dispose('the request was stopped');
    }
  }

  reset(): void {
    const c = this.cli;
    // Round 5: a session prewarmed on the wake word and not used yet has no
    // conversation in it: keep it (a fresh chat would just start it again).
    if (c && !c.used && !c.dead) {
      /* keep */
    } else {
      this.cli = null;
      void c?.dispose('new chat or settings change');
    }
    const l = this.live;
    this.live = null;
    if (!l) return;
    l.dead = true;
    try {
      l.inbox.close();
      l.q.close?.();
    } catch {
      /* ignore */
    }
  }

  private async open(model: string, resumeId?: string): Promise<LiveSession> {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const defs = this.deps.tools();
    const server = sdk.createSdkMcpServer({
      name: 'cadabra',
      version: this.deps.version,
      alwaysLoad: true,
      tools: defs.map((d) =>
        sdk.tool(d.name, d.description, d.shape, (args: any) => d.handler(args) as any, {
          annotations: { readOnlyHint: d.readOnly, destructiveHint: !d.readOnly },
        }),
      ),
    });
    const route = (this.deps.route?.() ?? 'api-key') as ClaudeRoute;
    const configDir = this.deps.configDir ?? path.join(this.deps.workDir, 'claude-config');
    fs.mkdirSync(configDir, { recursive: true });
    // Throws NoApiKeyError for an API-key route without a key: nothing is spawned.
    const env = claudeSdkEnv(process.env, { route, key: this.deps.apiKey(), configDir, version: this.deps.version });
    fs.mkdirSync(this.deps.workDir, { recursive: true });
    const inbox = new AsyncQueue<any>();
    const q = sdk.query({
      prompt: inbox,
      options: claudeSdkOptions({ model, server, resumeId, workDir: this.deps.workDir, env, exe: resolveClaudeExecutable(this.deps.exePath()), webGuard: this.deps.webAccess?.() ? this.deps.webGuard : undefined }) as any,
    });
    const live: LiveSession = { q, inbox, it: (q as AsyncIterable<any>)[Symbol.asyncIterator](), model, dead: false, route };
    // Refresh the model picker from the runtime in the background.
    Promise.resolve()
      .then(() => q.supportedModels())
      .then((ms: any[]) => {
        if (Array.isArray(ms) && ms.length) {
          this.liveModels = ms.map((m) => ({ id: m.value, label: m.displayName ?? m.value, description: m.description }));
        }
      })
      .catch(() => undefined);
    return live;
  }

  private async *sendViaClaudeCode(req: SendRequest, model: string): AsyncIterable<ProviderEvent> {
    const exe = resolveUserClaudeCode(this.deps.exePath());
    if (!exe || !this.deps.mcp) {
      yield { type: 'error', message: 'Claude Code isn’t installed. Settings → AI accounts → Claude → Install Claude Code.' };
      return;
    }
    try {
      await this.ensureCli(model);
    } catch (e) {
      yield { type: 'error', message: `Couldn't start Claude Code: ${(e as Error).message}` };
      return;
    }
    yield* this.cli!.send(req);
  }

  private cliStarting: Promise<void> | null = null;

  /** One Claude Code process for this model (shared by prewarm and send). */
  private async ensureCli(model: string): Promise<void> {
    while (this.cliStarting) await this.cliStarting.catch(() => undefined);
    const exe = resolveUserClaudeCode(this.deps.exePath());
    if (!exe || !this.deps.mcp) throw new Error('Claude Code isn’t installed');
    if (this.cli && (this.cli.dead || this.cli.model !== model)) {
      await this.cli.dispose(this.cli.dead ? 'it had ended' : 'another model was needed');
      this.cli = null;
    }
    if (this.cli) return;
    const p = (async () => {
      const v = await claudeVersion(exe);
      const c = new ClaudeCliSession(
        { exe, workDir: this.deps.workDir, mcp: this.deps.mcp!, systemPrompt: SYSTEM_PROMPT, revokeSession: this.deps.revokeSession, issueSession: this.deps.issueSession, permissionPrompts: !v || versionAtLeast(v, CLAUDE_CODE_PERMISSION_PROMPTS_VERSION), web: !!this.deps.webAccess?.() },
        model,
      );
      await c.start();
      this.cli = c;
    })();
    this.cliStarting = p;
    try {
      await p;
    } finally {
      if (this.cliStarting === p) this.cliStarting = null;
    }
  }

  async *send(req: SendRequest): AsyncIterable<ProviderEvent> {
    const model = req.model || CLAUDE_MODELS[0].id;
    if ((this.deps.route?.() ?? 'api-key') === 'claude-code') {
      yield* this.sendViaClaudeCode(req, model);
      return;
    }
    // AUTH-1 layer 1: no key, no runtime.
    if ((this.deps.route?.() ?? 'api-key') === 'api-key' && !this.deps.apiKey()?.trim()) {
      yield { type: 'error', message: new NoApiKeyError().message };
      return;
    }
    try {
      if (this.live && (this.live.dead || (req.resumeId && this.live.sessionId && req.resumeId !== this.live.sessionId))) this.reset();
      const l = this.live ?? (await this.ensureLive(model, req.resumeId));
      if (l.model !== model) {
        await l.q.setModel(model);
        l.model = model;
      }
    } catch (e) {
      this.reset();
      yield { type: 'error', message: `Couldn't start Claude: ${(e as Error).message}` };
      return;
    }
    const live = this.live!;
    if (!live.preflighted) {
      live.preflighted = true;
      const info = await Promise.race([
        Promise.resolve()
          .then(() => live.q.accountInfo?.())
          .catch(() => undefined),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 15000)),
      ]);
      if (!accountAllowed(live.route ?? 'api-key', info)) {
        console.warn(`[claude] refused before sending: credential source "${info?.apiKeySource ?? info?.tokenSource ?? '?'}" is not allowed for route ${live.route}`);
        this.reset();
        yield { type: 'error', message: 'Stopped: Claude wasn’t going to use your API key, so Cadabra didn’t send anything. Check Settings → AI accounts → Claude.' };
        return;
      }
    }
    const content: any[] = [];
    if (req.image) content.push({ type: 'image', source: { type: 'base64', media_type: req.image.mimeType, data: req.image.data } });
    content.push({ type: 'text', text: buildUserText(req) });
    live.inbox.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: live.sessionId ?? '' });

    const onAbort = () => {
      live.q.interrupt?.().catch(() => undefined);
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    if (req.signal.aborted) onAbort(); // aborted while we were starting up
    const st = newClaudeMapState();
    try {
      while (true) {
        const r = await live.it.next();
        // AUTH-1 layer 4: the runtime says which credential it is using; anything
        // but our own API key (or the chosen cloud route) ends the session now.
        if (!r.done && r.value?.type === 'system' && r.value.subtype === 'init' && !authSourceAllowed(live.route ?? 'api-key', r.value)) {
          live.q.interrupt?.().catch(() => undefined);
          live.dead = true;
          console.warn(`[claude] refused session: credential source "${r.value.apiKeySource}" is not allowed for route ${live.route}`);
          yield { type: 'error', message: 'Stopped: Claude wasn’t using your API key, so Cadabra ended the request. Check Settings → AI accounts → Claude.' };
          break;
        }
        if (!r.done && r.value?.type === 'result') {
          // P4: the runtime ends the query after these; reopen next time
          // (with resume after max turns, fresh after the budget cap).
          if (r.value.subtype === 'error_max_turns') live.dead = true;
          if (r.value.subtype === 'error_max_budget_usd') {
            live.dead = true;
            live.spent = true;
            if (live.sessionId) this.spentSessions.add(live.sessionId);
          }
        }
        if (r.done) {
          live.dead = true;
          if (!st.finished) yield req.signal.aborted ? { type: 'done', sessionId: live.sessionId } : { type: 'error', message: 'Claude stopped unexpectedly.' };
          break;
        }
        for (const ev of mapClaudeMessage(r.value, st)) {
          if (ev.type === 'session') live.sessionId = ev.sessionId;
          // An interrupted turn ends with an error result; present it as a calm stop.
          if (ev.type === 'error' && req.signal.aborted) {
            yield { type: 'done', sessionId: live.sessionId };
            continue;
          }
          yield ev;
        }
        if (st.finished) break;
      }
    } catch (e) {
      live.dead = true;
      if (req.signal.aborted) yield { type: 'done', sessionId: live.sessionId };
      else yield { type: 'error', message: (e as Error).message || String(e) };
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      if (live.dead && this.live === live) this.reset();
    }
  }
}
