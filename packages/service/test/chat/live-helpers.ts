import type { EventMsg } from '@threadgarden/protocol';
import type { LiveRegistry, Timers } from '../../src/chat/live-session.js';
import type { SDKMessage } from '../../src/sdk/adapter.js';

// Fixtures are plain objects cast to SDK types: the tests deliberately do not
// satisfy the full Anthropic API typings.
export const sdk = (m: Record<string, unknown>): SDKMessage => m as unknown as SDKMessage;

export const init = (sessionId: string, extra: Record<string, unknown> = {}): SDKMessage =>
  sdk({
    type: 'system',
    subtype: 'init',
    uuid: `init-${sessionId}`,
    session_id: sessionId,
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    claude_code_version: '2.9.0',
    cwd: '/proj',
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    apiKeySource: 'none',
    output_style: 'default',
    skills: [],
    plugins: [],
    ...extra,
  });

export const assistantText = (
  uuid: string,
  text: string,
  usage: Record<string, number> = {},
): SDKMessage =>
  sdk({
    type: 'assistant',
    uuid,
    session_id: 's',
    parent_tool_use_id: null,
    message: { id: `msg_${uuid}`, role: 'assistant', content: [{ type: 'text', text }], usage },
  });

export const result = (uuid: string, extra: Record<string, unknown> = {}): SDKMessage =>
  sdk({
    type: 'result',
    subtype: 'success',
    uuid,
    session_id: 's',
    is_error: false,
    duration_ms: 12,
    total_cost_usd: 0.25,
    usage: {},
    ...extra,
  });

export const streamEvent = (uuid: string, event: Record<string, unknown>): SDKMessage =>
  sdk({ type: 'stream_event', uuid, session_id: 's', parent_tool_use_id: null, event });

let taskMessageCounter = 0;

/** A `system` message of `subtype` (task fixtures). */
export const sys = (subtype: string, extra: Record<string, unknown>) =>
  sdk({
    type: 'system',
    subtype,
    uuid: `${subtype}-${++taskMessageCounter}`,
    session_id: 's',
    ...extra,
  });

export const started = (taskId: string, extra: Record<string, unknown> = {}) =>
  sys('task_started', { task_id: taskId, description: `task ${taskId}`, ...extra });
export const progress = (taskId: string, extra: Record<string, unknown> = {}) =>
  sys('task_progress', {
    task_id: taskId,
    description: `task ${taskId}`,
    usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
    ...extra,
  });
export const updated = (taskId: string, patch: Record<string, unknown>, extra = {}) =>
  sys('task_updated', { task_id: taskId, patch, ...extra });
export const notification = (taskId: string, status: string, extra: Record<string, unknown> = {}) =>
  sys('task_notification', { task_id: taskId, status, output_file: '', summary: '', ...extra });
export const level = (tasks: Record<string, unknown>[]) =>
  sys('background_tasks_changed', { tasks });

export class MemoryRegistry implements LiveRegistry {
  readonly live = new Map<string, string>();
  readonly ended: string[] = [];
  markLive(sessionId: string, cwd: string): void {
    this.live.set(sessionId, cwd);
  }
  markEnded(sessionId: string): void {
    this.live.delete(sessionId);
    this.ended.push(sessionId);
  }
  listLive(): { sessionId: string; cwd: string }[] {
    return [...this.live].map(([sessionId, cwd]) => ({ sessionId, cwd }));
  }
}

type Task = { at: number; fn: () => void; every?: number };

/** Deterministic clock + timers: nothing runs until `advance()`. */
export class ManualTimers implements Timers {
  t = 1_000_000;
  private nextId = 1;
  private readonly tasks = new Map<number, Task>();

  now = (): number => this.t;

  setTimeout = (fn: () => void, ms: number): unknown => this.add({ at: this.t + ms, fn });
  clearTimeout = (h: unknown): void => void this.tasks.delete(h as number);
  setInterval = (fn: () => void, ms: number): unknown =>
    this.add({ at: this.t + ms, fn, every: ms });
  clearInterval = (h: unknown): void => void this.tasks.delete(h as number);

  get pending(): number {
    return this.tasks.size;
  }

  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.tasks].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at);
      const first = due[0];
      if (!first) break;
      const [id, task] = first;
      this.t = task.at;
      if (task.every) task.at += task.every;
      else this.tasks.delete(id);
      task.fn();
    }
    this.t = end;
  }

  private add(task: Task): number {
    const id = this.nextId++;
    this.tasks.set(id, task);
    return id;
  }
}

/** Lets the session's message pump consume everything emitted so far. */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

export const statuses = (events: EventMsg[], sessionId?: string): string[] =>
  events
    .filter((e) => e.event === 'chat.status')
    .map((e) => e.data as { sessionId: string; status: string })
    .filter((d) => sessionId === undefined || d.sessionId === sessionId)
    .map((d) => d.status);
