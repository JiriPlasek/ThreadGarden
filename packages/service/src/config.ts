import path from 'node:path';

export const resolveDataDir = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string => {
  if (env.PAHUB_DATA_DIR) return env.PAHUB_DATA_DIR;
  if (platform === 'win32') {
    return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'pahub');
  }
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'pahub');
  }
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'pahub');
};

export const resolveClaudeConfigDir = (env: NodeJS.ProcessEnv, home: string): string =>
  env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
