/**
 * v1.1 §4 project list support: telling clients when live activity reorders
 * the projects (throttled), and the cached "does this project folder still
 * exist" check behind the Missing folders group.
 *
 * The folder check only `stat`s project paths (the user's own folders); it
 * never reads anything, and never anything under Claude Code's config dir.
 */
import { stat } from 'node:fs/promises';
import type { Timers } from '../chat/live-session.js';

/** At most one project-order check (and `projects.changed`) per this many ms. */
export const PROJECT_ORDER_THROTTLE_MS = 1_000;

export type ProjectOrderNotifierOptions = {
  /** True when the project order differs from what clients last got (`Catalog.projectOrderChanged`). */
  changed: () => boolean;
  /** Sends `projects.changed`. */
  emit: () => void;
  timers: Timers;
  now: () => number;
  onError?: (err: unknown, context: string) => void;
};

/**
 * Live chats report activity all the time (every streamed delta); this turns
 * that into at most one order check per `PROJECT_ORDER_THROTTLE_MS`, run off
 * the caller's stack, and emits only when the order actually changed.
 */
export class ProjectOrderNotifier {
  private timer: unknown = undefined;
  private lastRun = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(private readonly o: ProjectOrderNotifierOptions) {}

  /** A live chat did something. Cheap: schedules a check unless one is pending. */
  notify(): void {
    if (this.disposed || this.timer !== undefined) return;
    const wait = Math.max(0, this.lastRun + PROJECT_ORDER_THROTTLE_MS - this.o.now());
    this.timer = this.o.timers.setTimeout(() => {
      this.timer = undefined;
      this.lastRun = this.o.now();
      try {
        if (this.o.changed()) this.o.emit();
      } catch (err) {
        this.o.onError?.(err, 'project order check');
      }
    }, wait);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer === undefined) return;
    this.o.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** A cached folder older than this is checked again when next asked about. */
export const FOLDER_RECHECK_MS = 60_000;

/**
 * Whether `path` is an existing directory. Only a missing path (or a non-directory)
 * counts as gone; any other failure (permissions, a slow network drive) is
 * reported as existing, so a folder never moves to Missing folders on a guess.
 */
export const folderExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return !(code === 'ENOENT' || code === 'ENOTDIR');
  }
};

export type FolderCheckOptions = {
  /** Default `folderExists`. */
  stat?: (path: string) => Promise<boolean>;
  now?: () => number;
  /** Called when answers changed (coalesced per tick) → `projects.changed`. */
  onChange: () => void;
  onError?: (err: unknown, context: string) => void;
};

/** Most folder checks in flight at once (each holds a libuv threadpool thread). */
export const MAX_FOLDER_CHECKS = 2;

/**
 * The volume a path lives on, for one-check-at-a-time per volume: a drive
 * letter, a UNC share (`\\server\share`), or on POSIX the first two
 * directories (`/mnt/nas`, `/Volumes/Share`, `/home/me`).
 */
export const volumeOf = (path: string): string => {
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(path);
  if (unc) return `//${unc[1]}/${unc[2]}`.toLowerCase();
  const drive = /^([A-Za-z]):/.exec(path);
  if (drive) return `${drive[1]!.toLowerCase()}:`;
  const top = /^\/+([^/]+)(?:\/+([^/]+))?/.exec(path);
  return top ? `/${top[1]}${top[2] === undefined ? '' : `/${top[2]}`}` : path;
};

type Cached = { exists: boolean; checkedAt: number };

/**
 * Per-path cache of `folderExists`. `exists()` answers at once from the
 * cache (an unknown path counts as existing) and queues a background check
 * for paths unknown or older than `FOLDER_RECHECK_MS`.
 *
 * Network drives can make a `stat` hang for a long time, so checks run at
 * most `MAX_FOLDER_CHECKS` at a time and one at a time per volume, and each
 * answer is cached as soon as it arrives: a hung share holds one slot and its
 * own folders (which keep their last answer), while the other folders are
 * checked through the remaining slot. A path is never checked twice at once.
 */
export class FolderCheck {
  private readonly cache = new Map<string, Cached>();
  /** Queued paths (in order) → callbacks to run when their check settles. */
  private readonly waiting = new Map<string, (() => void)[]>();
  private readonly running = new Map<string, (() => void)[]>();
  private readonly busyVolumes = new Set<string>();
  private changePending = false;
  private readonly stat: (path: string) => Promise<boolean>;
  private readonly now: () => number;

  constructor(private readonly o: FolderCheckOptions) {
    this.stat = o.stat ?? folderExists;
    this.now = o.now ?? Date.now;
  }

  exists(path: string): boolean {
    const c = this.cache.get(path);
    if (!c || this.now() - c.checkedAt >= FOLDER_RECHECK_MS) void this.check(path);
    return c?.exists ?? true;
  }

  /** Checks `paths` now (e.g. after a sync), whatever their age; settles when all have answered. */
  async refresh(paths: readonly string[]): Promise<void> {
    await Promise.all([...new Set(paths)].map((p) => this.check(p)));
  }

  /** Queues a check of `path` (joining one queued or in flight); settles when it has answered. */
  private check(path: string): Promise<void> {
    return new Promise((resolve) => {
      const joined = this.running.get(path) ?? this.waiting.get(path);
      if (joined) {
        joined.push(resolve);
        return;
      }
      this.waiting.set(path, [resolve]);
      this.pump();
    });
  }

  /** Starts queued checks while a slot is free, skipping paths whose volume is busy. */
  private pump(): void {
    for (const [path, done] of this.waiting) {
      if (this.running.size >= MAX_FOLDER_CHECKS) return;
      const volume = volumeOf(path);
      if (this.busyVolumes.has(volume)) continue;
      this.waiting.delete(path);
      this.start(path, volume, done);
    }
  }

  private start(path: string, volume: string, done: (() => void)[]): void {
    this.running.set(path, done);
    this.busyVolumes.add(volume);
    let answer: Promise<boolean>;
    try {
      answer = this.stat(path);
    } catch (err) {
      answer = Promise.reject(err);
    }
    void answer
      .catch((err: unknown) => {
        this.o.onError?.(err, `folder check ${path}`);
        return true;
      })
      .then((exists) => {
        const before = this.cache.get(path)?.exists ?? true;
        this.cache.set(path, { exists, checkedAt: this.now() });
        this.running.delete(path);
        this.busyVolumes.delete(volume);
        if (before !== exists) this.changed();
        for (const d of done) d();
        this.pump();
      });
  }

  /** Answers arriving in the same tick give one `onChange`. */
  private changed(): void {
    if (this.changePending) return;
    this.changePending = true;
    queueMicrotask(() => {
      this.changePending = false;
      try {
        this.o.onChange();
      } catch (err) {
        this.o.onError?.(err, 'folder check change');
      }
    });
  }
}
