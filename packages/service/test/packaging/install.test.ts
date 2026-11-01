import { execFile } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const packaging = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../packaging/headless',
);

const sh = (script: string, args: string[], env: Record<string, string>) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(
      'sh',
      [script, ...args],
      { env: { PATH: process.env.PATH ?? '', ...env } },
      (err, stdout, stderr) =>
        done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });

const isRoot = process.getuid?.() === 0;

describe.skipIf(process.platform === 'win32' || isRoot)('headless install.sh', () => {
  let root: string;
  let release: string;
  let home: string;
  let log: string;
  let stubs: string;

  const stub = async (name: string, body: string) => {
    const path = join(stubs, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tg-headless-'));
    release = join(root, 'threadgarden-headless-9.9.9');
    home = join(root, 'home');
    stubs = join(root, 'stubs');
    log = join(root, 'calls.log');
    await mkdir(join(release, 'bin'), { recursive: true });
    await mkdir(join(release, 'lib'), { recursive: true });
    await mkdir(stubs);
    await mkdir(home);
    await writeFile(log, '');
    await cp(join(packaging, 'install.sh'), join(release, 'install.sh'));
    await cp(join(packaging, 'threadgarden.service'), join(release, 'threadgarden.service'));
    await cp(join(packaging, 'threadgarden'), join(release, 'bin', 'threadgarden'));
    await writeFile(
      join(release, 'bin', 'node'),
      '#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done\n',
    );
    await writeFile(join(release, 'lib', 'service.mjs'), '');
    await writeFile(join(release, 'VERSION'), '9.9.9\n');
    await chmod(join(release, 'install.sh'), 0o755);
    await chmod(join(release, 'bin', 'node'), 0o755);
    await chmod(join(release, 'bin', 'threadgarden'), 0o755);
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean);

  const install = async (extra: Record<string, string> = {}, from = release) => {
    const systemctl = await stub('systemctl', 'echo "systemctl $*" >> "$LOG"');
    const loginctl = await stub(
      'loginctl',
      'echo "loginctl $*" >> "$LOG"\n[ "$1" = show-user ] && [ -n "${LINGER:-}" ] && echo "Linger=$LINGER"\nexit 0',
    );
    // Logs the command by basename: LOGINCTL is an absolute stub path.
    const sudo = await stub(
      'sudo',
      'first=$1\nshift\necho "sudo $(basename "$first") $*" >> "$LOG"\nexec "$first" "$@"',
    );
    return sh(join(from, 'install.sh'), [], {
      HOME: home,
      USER: 'tester',
      LOG: log,
      SYSTEMCTL: systemctl,
      LOGINCTL: loginctl,
      SUDO: sudo,
      // Never the real /etc: a missing directory is the "old polkit" case.
      POLKIT_RULES_DIR: join(root, 'no-polkit'),
      ...extra,
    });
  };

  const data = join('.local', 'share', 'threadgarden-headless');

  it('installs into a temp HOME and enables the user unit', async () => {
    const { code, stdout } = await install();
    expect(code).toBe(0);
    expect(await readlink(join(home, '.local/bin/threadgarden'))).toContain(
      'threadgarden-headless/current/bin/threadgarden',
    );
    const unit = await readFile(join(home, '.config/systemd/user/threadgarden.service'), 'utf8');
    expect(unit).toContain('serve --headless');
    expect(unit).not.toContain('network-online');
    expect(stdout).toContain('systemctl --user enable threadgarden');
    expect(stdout).toContain('threadgarden pair');
    expect(stdout).toContain('systemctl --user edit threadgarden');
    const c = await calls();
    expect(c).toContain('systemctl --user daemon-reload');
    expect(c).toContain('systemctl --user enable threadgarden');
    expect(c).toContain('systemctl --user restart threadgarden');
    expect(c).not.toContain('systemctl --user enable --now threadgarden');
    expect(c.indexOf('systemctl --user enable threadgarden')).toBeLessThan(
      c.indexOf('systemctl --user restart threadgarden'),
    );
    expect(c).toContain('sudo loginctl enable-linger tester');
    expect(c).toContain('loginctl enable-linger tester');
  });

  it('writes a world-readable polkit rule letting this user power off, through sudo', async () => {
    const rules = join(root, 'rules.d');
    await mkdir(rules);
    const { code, stdout } = await install({ POLKIT_RULES_DIR: rules });
    expect(code).toBe(0);
    const file = join(rules, '49-threadgarden-power.rules');
    const text = await readFile(file, 'utf8');
    expect(text).toContain('subject.user == "tester"');
    expect(text).toContain('"org.freedesktop.login1.power-off"');
    expect(text).toContain('"org.freedesktop.login1.power-off-multiple-sessions"');
    expect(text).toContain('polkit.Result.YES');
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    expect(stdout).toContain('power');
    const c = await calls();
    expect(
      c.some((l) => l.startsWith('sudo tee ') && l.endsWith('49-threadgarden-power.rules')),
    ).toBe(true);
    expect(c).toContain('sudo chmod 644 ' + file);
    // Reinstalling over an identical rule succeeds and leaves it unchanged.
    expect((await install({ POLKIT_RULES_DIR: rules })).code).toBe(0);
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('warns and carries on when there is no polkit rules directory', async () => {
    const { code, stderr } = await install({ POLKIT_RULES_DIR: join(root, 'missing') });
    expect(code).toBe(0);
    expect(stderr).toContain("won't be able to power");
    expect((await calls()).some((l) => l.startsWith('sudo tee'))).toBe(false);
    expect(await calls()).toContain('systemctl --user restart threadgarden');
  });

  it('works with USER unset and skips sudo when lingering is already on', async () => {
    const env = { USER: '', LINGER: 'yes' } as Record<string, string>;
    const { code } = await install(env);
    expect(code).toBe(0);
    const c = await calls();
    expect(c.some((l) => l.includes('enable-linger'))).toBe(false);
    expect(c.some((l) => l.startsWith('sudo'))).toBe(false);
    expect(c.some((l) => l.startsWith('loginctl show-user ' + userInfo().username))).toBe(true);
  });

  it('is idempotent and upgrades current to the new version', async () => {
    expect((await install()).code).toBe(0);
    await writeFile(join(release, 'VERSION'), '9.9.10\n');
    expect((await install()).code).toBe(0);
    expect(await readlink(join(home, data, 'current'))).toMatch(/9\.9\.10$/);
  });

  it('re-running the installed copy keeps a working install', async () => {
    expect((await install()).code).toBe(0);
    const installed = join(home, data, 'current');
    expect((await install({}, installed)).code).toBe(0);
    expect(await readlink(join(home, data, 'current'))).toMatch(/9\.9\.9$/);
    expect((await stat(join(home, data, '9.9.9', 'bin', 'threadgarden'))).isFile()).toBe(true);
    expect((await stat(join(home, data, '9.9.9', 'lib', 'service.mjs'))).isFile()).toBe(true);
    expect(await readFile(join(home, data, '9.9.9', 'VERSION'), 'utf8')).toBe('9.9.9\n');
  });

  it('keeps only the new version and the previous one', async () => {
    for (const v of ['1.0.0', '2.0.0', '3.0.0']) {
      await writeFile(join(release, 'VERSION'), `${v}\n`);
      expect((await install()).code).toBe(0);
    }
    const left = (await readdir(join(home, data))).sort();
    expect(left).toEqual(['2.0.0', '3.0.0', 'current']);
    expect(await readlink(join(home, data, 'current'))).toMatch(/3\.0\.0$/);
  });

  it('reinstalling the current version keeps the rollback and drops stale temp copies', async () => {
    for (const v of ['2.0.0', '3.0.0']) {
      await writeFile(join(release, 'VERSION'), `${v}\n`);
      expect((await install()).code).toBe(0);
    }
    await mkdir(join(home, data, '.3.0.0.tmp.99'));
    expect((await install({}, join(home, data, 'current'))).code).toBe(0);
    expect((await readdir(join(home, data))).sort()).toEqual(['2.0.0', '3.0.0', 'current']);
  });

  it('refuses to run as root', async () => {
    const id = await stub('id', 'if [ "$1" = -u ]; then echo 0; else echo root; fi');
    expect(id).toBeTruthy();
    const { code, stderr } = await install({
      PATH: `${stubs}:${process.env.PATH ?? ''}`,
    });
    expect(code).toBe(1);
    expect(stderr).toContain('not root');
  });

  it('refuses an empty or path-like VERSION', async () => {
    for (const v of ['', '../evil']) {
      await writeFile(join(release, 'VERSION'), `${v}\n`);
      const { code } = await install();
      expect(code).toBe(1);
    }
  });

  it('exits clearly when the user systemd manager is unavailable', async () => {
    const { code, stderr } = await install({ SYSTEMCTL: 'false' });
    expect(code).toBe(1);
    expect(stderr).toContain('systemd user manager');
  });

  it('the launcher resolves its symlink and passes arguments through unchanged', async () => {
    await install();
    const { code, stdout } = await sh(
      join(home, '.local/bin/threadgarden'),
      ['pair', '--x', 'a b'],
      { HOME: home },
    );
    expect(code).toBe(0);
    const args = stdout.split('\n').filter((l) => l.startsWith('arg:'));
    expect(args[0]).toBe('arg:--disable-warning=ExperimentalWarning');
    expect(args[1]).toMatch(/lib\/service\.mjs$/);
    expect(args.slice(2)).toEqual(['arg:pair', 'arg:--x', 'arg:a b']);
  });
});
