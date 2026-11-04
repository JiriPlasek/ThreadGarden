import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * A worker running in WSL on a Windows PC: Windows does the powering off. Its
 * programs are reached through WSL's interop, by their full path, so nothing
 * depends on the worker's PATH or current folder.
 */
export const SHUTDOWN_EXE = '/mnt/c/Windows/System32/shutdown.exe';
export const REG = '/mnt/c/Windows/System32/reg.exe';
export const QUSER = '/mnt/c/Windows/System32/quser.exe';

/** Present in every WSL distro with interop on (WSL 1 and 2). */
const WSL_INTEROP = '/proc/sys/fs/binfmt_misc/WSLInterop';

/** quser and reg answer at once; one that takes this long is stuck. */
const QUERY_TIMEOUT_MS = 15_000;
/** shutdown.exe only schedules the shutdown, so it returns quickly too. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * `reg.exe` arguments for the signs of a pending restart: Windows Update's, the
 * component servicing's, and files waiting to be replaced at the next boot.
 */
export const RESTART_KEYS: readonly (readonly string[])[] = [
  [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired',
  ],
  [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending',
  ],
  [
    'query',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager',
    '/v',
    'PendingFileRenameOperations',
  ],
];

/** How a program ended: `code` null means it was ended by a signal from outside. */
export type RunResult = { code: number | null; stdout: string; stderr: string };
export type Run = (file: string, args: string[], o: { timeoutMs: number }) => Promise<RunResult>;

export interface WindowsHost {
  /** Whether someone is signed in at the PC (an interactive session, even a locked one). */
  signedIn(): Promise<boolean>;
  /** Whether Windows waits for a restart, so a shutdown may install updates on its way down. */
  restartPending(): Promise<boolean>;
  /** Shuts Windows down now; `force` closes open apps instead of waiting on them. */
  shutdown(opts: { force: boolean }): Promise<void>;
}

/** Whether this process runs in WSL: the interop entry, or the distro name WSL sets. */
export function detectWsl(
  deps: { exists(p: string): boolean; env: NodeJS.ProcessEnv } = {
    exists: existsSync,
    env: process.env,
  },
): boolean {
  return deps.exists(WSL_INTEROP) || (deps.env.WSL_DISTRO_NAME ?? '') !== '';
}

class TimedOut extends Error {}

/** `shutdown.exe` for `/mnt/c/Windows/System32/shutdown.exe`. */
const baseName = (file: string) => file.slice(file.lastIndexOf('/') + 1);

/** The real programs: a child still running at its timeout is killed outright. */
const runFile: Run = (file, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        if (err.killed) return reject(new TimedOut(`${baseName(file)} timed out`));
        if (typeof err.code === 'number') return resolve({ code: err.code, stdout, stderr });
        if (err.signal) return resolve({ code: null, stdout, stderr });
        reject(err); // not started at all (ENOENT: no such program on this Windows)
      },
    );
  });

const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0]!.trim();
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function windowsHost(
  deps: { run?: Run; log?: { warn(m: string): void } } = {},
): WindowsHost {
  const run = deps.run ?? runFile;

  /**
   * Bounded by its own timer too: a program that hangs through interop, or a `run`
   * that ignores its timeout, must never hold a shutdown up for good.
   */
  const bounded = (file: string, args: string[], timeoutMs: number): Promise<RunResult> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimedOut(`${baseName(file)} timed out`)), timeoutMs);
    });
    return Promise.race([run(file, args, { timeoutMs }), late]).finally(() => clearTimeout(timer));
  };

  return {
    async signedIn() {
      let r: RunResult;
      try {
        r = await bounded(QUSER, [], QUERY_TIMEOUT_MS);
      } catch (err) {
        // Windows Home has no quser: nobody can be seen, so nobody counts as signed in.
        deps.log?.warn(`power: quser failed, counting nobody as signed in: ${errorText(err)}`);
        return false;
      }
      // Exit 1 is "No User exists"; the first line of a list is its header.
      if (r.code === 1) return false;
      if (r.code === 0) return r.stdout.split(/\r?\n/).filter((l) => l.trim() !== '').length > 1;
      deps.log?.warn(
        `power: quser exited with ${r.code ?? 'a signal'}, counting nobody as signed in: ${firstLine(r.stderr)}`,
      );
      return false;
    },

    async restartPending() {
      // reg exits 0 when the key or value is there and 1 when it is not.
      const found = await Promise.all(
        RESTART_KEYS.map(async (args) => {
          try {
            return (await bounded(REG, [...args], QUERY_TIMEOUT_MS)).code === 0;
          } catch (err) {
            // Not known counts as not pending: the shutdown then keeps its full cut.
            deps.log?.warn(`power: reg failed, counting no restart pending: ${errorText(err)}`);
            return false;
          }
        }),
      );
      return found.some(Boolean);
    },

    async shutdown({ force }) {
      const args = force ? ['/s', '/f', '/t', '0'] : ['/s', '/t', '0'];
      // A timeout throws "shutdown.exe timed out"; one that never started, why not.
      const r = await bounded(SHUTDOWN_EXE, args, SHUTDOWN_TIMEOUT_MS);
      // Ended from outside: Windows is stopping WSL on its way down.
      if (r.code === 0 || r.code === null) return;
      throw new Error(firstLine(r.stderr) || `shutdown.exe exited with code ${r.code}`);
    },
  };
}
