import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuthStatus, ModelOption, ProviderEvent } from '../../shared/types';
import { execCli, firstExisting, npmGlobalRoots, whichSync } from '../exe-finder';
import type { ToolDef } from '../tools';
import { SYSTEM_PROMPT } from '../tools';
import { NoApiKeyError, type ClaudeRoute } from './claude-auth';
import { ClaudeAuthRefused, ClaudeCliSession, claudeAuthStatus, claudeCodeEnv, isSubscriptionLogin } from './claude-cli';
import { type ProviderAdapter, type SendRequest, type SignInIO, type SignInOption } from './types';

export { accountAllowed, authSourceAllowed, AUTH_ENV_VARS, claudeApiEnv, NoApiKeyError, type ClaudeRoute } from './claude-auth';

// Model ids from the Claude API reference / docs/research.md (2026-10). Used
// until Claude Code reports its own list.
export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: 'Fast and smart — great default for Cadabra', default: true },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', description: 'Most capable Opus — best for long multi-step tasks' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', description: 'Fastest — quick “what’s on screen” answers' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', description: 'Hardest reasoning (slower, pricier)' },
];

export interface ClaudeDeps {
  tools: () => ToolDef[];
  apiKey: () => string | undefined;
  /** User override for the Claude Code app (settings, "Browse…"). */
  exePath: () => string | undefined;
  /** Working dir for the Claude Code process (built-in tools are disabled; nothing is read from it). */
  workDir: string;
  version: string;
  /** 'api-key', 'claude-code' (user's subscription), 'bedrock' or 'vertex' (see signInOptions()). */
  route?: () => string | undefined;
  /** Cadabra-owned, empty config dir for the API-key / cloud routes (AUTH-1 layer 3). */
  configDir?: string;
  /** Cadabra's HTTP MCP server (Claude Code gets its tools over HTTP). */
  mcp?: () => Promise<{ url: string; token: string }>;
  revokeSession?: (key: string) => void;
  issueSession?: (key: string) => void;
  /** Opens a visible terminal running `claude auth login` (Claude Code's own login). */
  openLoginTerminal?: (exe: string) => void;
  /** Round 7: web access setting. */
  webAccess?: () => boolean;
  /** 0.9.3: web search on the API-key / Bedrock / Vertex routes (default on). */
  apiWeb?: () => boolean;
  /** Round 7: Cadabra's decision on one web search / fetch (wired to the HTTP hook by the app). */
  webGuard?: (tool: 'search' | 'fetch', text: string) => Promise<{ allow: boolean; reason?: string }>;
}

/** Minimum Claude Code for the lockdown flags. */
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
 * Every Claude mode uses the user's OWN Claude Code install (never a bundled
 * runtime or the VS Code extension's private copy). The official installer
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

/** A VS Code extension-bundled binary, if any (only mentioned, never used). */
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

/** Plain-language status when the Claude Code app is missing (no jargon: shown to everyone). */
export const CLAUDE_CODE_MISSING: AuthStatus = {
  ok: false,
  detail: 'The Claude Code app isn’t installed',
  howTo: 'Cadabra talks to Claude through Anthropic’s Claude Code app (free to install; using Claude needs a Claude plan or an API key). Choose “Install Claude Code” and Cadabra installs it for you.',
};

/**
 * Claude, always through the user's own Claude Code app (`claude -p`, one
 * long-lived process per chat; claude-cli.ts). Subscription mode uses the
 * user's own Claude Code login; API-key / Bedrock / Vertex run the same app in
 * `--bare` mode with only that credential (claude-auth.ts).
 */
export class ClaudeProvider implements ProviderAdapter {
  readonly id = 'claude' as const;
  readonly label = 'Claude';
  private cli: ClaudeCliSession | null = null;
  /** Which credential the running process was started with (route + key fingerprint). */
  private cliIdentity = '';
  private cliStarting: Promise<void> | null = null;
  private liveModels: ModelOption[] | null = null;

  constructor(private readonly deps: ClaudeDeps) {}

  private route(): ClaudeRoute {
    const r = this.deps.route?.();
    return r === 'claude-code' || r === 'bedrock' || r === 'vertex' ? r : 'api-key';
  }

  /**
   * Web search for this Claude connection. The subscription route always can.
   * API key / Bedrock / Vertex can when "Web search with your Claude API key"
   * is on: Claude Code then runs WITHOUT --bare (which would skip Cadabra's
   * web-guard hook), with every other lock kept (claude-cli.ts).
   */
  webAvailable(): boolean {
    return this.route() === 'claude-code' || this.deps.apiWeb?.() !== false;
  }

  /** Web tools offered to this process: web access on and available for the route. */
  private webOn(): boolean {
    return !!this.deps.webAccess?.() && this.webAvailable();
  }

  /** Changes when the route or the saved key changes, so a stale process is never reused. */
  private identity(): string {
    const route = this.route();
    const key = route === 'api-key' ? (this.deps.apiKey()?.trim() ?? '') : '';
    return `${route}:${key ? createHash('sha256').update(key).digest('hex').slice(0, 16) : '-'}:${this.webOn() ? 'web' : 'noweb'}`;
  }

  async listModels(): Promise<ModelOption[]> {
    return this.liveModels ?? CLAUDE_MODELS;
  }

  async checkAuth(): Promise<AuthStatus> {
    const own = resolveUserClaudeCode(this.deps.exePath());
    if (!own) {
      return findVsCodeBundledClaude()
        ? { ...CLAUDE_CODE_MISSING, howTo: 'Only a private copy inside VS Code was found. Choose “Install Claude Code”, or “Browse…” to the Claude Code app (claude.exe).' }
        : CLAUDE_CODE_MISSING;
    }
    const route = this.route();
    if (route === 'claude-code') return this.checkClaudeCode(own);
    const v = await claudeVersion(own);
    if (v && !versionAtLeast(v, CLAUDE_CODE_MIN_VERSION)) return { ok: false, detail: `Claude Code ${v} is too old`, howTo: 'Choose “Install Claude Code” to update it.' };
    if (route === 'bedrock') return process.env.AWS_REGION || process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID ? { ok: true, detail: 'Amazon Bedrock (via Claude Code)' } : { ok: false, detail: 'Bedrock needs AWS credentials', howTo: 'Set AWS_REGION and AWS credentials (AWS_PROFILE or access keys) in your environment.' };
    if (route === 'vertex') return process.env.ANTHROPIC_VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT ? { ok: true, detail: 'Google Vertex AI (via Claude Code)' } : { ok: false, detail: 'Vertex needs a Google Cloud project', howTo: 'Set ANTHROPIC_VERTEX_PROJECT_ID and CLOUD_ML_REGION, and sign in with gcloud.' };
    if (this.deps.apiKey()?.trim()) return { ok: true, detail: 'API key saved (runs in Claude Code)' };
    // AUTH-1: an inherited ANTHROPIC_API_KEY is deliberately ignored (the child env is scrubbed);
    // the key must be the one saved in Cadabra.
    return { ok: false, detail: 'Needs an Anthropic API key', howTo: 'Paste your Anthropic API key (console.anthropic.com → API keys).' };
  }

  /** Subscription mode status: installed, recent enough, signed in with a Claude plan. */
  private async checkClaudeCode(exe: string): Promise<AuthStatus> {
    const v = await claudeVersion(exe);
    if (v && !versionAtLeast(v, CLAUDE_CODE_MIN_VERSION)) {
      return { ok: false, detail: `Claude Code ${v} is too old`, howTo: 'Choose “Install Claude Code” to update it.' };
    }
    const a = await claudeAuthStatus(exe);
    if (!a.loggedIn) return { ok: false, detail: 'Claude Code is not signed in', howTo: 'Choose “Sign in”: Claude Code opens its own sign-in page.' };
    if (!isSubscriptionLogin(a)) return { ok: false, detail: `Claude Code is signed in with ${a.authMethod}, not a Claude plan`, howTo: 'Use “Use an Anthropic API key” instead, or sign in to Claude Code with your Claude account.' };
    // Privacy: never show or log the account email / org; the plan is enough.
    const plan = a.subscription ? a.subscription.charAt(0).toUpperCase() + a.subscription.slice(1) : '';
    return { ok: true, detail: `Signed in to Claude Code${plan ? ` (${plan})` : ''}` };
  }

  /**
   * Two equal choices (user decision, round 3): your Claude subscription or an
   * Anthropic API key, both through the Claude Code app. Plus Bedrock/Vertex.
   */
  signInOptions(): SignInOption[] {
    return [
      {
        id: 'claude-code',
        label: 'Use my Claude subscription (via Claude Code)',
        note: 'No extra cost: uses your Pro/Max limits through Anthropic’s Claude Code app on this PC. Anthropic’s terms may restrict use of subscriptions by third-party apps — use at your own risk.',
      },
      { id: 'api-key', label: 'Use an Anthropic API key', needsKey: true, keyPlaceholder: 'sk-ant-…', note: 'Billed per use by Anthropic, separately from any Claude subscription (console.anthropic.com). Clearly permitted for apps like Cadabra. Runs in the Claude Code app, but only your key is used, never your subscription.' },
      { id: 'bedrock', label: 'Use Amazon Bedrock', note: 'Runs in the Claude Code app with your AWS credentials from the environment (AWS_REGION, AWS_PROFILE).' },
      { id: 'vertex', label: 'Use Google Vertex AI', note: 'Runs in the Claude Code app with ANTHROPIC_VERTEX_PROJECT_ID / CLOUD_ML_REGION and your gcloud login.' },
    ];
  }

  /**
   * The app stores the key / route first. For the subscription: if Claude Code
   * isn't signed in, open its own login and poll `claude auth status`.
   */
  async signIn(optionId: string, io: SignInIO): Promise<AuthStatus> {
    await this.dropCli('new sign-in');
    if (optionId !== 'claude-code') return this.checkAuth();
    const exe = resolveUserClaudeCode(this.deps.exePath());
    if (!exe) throw new Error('The Claude Code app isn’t installed yet. Choose “Install Claude Code” first.');
    const first = await this.checkClaudeCode(exe);
    if (first.ok) return first;
    if (!/not signed in/i.test(first.detail)) return first;
    io.status?.('A window opened with Claude Code’s own sign-in. Finish it there…');
    this.deps.openLoginTerminal?.(exe);
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline && !io.signal?.aborted) {
      await new Promise((r) => setTimeout(r, 3000));
      const a = await claudeAuthStatus(exe);
      if (a.loggedIn) return this.checkClaudeCode(exe);
    }
    return { ok: false, detail: 'Claude Code is not signed in', howTo: 'Finish the sign-in, then press Reconnect.' };
  }

  /** Can a process be started right now without user action (prewarm)? */
  private canRun(): boolean {
    const route = this.route();
    if (route === 'api-key' && !this.deps.apiKey()?.trim()) return false;
    return !!resolveUserClaudeCode(this.deps.exePath()) && !!this.deps.mcp;
  }

  /**
   * Start Claude Code early so the first answer starts sooner (the app sends
   * nothing to the model until a real message arrives). Round 11: a warm,
   * unused process is kept; only a real request for another model replaces it.
   */
  async prewarm(model: string): Promise<void> {
    if (this.cli && !this.cli.dead && !this.cli.used && this.cliIdentity === this.identity()) return;
    if (!this.canRun()) return;
    await this.ensureCli(model || CLAUDE_MODELS[0].id).catch(() => undefined);
  }

  /** REVIEW-3 N4-R: a stopped run's process (and its MCP session) is dropped. */
  onAbort(): void {
    void this.dropCli('the request was stopped');
  }

  reset(): void {
    const c = this.cli;
    // Round 5: a session prewarmed and not used yet has no conversation in it:
    // keep it, unless the credential changed.
    if (c && !c.used && !c.dead && this.cliIdentity === this.identity()) return;
    void this.dropCli('new chat or settings change');
  }

  /** Stop the Claude Code process for good (quit, "Clear chat history"); its session files are removed. */
  async dispose(): Promise<void> {
    while (this.cliStarting) await this.cliStarting.catch(() => undefined);
    await this.dropCli('shut down');
  }

  private async dropCli(reason: string): Promise<void> {
    const c = this.cli;
    this.cli = null;
    this.cliIdentity = '';
    await c?.dispose(reason);
  }

  /** One Claude Code process for this model and credential (shared by prewarm and send). */
  private async ensureCli(model: string): Promise<void> {
    while (this.cliStarting) await this.cliStarting.catch(() => undefined);
    const exe = resolveUserClaudeCode(this.deps.exePath());
    if (!exe || !this.deps.mcp) throw new Error('the Claude Code app isn’t installed');
    const identity = this.identity();
    if (this.cli && (this.cli.dead || this.cli.model !== model || this.cliIdentity !== identity)) {
      await this.dropCli(this.cli.dead ? 'it had ended' : this.cliIdentity !== identity ? 'the account changed' : 'another model was needed');
    }
    if (this.cli) return;
    const route = this.route();
    const p = (async () => {
      const v = await claudeVersion(exe);
      const c = new ClaudeCliSession(
        {
          exe,
          workDir: this.deps.workDir,
          mcp: this.deps.mcp!,
          systemPrompt: SYSTEM_PROMPT,
          revokeSession: this.deps.revokeSession,
          issueSession: this.deps.issueSession,
          permissionPrompts: !v || versionAtLeast(v, CLAUDE_CODE_PERMISSION_PROMPTS_VERSION),
          // `--bare` disables hooks and Claude Code's web tools (verified locally,
          // 0.9.2), so web search on the API routes means running without
          // --bare; the session keeps every other lock (0.9.3, claude-cli.ts).
          web: this.webOn(),
          route,
          // AUTH-1 layer 2: the key goes only into this child's environment.
          apiKey: route === 'api-key' ? this.deps.apiKey() : undefined,
          configDir: this.deps.configDir ?? path.join(this.deps.workDir, 'claude-config'),
          version: this.deps.version,
        },
        model,
      );
      await c.start();
      if (route !== 'claude-code' && c.models?.length) {
        this.liveModels = c.models.map((m) => ({ id: m.value, label: m.displayName ?? m.value, description: m.description }));
      }
      this.cli = c;
      this.cliIdentity = identity;
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
    // AUTH-1 layer 1: no key, no process.
    if (this.route() === 'api-key' && !this.deps.apiKey()?.trim()) {
      yield { type: 'error', message: new NoApiKeyError().message };
      return;
    }
    if (!resolveUserClaudeCode(this.deps.exePath()) || !this.deps.mcp) {
      yield { type: 'error', message: 'The Claude Code app isn’t installed. Settings → AI accounts → Claude → Install Claude Code.' };
      return;
    }
    try {
      await this.ensureCli(model);
    } catch (e) {
      if (e instanceof ClaudeAuthRefused || e instanceof NoApiKeyError) yield { type: 'error', message: e.message };
      else yield { type: 'error', message: `Couldn't start Claude Code: ${(e as Error).message}` };
      return;
    }
    const c = this.cli!;
    try {
      yield* c.send(req);
    } finally {
      if (c.dead && this.cli === c) await this.dropCli('it had ended');
    }
  }
}
