import { parseTaskNotification, type ChatItem, type ChatTask } from '@threadgarden/protocol';
import { agentRowStatus } from './activity';
import { buildRows, type Row } from './rows';

export type CompletedTaskSummary = {
  id: string;
  description: string;
  status: 'completed' | 'failed' | 'stopped' | 'unknown';
  summary: string;
  model?: string;
  tokens?: number;
  durationMs?: number;
};
export type ConciseRow =
  Row | { kind: 'taskSummary'; key: string; task: CompletedTaskSummary; itemIds: string[] };

type Completion = {
  task: CompletedTaskSummary;
  itemIds: string[];
  position?: number;
  notificationPosition?: number;
  at?: number;
};
const rec = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const string = (value: unknown): string => (typeof value === 'string' ? value : '');
const terminal = (status: string): status is CompletedTaskSummary['status'] =>
  ['completed', 'failed', 'stopped', 'unknown'].includes(status);
const main = (item: ChatItem): boolean => !('parentToolUseId' in item && item.parentToolUseId);
const identity = (id: string): string => id.replace(/^codex-agent-/, '');

/** A main-thread projection only; all source items remain available in Conversation. */
export const buildConciseRows = (
  items: readonly ChatItem[],
  tasks: readonly ChatTask[],
  hasMore = false,
): ConciseRow[] => {
  const aliases = new Map<string, Completion>();
  const completions = new Set<Completion>();
  const visible: ChatItem[] = [];
  const positions = new Map<string, number>();
  const sources = new Map(
    items
      .filter(
        (item): item is Extract<ChatItem, { kind: 'toolCall' }> =>
          main(item) && item.kind === 'toolCall',
      )
      .map((item) => [item.toolUseId, item]),
  );
  const get = (keys: (string | undefined)[], initial: CompletedTaskSummary): Completion => {
    const ids = keys.filter((key): key is string => !!key).map(identity);
    const found = ids.map((id) => aliases.get(id)).filter((v): v is Completion => !!v);
    const entry = found[0] ?? { task: initial, itemIds: [] };
    completions.add(entry);
    for (const other of found.slice(1)) {
      if (other === entry) continue;
      entry.itemIds.push(...other.itemIds);
      entry.notificationPosition = other.notificationPosition ?? entry.notificationPosition;
      entry.position = entry.position ?? other.position;
      for (const [key, value] of aliases) if (value === other) aliases.set(key, entry);
      completions.delete(other);
    }
    for (const id of ids) aliases.set(id, entry);
    return entry;
  };
  const callTasks = new Map(tasks.filter((t) => !t.parentTaskId).map((t) => [t.toolUseId, t]));
  for (const [index, item] of items.entries()) {
    if (!main(item)) continue;
    positions.set(item.id, index);
    if (item.kind === 'toolCall' && ['Agent', 'Task', 'collabAgentToolCall'].includes(item.name)) {
      const task =
        callTasks.get(item.toolUseId) ??
        tasks.find(
          (t) => !t.parentTaskId && item.agentId && identity(t.taskId) === identity(item.agentId),
        );
      const status = agentRowStatus(item, task);
      const input = rec(item.input);
      const nativeLaunch =
        item.name === 'collabAgentToolCall' && Array.isArray(input.receiverThreadIds);
      if (
        status.text === 'Running' ||
        status.text === 'Paused' ||
        status.text === 'Started in background' ||
        (nativeLaunch && !task)
      )
        continue;
      const entry = get([item.toolUseId, item.agentId, task?.taskId], {
        id: task?.taskId ?? item.toolUseId,
        description: string(input.description) || string(input.prompt) || item.name,
        status:
          status.text === 'Failed' ? 'failed' : status.text === 'Stopped' ? 'stopped' : 'completed',
        summary: item.resultText ?? '',
        ...(string(input.model) ? { model: string(input.model) } : {}),
        ...(item.tokens === undefined ? {} : { tokens: item.tokens }),
        ...(item.startedAt !== undefined &&
        item.endedAt !== undefined &&
        item.endedAt >= item.startedAt
          ? { durationMs: item.endedAt - item.startedAt }
          : {}),
      });
      entry.itemIds.push(item.id);
      entry.position = index;
      entry.at = item.endedAt;
      continue;
    }
    if (item.kind === 'system') {
      const notification = parseTaskNotification(item.detail ?? item.text);
      if (
        notification &&
        (!notification.status ||
          terminal(notification.status) ||
          !['running', 'pending', 'paused'].includes(notification.status))
      ) {
        const entry = get([notification.toolUseId, notification.taskId], {
          id: notification.taskId ?? notification.toolUseId ?? item.id,
          description: item.text,
          status:
            notification.status && terminal(notification.status) ? notification.status : 'unknown',
          summary: notification.summary,
        });
        // The persisted completion is authoritative over a launch acknowledgement.
        entry.task.status =
          notification.status && terminal(notification.status) ? notification.status : 'unknown';
        entry.task.summary = notification.summary;
        entry.itemIds.push(item.id);
        entry.notificationPosition = index;
        entry.at = item.ts;
        const source = notification.toolUseId ? sources.get(notification.toolUseId) : undefined;
        if (source) {
          entry.itemIds.unshift(source.id);
          const input = rec(source.input);
          entry.task.description =
            string(input.description) || string(input.prompt) || entry.task.description;
          if (string(input.model)) entry.task.model = string(input.model);
        }
        continue;
      }
      if (item.level === 'info') continue;
    }
    if (item.kind === 'thinking' || item.kind === 'todo') continue;
    if (item.kind === 'toolCall' && item.status !== 'error') continue;
    if (item.kind === 'permissionRequest' && item.state !== 'pending') continue;
    visible.push(item);
  }
  for (const task of tasks) {
    if (
      task.parentTaskId ||
      (task.spawnDepth ?? 1) > 1 ||
      !terminal(task.status) ||
      (task.status === 'unknown' && task.endedAt === undefined)
    )
      continue;
    const entry = get([task.toolUseId, task.taskId], {
      id: task.taskId,
      description: task.description,
      status: task.status,
      summary: '',
    });
    entry.task = {
      ...entry.task,
      id: task.taskId,
      description: task.description || entry.task.description,
      status: task.status,
      summary: task.error ?? task.summary ?? entry.task.summary,
      ...(task.model === undefined ? {} : { model: task.model }),
      ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
      ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }),
    };
    entry.at = task.endedAt ?? entry.at;
    const source = task.toolUseId
      ? sources.get(task.toolUseId)
      : [...sources.values()].find(
          (call) =>
            (call.agentId && identity(call.agentId) === identity(task.taskId)) ||
            (call.name === 'collabAgentToolCall' &&
              Array.isArray(rec(call.input).receiverThreadIds) &&
              (rec(call.input).receiverThreadIds as unknown[]).includes(identity(task.taskId))),
        );
    if (source) {
      entry.itemIds.unshift(source.id);
      entry.position ??= positions.get(source.id);
      const input = rec(source.input);
      if (!entry.task.model && string(input.model)) entry.task.model = string(input.model);
      entry.task.tokens ??= source.tokens;
    }
    if (
      entry.task.durationMs === undefined &&
      task.endedAt !== undefined &&
      task.endedAt >= task.startedAt
    ) {
      entry.task.durationMs = task.endedAt - task.startedAt;
    }
  }
  const anchors = items.flatMap((item, index) =>
    main(item) && (item.kind === 'user' || item.kind === 'result') && item.ts !== undefined
      ? [{ index, at: item.ts }]
      : [],
  );
  const firstAt = anchors[0]?.at;
  const timePosition = (at: number): number | undefined => {
    if (hasMore && firstAt !== undefined && at < firstAt) return undefined;
    const next = anchors.find((anchor) => anchor.at >= at);
    if (next) return next.index - 0.5;
    if (anchors.length) return items.length;
    return undefined;
  };
  const output: { position: number; row: ConciseRow }[] = buildRows(visible).map((row) => ({
    position: positions.get(row.itemIds[0]!)!,
    row,
  }));
  for (const entry of completions) {
    const timed = entry.at === undefined ? undefined : timePosition(entry.at);
    const position =
      entry.notificationPosition ??
      (timed === undefined ? entry.position : Math.max(timed, entry.position ?? -1));
    if (position === undefined) continue;
    output.push({
      position,
      row: {
        kind: 'taskSummary',
        key: `task-summary:${entry.task.id}`,
        task: entry.task,
        itemIds: [...new Set(entry.itemIds)],
      },
    });
  }
  return output.sort((a, b) => a.position - b.position).map(({ row }) => row);
};
