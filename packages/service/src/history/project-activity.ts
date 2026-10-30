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
  /** Called once per check batch whose answers differ from the cached ones (→ `projects.changed`). */
  onChange: () => void;
  onError?: (err: unknown, context: string) => void;
};

type Cached = { exists: boolean; checkedAt: number };

/**
 * Per-path cache of `folderExists`. `exists()` answers at once from the
 * cache (an unknown path counts as existing) and queues a background check
 * for paths unknown or older than `FOLDER_RECHECK_MS`; checks queued together
 * run as one batch, and `onChange` fires once if any answer changed.
 */
export class FolderCheck {
  private readonly cache = new Map<string, Cached>();
  private readonly queued = new Set<string>();
  private readonly inFlight = new Set<string>();
  private scheduled = false;
  private readonly stat: (path: string) => Promise<boolean>;
  private readonly now: () => number;

  constructor(private readonly o: FolderCheckOptions) {
    this.stat = o.stat ?? folderExists;
    this.now = o.now ?? Date.now;
  }

  exists(path: string): boolean {
    const c = this.cache.get(path);
    if (!c || this.now() - c.checkedAt >= FOLDER_RECHECK_MS) this.queue(path);
    return c?.exists ?? true;
  }

  /** Checks `paths` now (e.g. after a sync), whatever their age. */
  refresh(paths: readonly string[]): Promise<void> {
    return this.run([...new Set(paths)]);
  }

  private queue(path: string): void {
    if (this.inFlight.has(path)) return;
    this.queued.add(path);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const paths = [...this.queued];
      this.queued.clear();
      void this.run(paths);
    });
  }

  private async run(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    for (const p of paths) this.inFlight.add(p);
    let changed = false;
    try {
      const answers = await Promise.all(
        paths.map((p) =>
          this.stat(p).then(
            (exists) => ({ p, exists }),
            (err: unknown) => {
              this.o.onError?.(err, `folder check ${p}`);
              return { p, exists: true };
            },
          ),
        ),
      );
      const at = this.now();
      for (const { p, exists } of answers) {
        const before = this.cache.get(p)?.exists ?? true;
        if (before !== exists) changed = true;
        this.cache.set(p, { exists, checkedAt: at });
      }
    } finally {
      for (const p of paths) this.inFlight.delete(p);
    }
    if (!changed) return;
    try {
      this.o.onChange();
    } catch (err) {
      this.o.onError?.(err, 'folder check change');
    }
  }
}
