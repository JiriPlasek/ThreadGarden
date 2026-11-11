/**
 * Mock Threadgarden service for UI development and Playwright
 * (`pnpm --filter @threadgarden/service mock`): the real service (`startService`)
 * over a synthetic history (`generateCorpus`) and a scripted fake Claude Code.
 *
 * Script, per user message:
 * - every reply streams a few sentences with partial (`stream_event`) messages;
 * - a message containing "perm" asks for permission to run a Bash command;
 * - "ask" asks an AskUserQuestion question; "plan" asks to approve a plan
 *   (ExitPlanMode);
 * - "agent" runs an Explore subagent on `haiku` (an Agent tool call and its
 *   task) that reports progress, spawns a nested subagent whose model is
 *   streamed, and completes after about 3 s;
 * - "server" starts a background shell task ("npm run dev") that keeps
 *   running until it is stopped with `chat.stopTask` (or the chat ends);
 * - "limit" reaches the (mock) account's usage limit for `MOCK_LIMIT_MS`
 *   (2 min): that turn and every turn until the reset is refused, like the
 *   CLI does (a rejected `rate_limit_event`, an assistant message with the
 *   `rate_limit` error, an error result), so "Send when the limit resets"
 *   can be tried.
 *
 * Usage (v1.3 B): every turn reports the mock account's 5-hour window in a
 * `rate_limit_event` (a little more used each turn, a warning from 80 %), and
 * sessions answer the experimental usage reading with 5-hour, 7-day and
 * per-model windows. The service starts with that usage already known, so the
 * usage meter shows at once.
 *
 * A new chat is named after its first turn (v1.2 C1): the fake small model
 * answers about half a second later with "Mock: " and the first words of the
 * first message.
 *
 * Everything lives in temporary directories (Threadgarden data dir and a fixture
 * `CLAUDE_CONFIG_DIR`), removed on exit. The mock's fake Claude Code writes a
 * placeholder transcript per chat into that fixture, like the real CLI, so the
 * watcher and indexer pick new chats up. On start it prints the discovery
 * record (port, token, …) as one JSON line on stdout. `THREADGARDEN_MOCK_PORT` and
 * `THREADGARDEN_MOCK_TOKEN` (or `--port` / `--token`) fix the port and token.
 *
 * Remote machines (v1.4): `--remote [--remote-port <port>] --pairing-code
 * <code>` starts a second machine to pair with instead: headless, named
 * "Ubuntu", with a history of its own (20 chats in the project `tg-cli`), its
 * device listener on 127.0.0.1 (default port 47380) and `<code>` kept live as
 * its pairing code. Loopback is for tests only: the real service listens on
 * private addresses only (`bin.ts` never sets the addresses), ledger Ruling R4.
 *
 * Power control (v1.4, plan 4): `--fake-tasmota [--fake-tasmota-port <port>]`
 * also starts a fake Tasmota Zigbee bridge on 127.0.0.1 (password
 * `FAKE_TASMOTA_PASSWORD`) with one plug, `MockPlug`, drawing 47 W, and prints
 * the fake's own address (`127.0.0.1:<port>`) on stderr. It is meant for
 * `--remote` (a headless machine, which offers power control). The mock never
 * powers anything off: its shutdown sequence ends in `mockPoweroff`.
 *
 * Moving a chat (protocol 9): the mock's folders are not on disk, so no real
 * git runs for a move. A folder named after one of the mocks' projects
 * (`proj-N`, `tg-cli`) is a clean clone of it on `main`, wherever it is (the
 * folder a chat moved to as well, as if Claude had cloned it); any other
 * folder is not a git repo. No folder is made for a chat moved here (every
 * folder counts as existing). The
 * remote's Create in is `<temp>/projects`, so a chat moved there goes to
 * `<temp>/projects/<repo>`. Like the SDK, a chat resumed from Threadgarden's
 * store records its turns in that store only. Threadgarden's first note in
 * a moved chat gets the plain reply (its words would trigger "ask"). The
 * mock-only method `mock.forgetMoves` (local callers only; no real service
 * has it) forgets every move, so a spec that failed mid-move leaves no chat
 * moved away for the specs after it.
 *
 * Updating (protocol 10): both mocks pretend to update, never touching systemd
 * or GitHub. `update.latest` answers `THREADGARDEN_MOCK_LATEST` (default
 * 0.99.0). `update.start` goes through the stages about 300 ms apart
 * (`THREADGARDEN_MOCK_UPDATE_STEP_MS` changes it), then pretends to restart:
 * the devices' sockets drop, later `hello`s report the new
 * version and `update.status` is `done`. The mock-only methods (local callers
 * only) `mock.failNextUpdate {reason}` (the next update fails with it) and
 * `mock.setBusy {count}` (the chats an update would stop) steer it, and
 * `mock.resetUpdate` puts it back to its start. The
 * `update` capability is offered on every OS.
 *
 * A machine that's away (away machine spec): the remote mock's mock-only
 * methods (local callers only) `mock.goAway` (it is switched off: its devices'
 * sockets drop, no device gets in, as a PC without power never answers, and
 * its plug `MockPlug` is off, 0 W) and `mock.comeBack` (on again at once).
 * Its plug switched on through the fake Tasmota while it's away, as
 * Threadgarden does to deliver a message, brings it back about 2 s later
 * (`MOCK_BOOT_MS`). The main mock has neither method.
 *
 * The phone (`MOCK_PHONE=1`, or `--phone`): the main mock answers like the
 * phone's core, for the UI built with `VITE_THREADGARDEN_PHONE=1`. Its `hello`
 * names an empty machine as the core does (`linux`, not headless, no home, no
 * capabilities), it has no chats, projects, external sessions or usage of its
 * own, and `system.status` finds no Claude Code. It refuses (`METHOD_NOT_FOUND`)
 * what the core refuses, read from the core's contract table
 * (`packages/protocol/test/fixtures/core-answers/methods.json`), so it follows
 * the core as it learns more. With `--pair-port <port>
 * --pairing-code <code>` it pairs as "Phone" with the remote mock whose device
 * listener is on 127.0.0.1:`<port>`, once that one answers, and holds its
 * token, as the core does: the UI never unlocks it. The port has no default,
 * so the mock never tries a real machine's.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  UPDATE_ERRORS,
  UpdateFailureSchema,
  VERSION_PATTERN,
  type GitState,
  type UpdateFailure,
  type UpdateStage,
  type UpdateStartResult,
  type UpdateStatus,
} from '@threadgarden/protocol';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import { readDiscovery } from '../discovery.js';
import { findProjectIcon } from '../history/project-icons.js';
import {
  PAIRING_ALPHABET,
  isWellFormedPairingCode,
  normalisePairingCode,
} from '../machine/devices.js';
import { startService, type ServiceHandle } from '../main.js';
import { CREATE_IN_KEY } from '../projects/maker.js';
import { startFakeTasmota, type FakeDevice, type FakeTasmota } from './fake-tasmota.js';
import type { MoveGit } from '../server/handlers/move.js';
import { ServiceError } from '../server/router.js';
import type { Updater } from '../update/updater.js';
import { REMOTE_PORT } from '../server/remote-server.js';
import type {
  OneShotOptions,
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
/** The model named on the scripted replies (v1.3 analytics). */
const MOCK_MODEL = 'claude-sonnet-4-5';
/** The synthetic history spans this many days before the mock's start (v1.3 analytics). */
const HISTORY_DAYS = 150;
const DELTA_MS = 40;
/** The "agent" subagent reports progress this often, `AGENT_STEPS.length` times (~3 s). */
const AGENT_STEP_MS = 600;
const AGENT_STEPS = [
  { tool: 'Glob', summary: 'Listing the project files' },
  { tool: 'Read', summary: 'Reading package.json' },
  { tool: 'Grep', summary: 'Searching for the entry points' },
  { tool: 'Read', summary: 'Reading the service entry point' },
  { tool: 'Read', summary: 'Reading the desktop app layout' },
];
const DEV_SERVER_COMMAND = 'npm run dev';
/** How long "limit" keeps the mock account refused. */
export const MOCK_LIMIT_MS = 2 * 60_000;
/** The mock account's 5-hour window resets this long after the service starts. */
const MOCK_WINDOW_MS = 3 * 3_600_000 + 12 * 60_000;
/** 5-hour utilization (a fraction, like the CLI's events) at start, and added per turn. */
const MOCK_USAGE_START = 0.42;
const MOCK_USAGE_STEP = 0.03;

/** The `--remote` mock (v1.4): a second machine's name, its one project and its history's size. */
export const REMOTE_MACHINE_NAME = 'Ubuntu';
export const REMOTE_PROJECT_PATH = '/home/owner/tg-cli';
const REMOTE_SESSIONS = 20;
/**
 * The fixed pairing code is made live again this often: a spent or
 * expired code is back at once, so a spec can pair again right away.
 */
const PAIRING_REFRESH_MS = 1_000;

/** How Threadgarden's first note in a moved chat starts (desktop `move/note.ts`). */
const THREADGARDEN_NOTE = '[Threadgarden] ';
/** The mocks' projects: the corpus's `proj-N` and the remote's `tg-cli`. */
const MOCK_REPO = /^(proj-\d+|tg-cli)$/;
const mockOrigin = (repo: string): string => `https://github.com/owner/${repo}.git`;

/** The mock project a folder is a clone of (by its name, wherever it is), else null. */
const mockRepoOf = (cwd: string): string | null => {
  const name = posix.basename(cwd.replace(/\\/g, '/'));
  return MOCK_REPO.test(name) ? name : null;
};

/** The git a move reads, faked (see the file comment): no real git runs on the mock's folders. */
const mockMoveGit: MoveGit = {
  state: async (cwd): Promise<GitState> => {
    const repo = mockRepoOf(cwd);
    return repo ? { kind: 'clean', branch: 'main', origin: mockOrigin(repo) } : { kind: 'notRepo' };
  },
  originUrl: async (cwd) => {
    const repo = mockRepoOf(cwd);
    return repo ? mockOrigin(repo) : null;
  },
};

const SENTENCES = [
  'This is the Threadgarden mock service answering.',
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

/** The "agent" subagent's nested subagent: its task, its Agent call, its one tool call. */
type NestedAgent = { taskId: string; toolUseId: string; parentToolUseId: string; grepId: string };

/** A fake Claude Code session that answers every message with the script above. */
class ScriptedSession extends FakeSession {
  private turn: Promise<void> = Promise.resolve();
  private abort = new AbortController();
  /** Running "server" shell tasks: task id → command. */
  private readonly shells = new Map<string, string>();
  /** Running "agent" subagent tasks: task id → its stop signal. */
  private readonly agents = new Map<string, AbortController>();

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
    this.usage = async () => this.adapter.usageReading();
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

  /** Stops a running "agent" or "server" task, like the CLI: killed, then a stopped notification. */
  override async stopTask(taskId: string): Promise<void> {
    await super.stopTask(taskId);
    const agent = this.agents.get(taskId);
    if (agent) {
      agent.abort();
      return;
    }
    const command = this.shells.get(taskId);
    if (command === undefined) throw new Error(`No running task ${taskId}`);
    this.shells.delete(taskId);
    this.out(this.system('task_updated', { task_id: taskId, patch: { status: 'killed' } }));
    this.out(
      this.system('task_notification', {
        task_id: taskId,
        status: 'stopped',
        output_file: '',
        summary: `${command} was stopped`,
      }),
    );
    this.out(this.backgroundTasks());
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
    // Threadgarden's first note in a moved chat gets the plain reply: it says "stop and ask".
    const lower = text.startsWith(THREADGARDEN_NOTE) ? '' : text.toLowerCase();
    if (lower.includes('limit')) this.adapter.reachLimit();
    if (this.adapter.limited()) {
      await this.refusedTurn(started);
      return;
    }
    this.out(this.adapter.rateLimitEvent(this.id));
    if (lower.includes('perm')) await this.permissionTurn();
    else if (lower.includes('ask')) await this.questionTurn();
    else if (lower.includes('plan')) await this.planTurn();
    else if (lower.includes('agent')) await this.agentTurn();
    else if (lower.includes('server')) await this.serverTurn();
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
    // As the SDK: a prediction only for a session started with `promptSuggestions`.
    if (!interrupted && this.options.promptSuggestions === true && lower.includes('suggest')) {
      this.out(
        msg({
          type: 'prompt_suggestion',
          uuid: randomUUID(),
          session_id: this.id,
          suggestion: 'Run the tests and fix any failures',
        }),
      );
    }
  }

  /** A turn the usage limit refuses, as the CLI reports one. */
  private async refusedTurn(started: number): Promise<void> {
    this.out(this.adapter.rateLimitEvent(this.id));
    await sleep(DELTA_MS * 3);
    const reset = new Date(this.adapter.limitedUntil);
    const at = `${String(reset.getHours()).padStart(2, '0')}:${String(reset.getMinutes()).padStart(2, '0')}`;
    const uuid = randomUUID();
    const message = {
      id: `msg_${randomUUID()}`,
      role: 'assistant',
      content: [{ type: 'text', text: `You've hit your usage limit (mock) · resets ${at}` }],
    };
    this.out(
      msg({
        type: 'assistant',
        uuid,
        session_id: this.id,
        parent_tool_use_id: null,
        error: 'rate_limit',
        message,
      }),
    );
    await this.adapter.record(this, { type: 'assistant', uuid, message });
    this.out(
      msg({
        type: 'result',
        subtype: 'success',
        uuid: randomUUID(),
        session_id: this.id,
        is_error: true,
        duration_ms: Date.now() - started,
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        num_turns: 1,
        result: message.content[0]!.text,
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
    const toolUseId = this.toolUse('Bash', input);
    await sleep(DELTA_MS * 3);
    this.toolResult(toolUseId, 'README.md\npackage.json\nsrc\n');
    await this.say('There are three entries: README.md, package.json and src.');
  }

  /**
   * A foreground Explore subagent on the `haiku` model (task_started, progress
   * every step, then its end). Its second step spawns a nested subagent (a
   * depth-2 task with `parent_task_id`) whose model is only known from the
   * messages it streams, like a real one without a `model` input.
   */
  private async agentTurn(): Promise<void> {
    await this.say('I will ask a subagent to explore the project.');
    const description = 'Explore the project structure';
    const prompt = 'Map the main parts of this project.';
    const toolUseId = this.toolUse('Agent', {
      description,
      subagent_type: 'Explore',
      model: 'haiku',
      prompt,
    });
    const taskId = `a${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const task = { task_id: taskId, tool_use_id: toolUseId, description, subagent_type: 'Explore' };
    this.out(
      this.system('task_started', {
        ...task,
        task_type: 'local_agent',
        is_backgrounded: false,
        prompt,
        spawn_depth: 1,
      }),
    );
    const stop = new AbortController();
    this.agents.set(taskId, stop);
    const started = Date.now();
    const usage = (steps: number) => ({
      total_tokens: 1800 * steps,
      tool_uses: steps,
      duration_ms: Date.now() - started,
    });
    let nested: NestedAgent | undefined;
    let steps = 0;
    for (const step of AGENT_STEPS) {
      await sleep(AGENT_STEP_MS);
      if (this.abort.signal.aborted || stop.signal.aborted || this.closed) break;
      steps++;
      this.out(
        this.system('task_progress', {
          ...task,
          usage: usage(steps),
          last_tool_name: step.tool,
          summary: step.summary,
        }),
      );
      if (steps === 2) nested = this.nestedAgent(taskId, toolUseId);
    }
    if (nested) this.endNestedAgent(nested, steps === AGENT_STEPS.length);
    this.agents.delete(taskId);
    const done = steps === AGENT_STEPS.length;
    this.out(
      this.system('task_updated', {
        task_id: taskId,
        patch: { status: done ? 'completed' : 'killed', end_time: Date.now() },
      }),
    );
    const summary = done
      ? 'The project has a service, a protocol package and a desktop app.'
      : 'The subagent was stopped.';
    this.out(
      this.system('task_notification', {
        task_id: taskId,
        tool_use_id: toolUseId,
        status: done ? 'completed' : 'stopped',
        output_file: '',
        summary,
        usage: usage(steps),
      }),
    );
    this.toolResult(toolUseId, summary, !done);
    await this.say(done ? `The subagent reports: ${summary}` : 'The subagent did not finish.');
  }

  /** The "agent" subagent's own subagent: its Agent call and first message come from inside the parent. */
  private nestedAgent(parentTaskId: string, parentToolUseId: string): NestedAgent {
    const description = 'Find the entry points';
    const prompt = 'List the entry points of the service and the desktop app.';
    const toolUseId = this.toolUse(
      'Agent',
      { description, subagent_type: 'general-purpose', prompt },
      parentToolUseId,
    );
    const taskId = `a${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    this.out(
      this.system('task_started', {
        task_id: taskId,
        tool_use_id: toolUseId,
        description,
        subagent_type: 'general-purpose',
        task_type: 'local_agent',
        is_backgrounded: false,
        parent_task_id: parentTaskId,
        prompt,
        spawn_depth: 2,
      }),
    );
    const grepId = this.toolUse('Grep', { pattern: 'main' }, toolUseId, 'claude-sonnet-4-5');
    return { taskId, toolUseId, parentToolUseId, grepId };
  }

  private endNestedAgent(n: NestedAgent, done: boolean): void {
    const summary = done ? 'Two entry points: main.ts and the app layout.' : 'Stopped.';
    this.toolResult(n.grepId, 'src/main.ts\napps/desktop/src/routes/+layout.svelte\n', false, {
      parent: n.toolUseId,
    });
    this.out(
      this.system('task_notification', {
        task_id: n.taskId,
        tool_use_id: n.toolUseId,
        status: done ? 'completed' : 'stopped',
        output_file: '',
        summary,
        usage: { total_tokens: 2400, tool_uses: 1, duration_ms: AGENT_STEP_MS * 3 },
      }),
    );
    this.toolResult(n.toolUseId, summary, !done, { parent: n.parentToolUseId });
  }

  /** A background shell ("npm run dev") that runs until `stopTask`. */
  private async serverTurn(): Promise<void> {
    await this.say('Starting the dev server in the background.');
    const toolUseId = this.toolUse('Bash', {
      command: DEV_SERVER_COMMAND,
      description: 'Start the dev server',
      run_in_background: true,
    });
    const taskId = `b${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    this.shells.set(taskId, DEV_SERVER_COMMAND);
    // Like the CLI: a task started in the background joins the level before its task_started.
    this.out(this.backgroundTasks());
    this.out(
      this.system('task_started', {
        task_id: taskId,
        tool_use_id: toolUseId,
        description: DEV_SERVER_COMMAND,
        task_type: 'local_bash',
        is_backgrounded: true,
      }),
    );
    await sleep(DELTA_MS * 3);
    this.toolResult(toolUseId, `Command running in background with ID: ${taskId}`);
    await this.say('The dev server is running at http://localhost:5173.');
  }

  private system(subtype: string, extra: Record<string, unknown>): SDKMessage {
    return msg({ type: 'system', subtype, uuid: randomUUID(), session_id: this.id, ...extra });
  }

  /** The level of running background tasks (`background_tasks_changed`). */
  private backgroundTasks(): SDKMessage {
    return this.system('background_tasks_changed', {
      tasks: [...this.shells].map(([taskId, command]) => ({
        task_id: taskId,
        task_type: 'local_bash',
        description: command,
      })),
    });
  }

  /**
   * Emits an assistant message with one tool call (inside the subagent of
   * `parent` when given, streamed with `model`); returns its tool_use id.
   */
  private toolUse(
    name: string,
    input: Record<string, unknown>,
    parent: string | null = null,
    model?: string,
  ): string {
    const toolUseId = `toolu_${randomUUID()}`;
    this.out(
      msg({
        type: 'assistant',
        uuid: randomUUID(),
        session_id: this.id,
        parent_tool_use_id: parent,
        message: {
          id: `msg_${randomUUID()}`,
          role: 'assistant',
          ...(model === undefined ? {} : { model }),
          content: [{ type: 'tool_use', id: toolUseId, name, input }],
        },
      }),
    );
    return toolUseId;
  }

  private toolResult(
    toolUseId: string,
    content: string,
    isError = false,
    o: { parent?: string } = {},
  ): void {
    this.out(
      msg({
        type: 'user',
        uuid: randomUUID(),
        session_id: this.id,
        parent_tool_use_id: o.parent ?? null,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
        },
      }),
    );
  }

  private async questionTurn(): Promise<void> {
    const question = 'Which approach should I take?';
    const r = await this.ask('AskUserQuestion', {
      questions: [
        {
          question,
          header: 'Approach',
          multiSelect: false,
          // Previews show beside the options, as in the terminal.
          options: [
            {
              label: 'Small refactor',
              description: 'Keep the structure, tidy the code',
              preview:
                'src/parser/\n├── index.ts      (tidied)\n├── tokens.ts\n└── rules.ts      (tidied)',
            },
            {
              label: 'Rewrite',
              description: 'Start the module again',
              preview:
                'src/parser/\n├── index.ts      (new)\n├── lexer.ts      (new)\n└── grammar.ts    (new)',
            },
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
    const message = {
      id: apiId,
      role: 'assistant',
      model: MOCK_MODEL,
      content: [{ type: 'text', text: sent }],
      usage: { input_tokens: 1200, output_tokens: sent.length, cache_read_input_tokens: 18_000 },
    };
    this.out(msg({ type: 'assistant', uuid, ...base, message }));
    await this.adapter.record(this, { type: 'assistant', uuid, message });
  }
}

/** FakeAdapter whose sessions follow the script and leave a history behind. */
class ScriptedAdapter extends FakeAdapter {
  /** The mock account's 5-hour window (v1.3 B): used fraction and reset time. */
  private fiveHour = MOCK_USAGE_START;
  private windowResets = Date.now() + MOCK_WINDOW_MS;
  /** Until when the mock account is refused ("limit"); 0 when it is not. */
  limitedUntil = 0;

  constructor(private readonly claudeDir: string) {
    super();
  }

  limited(): boolean {
    if (this.limitedUntil === 0) return false;
    if (Date.now() < this.limitedUntil) return true;
    // The limit reset: a fresh window.
    this.limitedUntil = 0;
    this.fiveHour = 0.05;
    this.windowResets = Date.now() + 5 * 3_600_000;
    return false;
  }

  reachLimit(): void {
    if (this.limited()) return;
    this.limitedUntil = Date.now() + MOCK_LIMIT_MS;
    this.fiveHour = 1;
  }

  /** The `rate_limit_event` a turn starts with; each allowed turn uses a little more. */
  rateLimitEvent(sessionId: string): SDKMessage {
    const limited = this.limited();
    if (!limited) this.fiveHour = Math.min(0.99, this.fiveHour + MOCK_USAGE_STEP);
    const resetsAt = limited ? this.limitedUntil : this.windowResets;
    return msg({
      type: 'rate_limit_event',
      uuid: randomUUID(),
      session_id: sessionId,
      rate_limit_info: {
        status: limited ? 'rejected' : this.fiveHour >= 0.8 ? 'allowed_warning' : 'allowed',
        rateLimitType: 'five_hour',
        utilization: this.fiveHour,
        // Seconds, like Claude Code 2.1.314.
        resetsAt: Math.floor(resetsAt / 1000),
      },
    });
  }

  /** The experimental usage reading (`SDKControlGetUsageResponse`) of the mock account. */
  usageReading(): unknown {
    this.limited();
    const iso = (t: number) => new Date(Math.floor(t / 1000) * 1000).toISOString();
    const weekly = Date.now() + 4 * 24 * 3_600_000;
    return {
      session: { total_cost_usd: 0.0123 },
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: {
          utilization: Math.round(this.fiveHour * 100),
          resets_at: iso(this.limitedUntil || this.windowResets),
        },
        seven_day: { utilization: 23, resets_at: iso(weekly) },
        seven_day_opus: { utilization: 8, resets_at: iso(weekly) },
        model_scoped: [{ display_name: 'Fable', utilization: 4, resets_at: iso(weekly) }],
        extra_usage: {
          is_enabled: false,
          monthly_limit: null,
          used_credits: null,
          utilization: null,
        },
      },
      behaviors: null,
    };
  }

  override start(o: StartOptions): FakeSession {
    const s = new ScriptedSession(o, this);
    this.started.push(s);
    return s;
  }

  /** The fake small model (v1.2 C1 titles): "Mock: " and the message's first four words. */
  override async oneShot(o: OneShotOptions): Promise<string> {
    this.oneShots.push(o);
    await new Promise((r) => setTimeout(r, 500));
    const message = /<first_message>\n([\s\S]*?)\n<\/first_message>/.exec(o.prompt)?.[1] ?? '';
    const words = message.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
    return `Mock: ${words || 'new chat'}`;
  }

  /**
   * Adds a message to the session's history (what `getSessionMessages` returns)
   * and touches a placeholder transcript in the fixture config dir, as the
   * real CLI would, so the service's watcher re-indexes the chat. A session
   * resumed from a store (a chat moved here) records into that store only, as
   * the SDK does.
   */
  async record(
    s: ScriptedSession,
    m: { type: 'user' | 'assistant'; uuid: string; message: unknown },
  ): Promise<void> {
    const store = s.options.sessionStore;
    if (store) {
      const { cwd } = s.options;
      const line = { ...m, sessionId: s.id, timestamp: new Date().toISOString(), cwd };
      await store.append({ projectKey: cwd, sessionId: s.id }, [line]);
      return;
    }
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
      // Like the CLI's transcript entries (v1.3 analytics reads it).
      timestamp: new Date().toISOString(),
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
  /**
   * v1.4: a second machine to pair with instead (see the file comment): its
   * device listener on 127.0.0.1:`port` (0: any free port; tests only) and
   * the well-formed `pairingCode` it keeps live.
   */
  remote?: { port: number; pairingCode: string };
  /** Plan 4: a fake Tasmota Zigbee bridge with the plug `MockPlug` (port 0: any free one). */
  fakeTasmota?: { port: number };
  /**
   * Answer like the phone's core (see the file comment), paired with the remote
   * mock whose device listener is on 127.0.0.1:`pairWith.port`, when given.
   */
  phone?: { pairWith?: { port: number; pairingCode: string } };
};

/** What the mock does where a machine would power off. */
const mockPoweroff = async (): Promise<void> => {
  process.stderr.write('mock: would power off\n');
};

/** The web password of the mock's fake Tasmota switch (user `admin`). */
export const FAKE_TASMOTA_PASSWORD = 'mock-switch';

export type MockService = {
  svc: ServiceHandle;
  dataDir: string;
  claudeDir: string;
  adapter: FakeAdapter;
  /** The fake switch, when `fakeTasmota` was asked for; closed with the service. */
  fakeTasmota?: FakeTasmota;
  /** The phone's: resolves once it paired with `phone.pairWith` (rejects when it gave up). */
  paired?: Promise<void>;
  /** Resolves once the temp dirs are gone after the service closed. */
  removed: Promise<void>;
};

/** A rounded square with a letter, as a mock project's favicon. */
const iconSvg = (fill: string, letter: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
  `<rect width="32" height="32" rx="7" fill="${fill}"/>` +
  `<text x="16" y="22" font-family="sans-serif" font-size="18" font-weight="700" ` +
  `text-anchor="middle" fill="#fff">${letter}</text></svg>`;

/**
 * Icon fixtures for some mock projects (v1.3 §5), laid out the ways real
 * projects keep them, so the real icon search runs on them. The corpus's
 * project folders (`/work/proj-N`) are not on disk; their icons live in
 * `<temp>/projects/proj-N` instead. The other projects get letter tiles.
 */
const MOCK_ICONS: { project: number; files: Record<string, string> }[] = [
  { project: 0, files: { 'favicon.svg': iconSvg('#2563eb', 'P') } },
  {
    project: 1,
    files: {
      'index.html': '<link rel="icon" type="image/svg+xml" href="/brand.svg">',
      'public/brand.svg': iconSvg('#0d9488', 'B'),
    },
  },
  {
    project: 2,
    files: {
      'src/app.html': '<link rel="icon" href="%sveltekit.assets%/favicon.svg" />',
      'static/favicon.svg': iconSvg('#c026d3', 'S'),
    },
  },
  { project: 4, files: { 'apps/web/public/favicon.svg': iconSvg('#ea580c', 'W') } },
  { project: 7, files: { '.github/logo.svg': iconSvg('#16a34a', 'G') } },
];

const writeMockIcons = async (root: string): Promise<Map<string, string>> => {
  const dirs = new Map<string, string>();
  for (const { project, files } of MOCK_ICONS) {
    const dir = join(root, 'projects', `proj-${project}`);
    for (const [rel, body] of Object.entries(files)) {
      const file = join(dir, ...rel.split('/'));
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, body);
    }
    dirs.set(`/work/proj-${project}`, dir);
  }
  return dirs;
};

/**
 * Random bytes that make `DeviceRegistry.createPairingCode` produce `code`
 * (each byte an alphabet index, below its rejection limit).
 */
const fixedPairingRandom = (code: string): ((n: number) => Buffer) => {
  const indexes = [...normalisePairingCode(code)].map((c) => PAIRING_ALPHABET.indexOf(c));
  return (n) => Buffer.from(Array.from({ length: n }, (_, i) => indexes[i % indexes.length]!));
};

/** The mock's own test reset (see the file comment); not a protocol method. */
export const MOCK_FORGET_MOVES = 'mock.forgetMoves';

/** A machine that's away (see the file comment): the remote mock goes off, and comes back. */
export const MOCK_GO_AWAY = 'mock.goAway';
export const MOCK_COME_BACK = 'mock.comeBack';
/** How long the remote mock takes to boot once its plug is switched on while it's away. */
export const MOCK_BOOT_MS = 2_000;

/**
 * The remote mock as a machine that can be switched off (away machine spec).
 * Away, every device link is cut and no new one gets in, as a PC without
 * power never answers, and its plug is off (0 W). The plug switched on through
 * the fake Tasmota, as Threadgarden does to deliver a message, brings it back
 * `MOCK_BOOT_MS` later; `comeBack` brings it back at once.
 */
class MockPresence {
  private away = false;
  private booting: ReturnType<typeof setTimeout> | undefined;
  private svc: ServiceHandle | undefined;
  private plug: FakeDevice | undefined;

  /** What the device listener asks before letting anyone in. */
  readonly reachable = (): boolean => !this.away;

  /** The service exists only after this (`reachable` is passed to `startService`). */
  attach(svc: ServiceHandle): void {
    this.svc = svc;
    svc.onClosed(() => this.stopBooting());
  }

  /** The machine's plug on the fake switch, which tells this when it is switched on. */
  makePlug(): FakeDevice {
    let on = true;
    const switchedOn = (): void => this.switchedOn();
    this.plug = {
      name: 'MockPlug',
      watts: 47,
      get on() {
        return on;
      },
      set on(value: boolean) {
        const was = on;
        on = value;
        if (value && !was) switchedOn();
      },
    };
    return this.plug;
  }

  goAway(): void {
    this.stopBooting();
    this.away = true;
    this.svc?.dropDevices();
    if (this.plug) this.plug.on = false;
  }

  comeBack(): void {
    this.stopBooting();
    this.away = false;
    if (this.plug) this.plug.on = true;
  }

  /** Power came back while away: the machine boots. */
  private switchedOn(): void {
    if (!this.away || this.booting) return;
    this.booting = setTimeout(() => {
      this.booting = undefined;
      this.away = false;
    }, MOCK_BOOT_MS);
    this.booting.unref();
  }

  private stopBooting(): void {
    clearTimeout(this.booting);
    this.booting = undefined;
  }
}

/** Updating (protocol 10): the next update fails with `reason`; the busy count `update.start` sees. */
export const MOCK_FAIL_NEXT_UPDATE = 'mock.failNextUpdate';
export const MOCK_SET_BUSY = 'mock.setBusy';
/** Back to the version the mock started with, no status, no busy chats, no queued failure. */
export const MOCK_RESET_UPDATE = 'mock.resetUpdate';

/** The release the main mock's `update.latest` answers; the env variable changes it. */
const mockLatest = (): string => process.env.THREADGARDEN_MOCK_LATEST || '0.99.0';

/** The step between two stages of a pretend update; the env variable changes it. */
const UPDATE_STEP_MS = Number(process.env.THREADGARDEN_MOCK_UPDATE_STEP_MS) || 300;

const FailNextParams = z.object({ reason: UpdateFailureSchema });
const SetBusyParams = z.object({ count: z.number().int().min(0) });

/**
 * A machine that updates itself in pretence: the stages the real updater goes
 * through, then a restart that drops the devices and reports the new version
 * in later `hello`s. No download, no systemd.
 */
class MockUpdater implements Updater {
  /** What `hello` reports; the pretend restart changes it. */
  version = pkg.version;
  private current: UpdateStatus = { state: 'idle' };
  private busy = 0;
  private failure: UpdateFailure | undefined;
  private closed = false;
  private epoch = 0;
  private svc: ServiceHandle | undefined;

  /** The service exists only after the updater (it is passed to `startService`). */
  attach(svc: ServiceHandle): void {
    this.svc = svc;
    svc.onClosed(() => {
      this.closed = true;
    });
  }

  failNext(reason: UpdateFailure): void {
    this.failure = reason;
  }

  setBusy(count: number): void {
    this.busy = count;
  }

  /** A test's clean slate: an update still in its steps stops there (the epoch no longer matches). */
  reset(): void {
    this.epoch++;
    this.version = pkg.version;
    this.current = { state: 'idle' };
    this.busy = 0;
    this.failure = undefined;
  }

  // The `update` capability is offered on every OS, unlike the real updater's.
  supported(): boolean {
    return true;
  }

  status(): UpdateStatus {
    return this.current;
  }

  async reconcile(): Promise<void> {}

  async start(version: string, force: boolean): Promise<UpdateStartResult> {
    if (!VERSION_PATTERN.test(version)) {
      throw new ServiceError(UPDATE_ERRORS.INVALID_VERSION, 'That is not a release version');
    }
    if (version === this.version) {
      throw new ServiceError(UPDATE_ERRORS.ALREADY_CURRENT, `This machine already runs ${version}`);
    }
    if (this.current.state === 'running') {
      throw new ServiceError(UPDATE_ERRORS.UPDATE_RUNNING, 'An update is already running');
    }
    if (!force && this.busy > 0) return { started: false, busy: this.busy };
    this.stage(version, 'downloading');
    void this.perform(version);
    return { started: true };
  }

  private async perform(version: string): Promise<void> {
    const epoch = this.epoch;
    const from = this.version;
    const failure = this.failure;
    this.failure = undefined;
    await sleep(UPDATE_STEP_MS);
    if (epoch !== this.epoch) return;
    if (failure) {
      this.tell({
        state: 'failed',
        version,
        from,
        reason: failure,
        detail: `Mock: ${failure} failed`,
      });
      return;
    }
    this.stage(version, 'installing');
    await sleep(UPDATE_STEP_MS);
    if (epoch !== this.epoch) return;
    this.stage(version, 'restarting');
    await sleep(UPDATE_STEP_MS);
    if (this.closed || epoch !== this.epoch) return;
    // The restart: the devices lose their sockets, the new version answers the next hello.
    this.version = version;
    this.svc?.dropDevices();
    this.tell({ state: 'done', version, from, skipped: [] });
  }

  private stage(version: string, stage: UpdateStage): void {
    this.tell({ state: 'running', version, from: this.version, stage });
  }

  private tell(s: UpdateStatus): void {
    this.current = s;
    if (!this.closed) this.svc?.broadcast({ event: 'update.progress', data: s });
  }
}

const invalid = (id: number, message: string) => ({
  id,
  error: { code: 'INVALID_PARAMS', message },
});

/**
 * Answers the mock-only methods from local callers before the router sees them;
 * `mock.goAway` and `mock.comeBack` only on the remote mock (`presence`).
 */
const addMockMethods = (
  svc: ServiceHandle,
  updater: MockUpdater,
  presence: MockPresence | undefined,
): void => {
  const dispatch = svc.router.dispatch.bind(svc.router);
  svc.router.dispatch = async (req, ctx) => {
    if (ctx.origin !== 'local') return dispatch(req, ctx);
    switch (req.method) {
      case MOCK_GO_AWAY:
        if (!presence) return dispatch(req, ctx);
        presence.goAway();
        return { id: req.id, result: {} };
      case MOCK_COME_BACK:
        if (!presence) return dispatch(req, ctx);
        presence.comeBack();
        return { id: req.id, result: {} };
      case MOCK_FORGET_MOVES:
        await svc.forgetMoves();
        return { id: req.id, result: {} };
      case MOCK_FAIL_NEXT_UPDATE: {
        const p = FailNextParams.safeParse(req.params);
        if (!p.success) return invalid(req.id, p.error.message);
        updater.failNext(p.data.reason);
        return { id: req.id, result: {} };
      }
      case MOCK_SET_BUSY: {
        const p = SetBusyParams.safeParse(req.params);
        if (!p.success) return invalid(req.id, p.error.message);
        updater.setBusy(p.data.count);
        return { id: req.id, result: {} };
      }
      case MOCK_RESET_UPDATE:
        updater.reset();
        return { id: req.id, result: {} };
      default:
        return dispatch(req, ctx);
    }
  };
};

/** The phone's name, as the phone's core and the remote mock's devices list say it. */
export const PHONE_NAME = 'Phone';
/** How long the phone mock keeps trying to pair while the remote mock isn't up yet. */
const PHONE_PAIR_TRIES = 240;
const PHONE_PAIR_RETRY_MS = 500;

/**
 * The core's own table of the methods it answers and refuses, which its
 * contract test writes (`core-answers/methods.json`, from `REFUSED` in the
 * core's `methods.rs`): read, not copied, so the mock can't drift from it.
 */
const CORE_METHODS = new URL(
  '../../../protocol/test/fixtures/core-answers/methods.json',
  import.meta.url,
);

/** The methods the phone's core answers with `METHOD_NOT_FOUND`. */
export const refusedByThePhone = (): string[] => {
  const table = JSON.parse(readFileSync(CORE_METHODS, 'utf8')) as { refused?: unknown };
  if (!Array.isArray(table.refused)) throw new Error(`No refused list in ${CORE_METHODS.href}`);
  return table.refused.filter((m): m is string => typeof m === 'string');
};

/**
 * The phone's core answers `hello` with an empty machine, has no Claude Code
 * and refuses what it doesn't answer (as `methods.rs` in the core does): the
 * main mock answers the same. Resolves to the service's own dispatch, which
 * the mock pairs through itself, never through the table's refusals.
 */
const answerLikeThePhone = (svc: ServiceHandle): ServiceHandle['router']['dispatch'] => {
  const dispatch = svc.router.dispatch.bind(svc.router);
  const refused = new Set(refusedByThePhone());
  svc.router.dispatch = async (req, ctx) => {
    if (refused.has(req.method)) {
      return {
        id: req.id,
        error: { code: 'METHOD_NOT_FOUND', message: `Unknown method ${req.method}` },
      };
    }
    const res = await dispatch(req, ctx);
    if (!('result' in res)) return res;
    if (req.method === 'hello') {
      const hello = res.result as { machine?: Record<string, unknown> };
      if (!hello.machine) return res;
      return {
        ...res,
        result: {
          ...hello,
          machine: {
            id: hello.machine.id,
            name: PHONE_NAME,
            platform: 'linux',
            headless: false,
            home: '',
            capabilities: [],
          },
        },
      };
    }
    if (req.method === 'update.latest') {
      // As the core answers: the release's APK too (the screens' Download opens it).
      const { version } = res.result as { version: string };
      return {
        ...res,
        result: {
          version,
          url: `https://github.com/JiriPlasek/ThreadGarden/releases/download/v${version}/threadgarden-${version}.apk`,
        },
      };
    }
    if (req.method === 'system.status') {
      return {
        ...res,
        result: {
          claude: { found: false },
          externalAvailable: false,
          indexing: { done: 0, total: 0 },
        },
      };
    }
    return res;
  };
  return dispatch;
};

/**
 * Pairs the phone mock with the remote mock through the service's own
 * `dispatch` (whatever the core's table says of `machines.pair`), waiting for
 * it to answer; throws when it never does.
 */
const pairPhone = async (
  svc: ServiceHandle,
  dispatch: ServiceHandle['router']['dispatch'],
  to: { port: number; pairingCode: string },
): Promise<void> => {
  let closed = false;
  svc.onClosed(() => (closed = true));
  let last: unknown;
  for (let i = 0; i < PHONE_PAIR_TRIES; i++) {
    if (closed) return;
    try {
      const res = await dispatch(
        {
          id: 0,
          method: 'machines.pair',
          params: {
            address: '127.0.0.1',
            port: to.port,
            code: to.pairingCode,
            deviceName: PHONE_NAME,
          },
        },
        { clientId: 'mock', origin: 'local' },
      );
      if ('error' in res) throw new Error(`machines.pair: ${res.error.message}`);
      return;
    } catch (err) {
      last = err;
      await sleep(PHONE_PAIR_RETRY_MS);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
};

/** Calls `method` as this machine's own desktop would (origin local); throws its error. */
const callLocal = async (svc: ServiceHandle, method: string, params: unknown): Promise<void> => {
  const res = await svc.router.dispatch(
    { id: 0, method, params },
    { clientId: 'mock', origin: 'local' },
  );
  if ('error' in res) throw new Error(`${method}: ${res.error.message}`);
};

/** Starts the mock service; its temp dirs are removed when it closes. */
export const startMockService = async (o: MockOptions = {}): Promise<MockService> => {
  const remote = o.remote;
  const phone = o.phone;
  if (remote && phone) throw new Error('The mock is a remote machine or the phone, not both');
  for (const code of [remote?.pairingCode, phone?.pairWith?.pairingCode]) {
    if (code !== undefined && !isWellFormedPairingCode(code)) {
      throw new Error(`Invalid pairing code ${code}: 12 of ${PAIRING_ALPHABET}, dashes allowed`);
    }
  }
  const root = await mkdtemp(join(tmpdir(), 'threadgarden-mock-'));
  const dataDir = join(root, 'data');
  const claudeDir = join(root, 'claude');
  await mkdir(join(claudeDir, 'projects'), { recursive: true });
  const adapter = new ScriptedAdapter(claudeDir);
  const corpus = generateCorpus({
    // The phone runs no chats: it has none of its own.
    sessions: o.sessions ?? (phone ? 0 : remote ? REMOTE_SESSIONS : 1000),
    projects: o.projects ?? (phone ? 0 : remote ? 1 : 50),
    bigSessionMessages: o.bigSessionMessages ?? (remote || phone ? 0 : 2000),
    // Dated up to now, with models, tokens and tool calls: the Analytics view has data.
    recent: { now: Date.now(), days: HISTORY_DAYS },
  });
  for (const [id, s] of corpus.sessions) {
    // The second machine's chats all belong to its one project.
    if (remote) s.info.cwd = REMOTE_PROJECT_PATH;
    adapter.sessions.set(id, s);
  }
  const iconDirs = remote || phone ? new Map<string, string>() : await writeMockIcons(root);

  // One "external" Claude Code session (This PC's mock only), so the UI's
  // external states and resume block show.
  const externalId = remote || phone ? undefined : corpus.sessions.keys().next().value;
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

  const presence = remote ? new MockPresence() : undefined;
  let fakeTasmota: FakeTasmota | undefined;
  try {
    if (o.fakeTasmota) {
      fakeTasmota = await startFakeTasmota({
        kind: 'zigbee',
        password: FAKE_TASMOTA_PASSWORD,
        port: o.fakeTasmota.port,
      });
      fakeTasmota.devices.clear();
      fakeTasmota.devices.set(
        '0x863B',
        presence?.makePlug() ?? { name: 'MockPlug', on: true, watts: 47 },
      );
    }
    const updater = new MockUpdater();
    const svc = await startService({
      dataDir,
      serviceVersion: () => updater.version,
      update: { updater, latest: { get: async () => mockLatest() } },
      claudeConfigDir: claudeDir,
      adapter,
      claude: { path: 'mock-claude', version: MOCK_VERSION },
      externalRun: async () => JSON.stringify(externals),
      // The corpus's project folders (/work/proj-N) are not on disk: none is missing.
      folderStat: async () => true,
      moveGit: mockMoveGit,
      projectIconSearch: async (projectPath) => {
        const dir = iconDirs.get(projectPath.replace(/\\/g, '/'));
        return dir ? findProjectIcon(dir) : null;
      },
      ...(o.port === undefined ? {} : { port: o.port }),
      ...(o.token === undefined ? {} : { token: o.token }),
      installSignalHandlers: o.installSignalHandlers ?? true,
      // Never the real `systemctl poweroff`: a mock must not power off a developer's machine.
      poweroff: mockPoweroff,
      // Never detected: a mock run inside WSL is not a Windows worker.
      host: null,
      ...(remote
        ? {
            headless: true,
            // Test-only: loopback (Ruling R4). `bin.ts` lets the service find its private addresses.
            remote: {
              port: remote.port,
              addresses: ['127.0.0.1'],
              reachable: presence!.reachable,
            },
            pairingRandom: fixedPairingRandom(remote.pairingCode),
          }
        : {}),
    });
    updater.attach(svc);
    presence?.attach(svc);
    addMockMethods(svc, updater, presence);
    const ownDispatch = phone ? answerLikeThePhone(svc) : undefined;
    if (remote) {
      // The real service retries a listener that failed to start; a test mock must say so at once.
      if (!svc.remote) {
        await svc.close();
        throw new Error(`The device listener did not start on 127.0.0.1:${remote.port}`);
      }
      // A recognisable name, and the code live from the start for as long as the mock runs
      // (as if the owner ran `threadgarden pair` again whenever it expired or was spent).
      await callLocal(svc, 'machine.rename', { name: REMOTE_MACHINE_NAME });
      // Create in inside the mock's temp dir: a chat moved here (or a new project) never
      // touches a folder outside it.
      const createIn = join(root, 'projects');
      await mkdir(createIn, { recursive: true });
      await callLocal(svc, 'uiState.set', { key: CREATE_IN_KEY, value: createIn });
      const keepCodeLive = (): void =>
        void callLocal(svc, 'pairing.create', {}).catch((err: unknown) =>
          process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`),
        );
      keepCodeLive();
      const timer = setInterval(keepCodeLive, PAIRING_REFRESH_MS);
      timer.unref();
      svc.onClosed(() => clearInterval(timer));
    }
    // The mock account's usage is known from the start (v1.3 B), so the meter shows at once.
    // The phone runs no chats, so it has no usage of its own.
    if (!phone) {
      svc.usage?.observeEvent('mock', {
        status: 'allowed',
        rateLimitType: 'five_hour',
        utilization: MOCK_USAGE_START,
        resetsAt: Math.floor((Date.now() + MOCK_WINDOW_MS) / 1000),
      });
      svc.usage?.observeEvent('mock', {
        status: 'allowed',
        rateLimitType: 'seven_day',
        utilization: 0.23,
        resetsAt: Math.floor((Date.now() + 4 * 24 * 3_600_000) / 1000),
      });
    }
    // In the background: the remote mock may still be starting.
    const paired =
      phone?.pairWith && ownDispatch ? pairPhone(svc, ownDispatch, phone.pairWith) : undefined;
    paired?.catch((err: unknown) =>
      process.stderr.write(
        `The phone mock could not pair: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    const removed = new Promise<void>((resolve) =>
      svc.onClosed(() => {
        void fakeTasmota?.close().catch(() => {});
        void rm(root, { recursive: true, force: true })
          .catch(() => {})
          .finally(resolve);
      }),
    );
    return {
      svc,
      dataDir,
      claudeDir,
      adapter,
      ...(fakeTasmota ? { fakeTasmota } : {}),
      ...(paired ? { paired } : {}),
      removed,
    };
  } catch (err) {
    await fakeTasmota?.close().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
};

/** Whether the flag `--name` is in argv. */
const flag = (name: string): boolean => process.argv.slice(2).includes(`--${name}`);

/** `--name value` / `--name=value` from argv, else the env variable. */
const option = (name: string, envName?: string): string | undefined => {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return (envName && process.env[envName]) || undefined;
};

/** A port option (0: any free port); exits with a message when it is not one. */
const portOption = (name: string, envName?: string): number | undefined => {
  const text = option(name, envName);
  const port = text === undefined ? undefined : Number(text);
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) {
    process.stderr.write(`Invalid port: ${text}\n`);
    process.exit(1);
  }
  return port;
};

const isEntry = (): boolean =>
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry()) {
  const port = portOption('port', 'THREADGARDEN_MOCK_PORT');
  const token = option('token', 'THREADGARDEN_MOCK_TOKEN');
  let remote: MockOptions['remote'];
  if (flag('remote')) {
    const pairingCode = option('pairing-code');
    if (pairingCode === undefined) {
      process.stderr.write('--remote needs --pairing-code <code>, such as TEST-TEST-TEST\n');
      process.exit(1);
    }
    remote = { port: portOption('remote-port') ?? REMOTE_PORT, pairingCode };
  }
  const fakeTasmota = flag('fake-tasmota')
    ? { port: portOption('fake-tasmota-port') ?? 0 }
    : undefined;
  let phone: MockOptions['phone'];
  if (process.env.MOCK_PHONE === '1' || flag('phone')) {
    if (remote) {
      process.stderr.write('MOCK_PHONE is the main mock: it does not take --remote\n');
      process.exit(1);
    }
    const pairingCode = option('pairing-code');
    // No default port: 47380 may be a real machine's, and the mock must never pair with one.
    const pairPort = portOption('pair-port');
    if ((pairingCode === undefined) !== (pairPort === undefined)) {
      process.stderr.write('MOCK_PHONE pairs with --pair-port <port> and --pairing-code <code>\n');
      process.exit(1);
    }
    phone =
      pairingCode === undefined || pairPort === undefined
        ? {}
        : { pairWith: { port: pairPort, pairingCode } };
  }
  startMockService({
    ...(fakeTasmota ? { fakeTasmota } : {}),
    ...(phone ? { phone } : {}),
    ...(port === undefined ? {} : { port }),
    ...(token === undefined ? {} : { token }),
    ...(remote ? { remote } : {}),
  })
    .then(async ({ dataDir, claudeDir, fakeTasmota: switchHandle, removed }) => {
      const discovery = await readDiscovery(dataDir);
      if (switchHandle) {
        process.stderr.write(
          `Fake Tasmota switch at ${switchHandle.address} (user admin, password ${FAKE_TASMOTA_PASSWORD}), plug MockPlug at 47 W\n`,
        );
      }
      process.stdout.write(`${JSON.stringify({ ...discovery, dataDir, claudeDir })}\n`);
      void removed.then(() => process.exit(0));
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
