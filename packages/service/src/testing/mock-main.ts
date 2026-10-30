/**
 * Mock pahub service for UI development and Playwright
 * (`pnpm --filter @pahub/service mock`): the real service (`startService`)
 * over a synthetic history (`generateCorpus`) and a scripted fake Claude Code.
 *
 * Script, per user message:
 * - every reply streams a few sentences with partial (`stream_event`) messages;
 * - a message containing "perm" asks for permission to run a Bash command;
 * - "ask" asks an AskUserQuestion question; "plan" asks to approve a plan
 *   (ExitPlanMode).
 *
 * Everything lives in temporary directories (pahub data dir and a fixture
 * `CLAUDE_CONFIG_DIR`), removed on exit. The mock's fake Claude Code writes a
 * placeholder transcript per chat into that fixture, like the real CLI, so the
 * watcher and indexer pick new chats up. On start it prints the discovery
 * record (port, token, …) as one JSON line on stdout. `PAHUB_MOCK_PORT` and
 * `PAHUB_MOCK_TOKEN` (or `--port` / `--token`) fix the port and token.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDiscovery } from '../discovery.js';
import { startService, type ServiceHandle } from '../main.js';
import type {
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
  StartOptions,
} from '../sdk/adapter.js';
import { generateCorpus } from './corpus.js';
import { FakeAdapter, FakeSession } from './fake-adapter.js';

const MOCK_VERSION = '0.0.0-mock';
const DELTA_MS = 40;

const SENTENCES = [
  'This is the pahub mock service answering.',
  'Replies stream word by word so the UI can show partial output.',
  'Mention "perm", "ask" or "plan" to see a permission request, a question or a plan approval.',
  'Nothing here talks to a real model.',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (m: Record<string, unknown>): SDKMessage => m as unknown as SDKMessage;

const textOf = (m: SDKUserMessage): string => {
  const content = (m.message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: unknown) =>
      typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text'
        ? String((b as { text?: unknown }).text ?? '')
        : '',
    )
    .join('\n');
};

/** A fake Claude Code session that answers every message with the script above. */
class ScriptedSession extends FakeSession {
  private turn: Promise<void> = Promise.resolve();
  private abort = new AbortController();

  constructor(
    options: StartOptions,
    private readonly adapter: ScriptedAdapter,
  ) {
    super(options);
    this.commands = [
      { name: 'review', description: 'Review a pull request', argumentHint: '<pr>' },
      { name: 'compact', description: 'Compact the conversation', argumentHint: '' },
      { name: 'init', description: 'Create a CLAUDE.md for this project', argumentHint: '' },
    ];
    this.models = [
      { value: 'default', displayName: 'Default', description: 'Recommended model' },
      {
        value: 'opus',
        displayName: 'Opus',
        description: 'Most capable',
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'sonnet',
        displayName: 'Sonnet',
        description: 'Fast and capable',
        supportedEffortLevels: ['low', 'medium', 'high'],
      },
    ];
    this.account = { subscriptionType: 'max', apiProvider: 'firstParty' };
    setImmediate(() => this.out(this.init()));
  }

  get id(): string {
    return this.options.resume ?? this.options.sessionId ?? 'mock';
  }

  override send(m: SDKUserMessage): void {
    super.send(m);
    this.turn = this.turn.then(() => this.reply(m)).catch(() => {});
  }

  override async interrupt(): Promise<void> {
    await super.interrupt();
    this.abort.abort();
  }

  /** Emits unless the session was closed meanwhile. */
  private out(m: SDKMessage): void {
    if (!this.closed) this.emit(m);
  }

  private init(): SDKMessage {
    return msg({
      type: 'system',
      subtype: 'init',
      uuid: randomUUID(),
      session_id: this.id,
      model: this.model ?? 'default',
      permissionMode: this.permissionMode ?? 'default',
      claude_code_version: MOCK_VERSION,
      cwd: this.options.cwd,
      tools: ['Bash', 'Read', 'Edit'],
      mcp_servers: [],
      slash_commands: this.commands.map((c) => c.name),
      apiKeySource: 'none',
      output_style: 'default',
      skills: [],
      plugins: [],
    });
  }

  private async reply(m: SDKUserMessage): Promise<void> {
    const text = textOf(m);
    await this.adapter.record(this, {
      type: 'user',
      uuid: m.uuid ?? randomUUID(),
      message: { role: 'user', content: text },
    });
    if (text.startsWith('/')) return; // e.g. `/effort high`: no turn
    this.abort = new AbortController();
    const started = Date.now();
    const lower = text.toLowerCase();
    if (lower.includes('perm')) await this.permissionTurn();
    else if (lower.includes('ask')) await this.questionTurn();
    else if (lower.includes('plan')) await this.planTurn();
    else await this.say(SENTENCES.slice(0, 3).join(' '));
    const interrupted = this.abort.signal.aborted;
    this.out(
      msg({
        type: 'result',
        subtype: interrupted ? 'error_during_execution' : 'success',
        uuid: randomUUID(),
        session_id: this.id,
        is_error: interrupted,
        duration_ms: Date.now() - started,
        total_cost_usd: 0.0123,
        usage: {},
        modelUsage: { [this.model ?? 'default']: { contextWindow: 200_000 } },
        num_turns: 1,
        result: '',
      }),
    );
  }

  private ask(
    toolName: string,
    input: Record<string, unknown>,
    suggestions: PermissionUpdate[] = [],
  ): Promise<PermissionResult | null> {
    return this.requestPermission(toolName, input, {
      signal: this.abort.signal,
      suggestions,
    });
  }

  private async permissionTurn(): Promise<void> {
    await this.say('I need to look at the files first.');
    const input = { command: 'ls -la', description: 'List files in the project' };
    const r = await this.ask('Bash', input, [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ]);
    if (r?.behavior !== 'allow') {
      await this.say('Okay, I will not run it.');
      return;
    }
    const toolUseId = `toolu_${randomUUID()}`;
    this.out(
      msg({
        type: 'assistant',
        uuid: randomUUID(),
        session_id: this.id,
        parent_tool_use_id: null,
        message: {
          id: `msg_${randomUUID()}`,
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input }],
        },
      }),
    );
    await sleep(DELTA_MS * 3);
    this.out(
      msg({
        type: 'user',
        uuid: randomUUID(),
        session_id: this.id,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: 'README.md\npackage.json\nsrc\n',
              is_error: false,
            },
          ],
        },
      }),
    );
    await this.say('There are three entries: README.md, package.json and src.');
  }

  private async questionTurn(): Promise<void> {
    const question = 'Which approach should I take?';
    const r = await this.ask('AskUserQuestion', {
      questions: [
        {
          question,
          header: 'Approach',
          multiSelect: false,
          options: [
            { label: 'Small refactor', description: 'Keep the structure, tidy the code' },
            { label: 'Rewrite', description: 'Start the module again' },
          ],
        },
      ],
    });
    if (r?.behavior !== 'allow') {
      await this.say('Okay, I will not ask again.');
      return;
    }
    const answers = (r.updatedInput as { answers?: unknown } | undefined)?.answers;
    await this.say(`Thanks. Your answer: ${JSON.stringify(answers ?? null)}.`);
  }

  private async planTurn(): Promise<void> {
    await this.say('Here is what I would do.');
    const r = await this.ask('ExitPlanMode', {
      plan: '## Plan\n\n1. Read the module\n2. Write the failing test\n3. Fix it\n',
    });
    await this.say(r?.behavior === 'allow' ? 'Plan approved, starting.' : 'I will keep planning.');
  }

  /** Streams `text` (message_start, a text block, deltas) and then the final message. */
  private async say(text: string): Promise<void> {
    if (this.abort.signal.aborted) return;
    const apiId = `msg_${randomUUID()}`;
    const base = { session_id: this.id, parent_tool_use_id: null };
    const stream = (event: Record<string, unknown>) =>
      this.out(msg({ type: 'stream_event', uuid: randomUUID(), ...base, event }));
    stream({ type: 'message_start', message: { id: apiId } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    let sent = '';
    for (const word of text.split(/(?<= )/)) {
      if (this.abort.signal.aborted || this.closed) break;
      await sleep(DELTA_MS);
      sent += word;
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } });
    }
    stream({ type: 'content_block_stop', index: 0 });
    const uuid = randomUUID();
    const message = { id: apiId, role: 'assistant', content: [{ type: 'text', text: sent }] };
    this.out(msg({ type: 'assistant', uuid, ...base, message }));
    await this.adapter.record(this, { type: 'assistant', uuid, message });
  }
}

/** FakeAdapter whose sessions follow the script and leave a history behind. */
class ScriptedAdapter extends FakeAdapter {
  constructor(private readonly claudeDir: string) {
    super();
  }

  override start(o: StartOptions): FakeSession {
    const s = new ScriptedSession(o, this);
    this.started.push(s);
    return s;
  }

  /**
   * Adds a message to the session's history (what `getSessionMessages` returns)
   * and touches a placeholder transcript in the fixture config dir, as the
   * real CLI would, so the service's watcher re-indexes the chat.
   */
  async record(
    s: ScriptedSession,
    m: { type: 'user' | 'assistant'; uuid: string; message: unknown },
  ): Promise<void> {
    const entry = this.sessions.get(s.id) ?? {
      info: {
        sessionId: s.id,
        summary: '',
        lastModified: Date.now(),
        fileSize: 0,
        cwd: s.options.cwd,
        createdAt: Date.now(),
      },
      messages: [],
    };
    const text = typeof (m.message as { content?: unknown }).content === 'string';
    if (m.type === 'user' && !entry.info.firstPrompt && text) {
      entry.info.firstPrompt = (m.message as { content: string }).content;
    }
    entry.messages.push({
      ...m,
      session_id: s.id,
      parent_tool_use_id: null,
      parent_agent_id: null,
    } as SessionMessage);
    entry.info.lastModified = Date.now();
    entry.info.fileSize = (entry.info.fileSize ?? 0) + 100;
    this.sessions.set(s.id, entry);
    const dir = join(this.claudeDir, 'projects', 'mock');
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${s.id}.jsonl`), '{"mock":true}\n');
  }
}

export type MockOptions = {
  sessions?: number;
  projects?: number;
  bigSessionMessages?: number;
  port?: number;
  token?: string;
  installSignalHandlers?: boolean;
};

export type MockService = {
  svc: ServiceHandle;
  dataDir: string;
  claudeDir: string;
  adapter: FakeAdapter;
  /** Resolves once the temp dirs are gone after the service closed. */
  removed: Promise<void>;
};

/** Starts the mock service; its temp dirs are removed when it closes. */
export const startMockService = async (o: MockOptions = {}): Promise<MockService> => {
  const root = await mkdtemp(join(tmpdir(), 'pahub-mock-'));
  const dataDir = join(root, 'data');
  const claudeDir = join(root, 'claude');
  await mkdir(join(claudeDir, 'projects'), { recursive: true });
  const adapter = new ScriptedAdapter(claudeDir);
  const corpus = generateCorpus({
    sessions: o.sessions ?? 1000,
    projects: o.projects ?? 50,
    bigSessionMessages: o.bigSessionMessages ?? 2000,
  });
  for (const [id, s] of corpus.sessions) adapter.sessions.set(id, s);

  // One "external" Claude Code session, so the UI's external states and resume block show.
  const externalId = corpus.sessions.keys().next().value;
  const externals = externalId
    ? [
        {
          pid: 4242,
          cwd: corpus.sessions.get(externalId)?.info.cwd ?? '/',
          kind: 'interactive',
          startedAt: Date.now() - 10 * 60_000,
          sessionId: externalId,
          status: 'idle',
        },
      ]
    : [];

  try {
    const svc = await startService({
      dataDir,
      claudeConfigDir: claudeDir,
      adapter,
      claude: { path: 'mock-claude', version: MOCK_VERSION },
      externalRun: async () => JSON.stringify(externals),
      ...(o.port === undefined ? {} : { port: o.port }),
      ...(o.token === undefined ? {} : { token: o.token }),
      installSignalHandlers: o.installSignalHandlers ?? true,
    });
    const removed = new Promise<void>((resolve) =>
      svc.onClosed(() => {
        void rm(root, { recursive: true, force: true })
          .catch(() => {})
          .finally(resolve);
      }),
    );
    return { svc, dataDir, claudeDir, adapter, removed };
  } catch (err) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
};

/** `--name value` / `--name=value` from argv, else the env variable. */
const option = (name: string, envName: string): string | undefined => {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return process.env[envName] || undefined;
};

const isEntry = (): boolean =>
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry()) {
  const portText = option('port', 'PAHUB_MOCK_PORT');
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) {
    process.stderr.write(`Invalid port: ${portText}\n`);
    process.exit(1);
  }
  const token = option('token', 'PAHUB_MOCK_TOKEN');
  startMockService({
    ...(port === undefined ? {} : { port }),
    ...(token === undefined ? {} : { token }),
  })
    .then(async ({ dataDir, claudeDir, removed }) => {
      const discovery = await readDiscovery(dataDir);
      process.stdout.write(`${JSON.stringify({ ...discovery, dataDir, claudeDir })}\n`);
      void removed.then(() => process.exit(0));
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
