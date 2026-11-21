import { describe, expect, it, vi } from 'vitest';
import { CodexTasks } from '../../src/sdk/codex-tasks.js';
import type { CodexConnection } from '../../src/sdk/codex-client.js';

describe('Codex background work', () => {
  it('reconciles native terminals and child agents, and only stops owned task ids', async () => {
    let terminals = [{ processId: 'shell-1', command: 'pnpm dev' }];
    let agents = [{ id: 'child-1', status: { type: 'active' }, agentNickname: 'Explorer' }];
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: terminals };
      if (method === 'thread/list') return { data: agents };
      if (method === 'thread/turns/list')
        return { data: [{ id: 'turn-child', status: 'inProgress' }] };
      if (method === 'thread/backgroundTerminals/terminate') terminals = [];
      if (method === 'turn/interrupt') agents = [];
      return {};
    });
    const events: Record<string, unknown>[] = [];
    const tasks = new CodexTasks(
      { request } as unknown as CodexConnection,
      () => 'root',
      (message) => events.push(message),
    );
    await tasks.refresh();
    expect(events.at(-1)).toMatchObject({
      subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 'codex-shell-shell-1', task_type: 'local_bash', description: 'pnpm dev' },
        { task_id: 'codex-agent-child-1', task_type: 'local_agent', description: 'Explorer' },
      ],
    });
    await expect(tasks.stop('some-other-process')).rejects.toThrow('no longer running');
    await tasks.stop('codex-shell-shell-1');
    expect(request).toHaveBeenCalledWith('thread/backgroundTerminals/terminate', {
      threadId: 'root',
      processId: 'shell-1',
    });
    await tasks.stop('codex-agent-child-1');
    expect(request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'child-1',
      turnId: 'turn-child',
    });
    expect(events.at(-1)).toMatchObject({ tasks: [] });
    tasks.close();
    const count = request.mock.calls.length;
    await tasks.refresh();
    expect(request.mock.calls).toHaveLength(count);
  });

  it('retains known running work when a poll fails instead of declaring it ended', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ processId: 'shell-1' }] })
      .mockResolvedValueOnce({ data: [] })
      .mockRejectedValue(new Error('Unavailable'));
    const events: Record<string, unknown>[] = [];
    const tasks = new CodexTasks(
      { request } as unknown as CodexConnection,
      () => 'root',
      (message) => events.push(message),
    );
    await tasks.refresh();
    await tasks.refresh();
    expect(events).toHaveLength(1);
    tasks.close();
  });
});
