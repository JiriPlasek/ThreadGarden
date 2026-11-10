/** Separate opt-in diagnostic: requires a working native OS sandbox, no inference. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { connectCodex, initializeCodex } from '../../src/sdk/codex-client.js';

it.skipIf(process.platform !== 'win32' || process.env.THREADGARDEN_TEST_CODEX_SANDBOX !== '1')(
  'runs a harmless command directly in the installed Windows sandbox',
  async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'tg-codex-sandbox-'));
    const client = connectCodex(
      process.env,
      () => {},
      () => {},
    );
    try {
      await initializeCodex(client);
      expect(await client.request('windowsSandbox/readiness', {})).toMatchObject({
        status: 'ready',
      });
      const result = await client.request('command/exec', {
        command: ['powershell', '-NoProfile', '-Command', "Write-Output 'SANDBOX_OK'"],
        cwd,
        timeoutMs: 5_000,
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      });
      expect(result).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('SANDBOX_OK') });
    } finally {
      client.close();
      await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);
