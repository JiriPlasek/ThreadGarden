import { defineConfig } from 'vitest/config';

// Opt-in tests against the installed `claude` and the user's own login:
// `pnpm --filter @pahub/service test:real`. Never part of `pnpm test` or CI.
export default defineConfig({
  test: {
    include: ['test/real/**/*.real.test.ts'],
    env: { PAHUB_REAL: '1' },
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
