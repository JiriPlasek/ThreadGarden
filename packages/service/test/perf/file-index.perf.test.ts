import { monitorEventLoopDelay } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { FileIndex } from '../../src/files/file-index.js';
import { slack } from './perf-helpers.js';

describe('file index perf', () => {
  it('suggest on a cached 200,000-entry index ≤ 50 ms', async () => {
    const words = [
      'schema',
      'server',
      'client',
      'router',
      'index',
      'util',
      'store',
      'view',
      'model',
      'db',
    ];
    const files: string[] = [];
    for (let i = 0; i < 200_000; i++) {
      const w = (n: number) => words[(i * n + (i >> 3)) % words.length]!;
      files.push(`pkg${i % 40}/${w(3)}/${w(7)}${i % 97}/${w(1)}-${i}.ts`);
    }
    const idx = new FileIndex({ lister: async () => files });
    await idx.suggest('/big', 'x', 1); // builds the listing
    for (const q of ['warm', 'wrm']) await idx.suggest('/big', q, 50); // JIT warm-up
    // Best of 3 per query: measures the cost of the work, not scheduler noise from parallel test files.
    const times: number[] = [];
    for (const q of ['sche', 'srvr', 'index', 'zzzq', 'pkg1/rou']) {
      let best = Infinity;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        await idx.suggest('/big', q, 50);
        best = Math.min(best, performance.now() - t0);
      }
      times.push(best);
    }
    console.info(
      `suggest over 200k entries: max ${Math.max(...times).toFixed(1)} ms (${times.map((t) => t.toFixed(1)).join(', ')})`,
    );
    expect(Math.max(...times)).toBeLessThanOrEqual(50 * slack);
  }, 120_000);

  it('building a 200,000-entry listing never stalls the event loop > 50 ms', async () => {
    const files: string[] = [];
    for (let i = 0; i < 200_000; i++)
      files.push(`pkg${i % 40}/mod${i % 997}/sub${i % 13}/file-${i}.ts`);
    const idx = new FileIndex({ lister: async () => files });
    const h = monitorEventLoopDelay({ resolution: 5 });
    h.enable();
    const t0 = performance.now();
    await idx.suggest('/build', '', 10);
    const total = performance.now() - t0;
    h.disable();
    const maxMs = h.max / 1e6;
    console.info(
      `build of 200k: total ${total.toFixed(0)} ms, max event-loop delay ${maxMs.toFixed(1)} ms`,
    );
    expect(maxMs).toBeLessThanOrEqual(50 * slack);
  }, 120_000);
});
