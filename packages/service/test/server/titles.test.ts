/**
 * v1.2 C1: chat titles through the real service wiring (fake adapter): the
 * provisional title of a chat pahub starts, the generated one after its first
 * turn, the setting and the API-key-only gate.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSummary, EventMsg } from '@pahub/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startService, type ServiceHandle, type StartOptions } from '../../src/main.js';
import type { OneShotOptions, SessionMessage } from '../../src/sdk/adapter.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { assistantText, init, result } from '../chat/live-helpers.js';
import { TestClient, chatStatus, eventually } from '../e2e/ws-client.js';

let dir: string;
let svc: ServiceHandle | undefined;
let client: TestClient | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pahub-titles-'));
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  await svc?.close();
  svc = undefined;
  await rm(dir, { recursive: true, force: true });
});

const start = async (adapter: FakeAdapter, over: Partial<StartOptions> = {}) => {
  svc = await startService({
    dataDir: join(dir, 'data'),
    claudeConfigDir: join(dir, 'claude'),
    adapter,
    claude: { path: '/bin/claude', version: '2.1.314' },
    externalRun: async () => '[]',
    sessionEnv: { PATH: '/usr/bin' },
    installSignalHandlers: false,
    ...over,
  });
  client = await TestClient.connect(svc.port, svc.token);
  const c = client;
  await eventually(
    async () => (await c.call<{ all: number }>('places.counts', {})).all === adapter.sessions.size,
  );
  return c;
};

const titleOf = async (c: TestClient, sessionId: string): Promise<string | undefined> =>
  (await c.call<{ items: ChatSummary[] }>('sessions.summaries', { sessionIds: [sessionId] }))
    .items[0]?.title;

const changedFor = (sessionId: string) => (e: EventMsg) =>
  e.event === 'sessions.changed' &&
  (e.data as { sessionIds: string[] }).sessionIds.includes(sessionId);

/** Ends the first turn of the newest fake session with a short reply. */
const firstTurn = async (c: TestClient, adapter: FakeAdapter, sessionId: string, reply: string) => {
  const fake = adapter.lastSession();
  fake.emit(init(sessionId));
  fake.emit(assistantText('a1', reply));
  fake.emit(result('r1'));
  await c.waitFor(chatStatus(sessionId, 'idle'));
};

/** A one-shot model that answers `title` and records what it was asked. */
const answering = (adapter: FakeAdapter, title: string) => {
  adapter.oneShotReply = async () => title;
};

const historyChat = (adapter: FakeAdapter, sessionId: string, summary: string) => {
  adapter.sessions.set(sessionId, {
    info: { sessionId, summary, lastModified: 1_700_000_000_000, fileSize: 10, cwd: dir },
    messages: [
      {
        type: 'user',
        uuid: `${sessionId}-u0`,
        session_id: sessionId,
        message: { role: 'user', content: 'hello' },
        parent_tool_use_id: null,
        parent_agent_id: null,
      } as SessionMessage,
    ],
  });
};

describe('chat titles (service)', () => {
  it('a new chat is named from its first message at once, everywhere', async () => {
    const adapter = new FakeAdapter();
    const c = await start(adapter);
    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: 'Fix the login bug on Safari. It fails after the OAuth redirect.\nMore details…',
    });
    await c.waitFor(changedFor(sessionId));
    // Not indexed yet (no transcript): the overlay carries pahub's title.
    expect(await titleOf(c, sessionId)).toBe('Fix the login bug on Safari.');
    const opened = await c.call<{ summary: ChatSummary }>('chat.open', { sessionId, tail: 10 });
    expect(opened.summary.title).toBe('Fix the login bug on Safari.');
    const listed = await c.call<{ items: ChatSummary[] }>('sessions.list', {
      place: { kind: 'all' },
      limit: 50,
    });
    expect(listed.items.find((s) => s.sessionId === sessionId)?.title).toBe(
      'Fix the login bug on Safari.',
    );
  });

  it('a slash command or a long first message is kept as typed and cut to 80', async () => {
    const adapter = new FakeAdapter();
    const c = await start(adapter);
    const slash = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: '/review @src/auth.ts',
    });
    expect(await titleOf(c, slash.sessionId)).toBe('/review @src/auth.ts');
    const long = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: `${'very '.repeat(40)}long`,
    });
    expect((await titleOf(c, long.sessionId))!.length).toBeLessThanOrEqual(80);
  });

  it('after the first turn a small model names the chat (sessions.changed)', async () => {
    const adapter = new FakeAdapter();
    answering(adapter, '"Safari OAuth login fix."');
    const c = await start(adapter);
    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: 'Fix the login bug on Safari',
    });
    expect(adapter.oneShots).toHaveLength(0);
    const changes = () => c.events.filter(changedFor(sessionId)).length;
    await firstTurn(c, adapter, sessionId, 'Let me check the redirect handler.');
    await eventually(async () => (await titleOf(c, sessionId)) === 'Safari OAuth login fix');
    const before = changes();
    expect(before).toBeGreaterThan(0);
    expect(adapter.oneShots).toHaveLength(1);
    const asked: OneShotOptions = adapter.oneShots[0]!;
    expect(asked).toMatchObject({ model: 'haiku', cwd: dir, claudePath: '/bin/claude' });
    expect(asked.prompt).toContain('Fix the login bug on Safari');
    expect(asked.prompt).toContain('Let me check the redirect handler.');

    // A second turn never asks again.
    await c.call('chat.send', { sessionId, text: 'And on Firefox?' });
    adapter.lastSession().emit(result('r2'));
    await new Promise((r) => setTimeout(r, 50));
    expect(adapter.oneShots).toHaveLength(1);

    // The user's own name wins.
    await c.call('meta.update', { sessionId, customTitle: 'Login work' });
    expect(await titleOf(c, sessionId)).toBe('Login work');
  });

  it('a failed generation keeps the provisional title', async () => {
    const adapter = new FakeAdapter(); // the fake model fails by default
    const c = await start(adapter);
    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: 'Fix the login bug',
    });
    await firstTurn(c, adapter, sessionId, 'On it.');
    await eventually(() => adapter.oneShots.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(await titleOf(c, sessionId)).toBe('Fix the login bug');
  });

  it('with "Name new chats automatically" off, nothing is generated', async () => {
    const adapter = new FakeAdapter();
    answering(adapter, 'Should not appear');
    const c = await start(adapter);
    expect((await c.call<{ autoTitles: boolean }>('settings.get', {})).autoTitles).toBe(true);
    await c.call('settings.set', { autoTitles: false });
    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: 'Fix the login bug',
    });
    await firstTurn(c, adapter, sessionId, 'On it.');
    await new Promise((r) => setTimeout(r, 50));
    expect(adapter.oneShots).toHaveLength(0);
    expect(await titleOf(c, sessionId)).toBe('Fix the login bug');
  });

  it('the first message of an untitled chat names it; a titled chat keeps its title', async () => {
    const adapter = new FakeAdapter();
    answering(adapter, 'Generated for untitled');
    historyChat(adapter, 'titled', 'Claude Code named this');
    const c = await start(adapter);
    // A chat pahub knows by id only (no index row, no title of any kind).
    // The SDK knows its folder, so it can be resumed.
    adapter.sessions.set('bare', {
      info: { sessionId: 'bare', summary: '', lastModified: 1, cwd: dir },
      messages: [],
    });
    await c.call('chat.send', { sessionId: 'titled', text: 'Another question' });
    expect(await titleOf(c, 'titled')).toBe('Claude Code named this');
    await firstTurn(c, adapter, 'titled', 'Answer.');
    await new Promise((r) => setTimeout(r, 50));
    expect(adapter.oneShots).toHaveLength(0);

    await c.call('chat.send', { sessionId: 'bare', text: 'Continue the migration\nwith care' });
    await c.waitFor(changedFor('bare'));
    expect(await titleOf(c, 'bare')).toBe('Continue the migration');
    await firstTurn(c, adapter, 'bare', 'Resuming the migration.');
    await eventually(async () => (await titleOf(c, 'bare')) === 'Generated for untitled');
    expect(adapter.oneShots).toHaveLength(1);
  });

  it('API-key-only build: no generation without a key; with one the key is used', async () => {
    const adapter = new FakeAdapter();
    answering(adapter, 'Keyed title');
    const c = await start(adapter, { apiKeyOnly: true });
    await c.call('auth.setApiKey', { key: 'sk-ant-test' });
    const first = await c.call<{ sessionId: string }>('chat.create', { cwd: dir, text: 'One' });
    await firstTurn(c, adapter, first.sessionId, 'Reply one.');
    await eventually(async () => (await titleOf(c, first.sessionId)) === 'Keyed title');
    expect(adapter.oneShots[0]!.env.ANTHROPIC_API_KEY).toBe('sk-ant-test');

    const second = await c.call<{ sessionId: string }>('chat.create', { cwd: dir, text: 'Two' });
    // The key is removed before the first turn ends: API_KEY_REQUIRED would apply.
    await c.call('auth.setApiKey', { key: null });
    await firstTurn(c, adapter, second.sessionId, 'Reply two.');
    await new Promise((r) => setTimeout(r, 50));
    expect(adapter.oneShots).toHaveLength(1);
    expect(await titleOf(c, second.sessionId)).toBe('Two');
  });

  // ── fix round 1 ──

  it('R33: no title query when user or project settings could route sessions elsewhere', async () => {
    const adapter = new FakeAdapter();
    answering(adapter, 'Should not appear');
    await mkdir(join(dir, 'claude'), { recursive: true });
    await writeFile(
      join(dir, 'claude', 'settings.json'),
      '{"env":{"ANTHROPIC_BASE_URL":"https://gateway.example"}}',
    );
    const c = await start(adapter);
    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: 'Fix the login bug',
    });
    await firstTurn(c, adapter, sessionId, 'On it.');
    await new Promise((r) => setTimeout(r, 100));
    expect(adapter.oneShots).toHaveLength(0);
    expect(await titleOf(c, sessionId)).toBe('Fix the login bug');
  });

  it('R33: project-local settings of the chat folder count too', async () => {
    const adapter = new FakeAdapter();
    answering(adapter, 'Should not appear');
    const project = join(dir, 'proj');
    await mkdir(join(project, '.claude'), { recursive: true });
    await writeFile(join(project, '.claude', 'settings.local.json'), '{"apiKeyHelper":"/bin/k"}');
    const c = await start(adapter);
    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: project,
      text: 'Fix the login bug',
    });
    await firstTurn(c, adapter, sessionId, 'On it.');
    await new Promise((r) => setTimeout(r, 100));
    expect(adapter.oneShots).toHaveLength(0);
  });

  it('the running title query never shows up as an external chat', async () => {
    const adapter = new FakeAdapter();
    let answer: (s: string) => void = () => {};
    adapter.oneShotReply = () => new Promise<string>((r) => (answer = r));
    let agents: unknown[] = [];
    const c = await start(adapter, { externalRun: async () => JSON.stringify(agents) });
    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: 'Fix the login bug',
    });
    await firstTurn(c, adapter, sessionId, 'On it.');
    await eventually(() => adapter.oneShots.length === 1);
    const ghost = adapter.oneShots[0]!.sessionId;
    expect(ghost).not.toBe(sessionId);
    const agent = (id: string, pid: number) => ({
      pid,
      cwd: dir,
      kind: 'interactive',
      startedAt: Date.now(),
      sessionId: id,
      status: 'busy',
    });
    agents = [agent(ghost, 4001), agent('elsewhere-1', 4002)];
    // A resume check polls `claude agents` now.
    await c.call('chat.resumeCheck', { sessionId: 'elsewhere-1' });
    const listed = await c.call<{ items: ChatSummary[] }>('sessions.summaries', {
      sessionIds: [ghost, 'elsewhere-1'],
    });
    expect(listed.items.map((s) => s.sessionId)).toEqual(['elsewhere-1']);
    answer('Login bug fix');
    await eventually(async () => (await titleOf(c, sessionId)) === 'Login bug fix');
  });

  it('a chat ended before its first turn finished is never titled later', async () => {
    const adapter = new FakeAdapter();
    answering(adapter, 'Should not appear');
    const c = await start(adapter);
    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: dir,
      text: 'Fix the login bug',
    });
    await c.call('chat.end', { sessionId });
    // Resumed later; its next turn is not a first turn pahub saw.
    adapter.sessions.set(sessionId, {
      info: { sessionId, summary: '', lastModified: 1, cwd: dir },
      messages: [],
    });
    await c.call('chat.send', { sessionId, text: 'Second' });
    await firstTurn(c, adapter, sessionId, 'Reply.');
    await new Promise((r) => setTimeout(r, 100));
    expect(adapter.oneShots).toHaveLength(0);
    expect(await titleOf(c, sessionId)).toBe('Fix the login bug');
  });
});
