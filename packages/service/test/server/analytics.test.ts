/**
 * v1.3 analytics (design §4) through the real service wiring: the indexer
 * gathers statistics from the fake SDK, `analytics.get` aggregates them, and
 * a service upgraded from a version without statistics backfills them.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, STATS_TABLES } from '../../src/history/db.js';
import { startService, type ServiceHandle } from '../../src/main.js';
import { generateCorpus } from '../../src/testing/corpus.js';
import type { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { TestClient, eventually } from '../e2e/ws-client.js';

let dir: string;
let svc: ServiceHandle | undefined;
let client: TestClient | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadgarden-analytics-'));
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  await svc?.close();
  svc = undefined;
  await rm(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON results in tests
type Any = Record<string, any>;

const SESSIONS = 30;

const start = async (adapter: FakeAdapter) => {
  svc = await startService({
    dataDir: join(dir, 'data'),
    claudeConfigDir: join(dir, 'claude'),
    adapter,
    claude: { path: '/bin/claude', version: '2.1.314' },
    externalRun: async () => '[]',
    sessionEnv: { PATH: '/usr/bin' },
    installSignalHandlers: false,
  });
  client = await TestClient.connect(svc.port, svc.token);
  const c = client;
  await eventually(async () => (await c.call<Any>('places.counts', {})).active >= SESSIONS);
  return c;
};

const corpus = () =>
  generateCorpus({
    sessions: SESSIONS,
    projects: 3,
    bigSessionMessages: 0,
    recent: { now: Date.now(), days: 20 },
  });

describe('analytics.get', () => {
  it('aggregates what the indexer gathered', async () => {
    const adapter = corpus();
    const c = await start(adapter);
    const total = [...adapter.sessions.values()].reduce((n, s) => n + s.messages.length, 0);
    const r: Any = await eventually<Any>(async () => {
      const a = await c.call<Any>('analytics.get', { range: '30d' });
      return a.kpis.messages === total ? a : null;
    });
    expect(r.kpis.chats).toBe(SESSIONS);
    expect(r.activity).toHaveLength(30);
    expect(r.projects.map((p: Any) => p.name).sort()).toEqual(['proj-0', 'proj-1', 'proj-2']);
    expect(r.tools.length).toBeGreaterThan(0);
    expect(r.tokens.models.length).toBeGreaterThan(0);
    expect(r.pending).toBe(0);

    // Project ids are platform paths: take proj-1's from the answer.
    const projectId = r.projects.find((p: Any) => p.name === 'proj-1').projectId as string;
    const one = await c.call<Any>('analytics.get', { range: 'all', projectId });
    expect(one.projects).toEqual([expect.objectContaining({ projectId, name: 'proj-1' })]);
    expect(one.kpis.chats).toBe(SESSIONS / 3);
  });

  it('rejects an unknown range', async () => {
    const c = await start(corpus());
    const r = await c.raw('analytics.get', { range: '14d' });
    expect(r.error?.code).toBe('INVALID_PARAMS');
  });

  it('a service upgraded from before statistics backfills them in the background', async () => {
    const adapter = corpus();
    await start(adapter);
    await client?.close();
    client = undefined;
    await svc?.close();
    svc = undefined;
    // What an older Threadgarden left: the same index without statistics.
    const db = openDb(join(dir, 'data', 'pahub.db'));
    for (const t of STATS_TABLES) {
      db.raw.exec(`DELETE FROM ${t}`);
    }
    db.close();

    const c = await start(adapter);
    const r: Any = await eventually<Any>(async () => {
      const a = await c.call<Any>('analytics.get', { range: '30d' });
      return a.pending === 0 && a.kpis.chats === SESSIONS ? a : null;
    });
    expect(r.kpis.chats).toBe(SESSIONS);
  });
});
