/**
 * The service's executable entry point (`node service.mjs`, bundled from here
 * by `scripts/build.mjs`; `pnpm dev` in development): starts the real service
 * for the user's data dir. Kept apart from `main.ts`, so bundles and tests
 * that import `startService` never start a second, real service — in a bundle
 * every module shares one `import.meta.url`, so an "am I the entry?" check
 * inside `main.ts` would fire there too.
 */
import os from 'node:os';
import { resolveClaudeConfigDir, resolveDataDir } from './config.js';
import { startService } from './main.js';
import { findInstalledClaude } from './sdk/claude-path.js';
import { RealAdapter } from './sdk/real-adapter.js';

const home = os.homedir();
startService({
  dataDir: resolveDataDir(process.env, process.platform, home),
  claudeConfigDir: resolveClaudeConfigDir(process.env, home),
  adapter: new RealAdapter(),
  locateClaude: findInstalledClaude,
})
  .then((svc) => svc.onClosed(() => process.exit(0)))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
