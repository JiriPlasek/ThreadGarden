import type {
  AgentAdapter,
  AgentSession,
  HistoryOptions,
  ImportOptions,
  OneShotOptions,
  PageOptions,
  SDKSessionInfo,
  SessionMessage,
  SessionStore,
  StartOptions,
  ModelInfo,
} from './adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { CodexNotFoundError, findCodex } from './codex-client.js';
import { isCodexModel, isCodexSession } from './providers.js';
import type { Settings } from '@threadgarden/protocol';
import type { ExternalSession } from '../external/poller.js';
import os from 'node:os';
import path from 'node:path';

/** Anthropic credentials, matched case-insensitively as Windows matches variable names. */
const ANTHROPIC_CREDENTIAL =
  /^(THREADGARDEN_)?ANTHROPIC_(API_KEY|AUTH_TOKEN)$|^CLAUDE_CODE_OAUTH_TOKEN$/i;

/** `env` without any Anthropic credential; everything else stays. */
export const withoutAnthropicCredentials = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !ANTHROPIC_CREDENTIAL.test(key)));

/** Dispatch by explicit provider, never by a guessed GPT/Claude model-name pattern. */
export class MultiAdapter implements AgentAdapter {
  private catalog?: { until: number; models: ModelInfo[] };
  private settings: Pick<Settings, 'codexPath' | 'codexHome'> = {};
  constructor(
    private readonly claude: AgentAdapter,
    private readonly codex: CodexAdapter,
    private readonly env: () => NodeJS.ProcessEnv = () => process.env,
  ) {
    this.codex.history.setEnvironment(() => this.runtimeEnv());
  }

  configure(settings: Settings): void {
    this.settings = settings;
    this.catalog = undefined;
    this.codex.history.setEnvironment(() => this.runtimeEnv());
  }
  /**
   * The environment for every Codex process: a chat's app-server, and the
   * catalog, history and shared-runtime connections. A chat's `env` was built
   * for Claude (`buildSessionEnv`), and the service's own may hold the user's
   * key too, so Anthropic credentials are removed: Codex and every tool it runs
   * inherit this environment, and a model running `env` would send them on.
   */
  private runtimeEnv(base = this.env()): NodeJS.ProcessEnv {
    return {
      ...withoutAnthropicCredentials(base),
      ...(this.settings.codexPath ? { THREADGARDEN_CODEX_PATH: this.settings.codexPath } : {}),
      ...(this.settings.codexHome ? { CODEX_HOME: this.settings.codexHome } : {}),
    };
  }
  externalSessions(): Promise<ExternalSession[]> {
    return this.codex.history.external();
  }
  listPolledSessions(): Promise<SDKSessionInfo[]> {
    return this.codex.history.list();
  }
  dispose(): void {
    this.codex.history.close();
  }
  async getSessionHeader(id: string) {
    if (!isCodexSession(id)) return {};
    const record = this.codex.store.read(id);
    return {
      runtime: 'codex' as const,
      ...(record
        ? {
            model: record.model,
            effort: record.effort,
            permissionMode: record.permissionMode,
            runtimeVersion: record.runtimeVersion,
            contextUsage: record.contextUsage,
          }
        : {}),
    };
  }

  async requireCodex(): Promise<void> {
    findCodex(this.runtimeEnv());
  }
  codexInfo() {
    const env = this.runtimeEnv();
    return {
      path: findCodex(env),
      home: env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      historyProblem: this.codex.history.historyProblem,
    };
  }
  async resumeCommand(id: string): Promise<string | undefined> {
    if (!isCodexSession(id)) return undefined;
    const thread = this.codex.store.read(id)?.threadId;
    if (!thread || !/^[a-zA-Z0-9_-]+$/.test(thread))
      throw new Error('No saved Codex thread to resume');
    return `codex resume ${thread}`;
  }

  async models(): Promise<ModelInfo[]> {
    if (this.catalog && this.catalog.until > Date.now()) return this.catalog.models;
    try {
      const models = await this.codex.models(this.runtimeEnv());
      this.catalog = { until: Date.now() + 60_000, models };
      return models;
    } catch (error) {
      // No CLI is the usual state for a Claude-only user: Codex is simply not offered.
      if (error instanceof CodexNotFoundError) return [];
      // A CLI that is there but can't list its models: a selectable default still
      // starts a chat, and explains an auth failure there.
      return [
        {
          value: 'codex:default',
          displayName: 'Default (Codex)',
          description: 'Uses your installed Codex CLI and login',
          isDefault: true,
        },
      ];
    }
  }

  start(options: StartOptions): AgentSession {
    if (isCodexSession(options.resume ?? options.sessionId ?? '') || isCodexModel(options.model))
      return this.codex.start({ ...options, env: this.runtimeEnv(options.env) });
    const session = this.claude.start(options);
    const setModel = session.setModel.bind(session);
    session.setModel = async (model) => {
      if (isCodexModel(model))
        throw new Error('Start a new chat to switch between Claude and Codex.');
      await setModel(model);
    };
    return session;
  }

  async listSessions(options?: PageOptions & HistoryOptions): Promise<SDKSessionInfo[]> {
    if (options?.sessionStore) return this.claude.listSessions(options);
    const [claude, codex] = await Promise.all([
      this.claude.listSessions(),
      this.codex.history.list().catch(() => this.codex.store.list()),
    ]);
    const list = [...claude, ...codex].sort((a, b) => b.lastModified - a.lastModified);
    return list.slice(
      options?.offset ?? 0,
      options?.limit === undefined ? undefined : (options.offset ?? 0) + options.limit,
    );
  }
  async getSessionInfo(id: string, options?: HistoryOptions): Promise<SDKSessionInfo | undefined> {
    return isCodexSession(id)
      ? this.codex.history.info(id)
      : this.claude.getSessionInfo(id, options);
  }
  async getSessionMessages(
    id: string,
    options?: PageOptions & HistoryOptions,
  ): Promise<SessionMessage[]> {
    if (!isCodexSession(id)) return this.claude.getSessionMessages(id, options);
    return (await this.codex.history.messages(id)).slice(
      options?.offset ?? 0,
      options?.limit === undefined ? undefined : (options.offset ?? 0) + options.limit,
    );
  }
  async forkSession(
    id: string,
    options: { upToMessageId?: string },
  ): Promise<{ sessionId: string }> {
    if (isCodexSession(id)) return this.codex.history.fork(id, options);
    return this.claude.forkSession(id, options);
  }
  async importSession(id: string, store: SessionStore, options: ImportOptions): Promise<void> {
    if (isCodexSession(id))
      throw new Error('Moving Codex conversations between machines is not available yet.');
    return this.claude.importSession(id, store, options);
  }
  oneShot(options: OneShotOptions): Promise<string> {
    if (isCodexModel(options.model)) {
      const record = options.sourceSessionId
        ? this.codex.store.read(options.sourceSessionId)
        : undefined;
      return this.codex.oneShot(
        {
          ...options,
          model: record?.model ?? options.model,
          env: {
            ...this.runtimeEnv(options.env),
            ...(record?.home ? { CODEX_HOME: record.home } : {}),
          },
        },
        record?.modelProvider,
      );
    }
    return this.claude.oneShot(options);
  }
}
