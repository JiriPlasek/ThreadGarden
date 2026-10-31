import { describe, expect, it } from 'vitest';
import { resolveClaudeConfigDir, resolveDataDirs } from '../src/config.js';

describe('resolveDataDirs', () => {
  it('returns %APPDATA%\\threadgarden on win32, and pahub as the legacy dir', () => {
    expect(
      resolveDataDirs({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a'),
    ).toEqual({
      dataDir: 'C:\\Users\\a\\AppData\\Roaming\\threadgarden',
      legacyDir: 'C:\\Users\\a\\AppData\\Roaming\\pahub',
    });
    expect(resolveDataDirs({}, 'win32', 'C:\\Users\\a').dataDir).toBe(
      'C:\\Users\\a\\AppData\\Roaming\\threadgarden',
    );
  });
  it('returns the Library paths on darwin', () => {
    expect(resolveDataDirs({}, 'darwin', '/Users/a')).toEqual({
      dataDir: '/Users/a/Library/Application Support/threadgarden',
      legacyDir: '/Users/a/Library/Application Support/pahub',
    });
  });
  it('returns the XDG paths on linux', () => {
    expect(resolveDataDirs({ XDG_DATA_HOME: '/x' }, 'linux', '/home/a')).toEqual({
      dataDir: '/x/threadgarden',
      legacyDir: '/x/pahub',
    });
    expect(resolveDataDirs({}, 'linux', '/home/a')).toEqual({
      dataDir: '/home/a/.local/share/threadgarden',
      legacyDir: '/home/a/.local/share/pahub',
    });
  });
  it('honours the THREADGARDEN_DATA_DIR override, which is its own legacy dir', () => {
    expect(resolveDataDirs({ THREADGARDEN_DATA_DIR: '/custom' }, 'linux', '/home/a')).toEqual({
      dataDir: '/custom',
      legacyDir: '/custom',
    });
  });
  it('takes the legacy dir the desktop shell passes along with the override', () => {
    expect(
      resolveDataDirs(
        { THREADGARDEN_DATA_DIR: '/d/threadgarden', THREADGARDEN_LEGACY_DATA_DIR: '/d/pahub' },
        'linux',
        '/home/a',
      ),
    ).toEqual({ dataDir: '/d/threadgarden', legacyDir: '/d/pahub' });
  });
  it('still honours the deprecated PAHUB_DATA_DIR, with a deprecation note', () => {
    const dirs = resolveDataDirs({ PAHUB_DATA_DIR: '/old' }, 'linux', '/home/a');
    expect(dirs).toMatchObject({ dataDir: '/old', legacyDir: '/old' });
    expect(dirs.deprecation).toMatch(/PAHUB_DATA_DIR is deprecated.*THREADGARDEN_DATA_DIR/);
  });
  it('prefers THREADGARDEN_DATA_DIR over PAHUB_DATA_DIR; empty values count as unset', () => {
    expect(
      resolveDataDirs({ THREADGARDEN_DATA_DIR: '/new', PAHUB_DATA_DIR: '/old' }, 'linux', '/h'),
    ).toEqual({ dataDir: '/new', legacyDir: '/new' });
    expect(
      resolveDataDirs({ THREADGARDEN_DATA_DIR: '', PAHUB_DATA_DIR: '' }, 'linux', '/h').dataDir,
    ).toBe('/h/.local/share/threadgarden');
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
