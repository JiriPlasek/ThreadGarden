import { defineConfig, devices } from '@playwright/test';
import { MOCK_PORT, MOCK_TOKEN, REMOTE_MOCK_PORT, REMOTE_PAIRING_CODE, UI_PORT } from './env';

/**
 * End-to-end and performance specs for the UI in a browser (Chromium) against
 * the mock service (`pnpm --filter @threadgarden/service mock`): synthetic history of
 * 1,000 sessions and a scripted fake Claude Code. `pnpm --filter desktop test:e2e`.
 *
 * The UI is a production build served by `vite preview`, built into
 * `build-e2e/` with the mock's address baked in (`VITE_THREADGARDEN_MOCK_*`), so
 * `build/` (what Tauri embeds) is left alone. Fixed port and token, so the
 * build and the mock agree.
 *
 * A second mock (`mock --remote`) is the other machine `machines.spec.ts`
 * pairs with: headless, its device listener on 127.0.0.1 (test-only) and a
 * fixed pairing code. The UI reaches it through the first mock's relay.
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
      command: 'pnpm --filter @threadgarden/service mock',
      env: { THREADGARDEN_MOCK_PORT: String(MOCK_PORT), THREADGARDEN_MOCK_TOKEN: MOCK_TOKEN },
      // The mock answers plain HTTP with 426 (WebSocket only); the port opening is the signal.
      port: MOCK_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
    },
    {
      command: `pnpm --filter @threadgarden/service mock --remote --remote-port ${REMOTE_MOCK_PORT} --pairing-code ${REMOTE_PAIRING_CODE}`,
      // Its own local port and token: never the first mock's.
      env: { THREADGARDEN_MOCK_PORT: '', THREADGARDEN_MOCK_TOKEN: '' },
      // The device listener speaks TLS; the port opening is the signal.
      port: REMOTE_MOCK_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
    },
    {
      command: `pnpm build && pnpm exec vite preview --host 127.0.0.1 --port ${UI_PORT} --strictPort`,
      cwd: '..',
      env: {
        VITE_THREADGARDEN_MOCK_URL: `ws://127.0.0.1:${MOCK_PORT}`,
        VITE_THREADGARDEN_MOCK_TOKEN: MOCK_TOKEN,
        THREADGARDEN_UI_OUT: 'build-e2e',
      },
      url: UI_URL,
      reuseExistingServer: false,
      timeout: 240_000,
      stdout: 'ignore',
    },
  ],
});
