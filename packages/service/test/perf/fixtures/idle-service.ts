/**
 * Child process for `idle-rss.perf.test.ts`, bundled like the shipped service
 * and run by plain `node --expose-gc`: starts the service over a synthetic
 * history of 1,000 sessions, waits until they are indexed, lets it go idle,
 * and prints `{"rss": …, "heapUsed": …}` (bytes) as one JSON line.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../../../src/main.js';
import { generateCorpus } from '../../../src/testing/corpus.js';

const SESSIONS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), 'pahub-perf-rss-'));
const svc = await startService({
  dataDir: join(dir, 'data'),
  claudeConfigDir: join(dir, 'claude'),
  adapter: generateCorpus({ sessions: SESSIONS, projects: 50, bigSessionMessages: 0 }),
  claude: { path: '/bin/claude', version: '2.1.314' },
  externalRun: async () => '[]',
  installSignalHandlers: false,
});
const call = async (method: string): Promise<Record<string, number>> => {
  const r = await svc.router.dispatch({ id: 1, method, params: {} } as never, { clientId: 'rss' });
  if ('error' in r) throw new Error(`${method}: ${r.error.message}`);
  return r.result as Record<string, number>;
};
const deadline = Date.now() + 90_000;
while ((await call('places.counts')).all !== SESSIONS) {
  if (Date.now() > deadline) throw new Error('indexing did not finish');
  await sleep(50);
}
// Idle: let pending timers and I/O settle, then ask V8 to collect garbage.
await sleep(1000);
const gc = (globalThis as { gc?: () => void }).gc;
for (let i = 0; i < 3; i++) {
  gc?.();
  await sleep(100);
}
const { rss, heapUsed } = process.memoryUsage();
process.stdout.write(`${JSON.stringify({ rss, heapUsed, gc: gc !== undefined })}\n`);
await svc.close();
await rm(dir, { recursive: true, force: true });
// Pending handles (the poller, timers) must not keep the child alive.
process.exit(0);
