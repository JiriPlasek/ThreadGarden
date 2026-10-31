import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@threadgarden/protocol';
import { acquireInstanceLock, readDiscovery } from '../src/discovery.js';
import { openDb } from '../src/history/db.js';
import { createLogger } from '../src/logger.js';
import { SessionHost } from '../src/chat/session-host.js';
import { startService } from '../src/main.js';
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
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, `pahub.${token}`);
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
