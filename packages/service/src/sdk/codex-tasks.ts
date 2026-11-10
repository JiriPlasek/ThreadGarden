import type { CodexConnection } from './codex-client.js';
import { rec, str, type Rec } from './codex-events.js';

/** Only tasks owned by this thread may be listed or stopped. */
export class CodexTasks {
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private refreshing?: Promise<void>;
  private tasks = new Map<
    string,
    {
      kind: 'shell' | 'agent';
      nativeId: string;
      turnId?: string;
      description: string;
      model?: string;
    }
  >();
  constructor(
    private readonly client: CodexConnection,
    private readonly threadId: () => string,
    private readonly emit: (message: Rec) => void,
  ) {}
  start(): void {
    this.timer = setInterval(() => {
      void this.refresh();
    }, 5_000).unref();
    void this.refresh();
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }
  refresh(): Promise<void> {
    this.refreshing ??= this.read()
      .catch(() => {})
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }
  private async read(): Promise<void> {
    if (this.closed) return;
    const next = new Map<
      string,
      {
        kind: 'shell' | 'agent';
        nativeId: string;
        turnId?: string;
        description: string;
        model?: string;
      }
    >();
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await this.client.request('thread/backgroundTerminals/list', {
        threadId: this.threadId(),
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const value of Array.isArray(result.data) ? result.data : []) {
        const terminal = rec(value);
        const id = str(terminal.processId);
        if (id)
          next.set(`codex-shell-${id}`, {
            kind: 'shell',
            nativeId: id,
            description: str(terminal.command) || 'Codex terminal',
          });
      }
      cursor = str(result.nextCursor) || undefined;
      if (cursor && seen.has(cursor)) throw new Error('Repeated terminal cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    cursor = undefined;
    seen.clear();
    do {
      const result = await this.client.request('thread/list', {
        ancestorThreadId: this.threadId(),
        limit: 100,
        modelProviders: [],
        sourceKinds: ['subAgent', 'subAgentThreadSpawn', 'subAgentOther'],
        useStateDbOnly: true,
        ...(cursor ? { cursor } : {}),
      });
      for (const value of Array.isArray(result.data) ? result.data : []) {
        const agent = rec(value);
        const id = str(agent.id);
        const status = rec(agent.status);
        if (!id || status.type !== 'active') continue;
        next.set(`codex-agent-${id}`, {
          kind: 'agent',
          nativeId: id,
          description: str(agent.agentNickname) || str(agent.agentRole) || 'Codex agent',
          model: str(agent.model) || undefined,
        });
      }
      cursor = str(result.nextCursor) || undefined;
      if (cursor && seen.has(cursor)) throw new Error('Repeated agent cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (this.closed) return;
    for (const [id] of this.tasks)
      if (!next.has(id))
        this.emit({
          type: 'system',
          subtype: 'task_notification',
          task_id: id,
          status: 'completed',
          summary: 'Codex task ended',
          output_file: '',
        });
    this.tasks = next;
    this.emit({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [...next].map(([id, task]) => ({
        task_id: id,
        task_type: task.kind === 'shell' ? 'local_bash' : 'local_agent',
        description: task.description,
        model: task.model,
      })),
    });
  }
  async stop(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) throw new Error('This Codex task is no longer running');
    if (task.kind === 'shell')
      await this.client.request('thread/backgroundTerminals/terminate', {
        threadId: this.threadId(),
        processId: task.nativeId,
      });
    else {
      const result = await this.client.request('thread/turns/list', {
        threadId: task.nativeId,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      });
      const active = (Array.isArray(result.data) ? result.data : [])
        .map(rec)
        .find((turn) => turn.status === 'inProgress');
      if (active)
        await this.client.request('turn/interrupt', {
          threadId: task.nativeId,
          turnId: str(active.id),
        });
    }
    this.tasks.delete(id);
    this.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: id,
      status: 'stopped',
      summary: 'Stopped by you',
      output_file: '',
    });
    await this.refresh();
  }
}
