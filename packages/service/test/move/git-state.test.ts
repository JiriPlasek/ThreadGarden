import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitState } from '../../src/move/git-state.js';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      '-c',
      'core.autocrlf=false',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );

describe.skipIf(!hasGit)('gitState', () => {
  let root: string;
  let repo: string;
  let bare: string;

  const commit = (file: string, text: string) => {
    writeFileSync(join(repo, file), text);
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', `edit ${file}`);
  };

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-gitstate-')));
    bare = join(root, 'remote.git');
    repo = join(root, 'work');
    mkdirSync(bare);
    git(bare, 'init', '--bare', '--initial-branch=main');
    mkdirSync(repo);
    git(repo, 'init', '--initial-branch=main');
    commit('a.txt', 'a\n');
    commit('b.txt', 'b\n');
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-u', 'origin', 'main');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('clean repo on main with upstream: clean, branch main, origin url', async () => {
    expect(await gitState(repo)).toEqual({ kind: 'clean', branch: 'main', origin: bare });
  });

  it('two changed files and one untracked: dirty, changed 3', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    writeFileSync(join(repo, 'b.txt'), 'changed\n');
    writeFileSync(join(repo, 'new.txt'), 'x');
    expect(await gitState(repo)).toEqual({
      kind: 'dirty',
      branch: 'main',
      origin: bare,
      changed: 3,
      unpushed: 0,
    });
  });

  it('two commits ahead of upstream: unpushed 2', async () => {
    commit('a.txt', '1\n');
    commit('a.txt', '2\n');
    expect(await gitState(repo)).toMatchObject({ kind: 'dirty', changed: 0, unpushed: 2 });
  });

  it('branch with no upstream and one commit on no remote: unpushed 1', async () => {
    git(repo, 'checkout', '-b', 'fix/usage');
    commit('a.txt', 'new\n');
    expect(await gitState(repo)).toEqual({
      kind: 'dirty',
      branch: 'fix/usage',
      origin: bare,
      changed: 0,
      unpushed: 1,
    });
  });

  it('a detached HEAD has no branch', async () => {
    git(repo, 'checkout', '--detach');
    expect(await gitState(repo)).toEqual({ kind: 'clean', branch: null, origin: bare });
  });

  it('a repo without a remote has origin null', async () => {
    git(repo, 'remote', 'remove', 'origin');
    expect(await gitState(repo)).toMatchObject({ origin: null });
  });

  it('plain folder: notRepo', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(await gitState(plain)).toEqual({ kind: 'notRepo' });
  });

  it('missing folder: notRepo', async () => {
    expect(await gitState(join(root, 'nope'))).toEqual({ kind: 'notRepo' });
  });
});
