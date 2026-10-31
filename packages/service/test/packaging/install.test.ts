import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const packaging = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../packaging/headless',
);

const sh = (script: string, env: Record<string, string>) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(
      'sh',
      [script],
      { env: { PATH: process.env.PATH ?? '', ...env } },
      (err, stdout, stderr) =>
        done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });

describe.skipIf(process.platform === 'win32')('headless install.sh', () => {
  let root: string;
  let release: string;
  let home: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tg-headless-'));
    release = join(root, 'threadgarden-headless-9.9.9');
    home = join(root, 'home');
    await mkdir(join(release, 'bin'), { recursive: true });
    await mkdir(join(release, 'lib'), { recursive: true });
    await mkdir(home);
    await cp(join(packaging, 'install.sh'), join(release, 'install.sh'));
    await cp(join(packaging, 'threadgarden.service'), join(release, 'threadgarden.service'));
    await cp(join(packaging, 'threadgarden'), join(release, 'bin', 'threadgarden'));
    await writeFile(join(release, 'bin', 'node'), '#!/bin/sh\necho "node $*"\n');
    await writeFile(join(release, 'lib', 'service.mjs'), '');
    await writeFile(join(release, 'VERSION'), '9.9.9\n');
    await chmod(join(release, 'install.sh'), 0o755);
    await chmod(join(release, 'bin', 'node'), 0o755);
    await chmod(join(release, 'bin', 'threadgarden'), 0o755);
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  const install = () =>
    sh(join(release, 'install.sh'), {
      HOME: home,
      USER: 'tester',
      SYSTEMCTL: 'echo systemctl',
      LOGINCTL: 'echo loginctl',
      SUDO: '',
    });

  it('installs into a temp HOME and enables the user unit', async () => {
    const { code, stdout } = await install();
    expect(code).toBe(0);
    expect(await readlink(join(home, '.local/bin/threadgarden'))).toContain(
      'threadgarden-headless/current/bin/threadgarden',
    );
    expect(
      await readFile(join(home, '.config/systemd/user/threadgarden.service'), 'utf8'),
    ).toContain('serve --headless');
    expect(stdout).toContain('systemctl --user enable --now threadgarden');
    expect(stdout).toContain('threadgarden pair');
  });

  it('is idempotent and upgrades current to the new version', async () => {
    expect((await install()).code).toBe(0);
    await writeFile(join(release, 'VERSION'), '9.9.10\n');
    expect((await install()).code).toBe(0);
    expect(await readlink(join(home, '.local/share/threadgarden-headless/current'))).toMatch(
      /9\.9\.10$/,
    );
  });

  it('the launcher resolves its symlink and passes the arguments through', async () => {
    await install();
    const { stdout } = await sh(join(home, '.local/bin/threadgarden'), { HOME: home });
    expect(stdout).toContain('node --disable-warning=ExperimentalWarning');
    expect(stdout).toContain('lib/service.mjs');
  });
});
