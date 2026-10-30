import { monitorEventLoopDelay } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/history/db.js';
import { Indexer } from '../../src/history/indexer.js';
import { generateCorpus } from '../../src/testing/corpus.js';

const slack = Number(process.env.PAHUB_PERF_SLACK ?? 1);
const opts = { platform: 'linux' as const, gitCommonDir: () => null };

describe('indexer perf', () => {
  it('search over 1,000 sessions ≤ 150 ms', async () => {
    const adapter = generateCorpus({ sessions: 1000, projects: 20, bigSessionMessages: 0 });
    const db = openDb(':memory:');
    await new Indexer(adapter, db, () => {}, opts).fullSync();
    db.searchFts('parity', 50); // warm up
    const times: number[] = [];
    for (const q of ['parity', 'refactor', 'migrat', 'unlikelytoken']) {
      const t0 = performance.now();
      db.searchFts(q, 50);
      times.push(performance.now() - t0);
    }
    console.info(`search over 1000 sessions: max ${Math.max(...times).toFixed(1)} ms`);
    expect(Math.max(...times)).toBeLessThanOrEqual(150 * slack);
    db.close();
  }, 120_000);

  it('indexes a 20 MB synthetic session without blocking > 50 ms', async () => {
    // 2,000 messages × ~10 KB = ~20 MB of transcript text.
    const adapter = generateCorpus({ sessions: 0, projects: 1, bigSessionMessages: 2000 });
    const db = openDb(':memory:');
    // Count what the indexer's fetch path really pulls through.
    let fetched = 0;
    const real = adapter.getSessionMessages.bind(adapter);
    adapter.getSessionMessages = async (id, o) => {
      const page = await real(id, o);
      for (const m of page) fetched += JSON.stringify(m.message).length;
      return page;
    };
    const indexer = new Indexer(adapter, db, () => {}, opts);
    const h = monitorEventLoopDelay({ resolution: 5 });
    h.enable();
    const t0 = performance.now();
    await indexer.fullSync();
    const total = performance.now() - t0;
    h.disable();
    const maxMs = h.max / 1e6;
    console.info(
      `20 MB session: total ${total.toFixed(0)} ms, max loop delay ${maxMs.toFixed(1)} ms`,
    );
    // The histogram resolution adds its own 5 ms tick to every sample.
    console.info(`fetched ${(fetched / 1e6).toFixed(1)} MB`);
    expect(fetched).toBeGreaterThanOrEqual(19_000_000);
    expect(maxMs - 5).toBeLessThanOrEqual(50 * slack);
    expect(db.searchFts('parity', 5).length).toBe(1);
    db.close();
  }, 120_000);
});
