import { describe, expect, it } from 'vitest';
import type { ChatItem, ChatTask } from '@threadgarden/protocol';
import { projectTimeline } from '../../src/chat/timeline.js';

const T = Date.parse('2026-11-20T09:00:00Z');
const user = (id: string, ts = T): ChatItem => ({ kind: 'user', id, ts, text: `Prompt ${id}` });
const agent = (
  id: string,
  extra: Partial<Extract<ChatItem, { kind: 'toolCall' }>> = {},
): ChatItem => ({
  kind: 'toolCall',
  id,
  toolUseId: id,
  name: 'Agent',
  parentToolUseId: null,
  input: { description: `Work ${id}` },
  status: 'ok',
  startedAt: T + 1000,
  endedAt: T + 5000,
  resultText: 'Done',
  ...extra,
});

describe('timeline projection', () => {
  it('keeps repeated Codex exchanges and the live task under one child-agent block', () => {
    const child = '22222222-2222-4222-8222-222222222222';
    const call = (id: string): ChatItem =>
      agent(id, {
        name: 'collabAgentToolCall',
        input: { receiverThreadIds: [child], prompt: 'Review code' },
      });
    const p = projectTimeline(
      [user('u'), call('spawn'), call('send')],
      [
        {
          taskId: `codex-agent-${child}`,
          kind: 'agent',
          description: 'Review code',
          status: 'running',
          startedAt: T + 2000,
        },
      ],
    );
    expect(p.blocks.filter((b) => b.kind === 'agent')).toHaveLength(1);
    expect(p.blocks[0]?.agentCount).toBe(1);
    expect(p.blocks[1]?.status).toBe('running');
  });
  it('reports processed turn tokens, including cached input, and omits unknown usage', () => {
    const p = projectTimeline(
      [
        user('u'),
        {
          kind: 'result',
          id: 'r',
          isError: false,
          usage: { input_tokens: 2000000, cache_read_input_tokens: 2500000, output_tokens: 200000 },
        },
        user('next'),
      ],
      [],
    );
    expect(p.blocks[0]?.tokens).toBe(4700000);
    expect(p.blocks[1]?.tokens).toBeUndefined();
  });

  it('uses the task token count for its agent without adding it to the main turn', () => {
    const p = projectTimeline(
      [user('u'), agent('one')],
      [
        {
          taskId: 'a1',
          toolUseId: 'one',
          kind: 'agent',
          description: 'Work',
          status: 'completed',
          startedAt: T,
          tokens: 4700000,
        },
      ],
    );
    expect(p.blocks[1]?.tokens).toBe(4700000);
    expect(p.blocks[0]?.tokens).toBeUndefined();
  });
  it('summarizes complete turns without putting full messages in the summary', () => {
    const items: ChatItem[] = [
      user('u'),
      { kind: 'assistantText', id: 'a', markdown: 'Done\nwell', streaming: false },
      { kind: 'result', id: 'r', isError: false, ts: T + 10000 },
    ];
    const p = projectTimeline(items, []);
    expect(p.blocks).toMatchObject([
      {
        id: 'turn:u',
        kind: 'turn',
        title: 'Prompt u',
        outcome: 'Done well',
        status: 'completed',
        startedAt: T,
        promptAt: T,
        endedAt: T + 10000,
        toolCount: 0,
        agentCount: 0,
      },
    ]);
    expect(p.items.get('turn:u')).toEqual(items);
  });

  it('keeps unknown times unknown, including zero-valued historical user dates', () => {
    const p = projectTimeline([user('u', 0), { kind: 'result', id: 'r', isError: false }], []);
    expect(p.blocks[0]?.startedAt).toBeUndefined();
    expect(p.blocks[0]?.endedAt).toBeUndefined();
    expect(p.blocks[0]?.status).toBe('completed');
  });

  it('uses a known result duration to recover a missing turn start', () => {
    const p = projectTimeline(
      [user('u', 0), { kind: 'result', id: 'r', isError: false, ts: T + 10000, durationMs: 10000 }],
      [],
    );
    expect(p.blocks[0]).toMatchObject({ startedAt: T, endedAt: T + 10000 });
  });

  it('separates parallel agents and keeps their messages out of the main turn', () => {
    const child: ChatItem = {
      kind: 'assistantText',
      id: 'child',
      markdown: 'Child report',
      streaming: false,
      parentToolUseId: 'one',
    };
    const p = projectTimeline([user('u'), agent('one'), agent('two'), child], []);
    expect(p.blocks.map((b) => b.kind)).toEqual(['turn', 'agent', 'agent']);
    expect(p.blocks[0]).toMatchObject({ toolCount: 2, agentCount: 2, outcome: '' });
    expect(p.items.get('agent:one')).toContain(child);
    expect(p.items.get('turn:u')).not.toContain(child);
  });

  it('does not mistake a background launch for completion, then uses its notification', () => {
    const call = agent('one', { input: { description: 'Build', run_in_background: true } });
    expect(projectTimeline([user('u'), call], []).blocks[1]).toMatchObject({ status: 'unknown' });
    expect(projectTimeline([user('u'), call], []).blocks[1]?.endedAt).toBeUndefined();
    const notice: ChatItem = {
      kind: 'system',
      id: 'n',
      level: 'info',
      text: 'Failed',
      ts: T + 60000,
      detail:
        '<task-notification><task-id>a1</task-id><tool-use-id>one</tool-use-id><status>failed</status><summary>Tests failed</summary></task-notification>',
    };
    const p = projectTimeline([user('u'), call, notice], []);
    expect(p.blocks[1]).toMatchObject({
      status: 'failed',
      endedAt: T + 60000,
      outcome: 'Tests failed',
    });
    expect(p.agents.get('agent:one')).toBe('a1');
  });

  it('merges live task state without duplicating the launch and keeps agents after turn end', () => {
    const task: ChatTask = {
      taskId: 'a1',
      toolUseId: 'one',
      kind: 'agent',
      description: 'Build',
      status: 'running',
      startedAt: T + 1000,
    };
    const p = projectTimeline(
      [user('u'), agent('one'), { kind: 'result', id: 'r', isError: false, ts: T + 2000 }],
      [task],
    );
    expect(p.blocks).toHaveLength(2);
    expect(p.blocks[1]?.status).toBe('running');
    // A stale tool result must not close a currently running background agent.
    expect(p.blocks[1]?.endedAt).toBeUndefined();
  });

  it('only marks an unfinished last turn as live when the service says it is working', () => {
    expect(projectTimeline([user('u')], [], true).blocks[0]?.status).toBe('running');
    expect(projectTimeline([user('u')], []).blocks[0]?.status).toBe('unknown');
  });
});
