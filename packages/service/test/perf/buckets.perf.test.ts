/**
 * v1.2 buckets (design §3) at scale: place lists and counts stay within the
 * tab-switch budget (§8: ≤ 50 ms) when most chats are archived, and a bulk
 * "archive older" of thousands of chats is one quick transaction.
 */
import { describe, expect, it } from 'vitest';
import { Buckets } from '../../src/history/buckets.js';
import { Catalog } from '../../src/history/catalog.js';
import { openDb } from '../../src/history/db.js';
import { Indexer } from '../../src/history/indexer.js';
import { generateCorpus } from '../../src/testing/corpus.js';
import { bestOf, slack } from './perf-helpers.js';

const opts = { platform: 'linux' as const, gitCommonDir: () => null };
const SESSIONS = 5000;
const BASE = 1_700_000_000_000;

describe('buckets perf', () => {
  it(`lists, counts and bulk-archives ${SESSIONS} chats within budget`, async () => {
    const adapter = generateCorpus({ sessions: SESSIONS, projects: 50, bigSessionMessages: 0 });
    const db = openDb(':memory:');
    await new Indexer(adapter, db, () => {}, opts).fullSync();
    const catalog = new Catalog({ db, live: { list: () => [] }, externals: () => [], ...opts });
    // Session i is BASE + i minutes old; "now" leaves the newest 500 within 30 days.
    const now = BASE + 30 * 86_400_000 + (SESSIONS - 500) * 60_000;
    const buckets = new Buckets({ db, catalog, emit: () => {}, now: () => now });
    buckets.set(
      Array.from({ length: 100 }, (_, i) => `session-${SESSIONS - 1 - i * 3}`),
      'onHold',
    );

    const t0 = performance.now();
    const { archived } = buckets.archiveOlder({ olderThanDays: 30 });
    const archiveMs = performance.now() - t0;
    expect(archived).toBe(SESSIONS - 500);

    catalog.list({ kind: 'active' }, undefined, 50); // the corpus snapshot is built once
    const times: Record<string, number> = {
      counts: await bestOf(3, () => catalog.counts()),
      active: await bestOf(3, () => catalog.list({ kind: 'active' }, undefined, 50)),
      onHold: await bestOf(3, () => catalog.list({ kind: 'onHold' }, undefined, 50)),
      archived: await bestOf(3, () => catalog.list({ kind: 'archived' }, undefined, 50)),
      project: await bestOf(3, () =>
        catalog.list({ kind: 'project', projectId: '/work/proj-7' }, undefined, 50),
      ),
      projectAll: await bestOf(3, () =>
        catalog.list(
          { kind: 'project', projectId: '/work/proj-7', include: ['onHold', 'archived'] },
          undefined,
          50,
        ),
      ),
      needsYou: await bestOf(3, () => catalog.list({ kind: 'needsYou' }, undefined, 50)),
      // Archiving a chat and listing Active again (the cached corpus is patched, not rebuilt).
      afterChange: await bestOf(3, () => {
        buckets.set([`session-${SESSIONS - 2}`], 'archived');
        catalog.list({ kind: 'active' }, 'proj-7', 50);
        buckets.set([`session-${SESSIONS - 2}`], 'active');
        return catalog.list({ kind: 'active' }, undefined, 50);
      }),
    };
    console.info(
      `buckets over ${SESSIONS} sessions: archiveOlder ${archiveMs.toFixed(1)} ms; ` +
        Object.entries(times)
          .map(([k, v]) => `${k} ${v.toFixed(1)} ms`)
          .join(', '),
    );
    for (const [k, v] of Object.entries(times)) expect(v, k).toBeLessThanOrEqual(50 * slack);
    expect(archiveMs).toBeLessThanOrEqual(150 * slack);
    expect(catalog.counts()).toMatchObject({ active: 400, onHold: 100, archived: 4500 });
    db.close();
  });
});
