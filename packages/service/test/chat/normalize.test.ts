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
    const hook = sdk({ type: 'system', subtype: 'hook_started', uuid: 'x2', session_id: 's' });
    expect(n.push(hook).items).toEqual([
      { kind: 'unknown', id: 'x2', sdkType: 'system:hook_started', raw: hook },
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

  it('consumes status-only messages without items', () => {
    const n = new Normalizer();
    for (const m of [
      { type: 'system', subtype: 'init', uuid: 'i', session_id: 's', model: 'm' },
      {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'running',
        uuid: 'j',
        session_id: 's',
      },
    ]) {
      expect(n.push(sdk(m))).toEqual({ items: [], replace: false });
    }
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
