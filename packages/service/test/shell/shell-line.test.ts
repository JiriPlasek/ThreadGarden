import { describe, expect, it } from 'vitest';
import { shellLine } from '../../src/shell/shell-line.js';

const none = () => undefined;
const never = () => false;

describe('shellLine', () => {
  it('linux and macOS follow UNIX_SHELL', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const base = { platform, which: none, exists: never };
      expect(shellLine('echo hi', { ...base, env: { SHELL: '/bin/bash' } })).toEqual({
        file: '/bin/bash',
        args: ['-lic', 'echo hi'],
      });
      expect(shellLine('echo hi', { ...base, env: { SHELL: '/usr/bin/zsh' } })).toEqual({
        file: '/usr/bin/zsh',
        args: ['-lic', 'echo hi'],
      });
      expect(shellLine('echo hi', { ...base, env: { SHELL: '/usr/bin/fish' } })).toEqual({
        file: 'bash',
        args: ['-lic', 'echo hi'],
      });
      expect(shellLine('echo hi', { ...base, env: {} })).toEqual({
        file: 'bash',
        args: ['-lic', 'echo hi'],
      });
    }
  });

  it('windows uses CLAUDE_CODE_GIT_BASH_PATH when it exists', () => {
    const bash = String.raw`D:\Git\bin\bash.exe`;
    const line = shellLine('ls -la', {
      platform: 'win32',
      env: { CLAUDE_CODE_GIT_BASH_PATH: bash },
      which: none,
      exists: (p) => p === bash,
    });
    expect(line).toEqual({ file: bash, args: ['-lic', 'ls -la'] });
  });

  it('windows finds Git Bash from git on PATH', () => {
    const bash = String.raw`C:\Program Files\Git\bin\bash.exe`;
    const line = shellLine('ls', {
      platform: 'win32',
      env: { CLAUDE_CODE_GIT_BASH_PATH: String.raw`Z:\gone\bash.exe` },
      which: (n) => (n === 'git' ? String.raw`C:\Program Files\Git\cmd\git.exe` : undefined),
      exists: (p) => p === bash,
    });
    expect(line).toEqual({ file: bash, args: ['-lic', 'ls'] });
  });

  it('windows finds Git Bash from a mingw64 git', () => {
    const bash = String.raw`C:\Program Files\Git\bin\bash.exe`;
    const line = shellLine('ls', {
      platform: 'win32',
      env: {},
      which: (n) =>
        n === 'git' ? String.raw`C:\Program Files\Git\mingw64\bin\git.exe` : undefined,
      exists: (p) => p === bash,
    });
    expect(line.file).toBe(bash);
  });

  it('windows without Git Bash uses PowerShell with the command encoded', () => {
    const command = `echo "a b" 'c' $HOME`;
    const decode = (args: string[]) =>
      Buffer.from(args[args.length - 1] ?? '', 'base64').toString('utf16le');

    const pwsh = shellLine(command, {
      platform: 'win32',
      env: {},
      which: (n) => (n === 'pwsh' ? String.raw`C:\Program Files\PowerShell\7\pwsh.exe` : undefined),
      exists: never,
    });
    expect(pwsh.file).toBe('pwsh.exe');
    expect(pwsh.args.slice(0, 3)).toEqual(['-NoLogo', '-NoProfile', '-EncodedCommand']);
    expect(decode(pwsh.args)).toBe(command);

    const ps = shellLine(command, { platform: 'win32', env: {}, which: none, exists: never });
    expect(ps.file).toBe('powershell.exe');
    expect(ps.args.slice(0, 3)).toEqual(['-NoLogo', '-NoProfile', '-EncodedCommand']);
    expect(decode(ps.args)).toBe(command);
  });
});
