/** v1.1 "Your turn" (design §3) and project order / missing folders (§4) in the db and catalog. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatStatus } from '@threadgarden/protocol';
import { Catalog, type LiveChat } from '../../src/history/catalog.js';
import { openDb, type Db } from '../../src/history/db.js';
import { Indexer } from '../../src/history/indexer.js';
import { createQuickSearch } from '../../src/history/search.js';
import { registerHistoryHandlers } from '../../src/server/handlers/history.js';
import { Router } from '../../src/server/router.js';
import { generateCorpus } from '../../src/testing/corpus.js';

const opts = { platform: 'linux' as const, gitCommonDir: () => null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON results in tests
type Any = Record<string, any>;

const setup = async (sessions = 12, projects = 3, db: Db = openDb(':memory:')) => {
  const adapter = generateCorpus({ sessions, projects, bigSessionMessages: 0 });
  await new Indexer(adapter, db, () => {}, opts).fullSync();
  let live: LiveChat[] = [];
  const missing = new Set<string>();
  const catalog = new Catalog({
    db,
    live: { list: () => live },
    folderExists: (path) => !missing.has(path),
    ...opts,
  });
  const router = new Router();
  registerHistoryHandlers(router, { db, catalog, quickSearch: createQuickSearch(db, catalog) });
  const call = async (method: string, params: unknown = {}): Promise<Any> => {
    const r = await router.dispatch({ id: 1, method, params } as never, {
      clientId: 'c',
      origin: 'local',
    });
    if ('error' in r) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.result as Any;
  };
  const needsYou = async (query?: string): Promise<Any[]> =>
    (
      await call('sessions.list', {
        place: { kind: 'needsYou' },
        limit: 50,
        ...(query ? { query } : {}),
      })
    ).items;
  return { db, catalog, call, needsYou, missing, setLive: (l: LiveChat[]) => (live = l) };
};

const lc = (
  sessionId: string,
  cwd: string,
  status: ChatStatus,
  extra: Partial<LiveChat> = {},
): LiveChat => ({ sessionId, cwd, status, live: status !== 'paused', ...extra });

describe('Db turn state', () => {
  it('a turn that ends after the last seen time is unread until marked seen', () => {
    const db = openDb(':memory:');
    expect(db.unreadTurns().size).toBe(0);
    db.setTurnEnded('a', 100);
    expect([...db.unreadTurns()]).toEqual([['a', 100]]);
    expect(db.markSeen('a', 200)).toBe(true);
    expect(db.unreadTurns().size).toBe(0);
    // Idempotent: seeing it again changes nothing.
    expect(db.markSeen('a', 300)).toBe(false);
    db.setTurnEnded('a', 400);
    expect([...db.unreadTurns()]).toEqual([['a', 400]]);
    db.close();
  });

  it('orders by operation, even when the clock does not advance or goes back', () => {
    const db = openDb(':memory:');
    db.setTurnEnded('a', 100);
    db.markSeen('a', 100); // seen in the same millisecond, after the turn ended
    expect(db.unreadTurns().size).toBe(0);
    db.setTurnEnded('a', 100); // another turn ends in that millisecond
    expect(db.unreadTurns().has('a')).toBe(true);
    db.markSeen('a', 50); // clock went back
    expect(db.unreadTurns().size).toBe(0);
    db.setTurnEnded('a', 40);
    expect(db.unreadTurns().has('a')).toBe(true);
    db.close();
  });

  it('marking a chat without any finished turn seen stores nothing', () => {
    const db = openDb(':memory:');
    expect(db.markSeen('never-ran', 10)).toBe(false);
    db.setTurnEnded('never-ran', 5); // a turn ending later is still news
    expect(db.unreadTurns().has('never-ran')).toBe(true);
    db.close();
  });

  it('persists across a restart (same threadgarden.db file)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadgarden-turns-'));
    try {
      const file = join(dir, 'threadgarden.db');
      let db = openDb(file);
      db.setTurnEnded('a', 100);
      db.setTurnEnded('b', 100);
      db.markSeen('b', 200);
      db.close();
      db = openDb(file);
      expect([...db.unreadTurns().keys()]).toEqual(['a']);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('catalog: unread chats and the Needs you place', () => {
  it('an unseen finished turn makes an idle chat unread and lists it under Needs you', async () => {
    const t = await setup();
    t.setLive([lc('session-0', '/work/proj-0', 'idle')]);
    expect((await t.needsYou()).length).toBe(0);
    expect((await t.call('places.counts')).needsYou).toBe(0);

    t.db.setTurnEnded('session-0', 5);
    const [chat] = await t.needsYou();
    expect(chat).toMatchObject({ sessionId: 'session-0', status: 'idle', unread: true });
    expect((await t.call('places.counts')).needsYou).toBe(1);
    // Everywhere else the summary carries the flag too.
    const all = await t.call('sessions.list', { place: { kind: 'all' }, limit: 50 });
    expect(all.items.find((i: Any) => i.sessionId === 'session-0').unread).toBe(true);
    expect(all.items.filter((i: Any) => i.unread)).toHaveLength(1);
    expect(t.catalog.summary('session-0')?.unread).toBe(true);
    expect(t.catalog.summary('session-1')?.unread).toBe(false);

    t.db.markSeen('session-0', 10);
    expect(await t.needsYou()).toEqual([]);
    expect(t.catalog.summary('session-0')?.unread).toBe(false);
    expect((await t.call('places.counts')).needsYou).toBe(0);
  });

  it('needsYou wins over unread, and a working chat is never unread', async () => {
    const t = await setup();
    t.db.setTurnEnded('session-0', 5);
    t.db.setTurnEnded('session-1', 5);
    t.setLive([
      lc('session-0', '/work/proj-0', 'needsYou', { waitingFor: 'Allow Bash' }),
      lc('session-1', '/work/proj-1', 'working'),
    ]);
    const list = await t.needsYou();
    expect(list.map((i) => [i.sessionId, i.status, i.unread])).toEqual([
      ['session-0', 'needsYou', false],
    ]);
    expect((await t.call('places.counts')).needsYou).toBe(1);
    const run = await t.call('sessions.list', { place: { kind: 'running' }, limit: 50 });
    expect(run.items[0]).toMatchObject({ sessionId: 'session-1', unread: false });
  });

  it('lists waiting chats first, then unread ones by most recent turn end; counts both', async () => {
    const t = await setup();
    t.setLive([
      lc('session-0', '/work/proj-0', 'needsYou'),
      lc('session-1', '/work/proj-1', 'idle'),
      lc('session-2', '/work/proj-2', 'paused'),
      lc('session-3', '/work/proj-0', 'failed', { live: false }),
    ]);
    t.db.setTurnEnded('session-1', 100);
    t.db.setTurnEnded('session-2', 300);
    t.db.setTurnEnded('session-3', 200);
    t.db.setTurnEnded('session-4', 50); // ended (history only) but still unseen
    const ids = (await t.needsYou()).map((i) => i.sessionId);
    expect(ids).toEqual(['session-0', 'session-2', 'session-3', 'session-1', 'session-4']);
    expect((await t.call('places.counts')).needsYou).toBe(5);
    const projects = (await t.call('projects.list')) as unknown as Any[];
    const byId = new Map(projects.map((p) => [p.projectId, p.counts.needsYou]));
    expect(byId.get('/work/proj-0')).toBe(2); // session-0 waits, session-3 is unread
    expect(byId.get('/work/proj-1')).toBe(2); // session-1 and session-4 are unread
    expect(byId.get('/work/proj-2')).toBe(1);
  });

  it('a query in Needs you also searches the unread chats', async () => {
    const t = await setup();
    t.setLive([lc('session-1', '/work/proj-1', 'idle')]);
    t.db.setTurnEnded('session-1', 1);
    t.db.setTurnEnded('session-2', 1);
    await t.call('meta.update', { sessionId: 'session-2', customTitle: 'zebra crossing' });
    expect((await t.needsYou('zebra')).map((i) => i.sessionId)).toEqual(['session-2']);
    expect((await t.needsYou('proj-1')).map((i) => i.sessionId)).toEqual(['session-1']);
  });

  it('unread state survives a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadgarden-turns-'));
    try {
      const file = join(dir, 'threadgarden.db');
      const first = await setup(12, 3, openDb(file));
      first.db.setTurnEnded('session-5', 1);
      first.db.close();
      const again = await setup(12, 3, openDb(file));
      expect((await again.needsYou()).map((i) => [i.sessionId, i.unread])).toEqual([
        ['session-5', true],
      ]);
      again.db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('catalog: project order and missing folders', () => {
  it("a live chat's last activity moves its project up at once", async () => {
    const t = await setup(12, 3);
    const order = () => t.catalog.projects().map((p) => p.projectId);
    expect(order()).toEqual(['/work/proj-2', '/work/proj-1', '/work/proj-0']);
    t.setLive([lc('session-0', '/work/proj-0', 'working', { lastActivity: 2_000_000_000_000 })]);
    expect(order()).toEqual(['/work/proj-0', '/work/proj-2', '/work/proj-1']);
    const top = t.catalog.projects()[0]!;
    expect(top.lastActivity).toBe(2_000_000_000_000);
    // The chat's own summary reports the same activity.
    expect(t.catalog.summary('session-0')?.lastActivity).toBe(2_000_000_000_000);
    // Pinned projects still come first.
    t.db.setProjectPinned('/work/proj-1', true);
    expect(order()).toEqual(['/work/proj-1', '/work/proj-0', '/work/proj-2']);
  });

  it('projectOrderChanged reports a new order once', async () => {
    const t = await setup(12, 3);
    expect(t.catalog.projectOrderChanged()).toBe(true); // nothing seen yet
    expect(t.catalog.projectOrderChanged()).toBe(false);
    t.setLive([lc('session-1', '/work/proj-1', 'working', { lastActivity: 2_000_000_000_000 })]);
    expect(t.catalog.projectOrderChanged()).toBe(true);
    expect(t.catalog.projectOrderChanged()).toBe(false);
    // projects.list (what clients see) also moves the baseline.
    t.setLive([lc('session-0', '/work/proj-0', 'working', { lastActivity: 2_000_000_000_001 })]);
    await t.call('projects.list');
    expect(t.catalog.projectOrderChanged()).toBe(false);
  });

  it('projects carry whether their folder exists', async () => {
    const t = await setup(12, 3);
    t.missing.add('/work/proj-1');
    const list = (await t.call('projects.list')) as unknown as Any[];
    expect(list.map((p) => [p.projectId, p.exists])).toEqual([
      ['/work/proj-2', true],
      ['/work/proj-1', false],
      ['/work/proj-0', true],
    ]);
  });
});
