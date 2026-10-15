// Pure mapping from Claude Code stream-json messages to Cadabra ProviderEvents.
// Kept free of process handling so it can be unit-tested with fixtures.

import type { ProviderEvent } from '../../shared/types';
import { shortToolName } from './types';

export interface ClaudeMapState {
  /** Assistant message ids for which we've seen stream_event deltas. */
  streamed: Set<string>;
  currentStreamMsg: string | null;
  toolsStarted: Set<string>;
  /** tool_use id → tool name (to recognise WebSearch results). */
  toolNames?: Map<string, string>;
  sawText: boolean;
  needsBreak: boolean;
  sessionId?: string;
  finished: boolean;
}

export function newClaudeMapState(): ClaudeMapState {
  return { streamed: new Set(), currentStreamMsg: null, toolsStarted: new Set(), sawText: false, needsBreak: false, finished: false };
}

function textOut(st: ClaudeMapState, t: string): ProviderEvent[] {
  if (!t) return [];
  const out: ProviderEvent[] = [];
  if (st.needsBreak && st.sawText) out.push({ type: 'text', delta: '\n\n' });
  st.needsBreak = false;
  st.sawText = true;
  out.push({ type: 'text', delta: t });
  return out;
}

/** https URLs in a web search result (the search provider's links). */
export function urlsIn(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s"'<>\])}]+/g) ?? [])].slice(0, 60);
}

function toolStart(st: ClaudeMapState, id: string, name: string): ProviderEvent[] {
  if (id && name) (st.toolNames ??= new Map()).set(id, name);
  if (!id || st.toolsStarted.has(id)) return [];
  st.toolsStarted.add(id);
  st.needsBreak = true;
  return [{ type: 'tool', id, name: shortToolName(name), phase: 'start' }];
}

export function mapClaudeMessage(msg: any, st: ClaudeMapState): ProviderEvent[] {
  if (!msg || typeof msg !== 'object') return [];
  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init' && msg.session_id) {
        st.sessionId = msg.session_id;
        return [{ type: 'session', sessionId: msg.session_id }];
      }
      return [];
    }
    case 'stream_event': {
      if (msg.parent_tool_use_id) return [];
      const ev = msg.event;
      if (!ev) return [];
      if (ev.type === 'message_start' && ev.message?.id) {
        st.streamed.add(ev.message.id);
        st.currentStreamMsg = ev.message.id;
        return [];
      }
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        return toolStart(st, ev.content_block.id, ev.content_block.name);
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        return textOut(st, ev.delta.text ?? '');
      }
      return [];
    }
    case 'assistant': {
      if (msg.parent_tool_use_id) return [];
      const m = msg.message;
      const out: ProviderEvent[] = [];
      const wasStreamed = m?.id && st.streamed.has(m.id);
      for (const block of m?.content ?? []) {
        if (block.type === 'text' && !wasStreamed) out.push(...textOut(st, block.text ?? ''));
        if (block.type === 'tool_use') out.push(...toolStart(st, block.id, block.name));
      }
      if (msg.error && !out.length) out.push({ type: 'status', text: `Model error: ${String(msg.error)}` });
      return out;
    }
    case 'user': {
      if (msg.parent_tool_use_id) return [];
      const content = msg.message?.content;
      if (!Array.isArray(content)) return [];
      const out: ProviderEvent[] = [];
      for (const block of content) {
        if (block?.type === 'tool_result') {
          let summary: string | undefined;
          const c = block.content;
          if (typeof c === 'string') summary = c;
          else if (Array.isArray(c)) summary = c.find((x: any) => x?.type === 'text')?.text;
          out.push({ type: 'tool', id: block.tool_use_id, name: '', phase: 'end', ok: !block.is_error, summary: summary?.slice(0, 300) });
          if (st.toolNames?.get(block.tool_use_id) === 'WebSearch' && !block.is_error) {
            const full = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (typeof x?.text === 'string' ? x.text : JSON.stringify(x))).join('\n') : JSON.stringify(c ?? '');
            const urls = urlsIn(full);
            if (urls.length) out.push({ type: 'web-results', urls });
          }
        }
      }
      return out;
    }
    case 'result': {
      st.finished = true;
      if (msg.subtype === 'success' && !msg.is_error) {
        const out: ProviderEvent[] = [];
        // If nothing streamed (e.g. partial messages disabled), surface the final text.
        if (!st.sawText && typeof msg.result === 'string' && msg.result) out.push(...textOut(st, msg.result));
        out.push({ type: 'done', sessionId: msg.session_id ?? st.sessionId, costUsd: msg.total_cost_usd });
        return out;
      }
      if (msg.subtype === 'error_max_budget_usd') return [{ type: 'error', message: `This chat reached its $${CLAUDE_SESSION_BUDGET_USD} spending cap, so I stopped. Start a new chat to keep going.` }];
      if (msg.subtype === 'error_max_turns') return [{ type: 'error', message: 'That took more steps than I allow in one go, so I stopped. Ask me to continue if you want.' }];
      const errs: string[] = Array.isArray(msg.errors) ? msg.errors : [];
      const text = errs.join('; ') || (typeof msg.result === 'string' ? msg.result : '') || msg.subtype || 'Claude run failed';
      return [{ type: 'error', message: friendlyClaudeError(text) }];
    }
    default:
      return [];
  }
}

/** Per-chat spending cap passed to the SDK as maxBudgetUsd (REVIEW-1 P4). */
export const CLAUDE_SESSION_BUDGET_USD = 5;
/** Agent turns allowed per runtime process (the SDK counts them across the whole streaming session). */
export const CLAUDE_MAX_TURNS = 400;

export function friendlyClaudeError(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('invalid api key') || t.includes('authentication') || t.includes('401') || t.includes('not logged in') || t.includes('/login')) {
    return 'Claude needs an Anthropic API key. Add one in Settings (tray → Settings).';
  }
  if (t.includes('rate limit') || t.includes('429')) return 'Claude is rate-limited right now. Try again in a moment.';
  if (t.includes('overloaded') || t.includes('529')) return 'Claude is overloaded right now. Try again in a moment.';
  return text;
}
