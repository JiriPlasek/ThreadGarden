/**
 * Router handlers for moving a chat (protocol 9), source side first: `move.check`
 * and the lock that keeps a chat still while it is exported (ruling R3).
 */
import type { ChatStatus, MoveBusy } from '@threadgarden/protocol';
import type { SessionHost } from '../../chat/session-host.js';
import type { Db } from '../../history/db.js';
import { gitState } from '../../move/git-state.js';
import type { ChatStore } from '../../move/store.js';
import { ServiceError, type Router } from '../router.js';

/** A lock that nobody ended (a desktop that went away) lets go after this long. */
export const MOVE_LOCK_MS = 10 * 60_000;

/** Chats locked while a move exports them: `chat.send` answers MOVING until `unlock` or expiry. */
export class MoveLocks {
  private readonly held = new Map<string, { exportId: string; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  lock(sessionId: string, exportId: string): void {
    this.held.set(sessionId, { exportId, at: this.now() });
  }

  unlock(sessionId: string): void {
    this.held.delete(sessionId);
  }

  isLocked(sessionId: string): boolean {
    return this.exportIdOf(sessionId) !== undefined;
  }

  /** The export holding the lock, if it has not expired. */
  exportIdOf(sessionId: string): string | undefined {
    const l = this.held.get(sessionId);
    if (!l) return undefined;
    if (this.now() - l.at >= MOVE_LOCK_MS) {
      this.held.delete(sessionId);
      return undefined;
    }
    return l.exportId;
  }
}

/** What stops a chat from being moved now (the same things that keep `reclaimIdle` away). */
export const busyOf = (s: {
  live: boolean;
  status: ChatStatus;
  runningTasks: number;
  pendingRequests(): unknown[];
}): MoveBusy | null => {
  if (s.live && (s.status === 'working' || s.status === 'unknown')) return 'turn';
  if (s.pendingRequests().length > 0 || s.status === 'needsYou') return 'prompt';
  if (s.runningTasks > 0) return 'subagents';
  return null;
};

export type MoveHandlerDeps = {
  host: SessionHost;
  db: Db;
  store: ChatStore;
};

export const registerMoveHandlers = (router: Router, deps: MoveHandlerDeps): void => {
  const { host, db, store } = deps;

  router.register('move.check', async (p) => {
    const s = host.get(p.sessionId);
    const cwd = store.historyOf(p.sessionId).dir ?? s?.cwd ?? db.getSession(p.sessionId)?.cwd;
    if (!cwd) throw new ServiceError('NOT_FOUND', `Unknown chat ${p.sessionId}`);
    return { cwd, busy: s ? busyOf(s) : null, git: await gitState(cwd) };
  });
};
