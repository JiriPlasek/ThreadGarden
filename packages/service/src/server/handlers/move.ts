/**
 * Router handlers for moving a chat (protocol 9), source side first: `move.check`
 * and the lock that keeps a chat still while it is exported (ruling R3).
 */
import path from 'node:path';
import type { ChatStatus, GitState, MoveBusy } from '@threadgarden/protocol';
import type { SessionHost } from '../../chat/session-host.js';
import type { Db } from '../../history/db.js';
import { gitState } from '../../move/git-state.js';
import type { ChatStore } from '../../move/store.js';
import { originUrlOf, repoOfUrl, type Tools } from '../../projects/github.js';
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

export type TargetDeps = {
  tools: Tools;
  recentCwds(): string[];
  /** The remembered Create in (`ProjectMaker.createIn`). */
  createIn(): string;
  /** Chats with a running process here. */
  liveChats(): { cwd: string }[];
  /** A headless machine has no owner's folders; This PC does. */
  headless: boolean;
  gitState(cwd: string): Promise<GitState>;
};

type Candidate = { cwd: string; git: GitState | null; running: number };

/** The folder a chat of this repository uses on this machine (§4 "The folder there"). */
export const pickTarget = async (
  d: TargetDeps,
  p: { origin: string | null; repoName: string; branch: string | null },
): Promise<{
  folder: string;
  matched: boolean;
  inUse: { branch: string | null; running: number } | null;
}> => {
  const live = d.liveChats();
  const runningIn = (cwd: string) =>
    live.filter((l) => path.resolve(l.cwd) === path.resolve(cwd)).length;

  const candidates: Candidate[] = [];
  if (p.origin !== null) {
    const want = repoOfUrl(p.origin);
    for (const cwd of d.recentCwds()) {
      const url = await originUrlOf(d.tools, cwd).catch(() => null);
      if (url === null || repoOfUrl(url) !== want) continue;
      // A git failure only costs the folder its preference; it still matches.
      const git = await d.gitState(cwd).catch(() => null);
      candidates.push({ cwd, git, running: runningIn(cwd) });
    }
  }

  const branchOf = (c: Candidate) => (c.git && c.git.kind !== 'notRepo' ? c.git.branch : null);
  const chosen =
    candidates.find((c) => p.branch !== null && branchOf(c) === p.branch) ??
    candidates.find((c) => c.git?.kind === 'clean' && c.running === 0) ??
    candidates[0];
  if (!chosen) {
    return { folder: path.join(d.createIn(), p.repoName), matched: false, inUse: null };
  }

  const branch = branchOf(chosen);
  const otherBranch = branch !== p.branch && chosen.running > 0;
  const ownersUncommitted = !d.headless && chosen.git?.kind === 'dirty';
  return {
    folder: chosen.cwd,
    matched: true,
    inUse: otherBranch || ownersUncommitted ? { branch, running: chosen.running } : null,
  };
};

export type MoveHandlerDeps = {
  host: SessionHost;
  db: Db;
  store: ChatStore;
  target: Omit<TargetDeps, 'liveChats' | 'recentCwds' | 'gitState'>;
};

export const registerMoveHandlers = (router: Router, deps: MoveHandlerDeps): void => {
  const { host, db, store } = deps;
  const targetDeps: TargetDeps = {
    ...deps.target,
    recentCwds: () => db.recentCwds().map((r) => r.cwd),
    liveChats: () => host.list().filter((l) => l.live),
    gitState: (cwd) => gitState(cwd),
  };

  router.register('move.check', async (p) => {
    const s = host.get(p.sessionId);
    const cwd = store.historyOf(p.sessionId).dir ?? s?.cwd ?? db.getSession(p.sessionId)?.cwd;
    if (!cwd) throw new ServiceError('NOT_FOUND', `Unknown chat ${p.sessionId}`);
    return { cwd, busy: s ? busyOf(s) : null, git: await gitState(cwd) };
  });

  router.register('move.target', (p) => pickTarget(targetDeps, p));
};
