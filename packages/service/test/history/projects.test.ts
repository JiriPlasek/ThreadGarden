import { describe, expect, it } from 'vitest';
import { displayNames, projectIdFor } from '../../src/history/projects.js';

const none = () => null;

describe('projectIdFor', () => {
  it('groups C:\\Repo and c:\\repo\\ as one project', () => {
    expect(projectIdFor('C:\\Repo', 'win32', none)).toBe(projectIdFor('c:\\repo\\', 'win32', none));
  });

  it('strips trailing separators on posix', () => {
    expect(projectIdFor('/a/b/', 'linux', none)).toBe('/a/b');
  });

  it('groups worktrees under their repository', () => {
    const common = (cwd: string) => (cwd.includes('wt') ? '/work/repo/.git' : '/work/repo/.git');
    expect(projectIdFor('/work/repo-wt/feature', 'linux', common)).toBe('/work/repo');
    expect(projectIdFor('/work/repo', 'linux', common)).toBe('/work/repo');
  });

  it('groups worktrees on win32', () => {
    const common = () => 'C:\\Repo\\.git';
    expect(projectIdFor('D:\\wt\\x', 'win32', common)).toBe('c:\\repo');
  });

  it('falls back to the normalised input when the path does not exist', () => {
    expect(projectIdFor('/definitely/not/here/', process.platform, none)).toBe(
      process.platform === 'win32' ? '\\definitely\\not\\here' : '/definitely/not/here',
    );
  });
});

describe('displayNames', () => {
  it('display names disambiguate equal basenames', () => {
    const names = displayNames([
      { projectId: 'a', path: '/work/alpha/app' },
      { projectId: 'b', path: '/work/beta/app' },
      { projectId: 'c', path: '/work/solo' },
    ]);
    expect(names.get('a')).toBe('alpha/app');
    expect(names.get('b')).toBe('beta/app');
    expect(names.get('c')).toBe('solo');
  });
});
