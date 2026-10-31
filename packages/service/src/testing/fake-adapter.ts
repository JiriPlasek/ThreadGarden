/**
 * In-memory `AgentAdapter` for tests and the mock service. Sessions are driven
 * by the test: `emit()` pushes SDK messages, `requestPermission()` calls the
 * `canUseTool` callback the code under test passed to `start()`, `end()` stops
 * the stream (optionally with an error, like a crashed `claude` process).
 * `stopTask()` only records the call (or rejects with `stopTaskError`); a test
 * emits the resulting `task_notification` itself. `oneShot()` records the
 * request and answers with `oneShotReply` (v1.2 C1).
 */
import { randomUUID } from 'node:crypto';
import type {
  AccountInfo,
  AgentAdapter,
  AgentSession,
  CanUseTool,
  ModelInfo,
  OneShotOptions,
  PageOptions,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
  SlashCommand,
  StartOptions,
} from '../sdk/adapter.js';

type PermissionOptions = Parameters<CanUseTool>[2];

const page = <T>(list: T[], o: PageOptions = {}): T[] => {
  const offset = o.offset ?? 0;
  return list.slice(offset, o.limit === undefined ? undefined : offset + o.limit);
};

export class FakeSession implements AgentSession {
  readonly sent: SDKUserMessage[] = [];
  interrupted = 0;
  readonly stoppedTasks: string[] = [];
  /** When set, `stopTask` rejects with it (after recording the call). */
  stopTaskError: Error | undefined;
  closed = false;
  model: string | undefined;
  permissionMode: PermissionMode | undefined;
  commands: SlashCommand[] = [];
  models: ModelInfo[] = [];
  account: AccountInfo = {};
  /** v1.3 B: the experimental usage reading; absent unless a test (or the mock) sets one. */
  usage?: () => Promise<unknown>;

  private readonly queue: SDKMessage[] = [];
  private waiter: (() => void) | undefined;
  private ended = false;
  private error: Error | undefined;

  readonly messages: AsyncIterable<SDKMessage>;

  constructor(readonly options: StartOptions) {
    this.model = options.model;
    this.permissionMode = options.permissionMode;
    const iterator: AsyncIterator<SDKMessage> = { next: () => this.next() };
    this.messages = { [Symbol.asyncIterator]: () => iterator };
  }

  emit(m: SDKMessage): void {
    if (this.ended) throw new Error('FakeSession.emit after end');
    this.queue.push(m);
    this.wake();
  }

  /** Ends the message stream; with an error the iterator throws it after draining. */
  end(error?: Error): void {
    this.ended = true;
    this.error = error;
    this.wake();
  }

  /**
   * Simulates the SDK asking for permission. Resolves with whatever the code
   * under test's `canUseTool` returns (the SDK type allows `null`).
   */
  requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: Partial<PermissionOptions> = {},
  ): Promise<PermissionResult | null> {
    return this.options.canUseTool(toolName, input, {
      signal: new AbortController().signal,
      toolUseID: randomUUID(),
      requestId: randomUUID(),
      ...opts,
    });
  }

  send(m: SDKUserMessage): void {
    this.sent.push(m);
  }

  async interrupt(): Promise<void> {
    this.interrupted++;
  }

  async setModel(m?: string): Promise<void> {
    this.model = m;
  }

  async setPermissionMode(m: PermissionMode): Promise<void> {
    this.permissionMode = m;
  }

  async stopTask(taskId: string): Promise<void> {
    this.stoppedTasks.push(taskId);
    if (this.stopTaskError) throw this.stopTaskError;
  }

  async supportedCommands(): Promise<SlashCommand[]> {
    return this.commands;
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return this.models;
  }

  async accountInfo(): Promise<AccountInfo> {
    return this.account;
  }

  close(): void {
    this.closed = true;
    this.end();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }

  private async next(): Promise<IteratorResult<SDKMessage>> {
    for (;;) {
      const m = this.queue.shift();
      if (m !== undefined) return { done: false, value: m };
      if (this.ended) {
        const err = this.error;
        this.error = undefined;
        if (err) throw err;
        return { done: true, value: undefined };
      }
      await new Promise<void>((resolve) => (this.waiter = resolve));
    }
  }
}

export class FakeAdapter implements AgentAdapter {
  readonly sessions = new Map<string, { info: SDKSessionInfo; messages: SessionMessage[] }>();
  readonly started: FakeSession[] = [];
  readonly forks: { sessionId: string; upToMessageId?: string; newSessionId: string }[] = [];
  /** v1.2 C1: every `oneShot` request, in order. */
  readonly oneShots: OneShotOptions[] = [];
  /** Answers `oneShot`; by default it fails, as if no model were reachable. */
  oneShotReply: (o: OneShotOptions) => Promise<string> = async () => {
    throw new Error('FakeAdapter: no one-shot reply scripted');
  };

  start(o: StartOptions): FakeSession {
    const s = new FakeSession(o);
    this.started.push(s);
    return s;
  }

  lastSession(): FakeSession {
    const s = this.started.at(-1);
    if (!s) throw new Error('FakeAdapter: no session started');
    return s;
  }

  async listSessions(o?: PageOptions): Promise<SDKSessionInfo[]> {
    const all = [...this.sessions.values()]
      .map((s) => s.info)
      .sort((a, b) => b.lastModified - a.lastModified);
    return page(all, o);
  }

  async getSessionInfo(id: string): Promise<SDKSessionInfo | undefined> {
    return this.sessions.get(id)?.info;
  }

  async getSessionMessages(id: string, o?: PageOptions): Promise<SessionMessage[]> {
    return page(this.sessions.get(id)?.messages ?? [], o);
  }

  async forkSession(id: string, o: { upToMessageId?: string }): Promise<{ sessionId: string }> {
    const src = this.sessions.get(id);
    if (!src) throw new Error(`FakeAdapter: unknown session ${id}`);
    const cut = o.upToMessageId
      ? src.messages.findIndex((m) => m.uuid === o.upToMessageId)
      : src.messages.length - 1;
    if (cut < 0) throw new Error(`FakeAdapter: unknown message ${o.upToMessageId}`);
    const newSessionId = randomUUID();
    this.sessions.set(newSessionId, {
      info: { ...src.info, sessionId: newSessionId, lastModified: Date.now() },
      messages: src.messages.slice(0, cut + 1).map((m) => ({ ...m, session_id: newSessionId })),
    });
    this.forks.push({ sessionId: id, upToMessageId: o.upToMessageId, newSessionId });
    return { sessionId: newSessionId };
  }

  oneShot(o: OneShotOptions): Promise<string> {
    this.oneShots.push(o);
    return this.oneShotReply(o);
  }
}
