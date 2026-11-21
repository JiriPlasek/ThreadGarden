import { execFile, execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpdateStatusSchema } from '@threadgarden/protocol';
import { applyArgs } from '../../src/update/apply-script.js';
import { WINDOWS_APPLY_SCRIPT } from '../../src/update/windows-apply-script.js';

describe.skipIf(process.platform !== 'win32')(
  'Windows update apply and rollback',
  { timeout: 30_000 },
  () => {
    let root: string;
    let base: string;
    let updateDir: string;
    let script: string;
    let installer: string;
    const log = () => readFile(join(root, 'calls.log'), 'utf8');

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'tg-apply with space-'));
      base = join(root, 'install');
      updateDir = join(root, 'update');
      script = join(updateDir, 'apply.ps1');
      installer = join(root, 'install.ps1');
      for (const folder of ['bin', 'node', '0.9.0/bin', '0.9.1/bin']) {
        await mkdir(join(base, folder), { recursive: true });
      }
      await mkdir(updateDir);
      await writeFile(script, WINDOWS_APPLY_SCRIPT);
      await writeFile(join(base, '0.9.0', 'bin', 'node.exe'), 'old node');
      await writeFile(join(base, 'node', 'node.exe'), 'new node');
      const cli = '@echo off\r\n>>"%TG_APPLY_TEST_ROOT%\\calls.log" echo %*\r\nexit /b 0\r\n';
      await writeFile(join(base, '0.9.0', 'bin', 'threadgarden.cmd'), cli);
      await copyFile(
        join(base, '0.9.0', 'bin', 'threadgarden.cmd'),
        join(base, 'bin', 'threadgarden.cmd'),
      );
      execFileSync('cmd.exe', ['/c', 'mklink', '/J', join(base, 'current'), join(base, '0.9.1')]);
      await writeFile(join(updateDir, 'pending.json'), '{"version":"0.9.1","from":"0.9.0"}');
    });
    afterEach(async () => {
      const pid = Number(await readFile(join(root, 'background.pid'), 'utf8').catch(() => '0'));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid);
        } catch {
          /* It may already have exited. */
        }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    const run = (install: string, timeoutS = 2) =>
      new Promise<number>((resolve, reject) => {
        void writeFile(installer, install).then(() => {
          execFile(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              script,
              ...applyArgs({
                installSh: installer,
                version: '0.9.1',
                from: '0.9.0',
                installBase: base,
                updateDir,
                timeoutS,
              }),
            ],
            {
              windowsHide: true,
              env: {
                ...process.env,
                TG_APPLY_TEST_ROOT: root,
                TG_APPLY_TEST_NODE: process.execPath,
              },
              timeout: 20_000,
            },
            (err, _stdout, stderr) => {
              if (stderr) reject(new Error(stderr));
              else resolve(err ? (typeof err.code === 'number' ? err.code : 1) : 0);
            },
          );
        }, reject);
      });

    it('keeps a new version after it reports ready, in unattended mode', async () => {
      expect(
        await run(
          [
            "if ($env:THREADGARDEN_UNATTENDED -ne '1') { exit 2 }",
            "$last = Join-Path $env:TG_APPLY_TEST_ROOT 'update\\last.json'",
            '[IO.File]::WriteAllText($last, \'{"state":"done","version":"0.9.1","from":"0.9.0","skipped":[]}\')',
            'exit 0',
          ].join('\n'),
        ),
      ).toBe(0);
      expect(await realpath(join(base, 'current'))).toBe(await realpath(join(base, '0.9.1')));
      await expect(log()).rejects.toThrow();
    });

    it('finishes while the background service started by the installer remains alive', async () => {
      await writeFile(
        join(root, 'spawn.mjs'),
        [
          "import { spawn } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore', windowsHide: true });",
          "writeFileSync(join(process.env.TG_APPLY_TEST_ROOT, 'background.pid'), String(child.pid));",
          'child.unref();',
        ].join('\n'),
      );
      expect(
        await run(
          [
            "& $env:TG_APPLY_TEST_NODE (Join-Path $env:TG_APPLY_TEST_ROOT 'spawn.mjs')",
            "$last = Join-Path $env:TG_APPLY_TEST_ROOT 'update\\last.json'",
            '[IO.File]::WriteAllText($last, \'{"state":"done","version":"0.9.1","from":"0.9.0","skipped":[]}\')',
            'exit 0',
          ].join('\n'),
        ),
      ).toBe(0);
      const pid = Number(await readFile(join(root, 'background.pid'), 'utf8'));
      expect(() => process.kill(pid, 0)).not.toThrow();
    });

    it.each([
      ['exit 1', 'install'],
      ['exit 0', 'start'],
      [
        '[IO.File]::WriteAllText((Join-Path $env:TG_APPLY_TEST_ROOT \'update\\last.json\'), \'{"state":"done","version":"0.9.2"}\'); exit 0',
        'start',
      ],
    ])('rolls back after %s with reason %s', async (install, reason) => {
      expect(await run(install!)).toBe(1);
      expect(await realpath(join(base, 'current'))).toBe(await realpath(join(base, '0.9.0')));
      expect(await readFile(join(base, 'node', 'node.exe'), 'utf8')).toBe('old node');
      expect((await log()).trim().split(/\r?\n/)).toEqual(['stop', 'start']);
      expect(
        UpdateStatusSchema.parse(JSON.parse(await readFile(join(updateDir, 'last.json'), 'utf8'))),
      ).toEqual({
        state: 'failed',
        version: '0.9.1',
        from: '0.9.0',
        reason,
      });
      await expect(readFile(join(updateDir, 'pending.json'))).rejects.toThrow();
    });
  },
);
