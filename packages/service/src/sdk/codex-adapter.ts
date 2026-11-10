/** Codex's thread/turn protocol translated at the existing chat event boundary. */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {
  AccountInfo,
  AgentSession,
  Effort,
  ModelInfo,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
  StartOptions,
} from './adapter.js';
import {
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
  private starting = false;
  private completedWhileStarting = false;
  private inputs: SDKUserMessage[] = [];
  private streamed = new Map<string, string>();
  private tools = new Set<string>();
  private approvals = new Map<number | string, AbortController>();
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
    if (this.starting || this.activeTurn || this.closed) return;
    this.starting = true;
    // Capture before initialization: inputs arriving during startup belong to the next turn.
    const messages = this.inputs.splice(0);
    try {
      await this.ready;
      if (this.closed) return;
      // Match LiveSession's queued-input semantics: one subsequent turn consumes the batch.
      if (messages.length === 0) return;
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
        this.emit({ ...message, timestamp: new Date().toISOString() }, true);
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
    } finally {
      this.starting = false;
      if (!this.activeTurn && this.inputs.length && !this.closed)
        void this.drain().catch((error: unknown) => this.fail(error));
    }
  }

  async interrupt(): Promise<void> {
    this.inputs = [];
    await this.ready;
    // A click while turn/start is pending still interrupts the turn it creates.
    while (this.starting && !this.closed) await new Promise((resolve) => setTimeout(resolve, 10));
    if (this.activeTurn)
      await this.client.request('turn/interrupt', {
        threadId: this.record.threadId,
        turnId: this.activeTurn,
      });
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
    return [];
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
    this.client.close();
    this.messages.end();
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.messages.end(error instanceof Error ? error : new Error(String(error)));
    this.close();
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
          model: codexModel(this.record.model),
          content,
          ...(usage ? { usage } : {}),
        },
      },
      persist,
    );
  }

  private onMessage(message: RpcMessage): void {
    if (this.closed) return;
    try {
      const p = message.params ?? {};
      if (p.threadId && this.record.threadId && p.threadId !== this.record.threadId) return;
      if (message.id !== undefined && message.method) {
        void this.approve(message).catch((error: unknown) => this.fail(error));
        return;
      }
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
        case 'serverRequest/resolved': {
          const id = p.requestId as number | string;
          this.approvals.get(id)?.abort();
          this.approvals.delete(id);
          break;
        }
        case 'turn/completed': {
          this.completedWhileStarting = this.starting;
          for (const [id, text] of this.streamed) {
            this.lastAssistant = { id, content: [{ type: 'text', text }] };
            this.assistant(id, this.lastAssistant.content);
          }
          this.streamed.clear();
          for (const controller of this.approvals.values()) controller.abort();
          this.approvals.clear();
          const turn = rec(p.turn);
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
          if (failed)
            this.emit(
              {
                type: 'assistant',
                uuid: `${str(turn.id)}-error`,
                message: {
                  id: `${str(turn.id)}-error`,
                  role: 'assistant',
                  model: '<synthetic>',
                  content: [
                    {
                      type: 'text',
                      text: `Codex: ${str(rec(turn.error).message) || 'Turn failed'}`,
                    },
                  ],
                },
              },
              true,
            );
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
    }
  }

  private item(item: Rec, completed: boolean): void {
    if (item.type === 'userMessage') return; // Sent input is echoed under the client's own UUID.
    const id = str(item.id);
    if (!id) return;
    if (item.type === 'agentMessage' && completed) {
      this.lastAssistant = { id, content: [{ type: 'text', text: str(item.text) }] };
      this.streamed.delete(id);
    }
    const messages = itemMessages(
      this.record.id,
      item,
      codexModel(this.record.model),
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
      this.emit(message as unknown as Rec, true);
    }
    if (isTool) {
      if (completed) this.tools.delete(id);
      else this.tools.add(id);
    }
    if (item.type === 'collabAgentToolCall' && completed) void this.taskSource?.refresh();
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
    }
  }
}

export const readCodexModels = async (client: CodexConnection): Promise<ModelInfo[]> => {
  const models: ModelInfo[] = [];
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
      models.push({
        value: `codex:${str(model.model)}`,
        displayName: str(model.displayName) || str(model.model),
        description: str(model.description),
        supportedEffortLevels: efforts,
      });
    }
    cursor = str(result.nextCursor) || undefined;
  } while (cursor);
  return models;
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
