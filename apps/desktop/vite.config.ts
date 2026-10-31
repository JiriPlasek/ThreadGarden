import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// Tauri serves the static build; `tauri dev` loads the Vite dev server on this fixed port.
const DEV_PORT = 1420;

/**
 * `THREADGARDEN_API_KEY_ONLY=1` makes an API-key-only build (spec §5.5); the
 * legacy `PAHUB_API_KEY_ONLY=1` still does for one release (spec v1.3 §9).
 */
const apiKeyOnlyBuild = (): boolean => {
  const legacy = process.env.PAHUB_API_KEY_ONLY;
  if (legacy) {
    console.warn(
      'PAHUB_API_KEY_ONLY is deprecated and will be ignored in a later release: set THREADGARDEN_API_KEY_ONLY instead',
    );
  }
  return process.env.THREADGARDEN_API_KEY_ONLY === '1' || legacy === '1';
};

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Runes mode everywhere except libraries.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
      },
      // A static SPA: every route falls back to index.html (no server, no SSR).
      // `THREADGARDEN_UI_OUT` lets the Playwright build (mock address baked in) go elsewhere.
      adapter: adapter({
        pages: process.env.THREADGARDEN_UI_OUT ?? 'build',
        assets: process.env.THREADGARDEN_UI_OUT ?? 'build',
        fallback: 'index.html',
      }),
      // The workspace protocol package from its source (its package.json entry),
      // so the pnpm link in node_modules is never followed: some sandboxed and
      // agent environments on Windows cannot follow links. Also sets tsconfig paths.
      alias: { '@threadgarden/protocol': '../../packages/protocol/src/index.ts' },
    }),
  ],
  // Build flags (see src/lib/build-flags.ts): baked in at build time.
  define: {
    __THREADGARDEN_API_KEY_ONLY__: JSON.stringify(apiKeyOnlyBuild()),
  },
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
