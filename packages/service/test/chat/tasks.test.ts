import { describe, expect, it } from 'vitest';
import {
  MAX_TASKS,
  TaskTracker,
  taskKind,
  notificationStatus,
  updatedStatus,
} from '../../src/chat/tasks.js';
import { level, notification, progress, sdk, started, sys, updated } from './live-helpers.js';

const clock = () => {
  const c = { t: 1_000, now: () => c.t };
  return c;
};

describe('task kind and status mapping', () => {
  it('maps the SDK task types to agent, shell or other', () => {
    for (const t of ['local_agent', 'remote_agent', 'in_process_teammate']) {
      expect(taskKind(t, undefined), t).toBe('agent');
    }
    for (const t of ['local_bash', 'monitor_mcp', 'monitor_ws']) {
      expect(taskKind(t, undefined), t).toBe('shell');
    }
    for (const t of ['local_workflow', 'mcp_task', 'dream', 'auto_mode_scan', 'post_turn_memory']) {
      expect(taskKind(t, undefined), t).toBe('other');
    }
    // Any subagent type makes it an agent; unknown future types fall back by name, else other.
    expect(taskKind('local_workflow', 'reviewer')).toBe('agent');
    expect(taskKind(undefined, 'general-purpose')).toBe('agent');
    expect(taskKind('cloud_shell', undefined)).toBe('shell');
    expect(taskKind('remote_monitor', undefined)).toBe('shell');
    expect(taskKind('quantum_thing', undefined)).toBe('other');
    expect(taskKind(undefined, undefined)).toBe('other');
    expect(taskKind(undefined, '')).toBe('other');
  });

  it('maps task_updated and task_notification statuses; unknown values keep the raw one', () => {
    for (const s of ['pending', 'running', 'paused', 'completed', 'failed']) {
      expect(updatedStatus(s)).toEqual({ status: s });
    }
    expect(updatedStatus('killed')).toEqual({ status: 'stopped' });
    expect(updatedStatus('hibernating')).toEqual({ status: 'unknown', rawStatus: 'hibernating' });
    for (const s of ['completed', 'failed', 'stopped']) {
      expect(notificationStatus(s)).toEqual({ status: s });
    }
    expect(notificationStatus('vanished')).toEqual({ status: 'unknown', rawStatus: 'vanished' });
    expect(notificationStatus(42)).toEqual({ status: 'unknown', rawStatus: '42' });
  });
});

describe('TaskTracker', () => {
  it('tracks a subagent from task_started through progress to its notification', () => {
    const c = clock();
    const t = new TaskTracker({ now: c.now });
    expect(
      t.apply(
        started('a1', {
          task_type: 'local_agent',
          subagent_type: 'Explore',
          description: 'Find the config loader',
          tool_use_id: 'toolu_1',
          is_backgrounded: false,
          parent_task_id: 'a0',
          run_id: 'r1',
        }),
      ),
    ).toBe(true);
    expect(t.list()).toEqual([
      {
        taskId: 'a1',
        toolUseId: 'toolu_1',
        kind: 'agent',
        taskType: 'local_agent',
        subagentType: 'Explore',
        description: 'Find the config loader',
        status: 'running',
        backgrounded: false,
        parentTaskId: 'a0',
        startedAt: 1_000,
      },
    ]);

    c.t = 2_000;
    t.apply(
      progress('a1', {
        usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 900 },
        last_tool_name: 'Grep',
        summary: 'Searching for loaders',
      }),
    );
    expect(t.get('a1')).toMatchObject({
      tokens: 1200,
      toolUses: 3,
      durationMs: 900,
      lastTool: 'Grep',
      summary: 'Searching for loaders',
      status: 'running',
      startedAt: 1_000,
    });

    c.t = 3_000;
    t.apply(updated('a1', { status: 'completed', end_time: 99 }));
    t.apply(
      notification('a1', 'completed', {
        summary: 'Found it in src/config.ts',
        usage: { total_tokens: 1500, tool_uses: 4, duration_ms: 1900 },
      }),
    );
    expect(t.get('a1')).toMatchObject({
      status: 'completed',
      endedAt: 3_000,
      summary: 'Found it in src/config.ts',
      tokens: 1500,
      toolUses: 4,
      durationMs: 1900,
    });
  });

  it('maps killed to stopped, records errors and backgrounding, keeps unknown statuses raw', () => {
    const c = clock();
    const t = new TaskTracker({ now: c.now });
    t.apply(started('b1', { task_type: 'local_bash', description: 'npm run dev' }));
    t.apply(updated('b1', { is_backgrounded: true, description: 'npm run dev (port 5173)' }));
    expect(t.get('b1')).toMatchObject({
      kind: 'shell',
      backgrounded: true,
      description: 'npm run dev (port 5173)',
    });
    t.apply(updated('b1', { status: 'paused' }));
    expect(t.get('b1')?.status).toBe('paused');
    t.apply(updated('b1', { status: 'running' }));
    c.t = 5_000;
    t.apply(updated('b1', { status: 'killed', error: 'Killed by user' }));
    expect(t.get('b1')).toMatchObject({
      status: 'stopped',
      endedAt: 5_000,
      error: 'Killed by user',
    });

    t.apply(started('x1', { task_type: 'brand_new_type' }));
    t.apply(updated('x1', { status: 'hibernating' }));
    expect(t.get('x1')).toMatchObject({
      kind: 'other',
      taskType: 'brand_new_type',
      status: 'unknown',
      rawStatus: 'hibernating',
    });
    t.apply(updated('x1', { status: 'running' }));
    expect(t.get('x1')).not.toHaveProperty('rawStatus');
  });

  it('ignores non-task messages, malformed task messages and updates for tasks it never saw', () => {
    const t = new TaskTracker({ now: () => 1 });
    expect(t.apply(sdk({ type: 'assistant', message: {} }))).toBe(false);
    expect(t.apply(sdk({ type: 'system', subtype: 'init' }))).toBe(false);
    expect(t.apply(sys('task_started', { description: 'no id' }))).toBe(false);
    expect(t.apply(updated('ghost', { status: 'completed' }))).toBe(false);
    expect(t.apply(notification('ghost', 'completed'))).toBe(false);
    expect(t.apply(sys('background_tasks_changed', { tasks: 'nope' }))).toBe(false);
    expect(t.list()).toEqual([]);
    // Progress names the task and its description: enough to list it.
    expect(t.apply(progress('p1', { subagent_type: 'general-purpose' }))).toBe(true);
    expect(t.get('p1')).toMatchObject({ kind: 'agent', status: 'running', description: 'task p1' });
  });

  it('never lists ambient (housekeeping) tasks', () => {
    const t = new TaskTracker({ now: () => 1 });
    expect(t.apply(started('d1', { task_type: 'dream', ambient: true }))).toBe(false);
    expect(t.apply(progress('d1'))).toBe(false);
    expect(t.apply(notification('d1', 'completed'))).toBe(false);
    t.apply(
      level([{ task_id: 'w1', task_type: 'monitor_ws', description: 'watch', ambient: true }]),
    );
    expect(t.list()).toEqual([]);
    // A task first seen in the level that later turns out ambient is dropped.
    t.apply(level([{ task_id: 'm1', task_type: 'monitor_mcp', description: 'watch' }]));
    expect(t.list().map((x) => x.taskId)).toEqual(['m1']);
    expect(t.apply(started('m1', { task_type: 'monitor_mcp', ambient: true }))).toBe(true);
    expect(t.list()).toEqual([]);
  });

  describe('background_tasks_changed reconciliation', () => {
    it('lists tasks it has not seen started yet as running background tasks', () => {
      const c = clock();
      const t = new TaskTracker({ now: c.now });
      t.apply(
        level([
          {
            task_id: 'b1',
            task_type: 'local_bash',
            description: 'npm run dev',
            parent_task_id: 'a1',
          },
        ]),
      );
      expect(t.list()).toEqual([
        {
          taskId: 'b1',
          kind: 'shell',
          taskType: 'local_bash',
          description: 'npm run dev',
          status: 'running',
          backgrounded: true,
          parentTaskId: 'a1',
          startedAt: 1_000,
        },
      ]);
      // The task_started that follows fills in the details, keeping the start time.
      c.t = 1_010;
      t.apply(
        started('b1', {
          task_type: 'local_bash',
          description: 'npm run dev',
          tool_use_id: 'toolu_9',
          is_backgrounded: true,
        }),
      );
      expect(t.get('b1')).toMatchObject({ toolUseId: 'toolu_9', startedAt: 1_000 });
    });

    it('a pending task listed in the level is running', () => {
      const t = new TaskTracker({ now: () => 1 });
      t.apply(started('a1', { task_type: 'local_agent' }));
      t.apply(updated('a1', { status: 'pending' }));
      t.apply(level([{ task_id: 'a1', task_type: 'local_agent', description: 'task a1' }]));
      expect(t.get('a1')).toMatchObject({ status: 'running', backgrounded: true });
    });

    it('a listed task that leaves the level without an end edge ends as unknown; a late edge wins', () => {
      const c = clock();
      const t = new TaskTracker({ now: c.now });
      t.apply(started('b1', { task_type: 'local_bash', is_backgrounded: true }));
      t.apply(started('b2', { task_type: 'local_bash', is_backgrounded: true }));
      t.apply(
        level([
          { task_id: 'b1', task_type: 'local_bash', description: 'one' },
          { task_id: 'b2', task_type: 'local_bash', description: 'two' },
        ]),
      );
      c.t = 4_000;
      expect(t.apply(level([{ task_id: 'b2', task_type: 'local_bash', description: 'two' }]))).toBe(
        true,
      );
      expect(t.get('b1')).toMatchObject({ status: 'unknown', endedAt: 4_000 });
      expect(t.get('b1')).not.toHaveProperty('rawStatus');
      expect(t.get('b2')?.status).toBe('running');
      c.t = 4_100;
      t.apply(notification('b1', 'completed', { summary: 'exited 0' }));
      expect(t.get('b1')).toMatchObject({
        status: 'completed',
        summary: 'exited 0',
        endedAt: 4_000,
      });
    });

    it('leaves foreground tasks and tasks never seen in a level alone (older CLIs send no level)', () => {
      const t = new TaskTracker({ now: () => 1 });
      t.apply(started('a1', { task_type: 'local_agent', is_backgrounded: false }));
      t.apply(started('b1', { task_type: 'local_bash', is_backgrounded: true }));
      t.apply(level([]));
      expect(t.get('a1')?.status).toBe('running');
      expect(t.get('b1')?.status).toBe('running');
    });

    it('does not revive a task that already ended', () => {
      const t = new TaskTracker({ now: () => 1 });
      t.apply(started('b1', { task_type: 'local_bash', run_id: 'r1' }));
      t.apply(notification('b1', 'stopped', { run_id: 'r1' }));
      t.apply(level([{ task_id: 'b1', run_id: 'r1', task_type: 'local_bash', description: 'x' }]));
      expect(t.get('b1')?.status).toBe('stopped');
    });
  });

  it('a new run of a task restarts it; frames of an older run are ignored', () => {
    const c = clock();
    const t = new TaskTracker({ now: c.now });
    t.apply(started('a1', { task_type: 'local_agent', run_id: 'r1' }));
    t.apply(
      progress('a1', { run_id: 'r1', usage: { total_tokens: 5, tool_uses: 1, duration_ms: 1 } }),
    );
    t.apply(notification('a1', 'completed', { run_id: 'r1', summary: 'first' }));
    c.t = 9_000;
    t.apply(started('a1', { task_type: 'local_agent', run_id: 'r2', is_backgrounded: true }));
    const again = t.get('a1')!;
    expect(again).toMatchObject({ status: 'running', startedAt: 9_000, backgrounded: true });
    expect(again).not.toHaveProperty('endedAt');
    expect(again).not.toHaveProperty('summary');
    expect(again).not.toHaveProperty('tokens');
    expect(t.apply(notification('a1', 'failed', { run_id: 'r1' }))).toBe(false);
    expect(t.get('a1')?.status).toBe('running');
    expect(t.list()).toHaveLength(1);
  });

  it('a late same-run task_started or a non-terminal task_updated never revives an ended task', () => {
    const c = clock();
    const t = new TaskTracker({ now: c.now });
    t.apply(started('b1', { task_type: 'local_bash', run_id: 'r1', description: 'npm run dev' }));
    c.t = 2_000;
    t.apply(notification('b1', 'stopped', { run_id: 'r1' }));
    const ended = t.get('b1')!;
    expect(ended).toMatchObject({ status: 'stopped', startedAt: 1_000, endedAt: 2_000 });
    c.t = 3_000;
    // A started frame of the same run arriving late (after its end edge).
    t.apply(started('b1', { task_type: 'local_bash', run_id: 'r1' }));
    expect(t.get('b1')).toEqual(ended);
    // A non-terminal update of the same run.
    t.apply(updated('b1', { status: 'running' }, { run_id: 'r1' }));
    expect(t.get('b1')).toEqual(ended);
    // A terminal update of the same run may still correct the end status.
    t.apply(updated('b1', { status: 'failed', error: 'exit 1' }, { run_id: 'r1' }));
    expect(t.get('b1')).toMatchObject({ status: 'failed', error: 'exit 1', endedAt: 2_000 });
  });

  it('a new run id in task_updated restarts an ended task; absent run ids still restart', () => {
    const c = clock();
    const t = new TaskTracker({ now: c.now });
    t.apply(started('a1', { task_type: 'local_agent', run_id: 'r1' }));
    t.apply(progress('a1', { run_id: 'r1', usage: { total_tokens: 5, tool_uses: 1 } }));
    t.apply(notification('a1', 'completed', { run_id: 'r1', summary: 'first' }));
    c.t = 5_000;
    t.apply(updated('a1', { status: 'running' }, { run_id: 'r2' }));
    const again = t.get('a1')!;
    expect(again).toMatchObject({ status: 'running', startedAt: 5_000 });
    expect(again).not.toHaveProperty('endedAt');
    expect(again).not.toHaveProperty('summary');
    expect(again).not.toHaveProperty('tokens');
    // Frames of r1 are now late.
    expect(t.apply(notification('a1', 'failed', { run_id: 'r1' }))).toBe(false);

    // Without run ids (older CLIs) a new start still restarts the row.
    t.apply(started('b1', { task_type: 'local_bash' }));
    t.apply(notification('b1', 'completed'));
    c.t = 6_000;
    t.apply(started('b1', { task_type: 'local_bash' }));
    expect(t.get('b1')).toMatchObject({ status: 'running', startedAt: 6_000 });
    expect(t.get('b1')).not.toHaveProperty('endedAt');
  });

  it(`keeps at most ${MAX_TASKS} tasks, dropping the oldest finished first`, () => {
    const t = new TaskTracker({ now: () => 1 });
    t.apply(started('keep-running', { task_type: 'local_bash' }));
    for (let i = 0; i < MAX_TASKS - 1; i++) {
      t.apply(started(`a${i}`, { task_type: 'local_agent' }));
      t.apply(notification(`a${i}`, 'completed'));
    }
    expect(t.list()).toHaveLength(MAX_TASKS);
    t.apply(started('new', { task_type: 'local_agent' }));
    const ids = t.list().map((x) => x.taskId);
    expect(ids).toHaveLength(MAX_TASKS);
    expect(ids[0]).toBe('keep-running');
    expect(ids).not.toContain('a0');
    expect(ids.at(-1)).toBe('new');
  });

  it('with nothing finished, the bound drops the oldest task', () => {
    const t = new TaskTracker({ now: () => 1, max: 3 });
    for (const id of ['a', 'b', 'c', 'd']) t.apply(started(id));
    expect(t.list().map((x) => x.taskId)).toEqual(['b', 'c', 'd']);
  });

  it('clear forgets every task and reports whether there was any', () => {
    const t = new TaskTracker({ now: () => 1 });
    expect(t.clear()).toBe(false);
    t.apply(started('a'));
    expect(t.clear()).toBe(true);
    expect(t.list()).toEqual([]);
  });

  it('hands out frozen snapshots, shared between lists until the task changes', () => {
    // Every chat.tasks event in the replay log holds a list: unchanged tasks must not be copied.
    const t = new TaskTracker({ now: () => 1 });
    t.apply(started('a'));
    const a = t.list()[0]!;
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => {
      (a as { description: string }).description = 'changed';
    }).toThrow();
    t.apply(started('b'));
    expect(t.list()[0]).toBe(a);
    expect(t.get('a')).toBe(a);
    t.apply(progress('a', { usage: { total_tokens: 9, tool_uses: 1, duration_ms: 1 } }));
    const a2 = t.list()[0]!;
    expect(a2).not.toBe(a);
    expect(a2.tokens).toBe(9);
    expect(a.tokens).toBeUndefined();
    t.apply(level([{ task_id: 'b', task_type: 'local_bash', description: 'task b' }]));
    t.apply(level([]));
    expect(t.list()[0]).toBe(a2);
    expect(t.get('b')).toMatchObject({ status: 'unknown' });
  });
});
