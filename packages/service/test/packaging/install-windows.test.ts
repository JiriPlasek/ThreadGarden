import { execFile, execFileSync } from 'node:child_process';
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const packaging = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../packaging/headless-windows',
);

type Ran = { code: number; stdout: string; stderr: string };

const run = (file: string, args: string[], env: Record<string, string>) =>
  new Promise<Ran>((done) => {
    execFile(
      file,
      args,
      { env: { ...process.env, ...env }, windowsHide: true },
      (err, stdout, stderr) =>
        done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });

const elevated = (): boolean =>
  process.platform === 'win32' &&
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ],
    { encoding: 'utf8' },
  ).trim() === 'True';

/** What install.ps1 asks an elevated PowerShell to run, exactly. */
const ruleCommand = (nodeExe: string) =>
  "New-NetFirewallRule -Name 'Threadgarden-headless' -DisplayName 'Threadgarden headless' " +
  '-Direction Inbound -Action Allow -Protocol TCP -LocalPort 47380 ' +
  `-Program '${nodeExe.replace(/'/g, "''")}' ` +
  '-RemoteAddress 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10 -Profile Any';

describe.skipIf(process.platform !== 'win32')('headless install.ps1', { timeout: 60_000 }, () => {
  let root: string;
  let local: string;
  let base: string;
  let log: string;
  let cli: string;
  let elevate: string;

  /** A release folder for `version`, with a stand-in node.exe whose text names its version. */
  const release = async (version: string, versionText = `${version}\n`) => {
    const dir = join(root, 'releases', `threadgarden-headless-${version}`);
    await mkdir(join(dir, 'bin'), { recursive: true });
    await mkdir(join(dir, 'lib'), { recursive: true });
    await copyFile(join(packaging, 'install.ps1'), join(dir, 'install.ps1'));
    await copyFile(join(packaging, 'threadgarden.cmd'), join(dir, 'bin', 'threadgarden.cmd'));
    await writeFile(join(dir, 'bin', 'node.exe'), `node-${version}\r\n`);
    await writeFile(join(dir, 'lib', 'service.mjs'), '');
    await writeFile(join(dir, 'VERSION'), versionText);
    return dir;
  };

  const install = (dir: string, extra: Record<string, string> = {}) =>
    run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(dir, 'install.ps1'),
      ],
      {
        LOCALAPPDATA: local,
        THREADGARDEN_PATH_SCOPE: 'Process',
        THREADGARDEN_ALLOW_ELEVATED: '1',
        THREADGARDEN_CLI: cli,
        THREADGARDEN_ELEVATE: elevate,
        CALLS: log,
        ...extra,
      },
    );

  const calls = async () =>
    (await readFile(log, 'utf8'))
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

  const versions = async () =>
    (await readdir(base)).filter((n) => !['bin', 'node', 'current'].includes(n)).sort();

  beforeEach(async () => {
    root = join(await mkdtemp(join(tmpdir(), 'tg-win-')), 'with space');
    local = join(root, 'local');
    base = join(local, 'threadgarden-headless');
    log = join(root, 'calls.log');
    await mkdir(local, { recursive: true });
    await writeFile(log, '');
    // The CLI stand-in logs each call with the first line of the stable node.exe at that moment.
    cli = join(root, 'cli.cmd');
    await writeFile(
      cli,
      [
        '@echo off',
        'set "N=none"',
        'if exist "%LOCALAPPDATA%\\threadgarden-headless\\node\\node.exe" set /p N=<"%LOCALAPPDATA%\\threadgarden-headless\\node\\node.exe"',
        '>>"%CALLS%" echo cli:%* node=%N%',
        'exit /b 0',
        '',
      ].join('\r\n'),
    );
    elevate = join(root, 'elevate.cmd');
    await writeFile(elevate, '@echo off\r\n>>"%CALLS%" echo elevate:%*\r\nexit /b 0\r\n');
  });

  afterEach(() => rm(resolve(root, '..'), { recursive: true, force: true }));

  it('installs the release, points current at it, copies the launcher and node.exe', async () => {
    const r = await install(await release('9.9.9'));
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(await realpath(join(base, 'current'))).toBe(await realpath(join(base, '9.9.9')));
    expect(await readFile(join(base, 'bin', 'threadgarden.cmd'), 'utf8')).toBe(
      await readFile(join(packaging, 'threadgarden.cmd'), 'utf8'),
    );
    expect(await readFile(join(base, 'node', 'node.exe'), 'utf8')).toBe('node-9.9.9\r\n');
    expect(r.stdout).toContain('Installing Threadgarden headless 9.9.9');
    expect(r.stdout).toContain(`Added ${join(base, 'bin')} to your PATH`);
    expect(r.stdout).toContain('Installed. Pair this machine with your desktop: threadgarden pair');
  });

  it('stops the service before replacing node.exe and starts it after', async () => {
    expect((await install(await release('9.9.8'))).code).toBe(0);
    expect((await install(await release('9.9.9'))).code).toBe(0);
    // The first install has no node.exe to run a stop with, so it only starts.
    expect((await calls()).filter((c) => c.startsWith('cli:'))).toEqual([
      'cli:start node=node-9.9.8',
      'cli:stop node=node-9.9.8',
      'cli:start node=node-9.9.9',
    ]);
  });

  it('adds the firewall rule through the elevated command, with the exact arguments', async () => {
    const r = await install(await release('9.9.9'));
    expect(r.code).toBe(0);
    const elevations = (await calls()).filter((c) => c.startsWith('elevate:'));
    expect(elevations).toHaveLength(1);
    const encoded = /-EncodedCommand (\S+)/.exec(elevations[0]!)?.[1];
    expect(encoded).toBeDefined();
    const command = Buffer.from(encoded!, 'base64').toString('utf16le');
    expect(command).toContain(ruleCommand(join(base, 'node', 'node.exe')));
    expect(r.stdout).toContain('Added the firewall rule');
  });

  it('goes on without the firewall rule when elevation fails, and says so', async () => {
    await writeFile(elevate, '@echo off\r\n>>"%CALLS%" echo elevate:%*\r\nexit /b 1\r\n');
    const r = await install(await release('9.9.9'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "Skipped the firewall rule; other devices can't reach this machine until install.ps1 is run again and the rule is allowed.",
    );
    expect(await calls()).toContain('cli:start node=node-9.9.9');
  });

  it('unattended never elevates and prints no pairing advice', async () => {
    const r = await install(await release('9.9.9'), { THREADGARDEN_UNATTENDED: '1' });
    expect(r.code).toBe(0);
    expect((await calls()).filter((c) => c.startsWith('elevate:'))).toEqual([]);
    expect(r.stdout).not.toContain('threadgarden pair');
    expect(await calls()).toContain('cli:start node=node-9.9.9');
  });

  it('fails when the service does not start', async () => {
    await writeFile(cli, '@echo off\r\n>>"%CALLS%" echo cli:%*\r\nexit /b 1\r\n');
    const r = await install(await release('9.9.9'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Threadgarden did not start');
  });

  it('upgrading keeps the previous version and prunes older ones', async () => {
    for (const v of ['9.9.7', '9.9.8', '9.9.9'])
      expect((await install(await release(v))).code).toBe(0);
    expect(await versions()).toEqual(['9.9.8', '9.9.9']);
  });

  it('leaves the current release intact if stopping fails', async () => {
    expect((await install(await release('9.9.8'))).code).toBe(0);
    await writeFile(cli, '@echo off\r\nexit /b 1\r\n');
    const failed = await install(await release('9.9.9'));
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('Threadgarden did not stop');
    expect(await realpath(join(base, 'current'))).toBe(await realpath(join(base, '9.9.8')));
    expect(await readFile(join(base, 'node', 'node.exe'), 'utf8')).toBe('node-9.9.8\r\n');
  });

  it('does not prune unrelated directories under the installation', async () => {
    expect((await install(await release('9.9.8'))).code).toBe(0);
    await mkdir(join(base, 'notes'));
    await writeFile(join(base, 'notes', 'keep.txt'), 'keep');
    expect((await install(await release('9.9.9'))).code).toBe(0);
    expect(await readFile(join(base, 'notes', 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('reinstalling the same version keeps the previous one', async () => {
    for (const v of ['9.9.8', '9.9.9', '9.9.9'])
      expect((await install(await release(v))).code).toBe(0);
    expect(await versions()).toEqual(['9.9.8', '9.9.9']);
    // The installed copy run again changes nothing either.
    expect((await install(join(base, '9.9.9'))).code).toBe(0);
    expect(await versions()).toEqual(['9.9.8', '9.9.9']);
    expect(await realpath(join(base, 'current'))).toBe(await realpath(join(base, '9.9.9')));
  });

  it.skipIf(!elevated())(
    'refuses to run elevated without THREADGARDEN_ALLOW_ELEVATED',
    async () => {
      const r = await install(await release('9.9.9'), { THREADGARDEN_ALLOW_ELEVATED: '' });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Run install.ps1 as your own user, not as administrator.');
    },
  );

  it('rejects an invalid VERSION', async () => {
    const bad = await install(await release('bad', '../x\n'));
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Invalid VERSION '../x'.");
    const empty = await install(await release('empty', '\n'));
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain('Empty VERSION.');
  });

  it('the launcher runs node\\node.exe on current\\lib\\service.mjs with the arguments', async () => {
    await mkdir(join(base, 'bin'), { recursive: true });
    await mkdir(join(base, 'node'), { recursive: true });
    await mkdir(join(base, '9.9.9', 'lib'), { recursive: true });
    await copyFile(join(packaging, 'threadgarden.cmd'), join(base, 'bin', 'threadgarden.cmd'));
    const node = join(base, 'node', 'node.exe');
    await link(process.execPath, node).catch(() => copyFile(process.execPath, node));
    await writeFile(
      join(base, '9.9.9', 'lib', 'service.mjs'),
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), execArgv: process.execArgv }));\n',
    );
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', join(base, 'current'), join(base, '9.9.9')]);
    // A .cmd only runs through cmd.exe; /s keeps the quoted path with its space intact.
    const r = await new Promise<Ran>((done) => {
      execFile(
        'cmd.exe',
        ['/d', '/s', '/c', `""${join(base, 'bin', 'threadgarden.cmd')}" status "a b""`],
        { windowsVerbatimArguments: true, windowsHide: true },
        (err, stdout, stderr) =>
          done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
    });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      argv: ['status', 'a b'],
      execArgv: ['--disable-warning=ExperimentalWarning'],
    });
  });
});
