/**
 * Moving a chat between two services (protocol 9): the source exports it in
 * parts, the target imports and commits it, then the source marks it moved.
 * Two services in-process, each with a fake SDK and its own data dir.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChatItem, ChatSummary, MoveKey, MovePeer } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startService, type ServiceHandle, type StartOptions } from '../../src/main.js';
import type { SessionMessage } from '../../src/sdk/adapter.js';
import {
  MOVE_IMPORT_MAX_BYTES,
  MOVE_IMPORT_MS,
  MOVE_LOCK_MS,
  MOVE_PART_BYTES,
  MOVE_SWEEP_MS,
  MoveImports,
  MoveLocks,
  MoveTransfers,
  splitParts,
} from '../../src/server/handlers/move.js';
import { FakeAdapter, type FakeSession } from '../../src/testing/fake-adapter.js';
import { init, result } from '../chat/live-helpers.js';
import { TestClient, eventually } from '../e2e/ws-client.js';

const LAPTOP: MovePeer = { machineId: 'm-laptop', name: 'laptop' };
const UBUNTU: MovePeer = { machineId: 'm-ubuntu', name: 'kumbal-machine' };

type Reply = { result?: unknown; error?: { code: string; message: string } };
type Machine = {
  svc: ServiceHandle;
  adapter: FakeAdapter;
  peer: MovePeer;
  /** A folder that exists on this machine. */
  folder: string;
  call(method: string, params: unknown): Promise<Reply>;
  ok<T = unknown>(method: string, params: unknown): Promise<T>;
};

let dir: string;
const running: ServiceHandle[] = [];
/** Added to the services' clock (lock and import expiry). */
let skew = 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadgarden-transfer-'));
  skew = 0;
});
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
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
  }) as SessionMessage;

/** A chat in this machine's own (local) Claude Code history. */
const addLocal = (
  adapter: FakeAdapter,
  sessionId: string,
  cwd: string,
  messages = [msg(sessionId, `u-${sessionId}`, 'user', 'hello')],
) => {
  adapter.sessions.set(sessionId, {
    info: { sessionId, summary: `Chat ${sessionId}`, lastModified: 1_700_000_000_000, cwd },
    messages,
  });
};

const list = async (m: Machine) =>
  (await m.ok<{ items: ChatSummary[] }>('sessions.list', { place: { kind: 'all' }, limit: 50 }))
    .items;

const machine = async (
  name: string,
  peer: MovePeer,
  seed?: (adapter: FakeAdapter, folder: string) => void,
  extra: Partial<StartOptions> = {},
  given?: FakeAdapter,
): Promise<Machine> => {
  const root = join(dir, name);
  const folder = join(root, 'proj');
  await mkdir(folder, { recursive: true });
  const adapter = given ?? new FakeAdapter();
  seed?.(adapter, folder);
  const svc = await startService({
    dataDir: join(root, 'data'),
    claudeConfigDir: join(root, 'claude'),
    adapter,
    claude: { path: '/bin/claude', version: '2.1.314' },
    externalRun: async () => '[]',
    sessionEnv: { PATH: '/usr/bin' },
    installSignalHandlers: false,
    clock: () => Date.now() + skew,
    ...extra,
  });
  running.push(svc);
  let nextId = 1;
  const call = (method: string, params: unknown) =>
    svc.router.dispatch(
      { id: nextId++, method, params },
      { clientId: 't', origin: 'remote', deviceId: 'd' },
    ) as Promise<Reply>;
  const ok = async <T = unknown>(method: string, params: unknown): Promise<T> => {
    const r = await call(method, params);
    if (r.error) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
    return r.result as T;
  };
  const m: Machine = { svc, adapter, peer, folder, call, ok };
  const local = adapter.sessions.size;
  if (local > 0 && !given) await eventually(async () => (await list(m)).length >= local);
  return m;
};

/** The same machine after a service restart: same data dir and history, nothing in memory. */
const restart = async (m: Machine, name: string): Promise<Machine> => {
  await m.svc.close();
  running.splice(running.indexOf(m.svc), 1);
  let synced = 0;
  const list = m.adapter.listSessions.bind(m.adapter);
  m.adapter.listSessions = (o) => {
    if (!o?.sessionStore) synced++;
    return list(o);
  };
  const again = await machine(name, m.peer, undefined, {}, m.adapter);
  // Its first full sync began; a few chats take it moments.
  await eventually(() => synced > 0);
  await new Promise((r) => setTimeout(r, 150));
  return again;
};

/** Holds calls until `open()` (an SDK read or an index pass that takes long). */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
};

type Begin = { exportId: string; parts: number; bytes: number };

/** Copies the chat's parts from `src` to `dst` under a fresh import id. */
const copyParts = async (src: Machine, dst: Machine, sessionId: string, begin: Begin) => {
  const importId = randomUUID();
  const sizes: number[] = [];
  const keys: MoveKey[] = [];
  for (let index = 0; index < begin.parts; index++) {
    const part = await src.ok<{ keys: MoveKey[] }>('move.exportPart', {
      exportId: begin.exportId,
      index,
    });
    sizes.push(Buffer.byteLength(JSON.stringify(part.keys)));
    keys.push(...part.keys);
    await dst.ok('move.importPart', {
      importId,
      sessionId,
      index,
      parts: begin.parts,
      keys: part.keys,
    });
  }
  return { importId, sizes, keys };
};

/** The whole move, as the desktop runs it. */
const move = async (src: Machine, dst: Machine, sessionId: string, cwd: string) => {
  const begunAt = Date.now() + skew;
  const begin = await src.ok<Begin>('move.exportBegin', { exportId: randomUUID(), sessionId });
  const { importId, sizes, keys } = await copyParts(src, dst, sessionId, begin);
  const { summary } = await dst.ok<{ summary: ChatSummary }>('move.commit', {
    importId,
    sessionId,
    cwd,
    from: src.peer,
  });
  const marked = { exportId: begin.exportId, sessionId, begunAt, to: dst.peer };
  await src.ok('move.markMoved', marked);
  return { begin, importId, sizes, keys, summary, marked };
};

const items = async (m: Machine, sessionId: string) =>
  (await m.ok<{ items: ChatItem[] }>('chat.open', { sessionId, tail: 10_000 })).items;

/** Sends a message and ends its turn: the chat has an idle live process. */
const idleLive = async (m: Machine, sessionId: string): Promise<FakeSession> => {
  await m.ok('chat.send', { sessionId, text: 'go' });
  const s = m.adapter.lastSession();
  s.emit(init(sessionId));
  s.emit(result(`r-${randomUUID()}`, { session_id: sessionId }));
  await eventually(() => m.svc.host!.get(sessionId)?.status === 'idle');
  return s;
};

describe('a move between two services', () => {
  it('a 9 MiB chat moves in 3 parts and the target reads it back deep-equal', async () => {
    const big = Array.from({ length: 36 }, (_, i) =>
      msg('big', `m${i}`, i % 2 === 0 ? 'user' : 'assistant', `${i}:`.padEnd(256 * 1024, 'x')),
    );
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 'big', f, big));
    const ubuntu = await machine('ubuntu', UBUNTU);
    const before = await items(laptop, 'big');

    const { begin, sizes, keys, summary } = await move(laptop, ubuntu, 'big', ubuntu.folder);

    expect(begin.parts).toBe(3);
    expect(begin.bytes).toBeGreaterThan(9 * 1024 * 1024);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(MOVE_PART_BYTES);
    // The main transcript was cut between parts, and reads back whole and in order.
    expect(keys.every((k) => k.subpath === undefined)).toBe(true);
    const sent = keys.flatMap((k) => k.entries).map((e) => ({ uuid: e.uuid, message: e.message }));
    expect(sent).toEqual(big.map((m) => ({ uuid: m.uuid, message: m.message })));
    expect(summary.sessionId).toBe('big');
    // `ts` is when the fake's untimed messages were read, not part of the chat.
    const untimed = (l: ChatItem[]) => l.map((i) => ({ ...i, ts: undefined }));
    expect(untimed(await items(ubuntu, 'big'))).toEqual(untimed(before));
  });

  it('subagent keys come along', async () => {
    const sub = [
      { type: 'user', uuid: 'sa-1', message: { role: 'user', content: 'list the files' } },
      { type: 'assistant', uuid: 'sa-2', message: { role: 'assistant', content: [] } },
    ];
    const laptop = await machine('laptop', LAPTOP, (a, f) => {
      addLocal(a, 's1', f);
      a.subagents.set('s1', [{ subpath: 'subagents/agent-a1', entries: sub }]);
    });
    const ubuntu = await machine('ubuntu', UBUNTU);
    await move(laptop, ubuntu, 's1', ubuntu.folder);

    // The target resumes it from its store, where the subagent's transcript is.
    await ubuntu.ok('chat.send', { sessionId: 's1', text: 'carry on' });
    const store = ubuntu.adapter.lastSession().options.sessionStore!;
    const key = { projectKey: 'any', sessionId: 's1' };
    expect(await store.listSubkeys!(key)).toEqual(['subagents/agent-a1']);
    expect(await store.load({ ...key, subpath: 'subagents/agent-a1' })).toEqual(sub);
  });

  it('exportBegin on a busy chat answers BUSY', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    await laptop.ok('chat.send', { sessionId: 's1', text: 'a long turn' });
    expect(
      (await laptop.call('move.exportBegin', { exportId: randomUUID(), sessionId: 's1' })).error
        ?.code,
    ).toBe('BUSY');
    // Refused without keeping the lock: the chat can be sent to.
    expect(laptop.svc.moveLocks.isLocked('s1')).toBe(false);
  });

  it('chat.send during an export answers MOVING; after abort it works again', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const begin = await laptop.ok<Begin>('move.exportBegin', {
      exportId: randomUUID(),
      sessionId: 's1',
    });
    expect((await laptop.call('chat.send', { sessionId: 's1', text: 'hi' })).error?.code).toBe(
      'MOVING',
    );
    expect(
      (await laptop.call('move.exportBegin', { exportId: randomUUID(), sessionId: 's1' })).error
        ?.code,
    ).toBe('MOVING');

    await laptop.ok('move.abort', { exportId: begin.exportId });
    const part = await laptop.call('move.exportPart', { exportId: begin.exportId, index: 0 });
    expect(part.error?.code).toBe('EXPIRED');
    await laptop.ok('chat.send', { sessionId: 's1', text: 'hi' });
    // An abort again (a retry) is fine.
    await laptop.ok('move.abort', { exportId: begin.exportId });
  });

  it('an export expires with its lock', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const begin = await laptop.ok<Begin>('move.exportBegin', {
      exportId: randomUUID(),
      sessionId: 's1',
    });
    skew = MOVE_LOCK_MS;
    const part = await laptop.call('move.exportPart', { exportId: begin.exportId, index: 0 });
    expect(part.error?.code).toBe('EXPIRED');
    await laptop.ok('chat.send', { sessionId: 's1', text: 'hi' });
  });

  it('commit with a missing part answers EXPIRED and stores nothing', async () => {
    const ubuntu = await machine('ubuntu', UBUNTU);
    const keys = [
      { entries: [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'x' } }] },
    ];
    await ubuntu.ok('move.importPart', {
      importId: 'i1',
      sessionId: 's1',
      index: 0,
      parts: 2,
      keys,
    });
    const commit = (importId: string) =>
      ubuntu.call('move.commit', { importId, sessionId: 's1', cwd: ubuntu.folder, from: LAPTOP });
    expect((await commit('i1')).error?.code).toBe('EXPIRED');
    expect((await commit('never-begun')).error?.code).toBe('EXPIRED');

    // All parts, but too late.
    await ubuntu.ok('move.importPart', {
      importId: 'i2',
      sessionId: 's1',
      index: 0,
      parts: 1,
      keys,
    });
    skew = 10 * 60_000;
    expect((await commit('i2')).error?.code).toBe('EXPIRED');

    expect(await list(ubuntu)).toEqual([]);
    expect((await ubuntu.call('chat.open', { sessionId: 's1', tail: 10 })).error?.code).toBe(
      'NOT_FOUND',
    );
  });

  it('commit makes the missing chat folder, empty, and lists the chat on the target', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    const cwd = join(dir, 'ubuntu', 'home', 'projects', 'repo');

    const { summary, importId } = await move(laptop, ubuntu, 's1', cwd);

    // Claude Code starts in the chat's folder, so it must exist; Claude clones into it.
    expect(existsSync(cwd)).toBe(true);
    expect(await readdir(cwd)).toEqual([]);
    expect(summary).toMatchObject({ sessionId: 's1', cwd });
    expect((await list(ubuntu)).map((s) => [s.sessionId, s.cwd])).toEqual([['s1', cwd]]);
    // A retried commit (its answer was lost) succeeds with the same chat.
    const again = await ubuntu.ok<{ summary: ChatSummary }>('move.commit', {
      importId,
      sessionId: 's1',
      cwd,
      from: LAPTOP,
    });
    expect(again.summary.sessionId).toBe('s1');
  });

  it('a chat coming back onto its away copy shows the new history, not the stale local one', async () => {
    const ubuntu = await machine('ubuntu', UBUNTU, (a, f) =>
      addLocal(a, 's1', f, [msg('s1', 'u-old', 'user', 'a stale question')]),
    );
    const laptop = await machine('laptop', LAPTOP);
    const stale = await idleLive(ubuntu, 's1');
    await move(ubuntu, laptop, 's1', laptop.folder);
    expect(stale.closed).toBe(true);
    const s = await idleLive(laptop, 's1');
    await s.options.sessionStore!.append({ projectKey: 'k', sessionId: 's1' }, [
      { type: 'user', uuid: 'u-new', message: { role: 'user', content: 'the newest question' } },
    ]);

    await move(laptop, ubuntu, 's1', ubuntu.folder);

    const shown = JSON.stringify(await items(ubuntu, 's1'));
    expect(shown).toContain('the newest question');
    // Ubuntu's own transcript of the chat is the stale copy: the store wins.
    await ubuntu.ok('chat.send', { sessionId: 's1', text: 'go on' });
    expect(ubuntu.adapter.lastSession().options.sessionStore).toBeDefined();
  });

  it('markMoved hides the source copy and ends its live process', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    const live = await idleLive(laptop, 's1');

    const { marked } = await move(laptop, ubuntu, 's1', ubuntu.folder);

    expect(live.closed).toBe(true);
    expect(laptop.svc.host!.get('s1')).toBeUndefined();
    expect(laptop.svc.moveLocks.isLocked('s1')).toBe(false);
    expect(await list(laptop)).toEqual([]);
    expect((await laptop.call('chat.send', { sessionId: 's1', text: 'hi' })).error?.code).toBe(
      'MOVED',
    );
    expect(
      (await laptop.call('move.exportBegin', { exportId: randomUUID(), sessionId: 's1' })).error
        ?.code,
    ).toBe('MOVED');
    const open = await laptop.ok<{ movedTo: unknown }>('chat.open', { sessionId: 's1', tail: 1 });
    expect(open.movedTo).toEqual(UBUNTU);
    // The desktop retries markMoved: the same exportId again is fine.
    await laptop.ok('move.markMoved', marked);
  });

  it('markMoved still works after the export expired', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    const begunAt = Date.now();
    const begin = await laptop.ok<Begin>('move.exportBegin', {
      exportId: randomUUID(),
      sessionId: 's1',
    });
    const { importId } = await copyParts(laptop, ubuntu, 's1', begin);
    await ubuntu.ok('move.commit', { importId, sessionId: 's1', cwd: ubuntu.folder, from: LAPTOP });

    skew = MOVE_LOCK_MS + 60_000;
    await laptop.ok('move.markMoved', {
      exportId: begin.exportId,
      sessionId: 's1',
      begunAt,
      to: UBUNTU,
    });
    expect(await list(laptop)).toEqual([]);
  });

  it('a chat moved back to its first machine is one chat with the newest history', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    await move(laptop, ubuntu, 's1', ubuntu.folder);

    // A turn on the target: the SDK mirrors it into the store.
    const s = await idleLive(ubuntu, 's1');
    await s.options.sessionStore!.append({ projectKey: 'k', sessionId: 's1' }, [
      { type: 'user', uuid: 'u-ubuntu', message: { role: 'user', content: 'go' } },
      {
        type: 'assistant',
        uuid: 'a-ubuntu',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done on ubuntu' }] },
      },
    ]);

    await move(ubuntu, laptop, 's1', laptop.folder);

    // The target exported it from its store (R6), not from a local transcript.
    expect(ubuntu.adapter.imports).toEqual([]);
    expect(await list(ubuntu)).toEqual([]);
    expect((await list(laptop)).map((c) => c.sessionId)).toEqual(['s1']);
    expect(JSON.stringify(await items(laptop, 's1'))).toContain('done on ubuntu');
    // Here again: it resumes from the store.
    await laptop.ok('chat.send', { sessionId: 's1', text: 'back home' });
    expect(laptop.adapter.lastSession().options.sessionStore).toBeDefined();
  });

  it('a chat moved away leaves no permission mode behind: back here, it starts afresh', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    await idleLive(laptop, 's1');
    await laptop.ok('chat.setPermissionMode', { sessionId: 's1', value: 'auto' });
    await move(laptop, ubuntu, 's1', ubuntu.folder);
    // Move to… doesn't carry the mode over.
    const there = await idleLive(ubuntu, 's1');
    expect(there.options.permissionMode).toBeUndefined();

    await move(ubuntu, laptop, 's1', laptop.folder);
    const open = await laptop.ok<{ header: { permissionMode?: string } }>('chat.open', {
      sessionId: 's1',
      tail: 1,
    });
    expect(open.header.permissionMode).toBeUndefined();
    await laptop.ok('chat.send', { sessionId: 's1', text: 'back home' });
    expect(laptop.adapter.lastSession().options.permissionMode).toBeUndefined();
  });

  it('moving onto an old copy replaces it (entries without a uuid are not doubled)', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    await move(laptop, ubuntu, 's1', ubuntu.folder);
    const s = await idleLive(ubuntu, 's1');
    await s.options.sessionStore!.append({ projectKey: 'k', sessionId: 's1' }, [
      { type: 'custom-title', customTitle: 'Usage fix' },
    ]);
    await move(ubuntu, laptop, 's1', laptop.folder);
    await move(laptop, ubuntu, 's1', ubuntu.folder);

    await ubuntu.ok('chat.send', { sessionId: 's1', text: 'again' });
    const store = ubuntu.adapter.lastSession().options.sessionStore!;
    const entries = (await store.load({ projectKey: 'k', sessionId: 's1' })) ?? [];
    expect(entries.filter((e) => e.type === 'custom-title')).toHaveLength(1);
    expect(entries.map((e) => e.uuid ?? e.type)).toEqual(['u-s1', 'custom-title']);
  });

  it('scheduled.create with the same id twice keeps one send', async () => {
    const ubuntu = await machine('ubuntu', UBUNTU, (a, f) => addLocal(a, 's1', f));
    const p = { sessionId: 's1', text: 'later', sendAt: Date.now() + 3_600_000, id: 'sch-1' };
    const first = await ubuntu.ok<{ id: string }>('scheduled.create', p);
    const second = await ubuntu.ok<{ id: string }>('scheduled.create', p);
    expect(first.id).toBe('sch-1');
    expect(second).toEqual(first);
    const all = await ubuntu.ok<{ items: unknown[] }>('scheduled.list', { sessionId: 's1' });
    expect(all.items).toHaveLength(1);
  });

  it("scheduled.create with another chat's id is refused", async () => {
    const ubuntu = await machine('ubuntu', UBUNTU, (a, f) => {
      addLocal(a, 's1', f);
      addLocal(a, 's2', f);
    });
    const p = { sessionId: 's1', text: 'later', sendAt: Date.now() + 3_600_000, id: 'sch-1' };
    await ubuntu.ok('scheduled.create', p);
    const other = await ubuntu.call('scheduled.create', { ...p, sessionId: 's2' });
    expect(other.error?.code).toBe('INVALID_PARAMS');
    const s2 = await ubuntu.ok<{ items: unknown[] }>('scheduled.list', { sessionId: 's2' });
    expect(s2.items).toEqual([]);
  });

  // ── fix round 1 ──

  it('a markMoved retried after the chat came back leaves it here', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    const first = await move(laptop, ubuntu, 's1', ubuntu.folder);
    await move(ubuntu, laptop, 's1', laptop.folder);
    const live = await idleLive(laptop, 's1');

    // A late retry of the first move's markMoved.
    await laptop.ok('move.markMoved', first.marked);

    expect(live.closed).toBe(false);
    expect((await list(laptop)).map((c) => c.sessionId)).toEqual(['s1']);
    const open = await laptop.ok<{ movedTo: unknown }>('chat.open', { sessionId: 's1', tail: 1 });
    expect(open.movedTo).toBeNull();
  });

  it('markMoved after the lock ran out and the chat went on here answers EXPIRED', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    const begunAt = Date.now();
    const begin = await laptop.ok<Begin>('move.exportBegin', {
      exportId: randomUUID(),
      sessionId: 's1',
    });
    const { importId } = await copyParts(laptop, ubuntu, 's1', begin);
    await ubuntu.ok('move.commit', { importId, sessionId: 's1', cwd: ubuntu.folder, from: LAPTOP });
    // The lock ran out and the owner went on chatting on the laptop.
    skew = MOVE_LOCK_MS + 60_000;
    const live = await idleLive(laptop, 's1');

    const r = await laptop.call('move.markMoved', {
      exportId: begin.exportId,
      sessionId: 's1',
      begunAt,
      to: UBUNTU,
    });

    expect(r.error?.code).toBe('EXPIRED');
    expect(live.closed).toBe(false);
    expect((await list(laptop)).map((c) => c.sessionId)).toEqual(['s1']);
  });

  it('exportBegin with the same exportId twice gives the same answer and one lock', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const exportId = randomUUID();
    const first = await laptop.ok<Begin>('move.exportBegin', { exportId, sessionId: 's1' });
    const again = await laptop.ok<Begin>('move.exportBegin', { exportId, sessionId: 's1' });
    expect(again).toEqual(first);
    expect(first.exportId).toBe(exportId);
    expect(laptop.svc.moveLocks.exportIdOf('s1')).toBe(exportId);
    const other = await laptop.call('move.exportBegin', {
      exportId: randomUUID(),
      sessionId: 's1',
    });
    expect(other.error?.code).toBe('MOVING');
    // The desktop that lost the answer can still abort it.
    await laptop.ok('move.abort', { exportId });
    expect(laptop.svc.moveLocks.isLocked('s1')).toBe(false);
  });

  it('exportBegin of a chat larger than an import may be answers TOO_LARGE', async () => {
    const laptop = await machine(
      'laptop',
      LAPTOP,
      (a, f) => addLocal(a, 's1', f, [msg('s1', 'u1', 'user', 'x'.repeat(2_000))]),
      { moveMaxBytes: 1_000 },
    );
    const r = await laptop.call('move.exportBegin', { exportId: randomUUID(), sessionId: 's1' });
    expect(r.error?.code).toBe('TOO_LARGE');
    expect(laptop.svc.moveLocks.isLocked('s1')).toBe(false);
  });

  it('markMoved tells the clients the chat changed', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    const client = await TestClient.connect(laptop.svc.port, laptop.svc.token);
    try {
      const begin = await laptop.ok<Begin>('move.exportBegin', {
        exportId: randomUUID(),
        sessionId: 's1',
      });
      const { importId } = await copyParts(laptop, ubuntu, 's1', begin);
      await ubuntu.ok('move.commit', {
        importId,
        sessionId: 's1',
        cwd: ubuntu.folder,
        from: LAPTOP,
      });
      client.events.length = 0;
      await laptop.ok('move.markMoved', {
        exportId: begin.exportId,
        sessionId: 's1',
        begunAt: Date.now(),
        to: UBUNTU,
      });
      await client.waitFor(
        (e) =>
          e.event === 'sessions.changed' &&
          (e.data as { sessionIds: string[] }).sessionIds.includes('s1'),
      );
    } finally {
      await client.close();
    }
  });

  it("commit into Claude Code's own folder is refused and stores nothing", async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    const begin = await laptop.ok<Begin>('move.exportBegin', {
      exportId: randomUUID(),
      sessionId: 's1',
    });
    const { importId } = await copyParts(laptop, ubuntu, 's1', begin);
    const cwd = join(dir, 'ubuntu', 'claude', 'projects', 'repo');
    const r = await ubuntu.call('move.commit', { importId, sessionId: 's1', cwd, from: LAPTOP });
    expect(r.error?.code).toBe('INVALID_PARAMS');
    expect(existsSync(dirname(cwd))).toBe(false);
    expect(await list(ubuntu)).toEqual([]);
  });
});

describe('final review fixes', () => {
  /** One import of `sessionId` with a single message, ready to commit on `m`. */
  const importOne = async (m: Machine, sessionId: string, text: string) => {
    const importId = randomUUID();
    const keys = [
      { entries: [{ type: 'user', uuid: `u-${text}`, message: { role: 'user', content: text } }] },
    ];
    await m.ok('move.importPart', { importId, sessionId, index: 0, parts: 1, keys });
    return importId;
  };

  // ── C1 ──
  it('commit leaves an existing chat folder as it is', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    await writeFile(join(ubuntu.folder, 'README.md'), 'mine');
    await move(laptop, ubuntu, 's1', ubuntu.folder);
    expect(await readdir(ubuntu.folder)).toEqual(['README.md']);
  });

  // ── C2 ──
  it('a commit onto a chat that lives here is refused and stores nothing', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    await move(laptop, ubuntu, 's1', ubuntu.folder);
    // A duplicate import of an older copy (e.g. after a failed hand-off).
    const importId = await importOne(ubuntu, 's1', 'an older copy');
    const r = await ubuntu.call('move.commit', {
      importId,
      sessionId: 's1',
      cwd: ubuntu.folder,
      from: LAPTOP,
    });
    expect(r.error?.code).toBe('ALREADY_HERE');
    expect(r.error?.message).toMatch(/^This chat is already on .+/);
    expect(JSON.stringify(await items(ubuntu, 's1'))).not.toContain('an older copy');
  });

  it('a commit onto a local chat here that never moved away is refused', async () => {
    const ubuntu = await machine('ubuntu', UBUNTU, (a, f) =>
      addLocal(a, 's1', f, [msg('s1', 'u-own', 'user', 'my own chat')]),
    );
    const importId = await importOne(ubuntu, 's1', 'someone else');
    const r = await ubuntu.call('move.commit', {
      importId,
      sessionId: 's1',
      cwd: ubuntu.folder,
      from: LAPTOP,
    });
    expect(r.error?.code).toBe('ALREADY_HERE');
    const shown = JSON.stringify(await items(ubuntu, 's1'));
    expect(shown).toContain('my own chat');
    expect(shown).not.toContain('someone else');
  });

  // ── I1 ──
  it('a scheduled send stays pending while its chat is locked, and once it moved away', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    const p = { sessionId: 's1', text: 'later', sendAt: Date.now() + 60_000, id: 'sch-1' };
    await laptop.ok('scheduled.create', p);
    const state = async () =>
      (await laptop.ok<{ items: { state: string }[] }>('scheduled.list', { sessionId: 's1' }))
        .items[0]?.state;

    laptop.svc.moveLocks.lock('s1', 'x1');
    skew = 120_000;
    laptop.svc.scheduled!.check();
    await new Promise((r) => setTimeout(r, 50));
    expect(await state()).toBe('pending');
    laptop.svc.moveLocks.unlock('s1');

    skew = 0;
    await move(laptop, ubuntu, 's1', ubuntu.folder);
    skew = 120_000;
    laptop.svc.scheduled!.check();
    await new Promise((r) => setTimeout(r, 50));
    expect(await state()).toBe('pending');
  });

  // ── I2 ──
  it('a chat running in a terminal is busy for move.check and exportBegin', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f), {
      externalRun: async () =>
        JSON.stringify([
          { pid: 7, cwd: '/x', kind: 'interactive', startedAt: 1, sessionId: 's1', status: 'busy' },
        ]),
    });
    const check = await laptop.ok<{ busy: string | null }>('move.check', { sessionId: 's1' });
    expect(check.busy).toBe('terminal');
    const r = await laptop.call('move.exportBegin', { exportId: randomUUID(), sessionId: 's1' });
    expect(r.error).toEqual({ code: 'BUSY', message: 'This chat is running in a terminal' });
    expect(laptop.svc.moveLocks.isLocked('s1')).toBe(false);
  });

  // ── I3 ──
  it('markMoved works after a restart of the source (no export in memory)', async () => {
    let laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    const begunAt = Date.now();
    const begin = await laptop.ok<Begin>('move.exportBegin', {
      exportId: randomUUID(),
      sessionId: 's1',
    });
    const { importId } = await copyParts(laptop, ubuntu, 's1', begin);
    await ubuntu.ok('move.commit', { importId, sessionId: 's1', cwd: ubuntu.folder, from: LAPTOP });

    laptop = await restart(laptop, 'laptop');
    await laptop.ok('move.markMoved', {
      exportId: begin.exportId,
      sessionId: 's1',
      begunAt,
      to: UBUNTU,
    });
    expect(await list(laptop)).toEqual([]);
    expect((await laptop.call('chat.send', { sessionId: 's1', text: 'hi' })).error?.code).toBe(
      'MOVED',
    );
  });

  it('a late markMoved after the chat came back and the service restarted leaves it here', async () => {
    let laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    const first = await move(laptop, ubuntu, 's1', ubuntu.folder);
    await move(ubuntu, laptop, 's1', laptop.folder);
    laptop = await restart(laptop, 'laptop');

    expect((await laptop.call('move.markMoved', first.marked)).error).toBeUndefined();
    expect((await list(laptop)).map((c) => c.sessionId)).toEqual(['s1']);
    const open = await laptop.ok<{ movedTo: unknown }>('chat.open', { sessionId: 's1', tail: 1 });
    expect(open.movedTo).toBeNull();
  });

  it('markMoved after a restart, once the chat went on here, answers EXPIRED', async () => {
    let laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const ubuntu = await machine('ubuntu', UBUNTU);
    const begunAt = Date.now();
    const begin = await laptop.ok<Begin>('move.exportBegin', {
      exportId: randomUUID(),
      sessionId: 's1',
    });
    const { importId } = await copyParts(laptop, ubuntu, 's1', begin);
    await ubuntu.ok('move.commit', { importId, sessionId: 's1', cwd: ubuntu.folder, from: LAPTOP });
    laptop = await restart(laptop, 'laptop');
    skew = 1_000;
    await idleLive(laptop, 's1');

    const r = await laptop.call('move.markMoved', {
      exportId: begin.exportId,
      sessionId: 's1',
      begunAt,
      to: UBUNTU,
    });
    expect(r.error?.code).toBe('EXPIRED');
    expect((await list(laptop)).map((c) => c.sessionId)).toEqual(['s1']);
  });

  it('an export this service never knew is not EXPIRED: the chat is marked moved', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const r = await laptop.call('move.markMoved', {
      exportId: 'unknown',
      sessionId: 's1',
      begunAt: Date.now(),
      to: UBUNTU,
    });
    expect(r.error).toBeUndefined();
    expect(await list(laptop)).toEqual([]);
  });

  // ── I5 ──
  it('a chat that lived here in the store and moved away again stays openable', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    let ubuntu = await machine('ubuntu', UBUNTU);
    await move(laptop, ubuntu, 's1', ubuntu.folder);
    await move(ubuntu, laptop, 's1', laptop.folder);
    // The start's full sync must keep it: Ubuntu has no transcript of its own.
    ubuntu = await restart(ubuntu, 'ubuntu');

    const open = await ubuntu.ok<{ movedTo: unknown; items: ChatItem[] }>('chat.open', {
      sessionId: 's1',
      tail: 10,
    });
    expect(open.movedTo).toEqual(LAPTOP);
    expect(JSON.stringify(open.items)).toContain('hello');
  });

  // ── minors ──
  it('move.abort unlocks a chat whose export is still gathering', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const held = gate();
    const read = laptop.adapter.importSession.bind(laptop.adapter);
    laptop.adapter.importSession = async (...a) => {
      await held.opened;
      return read(...a);
    };
    const exportId = randomUUID();
    const begun = laptop.call('move.exportBegin', { exportId, sessionId: 's1' });
    await eventually(() => laptop.svc.moveLocks.isLocked('s1'));

    await laptop.ok('move.abort', { exportId });
    expect(laptop.svc.moveLocks.isLocked('s1')).toBe(false);
    held.open();
    expect((await begun).error?.code).toBe('EXPIRED');
    await laptop.ok('chat.send', { sessionId: 's1', text: 'hi' });
  });

  it('commit answers within the cap while the index queue is busy', async () => {
    const laptop = await machine('laptop', LAPTOP, (a, f) => addLocal(a, 's1', f));
    const busy = gate();
    const adapter = new FakeAdapter();
    const listAll = adapter.listSessions.bind(adapter);
    let first = true;
    adapter.listSessions = async (o) => {
      // The start's full sync takes long (a first run over thousands of chats).
      if (first && !o?.sessionStore) {
        first = false;
        await busy.opened;
      }
      return listAll(o);
    };
    const ubuntu = await machine('ubuntu', UBUNTU, undefined, {}, adapter);
    try {
      const started = Date.now();
      const { summary } = await move(laptop, ubuntu, 's1', ubuntu.folder);
      expect(Date.now() - started).toBeLessThan(9_000);
      expect(summary).toBeNull();
    } finally {
      busy.open();
    }
    await eventually(async () => (await list(ubuntu)).some((c) => c.sessionId === 's1'));
  }, 20_000);

  it('scheduled.create with the id of a failed send of the chat makes it pending again', async () => {
    const ubuntu = await machine('ubuntu', UBUNTU, (a, f) => addLocal(a, 's1', f));
    const p = { sessionId: 's1', text: 'later', sendAt: Date.now() + 3_600_000, id: 'sch-1' };
    await ubuntu.ok('scheduled.create', p);
    const raw = (
      ubuntu.svc.scheduled as unknown as { deps: { raw: import('node:sqlite').DatabaseSync } }
    ).deps.raw;
    raw
      .prepare(`UPDATE scheduled_sends SET state = 'failed', error = 'x' WHERE id = ?`)
      .run('sch-1');

    const again = await ubuntu.ok<{ state: string; text: string; sendAt: number }>(
      'scheduled.create',
      { ...p, text: 'later, again', sendAt: p.sendAt + 60_000 },
    );
    expect(again).toMatchObject({
      state: 'pending',
      text: 'later, again',
      sendAt: p.sendAt + 60_000,
    });
    const all = await ubuntu.ok<{ items: unknown[] }>('scheduled.list', { sessionId: 's1' });
    expect(all.items).toHaveLength(1);
  });
});

describe('splitParts', () => {
  const entry = (uuid: string, size: number) => ({ type: 'user', uuid, text: 'x'.repeat(size) });
  const sizeOf = (keys: MoveKey[]) => Buffer.byteLength(JSON.stringify(keys));

  it('keeps keys whole where they fit', () => {
    const keys = [
      { entries: [entry('a', 100)] },
      { subpath: 'subagents/agent-1', entries: [entry('b', 100)] },
    ];
    expect(splitParts(keys, 1_000)).toEqual([keys]);
  });

  it("splits a key's entries across parts, each at most the limit", () => {
    const keys = [
      { entries: [entry('a', 300), entry('b', 300), entry('c', 300)] },
      { subpath: 'subagents/agent-1', entries: [entry('d', 300)] },
    ];
    const parts = splitParts(keys, 800);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(sizeOf(p)).toBeLessThanOrEqual(800);
    // Read back in order, the entries of every key are the same.
    const flat = parts.flat();
    const of = (subpath?: string) =>
      flat.filter((k) => k.subpath === subpath).flatMap((k) => k.entries);
    expect(of(undefined)).toEqual(keys[0]!.entries);
    expect(of('subagents/agent-1')).toEqual(keys[1]!.entries);
  });

  it('a chat with no entries is one empty part', () => {
    expect(splitParts([], 800)).toEqual([[]]);
  });
});

describe('MoveImports', () => {
  const keys = (size: number) => [{ entries: [{ type: 'user', text: 'x'.repeat(size) }] }];

  it('an import past the cap answers TOO_LARGE and is dropped', () => {
    const imports = new MoveImports(() => 0, 1_000);
    const part = { importId: 'i1', sessionId: 's1', parts: 2 };
    imports.add({ ...part, index: 0, keys: keys(600) });
    expect(() => imports.add({ ...part, index: 1, keys: keys(600) })).toThrow(
      expect.objectContaining({ code: 'TOO_LARGE' }),
    );
    expect(() => imports.complete('i1', 's1')).toThrow(
      expect.objectContaining({ code: 'EXPIRED' }),
    );
  });

  it('the cap is 512 MiB', () => {
    expect(MOVE_IMPORT_MAX_BYTES).toBe(512 * 1024 * 1024);
  });

  it('a part sent again replaces the first copy', () => {
    const imports = new MoveImports(() => 0, 1_000);
    const part = { importId: 'i1', sessionId: 's1', parts: 1, index: 0 };
    imports.add({ ...part, keys: keys(600) });
    imports.add({ ...part, keys: keys(600) });
    expect(imports.complete('i1', 's1')).toEqual(keys(600));
  });

  it('the cap holds across every open import', () => {
    const imports = new MoveImports(() => 0, 1_000);
    imports.add({ importId: 'i1', sessionId: 's1', parts: 1, index: 0, keys: keys(600) });
    expect(() =>
      imports.add({ importId: 'i2', sessionId: 's2', parts: 1, index: 0, keys: keys(600) }),
    ).toThrow(expect.objectContaining({ code: 'TOO_LARGE' }));
    expect(imports.complete('i1', 's1')).toEqual(keys(600));
  });
});

describe('MoveTransfers', () => {
  const keys = (size: number) => [{ entries: [{ type: 'user', text: 'x'.repeat(size) }] }];

  it('a sweep every minute lets go of expired imports and exports, with no move calls', () => {
    let now = 1_000;
    const intervals: { fn: () => void; ms: number }[] = [];
    let cleared = 0;
    const timers = {
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: (fn: () => void, ms: number) => intervals.push({ fn, ms }),
      clearInterval: () => void cleared++,
    };
    const locks = new MoveLocks(() => now);
    const t = new MoveTransfers({ locks, now: () => now, timers });
    t.imports.add({ importId: 'i1', sessionId: 's1', index: 0, parts: 2, keys: keys(600) });
    locks.lock('s2', 'e1');
    t.exports.begin('e1', 's2', [keys(600)], 640);
    expect(t.bytesHeld()).toBeGreaterThan(1_200);
    expect(intervals.map((i) => i.ms)).toEqual([MOVE_SWEEP_MS]);

    now += Math.max(MOVE_IMPORT_MS, MOVE_LOCK_MS);
    intervals[0]!.fn();
    expect(t.bytesHeld()).toBe(0);

    t.close();
    expect(cleared).toBe(1);
  });
});
