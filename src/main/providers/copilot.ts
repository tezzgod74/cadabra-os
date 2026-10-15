import fs from 'node:fs';
import path from 'node:path';
import type { AuthStatus, ModelOption, ProviderEvent } from '../../shared/types';
import { AsyncQueue } from '../../shared/async-queue';
import { firstExisting, npmGlobalRoots, whichSync } from '../exe-finder';
import type { ToolDef } from '../tools';
import { SYSTEM_PROMPT } from '../tools';
import { buildUserText, shortToolName, type ProviderAdapter, type SendRequest } from './types';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Convert an MCP CallToolResult to Copilot's ToolResultObject (images -> binaryResultsForLlm). */
export function toCopilotResult(r: CallToolResult): {
  textResultForLlm: string;
  binaryResultsForLlm?: { data: string; mimeType: string; type: 'image' }[];
  resultType: 'success' | 'failure';
  error?: string;
} {
  const texts: string[] = [];
  const images: { data: string; mimeType: string; type: 'image' }[] = [];
  for (const c of r.content ?? []) {
    if (c.type === 'text') texts.push(c.text);
    else if (c.type === 'image') images.push({ data: c.data, mimeType: c.mimeType, type: 'image' });
  }
  const text = texts.join('\n') || (images.length ? 'Screenshot attached.' : 'OK');
  return {
    textResultForLlm: text,
    ...(images.length ? { binaryResultsForLlm: images } : {}),
    resultType: r.isError ? 'failure' : 'success',
    ...(r.isError ? { error: text } : {}),
  };
}

/** Pure mapping of Copilot SDK session events to ProviderEvents (unit-tested). */
export function mapCopilotEvent(ev: any, st: { sawText: boolean; needsBreak: boolean }): ProviderEvent[] {
  if (!ev || typeof ev !== 'object') return [];
  const d = ev.data ?? {};
  switch (ev.type) {
    case 'assistant.message_delta': {
      if (d.parentToolCallId || !d.deltaContent) return [];
      const out: ProviderEvent[] = [];
      if (st.needsBreak && st.sawText) out.push({ type: 'text', delta: '\n\n' });
      st.needsBreak = false;
      st.sawText = true;
      out.push({ type: 'text', delta: d.deltaContent });
      return out;
    }
    case 'tool.execution_start':
      if (d.parentToolCallId) return [];
      st.needsBreak = true;
      return [{ type: 'tool', id: d.toolCallId, name: shortToolName(d.mcpToolName ?? d.toolName ?? ''), phase: 'start' }];
    case 'tool.execution_complete':
      if (d.parentToolCallId) return [];
      return [{ type: 'tool', id: d.toolCallId, name: '', phase: 'end', ok: !!d.success, summary: d.result?.content?.slice?.(0, 300) ?? d.error?.message }];
    case 'session.error':
      return [{ type: 'error', message: d.message ?? 'Copilot error' }];
    case 'session.idle':
      return [{ type: 'done' }];
    default:
      return [];
  }
}

export interface CopilotDeps {
  tools: () => ToolDef[];
  exePath: () => string | undefined;
  workDir: string;
}

/** User-installed Copilot runtime (we don't ship the 136 MB runtime in the installer). */
export function resolveCopilotExecutable(override?: string): string | undefined {
  if (override && fs.existsSync(override)) return override;
  return firstExisting([
    whichSync('copilot.exe'),
    ...npmGlobalRoots().flatMap((r) => [path.join(r, '@github', 'copilot', 'copilot.exe'), path.join(r, '@github', 'copilot', 'bin', 'copilot.exe')]),
  ]);
}

/**
 * GitHub Copilot via @github/copilot-sdk. Cadabra's tools are registered as
 * custom tools (images go back via binaryResultsForLlm); every built-in tool is
 * hidden (`availableTools: ['custom:*']`) and permission requests other than
 * our own custom tools are rejected.
 */
export class CopilotProvider implements ProviderAdapter {
  readonly id = 'copilot' as const;
  readonly label = 'GitHub Copilot';
  private client: any = null;
  private session: any = null;
  private sessionModel = '';
  private models: ModelOption[] | null = null;

  constructor(private readonly deps: CopilotDeps) {}

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    const sdk: any = await import('@github/copilot-sdk');
    const exe = resolveCopilotExecutable(this.deps.exePath());
    fs.mkdirSync(this.deps.workDir, { recursive: true });
    const client = new sdk.CopilotClient({
      ...(exe ? { connection: sdk.RuntimeConnection.forStdio({ path: exe }) } : {}),
      workingDirectory: this.deps.workDir,
      logLevel: 'error',
    });
    await client.start();
    this.client = client;
    return client;
  }

  async listModels(): Promise<ModelOption[]> {
    if (this.models) return this.models;
    try {
      const c = await this.getClient();
      const ms: any[] = await c.listModels();
      this.models = ms
        .filter((m) => m.policy?.state !== 'disabled')
        .map((m) => ({ id: m.id, label: m.name ?? m.id, description: m.capabilities?.supports?.vision === false ? 'No image input' : undefined }));
      if (!this.models.some((m) => m.id === 'auto')) this.models.unshift({ id: 'auto', label: 'Auto', description: 'Copilot picks the model', default: true });
      return this.models;
    } catch {
      return [{ id: 'auto', label: 'Auto', description: 'Copilot picks the model', default: true }];
    }
  }

  async checkAuth(): Promise<AuthStatus> {
    try {
      const c = await this.getClient();
      const a = await c.getAuthStatus();
      if (a.isAuthenticated) return { ok: true, detail: a.login ? `Signed in as ${a.login}` : 'Signed in' };
      return { ok: false, detail: a.statusMessage ?? 'Not signed in', howTo: 'Run `copilot` in a terminal and use /login (or set COPILOT_GITHUB_TOKEN).' };
    } catch (e) {
      return {
        ok: false,
        detail: 'Copilot runtime not available',
        howTo: `Install GitHub Copilot CLI (npm i -g @github/copilot, or winget install GitHub.Copilot). ${(e as Error).message ?? ''}`.trim(),
      };
    }
  }

  reset(): void {
    const s = this.session;
    this.session = null;
    s?.disconnect?.().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.reset();
    const c = this.client;
    this.client = null;
    await c?.stop?.().catch(() => undefined);
  }

  private async getSession(model: string, resumeId?: string): Promise<any> {
    if (this.session && this.sessionModel === model) return this.session;
    this.reset();
    const sdk: any = await import('@github/copilot-sdk');
    const c = await this.getClient();
    const tools = this.deps.tools().map((d) =>
      sdk.defineTool(d.name, {
        description: d.description,
        parameters: z.object(d.shape),
        skipPermission: true,
        defer: 'never',
        handler: async (args: any) => toCopilotResult(await d.handler(args)),
      }),
    );
    const config = {
      ...(model && model !== 'auto' ? { model } : {}),
      streaming: true,
      tools,
      availableTools: ['custom:*'],
      onPermissionRequest: async (req: any) =>
        req?.kind === 'custom-tool' ? { kind: 'approved' } : { kind: 'reject', feedback: 'Not allowed in Cadabra: only Cadabra tools are available.' },
      systemMessage: { mode: 'append', content: SYSTEM_PROMPT },
      workingDirectory: this.deps.workDir,
    };
    this.session = resumeId ? await c.resumeSession(resumeId, config).catch(() => c.createSession(config)) : await c.createSession(config);
    this.sessionModel = model;
    return this.session;
  }

  async *send(req: SendRequest): AsyncIterable<ProviderEvent> {
    let session: any;
    try {
      session = await this.getSession(req.model, req.resumeId);
    } catch (e) {
      yield { type: 'error', message: `Couldn't start Copilot: ${(e as Error).message}` };
      return;
    }
    const q = new AsyncQueue<ProviderEvent>();
    const st = { sawText: false, needsBreak: false };
    const off = session.on((ev: any) => {
      for (const pe of mapCopilotEvent(ev, st)) {
        if (q.isClosed) return;
        q.push(pe);
        if (pe.type === 'done' || pe.type === 'error') q.close();
      }
    });
    const onAbort = () => {
      session.abort?.().catch(() => undefined);
      setTimeout(() => {
        if (!q.isClosed) {
          // P5: the session ignored abort; drop it so the next turn can't
          // receive this turn's late events (it resumes by session id).
          if (this.session === session) {
            this.session = null;
            session.disconnect?.().catch(() => undefined);
          }
          q.push({ type: 'done' });
          q.close();
        }
      }, 1500);
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    if (req.signal.aborted) onAbort(); // aborted while we were starting up
    if (session.sessionId) yield { type: 'session', sessionId: session.sessionId };
    try {
      await session.send({
        prompt: buildUserText(req),
        ...(req.image ? { attachments: [{ type: 'blob', data: req.image.data, mimeType: req.image.mimeType, displayName: 'screenshot.png' }] } : {}),
      });
      for await (const ev of q) yield ev.type === 'done' ? { ...ev, sessionId: session.sessionId } : ev;
    } catch (e) {
      yield { type: 'error', message: (e as Error).message };
    } finally {
      off?.();
      req.signal.removeEventListener('abort', onAbort);
    }
  }
}
