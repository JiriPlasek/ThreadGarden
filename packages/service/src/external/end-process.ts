/**
 * Ends a Claude Code process that holds a chat outside Threadgarden (`external.stop`).
 * On Windows the processes it started (tool shells, MCP servers) go with it,
 * since Windows does not end a process's children when it ends; elsewhere it
 * gets SIGTERM and shuts them down itself.
 */
import { execFile } from 'node:child_process';

export const END_PROCESS_TIMEOUT_MS = 5_000;

export const endProcessTree = (pid: number): Promise<void> =>
  new Promise((resolve, reject) => {
    // 0 and negative pids signal a process group or every process (POSIX `kill`).
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      reject(new Error(`Refusing to end pid ${pid}`));
      return;
    }
    if (process.platform === 'win32') {
      execFile(
        'taskkill',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, timeout: END_PROCESS_TIMEOUT_MS },
        (err) => (err ? reject(err) : resolve()),
      );
      return;
    }
    try {
      process.kill(pid, 'SIGTERM');
      resolve();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
