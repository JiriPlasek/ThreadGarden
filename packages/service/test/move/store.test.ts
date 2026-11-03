import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/history/db.js';
import { ChatStore } from '../../src/move/store.js';

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const open = (path = ':memory:'): Db => {
  const db = openDb(path);
  dbs.push(db);
  return db;
};
const make = (db = open()) => {
  const appended: string[] = [];
  let t = 1000;
  const store = new ChatStore(
    db,
    (id) => appended.push(id),
    () => (t += 10),
  );
  return { store, appended, sdk: store.sessionStore() };
};
const key = (sessionId: string, subpath?: string, projectKey = 'p') => ({
  projectKey,
  sessionId,
  ...(subpath !== undefined ? { subpath } : {}),
});
const user = (uuid: string) => ({ type: 'user', uuid, message: { content: uuid } });

describe('ChatStore', () => {
  it('append twice with the same uuid stores one entry', async () => {
    const { sdk } = make();
    await sdk.append(key('s1'), [user('a'), user('b')]);
    await sdk.append(key('s1'), [user('b'), user('c')]);
    expect((await sdk.load(key('s1')))?.map((e) => e.uuid)).toEqual(['a', 'b', 'c']);
  });

  it('entries without a uuid are kept in order', async () => {
    const { sdk } = make();
    await sdk.append(key('s1'), [{ type: 'summary', n: 1 }, user('a')]);
    await sdk.append(key('s1'), [
      { type: 'summary', n: 1 },
      { type: 'tag', n: 2 },
    ]);
    expect(await sdk.load(key('s1'))).toEqual([
      { type: 'summary', n: 1 },
      user('a'),
      { type: 'summary', n: 1 },
      { type: 'tag', n: 2 },
    ]);
  });

  it('load answers any projectKey and returns subagent subpaths via listSubkeys', async () => {
    const { sdk } = make();
    await sdk.append(key('s1', undefined, 'one'), [user('a')]);
    await sdk.append(key('s1', 'subagents/agent-1', 'one'), [user('x')]);
    expect(await sdk.load(key('s1', undefined, 'other'))).toEqual([user('a')]);
    expect(await sdk.load(key('s1', 'subagents/agent-1', 'other'))).toEqual([user('x')]);
    expect(await sdk.listSubkeys?.({ projectKey: 'other', sessionId: 's1' })).toEqual([
      'subagents/agent-1',
    ]);
  });

  it('load returns null for an unknown session', async () => {
    const { sdk } = make();
    expect(await sdk.load(key('nope'))).toBeNull();
    expect(await sdk.load(key('nope', 'subagents/a'))).toBeNull();
  });

  it('put then entries round-trips deep-equal', () => {
    const { store } = make();
    const keys = [
      { entries: [user('a'), { type: 'summary', deep: { list: [1, 'x', null] } }] },
      { subpath: 'subagents/agent-1', entries: [user('x')] },
    ];
    store.put('s1', keys);
    expect(store.entries('s1')).toEqual(keys);
    expect(store.entries('unknown')).toEqual([]);
  });

  it('markHere then markAway flips isHere/isAway and awayTo', async () => {
    const { store, sdk } = make();
    expect([store.isHere('s1'), store.isAway('s1'), store.awayTo('s1')]).toEqual([
      false,
      false,
      null,
    ]);
    store.markHere('s1', '/work/a', { machineId: 'm1', name: 'laptop' });
    expect(store.isHere('s1')).toBe(true);
    expect(store.isAway('s1')).toBe(false);
    expect(store.awayTo('s1')).toBeNull();
    expect(store.here()).toEqual([{ sessionId: 's1', cwd: '/work/a' }]);
    expect(await sdk.listSessions?.('whatever')).toEqual([{ sessionId: 's1', mtime: 1010 }]);

    store.markAway('s1', { machineId: 'm2', name: 'ubuntu' });
    expect(store.isHere('s1')).toBe(false);
    expect(store.isAway('s1')).toBe(true);
    expect(store.awayTo('s1')).toEqual({ machineId: 'm2', name: 'ubuntu' });
    expect(store.here()).toEqual([]);
    expect(await sdk.listSessions?.('whatever')).toEqual([]);

    // Coming back: the chat is here again, listed once.
    store.markHere('s1', '/work/b', { machineId: 'm2', name: 'ubuntu' });
    expect(store.isHere('s1')).toBe(true);
    expect(store.here()).toEqual([{ sessionId: 's1', cwd: '/work/b' }]);
  });

  it('onAppend fires once per append call with the session id', async () => {
    const { sdk, appended } = make();
    await sdk.append(key('s1'), [user('a'), user('b')]);
    await sdk.append(key('s2', 'subagents/a'), [user('c')]);
    expect(appended).toEqual(['s1', 's2']);
  });

  it('an append moves the listed mtime of a chat that lives here', async () => {
    const { store, sdk } = make();
    store.markHere('s1', '/work/a', { machineId: 'm1', name: 'laptop' });
    expect(await sdk.listSessions?.('p')).toEqual([{ sessionId: 's1', mtime: 1010 }]);
    await sdk.append(key('s1'), [user('a')]);
    expect(await sdk.listSessions?.('p')).toEqual([{ sessionId: 's1', mtime: 1020 }]);
  });

  it('historyOf reads a chat that lives here from the store, in its folder', () => {
    const { store, sdk } = make();
    expect(store.historyOf('s1')).toEqual({});
    store.markHere('s1', '/work/a', { machineId: 'm1', name: 'laptop' });
    expect(store.historyOf('s1')).toEqual({ dir: '/work/a', sessionStore: sdk });
    store.markAway('s1', { machineId: 'm2', name: 'ubuntu' });
    expect(store.historyOf('s1')).toEqual({});
  });

  it('survives reopening the db', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tg-store-'));
    dirs.push(dir);
    const path = join(dir, 'tg.db');
    const first = open(path);
    const a = make(first);
    await a.sdk.append(key('s1'), [user('a')]);
    a.store.put('s1', [{ subpath: 'subagents/x', entries: [user('x')] }]);
    a.store.markHere('s1', '/work/a', { machineId: 'm1', name: 'laptop' });
    first.close();
    dbs.splice(dbs.indexOf(first), 1);

    const b = make(open(path));
    expect(await b.sdk.load(key('s1'))).toEqual([user('a')]);
    expect(b.store.entries('s1')).toEqual([
      { entries: [user('a')] },
      { subpath: 'subagents/x', entries: [user('x')] },
    ]);
    expect(b.store.here()).toEqual([{ sessionId: 's1', cwd: '/work/a' }]);
    // Appending after a reopen continues the order.
    await b.sdk.append(key('s1'), [user('b'), user('a')]);
    expect((await b.sdk.load(key('s1')))?.map((e) => e.uuid)).toEqual(['a', 'b']);
  });
});
