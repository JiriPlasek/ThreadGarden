import { describe, expect, it } from 'vitest';
import {
  findClaude,
  parseClaudeVersion,
  type FindClaudeOptions,
} from '../../src/sdk/claude-path.js';

type Over = Partial<FindClaudeOptions> & { files?: string[]; shims?: Record<string, string> };

const opts = (over: Over = {}) => {
  const shims = over.shims ?? {};
  const files = new Set([...(over.files ?? []), ...Object.keys(shims)]);
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
    readFile: (p) => {
      const text = shims[p];
      if (text === undefined) throw new Error(`ENOENT: ${p}`);
      return text;
    },
    ...over,
  };
  return { o, runs };
};

// What `npm install -g @anthropic-ai/claude-code` writes as claude.cmd (cmd-shim).
const NPM_JS_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  '',
].join('\r\n');

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

  it('prefers claude.exe over a claude.cmd in the same PATH directory', async () => {
    const { o } = opts({
      platform: 'win32',
      home: 'C:\\Users\\u',
      env: { PATH: 'C:\\npm' },
      files: ['C:\\npm\\claude.exe'],
      shims: { 'C:\\npm\\claude.cmd': NPM_JS_SHIM },
    });
    await expect(findClaude(o)).resolves.toMatchObject({ path: 'C:\\npm\\claude.exe' });
  });

  it('prefers ~/.local/bin/claude.exe over a claude.cmd earlier on PATH', async () => {
    const { o } = opts({
      platform: 'win32',
      home: 'C:\\Users\\u',
      env: { PATH: 'C:\\npm' },
      files: ['C:\\Users\\u\\.local\\bin\\claude.exe'],
      shims: { 'C:\\npm\\claude.cmd': NPM_JS_SHIM },
    });
    await expect(findClaude(o)).resolves.toMatchObject({
      path: 'C:\\Users\\u\\.local\\bin\\claude.exe',
    });
  });

  it('resolves an npm claude.cmd to the cli.js it starts and checks it with this Node', async () => {
    const cli = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    const { o, runs } = opts({
      platform: 'win32',
      home: 'C:\\Users\\u',
      env: { PATH: 'C:\\npm' },
      // An extensionless `claude` next to it is npm's sh shim and is ignored.
      files: ['C:\\npm\\claude', cli],
      shims: { 'C:\\npm\\claude.cmd': NPM_JS_SHIM },
    });
    await expect(findClaude(o)).resolves.toEqual({ path: cli, version: '2.1.314' });
    // The service's own Node (the bundled sidecar in release builds), as the SDK
    // runs it: `node` need not be on PATH (a macOS GUI launch has a minimal PATH).
    expect(runs).toEqual([{ cmd: process.execPath, args: [cli, '--version'] }]);
  });

  it('resolves a pnpm-style claude.cmd that starts a native exe', async () => {
    const exe = 'C:\\pnpm\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const target = '"%~dp0\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"';
    const { o, runs } = opts({
      platform: 'win32',
      home: 'C:\\Users\\u',
      env: { PATH: 'C:\\pnpm' },
      files: [exe],
      shims: {
        'C:\\pnpm\\claude.cmd': [
          '@SETLOCAL',
          '@IF EXIST "%~dp0\\node.exe" (',
          `  ${target}   %*`,
          ') ELSE (',
          `  ${target}   %*`,
          ')',
        ].join('\r\n'),
      },
    });
    await expect(findClaude(o)).resolves.toEqual({ path: exe, version: '2.1.314' });
    expect(runs).toEqual([{ cmd: exe, args: ['--version'] }]);
  });

  it('a claude.cmd whose target cannot be determined is unrunnable with an explanation', async () => {
    const { o, runs } = opts({
      platform: 'win32',
      home: 'C:\\Users\\u',
      env: { PATH: 'C:\\tools' },
      shims: { 'C:\\tools\\claude.cmd': '@echo off\r\nclaude-wrapper %*\r\n' },
    });
    const r = await findClaude(o);
    expect(r).toMatchObject({ problem: 'unrunnable' });
    expect('detail' in r && r.detail).toMatch(/\.cmd launcher.*cannot start.*native/s);
    expect(runs).toEqual([]);
  });

  it('a claude.cmd whose target is missing or not spawnable is unrunnable', async () => {
    const missing = opts({
      platform: 'win32',
      home: 'C:\\Users\\u',
      env: { PATH: 'C:\\npm' },
      shims: { 'C:\\npm\\claude.cmd': NPM_JS_SHIM }, // cli.js itself does not exist
    });
    await expect(findClaude(missing.o)).resolves.toMatchObject({
      problem: 'unrunnable',
      detail: expect.stringContaining('missing'),
    });
    const batTarget = opts({
      platform: 'win32',
      home: 'C:\\Users\\u',
      env: { PATH: 'C:\\x' },
      files: ['C:\\x\\real.bat'],
      shims: { 'C:\\x\\claude.cmd': '"%~dp0\\real.bat" %*' },
    });
    await expect(findClaude(batTarget.o)).resolves.toMatchObject({ problem: 'unrunnable' });
    expect(batTarget.runs).toEqual([]);
  });

  it('a settings path pointing at a .cmd launcher is resolved too', async () => {
    const cli = 'D:\\node\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    const { o } = opts({
      platform: 'win32',
      home: 'C:\\Users\\u',
      settingPath: 'D:\\node\\claude.cmd',
      files: [cli],
      shims: { 'D:\\node\\claude.cmd': NPM_JS_SHIM },
    });
    await expect(findClaude(o)).resolves.toMatchObject({ path: cli });
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
