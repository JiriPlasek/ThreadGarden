/**
 * §8 "history chat open ≤ 150 ms": opening a held (live) chat whose history
 * is big must not re-read and re-normalize the transcript on every open or
 * page; the history read happens once while Threadgarden holds the session.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem } from '@threadgarden/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startService, type ServiceHandle } from '../../src/main.js';
import { generateCorpus } from '../../src/testing/corpus.js';
import { slack } from './perf-helpers.js';

let dir: string;
let svc: ServiceHandle;
const adapter = generateCorpus({ sessions: 20, projects: 2, bigSessionMessages: 2000 });

const call = async <T>(method: string, params: unknown): Promise<T> => {
  const r = await svc.router.dispatch({ id: 1, method, params }, { clientId: 'perf' });
  if ('error' in r) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
  return r.result as T;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadgarden-perf-open-'));
  svc = await startService({
    dataDir: join(dir, 'data'),
    claudeConfigDir: join(dir, 'claude'),
    adapter,
    claude: { path: '/bin/claude', version: '2.1.314' },
    externalRun: async () => '[]',
    installSignalHandlers: false,
  });
  for (let i = 0; i < 600; i++) {
    if ((await call<{ all: number }>('places.counts', {})).all === 21) break;
    await new Promise((r) => setTimeout(r, 50));
  }
}, 60_000);

afterAll(async () => {
  await svc.close();
  await rm(dir, { recursive: true, force: true });
});

describe('chat open performance', () => {
  it('reopening a held big chat ≤ 150 ms and paging never re-reads the history', async () => {
    await call('chat.send', { sessionId: 'session-big', text: 'continue' }); // held live
    const reads = vi.spyOn(adapter, 'getSessionMessages');

    const first = await call<{ items: ChatItem[]; hasMore: boolean }>('chat.open', {
      sessionId: 'session-big',
      tail: 50,
    });
    expect(first.hasMore).toBe(true);

    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await call('chat.open', { sessionId: 'session-big', tail: 50 });
      times.push(performance.now() - t0);
    }
    const median = times.sort((a, b) => a - b)[2]!;
    expect(median).toBeLessThanOrEqual(150 * slack);

    let before = first.items[0]!.id;
    let hasMore = true;
    let pages = 0;
    while (hasMore && pages < 60) {
      const page = await call<{ items: ChatItem[]; hasMore: boolean }>('chat.older', {
        sessionId: 'session-big',
        beforeItemId: before,
        limit: 50,
      });
      before = page.items[0]!.id;
      hasMore = page.hasMore;
      pages++;
    }
    expect(hasMore).toBe(false);
    expect(reads).toHaveBeenCalledTimes(1);
  }, 60_000);
});
