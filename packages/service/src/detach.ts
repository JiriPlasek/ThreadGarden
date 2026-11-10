import { spawn } from 'node:child_process';

/**
 * Starts `cmd` on its own, so it outlives this process: detached (on Windows
 * `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`, as the desktop shell starts its
 * service), no window, stdio to the null device. Answers the pid once it runs.
 */
export const startDetached = (cmd: string, args: string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid ?? 0);
    });
  });
