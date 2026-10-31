/**
 * One pahub chat while its Claude Code process exists (§4.3): sends and
 * queues user input, runs the permission / question / plan flow through the
 * SDK's `canUseTool`, derives the chat status (§6.2) and header, and emits
 * sequenced `chat.items` / `chat.status` / `chat.tasks` events through a
 * per-session `EventLog` so reconnecting clients can replay (§4.5).
 *
 * Session id: `create` picks a UUID and passes it to the SDK (`sessionId`
 * start option), so the id is known synchronously, before `system/init`.
 *
 * Error boundary (§7): the message pump catches everything; a crashed or
 * vanished process marks only this chat `failed`.
 *
 * Streaming coalescing: the normalizer re-emits the whole accumulated text on
 * every delta, so `chat.items` emission is throttled per session to at most
 * one event per `ITEMS_COALESCE_MS` (leading + trailing edge). Buffered items
 * are merged by id (latest version wins) and flushed before any `chat.status`
 * event, snapshot or replay, so event order is preserved. Each emitted batch
 * is exactly what the log stores, so `since(seq)` replays without gaps or
 * duplicates.
 *
 * Tasks (v1.1 §2): the SDK's task lifecycle messages are folded by a
 * `TaskTracker` into the chat's task list, published as `chat.tasks` (the full
 * list) with the same throttle as `chat.items` and only when it changed. The
 * list belongs to the current process: it is emptied when the process ends.
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { ChatHeaderInfo, ChatItem, ChatStatus, ChatTask, EventMsg } from '@pahub/protocol';
import type {
  AccountInfo,
  AgentAdapter,
  AgentSession,
  CanUseTool,
  Effort,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  ModelInfo,
  SDKMessage,
  SlashCommand,
  SDKUserMessage,
  StartOptions,
} from '../sdk/adapter.js';
import { startupFailureMessage, type StartupFailureMessage } from '../sdk/startup-failure.js';
import { ServiceError } from '../server/router.js';
import { EventLog, type ChatEvent, type ChatEventDraft } from './event-log.js';
import { Normalizer, deriveStatus } from './normalize.js';
import { TaskTracker, runningCount, taskEnded } from './tasks.js';

/** pahub's record of which sessions have a live process (Task 6 backs it with the db). */
export interface LiveRegistry {
  markLive(sessionId: string, cwd: string): void;
  markEnded(sessionId: string): void;
  listLive(): { sessionId: string; cwd: string }[];
}

/** Injected timer functions so throttling and reclaim are testable without real waits. */
export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

/** Node timers; intervals are unref'd (housekeeping never keeps the process alive). */
export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export type UserInput = {
  text: string;
  images?: { mediaType: string; dataBase64: string }[];
};

export type PermissionDecision = {
  decision: 'allow' | 'allowAlways' | 'deny';
  reason?: string;
  suggestionIndex?: number;
  /** Replaces the tool input (e.g. AskUserQuestion answers); passed through as-is. */
  updatedInput?: unknown;
};

/** What the user chose for this chat; carried over when the host resumes it. */
export type SessionChoices = {
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
};

export type LiveSessionDeps = {
  adapter: AgentAdapter;
  registry: LiveRegistry;
  claudePath: string;
  env: Record<string, string | undefined>;
  /** Event sink (the WebSocket broadcast). Must not throw; a throw is ignored. */
  emit(e: EventMsg): void;
  now(): number;
  timers?: Timers;
  /** Title and project name for the `needsYou` notification; defaults to first message / cwd basename. */
  describe?: (sessionId: string, cwd: string) => { title?: string; projectName?: string };
  /**
   * Receives failures of injected dependencies (registry, describe) and of the
   * message pump, which are contained so they never crash the service (§7).
   * Default: `console.error`. Must not throw; a throw is ignored.
   */
  onError?: (err: unknown, context: string) => void;
  // ── v1.1 T2 ──
  /**
   * A turn ended (a `result` that is not a startup failure and leaves no
   * queued user input, Ruling R28), at `at`; called
   * after the status changed and before `chatFinished` is emitted. A throw is
   * reported through `onError`.
   */
  onTurnEnded?: (sessionId: string, at: number) => void;
  /**
   * Ruling R29: the number of running background tasks changed (published
   * with the `chat.tasks` event that changed it). A throw is reported and
   * changes nothing.
   */
  onRunningTasks?: (sessionId: string, count: number) => void;
  /**
   * The chat did something (a message sent, an SDK message received); called
   * very often while a reply streams, so it must be cheap. A throw is reported.
   */
  onActivity?: (sessionId: string) => void;
  // ── v1.3 B: usage limits ──
  /** A `rate_limit_event` arrived (its `rate_limit_info`, unparsed). A throw is reported. */
  onRateLimit?: (sessionId: string, info: unknown) => void;
  /** An assistant message carried the API error `rate_limit` (the turn was refused). */
  onLimitError?: (sessionId: string) => void;
  /** A `result` arrived (every turn end, before `onTurnEnded`). A throw is reported. */
  onTurnResult?: (sessionId: string) => void;
};

export const defaultOnError = (err: unknown, context: string): void => {
  console.error(`pahub: ${context}:`, err);
};

export type LiveSessionOptions = LiveSessionDeps &
  SessionChoices & {
    /** For `create`: the new session's id (default: a random UUID). */
    sessionId?: string;
    /** An earlier instance's log, so sequence numbers continue across a resume. */
    log?: EventLog;
  };

export type LiveSnapshot = {
  items: ChatItem[];
  hasMore: boolean;
  seq: number;
  status: ChatStatus;
  header: ChatHeaderInfo;
  waitingFor?: string;
  /** Tasks of the running process (empty when there is none). */
  tasks: ChatTask[];
};

/** Why Claude Code refused to start this session (§6.4); `setup` asks for the setup screen. */
export type StartupFailure = StartupFailureMessage & { reason: string; detail?: string };

export const ITEMS_COALESCE_MS = 33;
export const DEFAULT_DENY_MESSAGE = 'Denied by user in pahub';

type PermissionItem = Extract<ChatItem, { kind: 'permissionRequest' }>;
type Pending = {
  item: PermissionItem;
  suggestions: PermissionUpdate[];
  what: string;
  settle(r: PermissionResult): void;
};
type Rec = Record<string, unknown>;

/**
 * Ruling R11: pahub v1 never runs a session in `bypassPermissions` (and never
 * sets the SDK's `allowDangerouslySkipPermissions`).
 */
const rejectBypass = (mode: string | undefined): void => {
  if (mode === 'bypassPermissions') {
    throw new ServiceError(
      'INVALID_PARAMS',
      'pahub does not support the bypassPermissions permission mode',
    );
  }
};

/** A suggested rule that would switch the session to bypassPermissions (never offered, R11). */
const isBypassSuggestion = (u: unknown): boolean =>
  isRec(u) && u.type === 'setMode' && u.mode === 'bypassPermissions';

const PROVIDERS: Record<string, string> = {
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
  gateway: 'Gateway',
};

/**
 * The header's authentication label from `accountInfo()` (§5.5; observed
 * shapes in docs/architecture.md). An API key wins: with `ANTHROPIC_API_KEY`
 * set the CLI still reports `tokenSource: "claude.ai"` from the stored login,
 * but the key is what the session runs on. Then a claude.ai login, then a
 * third-party provider.
 */
export const authLabel = (info: AccountInfo): NonNullable<ChatHeaderInfo['auth']> => {
  const keySource = str(info.apiKeySource);
  if (keySource && keySource !== 'none') {
    return {
      kind: 'apiKey',
      label: keySource === 'ANTHROPIC_API_KEY' ? 'API key' : `API key (${keySource})`,
    };
  }
  const plan = str(info.subscriptionType)?.trim();
  if (plan) {
    return {
      kind: 'subscription',
      label: `${plan[0]!.toUpperCase()}${plan.slice(1)} subscription`,
    };
  }
  if (str(info.tokenSource) === 'claude.ai') return { kind: 'subscription', label: 'Subscription' };
  const provider = str(info.apiProvider);
  if (provider && provider !== 'firstParty') {
    return { kind: 'other', label: PROVIDERS[provider] ?? provider };
  }
  return { kind: 'other', label: 'Unknown' };
};

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A turn is (or may be) in progress: new input is queued rather than starting a turn. */
const BUSY: ReadonlySet<ChatStatus> = new Set(['working', 'needsYou', 'unknown']);

export class LiveSession {
  private id = '';
  private dir = '';
  private session: AgentSession | null = null;
  private normalizer: Normalizer;
  private readonly log: EventLog;
  private readonly timers: Timers;
  private readonly chosen: SessionChoices;
  /** Every item published by this instance, by id, in first-seen order. */
  private readonly items = new Map<string, ChatItem>();
  private readonly pending = new Map<string, Pending>();
  private statusValue: ChatStatus = 'history';
  private headerValue: ChatHeaderInfo = {};
  private idleSinceValue: number | null = null;
  private lastActivityValue: number | null = null;
  /** User inputs sent with `priority: 'next'` since the last `result` (Ruling R28). */
  private queuedInputs = 0;
  /** The user stopped the turn in progress from pahub (Stop, Esc): its result is not a finish. */
  private interruptRequested = false;
  private published = '';
  private firstText: string | undefined;
  private contextUsed: number | undefined;
  private startupFailureValue: StartupFailure | undefined;
  /** The process whose account info was requested (once per process, after init). */
  private authAskedOf: AgentSession | null = null;
  private ended: Promise<void> = Promise.resolve();
  // chat.items coalescing
  private readonly buffered = new Map<string, ChatItem>();
  private bufferedReplace = false;
  private flushTimer: unknown = undefined;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  // chat.tasks coalescing
  private readonly tracker: TaskTracker;
  private tasksDirty = false;
  private tasksTimer: unknown = undefined;
  private lastTasksFlushAt = Number.NEGATIVE_INFINITY;
  /** The task list last published (JSON), so an unchanged list is not sent again. */
  private publishedTasks = '[]';
  /** How many of the published tasks are running (Ruling R29). */
  private publishedRunning = 0;

  constructor(private readonly deps: LiveSessionOptions) {
    rejectBypass(deps.permissionMode);
    this.log = deps.log ?? new EventLog();
    this.timers = deps.timers ?? realTimers;
    this.normalizer = new Normalizer({ now: deps.now });
    this.tracker = new TaskTracker({ now: deps.now });
    this.chosen = {
      ...(deps.model === undefined ? {} : { model: deps.model }),
      ...(deps.effort === undefined ? {} : { effort: deps.effort }),
      ...(deps.permissionMode === undefined ? {} : { permissionMode: deps.permissionMode }),
    };
    if (deps.effort !== undefined) this.headerValue.effort = deps.effort;
  }

  /** Starts a new chat (new SDK session) and sends its first message. */
  static create(cwd: string, firstMessage: UserInput, opts: LiveSessionOptions): LiveSession {
    const s = new LiveSession(opts);
    s.id = opts.sessionId ?? randomUUID();
    s.dir = cwd;
    s.startProcess({ sessionId: s.id });
    s.send(firstMessage);
    return s;
  }

  /** Continues an existing session (SDK `resume`, same id); idle until a message is sent. */
  static resume(sessionId: string, cwd: string, opts: LiveSessionOptions): LiveSession {
    const s = new LiveSession(opts);
    s.id = sessionId;
    s.dir = cwd;
    s.startProcess({ resume: sessionId });
    s.setStatus('idle');
    return s;
  }

  /** A chat with no process, in `status`, optionally with one system line (crash recovery). */
  static restore(
    sessionId: string,
    cwd: string,
    status: ChatStatus,
    opts: LiveSessionOptions,
    note?: { level: 'info' | 'warning' | 'error'; text: string },
  ): LiveSession {
    const s = new LiveSession(opts);
    s.id = sessionId;
    s.dir = cwd;
    if (note) s.pushItems([{ kind: 'system', id: `local:${randomUUID()}`, ...note }], false);
    s.setStatus(status);
    return s;
  }

  // ── state ───────────────────────────────────────────────────────────────

  get sessionId(): string {
    return this.id;
  }

  get cwd(): string {
    return this.dir;
  }

  get status(): ChatStatus {
    return this.statusValue;
  }

  /** When the chat last became idle (no turn, nothing pending); null while not idle. */
  get idleSince(): number | null {
    return this.idleSinceValue;
  }

  /** When this chat last sent or received anything (null: nothing yet in this instance). */
  get lastActivity(): number | null {
    return this.lastActivityValue;
  }

  /** True while the Claude Code process exists. */
  get live(): boolean {
    return this.session !== null;
  }

  get header(): ChatHeaderInfo {
    return { ...this.headerValue };
  }

  get seq(): number {
    return this.log.seq;
  }

  /** The event log, so a resumed instance continues its sequence numbers. */
  get eventLog(): EventLog {
    return this.log;
  }

  /** Set when the last process refused to start (a result with `startup_failure_reason`). */
  get startupFailure(): StartupFailure | undefined {
    return this.startupFailureValue ? { ...this.startupFailureValue } : undefined;
  }

  get choices(): SessionChoices {
    return { ...this.chosen };
  }

  /** The current process's tasks (subagents, background shells, …). */
  tasks(): ChatTask[] {
    return this.tracker.list();
  }

  /** How many published tasks are running (Ruling R29: such a chat counts as Running). */
  get runningTasks(): number {
    return this.publishedRunning;
  }

  pendingRequests(): ChatItem[] {
    return [...this.pending.values()].map((p) => p.item);
  }

  /**
   * v1.2 C1: the text of the first assistant reply this session holds (its
   * latest version, published or not), '' if none. Read-only: unlike
   * `snapshot` it publishes nothing.
   */
  firstReplyText(): string {
    for (const items of [this.items, this.buffered]) {
      for (const item of items.values()) {
        if (item.kind !== 'assistantText') continue;
        const latest = this.buffered.get(item.id) ?? item;
        return latest.kind === 'assistantText' ? latest.markdown : '';
      }
    }
    return '';
  }

  /** Resolves when the message pump has stopped (process gone). */
  whenEnded(): Promise<void> {
    return this.ended;
  }

  snapshot(tail: number): LiveSnapshot {
    this.flush();
    this.flushTasks();
    const all = [...this.items.values()];
    const n = Math.max(0, Math.floor(tail));
    const waitingFor = this.waitingFor();
    return {
      items: n === 0 ? [] : all.slice(-n),
      hasMore: all.length > n,
      seq: this.log.seq,
      status: this.statusValue,
      header: this.header,
      ...(waitingFor === undefined ? {} : { waitingFor }),
      tasks: this.tracker.list(),
    };
  }

  since(seq: number): ChatEvent[] | 'gap' {
    this.flush();
    this.flushTasks();
    return this.log.since(seq);
  }

  // ── input and controls ──────────────────────────────────────────────────

  /** Sends user input; while a turn is in progress it is queued (`priority: 'next'`). */
  send(input: UserInput): { queued: boolean } {
    const session = this.requireLive();
    const queued = BUSY.has(this.statusValue);
    const uuid = randomUUID();
    session.send(toUserMessage(input, uuid, queued));
    if (queued) this.queuedInputs++;
    this.firstText ??= input.text;
    const images = (input.images ?? []).map((i) => ({
      mediaType: i.mediaType,
      data: i.dataBase64,
    }));
    // Shown at once under the uuid sent to the SDK, so an echoed copy upserts instead of duplicating.
    this.pushItems(
      [
        {
          kind: 'user',
          id: uuid,
          text: input.text,
          ...(images.length > 0 ? { images } : {}),
          ts: this.deps.now(),
        },
      ],
      false,
    );
    this.noteActivity();
    if (!queued) this.setStatus('working');
    return { queued };
  }

  /**
   * Stops the turn in progress (Stop / Esc). The `result` that follows is not
   * a finished turn: the user stopped it from pahub, so there is no
   * `chatFinished` and the chat does not become unread. Pressed while nothing
   * runs, or if the SDK refuses, the next turn end counts as usual.
   */
  async interrupt(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const turn = BUSY.has(this.statusValue);
    if (turn) this.interruptRequested = true;
    try {
      await session.interrupt();
    } catch (err) {
      if (turn) this.interruptRequested = false;
      throw err;
    }
  }

  /**
   * Stops one task of the running process (SDK `stopTask`); the `stopped`
   * notification that follows updates the list. A task that already ended is
   * left alone. Errors: `NOT_LIVE`, `UNKNOWN_TASK`, `STOP_FAILED`.
   */
  async stopTask(taskId: string): Promise<void> {
    const session = this.session;
    if (!session) throw new ServiceError('NOT_LIVE', `Chat ${this.id} is not running`);
    const task = this.tracker.get(taskId);
    if (!task) throw new ServiceError('UNKNOWN_TASK', `No task ${taskId} in this chat`);
    if (taskEnded(task)) return;
    try {
      await session.stopTask(taskId);
    } catch (err) {
      throw new ServiceError('STOP_FAILED', `Could not stop the task: ${errorText(err)}`);
    }
  }

  /** Closes the process; the chat returns to history (§4.3 End session). */
  end(): void {
    this.stop('history');
  }

  /** Closes the process after idle reclaim; the next message resumes it. */
  pause(): void {
    this.stop('paused');
  }

  respond(requestId: string, d: PermissionDecision): void {
    const p = this.pending.get(requestId);
    if (!p) throw new Error(`No pending request ${requestId}`);
    if (d.decision === 'allowAlways') {
      const chosen = p.suggestions[d.suggestionIndex ?? 0];
      if (d.suggestionIndex !== undefined && chosen === undefined) {
        throw new ServiceError(
          'INVALID_PARAMS',
          `No suggestion ${d.suggestionIndex} to allow always`,
        );
      }
      // Defence in depth: bypass suggestions are filtered out when the request arrives.
      if (isBypassSuggestion(chosen)) {
        throw new ServiceError('INVALID_PARAMS', 'pahub does not apply bypassPermissions rules');
      }
    }
    if (d.decision === 'deny') {
      const message = d.reason?.trim() ? d.reason : DEFAULT_DENY_MESSAGE;
      this.finish(requestId, 'denied', { behavior: 'deny', message });
      return;
    }
    const r: PermissionResult = { behavior: 'allow' };
    if (isRec(d.updatedInput)) r.updatedInput = d.updatedInput;
    if (d.decision === 'allowAlways') {
      const chosen = p.suggestions[d.suggestionIndex ?? 0];
      if (chosen) r.updatedPermissions = [chosen];
    }
    this.finish(requestId, 'allowed', r);
  }

  async setModel(value: string): Promise<void> {
    await this.requireLive().setModel(value);
    this.chosen.model = value;
    this.headerValue.model = value;
    this.publishStatus();
  }

  async setPermissionMode(value: string): Promise<void> {
    rejectBypass(value);
    const mode = value as PermissionMode;
    await this.requireLive().setPermissionMode(mode);
    this.chosen.permissionMode = mode;
    this.headerValue.permissionMode = value;
    this.publishStatus();
  }

  /** Effort has no SDK control call; it is set with the `/effort` command, like the CLI. */
  async setEffort(value: string): Promise<void> {
    const session = this.requireLive();
    session.send(toUserMessage({ text: `/effort ${value}` }, randomUUID(), BUSY.has(this.status)));
    this.chosen.effort = value as Effort;
    this.headerValue.effort = value;
    this.publishStatus();
  }

  /** Slash commands of the running process (`supportedCommands()`). */
  supportedCommands(): Promise<SlashCommand[]> {
    return this.requireLive().supportedCommands();
  }

  /** Models the running process offers (`supportedModels()`). */
  supportedModels(): Promise<ModelInfo[]> {
    return this.requireLive().supportedModels();
  }

  /** The id of the item rendering SDK message `uuid` in this process, if seen. */
  resolveItemId(uuid: string): string | undefined {
    return this.normalizer.resolveItemId(uuid);
  }

  /** The SDK message uuid behind `itemId` (streamed items map to their final message). */
  messageUuidOf(itemId: string): string {
    return this.normalizer.messageUuidOf(itemId);
  }

  /** Auth label for the header (from the session's account info, see `authLabel`). */
  /**
   * v1.3 B: the SDK's experimental usage reading of this chat's process;
   * undefined when there is none or it does not offer the reading.
   */
  readUsage(): (() => Promise<unknown>) | undefined {
    const session = this.session;
    const usage = session?.usage;
    return usage ? () => usage.call(session) : undefined;
  }

  /** Adds a line of pahub's own to the chat (e.g. a scheduled message that went out late). */
  note(level: 'info' | 'warning' | 'error', text: string): void {
    this.pushItems([{ kind: 'system', id: `local:${randomUUID()}`, level, text }], false);
  }

  setAuth(auth: ChatHeaderInfo['auth']): void {
    if (auth === undefined) delete this.headerValue.auth;
    else this.headerValue.auth = auth;
    this.publishStatus();
  }

  // ── process ─────────────────────────────────────────────────────────────

  private startProcess(extra: Pick<StartOptions, 'sessionId' | 'resume'>): void {
    const { adapter, claudePath, env } = this.deps;
    const session = adapter.start({
      cwd: this.dir,
      env,
      claudePath,
      canUseTool: this.canUseTool,
      ...this.chosen,
      ...extra,
    });
    this.session = session;
    this.startupFailureValue = undefined;
    this.normalizer = new Normalizer({ now: this.deps.now });
    // The SDK's task state is per process: a new process starts with none.
    this.forgetTasks();
    this.guard('registry.markLive', () => this.deps.registry.markLive(this.id, this.dir));
    this.ended = this.pump(session).catch((err: unknown) => this.report(err, 'message pump'));
  }

  private async pump(session: AgentSession): Promise<void> {
    let error: unknown;
    let failed = false;
    try {
      for await (const m of session.messages) {
        if (this.session !== session) break;
        this.handle(m);
      }
    } catch (err) {
      error = err;
      failed = true;
    }
    if (this.session !== session) return; // closed on purpose (end / pause / stop all)
    this.session = null;
    this.cancelAllPending();
    this.forgetTasks();
    this.guard('registry.markEnded', () => this.deps.registry.markEnded(this.id));
    if (this.startupFailureValue) {
      this.setStatus('failed'); // already explained by the startup-failure line
      return;
    }
    const text = failed
      ? `Session failed: ${errorText(error)}`
      : 'The session process ended unexpectedly';
    this.pushItems([{ kind: 'system', id: `local:${randomUUID()}`, level: 'error', text }], false);
    this.setStatus('failed');
  }

  private stop(final: ChatStatus): void {
    const session = this.session;
    if (session) {
      this.session = null;
      this.cancelAllPending();
      this.forgetTasks();
      try {
        session.close();
      } catch {
        // The process is going away either way.
      }
      this.guard('registry.markEnded', () => this.deps.registry.markEnded(this.id));
    }
    this.setStatus(final);
  }

  private requireLive(): AgentSession {
    if (!this.session) throw new Error(`Session ${this.id} is not live`);
    return this.session;
  }

  private handle(m: SDKMessage): void {
    // Task tracking does not depend on rendering: a message the normalizer
    // cannot handle still updates the task list.
    this.guard('task tracking', () => {
      if (this.tracker.apply(m)) this.scheduleTasks();
    });
    this.guard('usage limits', () => this.noteLimits(m));
    try {
      this.noteActivity();
      this.updateHeader(m);
      this.requestAuth(m);
      const r = this.normalizer.push(m);
      if (r.items.length > 0) this.pushItems(r.items, r.replace);
      if (this.noteStartupFailure(m)) {
        this.setStatus('failed');
      } else {
        this.setStatus(this.nextStatus(m));
        if ((m as { type?: unknown }).type === 'result') this.resultArrived();
      }
    } catch (err) {
      // Defensive: one odd message must not take the chat down.
      this.pushItems(
        [
          {
            kind: 'system',
            id: `local:${randomUUID()}`,
            level: 'warning',
            text: `A message could not be processed: ${errorText(err)}`,
          },
        ],
        false,
      );
    }
  }

  /** v1.3 B: rate-limit events and refused turns, for the account's usage state. */
  private noteLimits(m: SDKMessage): void {
    const x: unknown = m;
    if (!isRec(x)) return;
    if (x.type === 'rate_limit_event') this.deps.onRateLimit?.(this.id, x.rate_limit_info);
    else if (x.type === 'assistant' && x.error === 'rate_limit') this.deps.onLimitError?.(this.id);
  }

  /** Maps a startup-failure result to an explained error line; true when `m` was one. */
  private noteStartupFailure(m: SDKMessage): boolean {
    const x: unknown = m;
    if (!isRec(x) || x.type !== 'result') return false;
    const reason = str(x.startup_failure_reason);
    if (reason === undefined) return false;
    const errors = Array.isArray(x.errors) ? x.errors.filter((e) => typeof e === 'string') : [];
    const detail = errors.join('\n').trim();
    const message = startupFailureMessage(reason);
    this.startupFailureValue = { reason, ...message, ...(detail ? { detail } : {}) };
    const text = `${message.title}: ${message.body}${detail ? `\n\nDetails: ${detail}` : ''}`;
    const id = `local:${randomUUID()}`;
    // `setup` lets the UI show its setup screen (install/update Claude Code) for this chat.
    this.pushItems(
      [{ kind: 'system', id, level: 'error', text, ...(message.setup ? { setup: true } : {}) }],
      false,
    );
    return true;
  }

  private nextStatus(m: SDKMessage): ChatStatus {
    if (this.pending.size > 0) return 'needsYou'; // an open request wins over stream activity
    const next = deriveStatus(m, this.statusValue);
    // Output while idle means a turn started (e.g. a queued message picked up after `result`).
    if (next === 'idle' && this.statusValue === 'idle') {
      const type = (m as { type?: unknown }).type;
      if (type === 'assistant' || type === 'stream_event') return 'working';
    }
    return next;
  }

  // ── header ──────────────────────────────────────────────────────────────

  private updateHeader(m: SDKMessage): void {
    const x: unknown = m;
    if (!isRec(x)) return;
    const h = this.headerValue;
    if (x.type === 'system' && x.subtype === 'init') {
      const model = str(x.model);
      const mode = str(x.permissionMode);
      const version = str(x.claude_code_version);
      if (model !== undefined) h.model = model;
      if (mode !== undefined) h.permissionMode = mode;
      if (version !== undefined) h.claudeVersion = version;
    } else if (x.type === 'system' && x.subtype === 'status') {
      const mode = str(x.permissionMode);
      if (mode !== undefined) h.permissionMode = mode;
    } else if (x.type === 'assistant' && !x.parent_tool_use_id) {
      const usage = isRec(x.message) ? x.message.usage : undefined;
      if (isRec(usage)) {
        const parts = [
          usage.input_tokens,
          usage.cache_creation_input_tokens,
          usage.cache_read_input_tokens,
          usage.output_tokens,
        ].map(num);
        if (parts.some((p) => p !== undefined)) {
          this.contextUsed = parts.reduce<number>((a, b) => a + (b ?? 0), 0);
        }
      }
    } else if (x.type === 'result') {
      const cost = num(x.total_cost_usd);
      if (cost !== undefined) h.costUsd = cost;
      const max = contextWindow(x.modelUsage, h.model);
      if (max !== undefined && this.contextUsed !== undefined) {
        h.contextUsage = { used: this.contextUsed, max };
      }
    }
  }

  /** After the first `system/init` of a process, asks once for its account info (§5.5). */
  private requestAuth(m: SDKMessage): void {
    const x: unknown = m;
    const session = this.session;
    if (!isRec(x) || x.type !== 'system' || x.subtype !== 'init') return;
    if (!session || this.authAskedOf === session) return;
    this.authAskedOf = session;
    let asked: Promise<AccountInfo>;
    try {
      asked = session.accountInfo();
    } catch (err) {
      this.report(err, `accountInfo (session ${this.id})`);
      return;
    }
    asked.then(
      (info) => {
        if (this.session === session) this.setAuth(authLabel(info));
      },
      (err: unknown) => this.report(err, `accountInfo (session ${this.id})`),
    );
  }

  // ── permissions ─────────────────────────────────────────────────────────

  private readonly canUseTool: CanUseTool = (toolName, input, options) => {
    const { requestId, signal } = options;
    const cancelled: PermissionResult = { behavior: 'deny', message: 'Request cancelled' };
    if (!this.session || signal.aborted) return Promise.resolve(cancelled);
    // A repeated request id supersedes the earlier one.
    this.finish(requestId, 'cancelled', cancelled);

    const variant =
      toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'tool';
    // R11: a "switch to bypassPermissions" rule is never offered.
    const suggestions = (options.suggestions ?? []).filter((u) => !isBypassSuggestion(u));
    const item: PermissionItem = {
      kind: 'permissionRequest',
      id: `permission:${requestId}`,
      requestId,
      toolName,
      input,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.decisionReason === undefined ? {} : { decisionReason: options.decisionReason }),
      suggestions,
      state: 'pending',
      variant,
    };
    const what = describeRequest(variant, toolName, input, options.title, options.displayName);

    return new Promise<PermissionResult>((resolve) => {
      const onAbort = () => this.finish(requestId, 'cancelled', cancelled);
      this.pending.set(requestId, {
        item,
        suggestions,
        what,
        settle: (r) => {
          signal.removeEventListener('abort', onAbort);
          resolve(r);
        },
      });
      signal.addEventListener('abort', onAbort, { once: true });
      this.pushItems([item], false);
      this.setStatus('needsYou');
      this.out({ event: 'needsYou', data: { ...this.describeChat(), what } });
    });
  };

  /** Session id, title and project name for notifications (`describe`, else first message / cwd). */
  private describeChat(): { sessionId: string; title: string; projectName: string } {
    const d = this.guard('describe', () => this.deps.describe?.(this.id, this.dir)) ?? {};
    return {
      sessionId: this.id,
      title: d.title ?? titleFrom(this.firstText),
      projectName: d.projectName ?? (basename(this.dir) || this.dir),
    };
  }

  // ── v1.1 T2: turn ends and activity ─────────────────────────────────────

  /** Records the activity time and tells `onActivity`. */
  private noteActivity(): void {
    this.lastActivityValue = this.deps.now();
    if (this.deps.onActivity) this.guard('onActivity', () => this.deps.onActivity?.(this.id));
  }

  /**
   * Ruling R28: a `result` while queued user input is pending is not a
   * finished turn: Claude goes straight on to that input, so the chat is not
   * waiting for the user. The CLI takes up everything queued at that turn
   * boundary, so the count restarts there and the next `result` decides.
   *
   * Every `result` also ends the turn's foreground tasks that got no end edge
   * (`TaskTracker.endForeground`), so none shows as running forever.
   */
  private resultArrived(): void {
    this.guard('onTurnResult', () => this.deps.onTurnResult?.(this.id));
    this.guard('task tracking', () => {
      if (this.tracker.endForeground()) this.scheduleTasks();
    });
    const interrupted = this.interruptRequested;
    this.interruptRequested = false;
    if (this.queuedInputs > 0) {
      this.queuedInputs = 0;
      return;
    }
    if (interrupted) return;
    this.turnEnded();
  }

  /** A turn ended: `onTurnEnded` (pahub's unread state), then `chatFinished` for the UI. */
  private turnEnded(): void {
    const at = this.deps.now();
    this.guard('onTurnEnded', () => this.deps.onTurnEnded?.(this.id, at));
    this.out({ event: 'chatFinished', data: this.describeChat() });
  }

  private finish(requestId: string, state: PermissionItem['state'], r: PermissionResult): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    this.pushItems([{ ...p.item, state }], true);
    p.settle(r);
    if (this.pending.size === 0 && this.statusValue === 'needsYou' && this.session) {
      this.setStatus('working');
    } else {
      this.publishStatus(); // waitingFor may have moved to the next request
    }
  }

  private cancelAllPending(): void {
    for (const id of [...this.pending.keys()]) {
      this.finish(id, 'cancelled', {
        behavior: 'deny',
        message: 'Session closed',
        interrupt: true,
      });
    }
  }

  /** What the chat is waiting on (first pending request) while it needs the user. */
  waitingFor(): string | undefined {
    if (this.statusValue !== 'needsYou') return undefined;
    return this.pending.values().next().value?.what;
  }

  // ── events ──────────────────────────────────────────────────────────────

  private setStatus(next: ChatStatus): void {
    if (next === 'idle') this.idleSinceValue ??= this.deps.now();
    else this.idleSinceValue = null;
    this.statusValue = next;
    this.publishStatus();
  }

  /** Emits `chat.status` when status, waitingFor or header changed since the last one. */
  private publishStatus(): void {
    const waitingFor = this.waitingFor();
    const key = JSON.stringify([this.statusValue, waitingFor, this.headerValue]);
    if (key === this.published) return;
    this.published = key;
    this.flush(); // items emitted before this status stay before it
    this.flushTasks();
    this.record({
      event: 'chat.status',
      data: {
        sessionId: this.id,
        status: this.statusValue,
        header: this.header,
        ...(waitingFor === undefined ? {} : { waitingFor }),
      },
    });
  }

  private pushItems(items: ChatItem[], replace: boolean): void {
    for (const item of items) {
      if (replace || this.items.has(item.id)) this.bufferedReplace = true;
      this.buffered.set(item.id, item);
    }
    if (this.flushTimer !== undefined) return;
    const wait = this.lastFlushAt + ITEMS_COALESCE_MS - this.deps.now();
    if (wait <= 0) {
      this.flush();
    } else {
      this.flushTimer = this.timers.setTimeout(() => {
        this.flushTimer = undefined;
        this.flush();
      }, wait);
    }
  }

  private flush(): void {
    if (this.flushTimer !== undefined) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.buffered.size === 0) return;
    const items = [...this.buffered.values()];
    const replace = this.bufferedReplace;
    this.buffered.clear();
    this.bufferedReplace = false;
    for (const item of items) this.items.set(item.id, item);
    this.lastFlushAt = this.deps.now();
    this.record({
      event: 'chat.items',
      data: { sessionId: this.id, items, ...(replace ? { replace: true } : {}) },
    });
  }

  /** Publishes the task list after a change, throttled like `pushItems`. */
  private scheduleTasks(): void {
    this.tasksDirty = true;
    if (this.tasksTimer !== undefined) return;
    const wait = this.lastTasksFlushAt + ITEMS_COALESCE_MS - this.deps.now();
    if (wait <= 0) {
      this.flushTasks();
    } else {
      this.tasksTimer = this.timers.setTimeout(() => {
        this.tasksTimer = undefined;
        this.flushTasks();
      }, wait);
    }
  }

  private flushTasks(): void {
    if (this.tasksTimer !== undefined) {
      this.timers.clearTimeout(this.tasksTimer);
      this.tasksTimer = undefined;
    }
    if (!this.tasksDirty) return;
    this.tasksDirty = false;
    const tasks = this.tracker.list();
    const key = JSON.stringify(tasks);
    if (key === this.publishedTasks) return;
    this.publishedTasks = key;
    this.lastTasksFlushAt = this.deps.now();
    this.record({ event: 'chat.tasks', data: { sessionId: this.id, tasks } });
    const running = runningCount(tasks);
    if (running !== this.publishedRunning) {
      this.publishedRunning = running;
      this.guard('onRunningTasks', () => this.deps.onRunningTasks?.(this.id, running));
    }
  }

  /** Empties the task list (the process is gone or new) and publishes that at once. */
  private forgetTasks(): void {
    if (this.tracker.clear()) this.tasksDirty = true;
    this.flushTasks();
  }

  private record(e: ChatEventDraft): void {
    const seq = this.log.append(e);
    const stamped = this.log.get(seq);
    if (stamped) this.out(stamped);
  }

  /** Runs a dependency call; a throw is reported and yields `undefined`. */
  private guard<T>(context: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      this.report(err, `${context} (session ${this.id})`);
      return undefined;
    }
  }

  private report(err: unknown, context: string): void {
    try {
      (this.deps.onError ?? defaultOnError)(err, context);
    } catch {
      // Nothing left to tell.
    }
  }

  private out(e: EventMsg): void {
    try {
      this.deps.emit(e);
    } catch {
      // A failing consumer must not break the chat; replay recovers the event.
    }
  }
}

const toUserMessage = (input: UserInput, uuid: SDKUserMessage['uuid'], queued: boolean) => {
  const content: unknown[] = [];
  if (input.text.length > 0) content.push({ type: 'text', text: input.text });
  for (const img of input.images ?? []) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 },
    });
  }
  // Never `client_composed`: `@path` mentions and `/commands` must behave as in the CLI.
  const m: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content } as SDKUserMessage['message'],
    parent_tool_use_id: null,
    uuid,
  };
  if (queued) m.priority = 'next';
  return m;
};

const describeRequest = (
  variant: PermissionItem['variant'],
  toolName: string,
  input: Rec,
  title: string | undefined,
  displayName: string | undefined,
): string => {
  if (variant === 'plan') return 'Approve a plan';
  if (variant === 'question') {
    const first = Array.isArray(input.questions) ? input.questions[0] : undefined;
    const q = isRec(first) ? str(first.question) : undefined;
    return q ? `Answer a question: ${q}` : 'Answer a question';
  }
  return title ?? `Allow ${displayName ?? toolName}`;
};

const titleFrom = (text: string | undefined): string => {
  const line = text
    ?.split('\n')
    .find((l) => l.trim())
    ?.trim();
  if (!line) return 'Chat';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/** Context window from a result's `modelUsage`: the header model's entry, else the largest. */
const contextWindow = (modelUsage: unknown, model: string | undefined): number | undefined => {
  if (!isRec(modelUsage)) return undefined;
  const own = model === undefined ? undefined : modelUsage[model];
  const fromOwn = isRec(own) ? num(own.contextWindow) : undefined;
  if (fromOwn !== undefined) return fromOwn;
  const all = Object.values(modelUsage)
    .map((u) => (isRec(u) ? num(u.contextWindow) : undefined))
    .filter((n): n is number => n !== undefined);
  return all.length > 0 ? Math.max(...all) : undefined;
};
