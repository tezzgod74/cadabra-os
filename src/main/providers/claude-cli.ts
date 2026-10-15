// "Use my Claude subscription (via Claude Code)": drives the user's own,
// unmodified `claude` binary in print mode with streaming JSON in and out
// (docs/research.md §1.2; https://code.claude.com/docs/en/cli-reference).
//
// - Cadabra never implements Anthropic OAuth, never reads ~/.claude
//   credentials, never spoofs headers and never bundles Claude Code. Sign-in
//   happens in a visible terminal running `claude auth login`.
// - Same lockdown as the API-key path: no built-in tools (`--tools ""`), only
//   Cadabra's MCP server (`--strict-mcp-config`), no settings sources,
//   `dontAsk` with `--permission-prompts none`, only `mcp__cadabra__*` allowed.

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { AsyncQueue } from '../../shared/async-queue';
import type { ProviderEvent } from '../../shared/types';
import { execCli, killTree, spawnCli } from '../exe-finder';
import { CLAUDE_MAX_TURNS, CLAUDE_SESSION_BUDGET_USD, mapClaudeMessage, newClaudeMapState } from './claude-events';
import { buildUserText, type SendRequest } from './types';

export interface ClaudeCodeAuth {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscription?: string;
  raw?: unknown;
}

/** Parse `claude auth status` (JSON by default; exit 0 = logged in, 1 = not). */
export function parseClaudeAuthStatus(stdout: string, exitCode: number | null): ClaudeCodeAuth {
  let j: any;
  try {
    j = JSON.parse(stdout.trim() || 'null');
  } catch {
    j = null;
  }
  const loggedIn = !!(j?.loggedIn ?? exitCode === 0);
  return {
    loggedIn: loggedIn && exitCode !== 1,
    authMethod: j?.authMethod,
    email: j?.email ?? j?.account?.email ?? j?.emailAddress,
    subscription: j?.subscriptionType ?? j?.subscription,
    raw: j,
  };
}

/** Only a Claude subscription login counts for this mode (not an API key / 3rd-party provider). */
export function isSubscriptionLogin(a: ClaudeCodeAuth): boolean {
  return a.loggedIn && (a.authMethod === 'claude.ai' || a.authMethod === 'oauth_token' || a.authMethod == null);
}

/**
 * Environment for the user's own Claude Code (subscription mode). Status checks
 * and sessions use the SAME environment (REVIEW-3), and no API key or other
 * credential of Cadabra's ever reaches it.
 */
export function claudeCodeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CLAUDE_AGENT_SDK_CLIENT_APP: 'cadabra-os' };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR']) delete env[k];
  return env;
}

export async function claudeAuthStatus(exe: string, timeoutMs = 15_000): Promise<ClaudeCodeAuth> {
  const r = await execCli(exe, ['auth', 'status'], { env: claudeCodeEnv(), timeoutMs });
  return parseClaudeAuthStatus(r.stdout, r.code ?? 1);
}

/** The exact argument list (unit-tested: the lockdown flags must never regress). */
/** Claude Code's read-only web tools (names from its own tool schema: WebSearchInput / WebFetchInput). */
export const CLAUDE_WEB_TOOLS = ['WebSearch', 'WebFetch'];

/**
 * Round 7: settings passed with --settings: a PreToolUse HTTP hook that asks
 * Cadabra about every web search / fetch. The web tools are deliberately NOT in
 * --allowedTools, so under dontAsk they're denied unless this hook says "allow"
 * (if the hook can't be reached, the call is denied: fail-closed).
 */
export function claudeWebHookSettings(o: { url: string; token: string; sessionKey: string }) {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: CLAUDE_WEB_TOOLS.join('|'),
          hooks: [{ type: 'http', url: o.url, headers: { Authorization: `Bearer ${o.token}`, 'x-cadabra-session': o.sessionKey }, timeout: 120 }],
        },
      ],
    },
  };
}

export function claudeCliArgs(o: { model?: string; mcpConfigFile: string; systemPromptFile: string; permissionPrompts?: boolean; webSettingsFile?: string }): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Round 7: no built-in tools at all, except (with web access on) the
    // read-only web tools, which Cadabra's hook must approve one by one.
    '--tools',
    o.webSettingsFile ? CLAUDE_WEB_TOOLS.join(',') : '',
    ...(o.webSettingsFile ? ['--settings', o.webSettingsFile] : []),
    '--strict-mcp-config',
    '--mcp-config',
    o.mcpConfigFile,
    '--setting-sources',
    '',
    '--allowedTools',
    'mcp__cadabra__*',
    '--permission-mode',
    'dontAsk',
    // 2.1.259+: deny any prompt outright; older builds rely on dontAsk (which also denies).
    ...(o.permissionPrompts === false ? [] : ['--permission-prompts', 'none']),
    '--append-system-prompt-file',
    o.systemPromptFile,
    '--max-turns',
    String(CLAUDE_MAX_TURNS),
    '--max-budget-usd',
    String(CLAUDE_SESSION_BUDGET_USD),
    '--no-session-persistence',
    ...(o.model ? ['--model', o.model] : []),
  ];
}

export interface ClaudeCliDeps {
  exe: string;
  workDir: string;
  mcp: () => Promise<{ url: string; token: string }>;
  systemPrompt: string;
  /** REVIEW-2 N4: refuse MCP calls from this process after it is dropped. */
  revokeSession?: (key: string) => void;
  /** REVIEW-3 N4-R: allowlist this process's session key. */
  issueSession?: (key: string) => void;
  /** CLI supports `--permission-prompts` (2.1.259+). */
  permissionPrompts?: boolean;
  /** Round 7: web access on (read-only web tools behind Cadabra's hook). */
  web?: boolean;
}

/** One long-lived `claude -p` process per chat (streaming input keeps it warm). */
export class ClaudeCliSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private lines = new AsyncQueue<any>();
  private files: string[] = [];
  private sessionKey = randomBytes(12).toString('base64url');
  dead = false;
  sessionId?: string;
  readonly model: string;

  constructor(
    private readonly deps: ClaudeCliDeps,
    model: string,
  ) {
    this.model = model;
  }

  async start(): Promise<void> {
    this.deps.issueSession?.(this.sessionKey);
    const mcp = await this.deps.mcp();
    fs.mkdirSync(this.deps.workDir, { recursive: true });
    const id = randomBytes(6).toString('hex');
    const mcpFile = path.join(this.deps.workDir, `claude-mcp-${id}.json`);
    const promptFile = path.join(this.deps.workDir, `claude-prompt-${id}.txt`);
    // The bearer token lives only in this per-process file (0600), deleted on dispose.
    fs.writeFileSync(
      mcpFile,
      JSON.stringify({ mcpServers: { cadabra: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}`, 'x-cadabra-session': this.sessionKey } } } }),
      { mode: 0o600 },
    );
    fs.writeFileSync(promptFile, this.deps.systemPrompt);
    this.files.push(mcpFile, promptFile);
    let webSettingsFile: string | undefined;
    if (this.deps.web) {
      webSettingsFile = path.join(this.deps.workDir, `claude-settings-${id}.json`);
      // Holds the same localhost bearer token as the MCP file (0600, deleted on dispose).
      fs.writeFileSync(webSettingsFile, JSON.stringify(claudeWebHookSettings({ url: mcp.url.replace(/\/mcp$/, '/hook/web'), token: mcp.token, sessionKey: this.sessionKey })), { mode: 0o600 });
      this.files.push(webSettingsFile);
    }
    // No API key or other Cadabra credential: the CLI uses the user's own Claude Code login.
    const env = claudeCodeEnv();
    const proc = spawnCli(this.deps.exe, claudeCliArgs({ model: this.model, mcpConfigFile: mcpFile, systemPromptFile: promptFile, permissionPrompts: this.deps.permissionPrompts, webSettingsFile }), { cwd: this.deps.workDir, env });
    this.proc = proc;
    proc.stdin.on('error', () => undefined);
    // Round 4.5: the CLI's own errors go to Cadabra's (redacted) log, rate-limited.
    let errLines = 0;
    proc.stderr.on('data', (d) => {
      if (errLines++ < 40) console.warn(`[claude-code] stderr: ${String(d).trim().slice(0, 300)}`);
    });
    createInterface({ input: proc.stdout }).on('line', (l) => {
      try {
        if (!this.lines.isClosed) this.lines.push(JSON.parse(l));
      } catch {
        /* not JSON */
      }
    });
    proc.on('exit', (code, signal) => {
      // Round 11: Cadabra stopping the process (taskkill → code 1) isn't a crash.
      if (this.stopReason) console.log(`[claude-code] process stopped by Cadabra (${this.stopReason}) after ${this.turnsDone} turns${this.used ? '' : ', unused'}`);
      else console.log(`[claude-code] process exited (code ${code}${signal ? `, ${signal}` : ''}) after ${this.turnsDone} turns`);
      this.dead = true;
      if (!this.lines.isClosed) this.lines.close();
    });
    await new Promise<void>((resolve, reject) => {
      proc.once('spawn', () => resolve());
      proc.once('error', reject);
    });
  }

  private write(obj: unknown) {
    try {
      this.proc?.stdin.write(JSON.stringify(obj) + '\n');
    } catch {
      /* gone */
    }
  }

  interrupt() {
    // Streaming-input control protocol (same as the Agent SDK uses). It's not
    // documented for the CLI, so a fallback drops the process if the turn
    // doesn't end within 1.5 s, and says so in the log (REVIEW-3 MISC).
    this.write({ type: 'control_request', request_id: `int-${Date.now()}`, request: { subtype: 'interrupt' } });
    const turnBefore = this.turnsDone;
    setTimeout(() => {
      if (!this.dead && this.turnsDone === turnBefore) {
        console.warn('[claude-code] interrupt not acknowledged within 1.5 s; dropping the claude -p process (fallback)');
        this.fallbacks++;
        void this.dispose('interrupt not acknowledged');
      }
    }, 1500);
  }

  /** How often the interrupt fallback fired (diagnostics). */
  fallbacks = 0;
  private turnsDone = 0;

  /** A message was sent in this session (round 5: an unused prewarmed session survives reset()). */
  used = false;

  async *send(req: SendRequest): AsyncIterable<ProviderEvent> {
    this.used = true;
    const content: any[] = [];
    if (req.image) content.push({ type: 'image', source: { type: 'base64', media_type: req.image.mimeType, data: req.image.data } });
    content.push({ type: 'text', text: buildUserText(req) });
    this.write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: this.sessionId ?? '' });
    const onAbort = () => this.interrupt();
    req.signal.addEventListener('abort', onAbort, { once: true });
    if (req.signal.aborted) onAbort();
    const st = newClaudeMapState();
    const it = this.lines[Symbol.asyncIterator]();
    try {
      while (true) {
        const r = await it.next();
        if (r.done) {
          if (!st.finished) yield req.signal.aborted ? { type: 'done', sessionId: this.sessionId } : { type: 'error', message: 'Claude Code stopped unexpectedly. Is it still signed in? (Settings → AI accounts)' };
          break;
        }
        if (r.value?.type === 'result' && (r.value.subtype === 'error_max_turns' || r.value.subtype === 'error_max_budget_usd')) this.dead = true;
        for (const ev of mapClaudeMessage(r.value, st)) {
          if (ev.type === 'session') this.sessionId = ev.sessionId;
          if (ev.type === 'error' && req.signal.aborted) {
            yield { type: 'done', sessionId: this.sessionId };
            continue;
          }
          yield ev;
        }
        if (st.finished) {
          this.turnsDone++;
          break;
        }
      }
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }
  }

  /** Why Cadabra stopped this process (set before killing it; logs only). */
  private stopReason = '';

  async dispose(reason = 'reset'): Promise<void> {
    this.stopReason ||= reason;
    this.dead = true;
    this.deps.revokeSession?.(this.sessionKey);
    if (!this.lines.isClosed) this.lines.close();
    await killTree(this.proc);
    this.proc = null;
    for (const f of this.files) fs.rm(f, { force: true }, () => undefined);
  }
}
