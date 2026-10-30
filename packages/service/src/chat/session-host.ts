/**
 * Owns every pahub chat that has (or recently had) a live process (§4.2, §4.3):
 * creation, resume on demand, End session, Stop all work, idle reclaim and
 * recovery of sessions that were live when the service last stopped.
 *
 * Chats whose process is gone but whose state the host must still report —
 * `paused` (idle-reclaimed) and `failed` (crashed / interrupted by a service
 * restart) — stay in the map as non-live `LiveSession`s; resuming one carries
 * its event log over so sequence numbers continue. Ended chats (`history`)
 * are forgotten.
 */
import type { EventMsg, Settings } from '@pahub/protocol';
import type { AgentAdapter } from '../sdk/adapter.js';
import {
  LiveSession,
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
  'Interrupted when the pahub service stopped — send a message to resume';

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
};

export class SessionHost {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly timers: Timers;
  private reclaimTimer: unknown = undefined;

  constructor(private readonly deps: SessionHostDeps) {
    this.timers = deps.timers ?? realTimers;
  }

  /** Starts the reclaim pass every `RECLAIM_INTERVAL_MS`. */
  start(): void {
    if (this.reclaimTimer !== undefined) return;
    this.reclaimTimer = this.timers.setInterval(
      () => this.reclaimIdle(this.deps.now()),
      RECLAIM_INTERVAL_MS,
    );
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
    const s = LiveSession.resume(
      sessionId,
      cwd,
      this.options({ ...current?.choices, ...(current ? { log: current.eventLog } : {}) }),
    );
    this.sessions.set(sessionId, s);
    return s;
  }

  /** End session: closes the process and returns the chat to history. */
  end(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.end();
    this.sessions.delete(sessionId);
  }

  /** Stop all work: interrupts and closes every live session; returns how many. */
  stopAll(): number {
    let count = 0;
    for (const [id, s] of [...this.sessions]) {
      if (!s.live) continue;
      s.interrupt().catch(() => {
        // Closing follows immediately; a failed interrupt changes nothing.
      });
      s.end();
      this.sessions.delete(id);
      count++;
    }
    return count;
  }

  /**
   * Closes live chats idle for at least `idleReclaimMinutes` (never pinned,
   * never waiting on the user); they become `paused`. Returns how many.
   */
  reclaimIdle(now: number): number {
    const minutes = this.deps.getSettings().idleReclaimMinutes;
    if (!(minutes > 0)) return 0;
    const limit = minutes * 60_000;
    let count = 0;
    for (const [id, s] of this.sessions) {
      if (!s.live || s.status !== 'idle' || s.idleSince === null) continue;
      if (now - s.idleSince < limit) continue;
      if (s.pendingRequests().length > 0 || this.deps.isPinned(id)) continue;
      s.pause();
      count++;
    }
    return count;
  }

  /**
   * At startup: sessions the registry still lists as live lost their process
   * with the previous service; they show as failed with a resume hint.
   */
  recoverAfterRestart(): number {
    let count = 0;
    for (const { sessionId, cwd } of this.deps.registry.listLive()) {
      if (this.sessions.get(sessionId)?.live) continue;
      const s = LiveSession.restore(sessionId, cwd, 'failed', this.options({}), {
        level: 'error',
        text: INTERRUPTED_TEXT,
      });
      this.sessions.set(sessionId, s);
      this.deps.registry.markEnded(sessionId);
      count++;
    }
    return count;
  }

  liveCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.live) n++;
    return n;
  }

  private options(extra: Partial<LiveSessionOptions>): LiveSessionOptions {
    const { adapter, registry, emit, now, describe } = this.deps;
    return {
      adapter,
      registry,
      claudePath: this.deps.claudePath(),
      env: this.deps.env(),
      emit,
      now,
      timers: this.timers,
      ...(describe ? { describe } : {}),
      ...extra,
    };
  }
}
