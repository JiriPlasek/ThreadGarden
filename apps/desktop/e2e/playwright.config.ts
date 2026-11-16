import { defineConfig, devices } from '@playwright/test';
import {
  MOCK_PORT,
  MOCK_TOKEN,
  REMOTE_LOCAL_PORT,
  REMOTE_LOCAL_TOKEN,
  REMOTE_MOCK_PORT,
  REMOTE_PAIRING_CODE,
  FAKE_SWITCH_PORT,
  PHONE_MOCK_PORT,
  PHONE_MOCK_TOKEN,
  PHONE_UI_PORT,
  UI_PORT,
} from './env';

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
 * fixed pairing code. The UI reaches it through the first mock's relay. With
 * `--fake-tasmota` it also holds a fake Tasmota Zigbee bridge (`power.spec.ts`),
 * whose plug brings it back when `away.spec.ts` has switched it off.
 *
 * The phone project (`phone.spec.ts`) runs at a phone's viewport, with touch,
 * against a third mock that answers like the phone's core (`MOCK_PHONE=1`),
 * paired with the remote mock, and a UI built for the phone. The web servers
 * start one after another, so the remote mock is up before the phone pairs.
 */
const UI_URL = `http://127.0.0.1:${UI_PORT}`;
const PHONE_UI_URL = `http://127.0.0.1:${PHONE_UI_PORT}`;

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
  projects: [
    { name: 'chromium', testIgnore: /phone\.spec\.ts/ },
    {
      name: 'phone',
      testMatch: /phone\.spec\.ts/,
      use: {
        baseURL: PHONE_UI_URL,
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 2.625,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
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
      command: `pnpm --filter @threadgarden/service mock --remote --remote-port ${REMOTE_MOCK_PORT} --pairing-code ${REMOTE_PAIRING_CODE} --fake-tasmota --fake-tasmota-port ${FAKE_SWITCH_PORT}`,
      // Its own local port and token: never the first mock's. Fixed, so a spec can reach its
      // test-only methods (`remoteCall`).
      env: {
        THREADGARDEN_MOCK_PORT: String(REMOTE_LOCAL_PORT),
        THREADGARDEN_MOCK_TOKEN: REMOTE_LOCAL_TOKEN,
        // Long enough that a slow CI runner still sees each stage of a pretend update
        // (three steps fit well within `expect.timeout`).
        THREADGARDEN_MOCK_UPDATE_STEP_MS: '1500',
      },
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
    {
      // After the remote mock: it pairs with it (never with 47380, a real machine's port).
      command: `pnpm --filter @threadgarden/service mock --pair-port ${REMOTE_MOCK_PORT} --pairing-code ${REMOTE_PAIRING_CODE}`,
      env: {
        MOCK_PHONE: '1',
        THREADGARDEN_MOCK_PORT: String(PHONE_MOCK_PORT),
        THREADGARDEN_MOCK_TOKEN: PHONE_MOCK_TOKEN,
      },
      port: PHONE_MOCK_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
    },
    {
      // After the desktop build, into folders of its own (the preview serves from them).
      command: `pnpm build && pnpm exec vite preview --host 127.0.0.1 --port ${PHONE_UI_PORT} --strictPort`,
      cwd: '..',
      env: {
        VITE_THREADGARDEN_MOCK_URL: `ws://127.0.0.1:${PHONE_MOCK_PORT}`,
        VITE_THREADGARDEN_MOCK_TOKEN: PHONE_MOCK_TOKEN,
        VITE_THREADGARDEN_PHONE: '1',
        THREADGARDEN_UI_OUT: 'build-e2e-phone',
        // Its own SvelteKit output too: `vite preview` serves from there.
        THREADGARDEN_KIT_OUT: '.svelte-kit-phone',
      },
      url: PHONE_UI_URL,
      reuseExistingServer: false,
      timeout: 240_000,
      stdout: 'ignore',
    },
  ],
});
