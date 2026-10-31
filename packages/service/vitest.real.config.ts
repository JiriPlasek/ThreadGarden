import { defineConfig } from 'vitest/config';

// Opt-in tests against the installed `claude` and the user's own login:
// `pnpm --filter @threadgarden/service test:real`. Never part of `pnpm test` or CI.
// Files run one at a time: the service suite snapshots the real Claude config
// dir and must not see the other file's sessions start mid-run.
export default defineConfig({
  test: {
    include: ['test/real/**/*.real.test.ts'],
    env: { THREADGARDEN_REAL: '1' },
    fileParallelism: false,
    silent: false,
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
