/**
 * Watches Claude Code's `projects` directory for transcript changes (spec §5.1).
 * It only listens for file-system events: it never opens, reads or stats a
 * transcript. Event names `<project>/<sessionId>.jsonl` map to session ids;
 * everything else (other files, nested subagent logs) is ignored.
 */
import fs from 'node:fs';

export type WatchOptions = {
  /** Events within this window are reported together. Default 500 ms. */
  debounceMs?: number;
  /** How often to look for a directory that does not exist yet / was removed. Default 3 s. */
  retryMs?: number;
  onError?: (err: unknown) => void;
};

const SEP = /[\\/]/;
const EXT = '.jsonl';

/** `<project>/<id>.jsonl` (or a bare `<id>.jsonl`) → id; anything else → undefined. */
export const sessionIdFromPath = (name: string): string | undefined => {
  const parts = name.split(SEP).filter(Boolean);
  const file = parts.at(-1);
  if (!file || parts.length > 2 || !file.endsWith(EXT) || file.length === EXT.length) {
    return undefined;
  }
  return file.slice(0, -EXT.length);
};

export const watchProjects = (
  projectsDir: string,
  onChanged: (sessionIds: string[]) => void,
  options: WatchOptions = {},
): { close(): void } => {
  const debounceMs = options.debounceMs ?? 500;
  const retryMs = options.retryMs ?? 3000;
  const report = options.onError ?? (() => {});
  const pending = new Set<string>();
  let flushTimer: NodeJS.Timeout | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  let closed = false;

  const flush = (): void => {
    flushTimer = undefined;
    if (closed || pending.size === 0) return;
    const ids = [...pending];
    pending.clear();
    try {
      onChanged(ids);
    } catch (err) {
      report(err);
    }
  };

  const scheduleRetry = (): void => {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      start();
    }, retryMs);
    retryTimer.unref();
  };

  const drop = (): void => {
    const w = watcher;
    watcher = undefined;
    try {
      w?.close();
    } catch {
      // already closed
    }
  };

  const start = (): void => {
    if (closed || watcher) return;
    if (!fs.existsSync(projectsDir)) {
      scheduleRetry();
      return;
    }
    try {
      const w = fs.watch(projectsDir, { recursive: true }, (_event, filename) => {
        if (closed || filename === null || filename === undefined) return;
        const id = sessionIdFromPath(String(filename));
        if (!id) return;
        pending.add(id);
        if (!flushTimer) {
          flushTimer = setTimeout(flush, debounceMs);
          flushTimer.unref();
        }
      });
      w.on('error', (err) => {
        report(err);
        drop();
        scheduleRetry();
      });
      watcher = w;
    } catch (err) {
      report(err);
      scheduleRetry();
    }
  };

  start();

  return {
    close: () => {
      closed = true;
      clearTimeout(flushTimer);
      clearTimeout(retryTimer);
      pending.clear();
      drop();
    },
  };
};
