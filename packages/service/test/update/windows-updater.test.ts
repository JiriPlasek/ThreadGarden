import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '@threadgarden/protocol';
import { MachineUpdater, type Run } from '../../src/update/updater.js';
import { WINDOWS_APPLY_SCRIPT } from '../../src/update/windows-apply-script.js';

describe('native Windows updates', () => {
  let root: string;
  let dataDir: string;
  let installBase: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tg-win-update-'));
    dataDir = join(root, 'data with space');
    installBase = join(root, 'install');
    await mkdir(join(installBase, 'current'), { recursive: true });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const rig = (opts: { badSum?: boolean; detachFails?: boolean; unpackFails?: boolean } = {}) => {
    const bytes = 'zip fixture';
    const sum = createHash('sha256').update(bytes).digest('hex');
    const urls: string[] = [];
    const calls: { cmd: string; args: string[] }[] = [];
    const stages: UpdateStatus[] = [];
    const run: Run = async (cmd, args) => {
      calls.push({ cmd, args });
      if (opts.unpackFails) return { code: 1, stdout: '', stderr: 'broken zip' };
      const dest = join(args[args.indexOf('-C') + 1]!, 'threadgarden-headless-0.9.1');
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, 'VERSION'), '0.9.1\n');
      return { code: 0, stdout: '', stderr: '' };
    };
    const detach = vi.fn(async () => {
      expect(JSON.parse(await readFile(join(dataDir, 'update', 'pending.json'), 'utf8'))).toEqual({
        version: '0.9.1',
        from: '0.9.0',
      });
      expect(await readFile(join(dataDir, 'update', 'apply.ps1'), 'utf8')).toBe(
        WINDOWS_APPLY_SCRIPT,
      );
      if (opts.detachFails) throw new Error('spawn denied');
      return process.pid;
    });
    const updater = new MachineUpdater({
      dataDir,
      installBase,
      currentVersion: '0.9.0',
      platform: 'win32',
      arch: 'x64',
      fetch: async (url) => {
        urls.push(String(url));
        return new Response(
          String(url).endsWith('.sha256')
            ? `${opts.badSum ? '0'.repeat(64) : sum}  release.zip\n`
            : bytes,
        );
      },
      run,
      detach,
      busyCount: async () => 0,
      emit: (s) => stages.push(s),
      log: { warn() {}, error() {} },
    });
    return { updater, urls, calls, detach, stages };
  };

  const finish = async (u: MachineUpdater) => {
    await vi.waitFor(() => {
      const s = u.status();
      expect(s.state === 'failed' || (s.state === 'running' && s.stage === 'restarting')).toBe(
        true,
      );
    });
  };

  it('checks the zip and launches PowerShell detached with separate arguments', async () => {
    const r = rig();
    expect(r.updater.supported()).toBe(true);
    await r.updater.start('0.9.1', false);
    await finish(r.updater);
    expect(r.urls).toEqual([
      'https://github.com/JiriPlasek/ThreadGarden/releases/download/v0.9.1/threadgarden-headless-0.9.1-windows-x64.zip',
      'https://github.com/JiriPlasek/ThreadGarden/releases/download/v0.9.1/threadgarden-headless-0.9.1-windows-x64.zip.sha256',
    ]);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.cmd).toMatch(/System32[\\/]tar.exe$/);
    expect(r.calls[0]!.args[0]).toBe('-xf');
    expect(r.detach).toHaveBeenCalledWith(expect.stringMatching(/powershell.exe$/), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(dataDir, 'update', 'apply.ps1'),
      join(dataDir, 'update', '0.9.1', 'threadgarden-headless-0.9.1', 'install.ps1'),
      '0.9.1',
      '0.9.0',
      installBase,
      join(dataDir, 'update'),
      '90',
    ]);
    expect(r.stages.map((s) => s.state === 'running' && s.stage)).toEqual([
      'downloading',
      'installing',
      'restarting',
    ]);
    expect(await readFile(join(dataDir, 'update', 'apply.pid'), 'utf8')).toBe(String(process.pid));
  });

  it.each([
    [{ badSum: true }, 'checksum'],
    [{ unpackFails: true }, 'unpack'],
    [{ detachFails: true }, 'install'],
  ] as const)('records failure and removes pending state: %j', async (opts, reason) => {
    const { updater } = rig(opts);
    await updater.start('0.9.1', false);
    await finish(updater);
    expect(updater.status()).toMatchObject({ state: 'failed', reason });
    await expect(readFile(join(dataDir, 'update', 'pending.json'))).rejects.toThrow();
  });

  it('waits for a live apply process, then settles an interrupted update', async () => {
    const folder = join(dataDir, 'update');
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, 'pending.json'),
      JSON.stringify({ version: '0.9.1', from: '0.9.0' }),
    );
    await writeFile(join(folder, 'apply.pid'), String(process.pid));
    const { updater, calls } = rig();
    await updater.reconcile();
    expect(updater.status()).toMatchObject({ state: 'running' });
    expect(calls).toEqual([]);
    await writeFile(join(folder, 'apply.pid'), '0');
    await updater.reconcile();
    expect(updater.status()).toMatchObject({ state: 'failed', reason: 'install' });
    await expect(readFile(join(folder, 'apply.pid'))).rejects.toThrow();
  });
});
