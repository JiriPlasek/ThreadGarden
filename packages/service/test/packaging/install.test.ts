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
      // Never the real /proc either: a run inside WSL must test the plain Linux case.
      PROC_ROOT: join(root, 'no-proc'),
      ...extra,
    });
  };

  /** A pkcheck that says this, and prints what the real one prints when it allows. */
  const pkcheck = (exit: number) =>
    stub(
      'pkcheck',
      `echo "pkcheck $*" >> "$LOG"\n[ ${exit} -ne 0 ] || printf '%s\\n' 'polkit\\56result=yes'\nexit ${exit}`,
    );

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

  describe('skipped sudo steps', () => {
    const skippedLines = async (file: string) =>
      (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean);

    it('a sudo that fails for lingering writes linger to THREADGARDEN_SKIPPED_FILE', async () => {
      const rules = join(root, 'rules.d');
      await mkdir(rules);
      // The first run puts the rule in place, so only lingering is left to skip.
      expect((await install({ POLKIT_RULES_DIR: rules })).code).toBe(0);
      const skipped = join(root, 'skipped');
      const { code } = await install({
        POLKIT_RULES_DIR: rules,
        SUDO: 'false',
        THREADGARDEN_SKIPPED_FILE: skipped,
      });
      expect(code).toBe(0);
      expect(await skippedLines(skipped)).toEqual(['linger']);
    });

    it('a sudo that fails for the polkit rule writes polkit', async () => {
      const rules = join(root, 'rules.d');
      await mkdir(rules);
      const skipped = join(root, 'skipped');
      const { code } = await install({
        POLKIT_RULES_DIR: rules,
        LINGER: 'yes',
        SUDO: 'false',
        THREADGARDEN_SKIPPED_FILE: skipped,
      });
      expect(code).toBe(0);
      expect(await skippedLines(skipped)).toEqual(['polkit']);
    });

    // install.sh explains it on stderr; a note would promise a fix that can't work.
    it('a missing polkit rules directory writes no marker', async () => {
      const skipped = join(root, 'skipped');
      const { code, stderr } = await install({
        POLKIT_RULES_DIR: join(root, 'missing'),
        LINGER: 'yes',
        THREADGARDEN_SKIPPED_FILE: skipped,
      });
      expect(code).toBe(0);
      expect(stderr).toContain("won't be able to power");
      expect(await skippedLines(skipped)).toEqual([]);
    });

    it('a readable rule that differs, with a failing sudo, writes polkit without asking polkit', async () => {
      const rules = join(root, 'rules.d');
      await mkdir(rules);
      await writeFile(join(rules, '49-threadgarden-power.rules'), '// an older rule\n');
      const skipped = join(root, 'skipped');
      const { code } = await install({
        POLKIT_RULES_DIR: rules,
        PKCHECK: await pkcheck(0),
        LINGER: 'yes',
        SUDO: 'false',
        THREADGARDEN_SKIPPED_FILE: skipped,
      });
      expect(code).toBe(0);
      expect(await skippedLines(skipped)).toEqual(['polkit']);
      expect((await calls()).some((l) => l.startsWith('pkcheck'))).toBe(false);
    });

    it('a rule plainly not there is not asked of polkit, which may allow it for other reasons', async () => {
      const rules = join(root, 'rules.d');
      await mkdir(rules);
      const skipped = join(root, 'skipped');
      const { code } = await install({
        POLKIT_RULES_DIR: rules,
        PKCHECK: await pkcheck(0),
        LINGER: 'yes',
        SUDO: 'false',
        THREADGARDEN_SKIPPED_FILE: skipped,
      });
      expect(code).toBe(0);
      expect(await skippedLines(skipped)).toEqual(['polkit']);
      expect((await calls()).some((l) => l.startsWith('pkcheck'))).toBe(false);
    });

    describe('a rule it cannot read', () => {
      let rules: string;
      const skipped = () => join(root, 'skipped');

      // As on Ubuntu, where the directory is 750 root:polkitd. Opened again for the
      // cleanup. The suite above never runs as root, for whom this would do nothing.
      const installByHandClosed = async (extra: Record<string, string>) => {
        rules = join(root, 'rules.d');
        await mkdir(rules);
        await writeFile(join(rules, '49-threadgarden-power.rules'), '// the rule\n');
        await chmod(rules, 0o000);
        try {
          return await install({ POLKIT_RULES_DIR: rules, LINGER: 'yes', ...extra });
        } finally {
          await chmod(rules, 0o755);
        }
      };

      /** Unattended, as an update runs it: the variable is what says so. */
      const installClosed = (extra: Record<string, string>) =>
        installByHandClosed({ THREADGARDEN_SKIPPED_FILE: skipped(), ...extra });

      it('by hand, an unreadable rule is offered through sudo and pkcheck is not asked', async () => {
        const { code, stdout } = await installByHandClosed({ PKCHECK: await pkcheck(0) });
        expect(code).toBe(0);
        expect(stdout).not.toContain('already in place');
        const c = await calls();
        expect(c.some((l) => l.startsWith('pkcheck'))).toBe(false);
        expect(c.some((l) => l.startsWith('sudo tee '))).toBe(true);
        expect(await readdir(root)).not.toContain('skipped');
      });

      it('an unreadable rule that polkit allows asks for nothing and writes no marker', async () => {
        const { code, stdout } = await installClosed({ PKCHECK: await pkcheck(0) });
        expect(code).toBe(0);
        expect(stdout).toContain('already in place');
        expect(stdout).not.toContain('polkit\\56result');
        expect(await skippedLines(skipped())).toEqual([]);
        const c = await calls();
        expect(c.some((l) => l.startsWith('sudo'))).toBe(false);
        const asked = c.filter((l) => l.startsWith('pkcheck'));
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatch(
          /^pkcheck --action-id org\.freedesktop\.login1\.power-off --process \d+$/,
        );
        expect(await readFile(join(rules, '49-threadgarden-power.rules'), 'utf8')).toBe(
          '// the rule\n',
        );
      });

      it.each([1, 2, 3])(
        'an unreadable rule that polkit refuses (exit %i), with a failing sudo, writes polkit',
        async (refusal) => {
          const { code } = await installClosed({
            PKCHECK: await pkcheck(refusal),
            SUDO: 'false',
          });
          expect(code).toBe(0);
          expect(await skippedLines(skipped())).toEqual(['polkit']);
        },
      );

      it('an unreadable rule that polkit refuses still offers to write it with sudo', async () => {
        const { code, stdout } = await installClosed({ PKCHECK: await pkcheck(1) });
        expect(code).toBe(0);
        expect(stdout).toContain('Could not write');
        expect((await calls()).some((l) => l.startsWith('sudo tee '))).toBe(true);
      });

      it('an unreadable rule without pkcheck, with a failing sudo, writes no marker', async () => {
        const { code, stdout } = await installClosed({
          PKCHECK: join(root, 'no-pkcheck-here'),
          SUDO: 'false',
        });
        expect(code).toBe(0);
        expect(stdout).toContain('Could not write');
        expect(await skippedLines(skipped())).toEqual([]);
      });

      it('an unreadable rule and a pkcheck that errors, with a failing sudo, writes no marker', async () => {
        const { code, stdout } = await installClosed({
          PKCHECK: await pkcheck(127),
          SUDO: 'false',
        });
        expect(code).toBe(0);
        expect(stdout).toContain('Could not write');
        expect(await skippedLines(skipped())).toEqual([]);
      });
    });

    it('a matching polkit rule and Linger=yes write nothing', async () => {
      const rules = join(root, 'rules.d');
      await mkdir(rules);
      expect((await install({ POLKIT_RULES_DIR: rules })).code).toBe(0);
      const skipped = join(root, 'skipped');
      const { code } = await install({
        POLKIT_RULES_DIR: rules,
        LINGER: 'yes',
        SUDO: 'false',
        THREADGARDEN_SKIPPED_FILE: skipped,
      });
      expect(code).toBe(0);
      expect(await skippedLines(skipped)).toEqual([]);
    });

    it('without THREADGARDEN_SKIPPED_FILE nothing is written and output is unchanged', async () => {
      const { code, stdout, stderr } = await install({ SUDO: 'false' });
      expect(code).toBe(0);
      expect(stdout).toContain("Could not enable lingering; run 'sudo loginctl enable-linger");
      expect(stderr).toContain("won't be able to power");
      expect(await readdir(root)).not.toContain('skipped');
    });
  });

  describe('in WSL', () => {
    const WSL_NOTE = 'Running in WSL: Windows does the powering off, so no polkit rule is needed.';
    const skippedLines = async (file: string) =>
      (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean);

    /** A stand-in for `/proc` holding just these files (paths below it, e.g. `sys/kernel/osrelease`). */
    const procRoot = async (files: Record<string, string>) => {
      const dir = join(root, 'proc-root');
      for (const [path, text] of Object.entries(files)) {
        const file = join(dir, 'proc', path);
        await mkdir(join(file, '..'), { recursive: true });
        await writeFile(file, text);
      }
      return dir;
    };

    it('in WSL the polkit rule is neither asked for nor marked skipped', async () => {
      // A rules directory it can't read, as on Ubuntu: outside WSL, that asks polkit.
      const rules = join(root, 'rules.d');
      await mkdir(rules);
      await chmod(rules, 0o000);
      const skipped = join(root, 'skipped');
      let result: Awaited<ReturnType<typeof install>>;
      try {
        result = await install({
          WSL_DISTRO_NAME: 'threadgarden',
          POLKIT_RULES_DIR: rules,
          PKCHECK: await pkcheck(1),
          LINGER: 'yes',
          SUDO: 'false',
          THREADGARDEN_SKIPPED_FILE: skipped,
        });
      } finally {
        await chmod(rules, 0o755);
      }
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(WSL_NOTE);
      expect(result.stdout).not.toContain('sudo tee');
      expect(result.stdout).not.toContain('Could not write');
      expect(result.stderr).not.toContain("won't be able to power");
      expect(await skippedLines(skipped)).toEqual([]);
      const c = await calls();
      expect(c.some((l) => l.startsWith('sudo') || l.startsWith('pkcheck'))).toBe(false);
      expect(c).toContain('systemctl --user restart threadgarden');
    });

    it('in WSL lingering is still asked for', async () => {
      const { code, stdout } = await install({ WSL_DISTRO_NAME: 'threadgarden' });
      expect(code).toBe(0);
      expect(stdout).toContain('sudo loginctl enable-linger tester');
      expect(stdout).toContain(WSL_NOTE);
      expect(await calls()).toContain('sudo loginctl enable-linger tester');

      // And a sudo that fails for it is still marked, unattended.
      const skipped = join(root, 'skipped');
      const again = await install({
        WSL_DISTRO_NAME: 'threadgarden',
        SUDO: 'false',
        THREADGARDEN_SKIPPED_FILE: skipped,
      });
      expect(again.code).toBe(0);
      expect(await skippedLines(skipped)).toEqual(['linger']);
    });

    it.each([
      ['the interop entry', { 'sys/fs/binfmt_misc/WSLInterop': '' }],
      ['the interop entry systemd registers late', { 'sys/fs/binfmt_misc/WSLInterop-late': '' }],
      ['a WSL 2 kernel', { 'sys/kernel/osrelease': '6.6.87.2-microsoft-standard-WSL2\n' }],
      ['a WSL 1 kernel', { 'sys/kernel/osrelease': '4.4.0-19041-Microsoft\n' }],
    ])('%s alone says WSL, with no distro name', async (_, files) => {
      const { code, stdout } = await install({
        PROC_ROOT: await procRoot(files),
        LINGER: 'yes',
      });
      expect(code).toBe(0);
      expect(stdout).toContain(WSL_NOTE);
      expect((await calls()).some((l) => l.startsWith('sudo'))).toBe(false);
    });

    it('outside WSL nothing changes', async () => {
      const rules = join(root, 'rules.d');
      await mkdir(rules);
      const { code, stdout } = await install({
        PROC_ROOT: await procRoot({ 'sys/kernel/osrelease': '6.8.0-45-generic\n' }),
        // Set but empty is not a distro name.
        WSL_DISTRO_NAME: '',
        POLKIT_RULES_DIR: rules,
        LINGER: 'yes',
      });
      expect(code).toBe(0);
      expect(stdout).not.toContain('Running in WSL');
      expect(stdout).toContain('needs a polkit rule');
      expect((await calls()).some((l) => l.startsWith('sudo tee ') && l.endsWith('.rules'))).toBe(
        true,
      );
    });
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
