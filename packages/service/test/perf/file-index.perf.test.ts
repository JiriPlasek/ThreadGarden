import { describe, expect, it } from 'vitest';
import { FileIndex } from '../../src/files/file-index.js';

const slack = Number(process.env.PAHUB_PERF_SLACK ?? 1);

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
    const times: number[] = [];
    for (const q of ['sche', 'srvr', 'index', 'zzzq', 'pkg1/rou']) {
      const t0 = performance.now();
      await idx.suggest('/big', q, 50);
      times.push(performance.now() - t0);
    }
    console.info(
      `suggest over 200k entries: max ${Math.max(...times).toFixed(1)} ms (${times.map((t) => t.toFixed(1)).join(', ')})`,
    );
    expect(Math.max(...times)).toBeLessThanOrEqual(50 * slack);
  }, 120_000);
});
