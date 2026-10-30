import { describe, expect, it } from 'vitest';
import {
  findClaude,
  parseClaudeVersion,
  type FindClaudeOptions,
} from '../../src/sdk/claude-path.js';

type Over = Partial<FindClaudeOptions> & { files?: string[] };

const opts = (over: Over = {}) => {
  const files = new Set(over.files ?? []);
  const runs: { cmd: string; args: string[] }[] = [];
  const o: FindClaudeOptions = {
    settingPath: null,
    env: {},
    platform: 'linux',
    home: '/home/u',
    exists: (p) => files.has(p),
    run: async (cmd, args) => {
      runs.push({ cmd, args });
      return '2.1.314 (Claude Code)\n';
    },
    ...over,
  };
  return { o, runs };
};

describe('findClaude', () => {
  it('findClaude prefers settings path', async () => {
    const { o, runs } = opts({
      settingPath: '/opt/claude/bin/claude',
      env: { PATH: '/usr/bin' },
      files: ['/opt/claude/bin/claude', '/usr/bin/claude', '/home/u/.local/bin/claude'],
    });
    await expect(findClaude(o)).resolves.toEqual({
      path: '/opt/claude/bin/claude',
      version: '2.1.314',
    });
    expect(runs).toEqual([{ cmd: '/opt/claude/bin/claude', args: ['--version'] }]);
  });

  it('falls through a settings path that no longer exists', async () => {
    const { o } = opts({
      settingPath: '/gone/claude',
      env: { PATH: '/usr/bin' },
      files: ['/usr/bin/claude'],
    });
    await expect(findClaude(o)).resolves.toMatchObject({ path: '/usr/bin/claude' });
  });

  it('searches PATH entries in order on POSIX', async () => {
    const { o } = opts({
      env: { PATH: '/a:/b:/c' },
      files: ['/b/claude', '/c/claude'],
    });
    await expect(findClaude(o)).resolves.toMatchObject({ path: '/b/claude' });
  });

  it('finds claude.exe on PATH on win32', async () => {
    const { o } = opts({
      platform: 'win32',
      home: 'C:\\Users\\u',
      // Windows keeps the variable as `Path`; lookup is case-insensitive there.
      env: { Path: 'C:\\Windows;C:\\Tools\\claude' },
      files: ['C:\\Tools\\claude\\claude.exe', 'C:\\Users\\u\\.local\\bin\\claude.exe'],
    });
    await expect(findClaude(o)).resolves.toEqual({
      path: 'C:\\Tools\\claude\\claude.exe',
      version: '2.1.314',
    });
  });

  it('finds claude.cmd on PATH on win32 and ignores an extensionless shim', async () => {
    const { o } = opts({
      platform: 'win32',
      home: 'C:\\Users\\u',
      env: { PATH: 'C:\\npm' },
      files: ['C:\\npm\\claude', 'C:\\npm\\claude.cmd'],
    });
    await expect(findClaude(o)).resolves.toMatchObject({ path: 'C:\\npm\\claude.cmd' });
  });

  it('falls back to ~/.local/bin/claude', async () => {
    const { o } = opts({
      env: { PATH: '/usr/bin' },
      files: ['/home/u/.local/bin/claude', '/home/u/.claude/local/claude'],
    });
    await expect(findClaude(o)).resolves.toMatchObject({ path: '/home/u/.local/bin/claude' });
  });

  it('falls back to ~/.local/bin/claude.exe on win32', async () => {
    const { o } = opts({
      platform: 'win32',
      home: 'C:\\Users\\u',
      env: { Path: 'C:\\Windows' },
      files: ['C:\\Users\\u\\.local\\bin\\claude.exe'],
    });
    await expect(findClaude(o)).resolves.toMatchObject({
      path: 'C:\\Users\\u\\.local\\bin\\claude.exe',
    });
  });

  it('falls back to ~/.claude/local/claude last', async () => {
    const { o } = opts({ files: ['/home/u/.claude/local/claude'] });
    await expect(findClaude(o)).resolves.toMatchObject({ path: '/home/u/.claude/local/claude' });
  });

  it('returns missing when nothing found', async () => {
    const { o, runs } = opts({ env: { PATH: '/usr/bin' }, settingPath: '/gone/claude' });
    const r = await findClaude(o);
    expect(r).toMatchObject({ problem: 'missing' });
    expect('detail' in r && r.detail).toContain('/gone/claude');
    expect(runs).toEqual([]);
  });

  it('returns unrunnable when the only candidate fails --version', async () => {
    const { o } = opts({
      env: { PATH: '/usr/bin' },
      files: ['/usr/bin/claude'],
      run: async () => {
        throw new Error('spawn EACCES');
      },
    });
    const r = await findClaude(o);
    expect(r).toMatchObject({ problem: 'unrunnable' });
    expect('detail' in r && r.detail).toContain('EACCES');
  });

  it('skips an unrunnable candidate when a later one works', async () => {
    const { o } = opts({
      env: { PATH: '/usr/bin' },
      files: ['/usr/bin/claude', '/home/u/.local/bin/claude'],
      run: async (cmd) => {
        if (cmd === '/usr/bin/claude') throw new Error('broken');
        return '2.1.400 (Claude Code)';
      },
    });
    await expect(findClaude(o)).resolves.toEqual({
      path: '/home/u/.local/bin/claude',
      version: '2.1.400',
    });
  });
});

describe('parseClaudeVersion', () => {
  it('takes the version number from `claude --version` output', () => {
    expect(parseClaudeVersion('2.1.314 (Claude Code)\n')).toBe('2.1.314');
    expect(parseClaudeVersion('claude 3.0.0-beta.1')).toBe('3.0.0-beta.1');
  });

  it('falls back to the first line when no version number is present', () => {
    expect(parseClaudeVersion('  dev build\nmore')).toBe('dev build');
  });
});
