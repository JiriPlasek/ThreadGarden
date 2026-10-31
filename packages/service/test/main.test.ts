import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@threadgarden/protocol';
import { acquireInstanceLock, readDiscovery } from '../src/discovery.js';
import { openDb } from '../src/history/db.js';
import { createLogger } from '../src/logger.js';
import { SessionHost } from '../src/chat/session-host.js';
import { startService, type ServiceHandle } from '../src/main.js';
import type { ClaudeFound } from '../src/sdk/claude-path.js';
import { generateCorpus } from '../src/testing/corpus.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadgarden-main-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rpc = (port: number, token: string, method: string, params: unknown) =>
  new Promise<unknown>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, `threadgarden.${token}`);
    ws.once('error', reject);
    // Skip broadcast events (they carry no id) that can arrive before the response.
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as { id?: number };
      if (m.id !== 1) return;
      ws.close();
      resolve(m);
    });
    ws.once('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
  });

describe('startService', () => {
  it('writes discovery, serves hello, and cleans up on close', async () => {
    const svc = await startService({ dataDir: dir, installSignalHandlers: false });
    const d = await readDiscovery(dir);
    expect(d).toMatchObject({
      pid: process.pid,
      port: svc.port,
      token: svc.token,
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(
      await rpc(svc.port, svc.token, 'hello', { protocolVersion: PROTOCOL_VERSION, client: 't' }),
    ).toMatchObject({
      result: { protocolVersion: PROTOCOL_VERSION },
    });
    await svc.close();
    expect(await readDiscovery(dir)).toBeNull();
    expect(await readdir(dir)).not.toContain('service.lock');
  });

  it('with an adapter, indexes history in the background and serves the places API', async () => {
    const adapter = generateCorpus({ sessions: 5, projects: 2, bigSessionMessages: 0 });
    const claudeDir = join(dir, 'claude-missing'); // projects dir absent: must not crash
    const svc = await startService({
      dataDir: join(dir, 'data'),
      claudeConfigDir: claudeDir,
      adapter,
      installSignalHandlers: false,
    });
    let counts: unknown;
    for (let i = 0; i < 100; i++) {
      counts = await rpc(svc.port, svc.token, 'places.counts', {});
      if ((counts as { result?: { all: number } }).result?.all === 5) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(counts).toMatchObject({ result: { all: 5, needsYou: 0, running: 0 } });
    expect(await readdir(join(dir, 'data'))).toContain('threadgarden.db');
    await svc.close();
  });

  it('carries the machine in hello when there is a database', async () => {
    const adapter = generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 });
    const svc = await startService({
      dataDir: join(dir, 'data'),
      claudeConfigDir: join(dir, 'claude-missing'),
      adapter,
      installSignalHandlers: false,
    });
    const hello = (await rpc(svc.port, svc.token, 'hello', {
      protocolVersion: PROTOCOL_VERSION,
      client: 't',
    })) as { result: { machine: { id: string } } };
    expect(hello.result.machine).toMatchObject({
      platform: process.platform,
      headless: false,
      capabilities: ['remote'],
    });
    const renamed = (await rpc(svc.port, svc.token, 'machine.rename', { name: ' Den ' })) as {
      result: { id: string; name: string };
    };
    expect(renamed.result).toMatchObject({ id: hello.result.machine.id, name: 'Den' });
    // Ruling R11: a pairing socket (remote, no device yet) is not told the home folder.
    const helloParams = { protocolVersion: PROTOCOL_VERSION, client: 't' };
    const asPairing = (await svc.router.dispatch(
      { id: 1, method: 'hello', params: helloParams },
      { clientId: 'p', origin: 'remote' },
    )) as { result: { machine: { home: string; id: string } } };
    expect(asPairing.result.machine).toMatchObject({ id: hello.result.machine.id, home: '' });
    const asDevice = (await svc.router.dispatch(
      { id: 1, method: 'hello', params: helloParams },
      { clientId: 'd', origin: 'remote', deviceId: 'dev' },
    )) as { result: { machine: { home: string } } };
    expect(asDevice.result.machine.home).toBe(homedir());
    await svc.close();
  });

  it('polls external sessions, answers resume checks and reports system status', async () => {
    const adapter = generateCorpus({ sessions: 2, projects: 1, bigSessionMessages: 0 });
    const run = async () =>
      JSON.stringify([
        { pid: 7, cwd: '/x', kind: 'interactive', startedAt: 1, sessionId: 'held', status: 'busy' },
      ]);
    const svc = await startService({
      dataDir: join(dir, 'data'),
      claudeConfigDir: join(dir, 'claude-missing'),
      adapter,
      claude: { path: '/bin/claude', version: '2.1.314' },
      externalRun: run,
      installSignalHandlers: false,
    });
    const result = async (method: string, params: unknown) =>
      ((await rpc(svc.port, svc.token, method, params)) as { result: unknown }).result;
    expect(await result('chat.resumeCheck', { sessionId: 'held' })).toMatchObject({
      status: 'blocked',
    });
    expect(await result('chat.resumeCheck', { sessionId: 'free' })).toMatchObject({ status: 'ok' });
    expect(await result('system.status', {})).toMatchObject({
      claude: { found: true, path: '/bin/claude', version: '2.1.314' },
      externalAvailable: true,
    });
    await svc.close();
  });

  it('a paused or failed Threadgarden chat now running in a terminal is external: resume is blocked', async () => {
    const adapter = generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 });
    const run = async () =>
      JSON.stringify([
        {
          pid: 7,
          cwd: '/x',
          kind: 'interactive',
          startedAt: 1,
          sessionId: 'paused',
          status: 'busy',
        },
        {
          pid: 8,
          cwd: '/x',
          kind: 'interactive',
          startedAt: 1,
          sessionId: 'failed',
          status: 'busy',
        },
        { pid: 9, cwd: '/x', kind: 'interactive', startedAt: 1, sessionId: 'mine', status: 'busy' },
      ]);
    const svc = await startService({
      dataDir: join(dir, 'data'),
      claudeConfigDir: join(dir, 'claude-missing'),
      adapter,
      claude: { path: '/bin/claude', version: '2.1.314' },
      externalRun: run,
      live: {
        list: () => [
          { sessionId: 'paused', cwd: '/x', status: 'paused', live: false },
          { sessionId: 'failed', cwd: '/x', status: 'failed', live: false },
          { sessionId: 'mine', cwd: '/x', status: 'working', live: true },
        ],
      },
      installSignalHandlers: false,
    });
    const result = async (method: string, params: unknown) =>
      ((await rpc(svc.port, svc.token, method, params)) as { result: unknown }).result;
    expect(await result('chat.resumeCheck', { sessionId: 'paused' })).toMatchObject({
      status: 'blocked',
    });
    expect(await result('chat.resumeCheck', { sessionId: 'failed' })).toMatchObject({
      status: 'blocked',
    });
    // A live Threadgarden chat is Threadgarden's own process, never "running elsewhere".
    expect(await result('chat.resumeCheck', { sessionId: 'mine' })).toMatchObject({ status: 'ok' });
    await svc.close();
  });

  it('listens and writes discovery before Claude Code is located; status waits for it', async () => {
    let found!: (c: ClaudeFound) => void;
    const locateClaude = vi.fn(
      () => new Promise<ClaudeFound>((resolve) => (found = resolve)), // e.g. a slow `claude --version`
    );
    const adapter = generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 });
    const svc = await Promise.race([
      startService({
        dataDir: join(dir, 'data'),
        claudeConfigDir: join(dir, 'claude-missing'),
        adapter,
        locateClaude,
        externalRun: async () => '[]',
        installSignalHandlers: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('startService waited for claude')), 2_000),
      ),
    ]);
    expect(locateClaude).toHaveBeenCalledTimes(1);
    expect(await readDiscovery(join(dir, 'data'))).toMatchObject({ port: svc.port });
    expect(
      await rpc(svc.port, svc.token, 'hello', { protocolVersion: PROTOCOL_VERSION, client: 't' }),
    ).toMatchObject({ result: { protocolVersion: PROTOCOL_VERSION } });
    // While locating, status does not claim Claude Code is missing: it answers once known.
    let status: unknown;
    const pending = rpc(svc.port, svc.token, 'system.status', {}).then((r) => (status = r));
    await new Promise((r) => setTimeout(r, 50));
    expect(status).toBeUndefined();
    found({ path: '/bin/claude', version: '2.1.314' });
    await pending;
    expect(status).toMatchObject({
      result: { claude: { found: true, path: '/bin/claude', version: '2.1.314' } },
    });
    await svc.close();
  });

  it('close() completes, removes discovery and releases the lock even when a step throws', async () => {
    const adapter = generateCorpus({ sessions: 3, projects: 1, bigSessionMessages: 0 });
    const errors: string[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (m: string) => void errors.push(m),
      flush: async () => {},
    };
    const start = () =>
      startService({
        dataDir: join(dir, 'data'),
        claudeConfigDir: join(dir, 'claude-missing'),
        adapter,
        claude: { path: '/bin/claude', version: '2.1.314' },
        logger,
        installSignalHandlers: false,
      });
    const svc = await start();
    const dispose = vi.spyOn(SessionHost.prototype, 'dispose').mockImplementation(() => {
      throw new Error('dispose blew up');
    });
    const closed = vi.fn();
    svc.onClosed(closed);
    try {
      await svc.close();
    } finally {
      dispose.mockRestore();
    }
    expect(closed).toHaveBeenCalledTimes(1);
    expect(await readDiscovery(join(dir, 'data'))).toBeNull();
    expect(await readdir(join(dir, 'data'))).not.toContain('service.lock');
    expect(errors.some((e) => e.includes('dispose blew up'))).toBe(true);
    // The next service can take over the data dir.
    await (await start()).close();
  });

  it('without claude there is no poller: resume is unverified and status says why', async () => {
    const svc = await startService({
      dataDir: dir,
      claude: { problem: 'missing', detail: 'Claude Code was not found.' },
      installSignalHandlers: false,
    });
    const result = async (method: string, params: unknown) =>
      ((await rpc(svc.port, svc.token, method, params)) as { result: unknown }).result;
    expect(await result('chat.resumeCheck', { sessionId: 's' })).toMatchObject({
      status: 'unverified',
    });
    expect(await result('system.status', {})).toMatchObject({
      claude: { found: false, problem: 'Claude Code was not found.' },
      externalAvailable: false,
    });
    expect(await result('ui.visibility', { visible: false })).toEqual({});
    await svc.close();
  });

  it('starts on the data of the pahub dir it migrated (spec v1.3 §9)', async () => {
    const legacy = join(dir, 'pahub');
    await mkdir(legacy);
    const old = openDb(join(legacy, 'pahub.db'));
    old.patchSettings({ autoTitles: false });
    old.close();
    const data = join(dir, 'threadgarden');
    const adapter = generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 });
    const svc = await startService({
      dataDir: data,
      legacyDataDir: legacy,
      adapter,
      claudeConfigDir: dir,
      installSignalHandlers: false,
    });
    const settings = (await rpc(svc.port, svc.token, 'settings.get', {})) as {
      result: { autoTitles: boolean };
    };
    expect(settings.result.autoTitles).toBe(false);
    expect(await readdir(data)).toContain('threadgarden.db');
    expect(await readdir(legacy)).toContain('MOVED-TO-THREADGARDEN.txt');
    await svc.close();
  });

  it('does not start while a pahub service still holds the old dir', async () => {
    const legacy = join(dir, 'pahub');
    await mkdir(legacy);
    openDb(join(legacy, 'pahub.db')).close();
    const oldService = await acquireInstanceLock(legacy);
    const data = join(dir, 'threadgarden');
    await expect(
      startService({
        dataDir: data,
        legacyDataDir: legacy,
        adapter: generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 }),
        claudeConfigDir: dir,
        installSignalHandlers: false,
      }),
    ).rejects.toThrow(/older pahub service is still running/);
    expect(await readdir(data)).not.toContain('threadgarden.db');
    expect(await readdir(data)).not.toContain('service.lock');
    expect(await readDiscovery(data)).toBeNull();
    await oldService!.release();
  });

  it('releases the lock and closes everything when history setup fails', async () => {
    const data = join(dir, 'data');
    await mkdir(join(data, 'threadgarden.db'), { recursive: true }); // a directory: openDb must fail
    const adapter = generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 });
    await expect(
      startService({ dataDir: data, adapter, claudeConfigDir: dir, installSignalHandlers: false }),
    ).rejects.toThrow();
    expect(await readdir(data)).not.toContain('service.lock');
    expect(await readDiscovery(data)).toBeNull();
    await rm(join(data, 'threadgarden.db'), { recursive: true });
    const svc = await startService({
      dataDir: data,
      adapter,
      claudeConfigDir: dir,
      installSignalHandlers: false,
    });
    await svc.close();
  });

  it('refuses a second instance on the same data dir', async () => {
    const svc = await startService({ dataDir: dir, installSignalHandlers: false });
    await expect(startService({ dataDir: dir, installSignalHandlers: false })).rejects.toThrow(
      /already running/,
    );
    await svc.close();
  });

  it('service.shutdown stops the service', async () => {
    const svc = await startService({ dataDir: dir, installSignalHandlers: false });
    const done = new Promise<void>((r) => svc.onClosed(r));
    await rpc(svc.port, svc.token, 'service.shutdown', { stopAll: true });
    await done;
    expect(await readDiscovery(dir)).toBeNull();
  });

  it('idle-exit timer fires after 30 min with no clients or live sessions', async () => {
    let now = 0;
    const timers: { fn: () => void; at: number }[] = [];
    const svc = await startService({
      dataDir: dir,
      installSignalHandlers: false,
      liveCount: () => 0,
      clock: () => now,
      setInterval: (fn) => {
        timers.push({ fn, at: 0 });
        return timers.length as unknown as NodeJS.Timeout;
      },
      clearInterval: () => {},
    });
    const done = new Promise<void>((r) => svc.onClosed(r));
    now = 29 * 60_000;
    timers[0]!.fn();
    now = 30 * 60_000 + 1;
    timers[0]!.fn();
    await done;
    expect(await readDiscovery(dir)).toBeNull();
  });

  it('live sessions keep the service alive', async () => {
    let now = 0;
    let live = 1;
    const timers: (() => void)[] = [];
    const svc = await startService({
      dataDir: dir,
      installSignalHandlers: false,
      liveCount: () => live,
      clock: () => now,
      setInterval: (fn) => {
        timers.push(fn);
        return 1 as unknown as NodeJS.Timeout;
      },
      clearInterval: () => {},
    });
    now = 31 * 60_000;
    timers[0]!();
    expect(await readDiscovery(dir)).not.toBeNull();
    live = 0;
    timers[0]!(); // idle clock restarted at last live observation
    expect(await readDiscovery(dir)).not.toBeNull();
    await svc.close();
  });

  it('never exits on idle when headless', async () => {
    let now = 0;
    const timers: (() => void)[] = [];
    const svc = await startService({
      ...headless(),
      liveCount: () => 0,
      clock: () => now,
      setInterval: (fn) => {
        timers.push(fn);
        return 1 as unknown as NodeJS.Timeout;
      },
      clearInterval: () => {},
    });
    const closed = vi.fn();
    svc.onClosed(closed);
    const check = vi.spyOn(svc.scheduled!, 'check');
    now = 31 * 60_000;
    timers[0]!();
    now = 120 * 60_000;
    timers[0]!();
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).not.toHaveBeenCalled();
    expect(await readDiscovery(join(dir, 'data'))).not.toBeNull();
    // Holds and scheduled sends are still looked after.
    expect(check).toHaveBeenCalledTimes(2);
    await svc.close();
  });

  it('starts the remote listener only when headless', async () => {
    const plain = await startService({ ...headless(), headless: false });
    expect(plain.remote).toBeUndefined();
    expect(await readDiscovery(join(dir, 'data'))).not.toHaveProperty('remotePort');
    const nonce = 'a'.repeat(64);
    // Without a listener there is nothing to prove.
    expect(
      await plain.router.dispatch(
        { id: 1, method: 'pair.proof', params: { nonce } },
        { clientId: 'p', origin: 'remote' },
      ),
    ).toMatchObject({ error: { code: 'NOT_LISTENING' } });
    await plain.close();

    const svc = await startService(headless());
    expect(svc.remote).toEqual({ addresses: ['127.0.0.1'], port: expect.any(Number) });
    expect(svc.remote!.port).toBeGreaterThan(0);
    expect(await readDiscovery(join(dir, 'data'))).toMatchObject({
      remotePort: svc.remote!.port,
      remoteAddresses: ['127.0.0.1'],
    });
    const hello = (await rpc(svc.port, svc.token, 'hello', {
      protocolVersion: PROTOCOL_VERSION,
      client: 't',
    })) as { result: { machine: { headless: boolean } } };
    expect(hello.result.machine.headless).toBe(true);

    // Pairing is closed until a code is live.
    await expect(openTls(svc.remote!.port, 'threadgarden-pair')).rejects.toThrow(/503/);
    const { result: created } = (await rpc(svc.port, svc.token, 'pairing.create', {})) as {
      result: { code: string };
    };
    const pairing = await openTls(svc.remote!.port, 'threadgarden-pair');
    const proof = await tlsCall(pairing, 'pair.proof', { nonce });
    expect(proof.result.proof).toMatch(/^[0-9a-f]{64}$/);
    const claimed = await tlsCall(pairing, 'pair.claim', {
      code: created.code,
      deviceName: 'Laptop',
    });
    pairing.close();
    // One registry: the device paired over TLS is listed locally.
    expect(await rpc(svc.port, svc.token, 'devices.list', {})).toMatchObject({
      result: [{ id: claimed.result.deviceId, name: 'Laptop' }],
    });

    // Events reach paired devices as well as local clients.
    const device = await openTls(svc.remote!.port, `threadgarden-device.${claimed.result.token}`);
    const seen = new Promise<unknown>((resolve) =>
      device.on('message', (d) => {
        const msg = JSON.parse(String(d)) as { event?: string };
        if (msg.event === 'test.event') resolve(msg);
      }),
    );
    svc.broadcast({ event: 'test.event', data: { n: 1 } });
    expect(await seen).toEqual({ event: 'test.event', data: { n: 1 } });
    const deviceClosed = new Promise((r) => device.once('close', r));
    await svc.close();
    await deviceClosed;
    expect(await readDiscovery(join(dir, 'data'))).toBeNull();
  });

  it('starts headless without the remote listener when there is no private address', async () => {
    const warnings: string[] = [];
    const svc = await startService({
      ...headless(),
      remote: { addresses: [], port: 0 },
      logger: { ...quietLogger(), warn: (m) => void warnings.push(m) },
    });
    expect(svc.remote).toBeUndefined();
    expect(warnings.some((w) => /no private network address/i.test(w))).toBe(true);
    await svc.close();
  });

  it('follows the machine addresses on the idle tick (Ruling R12)', async () => {
    let addresses: string[] = [];
    const timers: (() => void)[] = [];
    const svc = await startService({
      ...headless(),
      remote: { port: 0, addressSource: () => addresses },
      setInterval: (fn) => {
        timers.push(fn);
        return 1 as unknown as NodeJS.Timeout;
      },
      clearInterval: () => {},
    });
    const data = join(dir, 'data');
    const tick = () => timers[0]!();
    const discovered = async () => await readDiscovery(data);

    // No address yet: no listener, but the service runs and can pair later.
    expect(svc.remote).toBeUndefined();
    expect(await discovered()).not.toHaveProperty('remotePort');
    const device = `threadgarden-device.${await pairDevice(svc)}`;

    // An address appears: the listener starts there.
    addresses = ['127.0.0.1'];
    tick();
    await expect.poll(() => svc.remote?.addresses).toEqual(['127.0.0.1']);
    const first = svc.remote!.port;
    await expect.poll(async () => (await discovered())?.remoteAddresses).toEqual(['127.0.0.1']);
    expect((await discovered())?.remotePort).toBe(first);
    const ws = await openTlsAt('127.0.0.1', first, device);
    expect(await tlsCall(ws, 'machine.get', {})).toMatchObject({ result: { headless: true } });

    // The address changes: the listener moves; the old address refuses.
    const dropped = new Promise((r) => ws.once('close', r));
    addresses = ['::1'];
    tick();
    await expect.poll(() => svc.remote?.addresses).toEqual(['::1']);
    await dropped;
    await expect(openTlsAt('127.0.0.1', first, device)).rejects.toThrow();
    const moved = await openTlsAt('::1', svc.remote!.port, device);
    expect(await tlsCall(moved, 'machine.get', {})).toMatchObject({ result: { headless: true } });
    moved.close();
    await expect.poll(async () => (await discovered())?.remoteAddresses).toEqual(['::1']);

    // The same set again: nothing moves.
    const port = svc.remote!.port;
    tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(svc.remote).toEqual({ addresses: ['::1'], port });

    // The addresses vanish: the listener stops and service.json says so.
    addresses = [];
    tick();
    await expect.poll(() => svc.remote).toBeUndefined();
    await expect.poll(async () => 'remotePort' in ((await discovered()) ?? {})).toBe(false);
    expect(await discovered()).toMatchObject({ port: svc.port, token: svc.token });
    await expect(openTlsAt('::1', port, device)).rejects.toThrow();
    await svc.close();
    expect(await discovered()).toBeNull();
  });

  it('retries a failed listener start on the next tick', async () => {
    const blocker = createServer();
    const port = await new Promise<number>((resolve) =>
      blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as AddressInfo).port)),
    );
    const errors: string[] = [];
    const timers: (() => void)[] = [];
    const svc = await startService({
      ...headless(),
      remote: { port, addressSource: () => ['127.0.0.1'] },
      logger: { ...quietLogger(), error: (m) => void errors.push(m) },
      setInterval: (fn) => {
        timers.push(fn);
        return 1 as unknown as NodeJS.Timeout;
      },
      clearInterval: () => {},
    });
    // The port is taken: the service runs without the listener and says why.
    expect(svc.remote).toBeUndefined();
    expect(errors).toEqual([expect.stringMatching(/listening for devices on 127\.0\.0\.1 failed/)]);
    timers[0]!();
    await expect.poll(() => errors.length).toBe(2);
    expect(svc.remote).toBeUndefined();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    timers[0]!();
    await expect.poll(() => svc.remote?.port).toBe(port);
    await expect.poll(async () => (await readDiscovery(join(dir, 'data')))?.remotePort).toBe(port);
    await svc.close();
  });

  it('warns when the TLS identity had to be created again', async () => {
    const data = join(dir, 'data');
    await mkdir(join(data, 'tls'), { recursive: true });
    await writeFile(join(data, 'tls', 'cert.pem'), 'not a certificate');
    const warnings: string[] = [];
    const svc = await startService({
      ...headless(),
      logger: { ...quietLogger(), warn: (m) => void warnings.push(m) },
    });
    expect(svc.remote).toBeDefined();
    expect(warnings).toContain(
      'TLS identity was missing; created a new one — paired devices must pair again',
    );
    await svc.close();
  });
});

/** A headless service with history, listening for devices on loopback (tests only). */
const headless = () => ({
  dataDir: join(dir, 'data'),
  claudeConfigDir: join(dir, 'claude-missing'),
  adapter: generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 }),
  installSignalHandlers: false,
  headless: true,
  remote: { addresses: ['127.0.0.1'], port: 0 },
  logger: quietLogger(),
});
/** Pairs a device through the service's own handlers; its token. */
const pairDevice = async (svc: ServiceHandle): Promise<string> => {
  const created = (await svc.router.dispatch(
    { id: 1, method: 'pairing.create', params: {} },
    { clientId: 't', origin: 'local' },
  )) as { result: { code: string } };
  const claimed = (await svc.router.dispatch(
    { id: 2, method: 'pair.claim', params: { code: created.result.code, deviceName: 'Laptop' } },
    { clientId: 'p', origin: 'remote' },
  )) as { result: { token: string } };
  return claimed.result.token;
};
const quietLogger = () => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
});
const openTls = (port: number, protocol: string) => openTlsAt('127.0.0.1', port, protocol);
const openTlsAt = (host: string, port: number, protocol: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const where = host.includes(':') ? `[${host}]` : host;
    const ws = new WebSocket(`wss://${where}:${port}`, [protocol], { rejectUnauthorized: false });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON results in tests
const tlsCall = (ws: WebSocket, method: string, params: unknown): Promise<{ result?: any }> =>
  new Promise((resolve) => {
    const onMessage = (d: unknown) => {
      const msg = JSON.parse(String(d)) as { id?: number; result?: unknown };
      if (msg.id !== 7) return;
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id: 7, method, params }));
  });

describe('createLogger', () => {
  it('writes info to logs/ and hides debug by default', async () => {
    const log = createLogger(dir);
    log.info('hello-info');
    log.debug('secret-debug');
    await log.flush();
    const files = await readdir(join(dir, 'logs'));
    expect(files.length).toBeGreaterThan(0);
    const text = await readFile(join(dir, 'logs', files[0]!), 'utf8');
    expect(text).toContain('hello-info');
    expect(text).not.toContain('secret-debug');
  });
});
