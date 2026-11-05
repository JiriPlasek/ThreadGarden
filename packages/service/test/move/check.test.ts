/**
 * The away copy, the move lock and `move.check` (service wiring, fake SDK).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSummary } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/history/db.js';
import { startService, type ServiceHandle } from '../../src/main.js';
import { DB_FILE } from '../../src/migrate-data-dir.js';
import { ChatStore } from '../../src/move/store.js';
import type { SessionMessage } from '../../src/sdk/adapter.js';
import { MOVE_LOCK_MS, MoveLocks, busyOf } from '../../src/server/handlers/move.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { eventually } from '../e2e/ws-client.js';

const TO = { machineId: 'm-ubuntu', name: 'kumbal-machine' };

let dir: string;
let svc: ServiceHandle | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadgarden-check-'));
});
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  await rm(dir, { recursive: true, force: true });
});

const dataDir = () => join(dir, 'data');

const addLocal = (adapter: FakeAdapter, sessionId: string, cwd: string) => {
  adapter.sessions.set(sessionId, {
    info: { sessionId, summary: `Chat ${sessionId}`, lastModified: 1_700_000_000_000, cwd },
    messages: [
      {
        type: 'user',
        uuid: `u-${sessionId}`,
        session_id: sessionId,
        message: { role: 'user', content: 'hello' },
        parent_tool_use_id: null,
      } as SessionMessage,
    ],
  });
};

let nextId = 1;
const call = (method: string, params: unknown) =>
  svc!.router.dispatch(
    { id: nextId++, method, params },
    { clientId: 't', origin: 'local' },
  ) as Promise<{ result?: unknown; error?: { code: string; message: string } }>;
const ok = async <T = unknown>(method: string, params: unknown): Promise<T> => {
  const r = await call(method, params);
  if (r.error) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
  return r.result as T;
};
const list = async () =>
  (await ok<{ items: ChatSummary[] }>('sessions.list', { place: { kind: 'all' }, limit: 50 }))
    .items;

/** A service with two indexed chats (`gone`, `kept`); the ids in `away` are marked away first. */
const start = async (away: string[], seed?: (db: ReturnType<typeof openDb>) => void) => {
  const folder = join(dir, 'proj');
  await mkdir(folder, { recursive: true });
  await mkdir(dataDir(), { recursive: true });
  const db = openDb(join(dataDir(), DB_FILE));
  const store = new ChatStore(db, () => {});
  for (const id of away) store.markAway(id, TO);
  seed?.(db);
  db.close();
  const adapter = new FakeAdapter();
  addLocal(adapter, 'gone', folder);
  addLocal(adapter, 'kept', folder);
  if (away.includes('back')) addLocal(adapter, 'back', folder);
  svc = await startService({
    dataDir: dataDir(),
    claudeConfigDir: join(dir, 'claude'),
    adapter,
    claude: { path: '/bin/claude', version: '2.1.314' },
    externalRun: async () => '[]',
    sessionEnv: { PATH: '/usr/bin' },
    installSignalHandlers: false,
  });
  // Every chat indexed, the away ones too (they are not listed): a test that looks
  // for an away chat in a list must not pass only because it was not indexed yet.
  await eventually(async () => {
    const { indexing } = await ok<{ indexing: { done: number; total: number } }>(
      'system.status',
      {},
    );
    return indexing.total === adapter.sessions.size && indexing.done === indexing.total;
  });
  await eventually(async () => (await list()).length > 0);
  return { adapter, folder };
};

describe('away chats', () => {
  it('an away chat is not listed, and chat.open returns movedTo', async () => {
    await start(['gone']);
    expect((await list()).map((s) => s.sessionId)).toEqual(['kept']);
    const summaries = await ok<{ items: ChatSummary[] }>('sessions.summaries', {
      sessionIds: ['gone', 'kept'],
    });
    expect(summaries.items.map((s) => s.sessionId)).toEqual(['kept']);
    expect((await ok<{ all: number }>('places.counts', {})).all).toBe(1);

    const gone = await ok<{ movedTo?: unknown }>('chat.open', { sessionId: 'gone', tail: 10 });
    expect(gone.movedTo).toEqual(TO);
    const kept = await ok<{ movedTo?: unknown }>('chat.open', { sessionId: 'kept', tail: 10 });
    expect(kept.movedTo).toBeNull();
  });

  it('an away chat with an unread turn or a back-from-hold mark is not in Needs you', async () => {
    await start(['gone', 'back'], (db) => {
      db.raw
        .prepare('INSERT INTO turn_state (session_id, last_turn_ended_at) VALUES (?, ?)')
        .run('gone', 1_700_000_100_000);
      db.raw
        .prepare("INSERT INTO chat_buckets (session_id, bucket, back_at) VALUES (?, 'active', ?)")
        .run('back', 1_700_000_100_000);
    });
    const needs = await ok<{ items: ChatSummary[] }>('sessions.list', {
      place: { kind: 'needsYou' },
      limit: 50,
    });
    expect(needs.items).toEqual([]);
    expect((await ok<{ needsYou: number }>('places.counts', {})).needsYou).toBe(0);
  });

  it('an away chat is not in Running', async () => {
    await start(['gone']);
    const running = await ok<{ items: ChatSummary[] }>('sessions.list', {
      place: { kind: 'running' },
      limit: 50,
    });
    expect(running.items.map((s) => s.sessionId)).not.toContain('gone');
  });

  it('chat.send to a locked chat answers MOVING, to an away chat MOVED', async () => {
    await start(['gone']);
    svc!.moveLocks.lock('kept', 'x1');
    expect((await call('chat.send', { sessionId: 'kept', text: 'hi' })).error?.code).toBe('MOVING');
    expect((await call('chat.send', { sessionId: 'gone', text: 'hi' })).error?.code).toBe('MOVED');
    svc!.moveLocks.unlock('kept');
    await ok('chat.send', { sessionId: 'kept', text: 'hi' });
  });

  it('a retry of a message already taken reads as taken, even once the chat is moving', async () => {
    const M1 = '7b0c1f0e-5d1c-4f55-9a53-0a1b2c3d4e51';
    const M2 = '7b0c1f0e-5d1c-4f55-9a53-0a1b2c3d4e52';
    await start([]);
    await ok('chat.send', { sessionId: 'kept', text: 'hi', messageId: M1 });
    svc!.moveLocks.lock('kept', 'x1');
    // Its answer was lost and it comes again: it was taken, so it isn't refused.
    expect(await ok('chat.send', { sessionId: 'kept', text: 'hi', messageId: M1 })).toEqual({
      queued: false,
    });
    // A new message is still refused.
    expect(
      (await call('chat.send', { sessionId: 'kept', text: 'more', messageId: M2 })).error?.code,
    ).toBe('MOVING');
  });
});

describe('move.check', () => {
  it('reports the folder and git state; an idle chat is not busy', async () => {
    const { folder } = await start([]);
    const r = await ok<{ cwd: string; busy: unknown; git: unknown }>('move.check', {
      sessionId: 'kept',
    });
    expect(r).toMatchObject({ cwd: folder, busy: null });
  });

  it('reports a dirty repository (one change, one commit on no remote)', async () => {
    const { folder } = await start([]);
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.com', ...a], {
        cwd: folder,
        stdio: 'ignore',
      });
    git('init', '--initial-branch=main');
    writeFileSync(join(folder, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-m', 'init');
    writeFileSync(join(folder, 'a.txt'), 'b');
    const r = await ok<{ git: unknown }>('move.check', { sessionId: 'kept' });
    expect(r.git).toEqual({ kind: 'dirty', branch: 'main', origin: null, changed: 1, unpushed: 1 });
  });

  it('a running turn is busy', async () => {
    await start([]);
    await ok('chat.send', { sessionId: 'kept', text: 'go' });
    const r = await ok<{ busy: unknown }>('move.check', { sessionId: 'kept' });
    expect(r.busy).toBe('turn');
  });

  it('an unknown chat is NOT_FOUND', async () => {
    await start([]);
    expect((await call('move.check', { sessionId: 'nope' })).error?.code).toBe('NOT_FOUND');
  });
});

describe('busyOf', () => {
  const s = (o: { live?: boolean; status: string; tasks?: number; pending?: number }) => ({
    live: o.live ?? true,
    status: o.status as never,
    runningTasks: o.tasks ?? 0,
    pendingRequests: () => new Array<unknown>(o.pending ?? 0).fill({}),
  });
  it('working is a turn, a request is a prompt, a task is subagents, idle is free', () => {
    expect(busyOf(s({ status: 'working' }))).toBe('turn');
    expect(busyOf(s({ status: 'unknown' }))).toBe('turn');
    expect(busyOf(s({ status: 'needsYou' }))).toBe('prompt');
    expect(busyOf(s({ status: 'idle', pending: 1 }))).toBe('prompt');
    expect(busyOf(s({ status: 'idle', tasks: 2 }))).toBe('subagents');
    expect(busyOf(s({ status: 'idle' }))).toBeNull();
    expect(busyOf(s({ live: false, status: 'paused' }))).toBeNull();
  });
});

describe('MoveLocks', () => {
  it('the lock expires after 10 min (fake clock)', () => {
    let now = 1_000;
    const locks = new MoveLocks(() => now);
    locks.lock('a', 'x1');
    expect(locks.isLocked('a')).toBe(true);
    now += MOVE_LOCK_MS - 1;
    expect(locks.isLocked('a')).toBe(true);
    now += 1;
    expect(locks.isLocked('a')).toBe(false);
  });

  it('unlock lets go at once', () => {
    const locks = new MoveLocks();
    locks.lock('a', 'x1');
    locks.unlock('a');
    expect(locks.isLocked('a')).toBe(false);
  });
});
