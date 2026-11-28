import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

/** A literal in PowerShell source, distinct from Windows command-line quoting. */
const psLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Start-Process joins ArgumentList; quote each argument for the target's argv parser. */
const windowsArgument = (value: string): string =>
  `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;

/**
 * Starts a command independently and answers its pid. On Windows, Node's
 * DETACHED_PROCESS can make console programs exit before running any code.
 * A normal PowerShell child delegates to Start-Process instead, so the target
 * survives the worker stopping itself during an update.
 */
export const startDetached = (cmd: string, args: string[]): Promise<number> => {
  if (process.platform === 'win32') {
    const argumentsText = args.length
      ? ` -ArgumentList ${psLiteral(args.map(windowsArgument).join(' '))}`
      : '';
    const script = `$ErrorActionPreference = 'Stop'; $p = Start-Process -FilePath ${psLiteral(cmd)}${argumentsText} -WindowStyle Hidden -PassThru; $p.Id`;
    return new Promise((resolve, reject) => {
      execFile(
        path.join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, timeout: 30_000 },
        (err, stdout) => {
          if (err) return reject(err);
          const pid = Number(stdout.trim());
          if (!Number.isSafeInteger(pid) || pid <= 0) {
            return reject(new Error('The Windows launcher did not return a valid process id'));
          }
          resolve(pid);
        },
      );
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid ?? 0);
    });
  });
};
