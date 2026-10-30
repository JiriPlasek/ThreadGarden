import { configDefaults, defineConfig } from 'vitest/config';

// Real tests (test/real/**) spawn the user's `claude` and use their login;
// they run only through `pnpm test:real` (vitest.real.config.ts), never in CI.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'test/real/**'],
  },
});
