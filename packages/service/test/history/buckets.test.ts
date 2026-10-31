/**
 * v1.2 buckets (design §3): Active / On hold / Archived in the db, the
 * catalog, quick search and the history handlers.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { ChatStatus, EventMsg } from '@pahub/protocol';
import type { ExternalSession } from '../../src/external/poller.js';
import { Buckets } from '../../src/history/buckets.js';
import { Catalog, type LiveChat } from '../../src/history/catalog.js';
import { openDb, type Db } from '../../src/history/db.js';
import { Indexer } from '../../src/history/indexer.js';
import { migrate } from '../../src/history/migrations.js';
import { createQuickSearch } from '../../src/history/search.js';
import { registerHistoryHandlers } from '../../src/server/handlers/history.js';
import { Router } from '../../src/server/router.js';
import { generateCorpus } from '../../src/testing/corpus.js';

const opts = { platform: 'linux' as const, gitCommonDir: () => null };
const BASE = 1_700_000_000_000;
const DAY = 86_400_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON results in tests
type Any = Record<string, any>;

/**
 * 12 sessions over 3 projects: `session-i` is in `/work/proj-(i % 3)` and was
 * last modified at `BASE + i minutes`.
 */
const setup = async (sessions = 12, projects = 3, db: Db = openDb(':memory:')) => {
  const adapter = generateCorpus({ sessions, projects, bigSessionMessages: 0 });
  await new Indexer(adapter, db, () => {}, opts).fullSync();
  let live: LiveChat[] = [];
  let externals: ExternalSession[] = [];
  let now = BASE + 100 * DAY;
  const events: EventMsg[] = [];
  const catalog = new Catalog({
    db,
    live: { list: () => live },
    externals: () => externals,
    ...opts,
  });
  const buckets = new Buckets({ db, catalog, emit: (e) => events.push(e), now: () => now });
  const router = new Router();
  registerHistoryHandlers(router, {
    db,
    catalog,
    quickSearch: createQuickSearch(db, catalog),
    buckets,
  });
  const call = async (method: string, params: unknown = {}): Promise<Any> => {
    const r = await router.dispatch({ id: 1, method, params } as never, { clientId: 'c' });
    if ('error' in r) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.result as Any;
  };
  const list = async (place: Any, limit = 50, query?: string): Promise<Any[]> => {
    const out: Any[] = [];
    let cursor: string | undefined;
    do {
      const r = await call('sessions.list', {
        place,
        limit,
        ...(cursor ? { cursor } : {}),
        ...(query ? { query } : {}),
      });
      out.push(...r.items);
      cursor = r.nextCursor;
    } while (cursor);
    return out;
  };
  const ids = async (place: Any, limit = 50, query?: string) =>
    (await list(place, limit, query)).map((i) => i.sessionId as string);
  const setBucket = (sessionIds: string[], bucket: string, extra: Any = {}) =>
    call('chat.setBucket', { sessionIds, bucket, ...extra });
  return {
    db,
    catalog,
    buckets,
    events,
    call,
    list,
    ids,
    setBucket,
    setLive: (l: LiveChat[]) => (live = l),
    setExternals: (e: ExternalSession[]) => (externals = e),
    setNow: (t: number) => (now = t),
  };
};

const lc = (
  sessionId: string,
  cwd: string,
  status: ChatStatus,
  extra: Partial<LiveChat> = {},
): LiveChat => ({ sessionId, cwd, status, live: status !== 'paused', ...extra });

const ext = (
  sessionId: string,
  cwd: string,
  extra: Partial<ExternalSession> = {},
): ExternalSession => ({
  sessionId,
  cwd,
  kind: 'interactive',
  startedAt: BASE,
  pid: 42,
  raw: {},
  ...extra,
});

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `session-${to - i}`);

describe('buckets: migration', () => {
  it('upgrades an existing v1.1 database; existing chats are active, titles and pins kept', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pahub-buckets-'));
    try {
      const file = join(dir, 'pahub.db');
      const raw = new DatabaseSync(file);
      migrate(raw, 4); // the v1.1 schema
      raw
        .prepare(
          `INSERT INTO sessions (session_id, project_id, cwd, last_modified) VALUES (?, ?, ?, ?)`,
        )
        .run('old', '/work/a', '/work/a', BASE);
      raw
        .prepare('INSERT INTO meta (session_id, custom_title, pinned) VALUES (?, ?, ?)')
        .run('old', 'My title', 1);
      raw.close();

      const db = openDb(file);
      const version = db.raw.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(version.user_version).toBeGreaterThan(4);
      expect(db.getSession('old')).toMatchObject({
        customTitle: 'My title',
        pinned: true,
        bucket: 'active',
        holdUntil: null,
        holdNote: null,
        backAt: null,
      });
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an unknown stored bucket (a newer pahub) reads as active', async () => {
    const t = await setup();
    t.db.raw
      .prepare(`INSERT INTO chat_buckets (session_id, bucket) VALUES ('session-3', 'someday')`)
      .run();
    t.catalog.invalidate();
    expect(t.db.getSession('session-3')?.bucket).toBe('active');
    expect(await t.ids({ kind: 'active' })).toContain('session-3');
    expect((await t.call('places.counts')).active).toBe(12);
  });
});

describe('buckets: chat.setBucket', () => {
  it('moves one chat or many; summaries carry the bucket, until and note', async () => {
    const t = await setup();
    expect(t.catalog.summary('session-1')).toMatchObject({
      bucket: 'active',
      backFromHold: false,
    });
    expect(await t.setBucket(['session-1'], 'archived')).toEqual({ updated: 1, skipped: [] });
    expect(t.catalog.summary('session-1')?.bucket).toBe('archived');

    const until = BASE + 101 * DAY;
    expect(
      await t.setBucket(['session-2', 'session-3', 'session-2'], 'onHold', {
        holdUntil: until,
        holdNote: 'waiting for review from Petr',
      }),
    ).toEqual({ updated: 2, skipped: [] });
    expect(t.catalog.summary('session-2')).toMatchObject({
      bucket: 'onHold',
      holdUntil: until,
      holdNote: 'waiting for review from Petr',
    });
    // An indefinite hold has neither.
    await t.setBucket(['session-4'], 'onHold');
    expect(t.catalog.summary('session-4')).not.toHaveProperty('holdUntil');
    expect(t.catalog.summary('session-4')).not.toHaveProperty('holdNote');

    // Moving on clears the hold details.
    await t.setBucket(['session-2'], 'active');
    const s2 = t.catalog.summary('session-2');
    expect(s2?.bucket).toBe('active');
    expect(s2).not.toHaveProperty('holdUntil');
    expect(s2).not.toHaveProperty('holdNote');
    await t.setBucket(['session-3'], 'archived');
    expect(t.catalog.summary('session-3')).not.toHaveProperty('holdUntil');

    // Lists change: one sessions.changed per call, with the moved ids.
    const changed = t.events.filter((e) => e.event === 'sessions.changed');
    expect(changed.map((e) => (e.data as { sessionIds: string[] }).sessionIds)).toEqual([
      ['session-1'],
      ['session-2', 'session-3'],
      ['session-4'],
      ['session-2'],
      ['session-3'],
    ]);
  });

  it('refuses to archive a chat pahub runs (LIVE) or one running elsewhere (RUNNING); unknown ids are skipped', async () => {
    const t = await setup();
    t.setLive([
      lc('session-0', '/work/proj-0', 'idle'),
      lc('session-1', '/work/proj-1', 'paused'),
      lc('session-2', '/work/proj-2', 'working'),
    ]);
    t.setExternals([
      ext('session-5', '/work/proj-2', { status: 'busy' }),
      ext('session-6', '/work/proj-0', { status: 'idle' }),
    ]);
    const r = await t.setBucket(
      ['session-0', 'session-1', 'session-2', 'session-5', 'session-6', 'nope'],
      'archived',
    );
    expect(r).toEqual({
      updated: 2,
      skipped: [
        { sessionId: 'session-0', reason: 'LIVE' },
        { sessionId: 'session-2', reason: 'LIVE' },
        { sessionId: 'session-5', reason: 'RUNNING' },
        { sessionId: 'nope', reason: 'NOT_FOUND' },
      ],
    });
    expect(t.catalog.summary('session-1')?.bucket).toBe('archived'); // paused: no process
    expect(t.catalog.summary('session-6')?.bucket).toBe('archived'); // idle external
    expect(t.catalog.summary('session-0')?.bucket).toBe('active');
    // A live chat may be put on hold.
    expect(await t.setBucket(['session-0'], 'onHold')).toEqual({ updated: 1, skipped: [] });
    // After it ends, archiving it works.
    t.setLive([]);
    expect(await t.setBucket(['session-0', 'session-2'], 'archived')).toEqual({
      updated: 2,
      skipped: [],
    });
  });

  it('a chat pahub runs that was never indexed can be put in a bucket', async () => {
    const t = await setup();
    t.setLive([lc('fresh', '/work/proj-0', 'idle', { live: false })]);
    await t.setBucket(['fresh'], 'onHold', { holdNote: 'later' });
    expect(t.catalog.summary('fresh')).toMatchObject({ bucket: 'onHold', holdNote: 'later' });
    expect(await t.ids({ kind: 'onHold' })).toEqual(['fresh']);
    expect((await t.call('places.counts')).onHold).toBe(1);
  });

  it('rejects a note over 200 characters', async () => {
    const t = await setup();
    await expect(
      t.setBucket(['session-1'], 'onHold', { holdNote: 'x'.repeat(201) }),
    ).rejects.toThrow('INVALID_PARAMS');
  });
});

describe('buckets: places and counts', () => {
  it('Active, On hold and Archived list their chats; all is an alias of active', async () => {
    const t = await setup();
    await t.setBucket(['session-1', 'session-4'], 'onHold');
    await t.setBucket(['session-2', 'session-7', 'session-11'], 'archived');
    const active = range(0, 11).filter(
      (id) => !['session-1', 'session-4', 'session-2', 'session-7', 'session-11'].includes(id),
    );
    expect(await t.ids({ kind: 'active' })).toEqual(active);
    expect(await t.ids({ kind: 'all' })).toEqual(active);
    // Paged lists (keyset) give the same rows.
    expect(await t.ids({ kind: 'active' }, 2)).toEqual(active);
    expect(await t.ids({ kind: 'onHold' })).toEqual(['session-4', 'session-1']);
    expect(await t.ids({ kind: 'archived' }, 1)).toEqual(['session-11', 'session-7', 'session-2']);
    expect(await t.call('places.counts')).toEqual({
      needsYou: 0,
      running: 0,
      all: 7,
      active: 7,
      onHold: 2,
      archived: 3,
    });
  });

  it('live and external chats sort into their bucket; counts match the lists', async () => {
    const t = await setup();
    await t.setBucket(['session-3'], 'onHold');
    await t.setBucket(['session-6'], 'archived');
    t.setLive([
      lc('session-3', '/work/proj-0', 'idle'),
      lc('session-6', '/work/proj-0', 'paused'),
      lc('unindexed', '/work/proj-1', 'idle'),
    ]);
    t.setExternals([ext('session-9', '/work/proj-0', { status: 'idle' })]);
    const counts = await t.call('places.counts');
    for (const kind of ['active', 'onHold', 'archived'] as const) {
      const listed = await t.list({ kind });
      expect(listed.length, kind).toBe(counts[kind]);
      expect(new Set(listed.map((i) => i.bucket)), kind).toEqual(new Set([kind]));
    }
    expect(await t.ids({ kind: 'onHold' })).toEqual(['session-3']);
    expect(await t.ids({ kind: 'archived' })).toEqual(['session-6']);
    expect(await t.ids({ kind: 'active' })).toContain('unindexed');
    expect(counts.active).toBe(11);
    expect(counts.all).toBe(11);
  });

  it('hidden projects are left out of the bucket places, like All chats', async () => {
    const t = await setup();
    await t.setBucket(['session-0', 'session-1'], 'archived');
    t.db.setProjectHidden('/work/proj-0', true);
    t.catalog.invalidate();
    expect(await t.ids({ kind: 'archived' })).toEqual(['session-1']);
    const counts = await t.call('places.counts');
    expect(counts).toMatchObject({ active: 7, archived: 1, onHold: 0 });
    // The project itself still lists its chats.
    expect(
      await t.ids({ kind: 'project', projectId: '/work/proj-0', include: ['archived'] }),
    ).toContain('session-0');
  });

  it('a project lists its active chats; include adds on-hold and archived ones', async () => {
    const t = await setup();
    // proj-0: sessions 0, 3, 6, 9
    await t.setBucket(['session-3'], 'onHold');
    await t.setBucket(['session-6'], 'archived');
    t.setLive([lc('session-9', '/work/proj-0', 'idle')]);
    await t.setBucket(['session-9'], 'onHold');
    const proj = (include?: string[]) =>
      t.ids({ kind: 'project', projectId: '/work/proj-0', ...(include ? { include } : {}) });
    expect(await proj()).toEqual(['session-0']);
    expect(await proj(['onHold'])).toEqual(['session-9', 'session-3', 'session-0']);
    expect(await proj(['archived'])).toEqual(['session-6', 'session-0']);
    expect(await proj(['onHold', 'archived'])).toEqual([
      'session-9',
      'session-6',
      'session-3',
      'session-0',
    ]);
    // A query searches the same rows.
    expect(await t.ids({ kind: 'project', projectId: '/work/proj-0' }, 50, 'proj-0')).toEqual([
      'session-0',
    ]);
    expect(
      await t.ids(
        { kind: 'project', projectId: '/work/proj-0', include: ['archived'] },
        50,
        'proj-0',
      ),
    ).toEqual(['session-6', 'session-0']);
  });

  it('a query in a bucket place searches only that bucket', async () => {
    const t = await setup();
    await t.setBucket(['session-2'], 'archived');
    await t.call('meta.update', { sessionId: 'session-2', customTitle: 'zebra crossing' });
    await t.call('meta.update', { sessionId: 'session-5', customTitle: 'zebra stripes' });
    expect(await t.ids({ kind: 'archived' }, 50, 'zebra')).toEqual(['session-2']);
    expect(await t.ids({ kind: 'active' }, 50, 'zebra')).toEqual(['session-5']);
    expect(await t.ids({ kind: 'all' }, 50, 'zebra')).toEqual(['session-5']);
    expect(await t.ids({ kind: 'onHold' }, 50, 'zebra')).toEqual([]);
  });

  it('Needs you and Running span every bucket (Needs you precedence unchanged)', async () => {
    const t = await setup();
    await t.setBucket(['session-0', 'session-1'], 'onHold');
    await t.setBucket(['session-2', 'session-5'], 'archived');
    t.setLive([
      lc('session-0', '/work/proj-0', 'needsYou'),
      lc('session-1', '/work/proj-1', 'working'),
    ]);
    t.setExternals([ext('session-2', '/work/proj-2', { status: 'waiting' })]);
    t.db.setTurnEnded('session-5', 10);
    expect(await t.ids({ kind: 'needsYou' })).toEqual(['session-2', 'session-0', 'session-5']);
    expect(await t.ids({ kind: 'running' })).toEqual(['session-1']);
    expect(await t.call('places.counts')).toMatchObject({ needsYou: 3, running: 1 });
    // ...while their bucket place still holds them.
    expect(await t.ids({ kind: 'onHold' })).toEqual(['session-0', 'session-1']);
  });
});

describe('buckets: quick search', () => {
  it('archived matches are flagged and come after all other matches', async () => {
    const t = await setup();
    await t.call('meta.update', { sessionId: 'session-1', customTitle: 'flux capacitor' });
    await t.call('meta.update', { sessionId: 'session-2', customTitle: 'flux capacitor repair' });
    await t.call('meta.update', { sessionId: 'session-3', customTitle: 'flux capacitor notes' });
    await t.setBucket(['session-1'], 'archived');
    await t.setBucket(['session-3'], 'onHold');
    const r = await t.call('search.quick', { query: 'flux capacitor', limit: 10 });
    const hits = r.items as Any[];
    expect(hits.map((h) => h.sessionId).sort()).toEqual(['session-1', 'session-2', 'session-3']);
    expect(hits.at(-1)).toMatchObject({ sessionId: 'session-1', archived: true });
    for (const h of hits.slice(0, -1)) expect(h).not.toHaveProperty('archived');
  });

  it('up to 3 slots are kept for archived matches, however many others match', async () => {
    const t = await setup(30, 3);
    for (let i = 0; i < 30; i++) {
      await t.call('meta.update', {
        sessionId: `session-${i}`,
        customTitle: `flux capacitor ${i}`,
      });
    }
    const archivedIds = (hits: Any[]) =>
      hits.filter((h) => h.archived === true).map((h) => h.sessionId as string);

    await t.setBucket(['session-3'], 'archived');
    let hits = (await t.call('search.quick', { query: 'flux capacitor', limit: 20 }))
      .items as Any[];
    expect(hits).toHaveLength(20);
    expect(archivedIds(hits)).toEqual(['session-3']);
    expect(hits.at(-1)).toMatchObject({ sessionId: 'session-3', archived: true });

    await t.setBucket(['session-4', 'session-5', 'session-6', 'session-7'], 'archived');
    hits = (await t.call('search.quick', { query: 'flux capacitor', limit: 20 })).items as Any[];
    expect(hits).toHaveLength(20);
    expect(archivedIds(hits)).toHaveLength(3);
    for (const h of hits.slice(0, 17)) expect(h).not.toHaveProperty('archived');
  });
});

describe('buckets: back from hold', () => {
  it('a hold that ran out returns the chat to Active, under Needs you, once; markSeen clears it', async () => {
    const t = await setup();
    const now = BASE + 100 * DAY;
    await t.setBucket(['session-4'], 'onHold', { holdUntil: now + 60_000, holdNote: 'Petr' });
    await t.setBucket(['session-5'], 'onHold', { holdUntil: now + 120_000 });
    await t.setBucket(['session-6'], 'onHold'); // indefinitely
    t.db.setTurnEnded('session-7', now + 90_000); // unread, between the two holds
    t.events.length = 0;

    t.buckets.sweepHolds(); // nothing is due yet
    expect(t.events).toEqual([]);

    t.setNow(now + 200_000);
    t.buckets.sweepHolds();
    expect(t.events).toEqual([
      // In the order they came due.
      { event: 'sessions.changed', data: { sessionIds: ['session-4', 'session-5'] } },
      {
        event: 'chatBackFromHold',
        data: { sessionId: 'session-4', title: expect.any(String), projectName: 'proj-1' },
      },
      {
        event: 'chatBackFromHold',
        data: { sessionId: 'session-5', title: expect.any(String), projectName: 'proj-2' },
      },
    ]);
    expect(t.catalog.summary('session-4')).toMatchObject({ bucket: 'active', backFromHold: true });
    expect(t.catalog.summary('session-4')).not.toHaveProperty('holdUntil');
    expect(t.catalog.summary('session-4')).not.toHaveProperty('holdNote');
    // After the chats waiting on the user, alongside unread ones (most recent first).
    t.setLive([lc('session-0', '/work/proj-0', 'needsYou')]);
    expect(await t.ids({ kind: 'needsYou' })).toEqual([
      'session-0',
      'session-5',
      'session-7',
      'session-4',
    ]);
    expect((await t.call('places.counts')).needsYou).toBe(4);
    expect(await t.ids({ kind: 'onHold' })).toEqual(['session-6']);
    expect(await t.ids({ kind: 'active' })).toContain('session-4');

    // Once only.
    t.events.length = 0;
    t.buckets.sweepHolds();
    expect(t.events).toEqual([]);

    expect(t.db.clearBackFromHold('session-4')).toBe(true);
    expect(t.db.clearBackFromHold('session-4')).toBe(false);
    expect(t.catalog.summary('session-4')?.backFromHold).toBe(false);
    expect(await t.ids({ kind: 'needsYou' })).toEqual(['session-0', 'session-5', 'session-7']);
  });

  it('a chat back from hold that works or waits on the user is not flagged', async () => {
    const t = await setup();
    const now = BASE + 100 * DAY;
    await t.setBucket(['session-1', 'session-2'], 'onHold', { holdUntil: now - 1 });
    t.setLive([lc('session-1', '/work/proj-1', 'working')]);
    t.setExternals([ext('session-2', '/work/proj-2', { status: 'waiting' })]);
    t.buckets.sweepHolds();
    expect(t.catalog.summary('session-1')?.backFromHold).toBe(false);
    expect(await t.ids({ kind: 'needsYou' })).toEqual(['session-2']);
    t.setLive([lc('session-1', '/work/proj-1', 'idle')]);
    expect(t.catalog.summary('session-1')?.backFromHold).toBe(true);
  });

  it('putting a chat on hold until a past time brings it back at once; moving it clears the flag', async () => {
    const t = await setup();
    await t.setBucket(['session-1'], 'onHold', { holdUntil: BASE });
    expect(t.catalog.summary('session-1')).toMatchObject({ bucket: 'active', backFromHold: true });
    expect(t.events.some((e) => e.event === 'chatBackFromHold')).toBe(true);
    await t.setBucket(['session-1'], 'active');
    expect(t.catalog.summary('session-1')?.backFromHold).toBe(false);
  });
});

describe('buckets: auto-unarchive', () => {
  it('external sessions that work or wait on the user bring archived chats back', async () => {
    const t = await setup();
    await t.setBucket(['session-1', 'session-2', 'session-3', 'session-4'], 'archived');
    await t.setBucket(['session-5'], 'onHold');
    t.events.length = 0;
    t.buckets.unarchiveRunning([
      ext('session-1', '/work/proj-1', { status: 'busy' }),
      ext('session-2', '/work/proj-2', { state: 'blocked', kind: 'background' }),
      ext('session-3', '/work/proj-0', { status: 'idle' }),
      ext('session-5', '/work/proj-2', { status: 'busy' }),
    ]);
    expect(t.events).toEqual([
      { event: 'sessions.changed', data: { sessionIds: ['session-1', 'session-2'] } },
    ]);
    expect(await t.ids({ kind: 'archived' })).toEqual(['session-4', 'session-3']);
    expect(t.catalog.summary('session-5')?.bucket).toBe('onHold'); // only archived chats return
    t.events.length = 0;
    t.buckets.unarchiveRunning([ext('session-1', '/work/proj-1', { status: 'busy' })]);
    expect(t.events).toEqual([]); // nothing left to bring back
  });

  it('unarchive returns the chats that came back', async () => {
    const t = await setup();
    await t.setBucket(['session-1'], 'archived');
    expect(t.db.unarchive(['session-1', 'session-2'])).toEqual(['session-1']);
    expect(t.db.unarchive(['session-1'])).toEqual([]);
  });
});

describe('buckets: chat.archiveOlder', () => {
  it('archives active chats older than N days in one go; skips live, waiting, unread and back-from-hold chats', async () => {
    // Sessions 0..11 are BASE + i minutes old; "now" puts the cut between 5 and 6.
    const t = await setup();
    t.setNow(BASE + 30 * DAY + 5.5 * 60_000);
    await t.setBucket(['session-0'], 'onHold');
    t.setLive([lc('session-1', '/work/proj-1', 'idle'), lc('session-2', '/work/proj-2', 'paused')]);
    t.setExternals([ext('session-3', '/work/proj-0', { status: 'waiting' })]);
    t.db.setTurnEnded('session-4', 1);
    t.db.raw
      .prepare(`INSERT INTO chat_buckets (session_id, back_at) VALUES ('session-5', 1)`)
      .run();
    t.events.length = 0;

    expect(await t.call('chat.archiveOlder', { olderThanDays: 30, dryRun: true })).toEqual({
      archived: 1,
    });
    expect(await t.ids({ kind: 'archived' })).toEqual([]);
    expect(await t.call('chat.archiveOlder', { olderThanDays: 30 })).toEqual({ archived: 1 });
    // session-2 is paused (no process) and old: archived; the rest is skipped.
    expect(await t.ids({ kind: 'archived' })).toEqual(['session-2']);
    expect(t.catalog.summary('session-0')?.bucket).toBe('onHold');
    expect(t.events).toEqual([{ event: 'sessions.changed', data: { sessionIds: ['session-2'] } }]);
  });

  it('Ruling R35: pinned chats are skipped, in the count and the move', async () => {
    const t = await setup();
    t.setNow(BASE + 30 * DAY + 100 * 60_000); // everything is older
    await t.call('meta.update', { sessionId: 'session-0', pinned: true });
    await t.call('meta.update', { sessionId: 'session-7', pinned: true });
    expect(await t.call('chat.archiveOlder', { olderThanDays: 30, dryRun: true })).toEqual({
      archived: 10,
    });
    expect(await t.call('chat.archiveOlder', { olderThanDays: 30 })).toEqual({ archived: 10 });
    expect(await t.ids({ kind: 'active' })).toEqual(['session-7', 'session-0']);
    // Unpinned later, it can go with the next tidy-up.
    await t.call('meta.update', { sessionId: 'session-7', pinned: false });
    expect(await t.call('chat.archiveOlder', { olderThanDays: 30 })).toEqual({ archived: 1 });
  });

  it('one project, or the Active place without hidden projects', async () => {
    const t = await setup();
    t.setNow(BASE + 30 * DAY + 100 * 60_000); // everything is older
    t.db.setProjectHidden('/work/proj-2', true);
    t.catalog.invalidate();
    expect(
      await t.call('chat.archiveOlder', { olderThanDays: 30, projectId: '/work/proj-0' }),
    ).toEqual({ archived: 4 });
    expect(await t.call('chat.archiveOlder', { olderThanDays: 30 })).toEqual({ archived: 4 });
    expect(
      await t.ids({ kind: 'project', projectId: '/work/proj-2', include: ['archived'] }),
    ).toEqual(['session-11', 'session-8', 'session-5', 'session-2']);
    expect(await t.ids({ kind: 'project', projectId: '/work/proj-2' })).toHaveLength(4);
    expect((await t.call('places.counts')).archived).toBe(8);
    expect(await t.call('chat.archiveOlder', { olderThanDays: 30 })).toEqual({ archived: 0 });
  });
});

describe('buckets: persistence', () => {
  it('buckets, holds and back-from-hold survive a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pahub-buckets-'));
    try {
      const file = join(dir, 'pahub.db');
      const first = await setup(12, 3, openDb(file));
      await first.setBucket(['session-1'], 'archived');
      await first.setBucket(['session-2'], 'onHold', {
        holdUntil: BASE + 200 * DAY,
        holdNote: 'n',
      });
      await first.setBucket(['session-3'], 'onHold', { holdUntil: BASE });
      first.db.close();
      const again = await setup(12, 3, openDb(file));
      expect(again.catalog.summaries(['session-1', 'session-2', 'session-3'])).toMatchObject([
        { bucket: 'archived' },
        { bucket: 'onHold', holdUntil: BASE + 200 * DAY, holdNote: 'n' },
        { bucket: 'active', backFromHold: true },
      ]);
      again.db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('buckets: review fixes', () => {
  it('archived title matches never crowd out a weaker active match in search.quick', async () => {
    const t = await setup();
    const archived = ['session-1', 'session-2', 'session-3', 'session-4', 'session-5'];
    for (const id of archived) {
      await t.call('meta.update', { sessionId: id, customTitle: 'flux capacitor' });
    }
    await t.call('meta.update', {
      sessionId: 'session-6',
      customTitle: 'notes on the flux of a big capacitor',
    });
    await t.setBucket(archived, 'archived');
    const hits = (await t.call('search.quick', { query: 'flux capacitor', limit: 3 }))
      .items as Any[];
    expect(hits).toHaveLength(3);
    expect(hits[0]).toMatchObject({ sessionId: 'session-6' });
    expect(hits[0]).not.toHaveProperty('archived');
    for (const h of hits.slice(1)) expect(h.archived).toBe(true);
  });

  it('archived full-text matches never crowd out an active one in search.quick', async () => {
    const t = await setup();
    const archived = ['session-1', 'session-2', 'session-3', 'session-4', 'session-5'];
    for (const id of archived) t.db.setFts(id, 'zygomorphic zygomorphic zygomorphic');
    t.db.setFts('session-6', `${'filler words here '.repeat(200)} zygomorphic`);
    await t.setBucket(archived, 'archived');
    const hits = (await t.call('search.quick', { query: 'zygomorphic', limit: 2 })).items as Any[];
    expect(hits.map((h) => [h.sessionId, h.archived ?? false])).toEqual([
      ['session-6', false],
      [expect.any(String), true],
    ]);
  });

  it('Ruling R32: archiving a chat marks it seen, so it leaves Needs you', async () => {
    const t = await setup();
    t.db.setTurnEnded('session-1', 10);
    t.db.setTurnEnded('session-2', 20);
    expect(await t.ids({ kind: 'needsYou' })).toEqual(['session-2', 'session-1']);
    expect((await t.call('places.counts')).needsYou).toBe(2);
    await t.setBucket(['session-1'], 'archived');
    expect(await t.ids({ kind: 'needsYou' })).toEqual(['session-2']);
    expect((await t.call('places.counts')).needsYou).toBe(1);
    expect(t.catalog.summary('session-1')).toMatchObject({ bucket: 'archived', unread: false });
    // On hold does not: the chat stays unread.
    await t.setBucket(['session-2'], 'onHold');
    expect(t.catalog.summary('session-2')?.unread).toBe(true);
    // An archived chat that really waits on the user still shows under Needs you.
    await t.setBucket(['session-3'], 'archived');
    t.setExternals([ext('session-3', '/work/proj-0', { status: 'waiting' })]);
    expect(await t.ids({ kind: 'needsYou' })).toEqual(['session-3', 'session-2']);
  });

  it('a hold that ends while the chat works or waits is not announced', async () => {
    const t = await setup();
    const now = BASE + 100 * DAY;
    await t.setBucket(['session-1', 'session-2', 'session-3'], 'onHold', {
      holdUntil: now + 1000,
    });
    t.setLive([lc('session-1', '/work/proj-1', 'working')]);
    t.setExternals([ext('session-2', '/work/proj-2', { status: 'waiting' })]);
    t.events.length = 0;
    t.setNow(now + 2000);
    t.buckets.sweepHolds();
    expect(t.events).toEqual([
      {
        event: 'sessions.changed',
        data: { sessionIds: ['session-1', 'session-2', 'session-3'] },
      },
      {
        event: 'chatBackFromHold',
        data: { sessionId: 'session-3', title: expect.any(String), projectName: 'proj-0' },
      },
    ]);
  });
});
