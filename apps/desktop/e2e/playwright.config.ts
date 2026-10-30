import { defineConfig, devices } from '@playwright/test';
import { MOCK_PORT, MOCK_TOKEN, UI_PORT } from './env';

/**
 * End-to-end and performance specs for the UI in a browser (Chromium) against
 * the mock service (`pnpm --filter @pahub/service mock`): synthetic history of
 * 1,000 sessions and a scripted fake Claude Code. `pnpm --filter desktop test:e2e`.
 *
 * The UI is a production build served by `vite preview`, built into
 * `build-e2e/` with the mock's address baked in (`VITE_PAHUB_MOCK_*`), so
 * `build/` (what Tauri embeds) is left alone. Fixed port and token, so the
 * build and the mock agree.
 */
const UI_URL = `http://127.0.0.1:${UI_PORT}`;

export default defineConfig({
  testDir: '.',
  // The specs share one mock service (and its chats), and perf specs must not
  // compete for the CPU: one worker, in file order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  outputDir: '../test-results/e2e',
  use: {
    baseURL: UI_URL,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 900 },
  },
  projects: [{ name: 'chromium' }],
  webServer: [
    {
      command: 'pnpm --filter @pahub/service mock',
      env: { PAHUB_MOCK_PORT: String(MOCK_PORT), PAHUB_MOCK_TOKEN: MOCK_TOKEN },
      // The mock answers plain HTTP with 426 (WebSocket only); the port opening is the signal.
      port: MOCK_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
    },
    {
      command: `pnpm build && pnpm exec vite preview --host 127.0.0.1 --port ${UI_PORT} --strictPort`,
      cwd: '..',
      env: {
        VITE_PAHUB_MOCK_URL: `ws://127.0.0.1:${MOCK_PORT}`,
        VITE_PAHUB_MOCK_TOKEN: MOCK_TOKEN,
        PAHUB_UI_OUT: 'build-e2e',
      },
      url: UI_URL,
      reuseExistingServer: false,
      timeout: 240_000,
      stdout: 'ignore',
    },
  ],
});
