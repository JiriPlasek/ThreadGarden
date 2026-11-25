// The shell Claude Code's own Bash tool uses (results doc: UNIX_SHELL, WINDOWS_SHELL):
// docs/superpowers/specs/2026-11-22-shell-commands-spike-results.md
import { win32 } from 'node:path';

export type ShellLine = { file: string; args: string[] };

export type ShellLineEnv = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  which: (name: string) => string | undefined;
  exists: (path: string) => boolean;
};

/** Git Bash from CLAUDE_CODE_GIT_BASH_PATH, else from where `git` sits (as scripts/pty-smoke.mjs). */
const gitBash = (o: ShellLineEnv): string | undefined => {
  const set = o.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (set && o.exists(set)) return set;
  const git = o.which('git');
  if (!git) return undefined;
  // <git root>\cmd\git.exe or <git root>\mingw64\bin\git.exe -> <git root>\bin\bash.exe
  const root = win32.resolve(git, '..', '..');
  for (const candidate of [
    win32.join(root, 'bin', 'bash.exe'),
    win32.join(root, '..', 'bin', 'bash.exe'),
  ]) {
    if (o.exists(candidate)) return candidate;
  }
  return undefined;
};

/** The program and arguments that run `command` as one argument in a fresh PTY. */
export const shellLine = (command: string, o: ShellLineEnv): ShellLine => {
  if (o.platform !== 'win32') {
    const user = o.env.SHELL;
    const name = user?.split('/').pop();
    const file = user && (name === 'bash' || name === 'zsh') ? user : 'bash';
    return { file, args: ['-lic', command] };
  }
  const bash = gitBash(o);
  if (bash) return { file: bash, args: ['-lic', command] };
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  return {
    file: o.which('pwsh') ? 'pwsh.exe' : 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded],
  };
};
