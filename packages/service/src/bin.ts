/**
 * The service's executable entry point (`node service.mjs`, bundled from here
 * by `scripts/build.mjs`; `pnpm dev` in development): starts the real service
 * for the user's data dir. Kept apart from `main.ts`, so bundles and tests
 * that import `startService` never start a second, real service — in a bundle
 * every module shares one `import.meta.url`, so an "am I the entry?" check
 * inside `main.ts` would fire there too.
 */
import os from 'node:os';
import { resolveClaudeConfigDir, resolveDataDirs } from './config.js';
import { installCrashGuards } from './crash-guard.js';
import { createLogger } from './logger.js';
import { startService } from './main.js';
import { findInstalledClaude } from './sdk/claude-path.js';
import { RealAdapter } from './sdk/real-adapter.js';

const home = os.homedir();
const { dataDir, legacyDir, deprecation } = resolveDataDirs(process.env, process.platform, home);
const logger = createLogger(dataDir);
// Installed first, so even a failure during startup is logged rather than fatal.
installCrashGuards(process, { log: logger, exit: (code) => process.exit(code) });
if (deprecation) logger.warn(deprecation);

startService({
  dataDir,
  // Spec v1.3 §9: pahub's database is copied over once.
  legacyDataDir: legacyDir,
  claudeConfigDir: resolveClaudeConfigDir(process.env, home),
  adapter: new RealAdapter(),
  locateClaude: findInstalledClaude,
  logger,
  // Spec §5.5. `scripts/build.mjs` bakes the build-time value into the bundle,
  // so a release build's policy cannot be changed through the environment.
  apiKeyOnly: process.env.PAHUB_API_KEY_ONLY === '1',
})
  .then((svc) => svc.onClosed(() => process.exit(0)))
  .catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // Nobody reads a detached service's stderr: the log is where this shows.
    logger.error(`start failed: ${message}`);
    await logger.flush();
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
