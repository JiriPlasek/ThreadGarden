import type { ExternalSession } from '../external/poller.js';
import os from 'node:os';
import path from 'node:path';
import type { SDKSessionInfo, SessionMessage } from './adapter.js';
import {
  connectCodex,
  connectSharedCodex,
  initializeCodex,
  type CodexConnection,
  type ConnectCodex,
} from './codex-client.js';
import { millis, rec, str, turnMessages, type Rec } from './codex-events.js';
import { CodexStore, type CodexRecord } from './codex-store.js';

const SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'unknown'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A metadata-only connection is reused during indexing, then released when idle. */
export class CodexHistory {
  private client?: CodexConnection;
  private ready?: Promise<CodexConnection>;
  private idle?: ReturnType<typeof setTimeout>;
  private users = 0;
  historyProblem?: string;
  private externalRetryAt = 0;
  private externalProblem?: Error;
  constructor(
    private readonly store: CodexStore,
    private env: () => NodeJS.ProcessEnv,
    private readonly connect: ConnectCodex = connectCodex,
    private readonly shared: ConnectCodex = connectSharedCodex,
  ) {}
  setEnvironment(env: () => NodeJS.ProcessEnv): void {
    this.close();
    this.externalRetryAt = 0;
    this.env = env;
  }

  close(): void {
    clearTimeout(this.idle);
    this.ready = undefined;
    const client = this.client;
    this.client = undefined;
    client?.close();
  }
  private async use<T>(run: (client: CodexConnection) => Promise<T>): Promise<T> {
    clearTimeout(this.idle);
    this.users++;
    try {
      this.ready ??= (async () => {
        const client = this.connect(
          this.env(),
          () => {},
          () => {
            if (this.client === client) {
              this.client = undefined;
              this.ready = undefined;
            }
          },
        );
        this.client = client;
        try {
          await this.initialize(client);
          return client;
        } catch (error) {
          this.close();
          throw error;
        }
      })();
      return await run(await this.ready);
    } finally {
      if (--this.users === 0) this.idle = setTimeout(() => this.close(), 15_000).unref();
    }
  }

  private async initialize(client: CodexConnection): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        initializeCodex(client),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Codex history connection timed out')), 5_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private home(): string {
    return this.env().CODEX_HOME || path.join(os.homedir(), '.codex');
  }
  private async inHome<T>(
    home: string | undefined,
    run: (client: CodexConnection) => Promise<T>,
  ): Promise<T> {
    if (!home || home === this.home()) return this.use(run);
    const client = this.connect(
      { ...this.env(), CODEX_HOME: home },
      () => {},
      () => {},
    );
    try {
      await this.initialize(client);
      return await run(client);
    } finally {
      client.close();
    }
  }

  private remember(thread: Rec, home = this.home()): CodexRecord {
    const threadId = str(thread.id);
    if (!uuid.test(threadId)) throw new Error('Codex returned an invalid thread id');
    const own = this.store.recordForThread(threadId);
    const record: CodexRecord = own ?? {
      id: `codex-${threadId}`,
      threadId,
      cwd: str(thread.cwd),
      createdAt: millis(thread.createdAt),
      updatedAt: millis(thread.updatedAt),
      native: true,
      preservePermissions: true,
    };
    record.cwd = str(thread.cwd) || record.cwd;
    record.firstPrompt = str(thread.preview) || record.firstPrompt;
    record.title = str(thread.name) || undefined;
    record.updatedAt = Math.max(record.updatedAt, millis(thread.updatedAt));
    record.native = true;
    record.home = home;
    record.historyMode = str(thread.historyMode) || record.historyMode;
    record.nativePath = str(thread.path) || record.nativePath;
    record.modelProvider = str(thread.modelProvider) || record.modelProvider;
    record.runtimeVersion = str(thread.cliVersion) || record.runtimeVersion;
    if (thread.model) record.model = `codex:${str(thread.model)}`;
    if (thread.reasoningEffort) record.effort = str(thread.reasoningEffort);
    this.store.save(record);
    return record;
  }

  async list(): Promise<SDKSessionInfo[]> {
    try {
      return await this.use(async (client) => {
        const ids = new Set<string>();
        for (const archived of [false, true]) {
          let cursor: string | undefined;
          const seen = new Set<string>();
          do {
            const result = await client.request('thread/list', {
              limit: 100,
              modelProviders: [],
              sourceKinds: SOURCES,
              archived,
              useStateDbOnly: true,
              ...(cursor ? { cursor } : {}),
            });
            for (const value of Array.isArray(result.data) ? result.data : []) {
              const thread = rec(value);
              if (thread.ephemeral === true || thread.parentThreadId || !uuid.test(str(thread.id)))
                continue;
              const record = this.remember(thread);
              ids.add(record.id);
            }
            cursor = str(result.nextCursor) || undefined;
            if (cursor && seen.has(cursor)) throw new Error('Codex repeated a history cursor');
            if (cursor) seen.add(cursor);
          } while (cursor);
        }
        // Locally created chats may not be materialized by Codex until their first turn starts.
        for (const record of this.store.records())
          if (!record.native || record.createdHere) ids.add(record.id);
        return [...ids]
          .map((id) => this.store.info(id))
          .filter((info): info is SDKSessionInfo => !!info);
      }).then((infos) => {
        this.historyProblem = undefined;
        return infos;
      });
    } catch (error) {
      this.historyProblem = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async info(id: string): Promise<SDKSessionInfo | undefined> {
    const record = this.store.read(id);
    if (!record?.threadId || !record.native) return this.store.info(id);
    return this.inHome(record.home, async (client) => {
      const result = await client.request('thread/read', { threadId: record.threadId });
      this.remember(rec(result.thread), record.home);
      return this.store.info(id);
    });
  }

  async messages(id: string): Promise<SessionMessage[]> {
    const record = this.store.read(id);
    if (!record?.threadId || !record.native) return this.store.messages(id);
    return this.inHome(record.home, async (client) => {
      const result = await client.request('thread/read', { threadId: record.threadId });
      const thread = rec(result.thread);
      this.remember(thread, record.home);
      let turns: unknown[] = [];
      if (thread.historyMode === 'paginated' || record.historyMode === 'paginated') {
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await client.request('thread/turns/list', {
            threadId: record.threadId,
            limit: 100,
            sortDirection: 'asc',
            itemsView: 'full',
            ...(cursor ? { cursor } : {}),
          });
          turns.push(...(Array.isArray(page.data) ? page.data : []));
          cursor = str(page.nextCursor) || undefined;
          if (cursor && seen.has(cursor)) throw new Error('Codex repeated a turns cursor');
          if (cursor) seen.add(cursor);
        } while (cursor);
      } else {
        const history = await client.request('thread/read', {
          threadId: record.threadId,
          includeTurns: true,
        });
        turns = Array.isArray(rec(history.thread).turns)
          ? (rec(history.thread).turns as unknown[])
          : [];
      }
      const native = turns.flatMap((turn) =>
        turnMessages(id, rec(turn), record.model?.replace(/^codex:/, '')),
      );
      const journal = this.store.messages(id);
      const byId = new Map<string, SessionMessage>();
      for (const message of [...native, ...journal]) byId.set(message.uuid, message);
      return [...byId.values()].sort(
        (a, b) => Date.parse(str(rec(a).timestamp)) - Date.parse(str(rec(b).timestamp)),
      );
    });
  }

  async external(): Promise<ExternalSession[]> {
    if (Date.now() < this.externalRetryAt) throw this.externalProblem;
    const client = this.shared(
      this.env(),
      () => {},
      () => {},
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        initializeCodex(client),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Codex shared runtime is unavailable')), 3_000);
        }),
      ]);
      const sessions: ExternalSession[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const loaded = await client.request('thread/loaded/list', {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const value of Array.isArray(loaded.data) ? loaded.data : []) {
          const threadId = str(value);
          if (!uuid.test(threadId)) continue;
          const result = await client.request('thread/read', { threadId });
          const thread = rec(result.thread);
          if (thread.parentThreadId) continue;
          const record = this.remember(thread);
          const status = rec(thread.status);
          if (status.type === 'notLoaded') continue;
          const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
          sessions.push({
            sessionId: record.id,
            cwd: record.cwd,
            kind: 'codex',
            startedAt: millis(thread.updatedAt) || record.createdAt,
            status:
              status.type === 'active'
                ? flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')
                  ? 'waiting'
                  : 'busy'
                : status.type === 'idle'
                  ? 'idle'
                  : 'unknown',
            ...(flags.includes('waitingOnApproval')
              ? { waitingFor: 'Approve a Codex action' }
              : {}),
            name: str(thread.name) || record.firstPrompt,
            raw: thread,
          });
        }
        cursor = str(loaded.nextCursor) || undefined;
        if (cursor && seen.has(cursor)) throw new Error('Codex repeated a runtime cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
      this.externalProblem = undefined;
      this.externalRetryAt = 0;
      return sessions;
    } catch (error) {
      this.externalProblem = error instanceof Error ? error : new Error(String(error));
      this.externalRetryAt = Date.now() + 30_000;
      throw error;
    } finally {
      clearTimeout(timer);
      client.close();
    }
  }
}
