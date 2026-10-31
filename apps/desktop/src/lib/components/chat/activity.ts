import type { ChatTask } from '@pahub/protocol';
import { taskEnded } from '#lib/state/chats.svelte.js';

/** Deepest indent of a nested task; deeper ones still sit under their parent, at this indent. */
export const MAX_NEST_DEPTH = 3;

/** When an ended task ended: `endedAt`, else its start plus its duration, else its start. */
export const taskEndTime = (t: ChatTask): number =>
  t.endedAt ?? (t.durationMs === undefined ? t.startedAt : t.startedAt + t.durationMs);

/**
 * Activity panel order (v1.3 §2): tasks that have not ended (pending,
 * running, paused, unknown) first, newest start first; then ended tasks, most
 * recently ended first. Ties keep the service's order (first seen).
 */
export const compareTasks = (a: ChatTask, b: ChatTask): number => {
  const aEnded = taskEnded(a);
  const bEnded = taskEnded(b);
  if (aEnded !== bEnded) return aEnded ? 1 : -1;
  return aEnded ? taskEndTime(b) - taskEndTime(a) : b.startedAt - a.startedAt;
};

export type TaskRow = {
  task: ChatTask;
  /** Indent level: 0 for a top-level task, capped at `MAX_NEST_DEPTH`. */
  depth: number;
  /** The task it is listed under, when its parent is in the same list. */
  parent?: ChatTask;
};

/**
 * The tasks as panel rows: each task whose `parentTaskId` names another task
 * of `tasks` comes right after its parent (and the parent's earlier
 * children), one indent deeper; siblings are in `compareTasks` order. A
 * parent chain that loops (malformed input) is broken where it closes, so
 * every task is listed exactly once.
 */
export const taskRows = (tasks: readonly ChatTask[]): TaskRow[] => {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const children = new Map<string, ChatTask[]>();
  const roots: ChatTask[] = [];
  for (const t of tasks) {
    const parent = t.parentTaskId;
    if (parent !== undefined && parent !== t.taskId && byId.has(parent)) {
      const list = children.get(parent);
      if (list) list.push(t);
      else children.set(parent, [t]);
    } else {
      roots.push(t);
    }
  }
  const rows: TaskRow[] = [];
  const listed = new Set<string>();
  const visit = (t: ChatTask, depth: number, parent: ChatTask | undefined): void => {
    if (listed.has(t.taskId)) return;
    listed.add(t.taskId);
    rows.push({ task: t, depth: Math.min(depth, MAX_NEST_DEPTH), ...(parent ? { parent } : {}) });
    for (const c of (children.get(t.taskId) ?? []).sort(compareTasks)) visit(c, depth + 1, t);
  };
  for (const t of roots.sort(compareTasks)) visit(t, 0, undefined);
  // Only tasks in a parent loop are left: list each loop from its first task in order.
  for (const t of tasks.slice().sort(compareTasks)) visit(t, 0, undefined);
  return rows;
};

/** A model id or alias as the row shows it: without a leading `claude-`. */
export const shortModel = (model: string): string => model.replace(/^claude-/, '');
