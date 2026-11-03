/**
 * Router handlers for moving a chat (protocol 9). On the source: `move.check`,
 * the lock that keeps a chat still while it is exported (ruling R3), the
 * export in parts, `move.abort` and `move.markMoved`. On the target:
 * `move.target`, `move.importPart` and `move.commit`.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  MOVE_ERRORS,
  type ChatStatus,
  type ChatSummary,
  type GitState,
  type MoveBusy,
  type MoveKey,
} from '@threadgarden/protocol';
import type { SessionHost } from '../../chat/session-host.js';
import type { Db } from '../../history/db.js';
import { gitState } from '../../move/git-state.js';
import type { ChatStore } from '../../move/store.js';
import { makeParentFolder } from '../../projects/folders.js';
import { originUrlOf, repoOfUrl, type Tools } from '../../projects/github.js';
import type { AgentAdapter, SessionStore, SessionStoreEntry } from '../../sdk/adapter.js';
import { ServiceError, type Router } from '../router.js';

/** A lock that nobody ended (a desktop that went away) lets go after this long. */
export const MOVE_LOCK_MS = 10 * 60_000;
/** One part of an export holds at most this much JSON (a request may hold 32 MiB). */
export const MOVE_PART_BYTES = 4 * 1024 * 1024;
/** An import holds at most this much JSON until it is committed (`TOO_LARGE`). */
export const MOVE_IMPORT_MAX_BYTES = 512 * 1024 * 1024;
/** An import's parts are kept this long after its last part. */
export const MOVE_IMPORT_MS = 10 * 60_000;
/** A finished export or import is still recognised this long (the desktop retries). */
export const MOVE_RECENT_MS = 60 * 60_000;

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

const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

type Sized = { key: MoveKey; bytes: number };

/**
 * A key as pieces that each fit in a part of `limit` bytes: the key itself
 * when it fits, else runs of its entries under the same subpath, in order.
 * An entry longer than a part goes alone.
 */
const piecesOf = (key: MoveKey, limit: number): Sized[] => {
  const whole = jsonBytes(key);
  if (whole + 2 <= limit) return [{ key, bytes: whole }];
  const head = key.subpath === undefined ? {} : { subpath: key.subpath };
  const empty = jsonBytes({ ...head, entries: [] });
  const out: Sized[] = [];
  let run: MoveKey['entries'] = [];
  let bytes = empty;
  for (const e of key.entries) {
    const size = jsonBytes(e);
    // Inside the part's `[...]`, after a comma when the run is not empty.
    if (run.length > 0 && 2 + bytes + 1 + size > limit) {
      out.push({ key: { ...head, entries: run }, bytes });
      run = [];
      bytes = empty;
    }
    bytes += size + (run.length > 0 ? 1 : 0);
    run.push(e);
  }
  if (run.length > 0) out.push({ key: { ...head, entries: run }, bytes });
  return out;
};

/**
 * A chat's keys as parts of at most `limit` bytes of JSON each (one part is
 * the `keys` array of `move.exportPart`): keys stay whole where they fit, and
 * a longer key's entries are split between parts. Read back in order, every
 * key's entries are the same. No keys make one empty part.
 */
export const splitParts = (keys: MoveKey[], limit: number): MoveKey[][] => {
  const parts: MoveKey[][] = [];
  let part: MoveKey[] = [];
  let size = 2; // `[]`
  for (const piece of keys.flatMap((k) => piecesOf(k, limit))) {
    if (part.length > 0 && size + 1 + piece.bytes > limit) {
      parts.push(part);
      part = [];
      size = 2;
    }
    size += piece.bytes + (part.length > 0 ? 1 : 0);
    part.push(piece.key);
  }
  if (part.length > 0 || parts.length === 0) parts.push(part);
  return parts;
};

const expired = (what: string) =>
  new ServiceError(MOVE_ERRORS.expired, `${what} is gone; start the move again`);

type Import = {
  sessionId: string;
  parts: number;
  received: Map<number, { keys: MoveKey[]; bytes: number }>;
  bytes: number;
  at: number;
};

/** The parts of the imports on their way here (target side), until they are committed. */
export class MoveImports {
  private readonly open = new Map<string, Import>();
  /** Committed imports: a retried commit (its answer was lost) succeeds again. */
  private readonly done = new Map<string, { sessionId: string; at: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxBytes: number = MOVE_IMPORT_MAX_BYTES,
  ) {}

  /** Keeps one part (a part sent again replaces the first copy). */
  add(p: {
    importId: string;
    sessionId: string;
    index: number;
    parts: number;
    keys: MoveKey[];
  }): void {
    this.sweep();
    if (this.done.get(p.importId)?.sessionId === p.sessionId) return;
    if (p.parts < 1 || p.index < 0 || p.index >= p.parts) {
      throw new ServiceError('INVALID_PARAMS', `No part ${p.index} of ${p.parts}`);
    }
    let imp = this.open.get(p.importId);
    if (!imp) {
      imp = { sessionId: p.sessionId, parts: p.parts, received: new Map(), bytes: 0, at: 0 };
      this.open.set(p.importId, imp);
    } else if (imp.sessionId !== p.sessionId || imp.parts !== p.parts) {
      throw new ServiceError('INVALID_PARAMS', 'This part belongs to another import');
    }
    const bytes = jsonBytes(p.keys);
    const total = imp.bytes - (imp.received.get(p.index)?.bytes ?? 0) + bytes;
    if (total > this.maxBytes) {
      this.open.delete(p.importId);
      throw new ServiceError(MOVE_ERRORS.tooLarge, 'This chat is too large to move');
    }
    imp.received.set(p.index, { keys: p.keys, bytes });
    imp.bytes = total;
    imp.at = this.now();
  }

  /** Every key of a complete import, part by part; `EXPIRED` when a part is missing. */
  complete(importId: string, sessionId: string): MoveKey[] {
    this.sweep();
    const imp = this.open.get(importId);
    if (!imp || imp.sessionId !== sessionId || imp.received.size < imp.parts) {
      throw expired('Part of this move');
    }
    return Array.from({ length: imp.parts }, (_, i) => imp.received.get(i)!.keys).flat();
  }

  /** The import is in the store: its parts go. */
  committed(importId: string, sessionId: string): void {
    this.open.delete(importId);
    this.done.set(importId, { sessionId, at: this.now() });
  }

  wasCommitted(importId: string, sessionId: string): boolean {
    this.sweep();
    return this.done.get(importId)?.sessionId === sessionId;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, imp] of this.open) if (now - imp.at >= MOVE_IMPORT_MS) this.open.delete(id);
    for (const [id, d] of this.done) if (now - d.at >= MOVE_RECENT_MS) this.done.delete(id);
  }
}

/**
 * The exports of the chats moving away (source side). An export's parts live
 * as long as its lock; which chat an export was is remembered for an hour,
 * so a late `move.markMoved` (retried by the desktop) still finds it.
 */
class MoveExports {
  private readonly parts = new Map<string, { sessionId: string; parts: MoveKey[][] }>();
  private readonly sessions = new Map<string, { sessionId: string; at: number }>();

  constructor(
    private readonly locks: MoveLocks,
    private readonly now: () => number,
  ) {}

  begin(exportId: string, sessionId: string, parts: MoveKey[][]): void {
    this.sweep();
    this.parts.set(exportId, { sessionId, parts });
    this.sessions.set(exportId, { sessionId, at: this.now() });
  }

  /** The parts of an export whose lock still holds. */
  partsOf(exportId: string): MoveKey[][] | undefined {
    this.sweep();
    return this.parts.get(exportId)?.parts;
  }

  /** The chat of an export begun within the hour. */
  sessionOf(exportId: string): string | undefined {
    this.sweep();
    return this.sessions.get(exportId)?.sessionId;
  }

  drop(exportId: string): void {
    this.parts.delete(exportId);
  }

  private sweep(): void {
    for (const [id, e] of this.parts) {
      if (this.locks.exportIdOf(e.sessionId) !== id) this.parts.delete(id);
    }
    const now = this.now();
    for (const [id, s] of this.sessions) if (now - s.at >= MOVE_RECENT_MS) this.sessions.delete(id);
  }
}

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
    // A clone where New project would put it may have no chats here yet.
    const usual = path.join(d.createIn(), p.repoName);
    const cwds = d.recentCwds();
    if (!cwds.some((c) => path.resolve(c) === path.resolve(usual))) cwds.push(usual);
    for (const cwd of cwds) {
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
  adapter: AgentAdapter;
  locks: MoveLocks;
  catalog: { invalidate(): void; summary(sessionId: string): ChatSummary | undefined };
  index: { refresh(sessionIds: string[]): Promise<void> };
  /** `chat.end`'s path: ends the host's session of a chat and drops its cached view. */
  release(sessionId: string): void;
  now?: () => number;
  target: Omit<TargetDeps, 'liveChats' | 'recentCwds' | 'gitState'>;
};

const BUSY_TEXT: Record<MoveBusy, string> = {
  turn: 'This chat is in the middle of a turn',
  prompt: 'This chat is waiting for an answer',
  subagents: 'This chat has background tasks running',
};

export const registerMoveHandlers = (router: Router, deps: MoveHandlerDeps): void => {
  const { host, db, store, adapter, locks, catalog, index, release } = deps;
  const now = deps.now ?? Date.now;
  const exports = new MoveExports(locks, now);
  const imports = new MoveImports(now);
  const targetDeps: TargetDeps = {
    ...deps.target,
    recentCwds: () => db.recentCwds().map((r) => r.cwd),
    liveChats: () => host.list().filter((l) => l.live),
    gitState: (cwd) => gitState(cwd),
  };

  /** A chat's local transcript and its subagents', through the SDK's import into memory. */
  const importedKeys = async (sessionId: string, dir: string | undefined): Promise<MoveKey[]> => {
    const bySubpath = new Map<string, SessionStoreEntry[]>();
    const memory: SessionStore = {
      append: (key, entries) => {
        const subpath = key.subpath ?? '';
        const list = bySubpath.get(subpath) ?? [];
        for (const e of entries) list.push(e);
        bySubpath.set(subpath, list);
        return Promise.resolve();
      },
      load: () => Promise.resolve(null),
    };
    await adapter.importSession(sessionId, memory, {
      ...(dir === undefined ? {} : { dir }),
      includeSubagents: true,
    });
    // The main transcript ('') first, as the store lists them.
    return [...bySubpath]
      .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
      .map(([subpath, entries]) => (subpath === '' ? { entries } : { subpath, entries }));
  };

  router.register('move.check', async (p) => {
    const s = host.get(p.sessionId);
    const cwd = store.historyOf(p.sessionId).dir ?? s?.cwd ?? db.getSession(p.sessionId)?.cwd;
    if (!cwd) throw new ServiceError('NOT_FOUND', `Unknown chat ${p.sessionId}`);
    return { cwd, busy: s ? busyOf(s) : null, git: await gitState(cwd) };
  });

  router.register('move.target', (p) => pickTarget(targetDeps, p));

  router.register('move.exportBegin', async (p) => {
    const id = p.sessionId;
    if (store.isAway(id)) {
      const to = store.awayTo(id)?.name ?? 'another machine';
      throw new ServiceError(MOVE_ERRORS.moved, `This chat moved to ${to}`);
    }
    // A chat moved here before is exported from the store (R6).
    const here = store.isHere(id);
    const row = db.getSession(id);
    if (!here && !host.get(id) && !row) {
      throw new ServiceError(MOVE_ERRORS.notFound, `Unknown chat ${id}`);
    }
    // Where the local transcript is looked for (all projects when unknown).
    const cwd = host.get(id)?.cwd ?? row?.cwd ?? undefined;
    if (locks.isLocked(id)) {
      throw new ServiceError(MOVE_ERRORS.moving, 'This chat is already being moved');
    }
    const exportId = randomUUID();
    // Locked first, then checked: no turn can start between the check and the export.
    locks.lock(id, exportId);
    try {
      const s = host.get(id);
      const busy = s ? busyOf(s) : null;
      if (busy) throw new ServiceError(MOVE_ERRORS.busy, BUSY_TEXT[busy]);
      const keys = here ? store.entries(id) : await importedKeys(id, cwd);
      if (keys.every((k) => k.entries.length === 0)) {
        throw new ServiceError(MOVE_ERRORS.notFound, `Chat ${id} has no history to move`);
      }
      const parts = splitParts(keys, MOVE_PART_BYTES);
      exports.begin(exportId, id, parts);
      return {
        exportId,
        parts: parts.length,
        bytes: parts.reduce((n, part) => n + jsonBytes(part), 0),
      };
    } catch (err) {
      if (locks.exportIdOf(id) === exportId) locks.unlock(id);
      throw err;
    }
  });

  router.register('move.exportPart', async (p) => {
    const parts = exports.partsOf(p.exportId);
    if (!parts) throw expired('This export');
    const keys = parts[p.index];
    if (!keys) throw new ServiceError('INVALID_PARAMS', `No part ${p.index} of ${parts.length}`);
    return { keys };
  });

  router.register('move.abort', async (p) => {
    const id = exports.sessionOf(p.exportId);
    if (id !== undefined && locks.exportIdOf(id) === p.exportId) locks.unlock(id);
    exports.drop(p.exportId);
    return {};
  });

  router.register('move.markMoved', async (p) => {
    // Found even after the export expired: the target has the chat by now (R2).
    const id = exports.sessionOf(p.exportId);
    if (id === undefined) throw expired('This move');
    if (!store.isAway(id)) store.markAway(id, p.to);
    // A stale Claude process must never answer here.
    release(id);
    if (locks.exportIdOf(id) === p.exportId) locks.unlock(id);
    exports.drop(p.exportId);
    catalog.invalidate();
    return {};
  });

  router.register('move.importPart', async (p) => {
    imports.add(p);
    return {};
  });

  router.register('move.commit', async (p) => {
    const id = p.sessionId;
    if (!imports.wasCommitted(p.importId, id)) {
      const keys = imports.complete(p.importId, id);
      await makeParentFolder(p.cwd);
      // A process started from an older copy here must not keep writing it.
      release(id);
      store.replace(id, keys);
      store.markHere(id, p.cwd, p.from);
      imports.committed(p.importId, id);
      catalog.invalidate();
    }
    await index.refresh([id]);
    catalog.invalidate();
    const summary = catalog.summary(id);
    if (!summary) throw new ServiceError(MOVE_ERRORS.notFound, `Chat ${id} could not be listed`);
    return { summary };
  });
};
