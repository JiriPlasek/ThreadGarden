import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PTY_PACKAGE } from '../src/shell/pty.js';

const serviceDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const buildScript = join(serviceDir, 'scripts', 'build.mjs');

const build = (outDir: string, extra: string[] = []) =>
  new Promise<{ code: number; stderr: string }>((done) => {
    execFile(
      process.execPath,
      [buildScript, '--out-dir', outDir, ...extra],
      { cwd: serviceDir },
      (err, _stdout, stderr) =>
        done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stderr }),
    );
  });

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** What a target needs at run time, by the spike (the `.pdb` files are left out). */
const needed: Record<string, string[]> = {
  'win32-x64': [
    'prebuilds/win32-x64/conpty.node',
    'prebuilds/win32-x64/conpty_console_list.node',
    'prebuilds/win32-x64/conpty/conpty.dll',
    'prebuilds/win32-x64/conpty/OpenConsole.exe',
    'lib/worker/conoutSocketWorker.js',
  ],
  'darwin-arm64': ['prebuilds/darwin-arm64/pty.node', 'prebuilds/darwin-arm64/spawn-helper'],
  'linux-x64': ['prebuilds/linux-x64/pty.node'],
};

describe('the service build', () => {
  let out: string;
  const host = `${process.platform}-${process.arch}`;

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), 'tg-build-'));
    const r = await build(out);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
  }, 60_000);
  afterAll(() => rm(out, { recursive: true, force: true }));

  it('the bundle leaves the PTY package external', async () => {
    const bundle = await readFile(join(out, 'service.mjs'), 'utf8');
    expect(bundle).toContain(`"${PTY_PACKAGE}"`);
    // None of its sources: not its platform loader, nor the Windows agent.
    expect(bundle).not.toContain('requirePlatformSpecificPackage');
    expect(bundle).not.toContain('windowsPtyAgent');
  });

  it("the host's PTY files sit beside service.mjs", async () => {
    const mine = needed[host];
    if (!mine) return; // a host the package isn't shipped for
    const dir = join(out, 'node_modules', '@lydell');
    expect(await exists(join(dir, 'node-pty', 'index.js'))).toBe(true);
    expect(await exists(join(dir, 'node-pty', 'package.json'))).toBe(true);
    for (const file of mine) {
      expect(await exists(join(dir, `node-pty-${host}`, file)), file).toBe(true);
    }
    expect(await exists(join(dir, `node-pty-${host}`, 'package.json'))).toBe(true);
    if (process.platform === 'darwin') {
      const mode = (await stat(join(dir, `node-pty-${host}`, needed[host]![1]!))).mode;
      expect(mode & 0o111).not.toBe(0);
    }
  });

  it('a missing target fails with its package name', async () => {
    const other = await mkdtemp(join(tmpdir(), 'tg-build-missing-'));
    try {
      // Published, but never what this machine's install holds.
      const r = await build(other, ['--pty-target', 'darwin-x64']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('@lydell/node-pty-darwin-x64');
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  }, 60_000);
});
