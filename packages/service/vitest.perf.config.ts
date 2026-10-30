import { defineConfig } from 'vitest/config';

// Performance budgets (spec §8): `pnpm --filter @pahub/service test:perf`.
// One file at a time, after the regular tests, so timings are not skewed by
// other test files running in parallel.
export default defineConfig({
  test: {
    include: ['test/perf/**/*.perf.test.ts'],
    fileParallelism: false,
    // Print the measured numbers (console.info) even when the budgets are met.
    silent: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
