import { describe, expect, it } from 'vitest';
import type { ChatItem } from '@pahub/protocol';
import { Normalizer, deriveStatus, type PushResult } from '../../src/chat/normalize.js';
import type { SDKMessage, SessionMessage } from '../../src/sdk/adapter.js';

// Test fixtures are built as plain objects and cast: the SDK types reference the
// Anthropic API types, which the tests deliberately do not need to satisfy in full.
const sdk = (m: Record<string, unknown>): SDKMessage => m as unknown as SDKMessage;

const assistant = (
  uuid: string,
  content: unknown[],
  opts: { msgId?: string; parent?: string | null } = {},
): SDKMessage =>
  sdk({
    type: 'assistant',
    uuid,
    session_id: 's',
    parent_tool_use_id: opts.parent ?? null,
    message: { id: opts.msgId ?? `msg_${uuid}`, role: 'assistant', content },
  });

const user = (uuid: string, content: unknown, parent: string | null = null): SDKMessage =>
  sdk({
    type: 'user',
    uuid,
    session_id: 's',
    parent_tool_use_id: parent,
    message: { role: 'user', content },
  });

const streamEvent = (uuid: string, event: Record<string, unknown>): SDKMessage =>
  sdk({ type: 'stream_event', uuid, session_id: 's', parent_tool_use_id: null, event });

/** Applies push results the way a consumer must: upsert by id when `replace`, else append. */
const apply = (list: ChatItem[], r: PushResult): ChatItem[] => {
  const out = [...list];
  for (const item of r.items) {
    const at = r.replace ? out.findIndex((x) => x.id === item.id) : -1;
    if (at >= 0) out[at] = item;
    else out.push(item);
  }
  return out;
};

const run = (n: Normalizer, msgs: (SDKMessage | SessionMessage)[]): ChatItem[] =>
  msgs.reduce<ChatItem[]>((list, m) => apply(list, n.push(m)), []);

describe('Normalizer', () => {
  it('merges partial stream events into one streaming assistantText then finalises', () => {
    const n = new Normalizer();
    expect(n.push(streamEvent('e1', { type: 'message_start', message: { id: 'msg_1' } }))).toEqual({
      items: [],
      replace: false,
    });
    const start = n.push(
      streamEvent('e2', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    );
    expect(start).toEqual({
      items: [{ kind: 'assistantText', id: 'e2', markdown: '', streaming: true }],
      replace: false,
    });
    n.push(
      streamEvent('e3', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hel' },
      }),
    );
    const delta = n.push(
      streamEvent('e4', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'lo' },
      }),
    );
    expect(delta).toEqual({
      items: [{ kind: 'assistantText', id: 'e2', markdown: 'Hello', streaming: true }],
      replace: true,
    });
    expect(n.push(streamEvent('e5', { type: 'content_block_stop', index: 0 })).items).toEqual([]);

    const final = n.push(assistant('a1', [{ type: 'text', text: 'Hello' }], { msgId: 'msg_1' }));
    expect(final).toEqual({
      items: [{ kind: 'assistantText', id: 'e2', markdown: 'Hello', streaming: false }],
      replace: true,
    });
  });

  it('correlates later streamed blocks of the same API message by block index', () => {
    const n = new Normalizer();
    const items = run(n, [
      streamEvent('e1', { type: 'message_start', message: { id: 'msg_1' } }),
      streamEvent('e2', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
      }),
      streamEvent('e3', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":' },
      }),
      streamEvent('e4', { type: 'content_block_stop', index: 0 }),
      assistant(
        'a1',
        [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
        {
          msgId: 'msg_1',
        },
      ),
      streamEvent('e5', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }),
      streamEvent('e6', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Done' },
      }),
      streamEvent('e7', { type: 'content_block_stop', index: 1 }),
      assistant('a2', [{ type: 'text', text: 'Done' }], { msgId: 'msg_1' }),
      streamEvent('e8', { type: 'message_stop' }),
    ]);
    expect(items).toEqual([
      {
        kind: 'toolCall',
        id: 'a1',
        toolUseId: 'toolu_1',
        name: 'Bash',
        input: { command: 'ls' },
        status: 'running',
        parentToolUseId: null,
      },
      { kind: 'assistantText', id: 'e5', markdown: 'Done', streaming: false },
    ]);
  });

  it('uses <uuid> for single-block and <uuid>:<index> for multi-block messages', () => {
    const n = new Normalizer();
    expect(n.push(assistant('a1', [{ type: 'text', text: 'one' }])).items).toEqual([
      { kind: 'assistantText', id: 'a1', markdown: 'one', streaming: false },
    ]);
    expect(
      n.push(
        assistant('a2', [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'text', text: 'two' },
        ]),
      ),
    ).toEqual({
      items: [
        { kind: 'thinking', id: 'a2:0', text: 'hmm' },
        { kind: 'assistantText', id: 'a2:1', markdown: 'two', streaming: false },
      ],
      replace: false,
    });
  });

  it('pairs tool_use with tool_result and truncates result over 20000 chars', () => {
    const n = new Normalizer();
    n.push(
      assistant('a1', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ]),
    );
    const long = 'x'.repeat(20_001);
    const r = n.push(
      user('u1', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: long, is_error: false }]),
    );
    expect(r.replace).toBe(true);
    expect(r.items).toEqual([
      {
        kind: 'toolCall',
        id: 'a1',
        toolUseId: 'toolu_1',
        name: 'Bash',
        input: { command: 'ls' },
        status: 'ok',
        resultText: 'x'.repeat(20_000),
        resultTruncated: true,
        parentToolUseId: null,
      },
    ]);

    n.push(assistant('a2', [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} }]));
    const err = n.push(
      user('u2', [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          content: [{ type: 'text', text: 'boom' }],
          is_error: true,
        },
      ]),
    );
    expect(err.items).toEqual([
      expect.objectContaining({
        id: 'a2',
        status: 'error',
        resultText: 'boom',
        resultTruncated: false,
      }),
    ]);
  });

  it('renders TodoWrite as todo', () => {
    const n = new Normalizer();
    const r = n.push(
      assistant('a1', [
        {
          type: 'tool_use',
          id: 'toolu_t',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Write tests', status: 'completed', activeForm: 'Writing tests' },
              { content: 'Implement', status: 'in_progress', activeForm: 'Implementing' },
            ],
          },
        },
      ]),
    );
    expect(r).toEqual({
      items: [
        {
          kind: 'todo',
          id: 'a1',
          todos: [
            { content: 'Write tests', status: 'completed' },
            { content: 'Implement', status: 'in_progress' },
          ],
        },
      ],
      replace: false,
    });
    // Its tool_result is absorbed by the todo item, not surfaced as an orphan.
    expect(
      n.push(user('u1', [{ type: 'tool_result', tool_use_id: 'toolu_t', content: 'ok' }])).items,
    ).toEqual([]);
  });

  it('keeps parentToolUseId for subagent messages', () => {
    const n = new Normalizer();
    const items = run(n, [
      assistant('a1', [{ type: 'text', text: 'sub says' }], { parent: 'toolu_agent' }),
      assistant('a2', [{ type: 'tool_use', id: 'toolu_s', name: 'Grep', input: {} }], {
        parent: 'toolu_agent',
      }),
      user('u1', [{ type: 'tool_result', tool_use_id: 'toolu_s', content: 'hit' }], 'toolu_agent'),
    ]);
    expect(items).toEqual([
      {
        kind: 'assistantText',
        id: 'a1',
        markdown: 'sub says',
        streaming: false,
        parentToolUseId: 'toolu_agent',
      },
      expect.objectContaining({
        kind: 'toolCall',
        id: 'a2',
        status: 'ok',
        resultText: 'hit',
        parentToolUseId: 'toolu_agent',
      }),
    ]);
  });

  it('maps unknown message type to unknown item with raw', () => {
    const n = new Normalizer();
    const future = sdk({ type: 'holo_future', uuid: 'x1', session_id: 's', payload: { a: 1 } });
    expect(n.push(future)).toEqual({
      items: [{ kind: 'unknown', id: 'x1', sdkType: 'holo_future', raw: future }],
      replace: false,
    });
    const sys = sdk({ type: 'system', subtype: 'hologram_sync', uuid: 'x2', session_id: 's' });
    expect(n.push(sys).items).toEqual([
      { kind: 'unknown', id: 'x2', sdkType: 'system:hologram_sync', raw: sys },
    ]);
    // A known type with a malformed shape is unknown too.
    const noSubtype = sdk({ type: 'system', uuid: 'x3', session_id: 's' });
    expect(n.push(noSubtype).items).toEqual([
      { kind: 'unknown', id: 'x3', sdkType: 'system', raw: noSubtype },
    ]);
    // No uuid: still an item, with a unique local id.
    const a = n.push(sdk({ type: 'mystery' })).items[0];
    const b = n.push(sdk({ type: 'mystery' })).items[0];
    expect(a?.kind).toBe('unknown');
    expect(a?.id).not.toBe(b?.id);
  });

  it('maps unknown content block to unknown item', () => {
    const n = new Normalizer();
    const block = { type: 'hologram', beam: 42 };
    expect(n.push(assistant('a1', [{ type: 'text', text: 'hi' }, block])).items).toEqual([
      { kind: 'assistantText', id: 'a1:0', markdown: 'hi', streaming: false },
      { kind: 'unknown', id: 'a1:1', sdkType: 'block:hologram', raw: block },
    ]);
    const userBlock = { type: 'video', src: 'x' };
    expect(n.push(user('u1', [userBlock])).items).toEqual([
      { kind: 'unknown', id: 'u1', sdkType: 'block:video', raw: userBlock },
    ]);
  });

  it('never throws on malformed input', () => {
    const n = new Normalizer();
    const bad = [null, 42, 'str', {}, { type: 'assistant' }, { type: 'user', message: null }];
    for (const m of bad) {
      const r = n.push(m as unknown as SDKMessage);
      expect(r.items.length).toBeGreaterThan(0);
      expect(r.items.every((i) => i.kind === 'unknown')).toBe(true);
    }
  });

  it('maps known system and result messages', () => {
    const n = new Normalizer();
    expect(
      n.push(
        sdk({
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'c1',
          session_id: 's',
          compact_metadata: { trigger: 'auto', pre_tokens: 1 },
        }),
      ).items,
    ).toEqual([{ kind: 'compactBoundary', id: 'c1' }]);
    const usage = { input_tokens: 1, output_tokens: 2 };
    expect(
      n.push(
        sdk({
          type: 'result',
          subtype: 'success',
          uuid: 'r1',
          session_id: 's',
          is_error: false,
          duration_ms: 1234,
          total_cost_usd: 0.05,
          usage,
        }),
      ).items,
    ).toEqual([
      { kind: 'result', id: 'r1', isError: false, durationMs: 1234, costUsd: 0.05, usage },
    ]);
    expect(
      n.push(
        sdk({
          type: 'system',
          subtype: 'api_retry',
          uuid: 'y1',
          session_id: 's',
          attempt: 2,
          max_retries: 10,
          retry_delay_ms: 3000,
          error_status: 529,
          error: 'overloaded',
        }),
      ).items,
    ).toEqual([
      {
        kind: 'system',
        id: 'y1',
        level: 'warning',
        text: 'API error (529), retrying in 3 s (attempt 2 of 10)',
      },
    ]);
    expect(
      n.push(
        sdk({
          type: 'system',
          subtype: 'informational',
          uuid: 'i1',
          session_id: 's',
          content: 'Stop hook blocked',
          level: 'warning',
        }),
      ).items,
    ).toEqual([{ kind: 'system', id: 'i1', level: 'warning', text: 'Stop hook blocked' }]);
    expect(
      n.push(
        sdk({
          type: 'system',
          subtype: 'notification',
          uuid: 'n1',
          session_id: 's',
          key: 'k',
          text: 'Heads up',
          priority: 'low',
        }),
      ).items,
    ).toEqual([{ kind: 'system', id: 'n1', level: 'info', text: 'Heads up' }]);
  });

  it('produces no items for every non-visual SDK 0.3.314 message type', () => {
    const n = new Normalizer();
    const topLevel = [
      'tool_progress',
      'rate_limit_event',
      'tool_use_summary',
      'prompt_suggestion',
      'auth_status',
      // Not in the SDK's SDKMessage union, but CLI 2.1.314 emits ~3 per turn (Ruling R9).
      'command_lifecycle',
    ];
    const systemSubtypes = [
      'init',
      'session_state_changed',
      'commands_changed',
      'status',
      'thinking_tokens',
      'hook_started',
      'hook_progress',
      'task_started',
      'task_updated',
      'task_progress',
      'background_tasks_changed',
      'control_request_progress',
      'files_persisted',
      'memory_recall',
      'worker_shutting_down',
      'plugin_install',
      'elicitation_complete',
    ];
    const samples = [
      ...topLevel.map((type, i) => ({ type, uuid: `t${i}`, session_id: 's' })),
      ...systemSubtypes.map((subtype, i) => ({
        type: 'system',
        subtype,
        uuid: `s${i}`,
        session_id: 's',
      })),
      // Content-bearing types whose instance has nothing user-visible.
      {
        type: 'system',
        subtype: 'hook_response',
        hook_name: 'fmt',
        hook_event: 'PostToolUse',
        output: '',
        stdout: '',
        stderr: '',
        outcome: 'success',
        uuid: 'h1',
        session_id: 's',
      },
      // A successful hook never renders, even with output (Ruling R10): SessionStart
      // hooks routinely print whole context documents.
      {
        type: 'system',
        subtype: 'hook_response',
        hook_name: 'SessionStart:startup',
        hook_event: 'SessionStart',
        output: '{"hookSpecificOutput":{"additionalContext":"a very long document"}}',
        stdout: '{"hookSpecificOutput":{"additionalContext":"a very long document"}}',
        stderr: '',
        exit_code: 0,
        outcome: 'success',
        uuid: 'h2',
        session_id: 's',
      },
      {
        type: 'system',
        subtype: 'hook_response',
        hook_name: 'slow',
        hook_event: 'PreToolUse',
        output: 'partial',
        stdout: 'partial',
        stderr: '',
        outcome: 'cancelled',
        uuid: 'h3',
        session_id: 's',
      },
      {
        type: 'system',
        subtype: 'task_notification',
        status: 'completed',
        summary: 'watcher',
        skip_transcript: true,
        uuid: 'tn',
        session_id: 's',
      },
    ];
    for (const m of samples) {
      expect(n.push(sdk(m)), JSON.stringify(m)).toEqual({ items: [], replace: false });
    }
  });

  it('maps content-bearing system messages to readable system items', () => {
    const n = new Normalizer();
    const sys = (subtype: string, fields: Record<string, unknown>, uuid = subtype) =>
      n.push(sdk({ type: 'system', subtype, uuid, session_id: 's', ...fields })).items;
    expect(sys('local_command_output', { content: 'Total cost: $0.12' })).toEqual([
      { kind: 'system', id: 'local_command_output', level: 'info', text: 'Total cost: $0.12' },
    ]);
    expect(
      sys('permission_denied', {
        tool_name: 'Bash',
        tool_use_id: 't',
        message: 'Denied by rule',
        decision_reason: 'deny rule Bash(rm:*)',
      }),
    ).toEqual([
      {
        kind: 'system',
        id: 'permission_denied',
        level: 'warning',
        text: 'Permission denied: Bash — Denied by rule (deny rule Bash(rm:*))',
      },
    ]);
    expect(sys('task_notification', { status: 'failed', summary: 'Tests broke' }, 'tn1')).toEqual([
      { kind: 'system', id: 'tn1', level: 'error', text: 'Task failed: Tests broke' },
    ]);
    expect(sys('task_notification', { status: 'completed', summary: 'Indexed' }, 'tn2')).toEqual([
      { kind: 'system', id: 'tn2', level: 'info', text: 'Task completed: Indexed' },
    ]);
    expect(sys('task_notification', { status: 'stopped', summary: '' }, 'tn3')).toEqual([
      { kind: 'system', id: 'tn3', level: 'warning', text: 'Task stopped' },
    ]);
    expect(
      sys(
        'hook_response',
        { hook_name: 'lint', output: '', stderr: 'eslint exploded', outcome: 'error' },
        'hr1',
      ),
    ).toEqual([
      { kind: 'system', id: 'hr1', level: 'warning', text: 'Hook lint failed: eslint exploded' },
    ]);
    expect(
      sys('hook_response', { hook_name: 'greet', output: 'Hello', outcome: 'success' }, 'hr2'),
    ).toEqual([]);
    expect(
      sys(
        'hook_response',
        {
          hook_name: 'fmt',
          output: '',
          stderr: 'prettier: bad syntax',
          exit_code: 2,
          outcome: 'error',
        },
        'hr3',
      ),
    ).toEqual([
      {
        kind: 'system',
        id: 'hr3',
        level: 'warning',
        text: 'Hook fmt failed (exit code 2): prettier: bad syntax',
      },
    ]);
    expect(
      sys(
        'hook_response',
        { hook_name: 'gate', output: '', stderr: '', exit_code: 1, outcome: 'error' },
        'hr4',
      ),
    ).toEqual([
      { kind: 'system', id: 'hr4', level: 'warning', text: 'Hook gate failed (exit code 1)' },
    ]);
    const [long] = sys(
      'hook_response',
      { hook_name: 'big', output: '', stderr: `${'x'.repeat(5_000)}TAIL`, outcome: 'error' },
      'hr5',
    );
    expect(long).toMatchObject({ kind: 'system', level: 'warning' });
    const longText = (long as { text: string }).text;
    expect(longText.length).toBeLessThan(1_100);
    expect(longText).toMatch(/^Hook big failed: x+…$/);
    // An outcome this Threadgarden does not know stays visible as raw JSON.
    expect(sys('hook_response', { hook_name: 'h', outcome: 'timed_out' }, 'hr6')).toEqual([
      expect.objectContaining({ kind: 'unknown', id: 'hr6', sdkType: 'system:hook_response' }),
    ]);
    expect(sys('model_refusal_fallback', { content: 'Retried on Sonnet' }, 'mf')).toEqual([
      { kind: 'system', id: 'mf', level: 'warning', text: 'Retried on Sonnet' },
    ]);
    expect(sys('model_refusal_no_fallback', { content: 'Refused' }, 'mn')).toEqual([
      { kind: 'system', id: 'mn', level: 'error', text: 'Refused' },
    ]);
    expect(sys('mirror_error', { error: 'disk full' }, 'me')).toEqual([
      { kind: 'system', id: 'me', level: 'warning', text: 'Transcript mirror error: disk full' },
    ]);
  });

  it('maps conversation_reset to a system item and resets tool and stream state', () => {
    const n = new Normalizer();
    n.push(assistant('a1', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }]));
    n.push(streamEvent('e1', { type: 'message_start', message: { id: 'msg_1' } }));
    n.push(
      streamEvent('e2', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'par' },
      }),
    );
    const reset = sdk({
      type: 'conversation_reset',
      uuid: 'cr',
      session_id: 's',
      trigger: 'clear',
    });
    expect(n.push(reset)).toEqual({
      items: [
        { kind: 'assistantText', id: 'e2', markdown: 'par', streaming: false },
        { kind: 'system', id: 'cr', level: 'info', text: 'Conversation cleared' },
      ],
      replace: true,
    });
    // The old tool call is forgotten: a late result for it is an orphan.
    expect(
      n.push(user('u1', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }])).items,
    ).toEqual([expect.objectContaining({ kind: 'unknown', sdkType: 'block:tool_result' })]);
  });

  it('closes a stream without a final message on the next message_start (API retry)', () => {
    const n = new Normalizer();
    const items = run(n, [
      streamEvent('e1', { type: 'message_start', message: { id: 'msg_1' } }),
      streamEvent('e2', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      streamEvent('e3', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hel' },
      }),
      // Retry: a new API message starts; msg_1 never got its final assistant message.
      streamEvent('e4', { type: 'message_start', message: { id: 'msg_2' } }),
      streamEvent('e5', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      streamEvent('e6', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      }),
      assistant('a1', [{ type: 'text', text: 'Hello' }], { msgId: 'msg_2' }),
    ]);
    expect(items).toEqual([
      { kind: 'assistantText', id: 'e2', markdown: 'Hel', streaming: false },
      { kind: 'assistantText', id: 'e5', markdown: 'Hello', streaming: false },
    ]);
  });

  it('result closes open streams', () => {
    const n = new Normalizer();
    n.push(streamEvent('e1', { type: 'message_start', message: { id: 'msg_1' } }));
    n.push(
      streamEvent('e2', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'cut' },
      }),
    );
    const result = sdk({ type: 'result', subtype: 'error_during_execution', uuid: 'r1' });
    expect(n.push(result)).toEqual({
      items: [
        { kind: 'assistantText', id: 'e2', markdown: 'cut', streaming: false },
        { kind: 'result', id: 'r1', isError: true },
      ],
      replace: true,
    });
  });

  it('resolveItemId maps SDK uuids to the item ids rendering them', () => {
    const n = new Normalizer();
    run(n, [
      streamEvent('e1', { type: 'message_start', message: { id: 'msg_1' } }),
      streamEvent('e2', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      assistant('a1', [{ type: 'text', text: 'Hi' }], { msgId: 'msg_1' }),
      assistant('a2', [{ type: 'text', text: 'plain' }]),
      assistant('a3', [
        { type: 'thinking', thinking: 't', signature: 's' },
        { type: 'text', text: 'x' },
      ]),
    ]);
    expect(n.resolveItemId('a1')).toBe('e2');
    expect(n.resolveItemId('a2')).toBe('a2');
    expect(n.resolveItemId('a3')).toBe('a3:0');
    expect(n.resolveItemId('a3:1')).toBe('a3:1');
    expect(n.resolveItemId('never')).toBeUndefined();
  });

  it('messageUuidOf maps an item id back to the SDK message uuid (for fork)', () => {
    const n = new Normalizer();
    run(n, [
      streamEvent('e1', { type: 'message_start', message: { id: 'msg_1' } }),
      streamEvent('e2', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      assistant('a1', [{ type: 'text', text: 'Hi' }], { msgId: 'msg_1' }),
      assistant('a3', [
        { type: 'thinking', thinking: 't', signature: 's' },
        { type: 'text', text: 'x' },
      ]),
    ]);
    expect(n.messageUuidOf('e2')).toBe('a1'); // streamed item → its final message
    expect(n.messageUuidOf('a3:1')).toBe('a3');
    expect(n.messageUuidOf('u9')).toBe('u9'); // never seen: the id is the uuid
  });

  it('maps user prompts with text and images to one user item', () => {
    const n = new Normalizer({ now: () => 777 });
    expect(n.push(user('u1', 'plain prompt')).items).toEqual([
      { kind: 'user', id: 'u1', text: 'plain prompt', ts: 777 },
    ]);
    const withTs = sdk({
      type: 'user',
      uuid: 'u2',
      session_id: 's',
      parent_tool_use_id: null,
      timestamp: '2026-10-30T10:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
        ],
      },
    });
    expect(n.push(withTs).items).toEqual([
      {
        kind: 'user',
        id: 'u2',
        text: 'look',
        images: [{ mediaType: 'image/png', data: 'AA==' }],
        ts: Date.parse('2026-10-30T10:00:00.000Z'),
      },
    ]);
  });

  it('normalizes SessionMessage history equivalently to live messages', () => {
    const live: SDKMessage[] = [
      user('u1', 'list files'),
      assistant('a1', [
        { type: 'thinking', thinking: 'plan', signature: 's' },
        { type: 'text', text: 'Sure' },
      ]),
      assistant('a2', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ]),
      user('u2', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' }]),
      assistant('a3', [{ type: 'text', text: 'One file.' }]),
    ];
    const history: SessionMessage[] = live.map((m) => {
      const x = m as unknown as {
        type: 'user' | 'assistant';
        uuid: string;
        message: unknown;
        parent_tool_use_id: string | null;
      };
      return {
        type: x.type,
        uuid: x.uuid,
        session_id: 's',
        message: x.message,
        parent_tool_use_id: x.parent_tool_use_id,
        parent_agent_id: null,
      };
    });
    const now = () => 1;
    const fromLive = run(new Normalizer({ now }), live);
    const fromHistory = run(new Normalizer({ now }), history);
    expect(fromHistory).toEqual(fromLive);
    expect(fromLive.map((i) => i.kind)).toEqual([
      'user',
      'thinking',
      'assistantText',
      'toolCall',
      'assistantText',
    ]);
  });
});

describe('deriveStatus', () => {
  const state = (s: string) =>
    sdk({ type: 'system', subtype: 'session_state_changed', state: s, uuid: 'x', session_id: 's' });

  it('deriveStatus maps session_state_changed values', () => {
    expect(deriveStatus(state('running'), 'idle')).toBe('working');
    expect(deriveStatus(state('idle'), 'working')).toBe('idle');
    expect(deriveStatus(state('requires_action'), 'working')).toBe('needsYou');
    expect(deriveStatus(state('teleporting'), 'working')).toBe('unknown');
  });

  it('maps result to idle and leaves other messages alone', () => {
    expect(deriveStatus(sdk({ type: 'result', subtype: 'success', uuid: 'r' }), 'working')).toBe(
      'idle',
    );
    expect(deriveStatus(assistant('a', [{ type: 'text', text: 'x' }]), 'working')).toBe('working');
  });
});

// Shapes observed from Claude Code 2.1.314 (live stream and getSessionMessages history).
describe('Normalizer: user messages the CLI writes itself', () => {
  const special = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) =>
    sdk({ ...(user(uuid, content) as unknown as Record<string, unknown>), ...extra });
  const boundary = (uuid: string) =>
    sdk({ type: 'system', subtype: 'compact_boundary', uuid, session_id: 's' });
  const summary = 'This session is being continued from a previous conversation…';

  it('shows a live compaction as one boundary, without the summary message', () => {
    const items = run(new Normalizer(), [
      boundary('b1'),
      special('s1', summary, { isSynthetic: true, isReplay: false }),
      special('o1', '<local-command-stdout>Compacted </local-command-stdout>', { isReplay: true }),
      sdk({ type: 'result', subtype: 'success', uuid: 'r1', session_id: 's' }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['compactBoundary', 'system', 'result']);
    expect(items[1]).toEqual({ kind: 'system', id: 'o1', level: 'info', text: 'Compacted' });
  });

  it('turns a history compaction summary (no boundary message) into the boundary', () => {
    const items = run(new Normalizer(), [
      special('s1', summary, { isCompactSummary: true, is_meta: true }),
    ]);
    expect(items).toEqual([{ kind: 'compactBoundary', id: 's1' }]);
  });

  it('keeps synthetic user messages that do not follow a boundary', () => {
    const items = run(new Normalizer(), [special('x1', 'injected', { isSynthetic: true })]);
    expect(items).toMatchObject([{ kind: 'user', id: 'x1', text: 'injected' }]);
  });

  it('renders slash command entries as the command the user typed', () => {
    const items = run(new Normalizer(), [
      special(
        'c1',
        '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>',
        { isCompletedLocalCommand: true },
      ),
      special('c2', [
        {
          type: 'text',
          text: '<command-message>work</command-message>\n<command-name>/work</command-name>\n<command-args>fix the build</command-args>',
        },
      ]),
      special('c3', '<command-name>model</command-name><command-args>opus</command-args>'),
    ]);
    expect(items.map((i) => (i.kind === 'user' ? [i.id, i.text] : i.kind))).toEqual([
      ['c1', '/compact'],
      ['c2', '/work fix the build'],
      ['c3', '/model opus'],
    ]);
  });

  it('renders shell input and command output like the terminal', () => {
    const items = run(new Normalizer(), [
      special('i1', '<bash-input>git status</bash-input>'),
      special(
        'o1',
        '<bash-stdout>\u001b[32mclean\u001b[0m</bash-stdout><bash-stderr></bash-stderr>',
      ),
      special('o2', '<bash-stdout></bash-stdout><bash-stderr>fatal: no repo</bash-stderr>'),
      special('o3', '<local-command-stdout></local-command-stdout>'),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ kind: 'user', id: 'i1', text: '! git status' }),
      { kind: 'system', id: 'o1', level: 'info', text: 'clean' },
      { kind: 'system', id: 'o2', level: 'warning', text: 'fatal: no repo' },
    ]);
  });

  it('leaves ordinary text that merely contains such tags alone', () => {
    const text = 'Why does <local-command-stdout>x</local-command-stdout> show up?';
    const items = run(new Normalizer(), [special('u1', text)]);
    expect(items).toMatchObject([{ kind: 'user', id: 'u1', text }]);
  });

  // Ruling R27. The envelopes below have the shape Claude Code 2.1.x records in
  // history (tag names as listed in SDK 0.3.314; contents shortened).
  const taskNotification = [
    '<task-notification>',
    '<task-id>bx7k2m9qa</task-id>',
    '<tool-use-id>toolu_01AbCdEfGh</tool-use-id>',
    '<output-file>/tmp/claude/tasks/bx7k2m9qa.output</output-file>',
    '<status>completed</status>',
    '<summary>Background command "Run the test suite" completed (exit code 0)</summary>',
    '</task-notification>',
  ].join('\n');
  const handBack = [
    '<agent-message from="a1000e95cdfadce59">',
    '[Subagent hand-back] The text below is the final report of a subagent this session delegated to.',
    '',
    'All 12 tests pass; the fix is in src/parser.ts.',
    '</agent-message>',
  ].join('\n');

  it('renders a background-task notification as a collapsed system item (R27)', () => {
    const items = run(new Normalizer(), [special('t1', taskNotification)]);
    expect(items).toEqual([
      {
        kind: 'system',
        id: 't1',
        level: 'info',
        text: 'Background command "Run the test suite" completed (exit code 0)',
        detail: taskNotification,
      },
    ]);
  });

  it('decodes the XML entities some CLI versions put in the summary', () => {
    const text =
      '<task-notification>\n<status>completed</status>\n<summary>Background command &quot;cd x &amp;&amp; make &gt; log&quot; completed</summary>\n</task-notification>';
    const [item] = run(new Normalizer(), [special('t3', text)]);
    expect(item).toMatchObject({
      kind: 'system',
      text: 'Background command "cd x && make > log" completed',
    });
  });

  it('labels a notification without a summary by its status', () => {
    const text =
      '<task-notification>\n<task-id>b1</task-id>\n<status>killed</status>\n</task-notification>';
    const [item] = run(new Normalizer(), [special('t2', [{ type: 'text', text }])]);
    expect(item).toMatchObject({ kind: 'system', text: 'Background task killed', detail: text });
  });

  it('renders a subagent hand-back as a collapsed system item (R27)', () => {
    const items = run(new Normalizer(), [special('h1', handBack, { isMeta: true })]);
    expect(items).toEqual([
      {
        kind: 'system',
        id: 'h1',
        level: 'info',
        text: 'Report from a subagent',
        detail: [
          '[Subagent hand-back] The text below is the final report of a subagent this session delegated to.',
          '',
          'All 12 tests pass; the fix is in src/parser.ts.',
        ].join('\n'),
      },
    ]);
  });

  it('labels the other injected envelopes of the closed list', () => {
    const items = run(new Normalizer(), [
      special('m1', '<teammate-message teammate_id="ops">deploy done</teammate-message>'),
      special('m2', '<cross-session-message>from the other chat</cross-session-message>'),
      special('m3', '<coordinator-relay>status?</coordinator-relay>'),
    ]);
    expect(items.map((i) => (i.kind === 'system' ? [i.text, i.detail] : i.kind))).toEqual([
      ['Message from a teammate', 'deploy done'],
      ['Message from another session', 'from the other chat'],
      ['Message relayed by the coordinator', 'status?'],
    ]);
  });

  it('hides the local-command caveat, as the terminal does', () => {
    const caveat =
      '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>';
    expect(run(new Normalizer(), [special('c1', caveat, { isMeta: true })])).toEqual([]);
  });

  it('keeps user text that only starts with such a tag, and unknown tags, as typed', () => {
    const texts = [
      `${taskNotification}\nand what does this mean?`,
      '<agent-message from="x">unterminated',
      '<my-own-tag>hello</my-own-tag>',
      'see <task-notification>x</task-notification>',
    ];
    const items = run(
      new Normalizer(),
      texts.map((t, i) => special(`u${i}`, t)),
    );
    expect(items.map((i) => (i.kind === 'user' ? i.text : i.kind))).toEqual(texts);
  });
});
