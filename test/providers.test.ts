import { describe, expect, it } from 'vitest';
import { mapClaudeMessage, newClaudeMapState } from '../src/main/providers/claude-events';
import { mapCopilotEvent, toCopilotResult } from '../src/main/providers/copilot';
import { codexServerRequestReply, mapCodexNotification, newCodexMapState } from '../src/main/providers/codex';
import { shortToolName } from '../src/main/providers/types';
import type { ProviderEvent } from '../src/shared/types';

const run = <S>(msgs: any[], map: (m: any, s: S) => ProviderEvent[], st: S) => msgs.flatMap((m) => map(m, st));
const text = (evs: ProviderEvent[]) => evs.filter((e) => e.type === 'text').map((e: any) => e.delta).join('');

describe('shortToolName', () => {
  it('strips backend namespacing', () => {
    expect(shortToolName('mcp__cadabra__click')).toBe('click');
    expect(shortToolName('cadabra-see_screen')).toBe('see_screen');
    expect(shortToolName('cadabra.read_ui')).toBe('read_ui');
    expect(shortToolName('highlight')).toBe('highlight');
  });
});

describe('Claude Code stream-json event mapping', () => {
  // Shapes follow sdk.d.ts (SDKSystemMessage / SDKPartialAssistantMessage / SDKAssistantMessage / SDKUserMessage / SDKResultMessage).
  const fixture = [
    { type: 'system', subtype: 'init', session_id: 'sess-1', tools: ['mcp__cadabra__see_screen'], mcp_servers: [{ name: 'cadabra', status: 'connected' }] },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_1' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'look.' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'mcp__cadabra__see_screen', input: {} } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } } },
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'msg_1', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'tu_1', name: 'mcp__cadabra__see_screen', input: {} }] },
    },
    { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'Screenshot of window' }] }] } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_2' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It is an error dialog.' } } },
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_2', content: [{ type: 'text', text: 'It is an error dialog.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'It is an error dialog.', session_id: 'sess-1', total_cost_usd: 0.0123 },
  ];

  it('streams text deltas once (no duplication from the final assistant message)', () => {
    const evs = run(fixture, mapClaudeMessage, newClaudeMapState());
    expect(text(evs)).toBe('Let me look.\n\nIt is an error dialog.');
  });
  it('reports session, tool start/end and done with cost', () => {
    const evs = run(fixture, mapClaudeMessage, newClaudeMapState());
    expect(evs[0]).toEqual({ type: 'session', sessionId: 'sess-1' });
    const tools = evs.filter((e) => e.type === 'tool') as any[];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ id: 'tu_1', name: 'see_screen', phase: 'start' });
    expect(tools[1]).toMatchObject({ id: 'tu_1', phase: 'end', ok: true, summary: 'Screenshot of window' });
    expect(evs.at(-1)).toEqual({ type: 'done', sessionId: 'sess-1', costUsd: 0.0123 });
  });
  it('falls back to full assistant text when partial messages are absent', () => {
    const evs = run(
      [
        { type: 'assistant', parent_tool_use_id: null, message: { id: 'm', content: [{ type: 'text', text: 'Hello' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: 'Hello', session_id: 's' },
      ],
      mapClaudeMessage,
      newClaudeMapState(),
    );
    expect(text(evs)).toBe('Hello');
  });
  it('ignores subagent traffic', () => {
    const evs = run([{ type: 'stream_event', parent_tool_use_id: 'x', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'nope' } } }], mapClaudeMessage, newClaudeMapState());
    expect(evs).toEqual([]);
  });
  it('maps error results and auth failures to friendly errors', () => {
    const evs = run([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Invalid API key · Please run /login'] }], mapClaudeMessage, newClaudeMapState());
    expect(evs[0].type).toBe('error');
    expect((evs[0] as any).message).toMatch(/API key/);
    const evs2 = run([{ type: 'result', subtype: 'error_max_turns', is_error: true, errors: [] }], mapClaudeMessage, newClaudeMapState());
    expect((evs2[0] as any).message).toMatch(/more steps than I allow/);
  });
  it('marks failed tool results', () => {
    const evs = run(
      [{ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'Needs the user OK' }] } }],
      mapClaudeMessage,
      newClaudeMapState(),
    );
    expect(evs[0]).toMatchObject({ type: 'tool', phase: 'end', ok: false, summary: 'Needs the user OK' });
  });
});

describe('Copilot SDK event mapping', () => {
  const fixture = [
    { type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'Checking' } },
    { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'see_screen' } },
    { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: 'Screenshot attached.' } } },
    { type: 'assistant.message_delta', data: { messageId: 'm2', deltaContent: 'Done.' } },
    { type: 'assistant.message_delta', data: { messageId: 'x', deltaContent: 'sub', parentToolCallId: 'p' } },
    { type: 'session.idle', data: {} },
  ];
  it('maps deltas, tools and idle', () => {
    const evs = run(fixture, mapCopilotEvent, { sawText: false, needsBreak: false });
    expect(text(evs)).toBe('Checking\n\nDone.');
    expect(evs.filter((e) => e.type === 'tool')).toEqual([
      { type: 'tool', id: 'c1', name: 'see_screen', phase: 'start' },
      { type: 'tool', id: 'c1', name: '', phase: 'end', ok: true, summary: 'Screenshot attached.' },
    ]);
    expect(evs.at(-1)).toEqual({ type: 'done' });
  });
  it('maps session errors', () => {
    expect(mapCopilotEvent({ type: 'session.error', data: { errorType: 'auth', message: 'Not authenticated' } }, { sawText: false, needsBreak: false })).toEqual([
      { type: 'error', message: 'Not authenticated' },
    ]);
  });
  it('converts MCP tool results (incl. images) to Copilot tool results', () => {
    const r = toCopilotResult({ content: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }, { type: 'text', text: 'Screenshot 800x600' }] });
    expect(r).toEqual({ textResultForLlm: 'Screenshot 800x600', binaryResultsForLlm: [{ data: 'AAA', mimeType: 'image/png', type: 'image' }], resultType: 'success' });
    expect(toCopilotResult({ content: [{ type: 'text', text: 'nope' }], isError: true }).resultType).toBe('failure');
  });
});

describe('Codex app-server notification mapping', () => {
  const fixture = [
    { method: 'turn/started', params: { threadId: 'th', turn: { id: 'tu1' } } },
    { method: 'item/agentMessage/delta', params: { threadId: 'th', turnId: 'tu1', itemId: 'a1', delta: 'Looking' } },
    { method: 'item/started', params: { threadId: 'th', item: { type: 'mcpToolCall', id: 'i1', server: 'cadabra', tool: 'see_screen', status: 'inProgress' } } },
    { method: 'item/completed', params: { threadId: 'th', item: { type: 'mcpToolCall', id: 'i1', server: 'cadabra', tool: 'see_screen', status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } } } },
    { method: 'item/completed', params: { threadId: 'th', item: { type: 'agentMessage', id: 'a1', text: 'Looking' } } },
    { method: 'item/completed', params: { threadId: 'th', item: { type: 'agentMessage', id: 'a2', text: 'All good.' } } },
    { method: 'item/agentMessage/delta', params: { threadId: 'other', itemId: 'z', delta: 'ignored' } },
    { method: 'turn/completed', params: { threadId: 'th', turn: { id: 'tu1', status: 'completed' } } },
  ];
  it('maps deltas, tool calls, non-streamed messages and completion', () => {
    const st = newCodexMapState();
    st.threadId = 'th';
    const evs = run(fixture, mapCodexNotification, st);
    expect(text(evs)).toBe('Looking\n\nAll good.');
    expect(st.turnId).toBe('tu1');
    expect(evs.filter((e) => e.type === 'tool')).toEqual([
      { type: 'tool', id: 'i1', name: 'see_screen', phase: 'start' },
      { type: 'tool', id: 'i1', name: 'see_screen', phase: 'end', ok: true, summary: 'ok' },
    ]);
    expect(evs.at(-1)).toEqual({ type: 'done', sessionId: 'th' });
  });
  it('maps failed turns and errors', () => {
    const st = newCodexMapState();
    expect(mapCodexNotification({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'usage limit' } } } }, st)).toEqual([
      { type: 'error', message: 'usage limit' },
    ]);
    expect(mapCodexNotification({ method: 'error', params: { error: { message: 'boom' }, willRetry: true } }, st)).toEqual([{ type: 'status', text: 'Retrying…' }]);
  });
  it('declines every command execution / file change approval', () => {
    expect(codexServerRequestReply('item/commandExecution/requestApproval')).toEqual({ decision: 'decline' });
    expect(codexServerRequestReply('item/fileChange/requestApproval')).toEqual({ decision: 'decline' });
    expect(codexServerRequestReply('something/else')).toBeNull();
  });
});
