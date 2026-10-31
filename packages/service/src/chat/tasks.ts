/**
 * Per-session task state for the Activity panel (v1.1 design §2): folds the
 * SDK's task lifecycle messages of one Claude Code process into a list of
 * `ChatTask`s. The normalizer still treats these messages as non-visual; this
 * tracker is fed the same messages separately by `LiveSession`.
 *
 * Messages (SDK 0.3.x, see `SDKTask*Message` / `SDKBackgroundTasksChangedMessage`):
 * - `task_started` opens a task (or a new run of it, see run ids below);
 * - `task_progress` carries usage, the last tool and a one-line summary;
 * - `task_updated` merges a patch (status, description, error, backgrounding);
 * - `task_notification` is the end edge (completed / failed / stopped);
 * - `background_tasks_changed` is the *level*: every live background task.
 *
 * Reconciliation with the level, following the SDK's documentation of
 * `background_tasks_changed` (a level signal with REPLACE semantics, so that
 * "a missed bookend cannot wedge a stale running indicator"; its ordering
 * against the edges is unspecified):
 * - a task in the level is running (created from the entry if unseen — a task
 *   that starts in the background joins the level before its `task_started`);
 *   a task that already ended in this run is never revived by it;
 * - a task that was in an earlier level and is missing from a later one,
 *   without having ended, has ended with an unknown outcome: `unknown`, with
 *   `endedAt`. Its end edge usually comes first; if it arrives late it still
 *   sets the real status;
 * - tasks never seen in a level (foreground tasks, or CLIs that send no level)
 *   are left to the edges, plus one guard: a foreground task still open at
 *   its turn's `result` is ended there (`endForeground`).
 *
 * Run ids: "a resumed task keeps its task_id and gets a new [run id]"; run ids
 * of one task sort in the order the runs opened. A `task_started` with a new
 * run id restarts the row; frames naming an older run are late and ignored.
 *
 * Agent details (v1.3 §2): `task_started` carries the prompt, spawn depth and
 * workflow name. The model is on no task frame: it is the `model` input of
 * the Agent call that started the task (`tool_use_id`), else the
 * `message.model` of the first assistant message the subagent streams
 * (`parent_tool_use_id` naming that call); when a later streamed message
 * reports another model, that one is shown. These messages and the task's own
 * frames arrive in either order, so what they said is remembered per tool use
 * id (bounded) and applied whenever a task names that id.
 *
 * Ambient tasks (`ambient: true`: housekeeping and live-update watchers, which
 * the SDK says hosts should exclude from activity indicators) are never listed.
 *
 * Times come from the injected clock (`startedAt` when the task is first seen,
 * `endedAt` when it ends); the UI ticks the elapsed time live. At most `max`
 * tasks are kept, dropping the oldest finished task first. Unknown task types
 * and statuses get generic handling, never a throw.
 */
import type { ChatTask, ChatTaskKind, ChatTaskStatus } from '@pahub/protocol';

export const MAX_TASKS = 200;
/** Bound of the remembered ambient task ids (only used to ignore their later frames). */
const MAX_AMBIENT = 1_000;
/** Bound of the Agent calls whose model is remembered. */
const MAX_MODELS = 1_000;
/**
 * Longest prompt kept: every `chat.tasks` event carries the whole list, so a
 * prompt with a pasted log in it must not be copied into each one in full.
 */
export const MAX_PROMPT = 16_000;

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const nonEmpty = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** `task_type`s of agents (the CLI's full list also has workflows, MCP tasks and housekeeping). */
const AGENT_TYPES: ReadonlySet<string> = new Set([
  'local_agent',
  'remote_agent',
  'in_process_teammate',
]);
/** Tools whose call starts a subagent (`Task` is the name older CLIs use). */
const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);

/** Background shells (`run_in_background` Bash) and monitors. */
const SHELL_TYPES: ReadonlySet<string> = new Set(['local_bash', 'monitor_mcp', 'monitor_ws']);

/**
 * Activity section of a task: any `subagent_type` or an agent task type is an
 * agent; shells and monitors are shells. A type pahub does not know is placed
 * by its name (…agent…/…teammate… → agent, …bash…/…shell…/…monitor… → shell),
 * else `other`.
 */
export const taskKind = (
  taskType: string | undefined,
  subagentType: string | undefined,
): ChatTaskKind => {
  if (subagentType) return 'agent';
  if (taskType === undefined) return 'other';
  if (AGENT_TYPES.has(taskType)) return 'agent';
  if (SHELL_TYPES.has(taskType)) return 'shell';
  if (/agent|teammate/i.test(taskType)) return 'agent';
  if (/bash|shell|monitor/i.test(taskType)) return 'shell';
  return 'other';
};

type MappedStatus = { status: ChatTaskStatus; rawStatus?: string };

const unknownStatus = (raw: unknown): MappedStatus => ({
  status: 'unknown',
  rawStatus: typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? String(raw)),
});

const UPDATED: Readonly<Record<string, ChatTaskStatus>> = {
  pending: 'pending',
  running: 'running',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  killed: 'stopped',
};

/** `task_updated` `patch.status` → task status (`killed` is `stopped`). */
export const updatedStatus = (raw: unknown): MappedStatus => {
  const s = typeof raw === 'string' && Object.hasOwn(UPDATED, raw) ? UPDATED[raw] : undefined;
  return s ? { status: s } : unknownStatus(raw);
};

/** `task_notification` `status` → task status. */
export const notificationStatus = (raw: unknown): MappedStatus =>
  raw === 'completed' || raw === 'failed' || raw === 'stopped'
    ? { status: raw }
    : unknownStatus(raw);

const ENDED: ReadonlySet<ChatTaskStatus> = new Set(['completed', 'failed', 'stopped']);

/** The task has ended: an end status, or an end time (e.g. it left the level). */
export const taskEnded = (t: ChatTask): boolean => ENDED.has(t.status) || t.endedAt !== undefined;
const isFinished = taskEnded;

/**
 * Doing work now: running, pending, or an unknown status that has not ended.
 * Paused does not count. The same rule as the desktop's "N running" badge;
 * a live chat with such a task counts as Running (Ruling R29).
 */
export const taskRunning = (t: ChatTask): boolean =>
  t.status === 'running' || t.status === 'pending' || (t.status === 'unknown' && !t.endedAt);

/** How many of `tasks` are running (see `taskRunning`). */
export const runningCount = (tasks: readonly ChatTask[]): number =>
  tasks.reduce((n, t) => (taskRunning(t) ? n + 1 : n), 0);

/** What the messages of one Agent call said about its subagent's model. */
type ModelSeen = { input?: string; first?: string; last?: string };

/** The call's input model, else the first streamed one; a streamed model that changed since wins. */
const modelOf = (s: ModelSeen): string | undefined =>
  s.last !== undefined && s.last !== s.first ? s.last : (s.input ?? s.first);

/** A streamed model id; placeholders such as `<synthetic>` (CLI-made error messages) are not models. */
const streamedModel = (v: unknown): string | undefined => {
  const s = nonEmpty(v);
  return s === undefined || s.startsWith('<') ? undefined : s;
};

const clampPrompt = (v: unknown): string | undefined => {
  const s = nonEmpty(v);
  return s === undefined || s.length <= MAX_PROMPT ? s : `${s.slice(0, MAX_PROMPT)}…`;
};

type Entry = {
  /** The live record, edited in place (always through `edit`). */
  task: ChatTask;
  /** Frozen copy handed out until the task next changes. */
  snap: ChatTask | undefined;
  runId: string | undefined;
  /** Seen in a `background_tasks_changed` level (so leaving it means it ended). */
  inLevel: boolean;
};

export type TaskTrackerOptions = { now: () => number; max?: number };

export class TaskTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly ambient = new Set<string>();
  /** Agent call `tool_use` id → what its messages said about the model. */
  private readonly models = new Map<string, ModelSeen>();
  private readonly max: number;

  constructor(private readonly opts: TaskTrackerOptions) {
    this.max = Math.max(1, Math.floor(opts.max ?? MAX_TASKS));
  }

  /**
   * Every tracked task, in the order first seen, as frozen snapshots. A task
   * that did not change since the last call is the same object, so the
   * `chat.tasks` events kept for replay share their unchanged tasks.
   */
  list(): ChatTask[] {
    return [...this.entries.values()].map((e) => this.view(e));
  }

  get(taskId: string): ChatTask | undefined {
    const e = this.entries.get(taskId);
    return e ? this.view(e) : undefined;
  }

  /** Forgets everything (the process ended); true when there was a task. */
  clear(): boolean {
    const had = this.entries.size > 0;
    this.entries.clear();
    this.ambient.clear();
    this.models.clear();
    return had;
  }

  /** Folds one SDK message in; true when it may have changed the list. */
  apply(m: unknown): boolean {
    if (isRec(m) && m.type === 'assistant') return this.assistant(m);
    if (!isRec(m) || m.type !== 'system') return false;
    switch (m.subtype) {
      case 'task_started':
        return this.started(m);
      case 'task_progress':
        return this.progress(m);
      case 'task_updated':
        return this.updated(m);
      case 'task_notification':
        return this.notified(m);
      case 'background_tasks_changed':
        return this.level(m);
      default:
        return false;
    }
  }

  // ── edges ───────────────────────────────────────────────────────────────

  private started(m: Rec): boolean {
    const id = str(m.task_id);
    if (!id) return false;
    if (m.ambient === true) return this.markAmbient(id);
    const runId = str(m.run_id);
    const prev = this.entries.get(id);
    if (prev && isLate(runId, prev.runId)) return false;
    // A late start of a run that already ended must not revive it; only a new
    // run (or a CLI that sends no run ids) restarts the row.
    if (prev && isFinished(prev.task) && sameRunId(runId, prev.runId)) return false;
    const taskType = str(m.task_type) ?? prev?.task.taskType;
    const subagentType = nonEmpty(m.subagent_type) ?? prev?.task.subagentType;
    const toolUseId = str(m.tool_use_id) ?? prev?.task.toolUseId;
    const parentTaskId = str(m.parent_task_id) ?? prev?.task.parentTaskId;
    const backgrounded =
      typeof m.is_backgrounded === 'boolean' ? m.is_backgrounded : prev?.task.backgrounded;
    // A new run is the same agent resumed: its prompt and model carry over.
    const prompt = clampPrompt(m.prompt) ?? prev?.task.prompt;
    const spawnDepth = num(m.spawn_depth) ?? prev?.task.spawnDepth;
    const workflowName = nonEmpty(m.workflow_name) ?? prev?.task.workflowName;
    const model = prev?.task.model;
    // Same run (e.g. first seen in the level): merge; a new run or an ended task restarts.
    const sameRun =
      prev !== undefined &&
      !isFinished(prev.task) &&
      (runId === undefined || prev.runId === undefined || runId === prev.runId);
    const task: ChatTask = {
      ...(sameRun ? prev.task : {}),
      taskId: id,
      ...(toolUseId === undefined ? {} : { toolUseId }),
      kind: taskKind(taskType, subagentType),
      ...(taskType === undefined ? {} : { taskType }),
      ...(subagentType === undefined ? {} : { subagentType }),
      description:
        nonEmpty(m.description) ??
        nonEmpty(m.workflow_name) ??
        prev?.task.description ??
        taskType ??
        'Task',
      status: sameRun && prev.task.status !== 'pending' ? prev.task.status : 'running',
      ...(backgrounded === undefined ? {} : { backgrounded }),
      ...(parentTaskId === undefined ? {} : { parentTaskId }),
      startedAt: sameRun ? prev.task.startedAt : this.opts.now(),
      ...(model === undefined ? {} : { model }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(spawnDepth === undefined ? {} : { spawnDepth }),
      ...(workflowName === undefined ? {} : { workflowName }),
    };
    const entry: Entry = {
      task,
      snap: undefined,
      runId: runId ?? prev?.runId,
      inLevel: sameRun ? prev.inLevel : false,
    };
    this.put(id, entry);
    this.syncModel(entry);
    return true;
  }

  private progress(m: Rec): boolean {
    const id = str(m.task_id);
    if (!id || this.ambient.has(id)) return false;
    const runId = str(m.run_id);
    let e = this.entries.get(id);
    if (e && isLate(runId, e.runId)) return false;
    if (!e) {
      const subagentType = nonEmpty(m.subagent_type);
      e = {
        task: {
          taskId: id,
          kind: taskKind(undefined, subagentType),
          ...(subagentType === undefined ? {} : { subagentType }),
          description: nonEmpty(m.description) ?? 'Task',
          status: 'running',
          startedAt: this.opts.now(),
        },
        snap: undefined,
        runId,
        inLevel: false,
      };
      this.put(id, e);
    }
    const t = this.edit(e);
    const description = nonEmpty(m.description);
    if (description !== undefined) t.description = description;
    const toolUseId = str(m.tool_use_id);
    if (toolUseId !== undefined) t.toolUseId ??= toolUseId;
    this.syncModel(e);
    applyUsage(t, m.usage);
    const lastTool = nonEmpty(m.last_tool_name);
    if (lastTool !== undefined) t.lastTool = lastTool;
    const summary = nonEmpty(m.summary);
    if (summary !== undefined) t.summary = summary;
    if (t.status === 'pending') t.status = 'running';
    return true;
  }

  private updated(m: Rec): boolean {
    const e = this.known(m);
    if (!e || !isRec(m.patch)) return false;
    const p = m.patch;
    const status = p.status === undefined ? undefined : updatedStatus(p.status);
    const runId = str(m.run_id);
    const t = this.edit(e);
    if (status !== undefined) {
      if (!isFinished(t) || ENDED.has(status.status)) {
        this.setStatus(t, status);
      } else if (status.status !== 'unknown' && !sameRunId(runId, e.runId)) {
        // A non-terminal update of a new run (or with no run ids) restarts the
        // ended row; one of the run that ended is late and changes nothing.
        restart(t, this.opts.now());
        if (runId !== undefined) e.runId = runId;
        this.setStatus(t, status);
      }
    }
    const description = nonEmpty(p.description);
    if (description !== undefined) t.description = description;
    const error = nonEmpty(p.error);
    if (error !== undefined) t.error = error;
    if (typeof p.is_backgrounded === 'boolean') t.backgrounded = p.is_backgrounded;
    return true;
  }

  private notified(m: Rec): boolean {
    const e = this.known(m);
    if (!e) return false;
    const t = this.edit(e);
    this.setStatus(t, notificationStatus(m.status));
    // An end edge ends the task even when its status is one pahub does not know.
    t.endedAt ??= this.opts.now();
    const summary = nonEmpty(m.summary);
    if (summary !== undefined) t.summary = summary;
    applyUsage(t, m.usage);
    return true;
  }

  // ── models ──────────────────────────────────────────────────────────────

  /**
   * An assistant message: remembers the `model` input of its Agent calls and
   * the model a subagent's message (`parent_tool_use_id`) streamed with, then
   * updates the tasks those calls started. True when a task's model changed.
   */
  private assistant(m: Rec): boolean {
    const message = isRec(m.message) ? m.message : undefined;
    if (!message) return false;
    const touched = new Set<string>();
    if (Array.isArray(message.content)) {
      for (const b of message.content) {
        if (!isRec(b) || b.type !== 'tool_use' || !AGENT_TOOLS.has(str(b.name) ?? '')) continue;
        const id = str(b.id);
        const input = isRec(b.input) ? b.input : undefined;
        const model = nonEmpty(input?.model);
        // A fork ignores the input and always runs on its parent's model.
        if (!id || model === undefined || input?.subagent_type === 'fork') continue;
        this.seen(id).input = model;
        touched.add(id);
      }
    }
    const parent = nonEmpty(m.parent_tool_use_id);
    const streamed = streamedModel(message.model);
    if (parent !== undefined && streamed !== undefined) {
      const s = this.seen(parent);
      s.first ??= streamed;
      s.last = streamed;
      touched.add(parent);
    }
    if (touched.size === 0) return false;
    let changed = false;
    for (const e of this.entries.values()) {
      const id = e.task.toolUseId;
      if (id !== undefined && touched.has(id)) changed = this.syncModel(e) || changed;
    }
    return changed;
  }

  private seen(toolUseId: string): ModelSeen {
    let s = this.models.get(toolUseId);
    if (!s) {
      s = {};
      this.models.set(toolUseId, s);
      if (this.models.size > MAX_MODELS) {
        const oldest = this.models.keys().next().value;
        if (oldest !== undefined) this.models.delete(oldest);
      }
    }
    return s;
  }

  /** Sets the task's model from what its Agent call's messages said; true when it changed. */
  private syncModel(e: Entry): boolean {
    const id = e.task.toolUseId;
    const s = id === undefined ? undefined : this.models.get(id);
    const model = s ? modelOf(s) : undefined;
    if (model === undefined || model === e.task.model) return false;
    this.edit(e).model = model;
    return true;
  }

  // ── turn end ────────────────────────────────────────────────────────────

  /**
   * Called at a turn's `result`: ends every foreground task still open, as
   * `unknown` with `endedAt` (the same as leaving the level). A foreground
   * task blocks the tool call that spawned it, so it cannot outlive the turn;
   * if its end edge never came (a CLI that sends none, a lost frame, a status
   * pahub does not know), it would otherwise show as running forever, keep
   * the chat in Running and block idle reclaim. A late end edge still sets
   * the real status.
   *
   * Foreground means not backgrounded (`is_backgrounded` false or absent) and
   * never seen in a level. A task whose launcher (`parent_task_id`) is a
   * tracked task that is still open is left alone: a background agent's own
   * subagent runs on after the main turn; it is ended at the first turn end
   * after its launcher ended (parents are listed before their children, so
   * one pass settles a chain). True when a task changed.
   */
  endForeground(): boolean {
    let changed = false;
    for (const e of this.entries.values()) {
      const t = e.task;
      if (t.backgrounded === true || e.inLevel || isFinished(t)) continue;
      const parent = t.parentTaskId === undefined ? undefined : this.entries.get(t.parentTaskId);
      if (parent && !isFinished(parent.task)) continue;
      const edited = this.edit(e);
      this.setStatus(edited, { status: 'unknown' });
      edited.endedAt = this.opts.now();
      changed = true;
    }
    return changed;
  }

  // ── level ───────────────────────────────────────────────────────────────

  private level(m: Rec): boolean {
    if (!Array.isArray(m.tasks)) return false;
    let changed = false;
    const listed = new Set<string>();
    for (const raw of m.tasks) {
      if (!isRec(raw)) continue;
      const id = str(raw.task_id);
      if (!id) continue;
      if (raw.ambient === true) {
        changed = this.markAmbient(id) || changed;
        continue;
      }
      if (this.ambient.has(id)) continue;
      listed.add(id);
      const runId = str(raw.run_id);
      const prev = this.entries.get(id);
      if (prev && isLate(runId, prev.runId)) continue;
      const newRun =
        prev !== undefined &&
        runId !== undefined &&
        prev.runId !== undefined &&
        runId !== prev.runId;
      if (prev && !newRun) {
        const t = this.edit(prev);
        prev.inLevel = true;
        t.backgrounded = true;
        const parentTaskId = str(raw.parent_task_id);
        if (parentTaskId !== undefined) t.parentTaskId = parentTaskId;
        if (!isFinished(t) && t.status !== 'paused' && t.status !== 'running') {
          this.setStatus(t, { status: 'running' });
        }
        changed = true;
        continue;
      }
      const taskType = str(raw.task_type);
      const subagentType = nonEmpty(raw.subagent_type);
      const parentTaskId = str(raw.parent_task_id);
      this.put(id, {
        task: {
          taskId: id,
          kind: taskKind(taskType, subagentType),
          ...(taskType === undefined ? {} : { taskType }),
          ...(subagentType === undefined ? {} : { subagentType }),
          description: nonEmpty(raw.description) ?? taskType ?? 'Task',
          status: 'running',
          backgrounded: true,
          ...(parentTaskId === undefined ? {} : { parentTaskId }),
          startedAt: this.opts.now(),
        },
        snap: undefined,
        runId,
        inLevel: true,
      });
      changed = true;
    }
    for (const [id, e] of this.entries) {
      if (!e.inLevel || listed.has(id)) continue;
      e.inLevel = false;
      if (isFinished(e.task)) continue;
      const t = this.edit(e);
      this.setStatus(t, { status: 'unknown' });
      t.endedAt = this.opts.now();
      changed = true;
    }
    return changed;
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  /** The task record to change; its handed-out snapshot is replaced on the next `list`. */
  private edit(e: Entry): ChatTask {
    e.snap = undefined;
    return e.task;
  }

  private view(e: Entry): ChatTask {
    return (e.snap ??= Object.freeze({ ...e.task }));
  }

  /** The tracked entry an update / notification is for, unless it names an older run. */
  private known(m: Rec): Entry | undefined {
    const id = str(m.task_id);
    if (!id || this.ambient.has(id) || m.ambient === true) return undefined;
    const e = this.entries.get(id);
    if (!e || isLate(str(m.run_id), e.runId)) return undefined;
    return e;
  }

  private setStatus(t: ChatTask, s: MappedStatus): void {
    t.status = s.status;
    if (s.rawStatus === undefined) delete t.rawStatus;
    else t.rawStatus = s.rawStatus;
    if (ENDED.has(s.status)) t.endedAt ??= this.opts.now();
    else if (s.status !== 'unknown') delete t.endedAt;
  }

  private markAmbient(id: string): boolean {
    this.ambient.add(id);
    if (this.ambient.size > MAX_AMBIENT) {
      const oldest = this.ambient.values().next().value;
      if (oldest !== undefined) this.ambient.delete(oldest);
    }
    return this.entries.delete(id);
  }

  private put(id: string, e: Entry): void {
    this.entries.set(id, e);
    while (this.entries.size > this.max) {
      let drop: string | undefined;
      for (const [key, x] of this.entries) {
        if (key !== id && isFinished(x.task)) {
          drop = key;
          break;
        }
      }
      drop ??= this.entries.keys().next().value;
      if (drop === undefined) break;
      this.entries.delete(drop);
    }
  }
}

/** Both frames name the same run (absent run ids never match: older CLIs send none). */
const sameRunId = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a === b;

/** Clears what belonged to the ended run of `t`; a new run starts now. */
const restart = (t: ChatTask, now: number): void => {
  for (const k of [
    'endedAt',
    'rawStatus',
    'tokens',
    'toolUses',
    'durationMs',
    'lastTool',
    'summary',
    'error',
  ] as const) {
    delete t[k];
  }
  t.startedAt = now;
};

/** A frame naming a run that sorts before the one shown is late (SDK run id contract). */
const isLate = (runId: string | undefined, current: string | undefined): boolean =>
  runId !== undefined && current !== undefined && runId < current;

const applyUsage = (t: ChatTask, usage: unknown): void => {
  if (!isRec(usage)) return;
  const tokens = num(usage.total_tokens);
  const toolUses = num(usage.tool_uses);
  const durationMs = num(usage.duration_ms);
  if (tokens !== undefined) t.tokens = tokens;
  if (toolUses !== undefined) t.toolUses = toolUses;
  if (durationMs !== undefined) t.durationMs = durationMs;
};
