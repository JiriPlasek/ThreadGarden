import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { UpdateStatusSchema } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPLY_SCRIPT, applyArgs } from '../../src/update/apply-script.js';

const sh = (script: string, args: string[], env: Record<string, string>) =>
  new Promise<{ code: number; stderr: string }>((done) => {
    execFile(
      'sh',
      [script, ...args],
      { env: { PATH: process.env.PATH ?? '', ...env } },
      (err, _stdout, stderr) =>
        done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stderr }),
    );
  });

const isRoot = process.getuid?.() === 0;

describe('applyArgs', () => {
  const given = {
    installSh: '/data/update/0.7.1/threadgarden-headless-0.7.1/install.sh',
    version: '0.7.1',
    from: '0.7.0',
    installBase: '/home/u/.local/share/threadgarden-headless',
    updateDir: '/data/update',
  };

  it('passes the script its arguments in order, waiting 90 seconds by default', () => {
    expect(applyArgs(given)).toEqual([
      given.installSh,
      '0.7.1',
      '0.7.0',
      given.installBase,
      given.updateDir,
      '90',
    ]);
  });

  it('takes another timeout', () => {
    expect(applyArgs({ ...given, timeoutS: 2 }).at(-1)).toBe('2');
  });
});

describe.skipIf(process.platform === 'win32' || isRoot)('the apply script', () => {
  let root: string;
  let base: string;
  let updateDir: string;
  let log: string;
  let systemctl: string;
  let work: string;
  let home: string;
  let unitFile: string;

  const DONE = JSON.stringify({ state: 'done', version: '0.7.1', from: '0.7.0', skipped: [] });
  // What a real install.sh does first, so a rollback has something to undo.
  const SWITCH = 'ln -sfn "$BASE/0.7.1" "$BASE/current"';
  const finished = (json: string) => `printf '%s\\n' '${json}' > "$UPDATE_DIR/last.json"`;
  // What systemctl saw on disk at each call, to prove the order: the service stops
  // first, the old unit is loaded before the restart, and the outcome is settled by it.
  const ROLLBACK = [
    '--user stop threadgarden current=0.7.1 last=no pending=yes unit=new',
    '--user daemon-reload current=0.7.0 last=no pending=yes unit=old',
    '--user restart threadgarden current=0.7.0 last=yes pending=no unit=old',
  ];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tg-apply-'));
    // A space in every path the script is handed: it has to quote them all.
    work = join(root, 'a dir');
    base = join(work, 'base');
    updateDir = join(work, 'update');
    // Never the real home: the rollback writes the unit file under $HOME.
    home = join(work, 'home');
    unitFile = join(home, '.config', 'systemd', 'user', 'threadgarden.service');
    log = join(root, 'calls.log');
    await mkdir(join(base, '0.7.0'), { recursive: true });
    await mkdir(join(base, '0.7.1'), { recursive: true });
    await symlink(join(base, '0.7.0'), join(base, 'current'));
    await writeFile(join(base, '0.7.0', 'threadgarden.service'), 'old\n');
    await writeFile(join(base, '0.7.1', 'threadgarden.service'), 'new\n');
    // A real install.sh has already put the new release's unit in place.
    await mkdir(dirname(unitFile), { recursive: true });
    await writeFile(unitFile, 'new\n');
    await mkdir(updateDir, { recursive: true });
    await writeFile(join(updateDir, 'pending.json'), '{"version":"0.7.1","from":"0.7.0"}\n');
    await writeFile(log, '');
    await writeFile(join(work, 'apply.sh'), APPLY_SCRIPT);
    systemctl = join(root, 'systemctl');
    await writeFile(
      systemctl,
      [
        '#!/bin/sh',
        'current=$(basename "$(readlink "$BASE/current")")',
        'last=no',
        '[ ! -f "$UPDATE_DIR/last.json" ] || last=yes',
        'pending=no',
        '[ ! -f "$UPDATE_DIR/pending.json" ] || pending=yes',
        'unit=$(cat "$HOME/.config/systemd/user/threadgarden.service" 2>/dev/null)',
        'echo "$* current=$current last=$last pending=$pending unit=$unit" >> "$LOG"',
        'exit "${SYSTEMCTL_EXIT:-0}"',
        '',
      ].join('\n'),
    );
    await chmod(systemctl, 0o755);
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  /** Runs the script with a stub install.sh of the given body. */
  const apply = async (installBody: string, timeoutS = 2, env: Record<string, string> = {}) => {
    const installSh = join(work, 'install.sh');
    await writeFile(installSh, `#!/bin/sh\n${installBody}\n`);
    return sh(
      join(work, 'apply.sh'),
      applyArgs({
        installSh,
        version: '0.7.1',
        from: '0.7.0',
        installBase: base,
        updateDir,
        timeoutS,
      }),
      { HOME: home, BASE: base, UPDATE_DIR: updateDir, LOG: log, SYSTEMCTL: systemctl, ...env },
    );
  };

  const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean);
  const current = () => readlink(join(base, 'current'));
  const last = async () =>
    UpdateStatusSchema.parse(JSON.parse(await readFile(join(updateDir, 'last.json'), 'utf8')));
  const failed = (reason: string) => ({ state: 'failed', version: '0.7.1', from: '0.7.0', reason });

  it('install success and a done last.json within the timeout leaves current at the new version', async () => {
    // The new service reports a moment after install.sh returned, as a real one does.
    const body = `${SWITCH}\n(sleep 1; ${finished(DONE)}) &`;
    const { code } = await apply(body, 10);
    expect(code).toBe(0);
    expect(await current()).toBe(join(base, '0.7.1'));
    expect(await calls()).toEqual([]);
    expect((await last()).state).toBe('done');
    expect(await readFile(unitFile, 'utf8')).toBe('new\n');
  });

  it('install exit 1 points current back at 0.7.0, restarts, and writes failed/install', async () => {
    const { code } = await apply(`${SWITCH}\nexit 1`);
    expect(code).toBe(1);
    expect(await current()).toBe(join(base, '0.7.0'));
    expect(await calls()).toEqual(ROLLBACK);
    expect(await last()).toEqual(failed('install'));
  });

  it('no done within the timeout (timeoutS=2) rolls back and writes failed/start', async () => {
    const { code } = await apply(SWITCH, 2);
    expect(code).toBe(1);
    expect(await current()).toBe(join(base, '0.7.0'));
    expect(await calls()).toEqual(ROLLBACK);
    expect(await last()).toEqual(failed('start'));
  });

  it('rollback restores the old unit file and reloads before restarting', async () => {
    await apply(`${SWITCH}\nexit 1`);
    expect(await readFile(unitFile, 'utf8')).toBe('old\n');
    // unit=old already at daemon-reload, and daemon-reload before the restart.
    expect(await calls()).toEqual(ROLLBACK);
  });

  it('an old release without a unit file leaves the unit alone and still restarts', async () => {
    await rm(join(base, '0.7.0', 'threadgarden.service'));
    const { code } = await apply(`${SWITCH}\nexit 1`);
    expect(code).toBe(1);
    expect(await readFile(unitFile, 'utf8')).toBe('new\n');
    expect(await calls()).toEqual([
      '--user stop threadgarden current=0.7.1 last=no pending=yes unit=new',
      '--user daemon-reload current=0.7.0 last=no pending=yes unit=new',
      '--user restart threadgarden current=0.7.0 last=yes pending=no unit=new',
    ]);
  });

  it('a unit file it cannot copy does not stop the rest of the rollback', async () => {
    await rm(join(home, '.config'), { recursive: true });
    const { code } = await apply(`${SWITCH}\nexit 1`);
    expect(code).toBe(1);
    expect(await calls()).toEqual([
      '--user stop threadgarden current=0.7.1 last=no pending=yes unit=',
      '--user daemon-reload current=0.7.0 last=no pending=yes unit=',
      '--user restart threadgarden current=0.7.0 last=yes pending=no unit=',
    ]);
    expect(await last()).toEqual(failed('install'));
  });

  it('the written last.json parses with UpdateStatusSchema', async () => {
    await apply('exit 1');
    const text = await readFile(join(updateDir, 'last.json'), 'utf8');
    expect(UpdateStatusSchema.parse(JSON.parse(text))).toEqual(failed('install'));
  });

  it('systemctl failing at every call of the rollback still runs each step and leaves last.json written', async () => {
    const { code } = await apply(`${SWITCH}\nexit 1`, 2, { SYSTEMCTL_EXIT: '1' });
    expect(code).toBe(1);
    expect(await current()).toBe(join(base, '0.7.0'));
    expect(await calls()).toEqual(ROLLBACK);
    expect(await last()).toEqual(failed('install'));
  });

  it('a done left by an earlier update does not count as this one starting', async () => {
    await writeFile(join(updateDir, 'last.json'), `${DONE}\n`);
    await apply(SWITCH, 1);
    expect(await current()).toBe(join(base, '0.7.0'));
    expect(await last()).toEqual(failed('start'));
  });

  it.each(['0.7.10', '0x7x1'])('a done for version %s does not count', async (version) => {
    const other = JSON.stringify({ state: 'done', version, from: '0.7.0', skipped: [] });
    await apply(`${SWITCH}\n${finished(other)}`, 1);
    expect(await current()).toBe(join(base, '0.7.0'));
    expect(await last()).toEqual(failed('start'));
  });

  it('a done that has this version only as its from does not count', async () => {
    const other = JSON.stringify({ state: 'done', version: '0.7.2', from: '0.7.1', skipped: [] });
    await apply(`${SWITCH}\n${finished(other)}`, 1);
    expect(await last()).toEqual(failed('start'));
  });

  it('recognises a done last.json that is not compact', async () => {
    const pretty = JSON.stringify(JSON.parse(DONE), null, 2);
    const { code } = await apply(`${SWITCH}\n${finished(pretty)}`, 1);
    expect(code).toBe(0);
    expect(await current()).toBe(join(base, '0.7.1'));
  });

  it('keeps current as it is when the old version is gone, rather than leave it dangling', async () => {
    await rm(join(base, '0.7.0'), { recursive: true });
    const { code } = await apply(`${SWITCH}\nexit 1`);
    expect(code).toBe(1);
    expect(await current()).toBe(join(base, '0.7.1'));
    expect(await calls()).toEqual([
      '--user stop threadgarden current=0.7.1 last=no pending=yes unit=new',
      '--user daemon-reload current=0.7.1 last=no pending=yes unit=new',
      '--user restart threadgarden current=0.7.1 last=yes pending=no unit=new',
    ]);
    expect(await last()).toEqual(failed('install'));
  });

  it('still goes back and restarts when it cannot write to the update directory', async () => {
    await rm(updateDir, { recursive: true });
    const { code } = await apply(SWITCH);
    expect(code).toBe(1);
    expect(await current()).toBe(join(base, '0.7.0'));
    expect(await calls()).toEqual([
      '--user stop threadgarden current=0.7.0 last=no pending=no unit=new',
      '--user daemon-reload current=0.7.0 last=no pending=no unit=old',
      '--user restart threadgarden current=0.7.0 last=no pending=no unit=old',
    ]);
  });

  it('runs install.sh unattended, names the skipped file and logs its output', async () => {
    const body = [
      'echo "sudo=$SUDO skipped=$THREADGARDEN_SKIPPED_FILE"',
      'echo oops >&2',
      SWITCH,
      finished(DONE),
    ].join('\n');
    const { code } = await apply(body);
    expect(code).toBe(0);
    const logged = await readFile(join(updateDir, 'install.log'), 'utf8');
    expect(logged).toContain(`sudo=sudo -n skipped=${join(updateDir, 'skipped')}`);
    expect(logged).toContain('oops');
  });

  it('does not carry the skipped lines of an earlier update into this one', async () => {
    await writeFile(join(updateDir, 'skipped'), 'polkit\n');
    await apply(`${SWITCH}\n${finished(DONE)}`);
    await expect(readFile(join(updateDir, 'skipped'), 'utf8')).rejects.toThrow();
  });
});
