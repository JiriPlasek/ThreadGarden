/** The chat.* / auth.* router methods against the real service wiring and a fake adapter. */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem } from '@pahub/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startService, type ServiceHandle, type StartOptions } from '../../src/main.js';
import type { PermissionUpdate, SessionMessage } from '../../src/sdk/adapter.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { result, sdk, settle, streamEvent } from '../chat/live-helpers.js';
import { eventually } from '../e2e/ws-client.js';

let dir: string;
let svc: ServiceHandle | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pahub-chat-'));
});
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  await rm(dir, { recursive: true, force: true });
});

const msg = (
  sessionId: string,
  uuid: string,
  type: 'user' | 'assistant',
  text: string,
): SessionMessage =>
  ({
    type,
    uuid,
    session_id: sessionId,
    message:
      type === 'user'
        ? { role: 'user', content: text }
        : { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    parent_agent_id: null,
  }) as SessionMessage;

/** A history session the fake SDK knows about. */
const addHistory = (adapter: FakeAdapter, sessionId: string, turns: number, cwd = dir) => {
  const messages: SessionMessage[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(msg(sessionId, `${sessionId}-u${i}`, 'user', `question ${i}`));
    messages.push(msg(sessionId, `${sessionId}-a${i}`, 'assistant', `answer ${i}`));
  }
  adapter.sessions.set(sessionId, {
    info: {
      sessionId,
      summary: `Chat ${sessionId}`,
      lastModified: 1_700_000_000_000,
      fileSize: 100,
      cwd,
    },
    messages,
  });
};

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
  const s = svc;
  // History is indexed in the background.
  await eventually(async () => {
    const r = await call('places.counts', {});
    return (r.result as { all: number } | undefined)?.all === adapter.sessions.size;
  });
  return s;
};

let nextId = 1;
const call = (method: string, params: unknown) =>
  svc!.router.dispatch({ id: nextId++, method, params }, { clientId: 't' }) as Promise<{
    result?: unknown;
    error?: { code: string; message: string };
  }>;
const ok = async <T = unknown>(method: string, params: unknown): Promise<T> => {
  const r = await call(method, params);
  if (r.error) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
  return r.result as T;
};
const code = async (method: string, params: unknown) => (await call(method, params)).error?.code;

type Opened = { items: ChatItem[]; hasMore: boolean; seq: number; summary: { live: boolean } };
const ids = (items: ChatItem[]) => items.map((i) => i.id);

/** Streams one assistant text block (stream-start uuid `sb`, final message `fin`) and a result. */
const streamedReply = (adapter: FakeAdapter, text: string) => {
  const fake = adapter.lastSession();
  fake.emit(streamEvent('st', { type: 'message_start', message: { id: 'api9' } }));
  fake.emit(
    streamEvent('sb', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
  );
  fake.emit(
    sdk({
      type: 'assistant',
      uuid: 'fin',
      session_id: 's',
      parent_tool_use_id: null,
      message: { id: 'api9', role: 'assistant', content: [{ type: 'text', text }] },
    }),
  );
  fake.emit(result('r2'));
};

describe('chat handlers', () => {
  it('chat.open pages a history chat from the SDK and chat.older pages backwards', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1', 3);
    await start(adapter);

    const opened = await ok<Opened>('chat.open', { sessionId: 'h1', tail: 2 });
    expect(ids(opened.items)).toEqual(['h1-u2', 'h1-a2']);
    expect(opened.hasMore).toBe(true);
    expect(opened.summary).toMatchObject({ sessionId: 'h1', status: 'history', live: false });
    expect(Number.isSafeInteger(opened.seq)).toBe(true);

    const older = await ok<{ items: ChatItem[]; hasMore: boolean }>('chat.older', {
      sessionId: 'h1',
      beforeItemId: 'h1-u2',
      limit: 3,
    });
    expect(ids(older.items)).toEqual(['h1-a0', 'h1-u1', 'h1-a1']);
    expect(older.hasMore).toBe(true);
    const oldest = await ok<{ items: ChatItem[]; hasMore: boolean }>('chat.older', {
      sessionId: 'h1',
      beforeItemId: 'h1-a0',
      limit: 3,
    });
    expect(ids(oldest.items)).toEqual(['h1-u0']);
    expect(oldest.hasMore).toBe(false);

    expect(await code('chat.older', { sessionId: 'h1', beforeItemId: 'nope', limit: 3 })).toBe(
      'NOT_FOUND',
    );
    expect(await code('chat.open', { sessionId: 'missing', tail: 5 })).toBe('NOT_FOUND');
    // History-only: nothing new after the opened seq.
    expect(await ok('chat.since', { sessionId: 'h1', seq: opened.seq })).toEqual({
      events: [],
      seq: opened.seq,
    });
  });

  it('chat.open on a resumed chat shows its earlier conversation merged with live items', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1', 1);
    await start(adapter);
    const before = await ok<Opened>('chat.open', { sessionId: 'h1', tail: 50 });

    expect(await ok('chat.send', { sessionId: 'h1', text: 'follow up' })).toEqual({
      queued: false,
    });
    const fake = adapter.lastSession();
    expect(fake.options.resume).toBe('h1');
    const sent = fake.sent[0]!.uuid!;
    streamedReply(adapter, 'second answer');
    await settle();
    // Claude Code writes the same turn to the transcript; it must not show twice.
    const h = adapter.sessions.get('h1')!;
    h.messages.push(
      msg('h1', sent, 'user', 'follow up'),
      msg('h1', 'fin', 'assistant', 'second answer'),
    );

    const opened = await ok<Opened>('chat.open', { sessionId: 'h1', tail: 50 });
    expect(ids(opened.items)).toEqual(['h1-u0', 'h1-a0', sent, 'sb', 'r2']);
    expect(opened.summary.live).toBe(true);
    // The resumed session's events continue right after what the client had.
    const since = await ok<{ events: { seq: number }[] }>('chat.since', {
      sessionId: 'h1',
      seq: before.seq,
    });
    expect(since.events[0]?.seq).toBe(before.seq + 1);

    const tail = await ok<Opened>('chat.open', { sessionId: 'h1', tail: 2 });
    expect(ids(tail.items)).toEqual(['sb', 'r2']);
    expect(tail.hasMore).toBe(true);
    const older = await ok<{ items: ChatItem[]; hasMore: boolean }>('chat.older', {
      sessionId: 'h1',
      beforeItemId: 'sb',
      limit: 10,
    });
    expect(ids(older.items)).toEqual(['h1-u0', 'h1-a0', sent]);
    expect(older.hasMore).toBe(false);
  });

  it('validates permission mode, effort and model at the router', async () => {
    const adapter = new FakeAdapter();
    await start(adapter);
    const base = { cwd: dir, text: 'x' };
    expect(await code('chat.create', { ...base, permissionMode: 'bypassPermissions' })).toBe(
      'INVALID_PARAMS',
    );
    expect(await code('chat.create', { ...base, permissionMode: 'dontAsk' })).toBe(
      'INVALID_PARAMS',
    );
    expect(await code('chat.create', { ...base, effort: 'ultra' })).toBe('INVALID_PARAMS');
    expect(await code('chat.create', { ...base, model: ' ' })).toBe('INVALID_PARAMS');
    expect(adapter.started).toHaveLength(0);

    const { sessionId } = await ok<{ sessionId: string }>('chat.create', {
      ...base,
      permissionMode: 'auto',
      effort: 'xhigh',
      model: 'opus',
    });
    const fake = adapter.lastSession();
    for (const value of ['bypassPermissions', 'yolo', '']) {
      expect(await code('chat.setPermissionMode', { sessionId, value })).toBe('INVALID_PARAMS');
    }
    for (const value of ['default', 'acceptEdits', 'plan', 'auto']) {
      await ok('chat.setPermissionMode', { sessionId, value });
      expect(fake.permissionMode).toBe(value);
    }
    expect(await code('chat.setEffort', { sessionId, value: 'ultra' })).toBe('INVALID_PARAMS');
    for (const value of ['low', 'medium', 'high', 'xhigh', 'max']) {
      await ok('chat.setEffort', { sessionId, value });
    }
    expect(await code('chat.setModel', { sessionId, value: '' })).toBe('INVALID_PARAMS');
    await ok('chat.setModel', { sessionId, value: 'claude-sonnet-5' });
    expect(fake.model).toBe('claude-sonnet-5');

    await ok('chat.end', { sessionId });
    expect(await code('chat.setModel', { sessionId, value: 'opus' })).toBe('NOT_LIVE');
  });

  it('chat.respond never applies a bypassPermissions suggestion (R11)', async () => {
    const adapter = new FakeAdapter();
    await start(adapter);
    const { sessionId } = await ok<{ sessionId: string }>('chat.create', { cwd: dir, text: 'x' });
    const bypass: PermissionUpdate = {
      type: 'setMode',
      mode: 'bypassPermissions',
      destination: 'session',
    };
    const decision = adapter
      .lastSession()
      .requestPermission('Bash', { command: 'ls' }, { requestId: 'q', suggestions: [bypass] });
    await settle();
    // The suggestion is not offered, so there is nothing to "always allow".
    expect(
      await code('chat.respond', {
        sessionId,
        requestId: 'q',
        decision: 'allowAlways',
        suggestionIndex: 0,
      }),
    ).toBe('INVALID_PARAMS');
    await ok('chat.respond', { sessionId, requestId: 'q', decision: 'allowAlways' });
    await expect(decision).resolves.toEqual({ behavior: 'allow' });
    expect(
      await code('chat.respond', { sessionId: 'nope', requestId: 'q', decision: 'deny' }),
    ).toBe('NOT_FOUND');
  });

  it('auth.setApiKey reaches new and resumed sessions only, and is never stored', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1', 1);
    await start(adapter);
    await ok('chat.create', { cwd: dir, text: 'before' });
    const before = adapter.lastSession();
    expect(before.options.env).toEqual({ PATH: '/usr/bin' });

    await ok('auth.setApiKey', { key: 'sk-secret-123' });
    expect(before.options.env.ANTHROPIC_API_KEY).toBeUndefined();
    await ok('chat.create', { cwd: dir, text: 'after' });
    expect(adapter.lastSession().options.env).toEqual({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-secret-123',
    });
    await ok('chat.send', { sessionId: 'h1', text: 'resume me' });
    expect(adapter.lastSession().options.env.ANTHROPIC_API_KEY).toBe('sk-secret-123');

    await ok('auth.setApiKey', { key: null });
    await ok('chat.create', { cwd: dir, text: 'reverted' });
    expect(adapter.lastSession().options.env).toEqual({ PATH: '/usr/bin' });

    await svc!.close();
    svc = undefined;
    const data = join(dir, 'data');
    for (const f of await readdir(data, { recursive: true })) {
      const body = await readFile(join(data, f)).catch(() => Buffer.alloc(0));
      expect(body.includes('sk-secret-123'), f).toBe(false);
    }
  });

  it('chat.send on a history chat is refused when resume is blocked; unverified is allowed', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'held', 1);
    addHistory(adapter, 'free', 1);
    let agents: () => Promise<string> = async () =>
      JSON.stringify([
        { pid: 7, cwd: dir, kind: 'interactive', startedAt: 1, sessionId: 'held', status: 'busy' },
      ]);
    await start(adapter, { externalRun: () => agents() });

    const blocked = await call('chat.send', { sessionId: 'held', text: 'hi' });
    expect(blocked.error?.code).toBe('RESUME_BLOCKED');
    expect(blocked.error?.message).toMatch(/\S/);
    expect(adapter.started).toHaveLength(0);

    await ok('chat.send', { sessionId: 'free', text: 'hi' });
    expect(adapter.lastSession().options.resume).toBe('free');

    agents = () => Promise.reject(new Error('agent view disabled'));
    expect((await ok<{ status: string }>('chat.resumeCheck', { sessionId: 'held' })).status).toBe(
      'unverified',
    );
    await ok('chat.send', { sessionId: 'held', text: 'confirmed by the user' });
    expect(adapter.lastSession().options.resume).toBe('held');
    // A live chat is never re-checked.
    agents = async () =>
      JSON.stringify([
        { pid: 7, cwd: dir, kind: 'interactive', startedAt: 1, sessionId: 'held', status: 'busy' },
      ]);
    expect(await ok('chat.send', { sessionId: 'held', text: 'again' })).toEqual({ queued: true });
  });

  it('chat.fork maps item ids to SDK message uuids and indexes the fork', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1', 2);
    await start(adapter);

    const fromHistory = await ok<{ sessionId: string }>('chat.fork', {
      sessionId: 'h1',
      upToItemId: 'h1-u1',
    });
    expect(adapter.forks.at(-1)).toMatchObject({ sessionId: 'h1', upToMessageId: 'h1-u1' });
    const forked = await ok<Opened>('chat.open', { sessionId: fromHistory.sessionId, tail: 50 });
    expect(forked.items).toHaveLength(3);

    await ok('chat.fork', { sessionId: 'h1', upToItemId: 'h1-a0:1' });
    expect(adapter.forks.at(-1)?.upToMessageId).toBe('h1-a0');

    // A streamed assistant item is forked at its final SDK message.
    const { sessionId } = await ok<{ sessionId: string }>('chat.create', { cwd: dir, text: 'q' });
    streamedReply(adapter, 'streamed');
    await settle();
    adapter.sessions.set(sessionId, {
      info: { sessionId, summary: 'live', lastModified: 1, fileSize: 1, cwd: dir },
      messages: [msg(sessionId, 'u', 'user', 'q'), msg(sessionId, 'fin', 'assistant', 'streamed')],
    });
    await ok('chat.fork', { sessionId, upToItemId: 'sb' });
    expect(adapter.forks.at(-1)).toMatchObject({ sessionId, upToMessageId: 'fin' });

    expect(await code('chat.fork', { sessionId: 'h1', upToItemId: 'not-a-message' })).toBe(
      'FORK_FAILED',
    );
  });

  it('without claude, history works and chat.create explains the problem', async () => {
    const adapter = new FakeAdapter();
    addHistory(adapter, 'h1', 1);
    await start(adapter, {
      claude: { problem: 'missing', detail: 'Claude Code was not found on PATH.' },
      externalRun: undefined,
    });
    const created = await call('chat.create', { cwd: dir, text: 'x' });
    expect(created.error).toEqual({
      code: 'CLAUDE_MISSING',
      message: 'Claude Code was not found on PATH.',
    });
    expect(await code('chat.send', { sessionId: 'h1', text: 'x' })).toBe('CLAUDE_MISSING');
    expect(ids((await ok<Opened>('chat.open', { sessionId: 'h1', tail: 5 })).items)).toEqual([
      'h1-u0',
      'h1-a0',
    ]);
    expect(await ok('system.status', {})).toMatchObject({
      claude: { found: false, problem: 'Claude Code was not found on PATH.' },
    });
    expect(adapter.started).toHaveLength(0);
  });

  it('locates claude from the settings path and again when it changes', async () => {
    const adapter = new FakeAdapter();
    const locateClaude = vi.fn(async (p: string | null) =>
      p ? { path: p, version: '2.2.0' } : { problem: 'missing' as const, detail: 'not found' },
    );
    await start(adapter, { claude: undefined, locateClaude });
    expect(locateClaude).toHaveBeenCalledWith(null);
    expect(await code('chat.create', { cwd: dir, text: 'x' })).toBe('CLAUDE_MISSING');

    await ok('settings.set', { claudePath: '/opt/claude/claude' });
    await eventually(async () => {
      const s = await ok<{ claude: { found: boolean } }>('system.status', {});
      return s.claude.found;
    });
    await ok('chat.create', { cwd: dir, text: 'x' });
    expect(adapter.lastSession().options.claudePath).toBe('/opt/claude/claude');
  });

  it('chat.commands and chat.models come from a live session and are remembered', async () => {
    const adapter = new FakeAdapter();
    await start(adapter);
    const { sessionId } = await ok<{ sessionId: string }>('chat.create', { cwd: dir, text: 'x' });
    const fake = adapter.lastSession();
    fake.commands = [{ name: 'review', description: 'Review a PR', argumentHint: '<pr>' }];
    fake.models = [
      {
        value: 'opus',
        displayName: 'Opus',
        description: 'Most capable',
        supportedEffortLevels: ['low', 'high'],
      },
    ];
    const commands = [{ name: 'review', description: 'Review a PR', argumentHint: '<pr>' }];
    const models = [
      {
        value: 'opus',
        displayName: 'Opus',
        description: 'Most capable',
        supportedEffortLevels: ['low', 'high'],
      },
    ];
    expect(await ok('chat.commands', { sessionId })).toEqual(commands);
    expect(await ok('chat.models', { sessionId })).toEqual(models);

    await ok('chat.end', { sessionId });
    expect(await ok('chat.commands', { cwd: dir })).toEqual(commands);
    expect(await ok('chat.commands', {})).toEqual(commands);
    expect(await ok('chat.models', {})).toEqual(models);
  });

  it('chat.since for a seq this service never issued is a GAP', async () => {
    await start(new FakeAdapter());
    expect(await code('chat.since', { sessionId: 'whatever', seq: 3 })).toBe('GAP');
  });
});
