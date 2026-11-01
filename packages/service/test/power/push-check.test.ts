import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkUnpushed } from '../../src/power/push-check.js';

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

describe.skipIf(!hasGit)('checkUnpushed', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-push-')));
    const bare = join(root, 'remote.git');
    repo = join(root, 'work');
    mkdirSync(bare);
    git(bare, 'init', '--bare', '--initial-branch=main');
    mkdirSync(repo);
    git(repo, 'init', '--initial-branch=main');
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-u', 'origin', 'main');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const check = (...cwds: string[]) =>
    checkUnpushed(cwds.map((cwd, i) => ({ cwd, sessionId: `s${i}` })));

  it('a clean pushed clone has nothing', async () => {
    expect(await check(repo)).toEqual([]);
  });

  it('an untracked file is uncommitted work', async () => {
    writeFileSync(join(repo, 'new.txt'), 'x');
    expect(await check(repo)).toEqual([
      { repo, branch: null, kind: 'uncommitted', count: 1, sessionId: 's0' },
    ]);
  });

  it('an ignored file is not work', async () => {
    writeFileSync(join(repo, 'ignored.txt'), 'x');
    expect(await check(repo)).toEqual([]);
  });

  it('a local commit that was not pushed is reported', async () => {
    writeFileSync(join(repo, 'a.txt'), 'b\n');
    git(repo, 'commit', '-am', 'more');
    expect(await check(repo)).toEqual([
      { repo, branch: 'main', kind: 'unpushed', count: 1, sessionId: 's0' },
    ]);
  });

  it('a new branch without upstream is reported', async () => {
    git(repo, 'checkout', '-b', 'feature');
    writeFileSync(join(repo, 'f.txt'), 'f\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'f');
    const r = await check(repo);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ branch: 'feature', kind: 'unpushed', count: 1 });
  });

  it('a repo with no remote is skipped', async () => {
    const local = join(root, 'local');
    mkdirSync(local);
    git(local, 'init', '--initial-branch=main');
    writeFileSync(join(local, 'x.txt'), 'x');
    expect(await check(local)).toEqual([]);
  });

  it('a missing directory is skipped', async () => {
    expect(await check(join(root, 'nope'))).toEqual([]);
  });

  it('subdirectories of one repo count once, with the newest session', async () => {
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'new.txt'), 'x');
    const r = await check(join(repo, 'sub'), repo);
    expect(r).toHaveLength(1);
    expect(r[0]!.sessionId).toBe('s0');
  });

  it('a rename counts as one entry', async () => {
    git(repo, 'mv', 'a.txt', 'b.txt');
    const r = await check(repo);
    expect(r).toMatchObject([{ kind: 'uncommitted', count: 1 }]);
  });

  it('a git failure skips only that directory', async () => {
    writeFileSync(join(repo, 'new.txt'), 'x');
    const r = await checkUnpushed(
      [
        { cwd: 'bad', sessionId: null },
        { cwd: repo, sessionId: null },
      ],
      {
        git: async (args, cwd) => {
          if (cwd === 'bad') throw new Error('boom');
          return git(cwd, ...args);
        },
      },
    );
    expect(r).toHaveLength(1);
  });
});
