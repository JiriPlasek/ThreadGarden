import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diskProjectFiles } from '../../src/mcp/project-files';

let dir: string;
let prevConfig: string | undefined;
const local = () => path.join(dir, '.claude', 'settings.local.json');
const write = async (file: string, text: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'tg-mcp-'));
  prevConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'userconfig');
});
afterEach(async () => {
  if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfig;
  await rm(dir, { recursive: true, force: true });
});

describe('mcpJsonNames', () => {
  it('reads server names from .mcp.json', async () => {
    await write(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { etoro: { command: 'x' }, linear: { type: 'http' } } }),
    );
    expect(await diskProjectFiles.mcpJsonNames(dir)).toEqual(['etoro', 'linear']);
  });
  it('gives [] for a missing or broken file', async () => {
    expect(await diskProjectFiles.mcpJsonNames(dir)).toEqual([]);
    await write(path.join(dir, '.mcp.json'), '{ nope');
    expect(await diskProjectFiles.mcpJsonNames(dir)).toEqual([]);
  });
});

describe('approve', () => {
  it('creates the folder and file', async () => {
    await diskProjectFiles.approve(dir, 'etoro');
    expect(await readFile(local(), 'utf8')).toBe(
      '{\n  "enabledMcpjsonServers": [\n    "etoro"\n  ]\n}\n',
    );
  });
  it('keeps every other key and their order', async () => {
    await write(
      local(),
      JSON.stringify({ permissions: { allow: ['Bash'] }, enabledMcpjsonServers: ['a'], x: 1 }),
    );
    await diskProjectFiles.approve(dir, 'etoro');
    const obj = JSON.parse(await readFile(local(), 'utf8'));
    expect(Object.keys(obj)).toEqual(['permissions', 'enabledMcpjsonServers', 'x']);
    expect(obj.enabledMcpjsonServers).toEqual(['a', 'etoro']);
    expect(obj.permissions).toEqual({ allow: ['Bash'] });
  });
  it('takes the name off disabledMcpjsonServers', async () => {
    await write(local(), JSON.stringify({ disabledMcpjsonServers: ['etoro', 'b'] }));
    await diskProjectFiles.approve(dir, 'etoro');
    const obj = JSON.parse(await readFile(local(), 'utf8'));
    expect(obj.disabledMcpjsonServers).toEqual(['b']);
    expect(obj.enabledMcpjsonServers).toEqual(['etoro']);
  });
  it('approving twice adds the name once', async () => {
    await diskProjectFiles.approve(dir, 'etoro');
    await diskProjectFiles.approve(dir, 'etoro');
    expect(JSON.parse(await readFile(local(), 'utf8')).enabledMcpjsonServers).toEqual(['etoro']);
  });
  it('two approvals at once keep both names', async () => {
    await Promise.all([diskProjectFiles.approve(dir, 'a'), diskProjectFiles.approve(dir, 'b')]);
    expect(JSON.parse(await readFile(local(), 'utf8')).enabledMcpjsonServers).toEqual(['a', 'b']);
  });
  it('refuses an unreadable settings file', async () => {
    for (const text of ['{ // comment', '[]']) {
      await write(local(), text);
      await expect(diskProjectFiles.approve(dir, 'etoro')).rejects.toMatchObject({
        code: 'SETTINGS_UNREADABLE',
        message: `${local()} isn't valid JSON, so Threadgarden left it alone. Fix it, then approve again.`,
      });
      expect(await readFile(local(), 'utf8')).toBe(text);
    }
  });
  it('leaves no temp file behind when the rename fails', async () => {
    await mkdir(local(), { recursive: true }); // a directory where the file should go
    await expect(diskProjectFiles.approve(dir, 'etoro')).rejects.toBeDefined();
    const left = (await readdir(path.join(dir, '.claude'))).filter((f) => f.endsWith('.tmp'));
    expect(left).toEqual([]);
  });
  it('refuses a settings file it cannot read, without touching it', async () => {
    await mkdir(local(), { recursive: true });
    await expect(diskProjectFiles.approve(dir, 'etoro')).rejects.toMatchObject({
      code: 'SETTINGS_UNREADABLE',
    });
  });
  it('approves a file that starts with a byte-order mark', async () => {
    await write(local(), '﻿' + JSON.stringify({ x: 1 }));
    await diskProjectFiles.approve(dir, 'etoro');
    const obj = JSON.parse(await readFile(local(), 'utf8'));
    expect(obj).toEqual({ x: 1, enabledMcpjsonServers: ['etoro'] });
  });
});
