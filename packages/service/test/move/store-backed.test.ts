/**
 * Chats moved here live in Threadgarden's own session store (`move/store.ts`):
 * they are listed, opened, resumed and indexed from it, like any chat.
 * Real service wiring and db, fake SDK.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem, ChatSummary } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/history/db.js';
import { Indexer } from '../../src/history/indexer.js';
import { startService, type ServiceHandle } from '../../src/main.js';
import { DB_FILE } from '../../src/migrate-data-dir.js';
import { ChatStore } from '../../src/move/store.js';
import type { SessionMessage } from '../../src/sdk/adapter.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { eventually } from '../e2e/ws-client.js';

const S1 = 's1';
const FROM = { machineId: 'm-laptop', name: 'laptop' };
/** The folder the transcript names: the source machine's. */
const SOURCE_CWD = 'C:\\elsewhere\\proj';

let dir: string;
let svc: ServiceHandle | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadgarden-moved-'));
});
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  await rm(dir, { recursive: true, force: true });
});

const dataDir = () => join(dir, 'data');
const movedCwd = () => join(dir, 'moved');

/** A transcript line as the SDK keeps it in a store. */
const entry = (uuid: string, type: 'user' | 'assistant', text: string, timestamp: string) => ({
  type,
  uuid,
  sessionId: S1,
  timestamp,
  cwd: SOURCE_CWD,
  message:
    type === 'user'
      ? { role: 'user', content: text }
      : { role: 'assistant', content: [{ type: 'text', text }] },
});

const movedEntries = () => [
  entry('moved-u0', 'user', 'moved question', '2026-11-01T10:00:00.000Z'),
  entry('moved-a0', 'assistant', 'moved answer', '2026-11-01T10:00:05.000Z'),
];

/** Puts s1 in the store of the db in the data dir, as living here in `movedCwd()`. */
const seedStore = async () => {
  await mkdir(dataDir(), { recursive: true });
  const db = openDb(join(dataDir(), DB_FILE));
  const store = new ChatStore(db, () => {});
  store.put(S1, [{ entries: movedEntries() }]);
  store.markHere(S1, movedCwd(), FROM);
  db.close();
};

const localMsg = (sessionId: string, uuid: string, text: string): SessionMessage =>
  ({
    type: 'user',
    uuid,
    session_id: sessionId,
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  }) as SessionMessage;

/** A chat in Claude Code's own (local) history. */
const addLocal = (adapter: FakeAdapter, sessionId: string, cwd = join(dir, 'local')) => {
  adapter.sessions.set(sessionId, {
    info: { sessionId, summary: `Local ${sessionId}`, lastModified: 1_700_000_000_000, cwd },
    messages: [localMsg(sessionId, `local-${sessionId}`, 'local question')],
  });
};

let nextId = 1;
const call = (method: string, params: unknown) =>
  svc!.router.dispatch(
    { id: nextId++, method, params },
    { clientId: 't', origin: 'local' },
  ) as Promise<{
    result?: unknown;
    error?: { code: string; message: string };
  }>;
const ok = async <T = unknown>(method: string, params: unknown): Promise<T> => {
  const r = await call(method, params);
  if (r.error) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
  return r.result as T;
};
const list = async () =>
  (await ok<{ items: ChatSummary[] }>('sessions.list', { place: { kind: 'all' }, limit: 50 }))
    .items;
const ids = (items: ChatItem[]) => items.map((i) => i.id);

const start = async (adapter: FakeAdapter, chats: number) => {
  svc = await startService({
    dataDir: dataDir(),
    claudeConfigDir: join(dir, 'claude'),
    adapter,
    claude: { path: '/bin/claude', version: '2.1.314' },
    externalRun: async () => '[]',
    sessionEnv: { PATH: '/usr/bin' },
    installSignalHandlers: false,
  });
  await eventually(async () => (await list()).length === chats);
};

describe('store-backed chats', () => {
  it('a here chat is listed by sessions.list with its cwd', async () => {
    await seedStore();
    const adapter = new FakeAdapter();
    await start(adapter, 1);
    const [s1] = await list();
    expect(s1).toMatchObject({ sessionId: S1, cwd: movedCwd(), status: 'history' });
    expect(s1!.lastActivity).toBe(Date.parse('2026-11-01T10:00:05.000Z'));
  });

  it('fullSync keeps a here chat (removeVanished does not delete it)', async () => {
    const db = openDb(':memory:');
    try {
      const store = new ChatStore(db, () => {});
      store.put(S1, [{ entries: movedEntries() }]);
      store.markHere(S1, '/work/moved', FROM);
      const adapter = new FakeAdapter();
      addLocal(adapter, 'h1', '/work/local');
      const indexer = new Indexer(adapter, db, () => {}, {
        platform: 'linux',
        gitCommonDir: () => null,
        historyOf: (id) => store.historyOf(id),
        storeBacked: () => store.here().map((h) => h.sessionId),
      });
      await indexer.fullSync();
      await indexer.fullSync();
      expect(db.allSessionIds().sort()).toEqual(['h1', S1]);
      expect(db.getSession(S1)).toMatchObject({ cwd: '/work/moved' });
    } finally {
      db.close();
    }
  });

  it("with a local and a store copy of s1, chat.open shows the store's messages", async () => {
    await seedStore();
    const adapter = new FakeAdapter();
    addLocal(adapter, S1);
    await start(adapter, 1);
    const opened = await ok<{ items: ChatItem[] }>('chat.open', { sessionId: S1, tail: 50 });
    expect(ids(opened.items)).toEqual(['moved-u0', 'moved-a0', 'turn-end:moved-a0']);
    expect((await list())[0]).toMatchObject({ sessionId: S1, cwd: movedCwd() });
  });

  it('resume of a store-backed chat starts the adapter with sessionStore and its cwd', async () => {
    await seedStore();
    const adapter = new FakeAdapter();
    addLocal(adapter, S1); // a stale local copy: the store still wins
    addLocal(adapter, 'h1');
    await start(adapter, 2);

    await ok('chat.send', { sessionId: S1, text: 'go on' });
    const moved = adapter.lastSession().options;
    expect(moved).toMatchObject({ resume: S1, cwd: movedCwd() });
    const loaded = await moved.sessionStore?.load({ projectKey: 'any', sessionId: S1 });
    expect(loaded?.map((e) => e.uuid)).toEqual(['moved-u0', 'moved-a0']);

    await ok('chat.send', { sessionId: 'h1', text: 'hi' });
    expect(adapter.lastSession().options.sessionStore).toBeUndefined();
  });

  it("a chat that came back into another folder resumes in the store row's folder", async () => {
    const adapter = new FakeAdapter();
    addLocal(adapter, S1, join(dir, 'local'));
    await start(adapter, 1);
    // Threadgarden ran the local chat here once; its process crashed, the host keeps it.
    await ok('chat.send', { sessionId: S1, text: 'hi' });
    adapter.lastSession().end(new Error('crashed'));
    await eventually(() => svc!.host!.get(S1)?.status === 'failed');

    // The chat moved away and came back, into another folder: it lives in the store now.
    const db = openDb(join(dataDir(), DB_FILE));
    const store = new ChatStore(db, () => {});
    store.put(S1, [{ entries: movedEntries() }]);
    store.markHere(S1, movedCwd(), FROM);
    db.close();

    await ok('chat.send', { sessionId: S1, text: 'go on' });
    const resumed = adapter.lastSession().options;
    expect(resumed).toMatchObject({ resume: S1, cwd: movedCwd() });
    expect(resumed.sessionStore).toBeDefined();
  });

  it('an append refreshes the index (lastModified moves)', async () => {
    await seedStore();
    const adapter = new FakeAdapter();
    await start(adapter, 1);
    await ok('chat.send', { sessionId: S1, text: 'go on' });
    const store = adapter.lastSession().options.sessionStore!;
    await ok('chat.end', { sessionId: S1 });
    // Opened (and cached) before the append.
    await ok('chat.open', { sessionId: S1, tail: 50 });

    const later = '2026-11-03T08:00:00.000Z';
    await store.append({ projectKey: 'any', sessionId: S1 }, [
      entry('moved-u1', 'user', 'a later question', later),
    ]);
    await eventually(async () => (await list())[0]?.lastActivity === Date.parse(later));
    const opened = await ok<{ items: ChatItem[] }>('chat.open', { sessionId: S1, tail: 50 });
    expect(ids(opened.items)).toEqual(['moved-u0', 'moved-a0', 'turn-end:moved-a0', 'moved-u1']);
  });

  it('chat.fork on a store-backed chat is refused', async () => {
    await seedStore();
    const adapter = new FakeAdapter();
    addLocal(adapter, S1);
    await start(adapter, 1);
    const r = await call('chat.fork', { sessionId: S1, upToItemId: 'moved-u0' });
    expect(r.error).toEqual({ code: 'FORK_FAILED', message: 'Not available for a moved chat yet' });
    expect(adapter.forks).toEqual([]);
  });
});
