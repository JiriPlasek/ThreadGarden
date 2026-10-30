import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { PROTOCOL_VERSION } from '@pahub/protocol';
import pkg from '../package.json' with { type: 'json' };
import { resolveDataDir } from './config.js';
import { acquireInstanceLock, removeDiscovery, writeDiscovery } from './discovery.js';
import { createLogger, type Logger } from './logger.js';
import { Router } from './server/router.js';
import { startWsServer } from './server/ws-server.js';

export const IDLE_EXIT_MS = 30 * 60_000;
const IDLE_CHECK_MS = 60_000;

export type StartOptions = {
  dataDir: string;
  /** Number of live sessions; they keep the service alive. Wired up by the session host. */
  liveCount?: () => number;
  clock?: () => number;
  setInterval?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval?: (t: NodeJS.Timeout) => void;
  installSignalHandlers?: boolean;
  logger?: Logger;
};

export type ServiceHandle = {
  port: number;
  token: string;
  router: Router;
  broadcast: (e: { event: string; data: unknown }) => void;
  close(): Promise<void>;
  onClosed(cb: () => void): void;
};

export const startService = async (opts: StartOptions): Promise<ServiceHandle> => {
  const { dataDir } = opts;
  const liveCount = opts.liveCount ?? (() => 0);
  const clock = opts.clock ?? Date.now;
  const setTimer = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearInterval ?? ((t) => clearInterval(t));
  const log = opts.logger ?? createLogger(dataDir);

  await mkdir(dataDir, { recursive: true });
  const lock = await acquireInstanceLock(dataDir);
  if (!lock) throw new Error('pahub service is already running for this data directory');

  const token = randomBytes(32).toString('hex');
  const router = new Router(log);
  let clientCount = 0;
  let lastActive = clock();
  let closing: Promise<void> | null = null;
  const closedCallbacks: (() => void)[] = [];

  router.register('hello', async () => ({
    serviceVersion: pkg.version,
    protocolVersion: PROTOCOL_VERSION,
  }));

  let server: Awaited<ReturnType<typeof startWsServer>>;
  try {
    server = await startWsServer({
      token,
      router,
      onClientCountChange: (n) => {
        clientCount = n;
        lastActive = clock();
      },
    });
    await writeDiscovery(dataDir, {
      pid: process.pid,
      port: server.port,
      token,
      version: pkg.version,
      protocolVersion: PROTOCOL_VERSION,
      startedAt: clock(),
    });
  } catch (err) {
    await lock.release();
    throw err;
  }

  const close = (): Promise<void> => {
    closing ??= (async () => {
      clearTimer(timer);
      await server.close();
      await removeDiscovery(dataDir);
      await lock.release();
      await log.flush();
      for (const cb of closedCallbacks) cb();
    })();
    return closing;
  };

  const timer = setTimer(() => {
    if (liveCount() > 0 || clientCount > 0) lastActive = clock();
    else if (clock() - lastActive >= IDLE_EXIT_MS) {
      log.info('idle for 30 minutes, exiting');
      void close();
    }
  }, IDLE_CHECK_MS);
  timer.unref?.();

  router.register('service.shutdown', async () => {
    setImmediate(() => void close());
    return {};
  });

  if (opts.installSignalHandlers ?? true) {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void close());
  }

  log.info(`service started on 127.0.0.1:${server.port}`);
  return {
    port: server.port,
    token,
    router,
    broadcast: server.broadcast,
    close,
    onClosed: (cb) => void closedCallbacks.push(cb),
  };
};

const isEntry = (): boolean =>
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry()) {
  const dataDir = resolveDataDir(process.env, process.platform, os.homedir());
  startService({ dataDir })
    .then((svc) => svc.onClosed(() => process.exit(0)))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
