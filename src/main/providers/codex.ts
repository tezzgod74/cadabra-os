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

export interface CodexMapState {
  threadId?: string;
  turnId?: string;
  deltaItems: Set<string>;
  sawText: boolean;
  needsBreak: boolean;
  finished: boolean;
}

export function newCodexMapState(): CodexMapState {
  return { deltaItems: new Set(), sawText: false, needsBreak: false, finished: false };
}

function txt(st: CodexMapState, t: string): ProviderEvent[] {
  if (!t) return [];
  const out: ProviderEvent[] = [];
  if (st.needsBreak && st.sawText) out.push({ type: 'text', delta: '\n\n' });
  st.needsBreak = false;
  st.sawText = true;
  out.push({ type: 'text', delta: t });
  return out;
}

const isToolItem = (item: any) => item && (item.type === 'mcpToolCall' || item.type === 'mcp_tool_call' || item.type === 'dynamicToolCall');
/** Round 7: Codex's own web search item (UNVERIFIED item name; matched loosely). */
export const isWebSearchItem = (item: any) => !!item && /^web_?search/i.test(String(item.type ?? ''));

/**
 * Pure mapping of `codex app-server` notifications (JSON-RPC, one per line,
 * no "jsonrpc" field) to ProviderEvents. Shapes per `codex app-server
 * generate-ts` as summarized in docs/research.md §1.4.
 */
export function mapCodexNotification(msg: any, st: CodexMapState): ProviderEvent[] {
  const m = msg?.method;
  const p = msg?.params ?? {};
  if (p.threadId && st.threadId && p.threadId !== st.threadId) return [];
  const evTurn = p.turnId ?? p.turn?.id;
  if (m !== 'turn/started' && evTurn && st.turnId && evTurn !== st.turnId) return [];
  switch (m) {
    case 'turn/started':
      st.turnId = p.turn?.id ?? p.turnId ?? st.turnId;
      return [];
    case 'item/agentMessage/delta':
      if (p.itemId) st.deltaItems.add(p.itemId);
      return txt(st, p.delta ?? '');
    case 'item/started': {
      const item = p.item;
      if (isToolItem(item)) {
        st.needsBreak = true;
        return [{ type: 'tool', id: item.id, name: shortToolName(item.tool ?? item.name ?? ''), phase: 'start' }];
      }
      if (isWebSearchItem(item)) {
        st.needsBreak = true;
        return [{ type: 'tool', id: item.id, name: 'web_search', phase: 'start' }];
      }
      return [];
    }
    case 'item/completed': {
      const item = p.item;
      if (!item) return [];
      if (isToolItem(item)) {
        const failed = item.status === 'failed' || !!item.error;
        const first = Array.isArray(item.result?.content) ? item.result.content.find((c: any) => c?.type === 'text')?.text : undefined;
        return [{ type: 'tool', id: item.id, name: shortToolName(item.tool ?? ''), phase: 'end', ok: !failed, summary: (item.error?.message ?? first)?.slice(0, 300) }];
      }
      if ((item.type === 'agentMessage' || item.type === 'agent_message') && !st.deltaItems.has(item.id)) {
        return txt(st, item.text ?? '');
      }
      return [];
    }
    case 'turn/completed': {
      st.finished = true;
      const turn = p.turn ?? {};
      if (turn.status === 'failed') return [{ type: 'error', message: turn.error?.message ?? 'Codex turn failed' }];
      return [{ type: 'done', sessionId: st.threadId }];
    }
    case 'error': {
      if (p.willRetry) return [{ type: 'status', text: 'Retrying…' }];
      return [{ type: 'error', message: p.error?.message ?? p.message ?? 'Codex error' }];
    }
    default:
      return [];
  }
}

/** Response to server->client requests: never allow command execution or file changes. */
export function codexServerRequestReply(method: string): any {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: 'decline' };
    case 'mcpServer/elicitation/request':
      return { action: 'decline' };
    default:
      return null;
  }
}

export function resolveCodexExecutable(override?: string): string | undefined {
  if (override && fs.existsSync(override)) return override;
  return firstExisting([
    whichSync('codex.exe'),
    ...npmGlobalRoots().flatMap((r) => [
      path.join(r, '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'),
      path.join(r, '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'),
    ]),
    whichSync('codex.cmd'),
  ]);
}

export interface CodexDeps {
  exePath: () => string | undefined;
  /** Round 7: web access setting and Cadabra's guard (post-hoc for Codex). */
  webAccess?: () => boolean;
  webGuard?: (tool: 'search' | 'fetch', text: string) => Promise<{ allow: boolean; reason?: string }>;
  /** Cadabra's HTTP MCP server (started lazily). */
  mcp: () => Promise<{ url: string; token: string }>;
  workDir: string;
  /**
   * Cadabra-owned CODEX_HOME (P1). The user's ~/.codex config, MCP servers,
   * profiles and AGENTS.md are never loaded, and Cadabra never copies their
   * token files: the user signs in here through Codex's own login flow.
   */
  homeDir: string;
  version: string;
  /** REVIEW-2 N4: refuse further MCP calls from a dropped thread's session key. */
  revokeSession?: (key: string) => void;
  /** REVIEW-3 N4-R: allowlist a new session key. */
  issueSession?: (key: string) => void;
}

/** The minimal config Cadabra's private CODEX_HOME starts with (no MCP servers, no shell). */
export const CODEX_HOME_CONFIG = `# Written by Cadabra OS. This CODEX_HOME is private to Cadabra so your own
# ~/.codex config, MCP servers and AGENTS.md are not loaded into it.
approval_policy = "never"
sandbox_mode = "read-only"

[features]
shell_tool = false
unified_exec = false
web_search_request = false
`;

/**
 * OpenAI Codex via `codex app-server` (JSON-RPC over stdio): streamed text
 * deltas, model/list, account/read, account/login/start, turn/interrupt.
 * Cadabra's tools are attached per thread as an HTTP MCP server (bearer token
 * passed by env var, never written into the thread config); read-only
 * sandbox, approval policy "never", shell features disabled,
 * command/file approvals declined, ephemeral threads.
 */
export class CodexProvider implements ProviderAdapter {
  readonly id = 'codex' as const;
  readonly label = 'Codex';
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(msg: any) => void>();
  private starting: Promise<void> | null = null;
  private threadId: string | null = null;
  private threadModel = '';
  /** Per-thread MCP session key (header), revoked when the thread is dropped. */
  private sessionKey: string | null = null;
  private isolationChecked = false;
  /** Tool names the thread reported (P1 verification), if the server exposes them. */
  toolCheck: { ok: boolean; extras: string[]; verified: boolean } = { ok: true, extras: [], verified: false };

  constructor(private readonly deps: CodexDeps) {}

  private prepareHome() {
    fs.mkdirSync(this.deps.homeDir, { recursive: true });
    const cfg = path.join(this.deps.homeDir, 'config.toml');
    if (!fs.existsSync(cfg) || fs.readFileSync(cfg, 'utf8') !== CODEX_HOME_CONFIG) fs.writeFileSync(cfg, CODEX_HOME_CONFIG);
  }

  private start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const exe = resolveCodexExecutable(this.deps.exePath());
      if (!exe) throw new Error('Codex isn\'t installed. Install it with `npm i -g @openai/codex` (or winget install OpenAI.Codex).');
      fs.mkdirSync(this.deps.workDir, { recursive: true });
      this.prepareHome();
      const mcp = await this.deps.mcp();
      const env = { ...process.env, CODEX_HOME: this.deps.homeDir, CADABRA_MCP_TOKEN: mcp.token };
      const proc = spawnCli(exe, ['app-server'], { cwd: this.deps.workDir, env });
      this.proc = proc;
      proc.stdin.on('error', () => undefined); // H2: EPIPE on a dying app-server must not crash main
      createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
      proc.stderr.on('data', () => undefined);
      proc.on('exit', () => {
        this.proc = null;
        this.starting = null;
        this.threadId = null;
        for (const [, p] of this.pending) p.reject(new Error('codex app-server exited'));
        this.pending.clear();
      });
      await new Promise<void>((resolve, reject) => {
        proc.once('spawn', () => resolve());
        proc.once('error', reject);
      });
      // clientInfo.name identifies Cadabra to OpenAI (research §8.2).
      await this.rpc('initialize', { clientInfo: { name: 'cadabra-os', title: 'Cadabra OS', version: this.deps.version }, capabilities: null });
      this.notify('initialized', {});
    })().catch((e) => {
      this.starting = null;
      throw e;
    });
    return this.starting;
  }

  private write(obj: unknown) {
    try {
      this.proc?.stdin.write(JSON.stringify(obj) + '\n');
    } catch {
      /* process gone */
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
      // Server -> client request.
      const reply = codexServerRequestReply(msg.method);
      this.write(reply ? { id: msg.id, result: reply } : { id: msg.id, error: { code: -32601, message: 'Not supported by Cadabra' } });
      return;
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'codex error'));
      else p.resolve(msg.result);
      return;
    }
    for (const l of this.listeners) l(msg);
  }

  private rpc(method: string, params: any, timeoutMs = 30000): Promise<any> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error('codex not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex ${method} timed out`));
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

  private notify(method: string, params: any) {
    this.write({ method, params });
  }

  private waitFor(pred: (msg: any) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      const done = (fn: () => void) => {
        clearTimeout(t);
        this.listeners.delete(l);
        fn();
      };
      const l = (msg: any) => {
        if (pred(msg)) done(() => resolve(msg));
      };
      const t = setTimeout(() => done(() => reject(new Error('Timed out waiting for sign-in'))), timeoutMs);
      signal?.addEventListener('abort', () => done(() => reject(new Error('Sign-in cancelled'))), { once: true });
      this.listeners.add(l);
    });
  }

  async listModels(): Promise<ModelOption[]> {
    try {
      await this.start();
      const r = await this.rpc('model/list', { limit: 50, includeHidden: false });
      const list: any[] = Array.isArray(r) ? r : (r?.data ?? r?.models ?? []);
      return list.map((m) => ({ id: m.id ?? m.model, label: m.displayName ?? m.id, description: m.description, default: !!m.isDefault }));
    } catch {
      return [{ id: '', label: 'Default', description: 'Codex default model', default: true }];
    }
  }

  async checkAuth(): Promise<AuthStatus> {
    try {
      await this.start();
      const r = await this.rpc('account/read', { refreshToken: false });
      const a = r?.account;
      if (a) {
        // Privacy (REVIEW-3 AUTH-3): never the account email; the plan is enough.
        if (a.type === 'chatgpt') return { ok: true, detail: `Signed in to ChatGPT${a.planType ? ` (${cap(a.planType)})` : ''}` };
        if (a.type === 'apiKey') return { ok: true, detail: 'OpenAI API key' };
        return { ok: true, detail: `Signed in (${a.type})` };
      }
      return { ok: false, detail: 'Not signed in', howTo: 'Choose “Sign in with ChatGPT (via Codex)” or paste an OpenAI API key.' };
    } catch (e) {
      return { ok: false, detail: 'Codex isn\'t installed', howTo: (e as Error).message };
    }
  }

  signInOptions(): SignInOption[] {
    return [
      {
        id: 'chatgpt',
        label: 'Sign in with ChatGPT (via Codex)',
        note: "Uses your ChatGPT plan through OpenAI's official Codex app. OpenAI's sign-in page opens in your browser; Cadabra never sees your password or tokens.",
      },
      { id: 'apiKey', label: 'Use an OpenAI API key', needsKey: true, keyPlaceholder: 'sk-…', note: 'Usage-based billing on your OpenAI account. The key is handed to Codex.' },
    ];
  }

  /** Login runs entirely in Codex's own flow; Cadabra only opens OpenAI's URL. */
  async signIn(optionId: string, io: SignInIO): Promise<AuthStatus> {
    await this.start();
    if (optionId === 'apiKey') {
      if (!io.apiKey?.trim()) throw new Error('Paste an API key first.');
      await this.rpc('account/login/start', { type: 'apiKey', apiKey: io.apiKey.trim() });
      return this.checkAuth();
    }
    const r = await this.rpc('account/login/start', { type: 'chatgpt' });
    const loginId = r?.loginId;
    if (!r?.authUrl) throw new Error('Codex did not return a sign-in link.');
    const completed = this.waitFor((m) => m.method === 'account/login/completed' && (!loginId || m.params?.loginId === loginId), 10 * 60_000, io.signal);
    io.status?.('Finish signing in to ChatGPT in your browser…');
    io.openUrl(r.authUrl);
    try {
      const msg = await completed;
      if (msg.params?.success === false) throw new Error(msg.params?.error ?? 'Sign-in was not completed.');
    } catch (e) {
      if (loginId) this.rpc('account/login/cancel', { loginId }).catch(() => undefined);
      throw e;
    }
    return this.checkAuth();
  }

  async signOut(): Promise<void> {
    await this.start();
    await this.rpc('account/logout', {}).catch(() => undefined);
    this.reset();
  }

  /** REVIEW-3 N4-R: a stopped run's session is revoked; the next run gets a new one. */
  onAbort(): void {
    this.reset();
  }

  reset(): void {
    this.threadId = null;
    if (this.sessionKey) this.deps.revokeSession?.(this.sessionKey);
    this.sessionKey = null;
  }

  /**
   * REVIEW-2 #8: actively ask the app-server for its effective config and
   * check that shell/exec features are off and Cadabra is the only MCP
   * server. If the server doesn't support the query, say so (never assume).
   */
  async verifyIsolation(): Promise<{ ok: boolean; verified: boolean; detail: string }> {
    try {
      await this.start();
      const r = await this.rpc('config/read', { includeLayers: false }, 10_000);
      const cfg = r?.config ?? r ?? {};
      const feats = cfg.features ?? {};
      const servers = Object.keys(cfg.mcp_servers ?? cfg.mcpServers ?? {});
      const bad: string[] = [];
      for (const f of ['shell_tool', 'unified_exec', ...(this.deps.webAccess?.() ? [] : ['web_search_request'])]) if (feats[f] === true) bad.push(`${f} is on`);
      for (const n of servers) if (n !== 'cadabra') bad.push(`extra MCP server "${n}"`);
      const res = { ok: bad.length === 0, verified: true, detail: bad.length ? bad.join(', ') : 'shell off, only Cadabra tools' };
      this.toolCheck = { ok: res.ok, extras: bad, verified: true };
      return res;
    } catch (e) {
      return { ok: true, verified: false, detail: `could not query Codex config (${(e as Error).message}); relying on the private CODEX_HOME` };
    }
  }

  async dispose(): Promise<void> {
    await killTree(this.proc);
    this.proc = null;
  }

  private async ensureThread(model: string, resumeId?: string): Promise<string> {
    if (this.threadId && this.threadModel === model) return this.threadId;
    // REVIEW-2 #8: actively verify isolation once per app-server process.
    if (!this.isolationChecked) {
      this.isolationChecked = true;
      const iso = await this.verifyIsolation();
      if (iso.verified && !iso.ok) throw new Error(`Codex isn't isolated (${iso.detail}). Cadabra won't run it this way.`);
    }
    if (this.sessionKey) this.deps.revokeSession?.(this.sessionKey);
    this.sessionKey = randomBytes(12).toString('base64url');
    this.deps.issueSession?.(this.sessionKey);
    const mcp = await this.deps.mcp();
    const config = {
      mcp_servers: {
        cadabra: {
          url: mcp.url,
          // S14: the bearer token lives only in the app-server's env, never in thread config/rollouts.
          bearer_token_env_var: 'CADABRA_MCP_TOKEN',
          // REVIEW-2 N4: binds this thread's tool calls to a revocable session key.
          http_headers: { 'x-cadabra-session': this.sessionKey },
          default_tools_approval_mode: 'approve',
          tool_timeout_sec: 120,
        },
      },
      // Round 7: Codex's own web search (read-only) follows the Web access setting.
      // Codex can't ask Cadabra before searching, so web queries are checked as
      // they appear and the turn is stopped if one would leak something private.
      features: { shell_tool: false, unified_exec: false, web_search_request: !!this.deps.webAccess?.() },
    };
    const params = {
      ...(model ? { model } : {}),
      cwd: this.deps.workDir,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      developerInstructions: SYSTEM_PROMPT,
      config,
    };
    let r: any;
    if (resumeId) r = await this.rpc('thread/resume', { threadId: resumeId, ...params }).catch(() => null);
    if (!r) r = await this.rpc('thread/start', params);
    this.threadId = r?.thread?.id ?? r?.threadId;
    this.threadModel = model;
    if (!this.threadId) throw new Error('codex did not return a thread id');
    // P1: if the server reports the thread's tools, refuse anything beyond Cadabra's + planning.
    const tools: string[] | undefined = r?.thread?.tools ?? r?.tools;
    if (Array.isArray(tools)) {
      this.toolCheck = codexToolCheck(tools.map((t: any) => (typeof t === 'string' ? t : t?.name ?? '')));
      if (!this.toolCheck.ok) {
        this.threadId = null;
        throw new Error(`Codex offered tools Cadabra doesn't allow (${this.toolCheck.extras.join(', ')}). Update Codex or check its config.`);
      }
    }
    return this.threadId;
  }

  async *send(req: SendRequest): AsyncIterable<ProviderEvent> {
    let threadId: string;
    try {
      await this.start();
      threadId = await this.ensureThread(req.model, req.resumeId);
    } catch (e) {
      yield { type: 'error', message: (e as Error).message };
      return;
    }
    yield { type: 'session', sessionId: threadId };
    const st = newCodexMapState();
    st.threadId = threadId;
    const q = new AsyncQueue<ProviderEvent>();
    let interruptWanted = false;
    const interrupt = () => {
      if (st.turnId) this.rpc('turn/interrupt', { threadId, turnId: st.turnId }).catch(() => undefined);
      else interruptWanted = true; // P2: interrupt as soon as the turn id is known
    };
    const listener = (msg: any) => {
      if (msg.method === 'turn/started' && msg.params?.threadId === threadId && !st.turnId) {
        st.turnId = msg.params?.turn?.id ?? msg.params?.turnId;
        if (interruptWanted) interrupt();
      }
      // Round 7: Codex can't ask first, so its web queries are checked as they
      // appear; one that would leak something private stops the turn.
      if (msg.method === 'item/started' && isWebSearchItem(msg.params?.item) && this.deps.webGuard) {
        const query = String(msg.params.item.query ?? msg.params.item.action?.query ?? '');
        void this.deps.webGuard('search', query).then((r) => {
          if (r.allow || q.isClosed) return;
          interrupt();
          q.push({ type: 'error', message: `Stopped a web search: ${r.reason ?? 'not allowed'}` });
          q.close();
        });
      }
      for (const ev of mapCodexNotification(msg, st)) {
        if (q.isClosed) return;
        q.push(ev);
        if (ev.type === 'done' || ev.type === 'error') q.close();
      }
    };
    this.listeners.add(listener);
    const onAbort = () => {
      interrupt();
      setTimeout(() => {
        if (!q.isClosed) {
          // The turn didn't wind down: drop this thread so an orphaned turn can't leak into the next run (P2/P5).
          this.reset();
          q.push({ type: 'done', sessionId: threadId });
          q.close();
        }
      }, 1500);
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    if (req.signal.aborted) onAbort(); // aborted while we were starting up
    try {
      const input: any[] = [{ type: 'text', text: buildUserText(req), text_elements: [] }];
      if (req.image) {
        const file = path.join(this.deps.workDir, `screen-${Date.now()}.png`);
        fs.writeFileSync(file, Buffer.from(req.image.data, 'base64'));
        input.push({ type: 'localImage', path: file });
        setTimeout(() => fs.rm(file, { force: true }, () => undefined), 120_000);
      }
      const r = await this.rpc('turn/start', { threadId, input, ...(req.model ? { model: req.model } : {}) });
      st.turnId = r?.turn?.id ?? st.turnId;
      if (interruptWanted) interrupt();
      for await (const ev of q) yield ev;
    } catch (e) {
      yield { type: 'error', message: (e as Error).message };
    } finally {
      this.listeners.delete(listener);
      req.signal.removeEventListener('abort', onAbort);
    }
  }
}

/** P1: only Cadabra's MCP tools (and harmless planning) may be present on the thread. */
export function codexToolCheck(names: string[]): { ok: boolean; extras: string[]; verified: boolean } {
  const allowed = (n: string) => /^(mcp__)?cadabra[-_.:/]/i.test(n) || /^(update_plan|plan|todo_list|think)$/i.test(n);
  const extras = names.filter((n) => n && !allowed(n));
  return { ok: extras.length === 0, extras, verified: true };
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
