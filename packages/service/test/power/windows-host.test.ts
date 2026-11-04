import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QUSER,
  REG,
  RESTART_KEYS,
  SHUTDOWN_EXE,
  detectWsl,
  windowsHost,
  type RunResult,
} from '../../src/power/windows-host.js';

afterEach(() => {
  vi.useRealTimers();
});

type Call = { file: string; args: string[]; timeoutMs: number };

/** A `run` that answers from `reply` and records every call. */
function fakeRun(reply: (file: string, args: string[]) => Promise<RunResult> | RunResult) {
  const calls: Call[] = [];
  const run = async (file: string, args: string[], o: { timeoutMs: number }) => {
    calls.push({ file, args, timeoutMs: o.timeoutMs });
    return reply(file, args);
  };
  return { run, calls };
}

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const exit = (code: number, stderr = ''): RunResult => ({ code, stdout: '', stderr });

const QUSER_HEADER =
  ' USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME\r\n';

describe('detectWsl', () => {
  it('detectWsl is true with WSLInterop or WSL_DISTRO_NAME, false otherwise', () => {
    const interop = '/proc/sys/fs/binfmt_misc/WSLInterop';
    expect(detectWsl({ exists: (p) => p === interop, env: {} })).toBe(true);
    expect(detectWsl({ exists: () => false, env: { WSL_DISTRO_NAME: 'threadgarden' } })).toBe(true);
    expect(detectWsl({ exists: () => false, env: {} })).toBe(false);
    // Set but empty is not a distro name.
    expect(detectWsl({ exists: () => false, env: { WSL_DISTRO_NAME: '' } })).toBe(false);
  });
});

describe('windowsHost', () => {
  it('signedIn: quser exit 0 with a session line is true, exit 1 is false', async () => {
    const signed = fakeRun(() =>
      ok(
        `${QUSER_HEADER}>owner                 console             1  Active      none   04/11/2026 09:12\r\n`,
      ),
    );
    expect(await windowsHost({ run: signed.run }).signedIn()).toBe(true);
    expect(signed.calls).toEqual([{ file: QUSER, args: [], timeoutMs: 15_000 }]);

    const nobody = fakeRun(() => exit(1, 'No User exists for *\r\n'));
    expect(await windowsHost({ run: nobody.run }).signedIn()).toBe(false);

    // Only the header: no session.
    const header = fakeRun(() => ok(QUSER_HEADER));
    expect(await windowsHost({ run: header.run }).signedIn()).toBe(false);
  });

  it('signedIn: any other failure counts as nobody, and is logged', async () => {
    const warnings: string[] = [];
    const log = { warn: (m: string) => void warnings.push(m) };
    const missing = fakeRun(() => {
      throw Object.assign(new Error(`spawn ${QUSER} ENOENT`), { code: 'ENOENT' });
    });
    expect(await windowsHost({ run: missing.run, log }).signedIn()).toBe(false);
    const odd = fakeRun(() => exit(5, 'Access is denied.\r\n'));
    expect(await windowsHost({ run: odd.run, log }).signedIn()).toBe(false);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('Access is denied.');
  });

  it('a quser that hangs counts as nobody after its timeout', async () => {
    vi.useFakeTimers();
    const hang = fakeRun(() => new Promise<RunResult>(() => {}));
    let answer: boolean | undefined;
    void windowsHost({ run: hang.run })
      .signedIn()
      .then((v) => (answer = v));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toBe(false);
  });

  it('restartPending: any of the three keys makes it true; reg failing makes it false', async () => {
    expect(RESTART_KEYS).toEqual([
      [
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired',
      ],
      [
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending',
      ],
      [
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager',
        '/v',
        'PendingFileRenameOperations',
      ],
    ]);
    // reg.exe exits 1 for a key or value that is not there.
    const none = fakeRun(() =>
      exit(1, 'ERROR: The system was unable to find the specified registry key or value.\r\n'),
    );
    expect(await windowsHost({ run: none.run }).restartPending()).toBe(false);
    expect(none.calls.map((c) => [c.file, c.args, c.timeoutMs])).toEqual(
      RESTART_KEYS.map((args) => [REG, args, 15_000]),
    );

    for (const key of RESTART_KEYS) {
      const one = fakeRun((_f, args) => (args.join() === key.join() ? ok() : exit(1)));
      expect(await windowsHost({ run: one.run }).restartPending()).toBe(true);
    }

    const broken = fakeRun(() => {
      throw new Error(`spawn ${REG} ENOENT`);
    });
    expect(await windowsHost({ run: broken.run }).restartPending()).toBe(false);
  });

  it('a reg that hangs counts as not pending after its timeout', async () => {
    vi.useFakeTimers();
    const hang = fakeRun(() => new Promise<RunResult>(() => {}));
    let answer: boolean | undefined;
    void windowsHost({ run: hang.run })
      .restartPending()
      .then((v) => (answer = v));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(answer).toBe(false);
  });

  it('shutdown runs shutdown.exe /s /t 0, or /s /f /t 0 when forced', async () => {
    const r = fakeRun(() => ok());
    const host = windowsHost({ run: r.run });
    await host.shutdown({ force: false });
    await host.shutdown({ force: true });
    expect(r.calls).toEqual([
      { file: SHUTDOWN_EXE, args: ['/s', '/t', '0'], timeoutMs: 30_000 },
      { file: SHUTDOWN_EXE, args: ['/s', '/f', '/t', '0'], timeoutMs: 30_000 },
    ]);
  });

  it('shutdown.exe that exits non-zero throws its first stderr line', async () => {
    const denied = fakeRun(() => exit(1, 'Access is denied.(5)\r\nmore\r\n'));
    await expect(windowsHost({ run: denied.run }).shutdown({ force: false })).rejects.toThrow(
      /^Access is denied\.\(5\)$/,
    );
    const silent = fakeRun(() => exit(1190));
    await expect(windowsHost({ run: silent.run }).shutdown({ force: false })).rejects.toThrow(
      'shutdown.exe exited with code 1190',
    );
  });

  it('shutdown.exe ended by a signal (Windows is going down) is not a failure', async () => {
    const ended = fakeRun(() => ({ code: null, stdout: '', stderr: '' }));
    await expect(
      windowsHost({ run: ended.run }).shutdown({ force: false }),
    ).resolves.toBeUndefined();
  });

  it('a shutdown.exe that hangs fails after 30 s, saying it timed out', async () => {
    vi.useFakeTimers();
    const hang = fakeRun(() => new Promise<RunResult>(() => {}));
    const done = windowsHost({ run: hang.run }).shutdown({ force: false });
    const settled = expect(done).rejects.toThrow('shutdown.exe timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
  });
});
