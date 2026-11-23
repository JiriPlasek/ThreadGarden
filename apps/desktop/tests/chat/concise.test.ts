import { describe, expect, it } from 'vitest';
import type { ChatItem, ChatTask } from '@threadgarden/protocol';
import { buildConciseRows } from '../../src/lib/components/chat/concise';

const user = (id: string, ts: number): ChatItem => ({ kind: 'user', id, ts, text: id });
const call = (
  id: string,
  extra: Partial<Extract<ChatItem, { kind: 'toolCall' }>> = {},
): ChatItem => ({
  kind: 'toolCall',
  id,
  toolUseId: id,
  name: 'Agent',
  input: { description: 'Research' },
  status: 'ok',
  parentToolUseId: null,
  resultText: 'Found it',
  ...extra,
});
const task = (extra: Partial<ChatTask> = {}): ChatTask => ({
  taskId: 'task',
  kind: 'agent',
  description: 'Research',
  status: 'completed',
  startedAt: 10,
  endedAt: 20,
  summary: 'Finished',
  ...extra,
});
const note = (id: string, tool = 'agent'): ChatItem => ({
  kind: 'system',
  id,
  level: 'info',
  text: 'Task finished',
  ts: 20,
  detail: `<task-notification><task-id>task</task-id><tool-use-id>${tool}</tool-use-id><status>completed</status><summary>Done &amp; checked</summary></task-notification>`,
});

describe('buildConciseRows', () => {
  it('shows main conversation, pending actions and warnings; hides unknowns, noise and orphan child output', () => {
    const items: ChatItem[] = [
      user('u', 1),
      { kind: 'thinking', id: 'think', text: 'hmm' },
      call('read', { name: 'Read' }),
      {
        kind: 'assistantText',
        id: 'child',
        parentToolUseId: 'missing',
        markdown: 'child',
        streaming: false,
      },
      { kind: 'assistantText', id: 'reply', markdown: 'answer', streaming: false },
      { kind: 'system', id: 'info', level: 'info', text: 'noise' },
      { kind: 'system', id: 'warning', level: 'warning', text: 'warning' },
      {
        kind: 'permissionRequest',
        id: 'request',
        requestId: 'r',
        toolName: 'Bash',
        input: {},
        suggestions: [],
        state: 'pending',
        variant: 'tool',
      },
      { kind: 'unknown', id: 'unknown', sdkType: 'codex_item', raw: {} },
      { kind: 'unknown', id: 'unknown2', sdkType: 'codex_item', raw: {} },
      { kind: 'unknown', id: 'unknown3', sdkType: 'codex_item', raw: {} },
      { kind: 'result', id: 'result', isError: false },
      { kind: 'compactBoundary', id: 'compact' },
    ];
    expect(buildConciseRows(items, []).map((r) => r.key)).toEqual([
      'u',
      'reply',
      'warning',
      'request',
      'result',
      'compact',
    ]);
  });
  it('does not mistake a background launch for completion and deduplicates completion at its notification position', () => {
    const agent = call('agent', {
      input: { run_in_background: true, description: 'Research' },
      resultText: 'Async agent launched',
    });
    expect(buildConciseRows([user('u', 1), agent], []).map((r) => r.key)).toEqual(['u']);
    const rows = buildConciseRows(
      [user('u', 1), agent, user('next', 15), note('done')],
      [task({ toolUseId: 'agent' })],
    );
    expect(rows.map((r) => r.kind)).toEqual(['item', 'item', 'taskSummary']);
    expect(rows[2]).toMatchObject({
      itemIds: ['agent', 'done'],
      task: { status: 'completed', summary: 'Finished' },
    });
  });
  it('keeps synchronous agent outcomes and terminal shell notifications without their live task metadata', () => {
    const rows = buildConciseRows([user('u', 1), call('agent'), note('shell', 'shell')], []);
    expect(rows.filter((r) => r.kind === 'taskSummary')).toHaveLength(2);
    expect(rows[2]).toMatchObject({ task: { summary: 'Done & checked', status: 'completed' } });
  });
  it('places task-only completions in their loaded turn and omits older unloaded tasks', () => {
    const items: ChatItem[] = [
      user('u', 10),
      { kind: 'result', id: 'r', isError: false, ts: 30 },
      user('next', 40),
    ];
    const rows = buildConciseRows(
      items,
      [task({ taskId: 'old', endedAt: 5 }), task({ taskId: 'loaded', endedAt: 20 })],
      true,
    );
    expect(rows.map((r) => (r.kind === 'taskSummary' ? r.task.id : r.key))).toEqual([
      'u',
      'loaded',
      'r',
      'next',
    ]);
  });
  it('does not expose nested tasks and does not mutate inputs', () => {
    const items = Object.freeze([user('u', 1), call('nested', { parentToolUseId: 'parent' })]);
    expect(buildConciseRows(items, [task({ parentTaskId: 'parent' })])).toHaveLength(1);
  });
});

it('places a synchronous completion at its end time and keeps terminal failures honest', () => {
  const rows = buildConciseRows(
    [
      user('u', 10),
      call('agent', { startedAt: 11, endedAt: 25, status: 'error' }),
      { kind: 'assistantText', id: 'during', markdown: 'Progress', streaming: false },
      { kind: 'result', id: 'result', isError: false, ts: 30 },
    ],
    [],
  );
  expect(rows.map((row) => row.kind)).toEqual(['item', 'item', 'taskSummary', 'item']);
  expect(rows[2]).toMatchObject({ task: { status: 'failed', durationMs: 14 } });
});

it('deduplicates native agent calls by task identity and hides nested task state', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  const rows = buildConciseRows(
    [
      user('u', 1),
      call('native', {
        name: 'collabAgentToolCall',
        input: { receiverThreadIds: [id] },
        resultText: 'launched',
      }),
      { kind: 'result', id: 'r', isError: false, ts: 30 },
    ],
    [
      task({ taskId: `codex-agent-${id}`, status: 'unknown', endedAt: 20 }),
      task({ taskId: 'nested', spawnDepth: 2 }),
    ],
  );
  expect(rows.filter((row) => row.kind === 'taskSummary')).toHaveLength(1);
  expect(rows[1]).toMatchObject({
    kind: 'taskSummary',
    itemIds: ['native'],
    task: { status: 'unknown' },
  });
});

it('hides failed tool calls and does not duplicate task source IDs', () => {
  const rows = buildConciseRows(
    [
      user('u', 1),
      call('broken', { name: 'Bash', status: 'error' }),
      call('read', { name: 'Read', status: 'error' }),
      call('agent'),
      note('done'),
    ],
    [task({ toolUseId: 'agent' })],
  );
  expect(rows.map((row) => row.key)).toEqual(['u', 'task-summary:task']);
  const summaries = rows.filter((row) => row.kind === 'taskSummary');
  expect(summaries).toHaveLength(1);
  expect(summaries[0]?.itemIds).toEqual(['agent', 'done']);
});
