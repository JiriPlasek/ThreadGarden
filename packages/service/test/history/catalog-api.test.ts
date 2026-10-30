import { describe, expect, it, vi } from 'vitest';
import type { ChatStatus } from '@pahub/protocol';
import { Catalog, type LiveChat } from '../../src/history/catalog.js';
import { openDb } from '../../src/history/db.js';
import { Indexer } from '../../src/history/indexer.js';
import { createQuickSearch } from '../../src/history/search.js';
import { registerHistoryHandlers } from '../../src/server/handlers/history.js';
import { Router } from '../../src/server/router.js';
import { generateCorpus } from '../../src/testing/corpus.js';

const opts = { platform: 'linux' as const, gitCommonDir: () => null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON results in tests
type Any = Record<string, any>;

const setup = async (sessions = 12, projects = 3) => {
  const adapter = generateCorpus({ sessions, projects, bigSessionMessages: 0 });
  const db = openDb(':memory:');
  await new Indexer(adapter, db, () => {}, opts).fullSync();
  let live: LiveChat[] = [];
  let externals: unknown[] = [];
  const catalog = new Catalog({
    db,
    live: { list: () => live },
    externals: () => externals as never,
    ...opts,
  });
  const router = new Router();
  registerHistoryHandlers(router, { db, catalog, quickSearch: createQuickSearch(db, catalog) });
  const call = async (method: string, params: unknown = {}): Promise<Any> => {
    const r = await router.dispatch({ id: 1, method, params } as never, { clientId: 'c' });
    if ('error' in r) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.result as Any;
  };
  return {
    adapter,
    db,
    catalog,
    call,
    setLive: (l: LiveChat[]) => (live = l),
    setExternals: (e: unknown[]) => (externals = e),
  };
};

const lc = (sessionId: string, cwd: string, status: ChatStatus, waitingFor?: string): LiveChat => ({
  sessionId,
  cwd,
  status,
  live: status !== 'paused',
  ...(waitingFor === undefined ? {} : { waitingFor }),
});

describe('catalog and places API', () => {
  it('needsYou place lists needs-you chats across projects', async () => {
    const t = await setup();
    t.setLive([
      lc('session-0', '/work/proj-0', 'needsYou', 'Bash'),
      lc('session-1', '/work/proj-1', 'needsYou', 'Edit'),
      lc('session-2', '/work/proj-2', 'working'),
    ]);
    const r = await t.call('sessions.list', { place: { kind: 'needsYou' }, limit: 50 });
    expect(r.items.map((i: Any) => i.sessionId).sort()).toEqual(['session-0', 'session-1']);
    expect(new Set(r.items.map((i: Any) => i.projectId)).size).toBe(2);
    expect(r.items[0]).toMatchObject({ status: 'needsYou', live: true, external: null });
    const counts = await t.call('places.counts');
    expect(counts.needsYou).toBe(2);
    expect(counts.running).toBe(1);
    const run = await t.call('sessions.list', { place: { kind: 'running' }, limit: 50 });
    expect(run.items.map((i: Any) => i.sessionId)).toEqual(['session-2']);
  });

  it('ordering puts needsYou first then working', async () => {
    const t = await setup();
    t.setLive([
      lc('session-3', '/work/proj-0', 'idle'),
      lc('session-4', '/work/proj-0', 'working'),
      lc('session-5', '/work/proj-0', 'needsYou'),
    ]);
    const r = await t.call('sessions.list', { place: { kind: 'all' }, limit: 50 });
    const ids = r.items.map((i: Any) => i.sessionId);
    expect(ids.slice(0, 3)).toEqual(['session-5', 'session-4', 'session-3']);
    const rest = r.items.slice(3).map((i: Any) => i.lastActivity);
    expect(rest).toEqual([...rest].sort((a, b) => b - a));
  });

  it('hidden projects excluded from all-chats', async () => {
    const t = await setup(12, 3);
    expect((await t.call('places.counts')).all).toBe(12);
    await t.call('projects.update', { projectId: '/work/proj-1', hidden: true });
    const r = await t.call('sessions.list', { place: { kind: 'all' }, limit: 50 });
    expect(r.items).toHaveLength(8);
    expect(r.items.every((i: Any) => i.projectId !== '/work/proj-1')).toBe(true);
    expect((await t.call('places.counts')).all).toBe(8);
    const proj = await t.call('sessions.list', {
      place: { kind: 'project', projectId: '/work/proj-1' },
      limit: 50,
    });
    expect(proj.items).toHaveLength(4);
    const list = (await t.call('projects.list')) as unknown as Any[];
    expect(list.find((p) => p.projectId === '/work/proj-1')).toMatchObject({ hidden: true });
  });

  it('meta.update customTitle overrides title without calling adapter mutation methods', async () => {
    const t = await setup();
    const spy = vi.spyOn(t.adapter, 'forkSession');
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(t.adapter));
    expect(names.some((k) => /rename|tag/i.test(k))).toBe(false);
    await t.call('meta.update', { sessionId: 'session-0', customTitle: 'My Title', pinned: true });
    const r = await t.call('sessions.list', { place: { kind: 'all' }, limit: 50 });
    expect(r.items.find((i: Any) => i.sessionId === 'session-0')).toMatchObject({
      title: 'My Title',
      pinned: true,
    });
    expect(spy).not.toHaveBeenCalled();
    await t.call('meta.update', { sessionId: 'session-0', customTitle: null });
    const r2 = await t.call('sessions.list', { place: { kind: 'all' }, limit: 50 });
    expect(r2.items.find((i: Any) => i.sessionId === 'session-0').title).not.toBe('My Title');
  });

  it('paginates with a cursor and filters by query', async () => {
    const t = await setup(30, 2);
    t.setLive([lc('session-7', '/work/proj-1', 'working')]);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await t.call('sessions.list', {
        place: { kind: 'all' },
        limit: 7,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...r.items.map((i: Any) => i.sessionId));
      cursor = r.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
    expect(seen[0]).toBe('session-7');
    await t.call('meta.update', { sessionId: 'session-9', customTitle: 'zebra crossing' });
    const q = await t.call('sessions.list', { place: { kind: 'all' }, query: 'zebra', limit: 10 });
    expect(q.items.map((i: Any) => i.sessionId)).toEqual(['session-9']);
  });

  it('includes live sessions not yet indexed and external rows', async () => {
    const t = await setup(3, 1);
    t.setLive([lc('fresh-live', '/work/new-proj', 'working')]);
    t.setExternals([
      {
        sessionId: 'ext-1',
        cwd: '/work/proj-0',
        status: 'needsYou',
        waitingFor: 'Bash',
        external: { kind: 'interactive', pid: 4 },
      },
    ]);
    const all = await t.call('sessions.list', { place: { kind: 'all' }, limit: 50 });
    expect(all.items.map((i: Any) => i.sessionId)).toEqual(
      expect.arrayContaining(['fresh-live', 'ext-1']),
    );
    const ext = all.items.find((i: Any) => i.sessionId === 'ext-1');
    expect(ext.external).toMatchObject({ kind: 'interactive' });
    expect(ext.live).toBe(false);
    expect((await t.call('places.counts')).needsYou).toBe(1);
    const projects = (await t.call('projects.list')) as unknown as Any[];
    expect(projects.find((p) => p.projectId === '/work/proj-0')?.counts.needsYou).toBe(1);
  });

  it('drafts and settings round-trip', async () => {
    const t = await setup(1, 1);
    expect(await t.call('drafts.get', { key: 'k' })).toEqual({ text: '' });
    await t.call('drafts.set', { key: 'k', text: 'hello' });
    expect(await t.call('drafts.get', { key: 'k' })).toEqual({ text: 'hello' });
    const s = await t.call('settings.set', { idleReclaimMinutes: 5 });
    expect(s.idleReclaimMinutes).toBe(5);
    expect((await t.call('settings.get')).idleReclaimMinutes).toBe(5);
  });

  it('projects.update rejects an unknown project', async () => {
    const t = await setup(1, 1);
    await expect(t.call('projects.update', { projectId: 'nope', pinned: true })).rejects.toThrow(
      /NOT_FOUND/,
    );
  });
});

describe('quickSearch', () => {
  it('finds by title, project name and full text; at most limit', async () => {
    const t = await setup(40, 4);
    await t.call('meta.update', { sessionId: 'session-5', customTitle: 'Flux capacitor repair' });
    const r1 = await t.call('search.quick', { query: 'flxcap', limit: 10 });
    expect(r1.items[0]).toMatchObject({ sessionId: 'session-5', projectName: 'proj-1' });
    const r2 = await t.call('search.quick', { query: 'proj-2', limit: 5 });
    expect(r2.items.length).toBeGreaterThan(0);
    expect(r2.items.length).toBeLessThanOrEqual(5);
    const r3 = await t.call('search.quick', { query: 'parity', limit: 8 });
    expect(r3.items.length).toBeGreaterThan(0);
    expect(r3.items.length).toBeLessThanOrEqual(8);
    expect(r3.items.some((i: Any) => i.snippet)).toBe(true);
    expect((await t.call('search.quick', { query: '', limit: 8 })).items).toEqual([]);
  });

  it('quickSearch per keystroke ≤ 50 ms over 1,000 sessions (perf)', async () => {
    const slack = Number(process.env.PAHUB_PERF_SLACK ?? 1);
    const t = await setup(1000, 20);
    const search = createQuickSearch(t.db, t.catalog);
    search('warm', 10);
    const times: number[] = [];
    for (const q of ['r', 're', 'ref', 'refa', 'refac', 'parity', 'migrat', 'zzzzqq']) {
      const t0 = performance.now();
      search(q, 20);
      times.push(performance.now() - t0);
    }
    const max = Math.max(...times);
    console.info(`quickSearch over 1000 sessions: max ${max.toFixed(1)} ms`);
    expect(max).toBeLessThanOrEqual(50 * slack);
  });
});
