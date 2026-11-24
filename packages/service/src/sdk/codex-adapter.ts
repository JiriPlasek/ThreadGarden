import { CODEX_COMMANDS, codexCommand, isBareCompact } from './codex-commands.js';
/** Codex's thread/turn protocol translated at the existing chat event boundary. */
import { codexOneShot } from './codex-one-shot.js';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {
  AccountInfo,
  AgentSession,
  Effort,
  ModelInfo,
  OneShotOptions,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
  StartOptions,
} from './adapter.js';
import {
  CodexRpcError,
  connectCodex,
  initializeCodex,
  type CodexConnection,
  type ConnectCodex,
  type RpcMessage,
} from './codex-client.js';
import { CodexStore, type CodexRecord } from './codex-store.js';
import { codexModel } from './providers.js';
import { CodexHistory } from './codex-history.js';
import { codexTokens, codexUsage } from './codex-usage.js';
import { itemMessages, rec, str, type Rec } from './codex-events.js';
import { CodexTasks } from './codex-tasks.js';

/** Explicit equivalents of the supported UI modes. Do not silently reinterpret Claude-only modes. */
export const codexPermissions = (
  mode: string = 'default',
): {
  approvalPolicy: string;
  sandbox: string;
  sandboxPolicy: Rec;
  approvalsReviewer?: string;
} => {
  switch (mode) {
    case 'bypassPermissions':
      return {
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        sandboxPolicy: { type: 'dangerFullAccess' },
      };
    case 'default':
    case 'plan':
      return {
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      };
    case 'acceptEdits':
    case 'auto':
      return {
        approvalPolicy: 'on-request',
        ...(mode === 'auto' ? { approvalsReviewer: 'auto_review' } : {}),
        sandbox: 'workspace-write',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
    default:
      throw new Error(`Codex does not support permission mode "${mode}".`);
  }
};

class MessageQueue implements AsyncIterable<SDKMessage> {
  private items: SDKMessage[] = [];
  private wake?: () => void;
  private ended = false;
  private error?: Error;
  push(message: SDKMessage): void {
    if (!this.ended) {
      this.items.push(message);
      this.wake?.();
    }
  }
  end(error?: Error): void {
    this.ended = true;
    this.error ??= error;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    while (true) {
      const item = this.items.shift();
      if (item) {
        yield item;
        continue;
      }
      if (this.ended) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

export class CodexSession implements AgentSession {
  readonly messages = new MessageQueue();
  private client: CodexConnection;
  private ready: Promise<void>;
  private closed = false;
  private activeTurn?: string;
  private compacting = false;
  private starting = false;
  private stopping = false;
  private steeringBlockedTurn?: string;
  private completedWhileStarting = false;
  private inputs: SDKUserMessage[] = [];
  private submitted = new Map<
    SDKUserMessage,
    { turnId: string; settled: boolean; completed: boolean }
  >();
  private streamed = new Map<string, string>();
  private tools = new Set<string>();
  private output = new Map<string, string>();
  private reasoning = new Map<string, Map<number, string>>();
  private children = new Map<
    string,
    {
      parent: string;
      toolId?: string;
      model?: string;
      terminal: boolean;
      activityId?: string;
      runId?: string;
      buffered: RpcMessage[];
    }
  >();
  private childCapacityNotified = false;
  private taskRun = 0;
  private context?: { parent_tool_use_id: string; parent_agent_id: string; codex_turn_id?: string };
  private streamContexts = new Map<string, typeof this.context>();
  private approvals = new Map<number | string, AbortController>();
  private approvalThreads = new Map<number | string, string>();
  private turnUsage?: Rec;
  private previousUsageTotal?: Rec;
  private nativeCollaboration?: Rec;
  private lastAssistant?: { id: string; content: Rec[] };
  private taskSource?: CodexTasks;

  constructor(
    private readonly options: StartOptions,
    private readonly record: CodexRecord,
    private readonly store: CodexStore,
    connect: ConnectCodex,
  ) {
    if (!record.preservePermissions) codexPermissions(record.permissionMode);
    this.client = connect(
      options.env,
      (message) => this.onMessage(message),
      (error) => this.fail(error),
    );
    this.ready = this.initialize();
    void this.ready.catch((error: unknown) => this.fail(error));
  }

  private async initialize(): Promise<void> {
    await initializeCodex(this.client);
    const policy = codexPermissions(this.record.permissionMode);
    const result = await this.client.request(
      this.record.threadId ? 'thread/resume' : 'thread/start',
      {
        ...(this.record.threadId ? { threadId: this.record.threadId } : {}),
        ...(this.record.modelProvider ? { modelProvider: this.record.modelProvider } : {}),
        cwd: this.record.cwd,
        ...(codexModel(this.record.model) ? { model: codexModel(this.record.model) } : {}),
        ...(!this.record.preservePermissions
          ? {
              approvalPolicy: policy.approvalPolicy,
              sandbox: policy.sandbox,
              ...(policy.approvalsReviewer ? { approvalsReviewer: policy.approvalsReviewer } : {}),
            }
          : {}),
        ...(this.record.threadId ? { excludeTurns: true } : {}),
      },
    );
    this.record.threadId = str(rec(result.thread).id);
    if (!this.record.threadId) throw new Error('Codex returned no thread id');
    if (/^[0-9a-f-]{36}$/.test(this.record.threadId)) this.record.native = true;
    this.record.historyMode = str(rec(result.thread).historyMode) || this.record.historyMode;
    this.record.runtimeVersion = str(rec(result.thread).cliVersion) || this.record.runtimeVersion;
    this.record.modelProvider = str(result.modelProvider) || this.record.modelProvider;
    if (this.record.preservePermissions) {
      if (result.collaborationMode) this.nativeCollaboration = rec(result.collaborationMode);
      const sandbox = rec(result.sandbox);
      const approval = result.approvalPolicy;
      this.record.effort = str(result.reasoningEffort) || this.record.effort;
      this.record.permissionMode =
        rec(result.collaborationMode).mode === 'plan'
          ? 'plan'
          : ['auto_review', 'guardian_subagent', 'guardian'].includes(str(result.approvalsReviewer))
            ? 'auto'
            : sandbox.type === 'dangerFullAccess' && approval === 'never'
              ? 'bypassPermissions'
              : sandbox.type === 'workspaceWrite' && approval === 'on-request'
                ? 'acceptEdits'
                : sandbox.type === 'readOnly' && approval === 'on-request'
                  ? 'default'
                  : undefined;
    }
    if (!this.record.model || this.record.model === 'codex:default') {
      this.record.model = result.model ? `codex:${str(result.model)}` : 'codex:default';
    }
    this.store.save(this.record);
    if (this.record.effort && !this.record.preservePermissions) {
      const models = await readCodexModels(this.client);
      const selected = models.find((model) => model.value === this.record.model);
      if (!selected?.supportedEffortLevels?.includes(this.record.effort))
        throw new Error(`Codex model does not support effort "${this.record.effort}"`);
    }
    this.emit({
      type: 'system',
      subtype: 'init',
      model: this.record.model,
      permissionMode:
        this.record.permissionMode ?? (this.record.preservePermissions ? 'custom' : 'default'),
      effort: this.record.effort,
      runtime: 'codex',
      runtimeVersion: this.record.runtimeVersion,
      contextUsage: this.record.contextUsage,
    });
    this.taskSource = new CodexTasks(
      this.client,
      () => this.record.threadId!,
      (message) => this.emit(message),
    );
    this.taskSource.start();
  }

  send(message: SDKUserMessage): void {
    if (this.closed) throw new Error('Codex session is closed');
    this.inputs.push(message);
    void this.drain().catch((error: unknown) => this.fail(error));
  }

  private async drain(): Promise<void> {
    if (this.starting || this.stopping || this.compacting || this.closed || !this.inputs.length)
      return;
    if (
      this.activeTurn &&
      (this.steeringBlockedTurn === this.activeTurn || codexCommand(this.inputs[0]!))
    )
      return;
    this.starting = true;
    // Capture before initialization; later inputs steer as soon as the first turn is active.
    const messages = this.inputs.splice(0, 1);
    const shown = new Set<SDKUserMessage>();
    let steering = false;
    try {
      await this.ready;
      if (this.closed) return;
      // Requests are serialized so one message can never be sent to two turns.
      if (messages.length === 0) return;
      try {
        if (this.activeTurn) {
          steering = true;
          const expectedTurnId = this.activeTurn;
          for (const message of messages)
            this.submitted.set(message, {
              turnId: expectedTurnId,
              settled: false,
              completed: false,
            });
          try {
            await this.client.request('turn/steer', {
              threadId: this.record.threadId,
              expectedTurnId,
              input: this.input(messages),
              ...(messages[0]?.uuid ? { clientUserMessageId: messages[0].uuid } : {}),
            });
            for (const message of messages) this.settleSubmitted(message);
          } catch (error) {
            // A rejected precondition means none of this input was consumed. Transport
            // failures are ambiguous and must never replay input into a second turn.
            if (
              error instanceof CodexRpcError &&
              error.code === -32600 &&
              (/^no active turn to steer$/.test(error.message) ||
                /^expected active turn id `[^`]+` but found `[^`]+`$/.test(error.message))
            ) {
              // Completion may arrive after this rejection. Wait for that native
              // event instead of racing another turn/start against the old turn.
              this.steeringBlockedTurn = expectedTurnId;
              for (const message of messages) this.submitted.delete(message);
              if (this.stopping) {
                for (const message of messages)
                  if (message.uuid) this.lifecycle(message.uuid, 'cancelled');
              } else this.inputs.unshift(...messages);
              return;
            }
            // A definite refusal can be returned; a timeout stays pending until
            // native consumption or turn completion resolves its ambiguity.
            for (const message of messages) {
              if (error instanceof CodexRpcError) this.cancelSubmitted(message);
              else this.settleSubmitted(message);
            }
            throw error;
          }
        } else await this.startTurn(messages, shown);
      } catch (error) {
        // One turn failing (rejected, timed out, unsupported input) leaves the thread usable;
        // a dead app-server fails the whole session through onExit instead.
        if (this.closed) return;
        if (!steering) for (const message of messages) if (!shown.has(message)) this.show(message);
        const text = error instanceof Error ? error.message : String(error);
        const id = randomUUID();
        this.turnError(id, text);
        if (steering) return;
        this.emit(
          {
            type: 'result',
            uuid: `${id}-result`,
            subtype: 'error_during_execution',
            is_error: true,
            errors: [text],
          },
          true,
        );
      }
    } finally {
      this.starting = false;
      if (this.inputs.length && !this.closed && !this.stopping)
        void this.drain().catch((error: unknown) => this.fail(error));
    }
  }

  private cancelSubmitted(message: SDKUserMessage): void {
    if (!this.submitted.delete(message)) return;
    if (message.uuid) this.lifecycle(message.uuid, 'cancelled');
  }

  private settleSubmitted(message: SDKUserMessage): void {
    const submitted = this.submitted.get(message);
    if (!submitted) return; // Native consumption may precede the RPC response.
    submitted.settled = true;
    if (submitted.completed) this.cancelSubmitted(message);
  }

  private show(message: SDKUserMessage): void {
    if (message.uuid) this.lifecycle(message.uuid, 'started');
    this.emit({ ...message, timestamp: new Date().toISOString() }, true);
  }

  private turnError(id: string, text: string): void {
    this.emit(
      {
        type: 'assistant',
        uuid: `${id}-error`,
        message: {
          id: `${id}-error`,
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: `Codex: ${text || 'Turn failed'}` }],
        },
      },
      true,
    );
  }

  private input(messages: SDKUserMessage[]): Rec[] {
    const input: Rec[] = [];
    for (const message of messages) {
      const content: unknown = message.message.content;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      if (!Array.isArray(blocks)) throw new Error('Unsupported Codex input');
      for (const block of blocks) {
        const b = rec(block);
        if (b.type === 'text') {
          input.push({ type: 'text', text: str(b.text), text_elements: [] });
          this.record.firstPrompt ??= str(b.text);
        } else if (b.type === 'image') {
          const source = rec(b.source);
          input.push({
            type: 'image',
            url: `data:${str(source.media_type)};base64,${str(source.data)}`,
          });
        } else throw new Error(`Unsupported Codex input: ${str(b.type)}`);
      }
    }
    return input;
  }

  private async startTurn(messages: SDKUserMessage[], shown: Set<SDKUserMessage>): Promise<void> {
    if (messages.some((message) => codexCommand(message))) {
      if (messages.length !== 1 || !isBareCompact(messages[0]!))
        throw new Error(
          'Unsupported Codex command. Send /compact alone, without arguments or attachments.',
        );
      this.completedWhileStarting = false;
      this.turnUsage = undefined;
      this.lastAssistant = undefined;
      this.show(messages[0]!);
      shown.add(messages[0]!);
      // The native compaction emits turn/started and turn/completed asynchronously.
      // Keep subsequent input queued even before its started notification arrives.
      this.compacting = true;
      this.activeTurn = 'compact';
      try {
        await this.client.request('thread/compact/start', { threadId: this.record.threadId });
      } catch (error) {
        this.compacting = false;
        this.activeTurn = undefined;
        throw error;
      }
      return;
    }
    const input = this.input(messages);
    for (const message of messages) {
      this.show(message);
      shown.add(message);
    }
    const policy = codexPermissions(this.record.permissionMode);
    const model = codexModel(this.record.model);
    const collaborationMode = this.record.preservePermissions
      ? this.nativeCollaboration && {
          ...this.nativeCollaboration,
          settings: {
            ...rec(this.nativeCollaboration.settings),
            ...(model ? { model } : {}),
            ...(this.record.effort ? { reasoning_effort: this.record.effort } : {}),
          },
        }
      : model && {
          mode: this.record.permissionMode === 'plan' ? 'plan' : 'default',
          settings: {
            model,
            reasoning_effort: this.record.effort ?? null,
            developer_instructions: null,
          },
        };
    this.completedWhileStarting = false;
    this.turnUsage = undefined;
    this.lastAssistant = undefined;
    const result = await this.client.request('turn/start', {
      threadId: this.record.threadId,
      input,
      ...(messages[0]?.uuid ? { clientUserMessageId: messages[0].uuid } : {}),
      ...(codexModel(this.record.model) ? { model: codexModel(this.record.model) } : {}),
      ...(this.record.effort ? { effort: this.record.effort } : {}),
      ...(!this.record.preservePermissions
        ? {
            approvalPolicy: policy.approvalPolicy,
            sandboxPolicy: policy.sandboxPolicy,
            approvalsReviewer: policy.approvalsReviewer ?? 'user',
          }
        : {}),
      ...(collaborationMode ? { collaborationMode } : {}),
    });
    if (!this.completedWhileStarting) this.activeTurn = str(rec(result.turn).id) || undefined;
  }

  /** As Claude Code's Esc: messages still waiting for a turn are cancelled with the turn. */
  async interrupt(): Promise<void> {
    this.stopping = true;
    try {
      for (const message of this.inputs.splice(0))
        if (message.uuid) this.lifecycle(message.uuid, 'cancelled');
      await this.ready;
      // A click while turn/start is pending still interrupts the turn it creates.
      while ((this.starting || this.activeTurn === 'compact') && !this.closed)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (this.activeTurn)
        await this.client.request('turn/interrupt', {
          threadId: this.record.threadId,
          turnId: this.activeTurn,
        });
    } finally {
      this.stopping = false;
      if (this.inputs.length) void this.drain().catch((error: unknown) => this.fail(error));
    }
  }

  async cancelQueued(uuid: string): Promise<boolean> {
    const i = this.inputs.findIndex((message) => message.uuid === uuid);
    if (i < 0) return false;
    this.inputs.splice(i, 1);
    this.lifecycle(uuid, 'cancelled');
    return true;
  }

  async setModel(model?: string): Promise<void> {
    if (!model?.startsWith('codex:'))
      throw new Error('Start a new chat to switch between Claude and Codex.');
    await this.ready;
    const selected = (await this.supportedModels()).find((m) => m.value === model);
    if (
      this.record.effort &&
      !selected?.supportedEffortLevels?.includes(this.record.effort as Effort)
    ) {
      throw new Error(
        'Choose a reasoning effort supported by the new Codex model before switching models.',
      );
    }
    this.record.model = model;
    this.store.save(this.record);
  }

  async setEffort(effort: Effort): Promise<void> {
    await this.ready;
    const models = await this.supportedModels();
    const model = models.find((m) => m.value === this.record.model);
    if (!model?.supportedEffortLevels?.includes(effort))
      throw new Error(`Codex model does not support effort "${effort}"`);
    this.record.effort = effort;
    this.store.save(this.record);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    codexPermissions(mode);
    await this.ready;
    if (this.activeTurn || this.starting)
      throw new Error('Wait for the current turn to finish before changing Codex permissions.');
    this.record.permissionMode = mode;
    this.record.preservePermissions = false;
    this.store.save(this.record);
  }

  async stopTask(taskId: string): Promise<void> {
    await this.ready;
    if (!this.taskSource) throw new Error('Codex task controls are not ready');
    await this.taskSource.stop(taskId);
  }
  async supportedCommands(): Promise<SlashCommand[]> {
    return CODEX_COMMANDS;
  }
  async supportedModels(): Promise<ModelInfo[]> {
    await this.ready;
    return readCodexModels(this.client);
  }
  async accountInfo(): Promise<AccountInfo> {
    await this.ready;
    const result = await this.client.request('account/read', {});
    const account = rec(result.account);
    return account.type === 'chatgpt'
      ? {
          subscriptionType: str(account.planType) || 'ChatGPT',
          ...(str(account.email) ? { email: str(account.email) } : {}),
        }
      : { ...(account.type === 'apiKey' ? { apiKeySource: 'Codex CLI' } : {}) };
  }

  readonly usage = async (): Promise<unknown> => {
    await this.ready;
    const account = await this.client.request('account/read', {});
    const limits =
      rec(account.account).type === 'chatgpt'
        ? await this.client.request('account/rateLimits/read', {})
        : {};
    return codexUsage(limits, account);
  };

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.taskSource?.close();
    for (const controller of this.approvals.values()) controller.abort();
    this.approvals.clear();
    this.approvalThreads.clear();
    this.client.close();
    this.messages.end();
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.messages.end(error instanceof Error ? error : new Error(String(error)));
    this.close();
  }

  /**
   * Claude Code's frame for a message sent while it works, which LiveSession
   * follows to show the message as queued: a turn took it up, or it was dropped.
   */
  private lifecycle(uuid: string, state: 'started' | 'cancelled'): void {
    this.emit({ type: 'command_lifecycle', command_uuid: uuid, state });
  }

  /** These compatibility envelopes are private to the adapter/normalizer boundary. */
  private emit(message: Rec, persist = false): void {
    const envelope = {
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      session_id: this.record.id,
      parent_tool_use_id: null,
      parent_agent_id: null,
      ...message,
      ...(this.activeTurn ? { codex_turn_id: this.activeTurn } : {}),
      ...this.context,
    } as unknown as SDKMessage;
    if (persist) this.store.append(this.record, envelope);
    this.messages.push(envelope);
  }

  private assistant(id: string, content: Rec[], persist = true, usage?: Rec): void {
    this.emit(
      {
        type: 'assistant',
        uuid: id,
        message: {
          id,
          role: 'assistant',
          model: this.context
            ? this.children.get(this.context.parent_agent_id)?.model
            : codexModel(this.record.model),
          content,
          ...(usage ? { usage } : {}),
        },
      },
      persist,
    );
  }

  private onMessage(message: RpcMessage): void {
    if (this.closed) return;
    const previousContext = this.context;
    try {
      const p = message.params ?? {};
      // Requests come before the thread filter: this app-server only runs this chat's thread
      // and its sub-agents, and a sub-agent's unanswered approval would hang the parent's turn.
      if (message.id !== undefined && message.method) {
        void this.approve(message).catch((error: unknown) => this.fail(error));
        return;
      }
      if (message.method === 'serverRequest/resolved') {
        const id = p.requestId as number | string;
        this.approvals.get(id)?.abort();
        this.approvals.delete(id);
        this.approvalThreads.delete(id);
        return;
      }
      if (message.method === 'turn/completed')
        this.finishApprovals(str(p.threadId) || this.record.threadId!);
      if (message.method === 'thread/started') {
        const thread = rec(p.thread);
        const parent =
          str(thread.parentThreadId) ||
          str(rec(rec(rec(thread.source).subAgent).thread_spawn).parent_thread_id);
        if (parent === this.record.threadId || this.children.has(parent))
          this.child(str(thread.id), parent, str(thread.model));
        return;
      }
      if (p.threadId && this.record.threadId && p.threadId !== this.record.threadId) {
        const child = this.children.get(str(p.threadId));
        if (!child) return;
        if (!child.toolId) {
          // A child may speak before spawn completion supplies receiver IDs.
          // Final native items retain complete content if old partials are evicted.
          if (child.buffered.length === 256) child.buffered.shift();
          child.buffered.push(message);
          return;
        }
        this.context = {
          parent_tool_use_id: child.toolId,
          parent_agent_id: str(p.threadId),
          codex_turn_id: str(p.turnId) || str(rec(p.turn).id) || undefined,
        };
        if (message.method === 'turn/completed') {
          this.finishStreams(str(p.threadId));
          return;
        }
        if (!message.method?.startsWith('item/')) return;
      } else this.context = undefined;
      switch (message.method) {
        case 'turn/started':
          this.activeTurn = str(rec(p.turn).id);
          break;
        case 'thread/tokenUsage/updated': {
          const usage = rec(p.tokenUsage);
          const last = rec(usage.last);
          const total = rec(usage.total);
          const delta = { ...last };
          if (typeof total.totalTokens === 'number') {
            if (
              this.previousUsageTotal &&
              total.totalTokens >= Number(this.previousUsageTotal.totalTokens)
            ) {
              for (const key of [
                'inputTokens',
                'cachedInputTokens',
                'cacheWriteInputTokens',
                'outputTokens',
              ]) {
                if (
                  typeof total[key] === 'number' &&
                  typeof this.previousUsageTotal[key] === 'number'
                )
                  delta[key] = Math.max(
                    0,
                    Number(total[key]) - Number(this.previousUsageTotal[key]),
                  );
              }
            }
            this.previousUsageTotal = total;
          }
          const tokens = codexTokens(delta);
          if (tokens)
            this.turnUsage = Object.fromEntries(
              Object.entries(tokens).map(([key, value]) => [
                key,
                Number(this.turnUsage?.[key] ?? 0) + Number(value),
              ]),
            );
          const used = typeof last.totalTokens === 'number' ? last.totalTokens : undefined;
          const max =
            typeof usage.modelContextWindow === 'number' ? usage.modelContextWindow : undefined;
          if (used !== undefined && max !== undefined && max > 0) {
            this.record.contextUsage = { used, max };
            this.store.save(this.record);
            this.emit({ type: 'system', subtype: 'status', contextUsage: { used, max } });
          }
          break;
        }
        case 'item/reasoning/summaryTextDelta': {
          const id = str(p.itemId);
          const index = typeof p.summaryIndex === 'number' ? p.summaryIndex : 0;
          const summary = this.reasoning.get(id) ?? new Map<number, string>();
          summary.set(index, (summary.get(index) ?? '') + str(p.delta));
          this.reasoning.set(id, summary);
          this.assistant(
            id,
            [
              {
                type: 'thinking',
                thinking: [...summary]
                  .sort(([a], [b]) => a - b)
                  .map(([, text]) => text)
                  .join('\n'),
              },
            ],
            false,
          );
          break;
        }
        case 'item/commandExecution/outputDelta':
        case 'item/fileChange/outputDelta':
        case 'item/mcpToolCall/progress': {
          const id = str(p.itemId);
          const text =
            (this.output.get(id) ?? '') +
            (message.method === 'item/mcpToolCall/progress' ? `${str(p.message)}\n` : str(p.delta));
          this.output.set(id, text.slice(0, 20_001));
          this.emit({
            type: 'user',
            uuid: `${id}-result`,
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: id,
                  content: this.output.get(id),
                  is_partial: true,
                },
              ],
            },
          });
          break;
        }
        case 'item/agentMessage/delta': {
          const id = str(p.itemId);
          if (!this.streamed.has(id)) {
            this.emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
            this.emit({
              type: 'stream_event',
              uuid: id,
              event: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              },
            });
          }
          this.streamContexts.set(id, this.context);
          this.streamed.set(id, (this.streamed.get(id) ?? '') + str(p.delta));
          this.emit({
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: str(p.delta) },
            },
          });
          break;
        }
        case 'item/started':
          this.item(rec(p.item), false);
          break;
        case 'item/completed':
          this.item(rec(p.item), true);
          break;
        case 'turn/completed': {
          this.compacting = false;
          this.completedWhileStarting = this.starting;
          this.finishStreams();
          const turn = rec(p.turn);
          for (const [message, submitted] of this.submitted) {
            if (submitted.turnId !== str(turn.id)) continue;
            submitted.completed = true;
            if (submitted.settled) this.cancelSubmitted(message);
          }
          const failed = turn.status === 'failed';
          if (this.lastAssistant && this.turnUsage)
            this.assistant(this.lastAssistant.id, this.lastAssistant.content, true, this.turnUsage);
          const error = rec(turn.error);
          if (
            failed &&
            (/usage.?limit|rate.?limit|quota/i.test(str(error.codexErrorInfo)) ||
              /usage limit|rate limit|quota exceeded/i.test(str(error.message)))
          )
            this.emit({
              type: 'rate_limit_event',
              rate_limit_info: { status: 'rejected', rateLimitType: 'current' },
            });
          if (failed) this.turnError(str(turn.id), str(error.message));
          this.emit(
            {
              type: 'result',
              uuid: `${str(turn.id)}-result`,
              ...(typeof turn.durationMs === 'number' ? { duration_ms: turn.durationMs } : {}),
              ...(this.turnUsage ? { usage: this.turnUsage } : {}),
              subtype: failed ? 'error_during_execution' : 'success',
              is_error: failed,
              ...(failed ? { errors: [str(rec(turn.error).message)] } : { result: '' }),
            },
            true,
          );
          this.activeTurn = undefined;
          void this.taskSource?.refresh();
          void this.drain().catch((error: unknown) => this.fail(error));
          break;
        }
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.context = previousContext;
    }
  }

  private item(item: Rec, completed: boolean): void {
    if (item.type === 'userMessage') {
      for (const [message] of this.submitted) {
        if (message.uuid && message.uuid === str(item.clientId)) {
          this.submitted.delete(message);
          this.show(message);
        }
      }
      if (!this.context) return; // Main input is echoed under the client's own UUID.
    }
    if (item.type === 'subAgentActivity' && item.kind === 'interacted') {
      const child = this.child(
        str(item.agentThreadId),
        this.context?.parent_agent_id || this.record.threadId!,
        str(item.model),
      );
      if (!child) return;
      child.terminal = false;
      if (child.toolId) {
        this.agentStarted(str(item.agentThreadId), child, str(item.agentPath), str(item.id));
        for (const event of child.buffered.splice(0)) this.onMessage(event);
        return;
      }
      // Resume excludes old turns. The first owned interaction is sufficient
      // evidence to show and route this child without loading unrelated history.
      item = { ...item, kind: 'started' };
    }
    const id = str(item.id);
    if (!id) return;
    if (item.type === 'agentMessage' && completed) {
      if (!this.context)
        this.lastAssistant = { id, content: [{ type: 'text', text: str(item.text) }] };
      this.streamed.delete(id);
      this.streamContexts.delete(id);
    }
    if (completed) {
      this.reasoning.delete(id);
      if (this.output.has(id) && !str(item.aggregatedOutput) && item.type === 'commandExecution')
        item = { ...item, aggregatedOutput: this.output.get(id) };
      this.output.delete(id);
    }
    if (item.type === 'subAgentActivity' && item.kind !== 'started') {
      const child = this.children.get(str(item.agentThreadId));
      if (completed && child?.toolId && item.kind !== 'interacted') {
        child.terminal = true;
        this.emit(
          {
            type: 'user',
            uuid: `${child.toolId}-result`,
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: child.toolId,
                  content: `Codex agent ${str(item.kind)}`,
                  is_error: item.kind === 'failed',
                },
              ],
            },
          },
          true,
        );
        this.emit({
          type: 'system',
          subtype: 'task_notification',
          task_id: `codex-agent-${str(item.agentThreadId)}`,
          status:
            item.kind === 'interrupted'
              ? 'stopped'
              : item.kind === 'failed'
                ? 'failed'
                : 'completed',
          summary: `Codex agent ${str(item.kind)}`,
          output_file: '',
        });
      }
      return;
    }
    const messages = itemMessages(
      this.record.id,
      item,
      this.context
        ? this.children.get(this.context.parent_agent_id)?.model
        : codexModel(this.record.model),
      completed,
      Date.now(),
    );
    const isTool = messages.some(
      (message) =>
        message.type === 'assistant' &&
        Array.isArray(rec(message.message).content) &&
        (rec(message.message).content as unknown[]).some((block) => rec(block).type === 'tool_use'),
    );
    for (const message of messages) {
      if (isTool && message.type === 'assistant' && this.tools.has(id)) continue;
      this.emit(
        {
          ...(message as unknown as Rec),
          ...(item.type === 'subAgentActivity' ? { codex_activity_only: true } : {}),
        },
        true,
      );
    }
    if (isTool) {
      if (completed) this.tools.delete(id);
      else this.tools.add(id);
    }
    if (item.type === 'subAgentActivity' && item.kind === 'started') {
      const child = this.child(
        str(item.agentThreadId),
        this.context?.parent_agent_id || this.record.threadId!,
        str(item.model),
      );
      if (child) {
        child.toolId ??= id;
        this.agentStarted(str(item.agentThreadId), child, str(item.agentPath));
        for (const event of child.buffered.splice(0)) this.onMessage(event);
      }
    }
    if (item.type === 'collabAgentToolCall') {
      if (item.tool === 'spawnAgent') {
        const parent =
          str(item.senderThreadId) || this.context?.parent_agent_id || this.record.threadId!;
        for (const childId of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) {
          const child = this.child(str(childId), parent, str(item.model));
          if (!child) continue;
          child.toolId ??= id;
          this.agentStarted(str(childId), child, str(item.prompt));
          for (const event of child.buffered.splice(0)) this.onMessage(event);
        }
      }
      if (completed) void this.taskSource?.refresh();
    }
  }

  private child(id: string, parent: string, model?: string) {
    if (!id || id === this.record.threadId) return undefined;
    const existing = this.children.get(id);
    if (existing) {
      if (model) existing.model = model;
      return existing;
    }
    if (this.children.size >= 128) {
      const terminal = [...this.children].find(([, child]) => child.terminal);
      if (terminal) this.children.delete(terminal[0]);
      else {
        if (!this.childCapacityNotified) {
          this.childCapacityNotified = true;
          this.emit(
            {
              type: 'system',
              subtype: 'informational',
              level: 'warning',
              content:
                'Live output is limited to 128 active Codex agents. Additional agent output is omitted until a slot is available.',
            },
            true,
          );
        }
        return undefined;
      }
    }
    const child = {
      parent,
      terminal: false,
      model: model || undefined,
      buffered: [] as RpcMessage[],
      toolId: undefined as string | undefined,
    };
    this.children.set(id, child);
    return child;
  }

  private agentStarted(
    id: string,
    child: { parent: string; toolId?: string; model?: string; activityId?: string; runId?: string },
    description: string,
    activityId = child.toolId,
  ): void {
    // Task tracking orders run IDs; native call IDs are random rather than ordered.
    if (child.activityId !== activityId || !child.runId) {
      child.activityId = activityId;
      child.runId = String(++this.taskRun).padStart(16, '0');
    }
    this.emit({
      type: 'system',
      subtype: 'task_started',
      run_id: child.runId,
      is_backgrounded: true,
      task_id: `codex-agent-${id}`,
      task_type: 'local_agent',
      tool_use_id: child.toolId,
      description: description || 'Codex agent',
      ...(child.parent !== this.record.threadId
        ? { parent_task_id: `codex-agent-${child.parent}` }
        : {}),
    });
  }

  private finishStreams(childId?: string): void {
    for (const [id, text] of this.streamed) {
      if (this.streamContexts.get(id)?.parent_agent_id !== childId) continue;
      const content = [{ type: 'text', text }];
      if (!childId) this.lastAssistant = { id, content };
      this.assistant(id, content);
      this.streamed.delete(id);
      this.streamContexts.delete(id);
    }
  }

  private finishApprovals(threadId: string): void {
    for (const [id, owner] of this.approvalThreads) {
      if (owner !== threadId) continue;
      this.approvals.get(id)?.abort();
      this.approvals.delete(id);
      this.approvalThreads.delete(id);
    }
  }

  private async approve(message: RpcMessage): Promise<void> {
    const id = message.id!;
    const p = message.params ?? {};
    const command = message.method === 'item/commandExecution/requestApproval';
    const file = message.method === 'item/fileChange/requestApproval';
    const question = message.method === 'item/tool/requestUserInput';
    const permissions = message.method === 'item/permissions/requestApproval';
    if (!command && !file && !question && !permissions) {
      // Unknown requests must never hang a turn or implicitly grant access.
      this.client.reject(id, `Threadgarden does not support ${message.method}`);
      return;
    }
    const controller = new AbortController();
    this.approvals.set(id, controller);
    this.approvalThreads.set(id, str(p.threadId) || this.record.threadId!);
    const questions = Array.isArray(p.questions) ? p.questions.map(rec) : [];
    const input = question
      ? { questions: questions.map((q) => ({ ...q, multiSelect: false })) }
      : p;
    try {
      const answer = await this.options.canUseTool(
        question ? 'AskUserQuestion' : command ? 'Bash' : file ? 'CodexPatch' : 'CodexPermissions',
        input,
        {
          requestId: `codex-${id}`,
          toolUseID: str(p.itemId) || `codex-${id}`,
          signal: controller.signal,
          ...(str(p.reason) ? { decisionReason: str(p.reason) } : {}),
        },
      );
      if (controller.signal.aborted || this.closed) return;
      const allowed = answer?.behavior === 'allow';
      if (question) {
        const given = rec(rec(answer?.behavior === 'allow' ? answer.updatedInput : {}).answers);
        this.client.reply(id, {
          answers: Object.fromEntries(
            questions.map((q) => [
              str(q.id),
              {
                answers: allowed
                  ? [str(given[str(q.question)]) || str(given[str(q.id)])].filter(Boolean)
                  : [],
              },
            ]),
          ),
        });
      } else if (permissions) {
        const requested = rec(p.permissions);
        this.client.reply(id, {
          permissions: allowed
            ? Object.fromEntries(Object.entries(requested).filter(([, value]) => value != null))
            : {},
          scope: 'turn',
        });
      } else this.client.reply(id, { decision: allowed ? 'accept' : 'decline' });
    } finally {
      this.approvals.delete(id);
      this.approvalThreads.delete(id);
    }
  }
}

/**
 * The model Codex's config names for a new thread (`model` in config.toml), if any.
 * Older CLIs without `config/read` name none.
 */
const configuredCodexModel = async (client: CodexConnection): Promise<string | undefined> => {
  try {
    const result = await client.request('config/read', {});
    return str(rec(result.config).model) || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Codex's selectable models. One is `isDefault`: the config's model when it is in
 * the catalog, else the catalog's own default.
 */
export const readCodexModels = async (client: CodexConnection): Promise<ModelInfo[]> => {
  const models: ModelInfo[] = [];
  let catalogDefault: string | undefined;
  let cursor: string | undefined;
  do {
    const result = await client.request('model/list', {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const value of Array.isArray(result.data) ? result.data : []) {
      const model = rec(value);
      if (model.hidden === true || !str(model.model)) continue;
      const efforts = (
        Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []
      )
        .map((e) => str(rec(e).reasoningEffort))
        .filter(Boolean);
      if (model.isDefault === true) catalogDefault ??= str(model.model);
      models.push({
        value: `codex:${str(model.model)}`,
        displayName: str(model.displayName) || str(model.model),
        description: str(model.description),
        supportedEffortLevels: efforts,
      });
    }
    cursor = str(result.nextCursor) || undefined;
  } while (cursor);
  const configured = await configuredCodexModel(client);
  const chosen =
    configured && models.some((m) => m.value === `codex:${configured}`)
      ? configured
      : catalogDefault;
  return models.map((m) => (m.value === `codex:${chosen}` ? { ...m, isDefault: true } : m));
};

export class CodexAdapter {
  readonly store: CodexStore;
  readonly history: CodexHistory;
  constructor(
    dir: string,
    private readonly connect: ConnectCodex = connectCodex,
    env: () => NodeJS.ProcessEnv = () => process.env,
    shared?: ConnectCodex,
  ) {
    this.store = new CodexStore(dir);
    this.history = new CodexHistory(this.store, env, connect, shared);
  }
  start(options: StartOptions): CodexSession {
    const id = options.resume ?? options.sessionId;
    if (!id) throw new Error('Codex needs a session id');
    let record = options.resume ? this.store.read(id) : undefined;
    if (options.resume && !record) throw new Error('No saved Codex conversation to resume');
    record ??= {
      id,
      createdHere: true,
      cwd: options.cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (options.model !== undefined) record.model = options.model;
    if (options.effort !== undefined) record.effort = options.effort;
    if (options.permissionMode !== undefined) {
      record.permissionMode = options.permissionMode;
      record.preservePermissions = false;
    }
    record.home ??= options.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this.store.save(record);
    return new CodexSession(
      { ...options, env: { ...options.env, CODEX_HOME: record.home } },
      record,
      this.store,
      this.connect,
    );
  }
  oneShot(options: OneShotOptions, modelProvider?: string): Promise<string> {
    return codexOneShot(options, this.connect, modelProvider);
  }
  async models(env: NodeJS.ProcessEnv): Promise<ModelInfo[]> {
    const client = this.connect(
      env,
      () => {},
      () => {},
    );
    try {
      await initializeCodex(client);
      return await readCodexModels(client);
    } finally {
      client.close();
    }
  }
}
