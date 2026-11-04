import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type EventMsg, type UpdateStatus } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import pkg from '../../package.json' with { type: 'json' };
import { ExternalPoller } from '../../src/external/poller.js';
import { startService, type ServiceHandle, type StartOptions } from '../../src/main.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { generateCorpus } from '../../src/testing/corpus.js';
import { APPLY_SCRIPT, applyArgs } from '../../src/update/apply-script.js';
import type { Fetch } from '../../src/update/github.js';
import { MachineUpdater, runCommand, type Run, type Updater } from '../../src/update/updater.js';
import { TestClient, chatStatus, eventually } from '../e2e/ws-client.js';

const CURRENT = '0.7.0';
const NEXT = '0.7.1';
const BASE = 'https://github.com/JiriPlasek/ThreadGarden/releases/download';
const tarUrl = (v: string): string => `${BASE}/v${v}/threadgarden-headless-${v}-linux-x64.tar.gz`;
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

let dir: string;
let dataDir: string;
let updateDir: string;
let installBase: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadgarden-updater-'));
  dataDir = join(dir, 'data');
  updateDir = join(dataDir, 'update');
  installBase = join(dir, 'install');
  await mkdir(join(installBase, 'current'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const TARBALL = new TextEncoder().encode('pretend this is a tarball');

/** Serves a release; `over` replaces the answer for a URL's ending. */
const releaseFetch = (
  version: string,
  over: { tar?: () => Response; sha?: () => Response } = {},
  bytes: Uint8Array = TARBALL,
): { fetch: Fetch; urls: string[] } => {
  const urls: string[] = [];
  const fetch: Fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url === `${tarUrl(version)}.sha256`) {
      return (
        over.sha?.() ??
        new Response(`${sha256(bytes)}  threadgarden-headless-${version}-linux-x64.tar.gz\n`)
      );
    }
    if (url === tarUrl(version)) return over.tar?.() ?? new Response(bytes);
    return new Response('not found', { status: 404 });
  };
  return { fetch, urls };
};

/** A `fetch` whose every answer waits for `answer`: an update held in its download. */
const stalledFetch = (): { fetch: Fetch; answer: (r: Response) => void } => {
  let answer!: (r: Response) => void;
  const gate = new Promise<Response>((resolve) => (answer = resolve));
  return { fetch: () => gate, answer };
};

type Call = { cmd: string; args: string[] };

/**
 * Stands in for the commands: `tar` makes the folder a real tar would unpack,
 * `systemd-run` notes what was on disk when it was launched.
 */
const fakeRun = (
  o: {
    versionFile?: string | null;
    tarCode?: number;
    launchCode?: number;
    unitActive?: boolean;
  } = {},
): {
  run: Run;
  calls: Call[];
  atLaunch: { pending?: string; apply?: string; files?: string[] };
} => {
  const calls: Call[] = [];
  const atLaunch: { pending?: string; apply?: string; files?: string[] } = {};
  const run: Run = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'tar') {
      if (o.tarCode) return { code: o.tarCode, stdout: '', stderr: 'tar: broken archive' };
      const into = args[args.indexOf('-C') + 1]!;
      const tarball = args.find((a) => a.endsWith('.tar.gz'))!;
      const version = /threadgarden-headless-(.+)-linux-x64\.tar\.gz$/.exec(tarball)![1]!;
      const folder = join(into, `threadgarden-headless-${version}`);
      await mkdir(folder, { recursive: true });
      if (o.versionFile !== null) {
        await writeFile(join(folder, 'VERSION'), `${o.versionFile ?? version}\n`);
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'systemd-run') {
      atLaunch.pending = await readFile(join(updateDir, 'pending.json'), 'utf8');
      atLaunch.apply = await readFile(join(updateDir, 'apply.sh'), 'utf8');
      atLaunch.files = await readdir(updateDir);
      if (o.launchCode) return { code: o.launchCode, stdout: '', stderr: 'Failed to start unit' };
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'systemctl') {
      return o.unitActive
        ? { code: 0, stdout: 'active\n', stderr: '' }
        : { code: 3, stdout: 'inactive\n', stderr: '' };
    }
    throw new Error(`unexpected command ${cmd}`);
  };
  return { run, calls, atLaunch };
};

const silent = () => ({
  debug: vi.fn<(m: string) => void>(),
  info: vi.fn<(m: string) => void>(),
  warn: vi.fn<(m: string) => void>(),
  error: vi.fn<(m: string) => void>(),
  flush: async () => {},
});

const make = (
  o: {
    fetch?: Fetch;
    run?: Run;
    busy?: number | (() => Promise<number>);
    current?: string;
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
  } = {},
) => {
  const emitted: UpdateStatus[] = [];
  const log = silent();
  const busy = o.busy ?? 0;
  const updater = new MachineUpdater({
    dataDir,
    currentVersion: o.current ?? CURRENT,
    installBase,
    platform: o.platform ?? 'linux',
    arch: o.arch ?? 'x64',
    fetch: o.fetch ?? releaseFetch(NEXT).fetch,
    run: o.run ?? fakeRun().run,
    busyCount: typeof busy === 'function' ? busy : async () => busy,
    emit: (s) => emitted.push(s),
    log,
  });
  return { updater, emitted, log };
};

/** Until the update has launched (`restarting`) or ended. */
const settled = (u: MachineUpdater): Promise<UpdateStatus> =>
  eventually(() => {
    const s = u.status();
    return s.state === 'running' && s.stage !== 'restarting' ? null : s;
  }) as Promise<UpdateStatus>;

const stages = (emitted: UpdateStatus[]): string[] =>
  emitted.flatMap((s) => (s.state === 'running' ? [s.stage] : []));

const lastJson = async (): Promise<unknown> =>
  JSON.parse(await readFile(join(updateDir, 'last.json'), 'utf8')) as unknown;

/** What is left of a download: every folder in the update directory. */
const folders = async (): Promise<string[]> => {
  if (!existsSync(updateDir)) return [];
  const entries = await readdir(updateDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
};

const writeUpdateFiles = async (files: Record<string, string>): Promise<void> => {
  await mkdir(updateDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(updateDir, name), text);
  }
};

describe('MachineUpdater.supported', () => {
  it('is Linux with an installed current release', async () => {
    expect(make().updater.supported()).toBe(true);
    expect(make({ platform: 'win32' }).updater.supported()).toBe(false);
    expect(make({ platform: 'darwin' }).updater.supported()).toBe(false);
    await rm(join(installBase, 'current'), { recursive: true });
    expect(make().updater.supported()).toBe(false);
  });

  it('is x64 only: no other architecture is published', () => {
    expect(make({ arch: 'x64' }).updater.supported()).toBe(true);
    expect(make({ arch: 'arm64' }).updater.supported()).toBe(false);
  });
});

describe('MachineUpdater.start', () => {
  it('start with busy chats and force=false returns {started:false, busy:2} and changes nothing', async () => {
    const f = releaseFetch(NEXT);
    const r = fakeRun();
    const earlier = { state: 'done', version: CURRENT, from: '0.6.9', skipped: [] };
    await writeUpdateFiles({ 'last.json': JSON.stringify(earlier) });
    const { updater, emitted } = make({ fetch: f.fetch, run: r.run, busy: 2 });
    await expect(updater.start(NEXT, false)).resolves.toEqual({ started: false, busy: 2 });
    expect(emitted).toEqual([]);
    expect(f.urls).toEqual([]);
    expect(r.calls).toEqual([]);
    expect(await readdir(updateDir)).toEqual(['last.json']);
    expect(updater.status()).toEqual(earlier);
  });

  it('with force goes on although chats run', async () => {
    const { updater } = make({ busy: 2 });
    await expect(updater.start(NEXT, true)).resolves.toEqual({ started: true });
    await expect(settled(updater)).resolves.toMatchObject({ state: 'running' });
  });

  it('start downloads, checks the sha256, unpacks, writes pending.json, then launches systemd-run --user with the apply script', async () => {
    const f = releaseFetch(NEXT);
    const r = fakeRun();
    const { updater, emitted } = make({ fetch: f.fetch, run: r.run });

    await expect(updater.start(NEXT, false)).resolves.toEqual({ started: true });
    await expect(settled(updater)).resolves.toEqual({
      state: 'running',
      version: NEXT,
      from: CURRENT,
      stage: 'restarting',
    });

    expect(stages(emitted)).toEqual(['downloading', 'installing', 'restarting']);
    expect(f.urls.sort()).toEqual([tarUrl(NEXT), `${tarUrl(NEXT)}.sha256`]);

    const download = join(updateDir, NEXT);
    const tarball = join(download, `threadgarden-headless-${NEXT}-linux-x64.tar.gz`);
    expect(await readFile(tarball)).toEqual(Buffer.from(TARBALL));
    expect(r.calls.map((c) => c.cmd)).toEqual(['tar', 'systemd-run']);
    expect(r.calls[0]!.args).toEqual(['-xzf', tarball, '-C', download]);
    expect(r.calls[1]!.args).toEqual([
      '--user',
      '--collect',
      `--unit=threadgarden-update-${NEXT}`,
      '/bin/sh',
      join(updateDir, 'apply.sh'),
      ...applyArgs({
        installSh: join(download, `threadgarden-headless-${NEXT}`, 'install.sh'),
        version: NEXT,
        from: CURRENT,
        installBase,
        updateDir,
      }),
    ]);
    expect(JSON.parse(r.atLaunch.pending!)).toEqual({ version: NEXT, from: CURRENT });
    expect(r.atLaunch.apply).toBe(APPLY_SCRIPT);
  });

  it('gives the tarball ten minutes and the checksum the default budget', async () => {
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { updater } = make();
      await updater.start(NEXT, false);
      await settled(updater);
      expect(timeouts.mock.calls.map(([ms]) => ms).sort((a, b) => a - b)).toEqual([
        15_000, 600_000,
      ]);
    } finally {
      timeouts.mockRestore();
    }
  });

  it('follows the redirect GitHub answers a release download with', async () => {
    const asset = 'https://release-assets.githubusercontent.com/abc/asset';
    const fetch: Fetch = async (input) => {
      const url = String(input);
      if (url === asset) return new Response(TARBALL);
      if (url.endsWith('.sha256')) return new Response(`${sha256(TARBALL)}  x\n`);
      return new Response(null, { status: 302, headers: { location: asset } });
    };
    const { updater } = make({ fetch });
    await updater.start(NEXT, false);
    await expect(settled(updater)).resolves.toMatchObject({ stage: 'restarting' });
  });

  it('deletes an old last.json and skipped when it writes pending.json', async () => {
    await writeUpdateFiles({
      'last.json': JSON.stringify({ state: 'done', version: NEXT, from: CURRENT, skipped: [] }),
      skipped: 'polkit\n',
    });
    const r = fakeRun();
    const { updater } = make({ run: r.run });
    await updater.start(NEXT, false);
    await settled(updater);
    expect(r.atLaunch.files).toContain('pending.json');
    expect(r.atLaunch.files).not.toContain('last.json');
    expect(r.atLaunch.files).not.toContain('skipped');
  });

  it('deletes an old last.json as the download starts: a service dying now must not show it', async () => {
    await writeUpdateFiles({
      'last.json': JSON.stringify({
        state: 'failed',
        version: '0.6.9',
        from: '0.6.8',
        reason: 'start',
      }),
    });
    const stalled = stalledFetch();
    const { updater } = make({ fetch: stalled.fetch });
    await updater.start(NEXT, false);
    await eventually(() => !existsSync(join(updateDir, 'last.json')));
    // What comes back after dying here: this update never happened, and no earlier one speaks for it.
    expect(make({ fetch: stalled.fetch }).updater.status()).toEqual({ state: 'idle' });
    stalled.answer(new Response('', { status: 404 }));
    await settled(updater);
  });

  it('a checksum mismatch fails with checksum and removes the download', async () => {
    const f = releaseFetch(NEXT, { sha: () => new Response(`${'0'.repeat(64)}  x\n`) });
    const r = fakeRun();
    const { updater, emitted, log } = make({ fetch: f.fetch, run: r.run });
    await updater.start(NEXT, false);
    const end = { state: 'failed', version: NEXT, from: CURRENT, reason: 'checksum' };
    await expect(settled(updater)).resolves.toMatchObject(end);
    expect(await folders()).toEqual([]);
    expect(r.calls).toEqual([]);
    expect(await lastJson()).toMatchObject(end);
    expect(emitted.at(-1)).toMatchObject(end);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('checksum'));
  });

  it('a .sha256 without a hash fails with checksum', async () => {
    const f = releaseFetch(NEXT, { sha: () => new Response('<html>nope</html>') });
    const { updater } = make({ fetch: f.fetch });
    await updater.start(NEXT, false);
    await expect(settled(updater)).resolves.toMatchObject({ reason: 'checksum' });
    expect(await folders()).toEqual([]);
  });

  it('accepts a sha256 in capitals', async () => {
    const f = releaseFetch(NEXT, {
      sha: () => new Response(`${sha256(TARBALL).toUpperCase()}  x\n`),
    });
    const { updater } = make({ fetch: f.fetch });
    await updater.start(NEXT, false);
    await expect(settled(updater)).resolves.toMatchObject({ stage: 'restarting' });
  });

  it('a VERSION file that differs fails with unpack', async () => {
    const r = fakeRun({ versionFile: '0.6.9' });
    const { updater } = make({ run: r.run });
    await updater.start(NEXT, false);
    await expect(settled(updater)).resolves.toMatchObject({
      state: 'failed',
      reason: 'unpack',
      detail: expect.stringContaining('0.6.9') as string,
    });
    expect(await folders()).toEqual([]);
    expect(r.calls.map((c) => c.cmd)).toEqual(['tar']);
  });

  it('a missing VERSION file fails with unpack', async () => {
    const { updater } = make({ run: fakeRun({ versionFile: null }).run });
    await updater.start(NEXT, false);
    await expect(settled(updater)).resolves.toMatchObject({ reason: 'unpack' });
    expect(await folders()).toEqual([]);
  });

  it('a tar that fails fails with unpack, and says why', async () => {
    const { updater } = make({ run: fakeRun({ tarCode: 2 }).run });
    await updater.start(NEXT, false);
    await expect(settled(updater)).resolves.toMatchObject({
      reason: 'unpack',
      detail: expect.stringContaining('broken archive') as string,
    });
    expect(await folders()).toEqual([]);
  });

  it.each<[string, Parameters<typeof releaseFetch>[1]]>([
    ['the tarball is missing', { tar: () => new Response('', { status: 404 }) }],
    ['the checksum file is missing', { sha: () => new Response('', { status: 404 }) }],
    [
      'the connection breaks during the body',
      {
        tar: () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array([1, 2, 3]));
                c.error(new Error('connection reset'));
              },
            }),
          ),
      },
    ],
    [
      'it redirects off GitHub',
      {
        tar: () =>
          new Response(null, { status: 302, headers: { location: 'https://example.com/x' } }),
      },
    ],
  ])('a failed download leaves nothing behind and reports download: %s', async (_name, over) => {
    const r = fakeRun();
    const { updater } = make({ fetch: releaseFetch(NEXT, over).fetch, run: r.run });
    await updater.start(NEXT, false);
    await expect(settled(updater)).resolves.toMatchObject({
      state: 'failed',
      version: NEXT,
      from: CURRENT,
      reason: 'download',
    });
    expect(await folders()).toEqual([]);
    expect(existsSync(join(updateDir, 'pending.json'))).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it('a failed launch fails with install, removes the download and pending.json', async () => {
    const r = fakeRun({ launchCode: 1 });
    const { updater, log } = make({ run: r.run });
    await updater.start(NEXT, false);
    await expect(settled(updater)).resolves.toMatchObject({
      state: 'failed',
      reason: 'install',
      detail: expect.stringContaining('Failed to start unit') as string,
    });
    expect(r.atLaunch.pending).toBeDefined();
    expect(await folders()).toEqual([]);
    expect(existsSync(join(updateDir, 'pending.json'))).toBe(false);
    expect(await lastJson()).toMatchObject({ state: 'failed', reason: 'install' });
    expect(log.error).toHaveBeenCalled();
  });

  it('a launch that cannot even run fails with install', async () => {
    const fake = fakeRun();
    const run: Run = async (cmd, args) => {
      if (cmd === 'systemd-run') throw new Error('spawn systemd-run ENOENT');
      return fake.run(cmd, args);
    };
    const { updater } = make({ run });
    await updater.start(NEXT, false);
    await expect(settled(updater)).resolves.toMatchObject({ reason: 'install' });
    expect(existsSync(join(updateDir, 'pending.json'))).toBe(false);
  });

  it('keeps detail short and on one line; the log has it all', async () => {
    const long = `first line ${'x'.repeat(2_000)}\nsecond line`;
    const fake = fakeRun();
    const run: Run = async (cmd, args) =>
      cmd === 'tar' ? { code: 2, stdout: '', stderr: long } : fake.run(cmd, args);
    const { updater, log } = make({ run });
    await updater.start(NEXT, false);
    const s = await settled(updater);
    const detail = (s as { detail: string }).detail;
    expect(detail.length).toBeLessThanOrEqual(200);
    expect(detail).not.toContain('\n');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('second line'));
  });

  it('can be tried again after a failure', async () => {
    const first = releaseFetch(NEXT, { sha: () => new Response(`${'0'.repeat(64)}  x\n`) });
    let f = first.fetch;
    const { updater } = make({ fetch: (...a) => f(...a) });
    await updater.start(NEXT, false);
    await expect(settled(updater)).resolves.toMatchObject({ state: 'failed' });
    f = releaseFetch(NEXT).fetch;
    await expect(updater.start(NEXT, false)).resolves.toEqual({ started: true });
    await expect(settled(updater)).resolves.toMatchObject({ stage: 'restarting' });
  });

  it('a second start while running is refused with UPDATE_RUNNING', async () => {
    const { fetch, answer } = stalledFetch();
    const { updater } = make({ fetch });
    await updater.start(NEXT, false);
    await expect(updater.start(NEXT, false)).rejects.toMatchObject({ code: 'UPDATE_RUNNING' });
    await expect(updater.start('0.7.2', true)).rejects.toMatchObject({ code: 'UPDATE_RUNNING' });
    answer(new Response('', { status: 500 }));
    await expect(settled(updater)).resolves.toMatchObject({ state: 'failed' });
  });

  it('a second start is refused while the first still counts busy chats', async () => {
    let count!: (n: number) => void;
    const { updater } = make({ busy: () => new Promise((resolve) => (count = resolve)) });
    const first = updater.start(NEXT, false);
    await expect(updater.start(NEXT, true)).rejects.toMatchObject({ code: 'UPDATE_RUNNING' });
    count(1);
    await expect(first).resolves.toEqual({ started: false, busy: 1 });
  });

  it('a start after launching is refused too', async () => {
    const { updater } = make();
    await updater.start(NEXT, false);
    await settled(updater);
    await expect(updater.start(NEXT, true)).rejects.toMatchObject({ code: 'UPDATE_RUNNING' });
  });

  it('start for the current version is ALREADY_CURRENT; ../x is INVALID_VERSION', async () => {
    const f = releaseFetch(NEXT);
    const { updater, emitted } = make({ fetch: f.fetch });
    await expect(updater.start(CURRENT, false)).rejects.toMatchObject({ code: 'ALREADY_CURRENT' });
    await expect(updater.start(CURRENT, true)).rejects.toMatchObject({ code: 'ALREADY_CURRENT' });
    for (const bad of ['../x', '..', '.hidden', 'a/b', 'a\\b', '', '0.7.1 ']) {
      await expect(updater.start(bad, true)).rejects.toMatchObject({ code: 'INVALID_VERSION' });
    }
    expect(f.urls).toEqual([]);
    expect(emitted).toEqual([]);
    expect(existsSync(updateDir)).toBe(false);
  });

  it('names the unit with a sanitised version, and keeps the version as it is elsewhere', async () => {
    const version = '1.0.0+build_7-rc.1';
    const r = fakeRun();
    const { updater } = make({ fetch: releaseFetch(version).fetch, run: r.run });
    await updater.start(version, false);
    await expect(settled(updater)).resolves.toMatchObject({ stage: 'restarting' });
    const launch = r.calls.find((c) => c.cmd === 'systemd-run')!;
    expect(launch.args).toContain('--unit=threadgarden-update-1.0.0_build_7-rc.1');
    expect(launch.args).toContain(version);
    expect(JSON.parse(r.atLaunch.pending!)).toEqual({ version, from: CURRENT });
  });

  it('survives an emit that throws', async () => {
    const updater = new MachineUpdater({
      dataDir,
      currentVersion: CURRENT,
      installBase,
      platform: 'linux',
      fetch: releaseFetch(NEXT).fetch,
      run: fakeRun().run,
      busyCount: async () => 0,
      emit: () => {
        throw new Error('nobody is listening');
      },
      log: silent(),
    });
    await expect(updater.start(NEXT, false)).resolves.toEqual({ started: true });
    await expect(settled(updater)).resolves.toMatchObject({ stage: 'restarting' });
  });
});

describe('MachineUpdater.status', () => {
  it('status is idle with no files, running while started, then last.json', async () => {
    const before = make();
    expect(before.updater.status()).toEqual({ state: 'idle' });

    const { fetch, answer } = stalledFetch();
    const { updater } = make({ fetch });
    await updater.start(NEXT, false);
    expect(updater.status()).toEqual({
      state: 'running',
      version: NEXT,
      from: CURRENT,
      stage: 'downloading',
    });
    answer(new Response('', { status: 500 }));
    await settled(updater);

    // A restarted service knows only the files.
    const restarted = make().updater;
    expect(restarted.status()).toMatchObject({
      state: 'failed',
      version: NEXT,
      from: CURRENT,
      reason: 'download',
    });
  });

  it('says failed even when last.json cannot be written', async () => {
    const { fetch, answer } = stalledFetch();
    const { updater, log } = make({ fetch });
    await updater.start(NEXT, false);
    // A folder in its place: writing the file fails.
    await mkdir(join(updateDir, 'last.json'), { recursive: true });
    answer(new Response('', { status: 500 }));
    await expect(settled(updater)).resolves.toMatchObject({ state: 'failed', reason: 'download' });
    expect(log.error).toHaveBeenCalled();
  });

  it('after a restart, pending.json for another version reads as restarting', async () => {
    await writeUpdateFiles({ 'pending.json': JSON.stringify({ version: NEXT, from: CURRENT }) });
    expect(make().updater.status()).toEqual({
      state: 'running',
      version: NEXT,
      from: CURRENT,
      stage: 'restarting',
    });
  });

  it('after a restart, pending.json for this version reads as restarting until reconcile', async () => {
    await writeUpdateFiles({ 'pending.json': JSON.stringify({ version: NEXT, from: CURRENT }) });
    const { updater } = make({ current: NEXT });
    expect(updater.status()).toMatchObject({ state: 'running', stage: 'restarting' });
    await updater.reconcile();
    expect(updater.status()).toEqual({ state: 'done', version: NEXT, from: CURRENT, skipped: [] });
  });

  it('a start after a restart is refused while pending.json is there', async () => {
    await writeUpdateFiles({ 'pending.json': JSON.stringify({ version: NEXT, from: CURRENT }) });
    await expect(make().updater.start('0.7.2', true)).rejects.toMatchObject({
      code: 'UPDATE_RUNNING',
    });
  });

  it.each([
    ['not JSON', '{ nope'],
    ['an unknown shape', JSON.stringify({ state: 'exploded' })],
    ['a state that is never final', JSON.stringify({ state: 'idle' })],
  ])('treats a last.json that is %s as absent, and logs it once', async (_name, text) => {
    await writeUpdateFiles({ 'last.json': text });
    const { updater, log } = make();
    expect(updater.status()).toEqual({ state: 'idle' });
    expect(updater.status()).toEqual({ state: 'idle' });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('last.json'));
  });

  it.each([
    ['not JSON', '{ nope'],
    ['missing its fields', JSON.stringify({ version: NEXT })],
    [
      'naming a version that could leave the folder',
      JSON.stringify({ version: '../x', from: 'y' }),
    ],
  ])('treats a pending.json that is %s as absent', async (_name, text) => {
    await writeUpdateFiles({ 'pending.json': text });
    const { updater, log } = make();
    expect(updater.status()).toEqual({ state: 'idle' });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('pending.json'));
  });
});

describe('MachineUpdater.reconcile', () => {
  it('reconcile with pending.json for this version writes last.json done with the skipped lines and cleans up', async () => {
    await writeUpdateFiles({
      'pending.json': JSON.stringify({ version: NEXT, from: CURRENT }),
      skipped: 'linger\npolkit\n',
      'apply.sh': APPLY_SCRIPT,
    });
    await mkdir(join(updateDir, NEXT, `threadgarden-headless-${NEXT}`), { recursive: true });
    const r = fakeRun();
    const { updater, emitted } = make({ current: NEXT, run: r.run });

    await updater.reconcile();

    const done = { state: 'done', version: NEXT, from: CURRENT, skipped: ['linger', 'polkit'] };
    expect(await lastJson()).toEqual(done);
    expect(updater.status()).toEqual(done);
    expect(emitted).toEqual([done]);
    expect(existsSync(join(updateDir, 'pending.json'))).toBe(false);
    expect(existsSync(join(updateDir, 'skipped'))).toBe(false);
    expect(await folders()).toEqual([]);
    // sh is still reading it, and asking systemd was not needed.
    expect(existsSync(join(updateDir, 'apply.sh'))).toBe(true);
    expect(r.calls).toEqual([]);
  });

  it('writes the exact keys the apply script looks for', async () => {
    await writeUpdateFiles({ 'pending.json': JSON.stringify({ version: NEXT, from: CURRENT }) });
    await make({ current: NEXT }).updater.reconcile();
    const text = (await readFile(join(updateDir, 'last.json'), 'utf8')).replace(/\s/g, '');
    expect(text).toContain('"state":"done"');
    expect(text).toContain(`"version":"${NEXT}"`);
  });

  it('drops a skipped line it does not know, and repeats, and logs it', async () => {
    await writeUpdateFiles({
      'pending.json': JSON.stringify({ version: NEXT, from: CURRENT }),
      skipped: 'polkit\nmystery\npolkit\n\n',
    });
    const { updater, log } = make({ current: NEXT });
    await updater.reconcile();
    expect(updater.status()).toMatchObject({ state: 'done', skipped: ['polkit'] });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('mystery'));
  });

  it('reconcile leaves a last.json failed written by the apply script as the status', async () => {
    const failed = { state: 'failed', version: NEXT, from: CURRENT, reason: 'start' };
    await writeUpdateFiles({ 'last.json': JSON.stringify(failed), skipped: 'polkit\n' });
    await mkdir(join(updateDir, NEXT), { recursive: true });
    const { updater, emitted } = make();

    await updater.reconcile();

    expect(updater.status()).toEqual(failed);
    expect(await lastJson()).toEqual(failed);
    expect(await folders()).toEqual([]);
    expect(existsSync(join(updateDir, 'skipped'))).toBe(false);
    expect(emitted).toEqual([]);
  });

  it('does not overwrite a failed last.json with done, whatever pending.json says', async () => {
    const failed = { state: 'failed', version: NEXT, from: CURRENT, reason: 'start' };
    await writeUpdateFiles({
      'last.json': JSON.stringify(failed),
      'pending.json': JSON.stringify({ version: NEXT, from: CURRENT }),
    });
    const { updater } = make({ current: NEXT });
    await updater.reconcile();
    expect(updater.status()).toEqual(failed);
    expect(existsSync(join(updateDir, 'pending.json'))).toBe(false);
  });

  it('does not replace the reason the apply script wrote with install', async () => {
    const failed = { state: 'failed', version: NEXT, from: CURRENT, reason: 'start' };
    await writeUpdateFiles({
      'last.json': JSON.stringify(failed),
      'pending.json': JSON.stringify({ version: NEXT, from: CURRENT }),
    });
    const { updater } = make({ run: fakeRun({ unitActive: false }).run });
    await updater.reconcile();
    expect(updater.status()).toEqual(failed);
  });

  it('pending.json for another version and no active unit writes failed with install', async () => {
    await writeUpdateFiles({
      'pending.json': JSON.stringify({ version: NEXT, from: CURRENT }),
      skipped: 'polkit\n',
    });
    await mkdir(join(updateDir, NEXT), { recursive: true });
    const r = fakeRun({ unitActive: false });
    const { updater, emitted } = make({ run: r.run });

    await updater.reconcile();

    expect(r.calls).toEqual([
      { cmd: 'systemctl', args: ['--user', 'is-active', `threadgarden-update-${NEXT}`] },
    ]);
    const failed = { state: 'failed', version: NEXT, from: CURRENT, reason: 'install' };
    expect(updater.status()).toMatchObject(failed);
    expect(await lastJson()).toMatchObject(failed);
    expect(emitted.at(-1)).toMatchObject(failed);
    expect(existsSync(join(updateDir, 'pending.json'))).toBe(false);
    expect(existsSync(join(updateDir, 'skipped'))).toBe(false);
    expect(await folders()).toEqual([]);
  });

  it('reads a systemctl that cannot run as no active unit', async () => {
    await writeUpdateFiles({ 'pending.json': JSON.stringify({ version: NEXT, from: CURRENT }) });
    const run: Run = async () => {
      throw new Error('spawn systemctl ENOENT');
    };
    const { updater } = make({ run });
    await updater.reconcile();
    expect(updater.status()).toMatchObject({ state: 'failed', reason: 'install' });
  });

  it('pending.json for another version with the unit active is left alone', async () => {
    await writeUpdateFiles({
      'pending.json': JSON.stringify({ version: NEXT, from: CURRENT }),
      skipped: 'polkit\n',
    });
    await mkdir(join(updateDir, NEXT), { recursive: true });
    const { updater, emitted } = make({ run: fakeRun({ unitActive: true }).run });

    await updater.reconcile();

    expect(updater.status()).toEqual({
      state: 'running',
      version: NEXT,
      from: CURRENT,
      stage: 'restarting',
    });
    expect(existsSync(join(updateDir, 'pending.json'))).toBe(true);
    expect(existsSync(join(updateDir, 'skipped'))).toBe(true);
    expect(await folders()).toEqual([NEXT]);
    expect(emitted).toEqual([]);
  });

  it('asks about the sanitised unit name', async () => {
    const version = '1.0.0+build';
    await writeUpdateFiles({ 'pending.json': JSON.stringify({ version, from: CURRENT }) });
    const r = fakeRun({ unitActive: true });
    await make({ run: r.run }).updater.reconcile();
    expect(r.calls[0]!.args).toEqual(['--user', 'is-active', 'threadgarden-update-1.0.0_build']);
  });

  it('removes a download an interrupted update left, and keeps the plain files', async () => {
    await writeUpdateFiles({ 'apply.sh': APPLY_SCRIPT, 'install.log': 'installed\n' });
    await mkdir(join(updateDir, NEXT), { recursive: true });
    const { updater } = make();
    await updater.reconcile();
    expect(await folders()).toEqual([]);
    expect((await readdir(updateDir)).sort()).toEqual(['apply.sh', 'install.log']);
    expect(updater.status()).toEqual({ state: 'idle' });
  });

  it('does nothing with no update directory', async () => {
    const { updater, log } = make();
    await expect(updater.reconcile()).resolves.toBeUndefined();
    expect(log.error).not.toHaveBeenCalled();
    expect(updater.status()).toEqual({ state: 'idle' });
  });

  it('survives malformed files', async () => {
    await writeUpdateFiles({ 'pending.json': '{ nope', 'last.json': '[1,2' });
    const { updater, log } = make();
    await expect(updater.reconcile()).resolves.toBeUndefined();
    expect(updater.status()).toEqual({ state: 'idle' });
    expect(log.warn).toHaveBeenCalled();
  });

  it('never rejects, and logs what went wrong', async () => {
    await writeUpdateFiles({ 'pending.json': JSON.stringify({ version: NEXT, from: CURRENT }) });
    // A folder in its place: writing the outcome fails.
    await mkdir(join(updateDir, 'last.json'));
    const { updater, log } = make({ current: NEXT });
    await expect(updater.reconcile()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('reconcile'));
  });

  it('keeps away from an update this service is running', async () => {
    const { fetch, answer } = stalledFetch();
    const { updater } = make({ fetch });
    await updater.start(NEXT, false);
    await eventually(() => existsSync(join(updateDir, NEXT)));
    await updater.reconcile();
    expect(await folders()).toEqual([NEXT]);
    answer(new Response('', { status: 500 }));
    await settled(updater);
  });

  it('a start made during reconcile waits for it, so its download is not swept away', async () => {
    await mkdir(join(updateDir, '0.6.0'), { recursive: true });
    const r = fakeRun();
    const { updater } = make({ run: r.run });
    const reconciling = updater.reconcile();
    await expect(updater.start(NEXT, false)).resolves.toEqual({ started: true });
    await reconciling;
    await expect(settled(updater)).resolves.toMatchObject({ stage: 'restarting' });
    expect(await folders()).toEqual([NEXT]);
  });
});

describe('runCommand', () => {
  const node = process.execPath;

  it('answers the exit code and both outputs', async () => {
    const ok = await runCommand(node, ['-e', 'console.log("out");console.error("err")']);
    expect(ok).toMatchObject({ code: 0 });
    expect(ok.stdout).toContain('out');
    expect(ok.stderr).toContain('err');
    const failed = await runCommand(node, ['-e', 'process.exit(3)']);
    expect(failed.code).toBe(3);
  });

  it('answers non-zero for a command that does not exist, rather than rejecting', async () => {
    const r = await runCommand(join(dir, 'no-such-command'), []);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('ENOENT');
  });
});

describe.skipIf(process.platform === 'win32')('with the real tar', () => {
  it('downloads a real tarball, unpacks it and checks its VERSION', async () => {
    const source = join(dir, 'source', `threadgarden-headless-${NEXT}`);
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'VERSION'), `${NEXT}\n`);
    const packed = join(dir, 'packed.tar.gz');
    const pack = await runCommand('tar', ['-czf', packed, '-C', join(dir, 'source'), '.']);
    expect(pack.code).toBe(0);
    const bytes = new Uint8Array(await readFile(packed));

    const fake = fakeRun();
    const run: Run = (cmd, args) => (cmd === 'tar' ? runCommand(cmd, args) : fake.run(cmd, args));
    const { updater } = make({ fetch: releaseFetch(NEXT, {}, bytes).fetch, run });
    await updater.start(NEXT, false);
    await expect(settled(updater)).resolves.toMatchObject({ stage: 'restarting' });
    expect(fake.calls.map((c) => c.cmd)).toEqual(['systemd-run']);
    expect(existsSync(join(updateDir, NEXT, `threadgarden-headless-${NEXT}`, 'VERSION'))).toBe(
      true,
    );
  });
});

describe('the release an updater expects (frozen)', () => {
  it('is the one scripts/build-headless.mjs builds', async () => {
    const build = await readFile(
      new URL('../../../../scripts/build-headless.mjs', import.meta.url),
      'utf8',
    );
    const expand = (t: string): string =>
      t.replaceAll('${version}', NEXT).replaceAll('${arch}', 'x64');
    const folder = expand(/const name = `(.+)`;/.exec(build)![1]!);
    const tarball = `${folder}${expand(/join\(OUT, `\$\{name\}(.+)`\)/.exec(build)![1]!)}`;
    expect(build).toContain("arg('arch') ?? 'x64'");
    for (const file of ['install.sh', 'threadgarden.service', 'VERSION']) {
      expect(build).toContain(`join(dir, '${file}')`);
    }

    const f = releaseFetch(NEXT);
    const r = fakeRun();
    const { updater } = make({ fetch: f.fetch, run: r.run });
    await updater.start(NEXT, false);
    await expect(settled(updater)).resolves.toMatchObject({ stage: 'restarting' });
    expect(f.urls).toContain(`${BASE}/v${NEXT}/${tarball}`);
    expect(f.urls).toContain(`${BASE}/v${NEXT}/${tarball}.sha256`);
    const launch = r.calls.find((c) => c.cmd === 'systemd-run')!;
    expect(launch.args).toContain(join(updateDir, NEXT, folder, 'install.sh'));
  });
});

describe('the service', () => {
  const opened: { svc: ServiceHandle[]; clients: TestClient[] } = { svc: [], clients: [] };

  afterEach(async () => {
    for (const c of opened.clients.splice(0)) await c.close();
    for (const s of opened.svc.splice(0)) await s.close();
  });

  const logger = { debug() {}, info() {}, warn() {}, error() {}, flush: async () => {} };
  const HELLO = { protocolVersion: PROTOCOL_VERSION, client: 'test' };

  const start = async (over: Partial<StartOptions> = {}): Promise<ServiceHandle> => {
    const svc = await startService({
      dataDir,
      claudeConfigDir: join(dir, 'claude-missing'),
      adapter: generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 }),
      claude: { path: '/bin/claude', version: '2.1.314' },
      externalRun: async () => '[]',
      installSignalHandlers: false,
      headless: true,
      remote: { addresses: ['127.0.0.1'], port: 0 },
      logger,
      update: { installBase, platform: 'linux', arch: 'x64', run: fakeRun().run },
      ...over,
    });
    opened.svc.push(svc);
    return svc;
  };

  const connect = async (svc: ServiceHandle): Promise<TestClient> => {
    const c = await TestClient.connect(svc.port, svc.token);
    opened.clients.push(c);
    return c;
  };

  const capabilities = async (svc: ServiceHandle): Promise<string[]> => {
    const c = await connect(svc);
    const hello = await c.call<{ machine: { capabilities: string[] } }>('hello', HELLO);
    return hello.machine.capabilities;
  };

  it('the update capability is offered only when supported', async () => {
    const yes = await start();
    expect(await capabilities(yes)).toContain('update');
    await yes.close();

    const otherOs = await start({ update: { installBase, platform: 'darwin', arch: 'x64' } });
    expect(await capabilities(otherOs)).not.toContain('update');
    await otherOs.close();

    const otherArch = await start({ update: { installBase, platform: 'linux', arch: 'arm64' } });
    expect(await capabilities(otherArch)).not.toContain('update');
    await otherArch.close();

    const notHeadless = await start({
      headless: false,
      update: { installBase, platform: 'linux', arch: 'x64' },
    });
    expect(await capabilities(notHeadless)).not.toContain('update');
    await notHeadless.close();

    await rm(join(installBase, 'current'), { recursive: true });
    const notInstalled = await start();
    expect(await capabilities(notInstalled)).not.toContain('update');
  });

  it('update.start throws NOT_SUPPORTED where the capability is not offered', async () => {
    const otherOs = await start({ update: { installBase, platform: 'darwin', arch: 'x64' } });
    await expect(
      (await connect(otherOs)).call('update.start', { version: NEXT, force: true }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    await otherOs.close();

    const notHeadless = await start({
      headless: false,
      update: { installBase, platform: 'linux', arch: 'x64' },
    });
    await expect(
      (await connect(notHeadless)).call('update.start', { version: NEXT, force: true }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('update.status works without a database', async () => {
    const svc = await startService({
      dataDir,
      installSignalHandlers: false,
      logger,
    });
    opened.svc.push(svc);
    await expect((await connect(svc)).call('update.status', {})).resolves.toEqual({
      state: 'idle',
    });
  });

  it('update.start answers the errors of the updater', async () => {
    const c = await connect(await start());
    await expect(
      c.call('update.start', { version: pkg.version, force: false }),
    ).rejects.toMatchObject({ code: 'ALREADY_CURRENT' });
    await expect(c.call('update.start', { version: '../x', force: false })).rejects.toMatchObject({
      code: 'INVALID_VERSION',
    });
  });

  it('counts busy chats and busy sessions in a terminal', async () => {
    const adapter = new FakeAdapter();
    const external = { cwd: dir, kind: 'interactive', startedAt: 0, raw: {} };
    const svc = await start({
      adapter,
      externals: () => [
        { ...external, status: 'busy' },
        { ...external, state: 'working' },
        { ...external, status: 'idle' },
        { ...external, state: 'done' },
      ],
    });
    const c = await connect(svc);
    await expect(c.call('update.start', { version: NEXT, force: false })).resolves.toEqual({
      started: false,
      busy: 2,
    });

    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: 'hello',
      permissionMode: 'acceptEdits',
      effort: 'high',
    });
    await c.waitFor(chatStatus(sessionId, 'working'));
    await expect(c.call('update.start', { version: NEXT, force: false })).resolves.toEqual({
      started: false,
      busy: 3,
    });
  });

  it('broadcasts update.progress', async () => {
    const svc = await start({
      update: {
        installBase,
        platform: 'linux',
        arch: 'x64',
        run: fakeRun().run,
        fetch: async () => new Response('', { status: 404 }),
      },
    });
    const c = await connect(svc);
    await c.call('update.start', { version: NEXT, force: false });
    const isUpdate = (e: EventMsg): boolean => e.event === 'update.progress';
    await c.waitFor((e) => isUpdate(e) && (e.data as UpdateStatus).state === 'failed');
    expect(c.events.filter(isUpdate).map((e) => e.data)).toMatchObject([
      { state: 'running', stage: 'downloading' },
      { state: 'failed', reason: 'download' },
    ]);
  });

  it('uses an injected updater, whatever the machine is', async () => {
    const fake: Updater = {
      supported: () => true,
      status: () => ({ state: 'running', version: '9.9.9', from: '9.9.8', stage: 'installing' }),
      start: async () => ({ started: false, busy: 7 }),
      reconcile: async () => {},
    };
    const c = await connect(await start({ update: { updater: fake } }));
    const hello = await c.call<{ machine: { capabilities: string[] } }>('hello', HELLO);
    expect(hello.machine.capabilities).toContain('update');
    await expect(c.call('update.status', {})).resolves.toMatchObject({ version: '9.9.9' });
    await expect(c.call('update.start', { version: NEXT, force: false })).resolves.toEqual({
      started: false,
      busy: 7,
    });
  });

  it("done isn't written until the listener is bound", async () => {
    await writeUpdateFiles({
      'pending.json': JSON.stringify({ version: pkg.version, from: CURRENT }),
      skipped: 'polkit\n',
    });
    let addresses: string[] = [];
    let tick: () => void = () => {};
    const svc = await start({
      setInterval: (fn) => {
        tick = fn;
        return setInterval(() => {}, 1 << 30);
      },
      remote: { port: 0, addressSource: () => addresses },
    });
    const c = await connect(svc);

    // The service answers, but devices can't reach it: the update isn't done.
    expect(svc.remote).toBeUndefined();
    expect(existsSync(join(updateDir, 'last.json'))).toBe(false);
    await expect(c.call('update.status', {})).resolves.toMatchObject({
      state: 'running',
      stage: 'restarting',
    });

    tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(updateDir, 'last.json'))).toBe(false);

    addresses = ['127.0.0.1'];
    tick();
    await eventually(() => svc.remote);
    await eventually(() => existsSync(join(updateDir, 'last.json')));
    const done = { state: 'done', version: pkg.version, from: CURRENT, skipped: ['polkit'] };
    expect(await lastJson()).toEqual(done);
    await expect(c.call('update.status', {})).resolves.toEqual(done);
    await c.waitFor((e) => e.event === 'update.progress');
  });

  it("done isn't written while the listener fails to bind, and is once it binds", async () => {
    await writeUpdateFiles({
      'pending.json': JSON.stringify({ version: pkg.version, from: CURRENT }),
    });
    // Not an address of this machine (TEST-NET-3): listening on it fails.
    let addresses = ['203.0.113.7'];
    let tick: () => void = () => {};
    const svc = await start({
      setInterval: (fn) => {
        tick = fn;
        return setInterval(() => {}, 1 << 30);
      },
      remote: { port: 0, addressSource: () => addresses },
    });
    expect(svc.remote).toBeUndefined();
    expect(existsSync(join(updateDir, 'last.json'))).toBe(false);

    addresses = ['127.0.0.1'];
    tick();
    await eventually(() => svc.remote);
    await eventually(() => existsSync(join(updateDir, 'last.json')));
    expect(await lastJson()).toMatchObject({ state: 'done', version: pkg.version });
  });

  it("done isn't written until startup has finished", async () => {
    await writeUpdateFiles({
      'pending.json': JSON.stringify({ version: pkg.version, from: CURRENT }),
    });
    // A folder where service.json goes: writing it fails after the listener has bound,
    // and bin.ts then exits 1. The apply script has to be left to roll this one back.
    await mkdir(join(dataDir, 'service.json'));
    await expect(start()).rejects.toThrow();
    expect(existsSync(join(updateDir, 'last.json'))).toBe(false);
    expect(existsSync(join(updateDir, 'pending.json'))).toBe(true);
  });

  it('the first reconcile comes after the last startup step', async () => {
    const order: string[] = [];
    const pollerStart = vi.spyOn(ExternalPoller.prototype, 'start').mockImplementation(() => {
      order.push('poller');
    });
    try {
      const fake: Updater = {
        supported: () => true,
        status: () => ({ state: 'idle' }),
        start: async () => ({ started: true }),
        reconcile: async () => {
          order.push('reconcile');
        },
      };
      await start({ update: { updater: fake } });
      expect(order).toEqual(['poller', 'reconcile']);
    } finally {
      pollerStart.mockRestore();
    }
  });

  it('the startup update.progress reaches a device, and systemd being slow delays nothing', async () => {
    // An update for another version that nothing is left to end, so reconcile asks systemd.
    await writeUpdateFiles({
      'pending.json': JSON.stringify({ version: '9.9.9', from: CURRENT }),
    });
    let answer!: () => void;
    const systemdAnswers = new Promise<void>((resolve) => (answer = resolve));
    const fake = fakeRun();
    const run: Run = async (cmd, args) => {
      if (cmd === 'systemctl') await systemdAnswers;
      return fake.run(cmd, args);
    };

    // It starts although systemd hasn't answered, and a device can connect meanwhile.
    const svc = await start({ update: { installBase, platform: 'linux', arch: 'x64', run } });
    const created = (await svc.router.dispatch(
      { id: 1, method: 'pairing.create', params: {} },
      { clientId: 't', origin: 'local' },
    )) as { result: { code: string } };
    const claimed = (await svc.router.dispatch(
      { id: 2, method: 'pair.claim', params: { code: created.result.code, deviceName: 'Laptop' } },
      { clientId: 'p', origin: 'remote' },
    )) as { result: { token: string } };
    const device = new WebSocket(`wss://127.0.0.1:${svc.remote!.port}`, [
      `threadgarden-device.${claimed.result.token}`,
    ], { rejectUnauthorized: false });
    try {
      await new Promise((resolve, reject) => {
        device.once('open', resolve);
        device.once('error', reject);
      });
      const progress = new Promise<unknown>((resolve) => {
        device.on('message', (d: unknown) => {
          const frame = JSON.parse(String(d)) as { event?: string; data?: unknown };
          if (frame.event === 'update.progress') resolve(frame.data);
        });
      });
      answer();
      await expect(progress).resolves.toMatchObject({
        state: 'failed',
        version: '9.9.9',
        from: CURRENT,
        reason: 'install',
      });
    } finally {
      answer();
      device.close();
    }
  });

  it('reconciles only once, however often the listener moves', async () => {
    const reconcile = vi.fn(async () => {});
    const fake: Updater = {
      supported: () => true,
      status: () => ({ state: 'idle' }),
      start: async () => ({ started: true }),
      reconcile,
    };
    let addresses = ['127.0.0.1'];
    let tick: () => void = () => {};
    const svc = await start({
      update: { updater: fake },
      setInterval: (fn) => {
        tick = fn;
        return setInterval(() => {}, 1 << 30);
      },
      remote: { port: 0, addressSource: () => addresses },
    });
    expect(reconcile).toHaveBeenCalledTimes(1);

    // Off the network and back, retried because a tick is ignored during a move.
    addresses = [];
    await eventually(() => {
      tick();
      return svc.remote === undefined;
    });
    addresses = ['127.0.0.1'];
    await eventually(() => {
      tick();
      return svc.remote;
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('keeps listening when reconcile fails', async () => {
    const errors: string[] = [];
    const fake: Updater = {
      supported: () => true,
      status: () => ({ state: 'idle' }),
      start: async () => ({ started: true }),
      reconcile: async () => {
        throw new Error('disk on fire');
      },
    };
    const svc = await start({
      update: { updater: fake },
      logger: { ...logger, error: (m: string) => void errors.push(m) },
    });
    expect(svc.remote).toBeDefined();
    expect(errors.join('\n')).toContain('disk on fire');
    expect(errors.join('\n')).not.toContain('listening for devices');
  });

  it('a desktop never reconciles: it has no remote listener', async () => {
    const reconcile = vi.fn(async () => {});
    const fake: Updater = {
      supported: () => true,
      status: () => ({ state: 'idle' }),
      start: async () => ({ started: true }),
      reconcile,
    };
    await start({ headless: false, update: { updater: fake } });
    expect(reconcile).not.toHaveBeenCalled();
  });
});
