/**
 * Router handlers for moving a chat (protocol 9). On the source: `move.check`,
 * the lock that keeps a chat still while it is exported (ruling R3), the
 * export in parts, `move.abort` and `move.markMoved`. On the target:
 * `move.target`, `move.importPart` and `move.commit`.
 */
import path from 'node:path';
import {
  MOVE_ERRORS,
  type ChatStatus,
  type ChatSummary,
  type GitState,
  type MoveBusy,
  type MoveKey,
} from '@threadgarden/protocol';
import { realTimers, type Timers } from '../../chat/live-session.js';
import type { SessionHost } from '../../chat/session-host.js';
import type { ResumeCheck } from '../../external/resume-safety.js';
import type { Db } from '../../history/db.js';
import { gitState } from '../../move/git-state.js';
import type { ChatStore } from '../../move/store.js';
import { makeChatFolder } from '../../projects/folders.js';
import { originUrlOf, repoOfUrl, type Tools } from '../../projects/github.js';
import type { AgentAdapter, SessionStore, SessionStoreEntry } from '../../sdk/adapter.js';
import { ServiceError, type Router } from '../router.js';
import { END_INDEX_WAIT_MS } from './chat.js';

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
/** How often expired exports and imports are let go of, move calls or not. */
export const MOVE_SWEEP_MS = 60_000;

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

/**
 * The parts of the imports on their way here (target side), until they are
 * committed. All open imports together hold at most `maxBytes`.
 */
export class MoveImports {
  private readonly open = new Map<string, Import>();
  /** Committed imports: a retried commit (its answer was lost) succeeds again. */
  private readonly done = new Map<string, { sessionId: string; at: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxBytes: number = MOVE_IMPORT_MAX_BYTES,
  ) {}

  /** The bytes of JSON the open imports hold. */
  bytesHeld(): number {
    let n = 0;
    for (const imp of this.open.values()) n += imp.bytes;
    return n;
  }

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
    const replaced = imp.received.get(p.index)?.bytes ?? 0;
    const total = imp.bytes - replaced + bytes;
    if (this.bytesHeld() - replaced + bytes > this.maxBytes) {
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

  /** Lets go of the imports that ran out. */
  sweep(): void {
    const now = this.now();
    for (const [id, imp] of this.open) if (now - imp.at >= MOVE_IMPORT_MS) this.open.delete(id);
    for (const [id, d] of this.done) if (now - d.at >= MOVE_RECENT_MS) this.done.delete(id);
  }
}

type Export = { sessionId: string; parts: MoveKey[][]; bytes: number };

/**
 * The exports of the chats moving away (source side). An export's parts live
 * as long as its lock. Which chat an export was, and when it began, is kept
 * for an hour, so a late `move.markMoved` (retried by the desktop) still
 * finds it; unless the chat came back here meanwhile (`supersede`).
 */
export class MoveExports {
  private readonly held = new Map<string, Export>();
  private readonly begun = new Map<string, { sessionId: string; at: number }>();
  /** Exports of chats that came back here since: their markMoved changes nothing. */
  private readonly superseded = new Map<string, number>();

  constructor(
    private readonly locks: MoveLocks,
    private readonly now: () => number,
  ) {}

  /** The export locked the chat at `at` and gathers its keys (`move.abort` finds it now). */
  started(exportId: string, sessionId: string, at: number): void {
    this.sweep();
    this.begun.set(exportId, { sessionId, at });
  }

  /** The export is ready; `at` is when it locked the chat. */
  begin(exportId: string, sessionId: string, parts: MoveKey[][], bytes: number, at = this.now()) {
    this.sweep();
    this.held.set(exportId, { sessionId, parts, bytes });
    this.begun.set(exportId, { sessionId, at });
  }

  /** An export whose lock still holds. */
  get(exportId: string): Export | undefined {
    this.sweep();
    return this.held.get(exportId);
  }

  /** The chat of an export begun within the hour, and when it began. */
  begunOf(exportId: string): { sessionId: string; at: number } | undefined {
    this.sweep();
    return this.begun.get(exportId);
  }

  isSuperseded(exportId: string): boolean {
    this.sweep();
    return this.superseded.has(exportId);
  }

  /** The chat came back here: every earlier export of it is over. */
  supersede(sessionId: string): void {
    for (const [id, b] of this.begun) {
      if (b.sessionId !== sessionId) continue;
      this.begun.delete(id);
      this.held.delete(id);
      this.superseded.set(id, this.now());
    }
  }

  drop(exportId: string): void {
    this.held.delete(exportId);
  }

  /** The bytes of JSON the exports hold. */
  bytesHeld(): number {
    let n = 0;
    for (const e of this.held.values()) n += e.bytes;
    return n;
  }

  /** Lets go of the exports whose lock ran out or ended. */
  sweep(): void {
    for (const [id, e] of this.held) {
      if (this.locks.exportIdOf(e.sessionId) !== id) this.held.delete(id);
    }
    const now = this.now();
    for (const [id, b] of this.begun) if (now - b.at >= MOVE_RECENT_MS) this.begun.delete(id);
    for (const [id, at] of this.superseded)
      if (now - at >= MOVE_RECENT_MS) this.superseded.delete(id);
  }
}

/** The exports and imports of a service, swept every `MOVE_SWEEP_MS` even with no move calls. */
export class MoveTransfers {
  readonly imports: MoveImports;
  readonly exports: MoveExports;
  private readonly timer: unknown;

  constructor(
    private readonly o: { locks: MoveLocks; now: () => number; timers: Timers; maxBytes?: number },
  ) {
    this.imports = new MoveImports(o.now, o.maxBytes ?? MOVE_IMPORT_MAX_BYTES);
    this.exports = new MoveExports(o.locks, o.now);
    this.timer = o.timers.setInterval(() => {
      this.imports.sweep();
      this.exports.sweep();
    }, MOVE_SWEEP_MS);
  }

  bytesHeld(): number {
    return this.imports.bytesHeld() + this.exports.bytesHeld();
  }

  close(): void {
    this.o.timers.clearInterval(this.timer);
  }
}

/** The read-only git a move runs: a folder's state, and its own repo's origin URL (null: none). */
export type MoveGit = {
  state(cwd: string): Promise<GitState>;
  originUrl(cwd: string): Promise<string | null>;
};

export type TargetDeps = {
  originUrl: MoveGit['originUrl'];
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
      const url = await d.originUrl(cwd).catch(() => null);
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
  /** Tells the clients these chats changed (`sessions.changed`). */
  changed(sessionIds: string[]): void;
  /** Resume safety (§4.4): `blocked` is a chat a Claude Code process outside Threadgarden runs. */
  resumeCheck(sessionId: string): Promise<ResumeCheck>;
  /** This machine's name, as a refused commit says it. */
  machineName(): string;
  /** Claude Code's config dir: a moved chat's folder is never made in it. */
  claudeConfigDir: string;
  now?: () => number;
  /** For the sweep of expired exports and imports (default Node timers, unref'd). */
  timers?: Timers;
  /** The largest chat a move carries, and what all imports here hold together. */
  maxBytes?: number;
  /** `tools` runs git for the default `git`. */
  target: { tools: Tools } & Pick<TargetDeps, 'createIn' | 'headless'>;
  /** Git as a move reads it (default: the real git, read-only); the mock service fakes it. */
  git?: MoveGit;
  /** Whether a folder exists, before a moved chat's folder is made (default `fs.stat`). */
  folderExists?: (p: string) => Promise<boolean>;
};

type Begun = { exportId: string; parts: number; bytes: number };

const BUSY_TEXT: Record<MoveBusy, string> = {
  turn: 'This chat is in the middle of a turn',
  prompt: 'This chat is waiting for an answer',
  subagents: 'This chat has background tasks running',
  terminal: 'This chat is running in a terminal',
};

/**
 * Registers the move methods; `close` stops the sweep (service shutdown).
 * `forgetAll` forgets every move, as if none had happened: the mock service's
 * test reset, never reached by a client of the real service.
 */
export const registerMoveHandlers = (
  router: Router,
  deps: MoveHandlerDeps,
): { close(): void; forgetAll(): Promise<void> } => {
  const { host, db, store, adapter, locks, catalog, index, release } = deps;
  const now = deps.now ?? Date.now;
  const maxBytes = deps.maxBytes ?? MOVE_IMPORT_MAX_BYTES;
  const transfers = new MoveTransfers({
    locks,
    now,
    timers: deps.timers ?? realTimers,
    maxBytes,
  });
  const { exports, imports } = transfers;
  /** Exports still gathering their keys: the same exportId again waits for the same answer. */
  const pending = new Map<string, Promise<Begun>>();
  /** The chat had activity here after `since` (a turn, a store append, a newer transcript). */
  const activeSince = (sessionId: string, since: number): boolean => {
    const moved = db.getMovedChat(sessionId);
    const latest = Math.max(
      host.get(sessionId)?.lastActivity ?? 0,
      db.getSession(sessionId)?.lastModified ?? 0,
      moved?.state === 'here' ? moved.at : 0,
    );
    return latest > since;
  };
  const git: MoveGit = deps.git ?? {
    state: (cwd) => gitState(cwd),
    originUrl: (cwd) => originUrlOf(deps.target.tools, cwd),
  };
  const targetDeps: TargetDeps = {
    createIn: deps.target.createIn,
    headless: deps.target.headless,
    originUrl: git.originUrl,
    recentCwds: () => db.recentCwds().map((r) => r.cwd),
    liveChats: () => host.list().filter((l) => l.live),
    gitState: git.state,
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

  /**
   * What keeps the chat from moving now: Threadgarden's own process of it, or
   * (when Threadgarden runs none) a Claude Code process in a terminal.
   */
  const busyNow = async (sessionId: string): Promise<MoveBusy | null> => {
    const s = host.get(sessionId);
    const busy = s ? busyOf(s) : null;
    if (busy || s?.live) return busy;
    return (await deps.resumeCheck(sessionId)).status === 'blocked' ? 'terminal' : null;
  };

  router.register('move.check', async (p) => {
    const s = host.get(p.sessionId);
    const cwd = store.historyOf(p.sessionId).dir ?? s?.cwd ?? db.getSession(p.sessionId)?.cwd;
    if (!cwd) throw new ServiceError('NOT_FOUND', `Unknown chat ${p.sessionId}`);
    return { cwd, busy: await busyNow(p.sessionId), git: await git.state(cwd) };
  });

  router.register('move.target', (p) => pickTarget(targetDeps, p));

  /** Gathers a locked chat's keys into parts (the lock is taken by the caller). */
  const exportChat = async (id: string, exportId: string, at: number): Promise<Begun> => {
    // Checked after the lock: no turn can start between the check and the export.
    const s = host.get(id);
    const busy = await busyNow(id);
    if (busy) throw new ServiceError(MOVE_ERRORS.busy, BUSY_TEXT[busy]);
    // A chat moved here before is exported from the store (R6).
    const keys = store.isHere(id)
      ? store.entries(id)
      : // Where the local transcript is looked for (all projects when unknown).
        await importedKeys(id, s?.cwd ?? db.getSession(id)?.cwd ?? undefined);
    if (keys.every((k) => k.entries.length === 0)) {
      throw new ServiceError(MOVE_ERRORS.notFound, `Chat ${id} has no history to move`);
    }
    const parts = splitParts(keys, MOVE_PART_BYTES);
    const bytes = parts.reduce((n, part) => n + jsonBytes(part), 0);
    if (bytes > maxBytes) {
      throw new ServiceError(MOVE_ERRORS.tooLarge, 'This chat is too large to move');
    }
    // Aborted (or the lock ran out) while the keys were gathered: nothing to hand out.
    if (locks.exportIdOf(id) !== exportId) throw expired('This export');
    exports.begin(exportId, id, parts, bytes, at);
    return { exportId, parts: parts.length, bytes };
  };

  router.register('move.exportBegin', async (p) => {
    const { sessionId: id, exportId } = p;
    const held = locks.exportIdOf(id);
    if (held === exportId) {
      // The same export again (its answer was lost): the same answer.
      const running = pending.get(exportId);
      if (running) return running;
      const e = exports.get(exportId);
      if (e) return { exportId, parts: e.parts.length, bytes: e.bytes };
    }
    if (store.isAway(id)) {
      const to = store.awayTo(id)?.name ?? 'another machine';
      throw new ServiceError(MOVE_ERRORS.moved, `This chat moved to ${to}`);
    }
    if (!store.isHere(id) && !host.get(id) && !db.getSession(id)) {
      throw new ServiceError(MOVE_ERRORS.notFound, `Unknown chat ${id}`);
    }
    if (held !== undefined) {
      throw new ServiceError(MOVE_ERRORS.moving, 'This chat is already being moved');
    }
    const other = exports.begunOf(exportId);
    if (other && other.sessionId !== id) {
      throw new ServiceError('INVALID_PARAMS', 'This exportId belongs to another chat');
    }
    const at = now();
    locks.lock(id, exportId);
    exports.started(exportId, id, at);
    const run = exportChat(id, exportId, at).catch((err: unknown) => {
      if (locks.exportIdOf(id) === exportId) locks.unlock(id);
      throw err;
    });
    pending.set(exportId, run);
    try {
      return await run;
    } finally {
      pending.delete(exportId);
    }
  });

  router.register('move.exportPart', async (p) => {
    const e = exports.get(p.exportId);
    if (!e) throw expired('This export');
    const keys = e.parts[p.index];
    if (!keys) throw new ServiceError('INVALID_PARAMS', `No part ${p.index} of ${e.parts.length}`);
    return { keys };
  });

  router.register('move.abort', async (p) => {
    const id = exports.begunOf(p.exportId)?.sessionId;
    if (id !== undefined && locks.exportIdOf(id) === p.exportId) locks.unlock(id);
    exports.drop(p.exportId);
    return {};
  });

  /**
   * The target has the chat by now (R2). Works without the export in memory
   * (a restart, or past the hour), from the chat's own record and `begunAt`.
   */
  router.register('move.markMoved', async (p) => {
    const { exportId, sessionId: id } = p;
    // A late retry after the chat came back here: it stays, untouched.
    if (exports.isSuperseded(exportId)) return {};
    const begun = exports.begunOf(exportId);
    if (begun && begun.sessionId !== id) {
      throw new ServiceError('INVALID_PARAMS', 'This exportId belongs to another chat');
    }
    // This service's own record of when the move began wins over the desktop's clock.
    const since = begun?.at ?? p.begunAt;
    const row = db.getMovedChat(id);
    // It came back here after this move began (the in-memory guard is gone after a restart).
    if (row?.state === 'here' && row.cameAt !== null && row.cameAt > since) return {};
    if (row?.state !== 'away') {
      if (!row && !host.get(id) && !db.getSession(id)) {
        throw new ServiceError(MOVE_ERRORS.notFound, `Unknown chat ${id}`);
      }
      const held = locks.exportIdOf(id);
      if (held !== undefined && held !== exportId) {
        throw new ServiceError(MOVE_ERRORS.moving, 'This chat is being moved again');
      }
      // Past its lock the chat may have gone on here: those turns must not be hidden.
      if (held !== exportId && activeSince(id, since)) {
        throw new ServiceError(
          MOVE_ERRORS.expired,
          'This chat went on here after the move began; it stays here',
        );
      }
      store.markAway(id, p.to);
    }
    // A stale Claude process must never answer here.
    release(id);
    if (locks.exportIdOf(id) === p.exportId) locks.unlock(id);
    exports.drop(p.exportId);
    catalog.invalidate();
    deps.changed([id]);
    return {};
  });

  router.register('move.importPart', async (p) => {
    imports.add(p);
    return {};
  });

  /**
   * Waits (at most `END_INDEX_WAIT_MS`) for the chat to be indexed: the index
   * queue may be in a long full sync. Past the cap it is indexed afterwards.
   */
  const indexSoon = async (id: string): Promise<void> => {
    const timers = deps.timers ?? realTimers;
    let timer: unknown;
    const capped = new Promise<void>((resolve) => {
      timer = timers.setTimeout(resolve, END_INDEX_WAIT_MS);
    });
    // A failed refresh only delays the listing: the next sync indexes it.
    const indexed = index.refresh([id]).catch(() => {});
    try {
      await Promise.race([indexed, capped]);
    } finally {
      timers.clearTimeout(timer);
    }
  };

  /**
   * The target takes the chat. Only a chat this machine has no copy of, or
   * holds as `away`, is taken: one that lives here, or a local chat here
   * that never moved away, would be overwritten (a duplicate after a failed
   * hand-off must never delete newer history).
   */
  router.register('move.commit', async (p) => {
    const id = p.sessionId;
    if (!imports.wasCommitted(p.importId, id)) {
      const row = db.getMovedChat(id);
      const ownHere =
        row?.state === 'here' ||
        (row?.state !== 'away' && (db.getSession(id) !== undefined || host.get(id) !== undefined));
      if (ownHere) {
        throw new ServiceError(
          MOVE_ERRORS.already,
          `This chat is already on ${deps.machineName()}`,
        );
      }
      const keys = imports.complete(p.importId, id);
      await makeChatFolder(p.cwd, deps.claudeConfigDir, deps.folderExists);
      // A process started from an older copy here must not keep writing it.
      release(id);
      store.replace(id, keys);
      store.markHere(id, p.cwd, p.from);
      // A late markMoved of an earlier move away from here must not hide it again.
      exports.supersede(id);
      imports.committed(p.importId, id);
      catalog.invalidate();
    }
    await indexSoon(id);
    catalog.invalidate();
    return { summary: catalog.summary(id) ?? null };
  });

  const forgetAll = async (): Promise<void> => {
    const ids = [...db.listMovedChats('here'), ...db.listMovedChats('away')].map(
      (c) => c.sessionId,
    );
    for (const id of ids) {
      locks.unlock(id);
      release(id);
      db.forgetMovedChat(id);
    }
    if (ids.length === 0) return;
    // A chat that only ever lived here in the store is gone; the others are local chats again.
    const local: string[] = [];
    for (const id of ids) {
      if (await adapter.getSessionInfo(id)) local.push(id);
      else db.deleteSession(id);
    }
    await index.refresh(local);
    catalog.invalidate();
    deps.changed(ids);
  };

  return { close: () => transfers.close(), forgetAll };
};
