import type { ChatItem, ChatTask, TimelineBlock } from '@threadgarden/protocol';

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const preview = (v: string): string => v.replace(/\s+/g, ' ').trim().slice(0, 240);
const time = (v: number | undefined): number | undefined =>
  v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined;
const agentCall = (i: ChatItem): i is Extract<ChatItem, { kind: 'toolCall' }> =>
  i.kind === 'toolCall' && ['Agent', 'Task', 'collabAgentToolCall'].includes(i.name);
const field = (v: string, tag: string): string | undefined =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(v)?.[1]?.trim();

export type TimelineProjection = {
  blocks: TimelineBlock[];
  items: Map<string, ChatItem[]>;
  agents: Map<string, string>;
};

/** History and live snapshots share one projection; unknown times are never fabricated. */
export const projectTimeline = (
  items: readonly ChatItem[],
  tasks: readonly ChatTask[],
  working = false,
): TimelineProjection => {
  const out: TimelineProjection = { blocks: [], items: new Map(), agents: new Map() };
  const calls = new Map<string, TimelineBlock>();
  let turn: TimelineBlock | undefined;
  const newTurn = (id: string, title: string, startedAt?: number): TimelineBlock => {
    const block: TimelineBlock = {
      id,
      kind: 'turn',
      title: preview(title) || 'Earlier activity',
      outcome: '',
      status: 'unknown',
      toolCount: 0,
      agentCount: 0,
      ...(time(startedAt) === undefined ? {} : { startedAt, promptAt: startedAt }),
    };
    out.blocks.push(block);
    out.items.set(id, []);
    return block;
  };
  for (const item of items) {
    const parent = 'parentToolUseId' in item ? item.parentToolUseId : undefined;
    if (item.kind === 'user' && !parent) turn = newTurn(`turn:${item.id}`, item.text, item.ts);
    if (!turn && !parent) turn = newTurn(`turn:${item.id}`, 'Earlier activity');
    if (turn && !parent) {
      out.items.get(turn.id)!.push(item);
      if (item.kind === 'assistantText') turn.outcome = preview(item.markdown);
      if (item.kind === 'toolCall') turn.toolCount++;
      if (item.kind === 'result') {
        turn.status = item.isError ? 'failed' : 'completed';
        const end = time(item.ts);
        if (end !== undefined) turn.endedAt = end;
        if (
          turn.startedAt === undefined &&
          end !== undefined &&
          item.durationMs !== undefined &&
          item.durationMs >= 0
        ) {
          turn.startedAt = time(end - item.durationMs);
        }
      }
    }
    if (agentCall(item)) {
      const input = record(item.input);
      // A background launch result is not the agent's completion.
      const background = input.run_in_background === true;
      const block: TimelineBlock = {
        id: `agent:${item.toolUseId}`,
        kind: 'agent',
        title: preview(text(input.description) || text(input.prompt) || item.name),
        outcome: background ? '' : preview(item.resultText ?? ''),
        status:
          item.status === 'error'
            ? 'failed'
            : item.status === 'ok' && !background
              ? 'completed'
              : 'unknown',
        toolCount: 0,
        agentCount: 0,
        ...(time(item.startedAt) === undefined ? {} : { startedAt: item.startedAt }),
        ...(!background && time(item.endedAt) !== undefined ? { endedAt: item.endedAt } : {}),
        ...(text(input.model) ? { model: text(input.model) } : {}),
      };
      calls.set(item.toolUseId, block);
      out.blocks.push(block);
      out.items.set(block.id, [item]);
      if (item.agentId) out.agents.set(block.id, item.agentId);
      if (turn) turn.agentCount++;
    }
    if (parent) {
      const block = calls.get(parent);
      if (block) {
        out.items.get(block.id)!.push(item);
        if (item.kind === 'toolCall') block.toolCount++;
      }
    }
  }
  // Notifications persisted by Claude are authoritative for background agents.
  for (const item of items) {
    if (item.kind !== 'system' || !item.detail?.trim().startsWith('<task-notification>')) continue;
    const toolId = field(item.detail, 'tool-use-id');
    const block = toolId ? calls.get(toolId) : undefined;
    if (!block) continue;
    const status = field(item.detail, 'status');
    if (status === 'completed' || status === 'failed' || status === 'stopped')
      block.status = status;
    const end = time(item.ts);
    if (end !== undefined) block.endedAt = end;
    block.outcome = preview(field(item.detail, 'summary') ?? item.text);
    out.items.get(block.id)!.push(item);
    const agentId = field(item.detail, 'task-id');
    if (agentId) out.agents.set(block.id, agentId);
  }
  for (const task of tasks) {
    if (task.kind !== 'agent') continue;
    let block = task.toolUseId ? calls.get(task.toolUseId) : undefined;
    if (!block) {
      block = {
        id: `task:${task.taskId}`,
        kind: 'agent',
        title: preview(task.description),
        outcome: '',
        status: 'unknown',
        toolCount: 0,
        agentCount: 0,
      };
      out.blocks.push(block);
      out.items.set(block.id, []);
    }
    block.status = task.status === 'pending' || task.status === 'paused' ? 'running' : task.status;
    block.startedAt = time(task.startedAt) ?? block.startedAt;
    block.endedAt = time(task.endedAt) ?? block.endedAt;
    if (block.status === 'running' && task.endedAt === undefined) delete block.endedAt;
    block.outcome = preview(task.error ?? task.summary ?? block.outcome);
    block.model = task.model ?? block.model;
    block.toolCount = task.toolUses ?? block.toolCount;
    out.agents.set(block.id, task.taskId);
  }
  if (working && turn && turn.status === 'unknown') turn.status = 'running';
  // Bad clocks must not turn a block into a negative duration.
  for (const block of out.blocks) {
    if (
      block.startedAt !== undefined &&
      block.endedAt !== undefined &&
      block.endedAt < block.startedAt
    )
      delete block.startedAt;
  }
  return out;
};
