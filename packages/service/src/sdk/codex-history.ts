import type { ExternalSession } from '../external/poller.js';
import os from 'node:os';
import path from 'node:path';
import type { SDKSessionInfo, SessionMessage } from './adapter.js';
import {
  connectCodex,
  CodexNotFoundError,
  connectSharedCodex,
  initializeCodex,
  type CodexConnection,
  type ConnectCodex,
} from './codex-client.js';
import { envelope, finite, millis, rec, str, turnMessages, type Rec } from './codex-events.js';
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
  /** The shared-runtime connection the external poll reuses while it keeps polling. */
  private sharedClient?: CodexConnection;
  private sharedReady?: Promise<CodexConnection>;
  private sharedIdle?: ReturnType<typeof setTimeout>;
  private externalPass?: Promise<ExternalSession[]>;
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
    this.closeIndex();
    this.closeShared();
  }
  private closeIndex(): void {
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
          this.closeIndex();
          throw error;
        }
      })();
      return await run(await this.ready);
    } finally {
      if (--this.users === 0) this.idle = setTimeout(() => this.closeIndex(), 15_000).unref();
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
    // A live chat holds this same record object: fields it chooses must survive a poll.
    const own = this.store.recordForThread(threadId);
    const before = own && JSON.stringify(own);
    // Codex's model and effort win for a new import, or after the thread was used in Codex
    // itself since Threadgarden last touched it; otherwise a choice made here stands.
    const usedElsewhere = !own || millis(thread.updatedAt) > own.updatedAt;
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
    if (usedElsewhere && thread.model) record.model = `codex:${str(thread.model)}`;
    if (usedElsewhere && thread.reasoningEffort) record.effort = str(thread.reasoningEffort);
    // Polls repeat the same answer; rewriting every record each time is wasted disk churn.
    if (JSON.stringify(record) !== before) this.store.save(record);
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
        // Chats imported from an earlier Codex home stay too: this listing only sees the current one.
        const home = this.home();
        for (const record of this.store.records())
          if (!record.native || record.createdHere || (record.home && record.home !== home))
            ids.add(record.id);
        return [...ids]
          .map((id) => this.store.info(id))
          .filter((info): info is SDKSessionInfo => !!info);
      }).then((infos) => {
        this.historyProblem = undefined;
        return infos;
      });
    } catch (error) {
      // No Codex CLI is the normal state for a Claude-only user, not a problem to report;
      // keeping every known chat listed stops the index from removing them meanwhile.
      if (error instanceof CodexNotFoundError) {
        this.historyProblem = undefined;
        return this.store.list();
      }
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
      const turns = await this.turns(client, record, thread);
      const native = turns.flatMap((turn) =>
        turnMessages(id, rec(turn), record.model?.replace(/^codex:/, '')),
      );
      native.push(...(await this.descendants(client, id, record.threadId!, turns)));
      const journal = this.store.messages(id);
      const byId = new Map<string, SessionMessage>();
      for (const message of [...native, ...journal]) byId.set(message.uuid, message);
      return [...byId.values()].sort(
        (a, b) => Date.parse(str(rec(a).timestamp)) - Date.parse(str(rec(b).timestamp)),
      );
    });
  }

  /** Follow only explicit spawn ownership, with bounded work even for malformed trees. */
  private async descendants(
    client: CodexConnection,
    id: string,
    root: string,
    turns: unknown[],
  ): Promise<SessionMessage[]> {
    const messages: SessionMessage[] = [];
    const seen = new Set([root]);
    const notices = new Set<string>();
    const notice = (key: string, parentTool: string | undefined, text: string): void => {
      if (notices.has(key)) return;
      notices.add(key);
      messages.push(
        envelope(id, `${root}-child-history-${key}`, {
          type: 'system',
          subtype: 'informational',
          level: 'warning',
          content: text,
          ...(parentTool ? { parent_tool_use_id: parentTool } : {}),
        }) as SessionMessage,
      );
    };
    const walk = async (
      parent: string,
      history: unknown[],
      depth: number,
      enclosingTool?: string,
    ): Promise<void> => {
      const spawns = new Map<string, { toolId: string; model?: string }>();
      for (const turn of history)
        for (const value of Array.isArray(rec(turn).items) ? (rec(turn).items as unknown[]) : []) {
          const item = rec(value);
          const toolId = str(item.id);
          const children =
            item.type === 'subAgentActivity' && item.kind === 'started'
              ? [item.agentThreadId]
              : item.type === 'collabAgentToolCall' &&
                  item.tool === 'spawnAgent' &&
                  Array.isArray(item.receiverThreadIds)
                ? item.receiverThreadIds
                : [];
          if (!toolId) continue;
          for (const value of children) {
            const child = str(value);
            if (uuid.test(child) && !spawns.has(child))
              spawns.set(child, { toolId, model: str(item.model) || undefined });
          }
        }
      for (const [childId, spawn] of spawns) {
        if (seen.has(childId)) continue;
        if (depth >= 8 || seen.size >= 33) {
          notice(
            'limit',
            enclosingTool,
            'Some Codex agent history was omitted because the history traversal limit was reached.',
          );
          continue;
        }
        seen.add(childId);
        try {
          const result = await client.request('thread/read', { threadId: childId });
          const child = rec(result.thread);
          const legacyParent = str(
            rec(rec(rec(child.source).subAgent).thread_spawn).parent_thread_id,
          );
          if (
            str(child.id) !== childId ||
            (child.parentThreadId && child.parentThreadId !== parent) ||
            (legacyParent && legacyParent !== parent)
          ) {
            notice(
              childId,
              spawn.toolId,
              'This Codex agent history is unavailable because its native ownership metadata does not match.',
            );
            continue;
          }
          const record: CodexRecord = {
            id,
            threadId: childId,
            cwd: '',
            createdAt: 0,
            updatedAt: 0,
          };
          const childTurns = await this.turns(client, record, child, 10, () =>
            notice(
              childId,
              spawn.toolId,
              'This Codex agent history is truncated because its page limit was reached.',
            ),
          );
          const model = str(child.model) || spawn.model;
          for (const turn of childTurns)
            for (const message of turnMessages(id, rec(turn), model)) {
              if (rec(message).type === 'result') continue;
              messages.push({
                ...message,
                parent_tool_use_id: spawn.toolId,
                parent_agent_id: childId,
              } as SessionMessage);
            }
          await walk(childId, childTurns, depth + 1, spawn.toolId);
        } catch (error) {
          notice(
            childId,
            spawn.toolId,
            `This Codex agent history is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      // Modern lifecycle events identify the original spawn by thread rather than tool id.
      for (const turn of history)
        for (const value of Array.isArray(rec(turn).items) ? (rec(turn).items as unknown[]) : []) {
          const item = rec(value);
          const spawn = spawns.get(str(item.agentThreadId));
          if (
            !spawn ||
            item.type !== 'subAgentActivity' ||
            !['completed', 'failed', 'interrupted'].includes(str(item.kind))
          )
            continue;
          messages.push(
            envelope(
              id,
              `${spawn.toolId}-result`,
              {
                type: 'user',
                ...(enclosingTool ? { parent_tool_use_id: enclosingTool } : {}),
                ...(parent !== root ? { parent_agent_id: parent } : {}),
                message: {
                  role: 'user',
                  content: [
                    {
                      type: 'tool_result',
                      tool_use_id: spawn.toolId,
                      content: `Codex agent ${str(item.kind)}`,
                      is_error: item.kind === 'failed',
                    },
                  ],
                },
              },
              finite(item.completedAtMs) ??
                finite(item.startedAtMs) ??
                millis(rec(turn).completedAt),
            ) as SessionMessage,
          );
        }
    };
    await walk(root, turns, 0);
    return messages;
  }

  private async turns(
    client: CodexConnection,
    record: CodexRecord,
    thread: Rec,
    maxPages = Number.POSITIVE_INFINITY,
    onLimit?: () => void,
  ): Promise<unknown[]> {
    let turns: unknown[] = [];
    if (thread.historyMode === 'paginated' || record.historyMode === 'paginated') {
      let cursor: string | undefined;
      const seen = new Set<string>();
      let pages = 0;
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
        if (++pages >= maxPages) {
          if (cursor) onLimit?.();
          break;
        }
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
    return turns;
  }

  /** The UI explicitly offers to fork through the selected message's whole turn. */
  async fork(id: string, options: { upToMessageId?: string }): Promise<{ sessionId: string }> {
    const source = this.store.read(id);
    if (!source?.threadId) throw new Error('No saved Codex thread to fork');
    return this.inHome(source.home, async (client) => {
      let lastTurnId: string | undefined;
      if (options.upToMessageId) {
        const result = await client.request('thread/read', { threadId: source.threadId });
        const turns = await this.turns(client, source, rec(result.thread));
        for (const value of turns) {
          const turn = rec(value);
          const messages = turnMessages(id, turn).filter(
            (message) => rec(message).type !== 'result',
          );
          if (
            turn.status === 'completed' &&
            messages.some((message) => message.uuid === options.upToMessageId)
          )
            lastTurnId = str(turn.id) || undefined;
        }
        if (!lastTurnId)
          throw new Error('Choose a message in a completed Codex turn to fork this chat.');
      }
      const result = await client.request('thread/fork', {
        threadId: source.threadId,
        ...(source.modelProvider ? { modelProvider: source.modelProvider } : {}),
        ...(source.model ? { model: source.model.replace(/^codex:/, '') } : {}),
        ...(lastTurnId ? { lastTurnId } : {}),
        excludeTurns: true,
      });
      const thread = rec(result.thread);
      if (str(thread.id) === source.threadId) throw new Error('Codex did not create a new thread');
      const fork = this.remember(thread, source.home);
      fork.createdHere = true;
      fork.preservePermissions = true;
      if (result.model) fork.model = `codex:${str(result.model)}`;
      if (result.reasoningEffort) fork.effort = str(result.reasoningEffort);
      if (result.modelProvider) fork.modelProvider = str(result.modelProvider);
      this.store.save(fork);
      return { sessionId: fork.id };
    });
  }

  /** Overlapping callers (the poll and an on-demand check) share one pass. */
  external(): Promise<ExternalSession[]> {
    if (Date.now() < this.externalRetryAt) return Promise.reject(this.externalProblem);
    return (this.externalPass ??= this.readExternal().finally(() => {
      this.externalPass = undefined;
    }));
  }

  private closeShared(): void {
    clearTimeout(this.sharedIdle);
    this.sharedReady = undefined;
    const client = this.sharedClient;
    this.sharedClient = undefined;
    client?.close();
  }

  /** One `app-server proxy` serves every poll; it closes once polls stop for 15 seconds. */
  private sharedConnection(): Promise<CodexConnection> {
    clearTimeout(this.sharedIdle);
    this.sharedReady ??= (async () => {
      const client = this.shared(
        this.env(),
        () => {},
        () => {
          if (this.sharedClient === client) {
            this.sharedClient = undefined;
            this.sharedReady = undefined;
          }
        },
      );
      this.sharedClient = client;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          initializeCodex(client),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Codex shared runtime is unavailable')),
              3_000,
            );
          }),
        ]);
        return client;
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.sharedReady;
  }

  private async readExternal(): Promise<ExternalSession[]> {
    try {
      const client = await this.sharedConnection();
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
      this.sharedIdle = setTimeout(() => this.closeShared(), 15_000).unref();
      return sessions;
    } catch (error) {
      this.closeShared();
      this.externalProblem = error instanceof Error ? error : new Error(String(error));
      this.externalRetryAt = Date.now() + 30_000;
      throw error;
    }
  }
}
