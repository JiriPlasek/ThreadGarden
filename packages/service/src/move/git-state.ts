/**
 * What a chat's folder looks like in git, read-only (`status`, `rev-parse`,
 * `rev-list`, `config --get`): the source side of `move.check`. Reuses the
 * push check's git runner; its behaviour is its own.
 */
import { existsSync } from 'node:fs';
import type { GitState } from '@threadgarden/protocol';
import { countStatusEntries, defaultGit, type Git } from '../power/push-check.js';

const count = async (git: Git, args: string[], cwd: string): Promise<number> => {
  const n = Number.parseInt((await git(args, cwd)).trim(), 10);
  if (Number.isNaN(n)) throw new Error('git failed');
  return n;
};

/** The folder's git state. A missing folder, or one that is not a work tree, is `notRepo`. */
export const gitState = async (cwd: string, git: Git = defaultGit): Promise<GitState> => {
  if (!existsSync(cwd)) return { kind: 'notRepo' };
  try {
    if ((await git(['rev-parse', '--is-inside-work-tree'], cwd)).trim() !== 'true') {
      return { kind: 'notRepo' };
    }
  } catch {
    return { kind: 'notRepo' };
  }

  // A detached HEAD has no branch name.
  const branch = await git(['symbolic-ref', '-q', '--short', 'HEAD'], cwd)
    .then((s) => s.trim() || null)
    .catch(() => null);
  const origin = await git(['config', '--get', 'remote.origin.url'], cwd)
    .then((s) => s.trim() || null)
    .catch(() => null);

  const changed = countStatusEntries(
    await git(
      ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=normal'],
      cwd,
    ),
  );
  const hasUpstream = await git(['rev-parse', '--abbrev-ref', '@{u}'], cwd).then(
    () => true,
    () => false,
  );
  // A repository without commits has nothing to push.
  const unpushed = await count(
    git,
    hasUpstream
      ? ['rev-list', '--count', '@{u}..HEAD']
      : ['rev-list', '--count', 'HEAD', '--not', '--remotes'],
    cwd,
  ).catch(() => 0);

  return changed === 0 && unpushed === 0
    ? { kind: 'clean', branch, origin }
    : { kind: 'dirty', branch, origin, changed, unpushed };
};
