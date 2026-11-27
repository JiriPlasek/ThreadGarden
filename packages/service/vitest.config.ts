import { configDefaults, defineConfig } from 'vitest/config';
import { protocolAlias } from './protocol-alias.mjs';

// Real tests (test/real/**) spawn the user's `claude` and use their login;
// they run only through `pnpm test:real` (vitest.real.config.ts), never in CI.
// Perf tests (test/perf/**) run in their own serial pass: `pnpm test:perf`
// (vitest.perf.config.ts).
export default defineConfig({
  resolve: { alias: protocolAlias },
  test: {
    exclude: [...configDefaults.exclude, 'test/real/**', 'test/perf/**'],
    // Shared CI runners (Windows above all) are several times slower at disk and process
    // work than a desk PC: the default 5 s per test and 10 s per hook time out there.
    ...(process.env.CI ? { testTimeout: 15_000, hookTimeout: 30_000 } : {}),
  },
});
