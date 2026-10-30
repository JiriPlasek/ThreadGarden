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

export interface AgentSession {
  /** Single-consumer stream of everything the SDK emits; ends when the session ends. */
  readonly messages: AsyncIterable<SDKMessage>;
  send(m: SDKUserMessage): void;
  interrupt(): Promise<void>;
  setModel(m?: string): Promise<void>;
  setPermissionMode(m: PermissionMode): Promise<void>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  accountInfo(): Promise<AccountInfo>;
  close(): void;
}

export interface AgentAdapter {
  start(o: StartOptions): AgentSession;
  listSessions(o?: PageOptions): Promise<SDKSessionInfo[]>;
  getSessionInfo(id: string): Promise<SDKSessionInfo | undefined>;
  getSessionMessages(id: string, o?: PageOptions): Promise<SessionMessage[]>;
  forkSession(id: string, o: { upToMessageId?: string }): Promise<{ sessionId: string }>;
}
