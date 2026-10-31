/**
 * The boundary between pahub and the Claude Agent SDK. Everything else in the
 * service talks to an `AgentAdapter`, so tests can drive sessions with
 * `FakeAdapter` and only `real-adapter.ts` imports SDK runtime code.
 */
import type {
  AccountInfo,
  CanUseTool,
  EffortLevel,
  ModelInfo,
  PermissionMode,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';

export type {
  AccountInfo,
  CanUseTool,
  ModelInfo,
  Options,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SDKSystemMessage,
  SDKUserMessage,
  SessionMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';

export type Effort = EffortLevel;

export type StartOptions = {
  cwd: string;
  /**
   * Session id for a new chat (a UUID chosen by pahub, maps to the SDK's
   * `sessionId` option), so the id is known before the CLI's `system/init`
   * arrives. Never combined with `resume`.
   */
  sessionId?: string;
  resume?: string;
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  env: Record<string, string | undefined>;
  claudePath: string;
  canUseTool: CanUseTool;
};

export type PageOptions = { limit?: number; offset?: number };

// ── v1.2 C1: chat titles ──

/**
 * A one-shot, tool-less question to a model through Claude Code (title
 * generation): one turn, no transcript, no settings loaded.
 */
export type OneShotOptions = {
  prompt: string;
  systemPrompt: string;
  /** A model alias Claude Code's `--model` accepts (e.g. `haiku`) or a model id. */
  model: string;
  cwd: string;
  /** The same environment as the user's sessions (pahub's API key included). */
  env: Record<string, string | undefined>;
  claudePath: string;
  /** Aborts the query (timeout, service shutdown). */
  signal: AbortSignal;
  /**
   * The query's session id (a fresh UUID): its process shows in Claude Code's
   * session list while it runs, and pahub leaves it out of external chats.
   */
  sessionId: string;
};

export interface AgentSession {
  /** Single-consumer stream of everything the SDK emits; ends when the session ends. */
  readonly messages: AsyncIterable<SDKMessage>;
  send(m: SDKUserMessage): void;
  interrupt(): Promise<void>;
  setModel(m?: string): Promise<void>;
  setPermissionMode(m: PermissionMode): Promise<void>;
  /** Stops one task (SDK `Query.stopTask`); its `stopped` task_notification follows in `messages`. */
  stopTask(taskId: string): Promise<void>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  accountInfo(): Promise<AccountInfo>;
  /**
   * v1.3 B: the SDK's experimental usage reading (plan rate-limit windows),
   * unparsed; absent when this SDK does not offer it. Callers parse it
   * leniently and fall back to the rate-limit events on any failure.
   */
  usage?: () => Promise<unknown>;
  close(): void;
}

export interface AgentAdapter {
  start(o: StartOptions): AgentSession;
  listSessions(o?: PageOptions): Promise<SDKSessionInfo[]>;
  getSessionInfo(id: string): Promise<SDKSessionInfo | undefined>;
  getSessionMessages(id: string, o?: PageOptions): Promise<SessionMessage[]>;
  forkSession(id: string, o: { upToMessageId?: string }): Promise<{ sessionId: string }>;
  /** v1.2 C1: the model's answer to a one-shot question; rejects on any failure. */
  oneShot(o: OneShotOptions): Promise<string>;
}
