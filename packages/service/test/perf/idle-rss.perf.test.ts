/**
 * §8 "service idle RSS ≤ 150 MB": the service, bundled with esbuild as it
 * ships (`scripts/build.mjs`), runs in its own `node` process over 1,000
 * indexed sessions; its resident set size is read once it is idle after a GC.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { slack } from './perf-helpers.js';

const MB = 1024 * 1024;
let dir: string | undefined;

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('service memory', () => {
  it('idle RSS ≤ 150 MB after indexing 1,000 sessions', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pahub-perf-bundle-'));
    const outfile = join(dir, 'idle-service.mjs');
    // The same esbuild options as scripts/build.mjs.
    await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/idle-service.ts', import.meta.url))],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      banner: {
        js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
      logLevel: 'error',
    });
    const r = spawnSync(
      process.execPath,
      ['--expose-gc', '--disable-warning=ExperimentalWarning', outfile],
      { encoding: 'utf8', timeout: 100_000 },
    );
    expect(r.status, r.stderr).toBe(0);
    const m = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as {
      rss: number;
      heapUsed: number;
      gc: boolean;
    };
    console.info(
      `idle service after indexing 1000 sessions: rss ${(m.rss / MB).toFixed(1)} MB, heap ${(m.heapUsed / MB).toFixed(1)} MB`,
    );
    expect(m.gc).toBe(true);
    expect(m.rss).toBeLessThanOrEqual(150 * MB * slack);
  });
});
