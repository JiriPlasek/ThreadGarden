import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';

/** The files a throwaway Codex home needs from the real one: the login and the config. */
const CARRIED = ['auth.json', 'config.toml'];

/**
 * Runs this file's tests against a throwaway `CODEX_HOME` holding a copy of the
 * user's login (and config), so the threads they start never land in the user's
 * real Codex history. Removed afterwards. `THREADGARDEN_TEST_CODEX_REAL_HOME=1`
 * keeps the real home, e.g. to look at a failed run in the Codex app.
 */
export const useThrowawayCodexHome = (): void => {
  if (process.env.THREADGARDEN_TEST_CODEX_REAL_HOME === '1') return;
  let home: string | undefined;
  let previous: string | undefined;
  beforeAll(async () => {
    const real = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    home = await mkdtemp(path.join(os.tmpdir(), 'tg-codex-home-'));
    for (const name of CARRIED) {
      const from = path.join(real, name);
      if (existsSync(from)) await copyFile(from, path.join(home, name));
    }
    previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    if (home) await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
};
