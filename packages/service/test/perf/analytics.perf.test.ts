/**
 * v1.3 analytics (design §4) budgets: `analytics.get` answers within the
 * tab-switch budget (§8: ≤ 50 ms) over a large dated history; gathering
 * statistics adds little to indexing; and the background backfill of an
 * upgraded index never blocks the event loop (≤ 50 ms, like indexing) or
 * slows search and analytics while it runs.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { queryAnalytics, type AnalyticsQuery } from '../../src/history/analytics.js';
import { Catalog } from '../../src/history/catalog.js';
import { openDb, STATS_TABLES, type Db } from '../../src/history/db.js';
import { Indexer } from '../../src/history/indexer.js';
import { StatsCollector } from '../../src/history/stats.js';
import { generateCorpus } from '../../src/testing/corpus.js';
import { bestOf, slack } from './perf-helpers.js';

const opts = { platform: 'linux' as const, gitCommonDir: () => null };
const NOW = Date.now();
const RANGES = ['7d', '30d', '90d', 'all'] as const;

/** `analytics.get` as the service answers it: titles from the catalog's cached corpus. */
const analyticsOf = (db: Db) => {
  const catalog = new Catalog({ db, live: { list: () => [] }, externals: () => [], ...opts });
  return (q: Omit<AnalyticsQuery, 'chats' | 'now'>) =>
    queryAnalytics(db, { ...q, now: NOW, chats: () => catalog.corpus() });
};

const forgetStats = (db: Db): void => {
  for (const t of STATS_TABLES) {
    db.raw.exec(`DELETE FROM ${t}`);
  }
};

describe('analytics perf', () => {
  it('analytics.get over 5,000 sessions ≤ 50 ms for every range, all or one project', async () => {
    const adapter = generateCorpus({
      sessions: 5000,
      projects: 50,
      bigSessionMessages: 0,
      recent: { now: NOW, days: 365 },
    });
    const db = openDb(':memory:');
    await new Indexer(adapter, db, () => {}, opts).fullSync();
    const project = db.listProjects()[7]!.projectId;
    const analytics = analyticsOf(db);
    analytics({ range: 'all' }); // warm up: the catalog builds its corpus once
    const times: Record<string, number> = {};
    for (const range of RANGES) {
      times[range] = await bestOf(3, () => analytics({ range }));
      times[`${range} one project`] = await bestOf(3, () =>
        analytics({ range, projectId: project }),
      );
    }
    console.info(
      'analytics.get over 5000 sessions: ' +
        Object.entries(times)
          .map(([k, v]) => `${k} ${v.toFixed(1)} ms`)
          .join(', '),
    );
    expect(analytics({ range: 'all' }).kpis.chats).toBe(5000);
    for (const [k, v] of Object.entries(times)) expect(v, k).toBeLessThanOrEqual(50 * slack);
    db.close();
  }, 120_000);

  it('gathering statistics costs ≤ 20 ms for a 2,000-message (20 MB) session', async () => {
    const adapter = generateCorpus({
      sessions: 0,
      projects: 1,
      bigSessionMessages: 2000,
      recent: { now: NOW, days: 30 },
    });
    const messages = await adapter.getSessionMessages('session-big');
    const ms = await bestOf(5, () => {
      const c = new StatsCollector(NOW);
      for (let i = 0; i < messages.length; i += 100) c.add(messages.slice(i, i + 100));
      return c.result();
    });
    const db = openDb(':memory:');
    const c = new StatsCollector(NOW);
    c.add(messages);
    const stats = c.result();
    const writeMs = await bestOf(5, () => db.replaceStats('session-big', stats, 1));
    console.info(
      `statistics of a 2000-message session: collect ${ms.toFixed(1)} ms, write ${writeMs.toFixed(1)} ms`,
    );
    expect(ms).toBeLessThanOrEqual(20 * slack);
    expect(writeMs).toBeLessThanOrEqual(20 * slack);
    db.close();
  });

  it('backfilling a 20 MB session and 200 others never blocks the event loop > 50 ms', async () => {
    // The same 20 MB session as the indexer's budget, plus the many small ones a backfill walks.
    const adapter = generateCorpus({
      sessions: 200,
      projects: 10,
      bigSessionMessages: 2000,
      recent: { now: NOW, days: 90 },
    });
    const db = openDb(':memory:');
    const indexer = new Indexer(adapter, db, () => {}, opts);
    await indexer.fullSync();
    await indexer.backfillStats();
    forgetStats(db); // what an index built before v1.3 looks like
    const h = monitorEventLoopDelay({ resolution: 5 });
    h.enable();
    const t0 = performance.now();
    await indexer.backfillStats();
    const total = performance.now() - t0;
    h.disable();
    const maxMs = h.max / 1e6;
    console.info(
      `backfill of 201 sessions (one of 20 MB): total ${total.toFixed(0)} ms, ` +
        `max loop delay ${maxMs.toFixed(1)} ms`,
    );
    expect(db.countSessionsNeedingStats(1)).toBe(0);
    // The histogram resolution adds its own 5 ms tick to every sample.
    expect(maxMs - 5).toBeLessThanOrEqual(50 * slack);
    db.close();
  }, 120_000);

  it('search and analytics.get stay within their budgets while 1,000 sessions are backfilled', async () => {
    const adapter = generateCorpus({
      sessions: 1000,
      projects: 20,
      bigSessionMessages: 0,
      recent: { now: NOW, days: 90 },
    });
    const db = openDb(':memory:');
    const indexer = new Indexer(adapter, db, () => {}, opts);
    await indexer.fullSync();
    await indexer.backfillStats();
    forgetStats(db);
    const analytics = analyticsOf(db);
    db.searchFts('parity', 50); // warm up, as the search budget does
    analytics({ range: '30d' });

    const backfill = indexer.backfillStats();
    let done = false;
    void backfill.then(() => (done = true));
    const search: number[] = [];
    const answer: number[] = [];
    // Requests arrive between the backfill's slices, as a UI's would.
    while (!done) {
      let s = performance.now();
      db.searchFts('parity', 50);
      search.push(performance.now() - s);
      s = performance.now();
      analytics({ range: '30d' });
      answer.push(performance.now() - s);
      await new Promise((r) => setTimeout(r, 5));
    }
    await backfill;
    const p = (xs: number[], q: number) =>
      [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))]!;
    console.info(
      `during the backfill of 1000 sessions (${search.length} rounds): ` +
        `search median ${p(search, 0.5).toFixed(1)} / max ${Math.max(...search).toFixed(1)} ms, ` +
        `analytics.get median ${p(answer, 0.5).toFixed(1)} / max ${Math.max(...answer).toFixed(1)} ms`,
    );
    expect(search.length).toBeGreaterThan(3);
    expect(Math.max(...search)).toBeLessThanOrEqual(150 * slack);
    expect(Math.max(...answer)).toBeLessThanOrEqual(50 * slack);
    db.close();
  }, 120_000);
});
