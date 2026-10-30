import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { readDiscovery } from '../src/discovery.js';
import { createLogger } from '../src/logger.js';
import { startService } from '../src/main.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pahub-main-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rpc = (port: number, token: string, method: string, params: unknown) =>
  new Promise<unknown>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, `pahub.${token}`);
    ws.once('error', reject);
    ws.once('message', (d) => {
      ws.close();
      resolve(JSON.parse(String(d)));
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
      protocolVersion: 1,
    });
    expect(
      await rpc(svc.port, svc.token, 'hello', { protocolVersion: 1, client: 't' }),
    ).toMatchObject({
      result: { protocolVersion: 1 },
    });
    await svc.close();
    expect(await readDiscovery(dir)).toBeNull();
    expect(await readdir(dir)).not.toContain('service.lock');
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
