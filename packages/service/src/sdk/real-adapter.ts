/**
 * `AgentAdapter` over the real Claude Agent SDK — the only module that calls
 * SDK runtime code. Each session is one `query()` in streaming-input mode:
 * `send()` pushes `SDKUserMessage`s into an input queue the SDK reads from,
 * and the process lives until `close()` ends that queue.
 *
 * Startup failures (§6.4) reach the host as a zeroed `error_during_execution`
 * result carrying `startup_failure_reason` in the message stream; the env flag
 * set here makes the CLI write that result for every known cause, and
 * `LiveSession` maps it with `startupFailureMessage`.
 */
import {
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AccountInfo,
  AgentAdapter,
  AgentSession,
  ModelInfo,
  Options,
  PageOptions,
  PermissionMode,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
  SlashCommand,
  StartOptions,
} from './adapter.js';

/** The SDK functions the adapter uses; injectable so tests need no `claude` process. */
export type SdkApi = {
  query: typeof query;
  listSessions: typeof listSessions;
  getSessionInfo: typeof getSessionInfo;
  getSessionMessages: typeof getSessionMessages;
  forkSession: typeof forkSession;
};

const realSdk: SdkApi = { query, listSessions, getSessionInfo, getSessionMessages, forkSession };

/**
 * The environment for a session's `claude` process. The SDK's `env` option
 * replaces the inherited environment, so `base` is copied whole (PATH, HOME,
 * proxies, an inherited key…); pahub's own API key (§5.5) is added only when set.
 */
export const buildSessionEnv = (
  base: NodeJS.ProcessEnv,
  apiKey: string | null,
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...base };
  if (apiKey !== null) env.ANTHROPIC_API_KEY = apiKey;
  return env;
};

/**
 * SDK options for a session started by pahub (Global Constraints). User text
 * is never `client_composed` / `verbatimPrompts`, so `@path` mentions and
 * `/commands` behave as in the CLI. `resume` and `sessionId` are exclusive
 * in the SDK (without `forkSession`); when resuming, the resumed id is the
 * session id.
 */
export const buildQueryOptions = (o: StartOptions): Options => {
  const opts: Options = {
    cwd: o.cwd,
    pathToClaudeCodeExecutable: o.claudePath,
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    includePartialMessages: true,
    canUseTool: o.canUseTool,
    env: { ...o.env, CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' },
  };
  if (o.resume !== undefined) opts.resume = o.resume;
  else if (o.sessionId !== undefined) opts.sessionId = o.sessionId;
  if (o.model !== undefined) opts.model = o.model;
  if (o.effort !== undefined) opts.effort = o.effort;
  if (o.permissionMode !== undefined) opts.permissionMode = o.permissionMode;
  return opts;
};

/** Unbounded single-consumer queue the SDK reads user messages from. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | undefined;
  private done = false;

  push(m: SDKUserMessage): void {
    if (this.done) return;
    const w = this.waiter;
    if (w) {
      this.waiter = undefined;
      w({ done: false, value: m });
    } else {
      this.items.push(m);
    }
  }

  end(): void {
    this.done = true;
    this.items.length = 0;
    const w = this.waiter;
    this.waiter = undefined;
    w?.({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m !== undefined) return Promise.resolve({ done: false, value: m });
        if (this.done) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => (this.waiter = resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

type Query = ReturnType<typeof query>;

class RealSession implements AgentSession {
  private closed = false;

  constructor(
    private readonly q: Query,
    private readonly input: InputQueue,
  ) {}

  get messages(): AsyncIterable<SDKMessage> {
    return this.q;
  }

  send(m: SDKUserMessage): void {
    this.input.push(m);
  }

  async interrupt(): Promise<void> {
    await this.q.interrupt();
  }

  setModel(m?: string): Promise<void> {
    return this.q.setModel(m);
  }

  setPermissionMode(m: PermissionMode): Promise<void> {
    return this.q.setPermissionMode(m);
  }

  supportedCommands(): Promise<SlashCommand[]> {
    return this.q.supportedCommands();
  }

  supportedModels(): Promise<ModelInfo[]> {
    return this.q.supportedModels();
  }

  accountInfo(): Promise<AccountInfo> {
    return this.q.accountInfo();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.end();
    this.q.close();
  }
}

/** Copies only the paging keys that are set (no `dir`: pahub reads all projects). */
const paging = (o: PageOptions = {}): PageOptions => ({
  ...(o.limit === undefined ? {} : { limit: o.limit }),
  ...(o.offset === undefined ? {} : { offset: o.offset }),
});

export class RealAdapter implements AgentAdapter {
  constructor(private readonly sdk: SdkApi = realSdk) {}

  start(o: StartOptions): AgentSession {
    const input = new InputQueue();
    const q = this.sdk.query({ prompt: input, options: buildQueryOptions(o) });
    return new RealSession(q, input);
  }

  listSessions(o?: PageOptions): Promise<SDKSessionInfo[]> {
    return this.sdk.listSessions(paging(o));
  }

  getSessionInfo(id: string): Promise<SDKSessionInfo | undefined> {
    return this.sdk.getSessionInfo(id);
  }

  getSessionMessages(id: string, o?: PageOptions): Promise<SessionMessage[]> {
    return this.sdk.getSessionMessages(id, paging(o));
  }

  forkSession(id: string, o: { upToMessageId?: string }): Promise<{ sessionId: string }> {
    return this.sdk.forkSession(
      id,
      o.upToMessageId === undefined ? {} : { upToMessageId: o.upToMessageId },
    );
  }
}
