import path from 'node:path';

/** The data dir's name, and the one pahub (Threadgarden before v1.3) used. */
const DIR_NAME = 'threadgarden';
const LEGACY_DIR_NAME = 'pahub';

export type DataDirs = {
  /** Where the service keeps its data. */
  dataDir: string;
  /**
   * Where pahub kept it: migrated from once (spec v1.3 §9, `migrate-data-dir.ts`).
   * With an override it is the override itself (`pahub.db` → `threadgarden.db` in place).
   */
  legacyDir: string;
  /** A deprecation note to log: the dir came from the legacy `PAHUB_DATA_DIR`. */
  deprecation?: string;
};

const platformDir = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  name: string,
): string => {
  if (platform === 'win32') {
    return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), name);
  }
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', name);
  }
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), name);
};

/**
 * Threadgarden's data dir: `THREADGARDEN_DATA_DIR`, else (deprecated, for one
 * release) `PAHUB_DATA_DIR`, else `threadgarden` in the platform's app data
 * dir. The desktop shell resolves the same dirs itself and passes both to the
 * service it starts (`THREADGARDEN_DATA_DIR`, `THREADGARDEN_LEGACY_DATA_DIR`),
 * so the two never disagree about either.
 */
export const resolveDataDirs = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): DataDirs => {
  const override = env.THREADGARDEN_DATA_DIR;
  if (override)
    return { dataDir: override, legacyDir: env.THREADGARDEN_LEGACY_DATA_DIR || override };
  const legacy = env.PAHUB_DATA_DIR;
  if (legacy) {
    return {
      dataDir: legacy,
      legacyDir: legacy,
      deprecation:
        'PAHUB_DATA_DIR is deprecated and will be ignored in a later release: set THREADGARDEN_DATA_DIR instead',
    };
  }
  return {
    dataDir: platformDir(env, platform, home, DIR_NAME),
    legacyDir: platformDir(env, platform, home, LEGACY_DIR_NAME),
  };
};

export const resolveClaudeConfigDir = (env: NodeJS.ProcessEnv, home: string): string =>
  env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
