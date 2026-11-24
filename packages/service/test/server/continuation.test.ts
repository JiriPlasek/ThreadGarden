import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startService, type ServiceHandle, type StartOptions } from '../../src/main.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import type { SessionMessage } from '../../src/sdk/adapter.js';
import { eventually } from '../e2e/ws-client.js';
import { sdk, settle, started as taskStarted, ManualTimers } from '../chat/live-helpers.js';

let dir: string;
let svc: ServiceHandle | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tg-continue-'));
});
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  await rm(dir, { recursive: true, force: true });
});
const call = async (method: string, params: unknown) =>
  svc!.router.dispatch(
    { id: 1, method, params },
    { clientId: 'test', origin: 'local' },
  ) as Promise<{ result?: unknown; error?: { code: string; message: string } }>;
const ok = async <T = unknown>(method: string, params: unknown): Promise<T> => {
  const r = await call(method, params);
  if (r.error) throw new Error(r.error.code + ': ' + r.error.message);
  return r.result as T;
};
const history = (adapter: FakeAdapter, id: string) => {
  adapter.sessions.set(id, {
    info: {
      sessionId: id,
      summary: 'Repair Safari login',
      cwd: dir,
      lastModified: 1,
      fileSize: 100,
    },
    messages: [
      {
        type: 'user',
        uuid: 'u1',
        session_id: id,
        message: { role: 'user', content: 'Fix the Safari login redirect' },
        parent_tool_use_id: null,
      },
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: id,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The callback loses returnUrl' }],
        },
        parent_tool_use_id: null,
      },
    ] as SessionMessage[],
  });
};
const start = async (
  adapter: FakeAdapter,
  externalRun: () => Promise<string> = async () => '[]',
  overrides: Partial<StartOptions> = {},
) => {
  await mkdir(join(dir, 'claude'), { recursive: true });
  svc = await startService({
    dataDir: join(dir, 'data'),
    claudeConfigDir: join(dir, 'claude'),
    adapter,
    claude: { path: '/bin/claude', version: '2.1.314' },
    externalRun,
    installSignalHandlers: false,
    ...overrides,
  });
  await eventually(
    async () => (await ok<{ all: number }>('places.counts', {})).all === adapter.sessions.size,
  );
};
const readyAdapter = () =>
  Object.assign(new FakeAdapter(), { requireCodex: vi.fn(async () => {}) });

it.each(['claude', 'codex'] as const)(
  'continues %s in the opposite runtime with history and reciprocal links',
  async (provider) => {
    const adapter = readyAdapter();
    const source = (provider === 'codex' ? 'codex-' : '') + randomUUID();
    const target = (provider === 'claude' ? 'codex-' : '') + randomUUID();
    history(adapter, source);
    await start(adapter);
    const params = { sessionId: source, targetSessionId: target, stopSource: true };
    expect(await ok('chat.continue', params)).toEqual({ sessionId: target });
    const session = adapter.lastSession();
    expect(session.options.cwd).toBe(dir);
    expect(session.options.resume).toBeUndefined();
    expect(session.options.model).toBe(provider === 'claude' ? 'codex:default' : undefined);
    expect(session.options.permissionMode).not.toBe('bypassPermissions');
    const prompt = JSON.stringify(session.sent);
    const file = join(dir, 'data', 'handoffs', target + '.md');
    expect(prompt).toContain(JSON.stringify(JSON.stringify(file)).slice(1, -1));
    expect(prompt).toContain('inspect');
    const exported = await readFile(file, 'utf8');
    expect(exported).toContain('Fix the Safari login redirect');
    expect(exported).toContain('callback loses returnUrl');
    expect(adapter.oneShots).toHaveLength(0);
    expect(await ok('chat.continue', params)).toEqual({ sessionId: target });
    expect(adapter.started).toHaveLength(1);
    const original = await ok<{ continuationLinks: { to: string[] } }>('chat.open', {
      sessionId: source,
      tail: 100,
    });
    expect(original.continuationLinks.to).toEqual([target]);
    const next = await ok<{ continuationLinks: { from: string } }>('chat.open', {
      sessionId: target,
      tail: 100,
    });
    expect(next.continuationLinks.from).toBe(source);
  },
);

it('ends an owned source process before starting the target and exports its live text', async () => {
  const adapter = readyAdapter();
  await start(adapter);
  const { sessionId: source } = await ok<{ sessionId: string }>('chat.create', {
    cwd: dir,
    text: 'Fix login',
    permissionMode: 'bypassPermissions',
  });
  const old = adapter.lastSession();
  old.emit(
    sdk({
      type: 'assistant',
      uuid: 'live-a',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Unfinished live investigation' }],
      },
    }),
  );
  await settle();
  const target = 'codex-' + randomUUID();
  const originalStart = adapter.start.bind(adapter);
  vi.spyOn(adapter, 'start').mockImplementation((options) => {
    expect(old.closed).toBe(true);
    return originalStart(options);
  });
  await ok('chat.continue', { sessionId: source, targetSessionId: target, stopSource: true });
  expect(old.closed).toBe(true);
  expect(adapter.lastSession().options.permissionMode).not.toBe('bypassPermissions');
  expect(await readFile(join(dir, 'data', 'handoffs', target + '.md'), 'utf8')).toContain(
    'Unfinished live investigation',
  );
});

it('refuses a missing destination runtime before ending the source', async () => {
  const adapter = new FakeAdapter();
  await start(adapter);
  const { sessionId } = await ok<{ sessionId: string }>('chat.create', {
    cwd: dir,
    text: 'Fix login',
  });
  const source = adapter.lastSession();
  const failed = await call('chat.continue', {
    sessionId,
    targetSessionId: 'codex-' + randomUUID(),
    stopSource: true,
  });
  expect(failed.error?.code).toBe('CODEX_MISSING');
  expect(source.closed).toBe(false);
});

it('rejects unsafe ids, same-runtime continuations and unknown sources without starting work', async () => {
  const adapter = readyAdapter();
  history(adapter, 'source');
  await start(adapter);
  expect(
    (
      await call('chat.continue', {
        sessionId: 'source',
        targetSessionId: '../escape',
        stopSource: true,
      })
    ).error?.code,
  ).toBe('INVALID_PARAMS');
  expect(
    (
      await call('chat.continue', {
        sessionId: 'source',
        targetSessionId: randomUUID(),
        stopSource: true,
      })
    ).error?.code,
  ).toBe('INVALID_PARAMS');
  expect(
    (
      await call('chat.continue', {
        sessionId: 'missing',
        targetSessionId: 'codex-' + randomUUID(),
        stopSource: true,
      })
    ).error?.code,
  ).toBe('NOT_FOUND');
  expect(adapter.started).toHaveLength(0);
});

it('recovers an interrupted prepared handoff instead of returning a nonexistent chat', async () => {
  const adapter = readyAdapter();
  history(adapter, 'source');
  await start(adapter);
  const target = 'codex-' + randomUUID();
  const raw = new DatabaseSync(join(dir, 'data', 'threadgarden.db'));
  raw
    .prepare('INSERT INTO chat_continuations (session_id, source_session_id, at) VALUES (?, ?, ?)')
    .run(target, 'source', 1);
  raw.close();
  await ok('chat.continue', { sessionId: 'source', targetSessionId: target, stopSource: true });
  expect(adapter.started).toHaveLength(1);
  expect(adapter.lastSession().options.sessionId).toBe(target);
});

it('replaces an orphan handoff export left before target creation', async () => {
  const adapter = readyAdapter();
  history(adapter, 'source');
  await start(adapter);
  const target = 'codex-' + randomUUID();
  await mkdir(join(dir, 'data', 'handoffs'), { recursive: true });
  await writeFile(join(dir, 'data', 'handoffs', target + '.md'), 'Incomplete old export');
  await ok('chat.continue', { sessionId: 'source', targetSessionId: target, stopSource: true });
  expect(adapter.started).toHaveLength(1);
  expect(await readFile(join(dir, 'data', 'handoffs', target + '.md'), 'utf8')).toContain(
    'Fix the Safari login redirect',
  );
});

it('fails instead of silently exporting only live items when established history cannot be read', async () => {
  const adapter = readyAdapter();
  history(adapter, 'source');
  await start(adapter);
  await ok('chat.send', { sessionId: 'source', text: 'Continue investigating' });
  const read = adapter.getSessionMessages.bind(adapter);
  vi.spyOn(adapter, 'getSessionMessages').mockImplementation(async (id, options) => {
    if (id === 'source') throw new Error('History unavailable');
    return read(id, options);
  });
  const result = await call('chat.continue', {
    sessionId: 'source',
    targetSessionId: 'codex-' + randomUUID(),
    stopSource: true,
  });
  expect(result.error).toBeDefined();
  expect(adapter.started).toHaveLength(1);
});

it('coalesces retries, rejects a conflicting source and locks source messages until the handoff ends', async () => {
  const adapter = readyAdapter();
  history(adapter, 'source');
  history(adapter, 'other-source');
  await start(adapter);
  let ready!: () => void;
  adapter.requireCodex.mockImplementation(
    () =>
      new Promise<void>((r) => {
        ready = r;
      }),
  );
  const target = 'codex-' + randomUUID();
  const params = { sessionId: 'source', targetSessionId: target, stopSource: true };
  const first = call('chat.continue', params);
  const retry = call('chat.continue', params);
  expect((await call('chat.continue', { ...params, sessionId: 'other-source' })).error?.code).toBe(
    'INVALID_PARAMS',
  );
  expect(
    (await call('chat.send', { sessionId: 'source', text: 'New concurrent task' })).error?.code,
  ).toBe('MOVING');
  ready();
  expect((await first).error).toBeUndefined();
  expect(await retry).toEqual(await first);
  expect(adapter.started).toHaveLength(1);
  expect(svc!.moveLocks.isLocked('source')).toBe(false);
});

it('refuses tracked background work without closing the source', async () => {
  const adapter = readyAdapter();
  await start(adapter);
  const { sessionId } = await ok<{ sessionId: string }>('chat.create', {
    cwd: dir,
    text: 'Fix login',
  });
  const old = adapter.lastSession();
  old.emit(taskStarted('background-agent'));
  await settle();
  const result = await call('chat.continue', {
    sessionId,
    targetSessionId: 'codex-' + randomUUID(),
    stopSource: true,
  });
  expect(result.error?.code).toBe('TASKS_RUNNING');
  expect(old.closed).toBe(false);
  expect(adapter.started).toHaveLength(1);
});

it('requires an external source to be stopped and explicit confirmation to start any handoff', async () => {
  const adapter = readyAdapter();
  history(adapter, 'source');
  await start(adapter, async () =>
    JSON.stringify([
      { pid: 7, cwd: dir, kind: 'interactive', startedAt: 1, sessionId: 'source', status: 'busy' },
    ]),
  );
  const target = 'codex-' + randomUUID();
  expect(
    (
      await call('chat.continue', {
        sessionId: 'source',
        targetSessionId: target,
        stopSource: true,
      })
    ).error?.code,
  ).toBe('RESUME_BLOCKED');
  expect(
    (await call('chat.continue', { sessionId: 'source', targetSessionId: target })).error?.code,
  ).toBe('INVALID_PARAMS');
  expect(adapter.started).toHaveLength(0);
});

it('does not close a source later or start a target after an interrupt timeout', async () => {
  const timers = new ManualTimers();
  const adapter = readyAdapter();
  await start(adapter, async () => '[]', { sessionTimers: timers });
  const { sessionId } = await ok<{ sessionId: string }>('chat.create', {
    cwd: dir,
    text: 'Fix login',
  });
  const source = adapter.lastSession();
  let interrupted!: () => void;
  vi.spyOn(source, 'interrupt').mockImplementation(
    () =>
      new Promise<void>((r) => {
        interrupted = r;
      }),
  );
  const pending = call('chat.continue', {
    sessionId,
    targetSessionId: 'codex-' + randomUUID(),
    stopSource: true,
  });
  await eventually(() => interrupted !== undefined);
  timers.advance(10_000);
  expect((await pending).error?.code).toBe('STOP_FAILED');
  expect(source.closed).toBe(false);
  interrupted();
  await settle();
  expect(source.closed).toBe(false);
  expect(adapter.started).toHaveLength(1);
});

it('keeps reciprocal links and retry identity after a service restart', async () => {
  const adapter = readyAdapter();
  history(adapter, 'source');
  await start(adapter);
  const target = 'codex-' + randomUUID();
  const params = { sessionId: 'source', targetSessionId: target, stopSource: true };
  await ok('chat.continue', params);
  await svc!.close();
  svc = undefined;
  const next = readyAdapter();
  history(next, 'source');
  history(next, target);
  await start(next);
  expect(await ok('chat.continue', params)).toEqual({ sessionId: target });
  expect(next.started).toHaveLength(0);
  const original = await ok<{ continuationLinks: { to: string[] } }>('chat.open', {
    sessionId: 'source',
    tail: 1,
  });
  expect(original.continuationLinks.to).toEqual([target]);
  const continued = await ok<{ continuationLinks: { from: string } }>('chat.open', {
    sessionId: target,
    tail: 1,
  });
  expect(continued.continuationLinks.from).toBe('source');
});
