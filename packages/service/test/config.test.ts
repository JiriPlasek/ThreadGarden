import { describe, expect, it } from 'vitest';
import { resolveClaudeConfigDir, resolveDataDir } from '../src/config.js';

describe('resolveDataDir', () => {
  it('returns %APPDATA%\\pahub on win32', () => {
    expect(
      resolveDataDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a'),
    ).toBe('C:\\Users\\a\\AppData\\Roaming\\pahub');
  });
  it('returns the Library path on darwin', () => {
    expect(resolveDataDir({}, 'darwin', '/Users/a')).toBe(
      '/Users/a/Library/Application Support/pahub',
    );
  });
  it('returns the XDG path on linux', () => {
    expect(resolveDataDir({ XDG_DATA_HOME: '/x' }, 'linux', '/home/a')).toBe('/x/pahub');
    expect(resolveDataDir({}, 'linux', '/home/a')).toBe('/home/a/.local/share/pahub');
  });
  it('honours the PAHUB_DATA_DIR override', () => {
    expect(resolveDataDir({ PAHUB_DATA_DIR: '/custom' }, 'linux', '/home/a')).toBe('/custom');
  });
});

describe('resolveClaudeConfigDir', () => {
  it('prefers CLAUDE_CONFIG_DIR', () => {
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/c' }, '/home/a')).toBe('/c');
  });
  it('falls back to home/.claude', () => {
    expect(resolveClaudeConfigDir({}, '/home/a')).toMatch(/[\\/]home[\\/]a[\\/]\.claude$/);
  });
});
