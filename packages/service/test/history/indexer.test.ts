import { describe, expect, it, vi } from 'vitest';
import { openDb, STATS_TABLES } from '../../src/history/db.js';
import { BACKFILL_BATCH, Indexer, extractText, MAX_TEXT_CHARS } from '../../src/history/indexer.js';
import { generateCorpus } from '../../src/testing/corpus.js';
import type { SessionMessage } from '../../src/sdk/adapter.js';

const setup = (sessions = 45) => {
  const adapter = generateCorpus({ sessions, projects: 3, bigSessionMessages: 0 });
  const db = openDb(':memory:');
  const events: { event: string; data: unknown }[] = [];
  const indexer = new Indexer(adapter, db, (e) => events.push(e), {
    platform: 'linux',
    gitCommonDir: () => null,
  });
  return { adapter, db, events, indexer };
};

const sm = (type: string, message: unknown): SessionMessage =>
  ({ type, uuid: 'u', session_id: 's', message, parent_tool_use_id: null }) as SessionMessage;

describe('extractText', () => {
  it('takes user strings and assistant text blocks, skipping tool results and thinking', () => {
    const text = extractText([
      sm('user', { role: 'user', content: 'hello there' }),
      sm('assistant', {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret' },
          { type: 'text', text: 'visible answer' },
          { type: 'tool_use', id: 't', name: 'X', input: { q: 'toolinput' } },
        ],
      }),
      sm('user', {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'toolresult' }],
      }),
      sm('system', { content: 'ignored' }),
    ]);
    expect(text).toContain('hello there');
    expect(text).toContain('visible answer');
    expect(text).not.toMatch(/secret|toolinput|toolresult|ignored/);
  });

  it('is robust to odd shapes', () => {
    expect(extractText([sm('user', null), sm('assistant', 5), sm('user', { content: 7 })])).toBe(
      '',
    );
    expect(MAX_TEXT_CHARS).toBe(2 * 1024 * 1024);
  });
});

describe('Indexer', () => {
  it('fullSync indexes all sessions and emits progress', async () => {
    const { db, events, indexer, adapter } = setup();
    await indexer.fullSync();
    expect(db.listSessions({}, 1000, undefined).items).toHaveLength(45);
    for (const s of adapter.sessions.values()) expect(db.needsReindex(s.info)).toBe(false);
    const progress = events
      .filter((e) => e.event === 'index.progress')
      .map((e) => e.data as { done: number; total: number });
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.at(-1)).toEqual({ done: 45, total: 45 });
    expect(events.some((e) => e.event === 'sessions.changed')).toBe(true);
    expect(db.searchFts('parity', 1000).length).toBeGreaterThan(0);
    const projects = db.listProjects();
    expect(projects).toHaveLength(3);
    expect(projects.every((p) => p.displayName.length > 0)).toBe(true);
  });

  it('a counted chat always has its project listed, batch by batch', async () => {
    const { db, events, indexer } = setup();
    const missing: string[] = [];
    const check = (): void => {
      const listed = new Set(db.listProjects().map((p) => p.projectId));
      for (const s of db.listSessions({}, 1000, undefined).items) {
        if (!listed.has(s.projectId)) missing.push(s.sessionId);
      }
    };
    // Between batches the indexer yields: anyone may read the database then.
    const push = events.push.bind(events);
    events.push = (...e) => {
      if (e.some((x) => x.event === 'index.progress')) check();
      return push(...e);
    };
    await indexer.fullSync();
    expect(missing).toEqual([]);
  });

  it('refresh only reindexes changed sessions', async () => {
    const { adapter, db, indexer, events } = setup(5);
    await indexer.fullSync();
    const spy = vi.spyOn(adapter, 'getSessionMessages');
    events.length = 0;

    await indexer.refresh([...adapter.sessions.keys()]);
    expect(spy).not.toHaveBeenCalled();

    const [id] = [...adapter.sessions.keys()];
    const s = adapter.sessions.get(id as string)!;
    s.info = {
      ...s.info,
      lastModified: s.info.lastModified + 1000,
      fileSize: (s.info.fileSize ?? 0) + 5,
    };
    s.messages.push(sm('user', { role: 'user', content: 'zebrafish appended' }));
    await indexer.refresh([id as string]);
    expect(spy.mock.calls.every((c) => c[0] === id)).toBe(true);
    expect(spy).toHaveBeenCalled();
    expect(db.searchFts('zebrafish', 5).map((h) => h.sessionId)).toEqual([id]);
    expect(events).toContainEqual({ event: 'sessions.changed', data: { sessionIds: [id] } });
  });

  it('caps indexed text per session', async () => {
    const adapter = generateCorpus({ sessions: 0, projects: 1, bigSessionMessages: 500 });
    const db = openDb(':memory:');
    const indexer = new Indexer(adapter, db, () => {}, {
      platform: 'linux',
      gitCommonDir: () => null,
      maxTextChars: 50_000,
    });
    await indexer.fullSync();
    const rows = db.raw.prepare('SELECT sum(length(text)) AS n FROM messages_fts').get() as {
      n: number;
    };
    expect(rows.n).toBeLessThanOrEqual(50_000 + 20_000);
    expect(rows.n).toBeGreaterThan(10_000);
  });

  it('keeps the most recent text when over the cap', async () => {
    const adapter = generateCorpus({ sessions: 0, projects: 1, bigSessionMessages: 100 });
    const msgs = adapter.sessions.get('session-big')!.messages;
    msgs[0] = sm('user', { role: 'user', content: 'headmarkerxyz' });
    msgs[msgs.length - 1] = sm('assistant', {
      role: 'assistant',
      content: [{ type: 'text', text: 'tailmarkerxyz' }],
    });
    const db = openDb(':memory:');
    await new Indexer(adapter, db, () => {}, {
      platform: 'linux',
      gitCommonDir: () => null,
      maxTextChars: 50_000,
    }).fullSync();
    expect(db.searchFts('tailmarkerxyz', 5)).toHaveLength(1);
    expect(db.searchFts('headmarkerxyz', 5)).toEqual([]);
  });

  it('reads each transcript once per index pass, however long it is', async () => {
    // The SDK parses the whole file on every call, so paging it would be quadratic.
    const adapter = generateCorpus({ sessions: 2, projects: 1, bigSessionMessages: 1000 });
    const spy = vi.spyOn(adapter, 'getSessionMessages');
    const db = openDb(':memory:');
    await new Indexer(adapter, db, () => {}, {
      platform: 'linux',
      gitCommonDir: () => null,
    }).fullSync();
    const perSession = new Map<string, number>();
    for (const [id] of spy.mock.calls) perSession.set(id, (perSession.get(id) ?? 0) + 1);
    expect(perSession.get('session-big')).toBe(1);
    expect([...perSession.values()].every((n) => n === 1)).toBe(true);
    expect(spy.mock.calls.every((c) => c[1] === undefined)).toBe(true);
    expect(db.searchFts('parity', 5).map((h) => h.sessionId)).toContain('session-big');
  });

  it('defers refreshes of busy (streaming) sessions until they settle', async () => {
    const { adapter, db, events } = setup(3);
    const busy = new Set(['session-1']);
    const indexer = new Indexer(adapter, db, (e) => events.push(e), {
      platform: 'linux',
      gitCommonDir: () => null,
      deferWhile: (id) => busy.has(id),
    });
    await indexer.fullSync();
    const spy = vi.spyOn(adapter, 'getSessionMessages');
    for (const id of ['session-0', 'session-1']) {
      const s = adapter.sessions.get(id)!;
      s.info = { ...s.info, lastModified: s.info.lastModified + 1000 };
      s.messages.push(sm('user', { role: 'user', content: `appended${id.slice(-1)}marker` }));
    }
    await indexer.refresh(['session-0', 'session-1']);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['session-0']);
    expect(db.searchFts('appended1marker', 5)).toEqual([]);
    // Still busy: nothing to do yet.
    await indexer.resumeDeferred();
    expect(spy).toHaveBeenCalledTimes(1);
    busy.delete('session-1');
    await indexer.resumeDeferred();
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['session-0', 'session-1']);
    expect(db.searchFts('appended1marker', 5).map((h) => h.sessionId)).toEqual(['session-1']);
    // Once indexed, it is no longer pending.
    await indexer.resumeDeferred();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('stop() ends a running sync early and resolves once it has stopped', async () => {
    const { adapter, db, indexer } = setup(45);
    const real = adapter.getSessionMessages.bind(adapter);
    let stopping: Promise<void> | undefined;
    const spy = vi.spyOn(adapter, 'getSessionMessages').mockImplementation(async (id, o) => {
      stopping ??= indexer.stop(); // shutdown arrives while the first transcript is read
      return real(id, o);
    });
    await indexer.fullSync(); // resolves: a stop is not a failure
    await stopping;
    const calls = spy.mock.calls.length;
    expect(calls).toBe(1);
    expect(db.searchFts('parity', 50)).toEqual([]);
    // Nothing runs after stop.
    await indexer.refresh(['session-44']);
    await indexer.fullSync().catch(() => {});
    expect(spy.mock.calls.length).toBe(calls);
    db.close();
  });

  it('removes vanished sessions and empty projects but keeps live sessions and pinned projects', async () => {
    const { adapter, db, indexer, events } = setup(6); // 3 projects x 2 sessions
    await indexer.fullSync();
    expect(db.listProjects()).toHaveLength(3);
    const ids = [...adapter.sessions.keys()];
    const inProject = (p: string) =>
      ids.filter((i) => adapter.sessions.get(i)?.info.cwd === `/work/proj-${p}`);
    // proj-0: gone entirely, but one of its sessions is live
    const [p0a, p0b] = inProject('0') as [string, string];
    db.markLive(p0b, '/work/proj-0');
    // proj-1: gone entirely, pinned project
    db.setProjectPinned('/work/proj-1', true);
    // proj-2: gone entirely, unpinned
    for (const id of [...inProject('0'), ...inProject('1'), ...inProject('2')])
      adapter.sessions.delete(id);
    events.length = 0;
    await indexer.fullSync();
    expect(db.getSession(p0a)).toBeUndefined();
    expect(db.getSession(p0b)).toBeDefined(); // live: kept
    expect(db.listSessions({}, 100, undefined).items.map((s) => s.sessionId)).toEqual([p0b]);
    expect(db.searchFts('parity', 100).some((h) => h.sessionId === p0a)).toBe(false);
    expect(db.raw.prepare('SELECT count(*) AS n FROM messages_fts').get()?.n).toBeLessThanOrEqual(
      2,
    );
    expect(
      db
        .listProjects()
        .map((p) => p.projectId)
        .sort(),
    ).toEqual(['/work/proj-0', '/work/proj-1']);
    expect(events.some((e) => e.event === 'projects.changed')).toBe(true);
  });

  it('prunes the "Your turn" state of vanished sessions, not of live or listed ones', async () => {
    const { adapter, db, indexer } = setup(3);
    await indexer.fullSync();
    const [gone, live, kept] = [...adapter.sessions.keys()] as [string, string, string];
    for (const id of [gone, live, kept]) db.setTurnEnded(id, 10);
    db.markLive(live, '/work/proj-1');
    adapter.sessions.delete(gone);
    adapter.sessions.delete(live);
    await indexer.fullSync();
    expect([...db.unreadTurns().keys()].sort()).toEqual([kept, live].sort());
    const rows = db.raw.prepare('SELECT session_id FROM turn_state').all();
    expect(rows.map((r) => r.session_id).sort()).toEqual([kept, live].sort());
  });

  it('isolates a failing session: others index, projects sync, failure is reported and unmarked', async () => {
    const { adapter, db, events } = setup(5);
    const failing = 'session-2';
    const real = adapter.getSessionMessages.bind(adapter);
    vi.spyOn(adapter, 'getSessionMessages').mockImplementation(async (id, o) => {
      if (id === failing) throw new Error('boom');
      return real(id, o);
    });
    const errors: { id: string; msg: string }[] = [];
    const indexer = new Indexer(adapter, db, (e) => events.push(e), {
      platform: 'linux',
      gitCommonDir: () => null,
      onError: (e, c) => errors.push({ id: c.sessionId, msg: (e as Error).message }),
    });
    await indexer.fullSync();
    expect(errors).toEqual([{ id: failing, msg: 'boom' }]);
    for (const [id, s] of adapter.sessions) expect(db.needsReindex(s.info)).toBe(id === failing);
    expect(db.listProjects().length).toBe(3);

    const realInfo = adapter.getSessionInfo.bind(adapter);
    vi.spyOn(adapter, 'getSessionInfo').mockImplementation(async (id) => {
      if (id === 'session-0') throw new Error('info boom');
      return realInfo(id);
    });
    await indexer.refresh(['session-0', 'session-1']);
    expect(errors.at(-1)).toEqual({ id: 'session-0', msg: 'info boom' });
  });

  it('a failure mid-extraction leaves the previous index text searchable', async () => {
    const { adapter, db, indexer } = setup(1);
    await indexer.fullSync();
    expect(db.searchFts('parity', 5)).toHaveLength(1);
    const s = adapter.sessions.get('session-0')!;
    s.info = { ...s.info, lastModified: s.info.lastModified + 1 };
    vi.spyOn(adapter, 'getSessionMessages').mockRejectedValue(new Error('mid'));
    await indexer.fullSync();
    expect(db.needsReindex(s.info)).toBe(true);
    expect(db.searchFts('parity', 5)).toHaveLength(1);
  });

  it('a failure while writing the new index leaves the old text and no stray rows', async () => {
    const adapter = generateCorpus({ sessions: 0, projects: 1, bigSessionMessages: 60 });
    const db = openDb(':memory:');
    const indexer = new Indexer(adapter, db, () => {}, {
      platform: 'linux',
      gitCommonDir: () => null,
    });
    await indexer.fullSync();
    const count = () => db.raw.prepare('SELECT count(*) AS n FROM messages_fts').get()?.n;
    const before = count();
    const s = adapter.sessions.get('session-big')!;
    s.info = { ...s.info, lastModified: s.info.lastModified + 1 };
    const real = db.addFtsChunk.bind(db);
    let calls = 0;
    vi.spyOn(db, 'addFtsChunk').mockImplementation((k, t) => {
      if (++calls === 3) throw new Error('disk');
      real(k, t);
    });
    await indexer.fullSync();
    expect(calls).toBe(3);
    expect(db.needsReindex(s.info)).toBe(true);
    expect(db.searchFts('parity', 5)).toHaveLength(1);
    expect(count()).toBe(before);
  });
});

// ── v1.2 C1 fix round 1 ──

describe('Indexer and Threadgarden titles', () => {
  it('a new Claude Code title (a /rename in the terminal) clears Threadgarden’s generated title', async () => {
    const { adapter, db, indexer } = setup(3);
    await indexer.fullSync();
    const [id, other] = [...adapter.sessions.keys()] as [string, string];
    db.setGeneratedTitle(id, 'Generated by Threadgarden');
    db.setGeneratedTitle(other, 'Kept');
    // An unrelated change keeps it.
    const s = adapter.sessions.get(id)!;
    s.info = { ...s.info, lastModified: s.info.lastModified + 1000 };
    await indexer.refresh([id]);
    expect(db.getSession(id)?.generatedTitle).toBe('Generated by Threadgarden');
    // The terminal rename: the SDK reports it as customTitle (Threadgarden's sdkTitle).
    s.info = {
      ...s.info,
      customTitle: 'Renamed in the terminal',
      lastModified: s.info.lastModified + 1000,
    };
    await indexer.refresh([id]);
    expect(db.getSession(id)?.generatedTitle).toBeNull();
    expect(db.getSession(other)?.generatedTitle).toBe('Kept');
  });
});

// ── v1.3 C analytics: statistics ──

describe('Indexer statistics', () => {
  const NOW = new Date(2026, 9, 31, 12).getTime();
  const richSetup = (sessions = 10) => {
    const adapter = generateCorpus({
      sessions,
      projects: 2,
      bigSessionMessages: 0,
      recent: { now: NOW, days: 30 },
    });
    const db = openDb(':memory:');
    const errors: { step: string; sessionId: string }[] = [];
    const busy = new Set<string>();
    const indexer = new Indexer(adapter, db, () => {}, {
      platform: 'linux',
      gitCommonDir: () => null,
      onError: (_e, ctx) => errors.push(ctx),
      deferWhile: (id) => busy.has(id),
    });
    return { adapter, db, indexer, errors, busy };
  };
  type TestDb = ReturnType<typeof openDb>;
  const count = (db: TestDb, table: string, id?: string): number =>
    Number(
      (
        db.raw
          .prepare(`SELECT COUNT(*) AS n FROM ${table}${id ? ' WHERE session_id = ?' : ''}`)
          .get(...(id ? [id] : [])) as { n: number }
      ).n,
    );
  const messagesOf = (db: TestDb, id: string): number =>
    Number(
      (
        db.raw
          .prepare(
            `SELECT COALESCE(SUM(user_messages + assistant_messages), 0) AS n
             FROM stats_days WHERE session_id = ?`,
          )
          .get(id) as { n: number }
      ).n,
    );
  /** What an older Threadgarden left behind: indexed sessions without statistics. */
  const forgetStats = (db: TestDb): void => {
    for (const t of STATS_TABLES) {
      db.raw.exec(`DELETE FROM ${t}`);
    }
  };

  it('gathers every session’s statistics during the index walk, with one read each', async () => {
    const { adapter, db, indexer } = richSetup();
    const spy = vi.spyOn(adapter, 'getSessionMessages');
    await indexer.fullSync();
    expect(spy).toHaveBeenCalledTimes(10);
    expect(count(db, 'stats_sessions')).toBe(10);
    expect(db.countSessionsNeedingStats(1)).toBe(0);
    for (const [id, s] of adapter.sessions) expect(messagesOf(db, id)).toBe(s.messages.length);
    expect(count(db, 'stats_tools')).toBeGreaterThan(0);
  });

  it('replaces a session’s statistics when it is indexed again', async () => {
    const { adapter, db, indexer } = richSetup(3);
    await indexer.fullSync();
    const s = adapter.sessions.get('session-1')!;
    const before = messagesOf(db, 'session-1');
    s.messages.push(sm('user', { role: 'user', content: 'one more' }));
    s.info = { ...s.info, lastModified: s.info.lastModified + 1000 };
    await indexer.refresh(['session-1']);
    expect(messagesOf(db, 'session-1')).toBe(before + 1);
  });

  it('deletes a session’s statistics with the session', async () => {
    const { adapter, db, indexer } = richSetup(3);
    await indexer.fullSync();
    adapter.sessions.delete('session-2');
    await indexer.fullSync();
    for (const t of ['stats_sessions', 'stats_days', 'stats_hours', 'stats_tools']) {
      expect(count(db, t, 'session-2'), t).toBe(0);
    }
    expect(count(db, 'stats_sessions')).toBe(2);
  });

  it('backfills sessions indexed before statistics existed, without redoing full-text', async () => {
    const { adapter, db, indexer } = richSetup(10);
    await indexer.fullSync();
    forgetStats(db);
    const stage = vi.spyOn(db, 'stageFts');
    const reads = vi.spyOn(adapter, 'getSessionMessages');
    expect(db.countSessionsNeedingStats(1)).toBe(10);
    // The next start's full sync finds nothing to re-index, then backfills in the background.
    await indexer.fullSync();
    await new Promise((r) => setImmediate(r));
    await indexer.backfillStats();
    expect(db.countSessionsNeedingStats(1)).toBe(0);
    expect(stage).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalledTimes(10);
    for (const [id, s] of adapter.sessions) expect(messagesOf(db, id)).toBe(s.messages.length);
    expect(db.searchFts('parity', 50).length).toBeGreaterThan(0);
  });

  it('lets a refresh run between backfill batches', async () => {
    const { adapter, db, indexer } = richSetup(3 * BACKFILL_BATCH);
    await indexer.fullSync();
    forgetStats(db);
    const order: string[] = [];
    const real = adapter.getSessionMessages.bind(adapter);
    adapter.getSessionMessages = async (id, o) => {
      order.push(id);
      return real(id, o);
    };
    const backfill = indexer.backfillStats();
    // The oldest chat (the backfill's last batch) changes: its refresh need not wait for the rest.
    const s = adapter.sessions.get('session-0')!;
    s.info = { ...s.info, lastModified: s.info.lastModified + 1 };
    await new Promise((r) => setImmediate(r));
    const refreshed = indexer.refresh(['session-0']);
    await Promise.all([backfill, refreshed]);
    expect(order.indexOf('session-0')).toBeLessThan(2 * BACKFILL_BATCH);
    expect(order.filter((id) => id === 'session-0')).toHaveLength(1);
    expect(db.countSessionsNeedingStats(1)).toBe(0);
  });

  it('skips a session it cannot read and chats mid-turn, and still finishes', async () => {
    const { adapter, db, indexer, errors, busy } = richSetup(6);
    await indexer.fullSync();
    forgetStats(db);
    const real = adapter.getSessionMessages.bind(adapter);
    adapter.getSessionMessages = async (id, o) => {
      if (id === 'session-3') throw new Error('unreadable');
      return real(id, o);
    };
    busy.add('session-4');
    await indexer.backfillStats();
    expect(errors).toEqual([{ sessionId: 'session-3', step: 'stats' }]);
    expect(db.sessionsNeedingStats(1, 10).sort()).toEqual(['session-3', 'session-4']);
    // The busy chat is indexed once its turn ends (its transcript changed meanwhile).
    busy.delete('session-4');
    const s = adapter.sessions.get('session-4')!;
    s.info = { ...s.info, lastModified: s.info.lastModified + 1 };
    await indexer.resumeDeferred();
    expect(db.sessionsNeedingStats(1, 10)).toEqual(['session-3']);
  });

  it('a stopped indexer ends the backfill', async () => {
    const { db, indexer } = richSetup(3 * BACKFILL_BATCH);
    await indexer.fullSync();
    forgetStats(db);
    const backfill = indexer.backfillStats();
    await indexer.stop();
    await backfill;
    expect(db.countSessionsNeedingStats(1)).toBeGreaterThan(0);
  });
});
