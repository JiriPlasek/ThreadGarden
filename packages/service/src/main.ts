import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROTOCOL_VERSION, type EventMsg } from '@pahub/protocol';
import pkg from '../package.json' with { type: 'json' };
import { resolveDataDir } from './config.js';
import { acquireInstanceLock, removeDiscovery, writeDiscovery } from './discovery.js';
import { Catalog, type ExternalSession, type LiveChat } from './history/catalog.js';
import { openDb, type Db } from './history/db.js';
import { Indexer } from './history/indexer.js';
import { createQuickSearch } from './history/search.js';
import { watchProjects } from './history/watcher.js';
import { createLogger, type Logger } from './logger.js';
import type { AgentAdapter } from './sdk/adapter.js';
import { registerHistoryHandlers } from './server/handlers/history.js';
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
  /**
   * Enables history: opens `pahub.db`, indexes sessions through this adapter,
   * watches `<claudeConfigDir>/projects` and serves the places API.
   */
  adapter?: AgentAdapter;
  /** Claude Code's config dir (`CLAUDE_CONFIG_DIR` or `~/.claude`); read-only for pahub. */
  claudeConfigDir?: string;
  /** Chats owned by the session host (Task 10 passes `host`). */
  live?: { list(): LiveChat[] };
  /** External sessions snapshot (Task 8). */
  externals?: () => ExternalSession[];
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

  const broadcastRef: { fn: (e: EventMsg) => void } = { fn: () => {} };
  let db: Db | undefined;
  let watcher: { close(): void } | undefined;
  if (opts.adapter) {
    const claudeDir =
      opts.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    db = openDb(path.join(dataDir, 'pahub.db'));
    const indexer = new Indexer(opts.adapter, db, (e) => broadcastRef.fn(e), {
      onError: (err, ctx) => log.error(`indexer ${JSON.stringify(ctx)}: ${String(err)}`),
    });
    const catalog = new Catalog({
      db,
      ...(opts.live ? { live: opts.live } : {}),
      ...(opts.externals ? { externals: opts.externals } : {}),
    });
    registerHistoryHandlers(router, { db, catalog, quickSearch: createQuickSearch(db, catalog) });
    watcher = watchProjects(
      path.join(claudeDir, 'projects'),
      (ids) =>
        void indexer.refresh(ids).catch((err: unknown) => log.error(`refresh: ${String(err)}`)),
      { onError: (err) => log.error(`watcher: ${String(err)}`) },
    );
    void indexer.fullSync().catch((err: unknown) => log.error(`full sync: ${String(err)}`));
  }

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
    broadcastRef.fn = server.broadcast;
    await writeDiscovery(dataDir, {
      pid: process.pid,
      port: server.port,
      token,
      version: pkg.version,
      protocolVersion: PROTOCOL_VERSION,
      startedAt: clock(),
    });
  } catch (err) {
    watcher?.close();
    db?.close();
    await lock.release();
    throw err;
  }

  const close = (): Promise<void> => {
    closing ??= (async () => {
      clearTimer(timer);
      watcher?.close();
      await server.close();
      await removeDiscovery(dataDir);
      db?.close();
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
