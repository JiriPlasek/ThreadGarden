import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION, type ChatStatus, type EventMsg } from '@pahub/protocol';
import pkg from '../package.json' with { type: 'json' };
import { nextSeqEpoch, seqBaseForEpoch } from './chat/event-log.js';
import { realTimers, type Timers } from './chat/live-session.js';
import { SessionHost } from './chat/session-host.js';
import { RoutingSettingsCheck, routingSettingsPaths } from './chat/title-routing.js';
import { ChatTitles } from './chat/titles.js';
import { resolveClaudeConfigDir } from './config.js';
import { acquireInstanceLock, removeDiscovery, writeDiscovery } from './discovery.js';
import { FileIndex } from './files/file-index.js';
import { ExternalPoller, makeClaudeRunner, type ExternalSession } from './external/poller.js';
import { Buckets } from './history/buckets.js';
import { Catalog, UNTITLED_TITLE, titleFor, type LiveChat } from './history/catalog.js';
import { openDb, type Db } from './history/db.js';
import { Indexer } from './history/indexer.js';
import { FolderCheck, ProjectOrderNotifier } from './history/project-activity.js';
import { ProjectIcons, type FoundIcon } from './history/project-icons.js';
import { createQuickSearch } from './history/search.js';
import { watchProjects } from './history/watcher.js';
import { createLogger, type Logger } from './logger.js';
import type { AgentAdapter } from './sdk/adapter.js';
import type { ClaudeFound, ClaudeProblem } from './sdk/claude-path.js';
import { buildSessionEnv } from './sdk/real-adapter.js';
import { registerChatHandlers } from './server/handlers/chat.js';
import { makeResumeChecker, registerExternalHandlers } from './server/handlers/external.js';
import { registerFileHandlers } from './server/handlers/files.js';
import { registerHistoryHandlers } from './server/handlers/history.js';
import { registerUsageHandlers } from './server/handlers/usage.js';
import { Router } from './server/router.js';
import { startWsServer } from './server/ws-server.js';
import { ScheduledSends } from './usage/scheduled.js';
import { UsageTracker } from './usage/usage.js';

export const IDLE_EXIT_MS = 30 * 60_000;
/**
 * The idle check; it also ends on-hold chats' holds whose time ran out (v1.2,
 * ≤ 60 s late) and catches up on scheduled sends (v1.3 B; their own timer is
 * the precise one).
 */
const IDLE_CHECK_MS = 60_000;
/** A chat in a turn (working, waiting on the user): its next scheduled send waits (v1.3 B). */
const IN_TURN: ReadonlySet<ChatStatus> = new Set(['working', 'needsYou', 'unknown']);
/** Said in a chat whose scheduled message was due while the service was not running. */
export const LATE_NOTE =
  'This scheduled message went out late: pahub was not running when it was due.';
/** pahub-db key of the last chat seq epoch (see `nextSeqEpoch`). */
const SEQ_EPOCH_KEY = 'service:seqEpoch';

type ClaudeStatus = ClaudeFound | ClaudeProblem;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export type StartOptions = {
  dataDir: string;
  /** Number of live sessions; they keep the service alive. Default: the session host's. */
  liveCount?: () => number;
  clock?: () => number;
  setInterval?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval?: (t: NodeJS.Timeout) => void;
  installSignalHandlers?: boolean;
  logger?: Logger;
  /**
   * Enables history and chats: opens `pahub.db`, indexes sessions through
   * this adapter, watches `<claudeConfigDir>/projects`, serves the places API
   * and runs the session host (every `chat.*` method).
   */
  adapter?: AgentAdapter;
  /** Claude Code's config dir (`CLAUDE_CONFIG_DIR` or `~/.claude`); read-only for pahub. */
  claudeConfigDir?: string;
  /** Overrides the session host as the source of pahub-owned chats for lists and the poller. */
  live?: { list(): LiveChat[] };
  /**
   * External sessions snapshot. Overrides the built-in poller's (tests, or a
   * caller that polls itself); the poller still serves resume checks.
   */
  externals?: () => ExternalSession[];
  /** Where `claude` was found (or why not), as `findInstalledClaude` reports it. */
  claude?: ClaudeStatus;
  /**
   * Finds `claude` given pahub's `claudePath` setting, when `claude` is not
   * passed; run at start and again whenever that setting changes.
   */
  locateClaude?: (settingPath: string | null) => Promise<ClaudeStatus>;
  /**
   * Runs `claude <args>` for the external-session poller. Defaults to spawning
   * the located `claude` when it was found at start; without either there is no poller.
   */
  externalRun?: (args: string[]) => Promise<string>;
  /** Builds the `claude agents` runner for a located `claude` (default: spawn it). */
  claudeRunner?: (claudePath: string) => (args: string[]) => Promise<string>;
  /** Approximate size budget (characters) of the chat history cache; see `registerChatHandlers`. */
  historyCacheChars?: number;
  /** Base environment of session processes (default `process.env`); the API key is added on top. */
  sessionEnv?: NodeJS.ProcessEnv;
  /**
   * Timers for the session host (coalescing, idle reclaim) and `chat.end`'s
   * index wait; default Node timers.
   */
  sessionTimers?: Timers;
  /** Whether a project folder exists (v1.1 §4); default one `fs.stat` per folder. */
  folderStat?: (path: string) => Promise<boolean>;
  /** Where a project's icon is looked up (v1.3 §5); default the project folder itself. */
  projectIconSearch?: (projectPath: string) => Promise<FoundIcon | null>;
  /** Fixed port and token (mock service, UI tests); default a random port and a fresh token. */
  port?: number;
  token?: string;
  /**
   * API-key-only configuration (spec §5.5; build flag `PAHUB_API_KEY_ONLY`):
   * chats start or resume only with an API key set (`auth.setApiKey`), never
   * on the installed Claude Code's own sign-in.
   */
  apiKeyOnly?: boolean;
};

/** How long shutdown waits for a running index pass to reach a stopping point. */
const INDEXER_STOP_MS = 5_000;

export type ServiceHandle = {
  port: number;
  token: string;
  router: Router;
  /** The session host (present when an adapter was given). */
  host?: SessionHost;
  /** v1.3 B: plan usage and scheduled sends (present when an adapter was given). */
  usage?: UsageTracker;
  scheduled?: ScheduledSends;
  broadcast: (e: { event: string; data: unknown }) => void;
  close(): Promise<void>;
  onClosed(cb: () => void): void;
};

export const startService = async (opts: StartOptions): Promise<ServiceHandle> => {
  const { dataDir } = opts;
  const clock = opts.clock ?? Date.now;
  const setTimer = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearInterval ?? ((t) => clearInterval(t));
  const log = opts.logger ?? createLogger(dataDir);

  await mkdir(dataDir, { recursive: true });
  const lock = await acquireInstanceLock(dataDir);
  if (!lock) throw new Error('pahub service is already running for this data directory');

  const token = opts.token ?? randomBytes(32).toString('hex');
  const router = new Router(log);
  let clientCount = 0;
  let lastActive = clock();
  let closing: Promise<void> | null = null;
  const closedCallbacks: (() => void)[] = [];
  /** One shutdown step; a failure is logged and the shutdown carries on. */
  const step = async (name: string, fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      log.error(`shutdown (${name}): ${errorText(err)}`);
    }
  };

  router.register('hello', async () => ({
    serviceVersion: pkg.version,
    protocolVersion: PROTOCOL_VERSION,
  }));

  const broadcastRef: { fn: (e: EventMsg) => void } = { fn: () => {} };
  /** v1.2: runs once the catalog exists (the poller is created before it). */
  const bucketsRef: { onExternals: () => void } = { onExternals: () => {} };
  const claude: { current: ClaudeStatus | undefined } = { current: opts.claude };
  /** pahub's optional API key (§5.5): in memory only, never logged or stored. */
  let apiKey: string | null = null;
  let db: Db | undefined;
  let host: SessionHost | undefined;
  let indexing = { done: 0, total: 0 };
  let indexer: Indexer | undefined;
  let watcher: { close(): void } | undefined;
  let server: Awaited<ReturnType<typeof startWsServer>> | undefined;
  let poller: ExternalPoller | undefined;
  let projectOrder: ProjectOrderNotifier | undefined;
  let buckets: Buckets | undefined;
  let titles: ChatTitles | undefined;
  let usage: UsageTracker | undefined;
  let scheduled: ScheduledSends | undefined;
  let startSync: (() => void) | undefined;
  const live = (): { list(): LiveChat[] } | undefined => opts.live ?? host;
  const claudeRunner = opts.claudeRunner ?? makeClaudeRunner;
  /** `claude agents` can run now: an injected runner, or a located `claude`. */
  const externalUsable = (): boolean => {
    const c = claude.current;
    return opts.externalRun !== undefined || (c !== undefined && 'path' in c);
  };

  const locate = async (settingPath: string | null): Promise<ClaudeStatus | undefined> => {
    if (!opts.locateClaude) return claude.current;
    try {
      return await opts.locateClaude(settingPath);
    } catch (err) {
      return { problem: 'unrunnable', detail: `Locating Claude Code failed: ${errorText(err)}` };
    }
  };
  const noteProblem = (c: ClaudeStatus | undefined): void => {
    if (c && !('path' in c)) log.warn(`claude: ${c.detail}`);
  };
  let locating = 0;
  /** Settles when the newest search for `claude` has (see `relocate`). */
  let located: Promise<void> = Promise.resolve();
  /**
   * Finds `claude` (at start, and again after the path setting changed); the
   * newest request wins. It runs in the background: `claude --version` can
   * take seconds (an npm install on Windows, a cold disk), and the UI must be
   * able to connect meanwhile. Requests that need the answer wait for it.
   */
  const relocate = (): Promise<void> => {
    const ticket = ++locating;
    located = locate(db?.getSettings().claudePath ?? null).then((found) => {
      if (ticket !== locating) return;
      claude.current = found;
      noteProblem(found);
      // External sessions show up now rather than at the next poll.
      if (found && 'path' in found) void poller?.refresh();
    });
    return located;
  };
  /** Waits for the search for `claude` in progress, if any. */
  const whenLocated = (): Promise<void> => located;

  try {
    if (opts.adapter) db = openDb(path.join(dataDir, 'pahub.db'));
    const found = claude.current;
    noteProblem(found);

    // A poller exists whenever `claude` can be (re)located or was found: the
    // runner follows the current `claude`, and polling pauses while it is missing.
    const run =
      opts.externalRun ??
      (opts.locateClaude || (found && 'path' in found)
        ? (args: string[]) => {
            const c = claude.current;
            return c && 'path' in c
              ? claudeRunner(c.path)(args)
              : Promise.reject(new Error('Claude Code is not available'));
          }
        : undefined);
    if (run) {
      poller = new ExternalPoller(
        run,
        // Only *live* pahub chats are pahub's own processes. A paused or failed
        // chat has none, so one that is running now runs in a terminal (§4.4).
        // v1.2 C1: so are the title queries pahub runs (`claude` lists them while they run).
        () =>
          new Set([
            ...(live()?.list() ?? []).filter((c) => c.live).map((c) => c.sessionId),
            ...(titles?.runningIds() ?? []),
          ]),
        (e) => {
          // v1.2: archived chats running elsewhere return to Active first.
          if (e.event === 'external.changed') {
            try {
              bucketsRef.onExternals();
            } catch (err) {
              log.error(`auto-unarchive: ${errorText(err)}`);
            }
          }
          broadcastRef.fn(e);
        },
        {
          enabled: () => externalUsable() && (db?.getSettings().externalPolling ?? true),
          onError: (err) => log.error(`external poller: ${String(err)}`),
        },
      );
    }
    const resumeCheck = makeResumeChecker({
      ...(poller ? { poller } : {}),
      located: whenLocated,
      externalUsable,
      lastModifiedOf: (id) => db?.getSession(id)?.lastModified,
      now: clock,
    });

    if (opts.adapter && db) {
      const adapter = opts.adapter;
      const opened = db;
      const claudeDir = opts.claudeConfigDir ?? resolveClaudeConfigDir(process.env, os.homedir());
      const epoch = nextSeqEpoch(opened.getUiState(SEQ_EPOCH_KEY));
      opened.setUiState(SEQ_EPOCH_KEY, epoch);
      const onError = (err: unknown, context: string) => log.error(`${context}: ${errorText(err)}`);
      const projectsChanged = () => broadcastRef.fn({ event: 'projects.changed', data: {} });
      // v1.1 §4: project folders that no longer exist (stat only, cached).
      const folders = new FolderCheck({
        onChange: projectsChanged,
        onError,
        ...(opts.folderStat ? { stat: opts.folderStat } : {}),
      });
      const projectOrderRef: { current?: ProjectOrderNotifier } = {};
      /** v1.2 C1: set once the catalog exists (after the session host). */
      const titlesRef: { current?: ChatTitles } = {};
      // v1.3 B: the account's plan usage, from every session's rate-limit events.
      const usageTracker = new UsageTracker({
        raw: opened.raw,
        now: clock,
        emit: (state) => broadcastRef.fn({ event: 'usage.changed', data: state }),
        timers: opts.sessionTimers ?? realTimers,
        onError,
      });
      usage = usageTracker;
      /** Set once the chat handlers exist (scheduled sends go out through `chat.send`). */
      const scheduledRef: { current?: ScheduledSends } = {};
      /** Title and project of a chat for notifications (`needsYou`, `scheduledSent`). */
      const describeChat = (id: string): { title?: string; projectName?: string } => {
        const row = opened.getSession(id);
        if (!row) {
          // Not indexed yet: pahub's own title of it, if any (v1.2 C1).
          const title = titleFor(opened.metaOf(id));
          return title === UNTITLED_TITLE ? {} : { title };
        }
        const project = opened.listProjects().find((p) => p.projectId === row.projectId);
        return {
          title: titleFor(row),
          ...(project ? { projectName: project.displayName } : {}),
        };
      };
      const sessionHost = new SessionHost({
        adapter,
        registry: opened,
        claudePath: () => {
          const c = claude.current;
          return c && 'path' in c ? c.path : '';
        },
        env: () => buildSessionEnv(opts.sessionEnv ?? process.env, apiKey),
        emit: (e) => emitChat(e),
        now: clock,
        ...(opts.sessionTimers ? { timers: opts.sessionTimers } : {}),
        isPinned: (id) => opened.isSessionPinned(id),
        getSettings: () => opened.getSettings(),
        describe: describeChat,
        onError,
        seqBase: seqBaseForEpoch(epoch),
        // v1.1 "Your turn": pahub's own record of the turn end; lists show the chat unread.
        onTurnEnded: (id, at) => {
          opened.setTurnEnded(id, at);
          emitChat({ event: 'sessions.changed', data: { sessionIds: [id] } });
          // v1.2 C1: a new chat's first turn is over: it gets its generated title.
          titlesRef.current?.turnEnded(id);
        },
        // v1.1 §4: live activity may reorder the projects.
        onActivity: () => projectOrderRef.current?.notify(),
        // Ruling R29: running background tasks put a chat under Running, idle or not.
        onRunningTasks: (id) => emitChat({ event: 'sessions.changed', data: { sessionIds: [id] } }),
        // v1.3 B: usage limits, and the scheduled send whose turn this was.
        onRateLimit: (id, info) => usageTracker.observeEvent(id, info),
        onLimitError: (id) => usageTracker.noteRefusal(id),
        onTurnResult: (id) => {
          const refused = usageTracker.turnEnded(id);
          // After the session has finished handling this result.
          setImmediate(() => scheduledRef.current?.turnEnded(id, refused));
        },
      });
      host = sessionHost;

      const catalogRef: { current?: Catalog } = {};
      const index = new Indexer(
        adapter,
        opened,
        (e) => {
          if (e.event === 'sessions.changed' || e.event === 'projects.changed') {
            catalogRef.current?.invalidate();
          }
          if (e.event === 'index.progress') indexing = e.data as typeof indexing;
          broadcastRef.fn(e);
        },
        {
          onError: (err, ctx) => log.error(`indexer ${JSON.stringify(ctx)}: ${String(err)}`),
          // A turn in progress appends to its transcript all the time: index it
          // once the turn is over, not on every watcher event (the chat view
          // reads the SDK, never the index).
          deferWhile: (id) => {
            const s = sessionHost.get(id);
            return s !== undefined && s.live && s.status !== 'idle';
          },
        },
      );
      indexer = index;
      /** Chat events go to clients; a turn that ended lets deferred indexing run. */
      const emitChat = (e: EventMsg): void => {
        broadcastRef.fn(e);
        if (e.event === 'chat.status') {
          const { sessionId, status } = e.data as { sessionId: string; status: ChatStatus };
          setImmediate(() => scheduledRef.current?.statusChanged(sessionId, status));
        }
        if (e.event !== 'chat.status' && e.event !== 'sessions.changed') return;
        // After the host has finished the transition that emitted this.
        setImmediate(() => {
          void index
            .resumeDeferred()
            .catch((err: unknown) => log.error(`deferred index: ${errorText(err)}`));
        });
      };
      const cat = new Catalog({
        db: opened,
        live: live() ?? sessionHost,
        externals: opts.externals ?? (() => poller?.snapshot() ?? []),
        folderExists: (p) => folders.exists(p),
      });
      catalogRef.current = cat;
      const routing = new RoutingSettingsCheck();
      const chatTitles = new ChatTitles({
        db: opened,
        adapter,
        enabled: () => opened.getSettings().autoTitles,
        // Exactly when a chat could start (`API_KEY_REQUIRED`, `CLAUDE_MISSING`).
        run: () => {
          const c = claude.current;
          if ((opts.apiKeyOnly === true && apiKey === null) || !c || !('path' in c)) {
            return undefined;
          }
          return {
            claudePath: c.path,
            env: buildSessionEnv(opts.sessionEnv ?? process.env, apiKey),
          };
        },
        firstReply: (id) => sessionHost.get(id)?.firstReplyText() ?? '',
        // Ruling R33: never around the provider the user's settings choose.
        routedElsewhere: (cwd) => routing.check(routingSettingsPaths(claudeDir, cwd)),
        titleChanged: (id) => cat.titleChanged(id),
        emit: (e) => broadcastRef.fn(e),
        debug: (m) => log.debug(m),
        now: clock,
      });
      titles = chatTitles;
      titlesRef.current = chatTitles;
      const bucketList = new Buckets({
        db: opened,
        catalog: cat,
        emit: (e) => broadcastRef.fn(e),
        now: clock,
      });
      buckets = bucketList;
      const externalsNow = opts.externals ?? (() => poller?.snapshot() ?? []);
      bucketsRef.onExternals = () => bucketList.unarchiveRunning(externalsNow());
      projectOrder = new ProjectOrderNotifier({
        changed: () => cat.projectOrderChanged(),
        emit: projectsChanged,
        timers: opts.sessionTimers ?? realTimers,
        now: clock,
        onError,
      });
      projectOrderRef.current = projectOrder;
      registerHistoryHandlers(router, {
        db: opened,
        catalog: cat,
        quickSearch: createQuickSearch(opened, cat),
        buckets: bucketList,
        icons: new ProjectIcons({
          onError,
          ...(opts.projectIconSearch ? { find: opts.projectIconSearch } : {}),
        }),
        folderExists: (p) => folders.exists(p),
        onSettingsChanged: (patch) => {
          if (patch.claudePath !== undefined && opts.locateClaude) relocate();
        },
      });
      const chatHandlers = registerChatHandlers(router, {
        host: sessionHost,
        adapter,
        db: opened,
        catalog: cat,
        claude: () => claude.current,
        located: whenLocated,
        apiKeyMissing: () => opts.apiKeyOnly === true && apiKey === null,
        resumeCheck,
        indexNow: (ids) => index.refresh(ids),
        ...(opts.historyCacheChars === undefined
          ? {}
          : { historyCacheChars: opts.historyCacheChars }),
        emit: (e) => emitChat(e),
        onError,
        now: clock,
        timers: opts.sessionTimers ?? realTimers,
        titles: chatTitles,
      });
      const scheduledSends = new ScheduledSends({
        raw: opened.raw,
        now: clock,
        timers: opts.sessionTimers ?? realTimers,
        emit: (e) => broadcastRef.fn(e),
        send: (sessionId, text, images) => chatHandlers.send({ sessionId, text, images }),
        busy: (id) => {
          const s = sessionHost.get(id);
          return s !== undefined && s.live && IN_TURN.has(s.status);
        },
        limitResetAt: () => usageTracker.limitResetAt(),
        exists: (id) => sessionHost.get(id) !== undefined || cat.summary(id) !== undefined,
        describe: (id) => {
          const d = describeChat(id);
          return { title: d.title ?? UNTITLED_TITLE, projectName: d.projectName ?? '' };
        },
        noteLate: (id) => sessionHost.get(id)?.note('info', LATE_NOTE),
        onError,
      });
      scheduled = scheduledSends;
      scheduledRef.current = scheduledSends;
      registerUsageHandlers(router, {
        usage: usageTracker,
        scheduled: scheduledSends,
        reader: () => sessionHost.usageReader(),
      });
      watcher = watchProjects(
        path.join(claudeDir, 'projects'),
        (ids) =>
          void index.refresh(ids).catch((err: unknown) => log.error(`refresh: ${String(err)}`)),
        { onError: (err) => log.error(`watcher: ${String(err)}`) },
      );
      startSync = () =>
        void index
          .fullSync()
          // A sync is when folders are known to be worth checking again (v1.1 §4).
          .then(() =>
            closing ? undefined : folders.refresh(opened.listProjects().map((p) => p.path)),
          )
          .catch((err: unknown) => log.error(`full sync: ${String(err)}`));
    }

    registerFileHandlers(router, { index: new FileIndex() });
    registerExternalHandlers(router, {
      ...(poller ? { poller } : {}),
      ...(run ? { run } : {}),
      located: whenLocated,
      externalUsable,
      lastModifiedOf: (id) => db?.getSession(id)?.lastModified,
      claude: () => claude.current,
      indexing: () => indexing,
      now: clock,
    });

    router.register('auth.setApiKey', async (p) => {
      apiKey = p.key === null || p.key.trim() === '' ? null : p.key.trim();
      return {};
    });
    router.register('work.stopAll', async () => ({ stopped: host?.stopAll() ?? 0 }));

    server = await startWsServer({
      token,
      router,
      ...(opts.port === undefined ? {} : { port: opts.port }),
      onClientCountChange: (n) => {
        clientCount = n;
        lastActive = clock();
      },
      onError: (err) => log.error(`ws server: ${errorText(err)}`),
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
    // Clients can connect now; `claude` is found in the background (§8 cold start).
    if (!claude.current && opts.locateClaude) void relocate();
  } catch (err) {
    await step('poller', () => poller?.stop());
    await step('watcher', () => watcher?.close());
    await step('indexer', () => indexer?.stop());
    await step('server', () => server?.close());
    await step('database', () => db?.close());
    await step('lock', () => lock.release());
    throw err;
  }
  const wsServer = server;
  const liveCount = opts.liveCount ?? (() => host?.liveCount() ?? 0);
  // Chats that were live when the service last stopped show as interrupted (§4.2).
  host?.recoverAfterRestart();
  /** Ends the holds whose time ran out (v1.2); a failure is logged, never fatal. */
  const sweepHolds = (): void => {
    try {
      buckets?.sweepHolds();
    } catch (err) {
      log.error(`hold timer: ${errorText(err)}`);
    }
  };
  // Holds that ran out while the service was not running end now.
  sweepHolds();
  host?.start();
  /** Scheduled sends that are due go out (v1.3 B); a failure is logged, never fatal. */
  const checkScheduled = (start = false): void => {
    try {
      if (start) scheduled?.start();
      else scheduled?.check();
    } catch (err) {
      log.error(`scheduled sends: ${errorText(err)}`);
    }
  };
  // Sends due while the service was not running go out now (marked late).
  checkScheduled(true);
  startSync?.();
  poller?.start();

  /** Waits for a running index pass to stop, but not forever. */
  const stopIndexer = async (): Promise<void> => {
    if (!indexer) return;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      indexer.stop(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, INDEXER_STOP_MS);
        timeout.unref?.();
      }),
    ]);
    clearTimeout(timeout);
  };

  /**
   * Stops everything. Every step runs even if an earlier one throws, and the
   * lock release, the log flush and the closed callbacks (the process exit)
   * always follow: a half-closed service must never keep the data dir locked.
   */
  const close = (): Promise<void> => {
    closing ??= (async () => {
      try {
        clearTimer(timer);
        await step('scheduled sends', () => scheduled?.dispose());
        // Live sessions end with the process; the registry still lists them,
        // so the next start shows them as interrupted (§4.2).
        await step('sessions', () => host?.dispose());
        await step('titles', () => titles?.dispose());
        await step('project order', () => projectOrder?.dispose());
        await step('poller', () => poller?.stop());
        await step('watcher', () => watcher?.close());
        // No index write may race the database close below.
        await step('indexer', stopIndexer);
        await step('server', () => wsServer.close());
        await step('discovery', () => removeDiscovery(dataDir));
        await step('database', () => db?.close());
      } finally {
        await step('lock', () => lock.release());
        await step('log', () => log.flush());
        for (const cb of closedCallbacks) await step('closed callback', cb);
      }
    })();
    return closing;
  };

  /** Scheduled sends waiting to go out keep the service running (v1.3 B). */
  const sendsPending = (): boolean => {
    try {
      return (scheduled?.pendingCount() ?? 0) > 0;
    } catch (err) {
      log.error(`scheduled sends: ${errorText(err)}`);
      return true; // when unsure, stay: exiting would miss a send
    }
  };
  const timer = setTimer(() => {
    sweepHolds();
    checkScheduled();
    if (liveCount() > 0 || clientCount > 0 || sendsPending()) lastActive = clock();
    else if (clock() - lastActive >= IDLE_EXIT_MS) {
      log.info('idle for 30 minutes, exiting');
      void close();
    }
  }, IDLE_CHECK_MS);
  timer.unref?.();

  // Quit pahub completely (§4.2): stop all work, then the service.
  router.register('service.shutdown', async () => {
    host?.stopAll();
    setImmediate(() => void close());
    return {};
  });

  if (opts.installSignalHandlers ?? true) {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void close());
  }

  log.info(`service started on 127.0.0.1:${wsServer.port}`);
  return {
    port: wsServer.port,
    token,
    router,
    ...(host ? { host } : {}),
    ...(usage ? { usage } : {}),
    ...(scheduled ? { scheduled } : {}),
    broadcast: wsServer.broadcast,
    close,
    onClosed: (cb) => void closedCallbacks.push(cb),
  };
};
