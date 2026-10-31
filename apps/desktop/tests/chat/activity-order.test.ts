import type { ChatTask } from '@threadgarden/protocol';
import { describe, expect, it } from 'vitest';
import {
  MAX_NEST_DEPTH,
  compareTasks,
  shortModel,
  taskEndTime,
  taskRows,
} from '../../src/lib/components/chat/activity';

const task = (taskId: string, over: Partial<ChatTask> = {}): ChatTask => ({
  taskId,
  kind: 'agent',
  description: taskId,
  status: 'running',
  startedAt: 0,
  ...over,
});

const ids = (tasks: ChatTask[]): string[] => tasks.map((t) => t.taskId);

describe('Activity panel order (v1.3 §2)', () => {
  it('end time is endedAt, else start plus duration, else start', () => {
    expect(taskEndTime(task('a', { startedAt: 10, endedAt: 50, durationMs: 5 }))).toBe(50);
    expect(taskEndTime(task('a', { startedAt: 10, durationMs: 5 }))).toBe(15);
    expect(taskEndTime(task('a', { startedAt: 10 }))).toBe(10);
  });

  it('lists tasks not ended first, newest start first, then ended ones by end, latest first', () => {
    const tasks = [
      task('done-early', { status: 'completed', startedAt: 1, endedAt: 20 }),
      task('old-running', { status: 'running', startedAt: 5 }),
      // Ended by duration only (an end status without endedAt): 2 + 40 = 42.
      task('done-by-duration', { status: 'failed', startedAt: 2, durationMs: 40 }),
      task('paused', { status: 'paused', startedAt: 30 }),
      task('new-pending', { status: 'pending', startedAt: 40 }),
      // Unknown but with an end time (it left the level): ended at 30.
      task('vanished', { status: 'unknown', startedAt: 3, endedAt: 30 }),
      task('unknown-live', { status: 'unknown', rawStatus: 'odd', startedAt: 10 }),
      task('stopped-no-times', { status: 'stopped', startedAt: 25 }),
    ];
    expect(ids(tasks.slice().sort(compareTasks))).toEqual([
      'new-pending',
      'paused',
      'unknown-live',
      'old-running',
      'done-by-duration',
      'vanished',
      'stopped-no-times',
      'done-early',
    ]);
  });

  it('keeps the given order for ties', () => {
    const tasks = [task('a', { startedAt: 5 }), task('b', { startedAt: 5 })];
    expect(ids(tasks.slice().sort(compareTasks))).toEqual(['a', 'b']);
  });
});

describe('taskRows: nesting by parentTaskId', () => {
  it('puts children right under their parent, sorted among siblings, one indent deeper', () => {
    const rows = taskRows([
      task('root-old', { startedAt: 1 }),
      task('child-done', { parentTaskId: 'root-old', status: 'completed', endedAt: 9 }),
      task('child-new', { parentTaskId: 'root-old', startedAt: 8 }),
      task('grandchild', { parentTaskId: 'child-new', startedAt: 9 }),
      task('root-new', { startedAt: 7 }),
    ]);
    expect(rows.map((r) => [r.task.taskId, r.depth, r.parent?.taskId])).toEqual([
      ['root-new', 0, undefined],
      ['root-old', 0, undefined],
      ['child-new', 1, 'root-old'],
      ['grandchild', 2, 'child-new'],
      ['child-done', 1, 'root-old'],
    ]);
  });

  it('a parent that is not in the list (e.g. another section) leaves the task at the top', () => {
    const rows = taskRows([task('shell', { kind: 'shell', parentTaskId: 'agent-elsewhere' })]);
    expect(rows).toEqual([{ task: expect.objectContaining({ taskId: 'shell' }), depth: 0 }]);
  });

  it(`caps the indent at ${MAX_NEST_DEPTH}`, () => {
    const chain = Array.from({ length: 6 }, (_, i) =>
      task(`t${i}`, i === 0 ? {} : { parentTaskId: `t${i - 1}` }),
    );
    expect(taskRows(chain).map((r) => r.depth)).toEqual([0, 1, 2, 3, 3, 3]);
  });

  it('lists every task once even when parents loop', () => {
    const rows = taskRows([
      task('a', { parentTaskId: 'b', startedAt: 2 }),
      task('b', { parentTaskId: 'a', startedAt: 1 }),
      task('self', { parentTaskId: 'self' }),
    ]);
    expect(rows.map((r) => [r.task.taskId, r.depth])).toEqual([
      ['self', 0],
      ['a', 0],
      ['b', 1],
    ]);
  });
});

describe('shortModel', () => {
  it('drops a leading claude- and keeps aliases and other ids as given', () => {
    expect(shortModel('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5-20250929');
    expect(shortModel('haiku')).toBe('haiku');
    expect(shortModel('us.anthropic.claude-opus-4')).toBe('us.anthropic.claude-opus-4');
  });
});
