import { randomBytes } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { AsyncQueue } from '../../shared/async-queue';
import type { AuthStatus, ModelOption, ProviderEvent } from '../../shared/types';
import { firstExisting, killTree, npmGlobalRoots, spawnCli, whichSync } from '../exe-finder';
import { SYSTEM_PROMPT } from '../tools';
import { buildUserText, shortToolName, type ProviderAdapter, type SendRequest, type SignInIO, type SignInOption } from './types';

// Google Gemini via the user's own, unmodified Gemini CLI in ACP mode
// (`gemini --acp`, Agent Client Protocol: JSON-RPC 2.0 over stdio).
// Login always runs in the CLI's own Google flow; Cadabra never reads
// ~/.gemini credentials (docs/research.md §8.3–8.4).

export interface AcpMapState {
  sawText: boolean;
  needsBreak: boolean;
  tools: Map<string, string>;
}

export function newAcpMapState(): AcpMapState {
  return { sawText: false, needsBreak: false, tools: new Map() };
}

/** Pure mapping of ACP `session/update` notifications → ProviderEvents. */
export function mapAcpUpdate(params: any, st: AcpMapState): ProviderEvent[] {
  const u = params?.update ?? {};
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      const t = u.content?.type === 'text' ? String(u.content.text ?? '') : '';
      if (!t) return [];
      const out: ProviderEvent[] = [];
      if (st.needsBreak && st.sawText) out.push({ type: 'text', delta: '\n\n' });
      st.needsBreak = false;
      st.sawText = true;
      out.push({ type: 'text', delta: t });
      return out;
    }
    case 'tool_call': {
      const id = String(u.toolCallId ?? '');
      const name = shortToolName(String(u.title ?? u.toolName ?? u.kind ?? 'tool').replace(/\s*\(.*$/, ''));
      st.tools.set(id, name);
      st.needsBreak = true;
      return [{ type: 'tool', id, name, phase: 'start' }];
    }
    case 'tool_call_update': {
      const id = String(u.toolCallId ?? '');
      if (u.status === 'completed' || u.status === 'failed') {
        const text = Array.isArray(u.content) ? u.content.map((c: any) => c?.content?.text ?? c?.text ?? '').join(' ').trim() : '';
        return [{ type: 'tool', id, name: st.tools.get(id) ?? '', phase: 'end', ok: u.status === 'completed', summary: text.slice(0, 300) || undefined }];
      }
      return [];
    }
    default:
      return [];
  }
}

/**
 * ACP permission request → our answer. Only Cadabra's own MCP tools are
 * allowed; Gemini's built-in shell / file / web tools are rejected.
 */
export function acpPermissionDecision(params: any): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } {
  const tc = params?.toolCall ?? {};
  // Gemini titles MCP calls "<tool> (<server> MCP Server)"; only our server counts.
  const fromCadabra = isCadabraToolCall(tc);
  const builtinRisky = ['execute', 'edit', 'delete', 'move', 'fetch'].includes(String(tc.kind ?? '').toLowerCase());
  const opts: any[] = Array.isArray(params?.options) ? params.options : [];
  if (fromCadabra && !builtinRisky) {
    const allowOnce = opts.find((o) => o.kind === 'allow_once') ?? opts.find((o) => String(o.kind).startsWith('allow'));
    if (allowOnce) return { outcome: { outcome: 'selected', optionId: allowOnce.optionId } };
  }
  const reject = opts.find((o) => o.kind === 'reject_once') ?? opts.find((o) => String(o.kind).startsWith('reject'));
  return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
}

/** Gemini built-in tools Cadabra excludes in its private workspace settings. */
export const GEMINI_EXCLUDED_TOOLS = [
  'run_shell_command',
  'write_file',
  'replace',
  'read_file',
  'read_many_files',
  'glob',
  'search_file_content',
  'list_directory',
  'web_fetch',
  'google_web_search',
  'save_memory',
  'write_todos',
  'grep',
  'ls',
  'shell',
  'edit',
  'activate_skill',
  'codebase_investigator',
  'delegate_to_agent',
];

export function resolveGeminiExecutable(override?: string): string | undefined {
  if (override && fs.existsSync(override)) return override;
  return firstExisting([
    whichSync('gemini.exe'),
    whichSync('gemini.cmd'),
    ...npmGlobalRoots().map((r) => path.join(r, '..', 'gemini.cmd')),
  ]);
}

export interface GeminiDeps {
  exePath: () => string | undefined;
  mcp: () => Promise<{ url: string; token: string }>;
  workDir: string;
  /** Gemini API key from Settings (optional; stored with safeStorage). */
  apiKey: () => string | undefined;
  version: string;
  /**
   * REVIEW-2 #8: Cadabra-owned GEMINI_CLI_HOME, so the user's ~/.gemini
   * settings, extensions, MCP servers and memory never load. (The user signs
   * in once more here, through the CLI's own Google flow.)
   */
  homeDir?: string;
  /** REVIEW-2 N4: refuse further MCP calls from a dropped session. */
  revokeSession?: (key: string) => void;
  /** REVIEW-3 N4-R: allowlist a new session key. */
  issueSession?: (key: string) => void;
  /** Round 7: web access setting and Cadabra's guard for each web call. */
  webAccess?: () => boolean;
  webGuard?: (tool: 'search' | 'fetch', text: string) => Promise<{ allow: boolean; reason?: string }>;
}

/**
 * Highest-precedence settings for Cadabra's Gemini (GEMINI_CLI_SYSTEM_SETTINGS_PATH):
 * built-in tools excluded, only the `cadabra` MCP server allowed, extensions,
 * skills and "always allow" disabled.
 */
/** Round 7: Gemini CLI's read-only web tools (their names in Gemini's tool registry). */
export const GEMINI_WEB_TOOLS = ['google_web_search', 'web_fetch'];

/** Is this ACP tool call one of Gemini's web tools? (UNVERIFIED titles; kind is the stable part.) */
export function isGeminiWebToolCall(tc: any): boolean {
  const kind = String(tc?.kind ?? '').toLowerCase();
  const title = `${tc?.title ?? ''} ${tc?.toolName ?? ''}`.toLowerCase();
  return kind === 'fetch' || kind === 'search' || /google_web_search|web_fetch|googlesearch|google search|searching the web|webfetch/.test(title);
}

/** The text a web tool call would send out (query or URL), for the guard. */
export function geminiWebText(tc: any): { tool: 'search' | 'fetch'; text: string } {
  const ri = tc?.rawInput ?? {};
  const isFetch = String(tc?.kind ?? '').toLowerCase() === 'fetch' || /fetch/.test(String(tc?.title ?? '').toLowerCase());
  return { tool: isFetch ? 'fetch' : 'search', text: String(ri.query ?? ri.url ?? ri.prompt ?? tc?.title ?? '') };
}

export function geminiSystemSettings(web = false) {
  const exclude = web ? GEMINI_EXCLUDED_TOOLS.filter((t) => !GEMINI_WEB_TOOLS.includes(t)) : GEMINI_EXCLUDED_TOOLS;
  return {
    tools: { exclude },
    excludeTools: exclude,
    mcp: { allowed: ['cadabra'] },
    admin: { extensions: { enabled: false }, skills: { enabled: false }, secureModeEnabled: true },
    security: { blockGitExtensions: true },
    general: { disableAutoUpdate: true },
  };
}

/** Is this ACP tool call one of Cadabra's own tools? */
export function isCadabraToolCall(tc: any): boolean {
  const title = String(tc?.title ?? '').toLowerCase().trim();
  const toolName = String(tc?.toolName ?? '').toLowerCase();
  return tc?.serverName === 'cadabra' || /^[a-z_]+ \(cadabra mcp server\)$/.test(title) || /^mcp__cadabra__[a-z_]+$/.test(title) || /^mcp__cadabra__[a-z_]+$/.test(toolName) || /^cadabra[._:/][a-z_]+$/.test(title);
}

export class GeminiProvider implements ProviderAdapter {
  readonly id = 'gemini' as const;
  readonly label = 'Gemini';
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(msg: any) => void>();
  /** Web tool calls that already went through Cadabra's guard. */
  private guardedCalls = new Set<string>();
  private starting: Promise<any> | null = null;
  private sessionId: string | null = null;
  private models: ModelOption[] = [];
  private authMethods: { id: string; name: string }[] = [];
  private sessionKey: string | null = null;

  constructor(private readonly deps: GeminiDeps) {}

  private prepareWorkspace() {
    // A private, empty workspace with settings that exclude Gemini's own
    // shell/file/web tools (belt and braces; permission requests are rejected too).
    const dir = path.join(this.deps.workDir, 'gemini-workspace');
    fs.mkdirSync(path.join(dir, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gemini', 'settings.json'), JSON.stringify(geminiSystemSettings(!!this.deps.webAccess?.()), null, 2));
    const home = this.deps.homeDir ?? path.join(this.deps.workDir, 'gemini-home');
    fs.mkdirSync(home, { recursive: true });
    const system = path.join(home, 'cadabra-system-settings.json');
    fs.writeFileSync(system, JSON.stringify(geminiSystemSettings(!!this.deps.webAccess?.()), null, 2));
    return { dir, home, system };
  }

  private start(): Promise<any> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const exe = resolveGeminiExecutable(this.deps.exePath());
      if (!exe) throw new Error("Gemini CLI isn't installed. Install it with `npm i -g @google/gemini-cli`.");
      const ws = this.prepareWorkspace();
      const cwd = ws.dir;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GEMINI_CLI_HOME: ws.home,
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: ws.system,
        GEMINI_CLI_TRUST_WORKSPACE: 'true',
      };
      const key = this.deps.apiKey();
      if (key) env.GEMINI_API_KEY = key;
      const proc = spawnCli(exe, ['--acp', '--approval-mode', 'default'], { cwd, env });
      this.proc = proc;
      proc.stdin.on('error', () => undefined);
      createInterface({ input: proc.stdout }).on('line', (l) => this.onLine(l));
      proc.stderr.on('data', () => undefined);
      proc.on('exit', () => {
        this.proc = null;
        this.starting = null;
        this.sessionId = null;
        for (const [, p] of this.pending) p.reject(new Error('gemini exited'));
        this.pending.clear();
      });
      await new Promise<void>((resolve, reject) => {
        proc.once('spawn', () => resolve());
        proc.once('error', reject);
      });
      const init = await this.rpc('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'cadabra-os', version: this.deps.version },
      });
      this.authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];
      return init;
    })().catch((e) => {
      this.starting = null;
      throw e;
    });
    return this.starting;
  }

  private write(obj: unknown) {
    try {
      this.proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(obj as object) }) + '\n');
    } catch {
      /* gone */
    }
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && msg.method) {
      // Agent → client requests.
      if (msg.method === 'session/request_permission') {
        const tc = msg.params?.toolCall ?? {};
        // Round 7: a web tool (with web access on) asks Cadabra's guard first.
        if (this.deps.webAccess?.() && this.deps.webGuard && isGeminiWebToolCall(tc)) {
          if (tc.toolCallId) this.guardedCalls.add(String(tc.toolCallId));
          const w = geminiWebText(tc);
          void this.deps.webGuard(w.tool, w.text).then((r) => {
            const opts: any[] = Array.isArray(msg.params?.options) ? msg.params.options : [];
            const pick = r.allow ? (opts.find((o) => o.kind === 'allow_once') ?? opts.find((o) => String(o.kind).startsWith('allow'))) : (opts.find((o) => o.kind === 'reject_once') ?? opts.find((o) => String(o.kind).startsWith('reject')));
            this.write({ id: msg.id, result: pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } } });
          });
        } else this.write({ id: msg.id, result: acpPermissionDecision(msg.params) });
      }
      else this.write({ id: msg.id, error: { code: -32601, message: 'Not supported by Cadabra' } }); // fs/*, terminal/*: refused
      return;
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const e = new Error(msg.error.message ?? 'gemini error') as Error & { code?: number };
        e.code = msg.error.code;
        p.reject(e);
      } else p.resolve(msg.result);
      return;
    }
    for (const l of this.listeners) l(msg);
  }

  private rpc(method: string, params: any, timeoutMs = 60_000): Promise<any> {
    if (!this.proc) return Promise.reject(new Error('gemini not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gemini ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.write({ id, method, params });
    });
  }

  private async newSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const mcp = await this.deps.mcp();
    if (this.sessionKey) this.deps.revokeSession?.(this.sessionKey);
    this.sessionKey = randomBytes(12).toString('base64url');
    this.deps.issueSession?.(this.sessionKey);
    const r = await this.rpc('session/new', {
      cwd: path.join(this.deps.workDir, 'gemini-workspace'),
      mcpServers: [
        {
          type: 'http',
          name: 'cadabra',
          url: mcp.url,
          headers: [
            { name: 'Authorization', value: `Bearer ${mcp.token}` },
            { name: 'x-cadabra-session', value: this.sessionKey },
          ],
        },
      ],
    });
    this.sessionId = r?.sessionId ?? null;
    const avail: any[] = r?.models?.availableModels ?? r?.availableModels ?? [];
    if (avail.length) this.models = avail.map((m) => ({ id: m.modelId ?? m.id, label: m.name ?? m.modelId ?? m.id, description: m.description }));
    if (!this.sessionId) throw new Error('Gemini did not return a session id');
    return this.sessionId;
  }

  async listModels(): Promise<ModelOption[]> {
    if (!this.models.length) {
      try {
        await this.start();
        await this.newSession();
      } catch {
        /* not signed in yet */
      }
    }
    return this.models.length ? this.models : [{ id: '', label: 'Default', description: 'Gemini CLI default model', default: true }];
  }

  async checkAuth(): Promise<AuthStatus> {
    try {
      await this.start();
    } catch (e) {
      return { ok: false, detail: "Gemini CLI isn't installed", howTo: (e as Error).message };
    }
    try {
      await this.newSession();
      return { ok: true, detail: this.deps.apiKey() ? 'Gemini API key' : 'Signed in via Gemini CLI' };
    } catch (e) {
      const code = (e as any).code;
      if (code === -32000 || /auth/i.test((e as Error).message)) return { ok: false, detail: 'Not signed in', howTo: 'Choose “Sign in with Google (via Gemini CLI)” or paste a Gemini API key.' };
      return { ok: false, detail: 'Gemini unavailable', howTo: (e as Error).message };
    }
  }

  signInOptions(): SignInOption[] {
    // Only offer what this CLI version advertises (when known).
    const advertised = new Set(this.authMethods.map((m) => m.id));
    const all: SignInOption[] = [
      {
        id: 'oauth-personal',
        label: 'Sign in with Google (via Gemini CLI)',
        note: "Uses your Google account through Google's official Gemini CLI; Google's sign-in opens in your browser and Cadabra never sees your credentials. Google recommends an API key for third-party agents.",
      },
      { id: 'gemini-api-key', label: 'Use a Gemini API key', needsKey: true, keyPlaceholder: 'AIza…', note: 'From Google AI Studio. Stored encrypted on this PC.' },
      { id: 'vertex-ai', label: 'Use Vertex AI', note: 'Set GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION (and gcloud auth) in your environment, then choose this.' },
    ];
    return advertised.size ? all.filter((o) => advertised.has(o.id)) : all;
  }

  async signIn(optionId: string, io: SignInIO): Promise<AuthStatus> {
    if (optionId === 'gemini-api-key') {
      // The app stores the key (safeStorage) before calling us; it reaches the
      // CLI only through GEMINI_API_KEY, so restart the CLI to pick it up.
      if (!io.apiKey?.trim() && !this.deps.apiKey()) throw new Error('Paste a Gemini API key first.');
      await this.dispose();
    }
    await this.start();
    io.status?.(optionId === 'oauth-personal' ? 'Finish signing in with Google in your browser…' : 'Connecting…');
    // The CLI runs Google's own login (it opens the browser itself).
    await this.rpc('authenticate', { methodId: optionId }, 10 * 60_000);
    this.sessionId = null;
    return this.checkAuth();
  }

  /** REVIEW-3 N4-R: a stopped run's session is revoked; the next run gets a new one. */
  onAbort(): void {
    this.reset();
  }

  reset(): void {
    this.sessionId = null;
    if (this.sessionKey) this.deps.revokeSession?.(this.sessionKey);
    this.sessionKey = null;
  }

  async dispose(): Promise<void> {
    await killTree(this.proc);
    this.proc = null;
    this.starting = null;
    this.sessionId = null;
  }

  async *send(req: SendRequest): AsyncIterable<ProviderEvent> {
    let sessionId: string;
    try {
      await this.start();
      sessionId = await this.newSession();
      if (req.model) await this.rpc('session/set_model', { sessionId, modelId: req.model }).catch(() => undefined);
    } catch (e) {
      yield { type: 'error', message: (e as Error).message };
      return;
    }
    yield { type: 'session', sessionId };
    const st = newAcpMapState();
    const q = new AsyncQueue<ProviderEvent>();
    const listener = (msg: any) => {
      if (msg.method !== 'session/update' || msg.params?.sessionId !== sessionId) return;
      const u = msg.params?.update;
      // REVIEW-2 #8 runtime verification: any tool that isn't Cadabra's means the
      // isolation failed. Stop the turn and drop the session; never continue.
      // REVIEW-7: a read-only web search may run WITHOUT a permission request,
      // so check it here too; if it can't be checked (no query visible) or the
      // guard says no, stop the turn.
      if (u?.sessionUpdate === 'tool_call' && !isCadabraToolCall(u) && this.deps.webAccess?.() && isGeminiWebToolCall(u) && !this.guardedCalls.has(String(u.toolCallId ?? ''))) {
        const w = geminiWebText(u);
        const stop = (why: string) => {
          this.write({ method: 'session/cancel', params: { sessionId } });
          if (!q.isClosed) {
            q.push({ type: 'error', message: `Stopped a web ${w.tool}: ${why}` });
            q.close();
          }
        };
        if (!w.text.trim() || w.text === String(u.title ?? '')) stop('Cadabra couldn’t check it first.');
        else void this.deps.webGuard?.(w.tool, w.text).then((r) => !r.allow && stop(r.reason ?? 'not allowed'));
        if (u.toolCallId) this.guardedCalls.add(String(u.toolCallId));
      }
      if (u?.sessionUpdate === 'tool_call' && !isCadabraToolCall(u) && !(this.deps.webAccess?.() && isGeminiWebToolCall(u))) {
        this.write({ method: 'session/cancel', params: { sessionId } });
        this.reset();
        if (!q.isClosed) {
          q.push({ type: 'error', message: `Gemini tried to use one of its own tools (${String(u.title ?? u.kind ?? 'unknown')}), which Cadabra doesn't allow. The request was stopped.` });
          q.close();
        }
        return;
      }
      for (const ev of mapAcpUpdate(msg.params, st)) if (!q.isClosed) q.push(ev);
    };
    this.listeners.add(listener);
    const onAbort = () => {
      this.write({ method: 'session/cancel', params: { sessionId } });
      setTimeout(() => {
        if (!q.isClosed) {
          this.reset();
          q.push({ type: 'done', sessionId });
          q.close();
        }
      }, 1500);
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    if (req.signal.aborted) onAbort(); // aborted while we were starting up
    const prompt: any[] = [];
    if (req.image) prompt.push({ type: 'image', mimeType: req.image.mimeType, data: req.image.data });
    prompt.push({ type: 'text', text: `${SYSTEM_PROMPT}\n\n${buildUserText(req)}` });
    this.rpc('session/prompt', { sessionId, prompt }, 15 * 60_000).then(
      (r) => {
        if (!q.isClosed) {
          q.push(r?.stopReason === 'refusal' ? { type: 'error', message: 'Gemini declined to answer.' } : { type: 'done', sessionId });
          q.close();
        }
      },
      (e) => {
        if (!q.isClosed) {
          q.push({ type: 'error', message: (e as Error).message });
          q.close();
        }
      },
    );
    try {
      for await (const ev of q) yield ev;
    } finally {
      this.listeners.delete(listener);
      req.signal.removeEventListener('abort', onAbort);
    }
  }
}
