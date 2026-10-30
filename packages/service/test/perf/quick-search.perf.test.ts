import { describe, expect, it } from 'vitest';
import { Catalog } from '../../src/history/catalog.js';
import { openDb } from '../../src/history/db.js';
import { Indexer } from '../../src/history/indexer.js';
import { createQuickSearch } from '../../src/history/search.js';
import { generateCorpus } from '../../src/testing/corpus.js';
import { bestOf, slack } from './perf-helpers.js';

const opts = { platform: 'linux' as const, gitCommonDir: () => null };

describe('quick switcher perf', () => {
  it('quickSearch per keystroke ≤ 50 ms over 1,000 sessions', async () => {
    const adapter = generateCorpus({ sessions: 1000, projects: 20, bigSessionMessages: 0 });
    const db = openDb(':memory:');
    await new Indexer(adapter, db, () => {}, opts).fullSync();
    const catalog = new Catalog({ db, live: { list: () => [] }, externals: () => [], ...opts });
    const search = createQuickSearch(db, catalog);
    search('warm', 10);
    const times: number[] = [];
    for (const q of ['r', 're', 'ref', 'refa', 'refac', 'parity', 'migrat', 'zzzzqq']) {
      times.push(await bestOf(3, () => search(q, 20)));
    }
    const max = Math.max(...times);
    console.info(`quickSearch over 1000 sessions: max ${max.toFixed(1)} ms`);
    expect(max).toBeLessThanOrEqual(50 * slack);
    db.close();
  });
});
