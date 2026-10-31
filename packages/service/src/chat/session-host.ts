/**
 * Owns every Threadgarden chat that has (or recently had) a live process (§4.2, §4.3):
 * creation, resume on demand, End session, Stop all work, idle reclaim and
 * recovery of sessions that were live when the service last stopped.
 *
 * Chats whose process is gone but whose state the host must still report —
 * `paused` (idle-reclaimed) and `failed` (crashed / interrupted by a service
 * restart) — stay in the map as non-live `LiveSession`s; resuming one carries
 * its event log over so sequence numbers continue. Ended chats (`history`)
 * are forgotten except for their last seq, which seeds the log of a later
 * resume in the same service run so per-session seq stays monotonic (§4.5).
 *
 * Robustness (§7): dependency failures (settings, pins, registry) and a
 * failing session never escape the reclaim timer or `stopAll`; they are
 * reported through `onError` and the remaining sessions carry on.
 */
import type { ChatStatus, EventMsg, Settings } from '@pahub/protocol';
import type { AgentAdapter } from '../sdk/adapter.js';
import { EventLog, type ChatEvent } from './event-log.js';
import {
  LiveSession,
  defaultOnError,
  realTimers,
  type LiveRegistry,
  type LiveSessionDeps,
  type LiveSessionOptions,
  type SessionChoices,
  type Timers,
  type UserInput,
} from './live-session.js';

export type { LiveRegistry } from './live-session.js';

export const RECLAIM_INTERVAL_MS = 60_000;
export const INTERRUPTED_TEXT =
  'Interrupted when the Threadgarden service stopped — send a message to resume';

export type SessionHostDeps = {
  adapter: AgentAdapter;
  registry: LiveRegistry;
  /** The `claude` executable to start sessions with (read at every start). */
  claudePath: () => string;
  env: () => Record<string, string | undefined>;
  emit(e: EventMsg): void;
  now(): number;
  timers?: Timers;
  /** Pinned chats are never reclaimed (Ruling R1). */
  isPinned: (sessionId: string) => boolean;
  /** `idleReclaimMinutes` is read at every reclaim pass; 0 disables reclaim. */
  getSettings: () => Settings;
  describe?: LiveSessionDeps['describe'];
  /** Contained failures (see module doc); also handed to every session. Default: `console.error`. */
  onError?: LiveSessionDeps['onError'];
  /**
   * Where this service run's chat event numbering starts (`seqBaseForEpoch`);
   * default 0. A seq from another run is then never valid here (§4.5).
   */
  seqBase?: number;
  // ── v1.1 T2 ──
  /** Handed to every session (see `LiveSessionDeps.onTurnEnded`). */
  onTurnEnded?: LiveSessionDeps['onTurnEnded'];
  /** Handed to every session (see `LiveSessionDeps.onActivity`). */
  onActivity?: LiveSessionDeps['onActivity'];
  /** Handed to every session (see `LiveSessionDeps.onRunningTasks`, Ruling R29). */
  onRunningTasks?: LiveSessionDeps['onRunningTasks'];
  // ── v1.3 B: usage limits ──
  /** Handed to every session (see `LiveSessionDeps.onRateLimit`). */
  onRateLimit?: LiveSessionDeps['onRateLimit'];
  /** Handed to every session (see `LiveSessionDeps.onLimitError`). */
  onLimitError?: LiveSessionDeps['onLimitError'];
  /** Handed to every session (see `LiveSessionDeps.onTurnResult`). */
  onTurnResult?: LiveSessionDeps['onTurnResult'];
};

export class SessionHost {
  private readonly sessions = new Map<string, LiveSession>();
  /** Last seq of chats ended (forgotten) in this service run, by session id. */
  private readonly seqFloor = new Map<string, number>();
  private readonly timers: Timers;
  private readonly seqBase: number;
  private reclaimTimer: unknown = undefined;

  constructor(private readonly deps: SessionHostDeps) {
    this.timers = deps.timers ?? realTimers;
    this.seqBase = deps.seqBase ?? 0;
  }

  /** Starts the reclaim pass every `RECLAIM_INTERVAL_MS`. */
  start(): void {
    if (this.reclaimTimer !== undefined) return;
    this.reclaimTimer = this.timers.setInterval(() => {
      try {
        this.reclaimIdle(this.deps.now());
      } catch (err) {
        this.report(err, 'idle reclaim');
      }
    }, RECLAIM_INTERVAL_MS);
  }

  /** Stops the reclaim timer (sessions are left alone; see `stopAll`). */
  dispose(): void {
    if (this.reclaimTimer === undefined) return;
    this.timers.clearInterval(this.reclaimTimer);
    this.reclaimTimer = undefined;
  }

  create(cwd: string, firstMessage: UserInput, choices: SessionChoices = {}): LiveSession {
    const s = LiveSession.create(cwd, firstMessage, this.options(choices));
    this.sessions.set(s.sessionId, s);
    return s;
  }

  get(sessionId: string): LiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * The live chat for `sessionId`, resuming it (same session id) when it is
   * paused, failed or history-only. Resume safety (§4.4) is checked by the caller.
   */
  ensureLive(sessionId: string, cwd: string): LiveSession {
    const current = this.sessions.get(sessionId);
    if (current?.live) return current;
    const floor = this.seqFloor.get(sessionId);
    const log =
      current?.eventLog ?? (floor === undefined ? undefined : new EventLog(undefined, floor));
    const s = LiveSession.resume(
      sessionId,
      cwd,
      this.options({ ...current?.choices, ...(log ? { log } : {}) }),
    );
    this.sessions.set(sessionId, s);
    this.seqFloor.delete(sessionId);
    return s;
  }

  /** End session: closes the process and returns the chat to history. */
  end(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.end();
    this.forget(s);
  }

  /**
   * Stop all work: interrupts and closes every live session. A session that
   * throws while stopping is reported and skipped (it stays in the host);
   * returns how many were stopped.
   */
  stopAll(): number {
    let count = 0;
    for (const s of [...this.sessions.values()]) {
      if (!s.live) continue;
      try {
        s.interrupt().catch(() => {
          // Closing follows immediately; a failed interrupt changes nothing.
        });
        s.end();
        this.forget(s);
        count++;
      } catch (err) {
        this.report(err, `stop all (session ${s.sessionId})`);
      }
    }
    return count;
  }

  /**
   * Closes live chats idle for at least `idleReclaimMinutes` (never pinned,
   * never waiting on the user, never with running background tasks: closing
   * the process would kill them, Ruling R29); they become `paused`. Returns
   * how many. A failure for one session is reported and the pass continues.
   */
  reclaimIdle(now: number): number {
    const minutes = this.deps.getSettings().idleReclaimMinutes;
    if (!(minutes > 0)) return 0;
    const limit = minutes * 60_000;
    let count = 0;
    for (const [id, s] of [...this.sessions]) {
      try {
        if (!s.live || s.status !== 'idle' || s.idleSince === null) continue;
        if (now - s.idleSince < limit) continue;
        if (s.pendingRequests().length > 0 || this.deps.isPinned(id)) continue;
        if (s.runningTasks > 0) continue;
        s.pause();
        count++;
      } catch (err) {
        this.report(err, `idle reclaim (session ${id})`);
      }
    }
    return count;
  }

  /**
   * At startup: sessions the registry still lists as live lost their process
   * with the previous service; they show as failed with a resume hint.
   */
  recoverAfterRestart(): number {
    let entries: { sessionId: string; cwd: string }[];
    try {
      entries = this.deps.registry.listLive();
    } catch (err) {
      this.report(err, 'registry.listLive');
      return 0;
    }
    let count = 0;
    for (const { sessionId, cwd } of entries) {
      try {
        if (this.sessions.get(sessionId)?.live) continue;
        const s = LiveSession.restore(sessionId, cwd, 'failed', this.options({}), {
          level: 'error',
          text: INTERRUPTED_TEXT,
        });
        this.sessions.set(sessionId, s);
        count++;
        this.deps.registry.markEnded(sessionId);
      } catch (err) {
        this.report(err, `recover after restart (session ${sessionId})`);
      }
    }
    return count;
  }

  /** Read-only view of every chat the host knows (live, paused or failed), for place lists. */
  list(): {
    sessionId: string;
    cwd: string;
    status: ChatStatus;
    live: boolean;
    waitingFor?: string;
    lastActivity?: number;
    runningTasks?: number;
  }[] {
    return [...this.sessions.values()].map((s) => {
      const waitingFor = s.waitingFor();
      const lastActivity = s.lastActivity;
      const runningTasks = s.live ? s.runningTasks : 0;
      return {
        sessionId: s.sessionId,
        cwd: s.cwd,
        status: s.status,
        live: s.live,
        ...(waitingFor === undefined ? {} : { waitingFor }),
        ...(lastActivity === null ? {} : { lastActivity }),
        ...(runningTasks > 0 ? { runningTasks } : {}),
      };
    });
  }

  /**
   * The latest event seq of `sessionId`: its log's, else the last seq of a
   * chat ended in this run, else the run's base (a chat with no events yet).
   */
  seqOf(sessionId: string): number {
    return this.sessions.get(sessionId)?.seq ?? this.seqFloor.get(sessionId) ?? this.seqBase;
  }

  /**
   * Events of `sessionId` after `seq` (§4.5 reconnect). A chat the host does
   * not hold has no buffered events: only its current seq is valid.
   */
  since(sessionId: string, seq: number): ChatEvent[] | 'gap' {
    const s = this.sessions.get(sessionId);
    if (s) return s.since(seq);
    return seq === this.seqOf(sessionId) ? [] : 'gap';
  }

  /**
   * v1.3 B: the usage reading of some live chat that offers one (the account
   * is the same for all); undefined when none runs. Never starts a process.
   */
  usageReader(): (() => Promise<unknown>) | undefined {
    for (const s of this.sessions.values()) {
      const read = s.live ? s.readUsage() : undefined;
      if (read) return read;
    }
    return undefined;
  }

  liveCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.live) n++;
    return n;
  }

  private forget(s: LiveSession): void {
    this.sessions.delete(s.sessionId);
    this.seqFloor.set(s.sessionId, s.seq);
  }

  private report(err: unknown, context: string): void {
    try {
      (this.deps.onError ?? defaultOnError)(err, context);
    } catch {
      // Nothing left to tell.
    }
  }

  private options(extra: Partial<LiveSessionOptions>): LiveSessionOptions {
    const {
      adapter,
      registry,
      emit,
      now,
      describe,
      onError,
      onTurnEnded,
      onActivity,
      onRunningTasks,
      onRateLimit,
      onLimitError,
      onTurnResult,
    } = this.deps;
    return {
      adapter,
      registry,
      claudePath: this.deps.claudePath(),
      env: this.deps.env(),
      emit,
      now,
      timers: this.timers,
      ...(describe ? { describe } : {}),
      ...(onError ? { onError } : {}),
      ...(onTurnEnded ? { onTurnEnded } : {}),
      ...(onActivity ? { onActivity } : {}),
      ...(onRunningTasks ? { onRunningTasks } : {}),
      ...(onRateLimit ? { onRateLimit } : {}),
      ...(onLimitError ? { onLimitError } : {}),
      ...(onTurnResult ? { onTurnResult } : {}),
      ...extra,
      log: extra.log ?? new EventLog(undefined, this.seqBase),
    };
  }
}
