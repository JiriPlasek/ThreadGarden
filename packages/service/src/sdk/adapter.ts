/**
 * Runtime boundary for chats and history. The existing normalized-message contract
 * is Claude-shaped; Codex translates its thread/turn events at this boundary.
 * MultiAdapter dispatches by provider, tests use FakeAdapter, and only
 * real-adapter.ts imports Claude SDK runtime code.
 */
import type {
  AccountInfo,
  CanUseTool,
  EffortLevel,
  ModelInfo as ClaudeModelInfo,
  PermissionMode,
  SDKMessage,
  SDKSessionInfo,
  McpServerStatus,
  SDKUserMessage,
  SessionMessage,
  SessionStore,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import type { Settings, ChatHeaderInfo } from '@threadgarden/protocol';
import type { ExternalSession } from '../external/poller.js';

export type {
  AccountInfo,
  CanUseTool,
  McpServerStatus,
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
  SessionStore,
  SessionStoreEntry,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';

/** Reasoning labels are provider-owned (Codex also offers none/minimal and future levels). */
export type Effort = string;
export type ModelInfo = Omit<ClaudeModelInfo, 'supportedEffortLevels'> & {
  supportedEffortLevels?: string[];
  /** The model its runtime uses when none is named (Codex's catalog and config). */
  isDefault?: boolean;
};
export const CLAUDE_EFFORT_LEVELS: readonly EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export type StartOptions = {
  cwd: string;
  /**
   * Session id for a new chat (a UUID chosen by Threadgarden, maps to the SDK's
   * `sessionId` option), so the id is known before the CLI's `system/init`
   * arrives. Never combined with `resume`.
   */
  sessionId?: string;
  resume?: string;
  /**
   * With `resume`: the store a moved chat lives in (`move/store.ts`). The SDK
   * reads the transcript from it and mirrors the new turns back into it.
   */
  sessionStore?: SessionStore;
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  /** The "Suggest my next reply" setting: the SDK's `promptSuggestions`, only when true. */
  promptSuggestions?: boolean;
  env: Record<string, string | undefined>;
  claudePath: string;
  canUseTool: CanUseTool;
};

export type PageOptions = { limit?: number; offset?: number };

/**
 * Where a session's history is read. Empty: Claude Code's local transcripts
 * (all projects). A chat moved here: Threadgarden's store, with `dir` its
 * folder on this machine.
 */
export type HistoryOptions = { dir?: string; sessionStore?: SessionStore };

/** Which local transcript `importSession` copies (SDK `importSessionToStore`). */
export type ImportOptions = { dir?: string; includeSubagents: boolean };

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
  /** The same environment as the user's sessions (Threadgarden's API key included). */
  env: Record<string, string | undefined>;
  claudePath: string;
  /** Aborts the query (timeout, service shutdown). */
  signal: AbortSignal;
  /**
   * The query's session id (a fresh UUID): its process shows in Claude Code's
   * session list while it runs, and Threadgarden leaves it out of external chats.
   */
  sessionId: string;
};

/**
 * Protocol 12: a Claude session's MCP servers. The auth methods pass sign-in
 * links and callback URLs through; callers never store or log them.
 */
export interface McpControls {
  status(): Promise<McpServerStatus[]>;
  reconnect(name: string): Promise<void>;
  toggle(name: string, enabled: boolean): Promise<void>;
  authenticate(name: string, redirectUri?: string): Promise<unknown>;
  submitCallback(name: string, callbackUrl: string): Promise<unknown>;
  clearAuth(name: string): Promise<unknown>;
}

/**
 * Protocol 14: signing in to Claude. Results pass sign-in links through;
 * callers never store or log them or the codes.
 */
export interface LoginControls {
  /** claude_authenticate with `loginWithClaudeAi: true`. */
  start(): Promise<unknown>;
  /** claude_oauth_callback. */
  submit(code: string, state: string): Promise<unknown>;
  /** claude_oauth_wait_for_completion. */
  wait(): Promise<unknown>;
}

export interface AgentSession {
  /** Single-consumer stream of everything the SDK emits; ends when the session ends. */
  readonly messages: AsyncIterable<SDKMessage>;
  send(m: SDKUserMessage): void;
  /**
   * Stops the running turn and cancels every message still queued, as the
   * terminal's Esc does: each gets a `cancelled` `command_lifecycle` frame.
   * (A Claude Code without the `interrupt_cancel_queued_v1` capability keeps
   * them, and they run next.)
   */
  interrupt(): Promise<void>;
  /**
   * Takes back a message Claude has not taken up yet, by the uuid it was sent
   * under: true when it was still queued (its `cancelled` frame comes before
   * this resolves), false when a turn already has it.
   */
  cancelQueued(uuid: string): Promise<boolean>;
  setModel(m?: string): Promise<void>;
  setPermissionMode(m: PermissionMode): Promise<void>;
  /** Runtimes with a native reasoning control use it instead of a Claude slash command. */
  setEffort?(effort: Effort): Promise<void>;
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
  /** Claude sessions only (Codex has none). */
  readonly mcp?: McpControls;
  /** Claude sessions only (Codex has none). */
  readonly login?: LoginControls;
  close(): void;
}

export interface AgentAdapter {
  configure?(settings: Settings): void;
  externalSessions?(): Promise<ExternalSession[]>;
  dispose?(): void;
  getSessionHeader?(sessionId: string): Promise<ChatHeaderInfo>;
  codexInfo?(): { path: string; home: string; historyProblem?: string };
  /** Optional provider catalog, also available before any session is running. */
  models?(): Promise<ModelInfo[]>;
  /** Checks an alternative runtime without requiring Claude installation or authentication. */
  requireCodex?(): Promise<void>;
  resumeCommand?(sessionId: string): Promise<string | undefined>;
  start(o: StartOptions): AgentSession;
  listSessions(o?: PageOptions & HistoryOptions): Promise<SDKSessionInfo[]>;
  /** Histories without a filesystem watcher, refreshed separately from watched history. */
  listPolledSessions?(): Promise<SDKSessionInfo[]>;
  getSessionInfo(id: string, o?: HistoryOptions): Promise<SDKSessionInfo | undefined>;
  getSessionMessages(id: string, o?: PageOptions & HistoryOptions): Promise<SessionMessage[]>;
  forkSession(id: string, o: { upToMessageId?: string }): Promise<{ sessionId: string }>;
  /**
   * Protocol 9: copies a chat's local transcript (and its subagents') into
   * `store` (a move's export). Only reads Claude Code's files.
   */
  importSession(id: string, store: SessionStore, o: ImportOptions): Promise<void>;
  /** v1.2 C1: the model's answer to a one-shot question; rejects on any failure. */
  oneShot(o: OneShotOptions): Promise<string>;
}
