import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../packaging/windows-wsl/setup-worker.ps1',
);

/** Windows PowerShell 5.1 and PowerShell 7, whichever this machine has. */
const shells = [...(process.platform === 'win32' ? ['powershell.exe'] : []), 'pwsh'].filter(
  (shell) => {
    const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      timeout: 60_000,
    });
    return !r.error && r.status === 0;
  },
);
/** 5.1 first: it is what a Windows PC has, and the stricter of the two. */
const shell = shells[0];

/**
 * Replaces everything that touches Windows (see the script's seams). State lives in
 * files under TG_STUB_DIR, so a second run sees what the first one did; every call
 * that would change Windows, and every question, goes to calls.log.
 */
const STUBS = String.raw`
$StubDir = $env:TG_STUB_DIR
function Get-StubPath([string]$Name) { Join-Path $StubDir $Name }
function Write-StubCall([string]$Line) { Add-Content -LiteralPath (Get-StubPath 'calls.log') -Value $Line }
function Test-TgAdmin { -not (Test-Path -LiteralPath (Get-StubPath 'not-admin')) }
function Get-TgBuild {
  $p = Get-StubPath 'build'
  if (Test-Path -LiteralPath $p) { [int](Get-Content -LiteralPath $p) } else { 26200 }
}
function Get-TgUser { 'PC\owner' }
function Test-TgWsl { -not (Test-Path -LiteralPath (Get-StubPath 'no-wsl')) }
function Get-TgDistros {
  $p = Get-StubPath 'distros'
  if (Test-Path -LiteralPath $p) { @(Get-Content -LiteralPath $p) } else { @() }
}
function Invoke-TgWsl {
  param([string[]]$Arguments)
  Write-StubCall ('wsl ' + ($Arguments -join ' '))
  $p = Get-StubPath 'distros'
  if ($Arguments[0] -eq '--install' -and $Arguments.Count -eq 5) { Add-Content -LiteralPath $p -Value $Arguments[4] }
  if ($Arguments[0] -eq '--unregister') {
    $keep = @(Get-TgDistros | Where-Object { $_ -ne $Arguments[1] })
    Set-Content -LiteralPath $p -Value $keep
  }
  0
}
function Test-TgFirewallRule { param([string]$Name) Test-Path -LiteralPath (Get-StubPath 'rule') }
function New-TgFirewallRule {
  param([string]$Name, [string]$VmCreatorId, [int]$Port)
  Write-StubCall "New-NetFirewallHyperVRule $Name $VmCreatorId TCP $Port"
  Set-Content -LiteralPath (Get-StubPath 'rule') -Value $Name
}
function Remove-TgFirewallRule {
  param([string]$Name)
  Write-StubCall "Remove-NetFirewallHyperVRule $Name"
  Remove-Item -LiteralPath (Get-StubPath 'rule')
}
function Test-TgTask { param([string]$Name) Test-Path -LiteralPath (Get-StubPath 'task') }
function Register-TgTask {
  param([string]$Name, [string]$Execute, [string]$Argument, [string]$User)
  $line = "Register-ScheduledTask $Name" + ": $Execute $Argument as $User"
  Write-StubCall $line
  Set-Content -LiteralPath (Get-StubPath 'task') -Value $line
}
function Unregister-TgTask {
  param([string]$Name)
  Write-StubCall "Unregister-ScheduledTask $Name"
  Remove-Item -LiteralPath (Get-StubPath 'task')
}
function Get-TgSleepQuery {
  $ac = '0x00000000'
  $p = Get-StubPath 'sleep-ac'
  if (Test-Path -LiteralPath $p) { $ac = (Get-Content -LiteralPath $p).Trim() }
  'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)'
  '      Minimum Possible Setting: 0x00000000'
  '      Maximum Possible Setting: 0xffffffff'
  '      Possible Settings increment: 0x00000001'
  '      Possible Settings units: Seconds'
  "    Current AC Power Setting Index: $ac"
  '    Current DC Power Setting Index: 0x00000384'
}
function Read-TgAnswer {
  param([string]$Prompt)
  Write-StubCall "ask: $Prompt"
  $env:TG_STUB_ANSWER
}
`;

const RULE =
  'New-NetFirewallHyperVRule ThreadgardenWorker {40E0AC32-46A5-438A-A0B2-2B479E8F2E90} TCP 47380';
const TASK =
  'Register-ScheduledTask Threadgarden worker: wsl.exe -d threadgarden --exec sleep infinity as PC\\owner';
const MARKED = ['# added by Threadgarden', 'networkingMode=mirrored'];

describe.skipIf(!shell)('the Windows setup script', () => {
  let root: string;
  let home: string;
  let state: string;
  let stubs: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tg-setup-worker-'));
    home = join(root, 'home');
    state = join(root, 'state');
    stubs = join(root, 'stubs.ps1');
    await mkdir(home);
    await mkdir(state);
    await writeFile(stubs, STUBS);
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  const config = () => join(home, '.wslconfig');
  const backup = () => join(home, '.wslconfig.bak-threadgarden');
  const read = (path: string) => readFile(path, 'utf8').catch(() => null);

  /** The calls since `from` (the log's line count before a run). */
  const calls = async (from = 0) =>
    ((await read(join(state, 'calls.log'))) ?? '').split(/\r?\n/).filter(Boolean).slice(from);

  const run = (args: string[] = [], o: { answer?: string } = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      execFile(
        shell!,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
        {
          env: {
            ...process.env,
            USERPROFILE: home,
            THREADGARDEN_SETUP_STUBS: stubs,
            TG_STUB_DIR: state,
            TG_STUB_ANSWER: o.answer ?? '',
          },
          timeout: 120_000,
        },
        (err, stdout, stderr) =>
          done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
    });

  it('parses on PowerShell 5.1 and 7', async () => {
    const parse =
      '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(' +
      '$env:TG_SCRIPT, [ref]$null, [ref]$e); $e | ForEach-Object { $_.Message }; exit $e.Count';
    for (const sh of shells) {
      const r = spawnSync(sh, ['-NoProfile', '-NonInteractive', '-Command', parse], {
        env: { ...process.env, TG_SCRIPT: script },
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect({ sh, status: r.status, out: r.stdout.trim() }).toEqual({ sh, status: 0, out: '' });
    }
    // ASCII only: 5.1 reads a file without a BOM in the ANSI code page.
    const bytes = await readFile(script);
    expect(bytes.findIndex((b) => b > 0x7f)).toBe(-1);
  });

  it('-DryRun prints every change as would: and changes nothing', async () => {
    await writeFile(join(state, 'sleep-ac'), '0x00000708');
    const { code, stdout } = await run(['-DryRun']);
    expect(code).toBe(0);
    const would = stdout.split(/\r?\n/).filter((l) => l.startsWith('would: '));
    expect(would).toEqual([
      'would: wsl --install -d Ubuntu-24.04 --name threadgarden',
      `would: add networkingMode=mirrored under [wsl2] in ${config()}`,
      "would: add the Hyper-V firewall rule 'ThreadgardenWorker' for TCP 47380",
      "would: add the scheduled task 'Threadgarden worker' (at startup, as PC\\owner): wsl.exe -d threadgarden --exec sleep infinity",
      'would: ask whether to run wsl --shutdown (default no)',
    ]);
    // Sleep after 30 minutes on mains power is pointed out.
    expect(stdout).toContain('after 30 minutes');
    expect(stdout).toContain('powercfg /change standby-timeout-ac 0');
    // The next steps start in the home folder.
    expect(stdout).toMatch(/^ {2}cd ~\r?$/m);
    expect(stdout).toContain('./install.sh');
    expect(await calls()).toEqual([]);
    expect(await read(config())).toBeNull();
  });

  it('adds mirrored under an existing [wsl2] and keeps its other lines', async () => {
    const before =
      '[wsl2]\r\nmemory=8GB\r\nprocessors=4\r\n\r\n[experimental]\r\nautoMemoryReclaim=gradual\r\n';
    await writeFile(config(), before);
    const { code, stdout } = await run();
    expect(code).toBe(0);
    expect(await read(config())).toBe(
      '[wsl2]\r\n# added by Threadgarden\r\nnetworkingMode=mirrored\r\nmemory=8GB\r\nprocessors=4\r\n' +
        '\r\n[experimental]\r\nautoMemoryReclaim=gradual\r\n',
    );
    expect(await read(backup())).toBe(before);
    expect(stdout).toContain('applies to all your WSL distros and to Docker Desktop');
  });

  it('adds a [wsl2] section to a file without one, and makes the file when there is none', async () => {
    await writeFile(config(), '[experimental]\nhostAddressLoopback=true');
    expect((await run()).code).toBe(0);
    expect(await read(config())).toBe(
      '[experimental]\nhostAddressLoopback=true\n\n[wsl2]\n# added by Threadgarden\nnetworkingMode=mirrored\n',
    );

    await rm(config());
    await rm(backup());
    expect((await run()).code).toBe(0);
    expect(await read(config())).toBe(
      '[wsl2]\r\n# added by Threadgarden\r\nnetworkingMode=mirrored\r\n',
    );
    // Nothing to back up.
    expect(await read(backup())).toBeNull();
  });

  it('stops when networkingMode is already something else', async () => {
    const before = '[wsl2]\r\nnetworkingMode=nat\r\n';
    await writeFile(config(), before);
    const { code, stderr } = await run();
    expect(code).not.toBe(0);
    expect(stderr).toContain('networkingMode=nat');
    expect(await read(config())).toBe(before);
    expect(await read(backup())).toBeNull();
    // It stopped there: no firewall rule, no task.
    const c = await calls();
    expect(c.some((l) => l.startsWith('New-NetFirewallHyperVRule'))).toBe(false);
    expect(c.some((l) => l.startsWith('Register-ScheduledTask'))).toBe(false);
  });

  it('running setup twice changes nothing the second time', async () => {
    await writeFile(config(), '[wsl2]\r\nmemory=8GB\r\n');
    expect((await run()).code).toBe(0);
    const first = await calls();
    expect(first).toContain('wsl --install -d Ubuntu-24.04 --name threadgarden');
    expect(first).toContain(RULE);
    expect(first).toContain(TASK);
    const configAfter = await read(config());
    const backupAfter = await read(backup());
    const taskAfter = await read(join(state, 'task'));

    const dry = await run(['-DryRun']);
    expect(dry.stdout.split(/\r?\n/).filter((l) => l.startsWith('would: '))).toEqual([
      "would: replace the scheduled task 'Threadgarden worker' (at startup, as PC\\owner): wsl.exe -d threadgarden --exec sleep infinity",
      'would: ask whether to run wsl --shutdown (default no)',
    ]);

    const again = await run();
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('Mirrored networking is already on');
    expect(again.stdout).toContain("The firewall rule 'ThreadgardenWorker' is already there.");
    expect(again.stdout).toContain("The WSL distro 'threadgarden' is already there.");
    const second = await calls(first.length);
    expect(second.filter((l) => !l.startsWith('ask: '))).toEqual([TASK]);
    // The same line once, the same backup, and the task replaced by an identical one.
    expect(await read(config())).toBe(configAfter);
    expect((configAfter ?? '').split('networkingMode=mirrored').length).toBe(2);
    expect(await read(backup())).toBe(backupAfter);
    expect(await read(join(state, 'task'))).toBe(taskAfter);
  });

  it('-Remove takes out only the added line, the rule and the task', async () => {
    const before = '[wsl2]\r\nmemory=8GB\r\n';
    await writeFile(config(), before);
    expect((await run()).code).toBe(0);
    // The user edits the file afterwards: those edits stay.
    const edited = (await read(config()))!.replace('memory=8GB', 'memory=16GB\r\nprocessors=4');
    await writeFile(config(), edited);
    const from = (await calls()).length;

    const { code, stdout } = await run(['-Remove']);
    expect(code).toBe(0);
    expect(await read(config())).toBe('[wsl2]\r\nmemory=16GB\r\nprocessors=4\r\n');
    expect(await read(join(state, 'rule'))).toBeNull();
    expect(await read(join(state, 'task'))).toBeNull();
    const c = await calls(from);
    expect(c).toEqual([
      'Unregister-ScheduledTask Threadgarden worker',
      'Remove-NetFirewallHyperVRule ThreadgardenWorker',
      "ask: Unregister the WSL distro 'threadgarden'? This deletes everything in it for good. [y/N]",
    ]);
    // Asked, and no is the default: the distro stays.
    expect(stdout).toContain("Kept the WSL distro 'threadgarden'");
    expect(await read(backup())).toBe(before);
  });

  it('-Remove leaves a line it marked but the user changed', async () => {
    await writeFile(config(), `[wsl2]\r\n${MARKED[0]}\r\nnetworkingMode=nat\r\n`);
    const { code, stdout } = await run(['-Remove']);
    expect(code).toBe(0);
    expect(stdout).toContain('was changed since, so it stays');
    expect(await read(config())).toBe(`[wsl2]\r\n${MARKED[0]}\r\nnetworkingMode=nat\r\n`);
  });

  it('-Remove twice reports nothing to remove', async () => {
    expect((await run()).code).toBe(0);
    const first = await run(['-Remove'], { answer: 'y' });
    expect(first.code).toBe(0);
    expect(await calls()).toContain('wsl --unregister threadgarden');
    expect(first.stdout).not.toContain('Nothing to remove.');
    const from = (await calls()).length;

    const second = await run(['-Remove'], { answer: 'y' });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('Nothing to remove.');
    expect(second.stdout).toContain("No scheduled task 'Threadgarden worker' to remove.");
    expect(second.stdout).toContain("No firewall rule 'ThreadgardenWorker' to remove.");
    expect(second.stdout).toContain("No WSL distro 'threadgarden' to unregister.");
    expect(await calls(from)).toEqual([]);
    expect(await read(config())).toBe('[wsl2]\r\n');
  });

  it('asks before wsl --shutdown and defaults to no', async () => {
    const no = await run();
    expect(no.code).toBe(0);
    expect(no.stdout).toContain('stops every running distro, and Docker Desktop');
    let c = await calls();
    expect(c).toContain('ask: Run wsl --shutdown now? [y/N]');
    expect(c).not.toContain('wsl --shutdown');

    let from = c.length;
    await run([], { answer: 'y' });
    c = await calls(from);
    expect(c.slice(-2)).toEqual(['ask: Run wsl --shutdown now? [y/N]', 'wsl --shutdown']);

    // -Yes answers for an unattended run, without asking.
    from = (await calls()).length;
    await run(['-Yes']);
    c = await calls(from);
    expect(c).toContain('wsl --shutdown');
    expect(c.some((l) => l.startsWith('ask: '))).toBe(false);
  });

  it('needs administrator, Windows 11 22H2 and WSL, and installs WSL first when missing', async () => {
    await writeFile(join(state, 'not-admin'), '');
    const notAdmin = await run();
    expect(notAdmin.code).toBe(1);
    expect(notAdmin.stderr).toContain('as administrator');
    await rm(join(state, 'not-admin'));

    await writeFile(join(state, 'build'), '19045');
    const windows10 = await run();
    expect(windows10.code).toBe(1);
    expect(windows10.stderr).toContain('build 22621');
    expect(windows10.stderr).toContain('build 19045');
    await rm(join(state, 'build'));

    await writeFile(join(state, 'no-wsl'), '');
    const noWsl = await run();
    expect(noWsl.code).toBe(0);
    expect(noWsl.stdout).toContain('Restart Windows, then run this script again.');
    // Nothing past WSL itself: the distro needs the restart first.
    expect(await calls()).toEqual(['wsl --install --no-distribution']);
  });
});
