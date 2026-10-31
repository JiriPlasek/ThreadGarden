/**
 * Ruling R29: a live Threadgarden chat with running background tasks (agents,
 * processes) counts as Running even while its turn is idle.
 */
import { describe, expect, it } from 'vitest';
import type { ChatStatus } from '@threadgarden/protocol';
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

const setup = async () => {
  const db = openDb(':memory:');
  const adapter = generateCorpus({ sessions: 12, projects: 3, bigSessionMessages: 0 });
  await new Indexer(adapter, db, () => {}, opts).fullSync();
  let live: LiveChat[] = [];
  const catalog = new Catalog({ db, live: { list: () => live }, ...opts });
  const router = new Router();
  registerHistoryHandlers(router, { db, catalog, quickSearch: createQuickSearch(db, catalog) });
  const call = async (method: string, params: unknown = {}): Promise<Any> => {
    const r = await router.dispatch({ id: 1, method, params } as never, { clientId: 'c' });
    if ('error' in r) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.result as Any;
  };
  const running = async (query?: string): Promise<Any[]> =>
    (
      await call('sessions.list', {
        place: { kind: 'running' },
        limit: 50,
        ...(query ? { query } : {}),
      })
    ).items;
  return { db, catalog, call, running, setLive: (l: LiveChat[]) => (live = l) };
};

const lc = (
  sessionId: string,
  cwd: string,
  status: ChatStatus,
  extra: Partial<LiveChat> = {},
): LiveChat => ({ sessionId, cwd, status, live: status !== 'paused', ...extra });

describe('Running place with background tasks (R29)', () => {
  it('lists an idle live chat with running tasks under Running, its status still idle', async () => {
    const t = await setup();
    t.setLive([
      lc('session-0', '/work/proj-0', 'idle', { runningTasks: 1 }), // a dev server
      lc('session-1', '/work/proj-1', 'working'),
      lc('session-2', '/work/proj-2', 'needsYou', { waitingFor: 'Allow Bash', runningTasks: 2 }),
      lc('session-3', '/work/proj-0', 'idle'), // nothing running
    ]);
    const items = await t.running();
    // Display order stays needs-you → working → idle.
    expect(items.map((i) => [i.sessionId, i.status, i.runningTasks])).toEqual([
      ['session-2', 'needsYou', 2],
      ['session-1', 'working', undefined],
      ['session-0', 'idle', 1],
    ]);
    expect((await t.call('places.counts')).running).toBe(3);
    const projects = (await t.call('projects.list')) as unknown as Any[];
    const byId = new Map(projects.map((p) => [p.projectId, p.counts.running]));
    expect(byId.get('/work/proj-0')).toBe(1);
    expect(byId.get('/work/proj-1')).toBe(1);
    expect(byId.get('/work/proj-2')).toBe(1);
    // Every summary of the chat carries the count (the chat list's badge).
    expect(t.catalog.summary('session-0')).toMatchObject({ status: 'idle', runningTasks: 1 });
    expect(t.catalog.summary('session-3')).not.toHaveProperty('runningTasks');
    const all = (await t.call('sessions.list', { place: { kind: 'all' }, limit: 50 })).items;
    expect(all.find((i: Any) => i.sessionId === 'session-0')).toMatchObject({ runningTasks: 1 });
    // Queries in Running see it too.
    const title = t.catalog.summary('session-0')!.title;
    expect((await t.running(title)).map((i) => i.sessionId)).toContain('session-0');
  });

  it('a chat without a process does not count, whatever it last reported', async () => {
    const t = await setup();
    t.setLive([
      lc('session-0', '/work/proj-0', 'paused', { runningTasks: 1 }),
      { ...lc('session-1', '/work/proj-1', 'failed', { runningTasks: 1 }), live: false },
    ]);
    expect(await t.running()).toEqual([]);
    expect((await t.call('places.counts')).running).toBe(0);
    expect(t.catalog.summary('session-0')).not.toHaveProperty('runningTasks');
  });

  it('the chat leaves Running when its last task ends', async () => {
    const t = await setup();
    t.setLive([lc('session-0', '/work/proj-0', 'idle', { runningTasks: 1 })]);
    expect((await t.running()).map((i) => i.sessionId)).toEqual(['session-0']);
    t.setLive([lc('session-0', '/work/proj-0', 'idle')]);
    expect(await t.running()).toEqual([]);
    expect((await t.call('places.counts')).running).toBe(0);
  });
});
