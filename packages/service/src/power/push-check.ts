import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Unpushed } from '@threadgarden/protocol';

type Git = (args: string[], cwd: string) => Promise<string>;

/** A git failure with a short plain reason that is safe to show. */
class GitFailure extends Error {
  constructor(
    readonly reason: string,
    readonly notRepo: boolean,
  ) {
    super(reason);
  }
}

const reasonOf = (e: unknown): string => (e instanceof GitFailure ? e.reason : 'git failed');

/**
 * The environment git runs in: no repository forced on it from outside, and the C
 * locale, so the messages matched below are English in any language.
 */
export const cleanEnv = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...base, LC_ALL: 'C', LANGUAGE: '' };
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete env[k];
  return env;
};

const defaultGit: Git = (args, cwd) =>
  new Promise((res, rej) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: 10000,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: cleanEnv(),
      },
      (err, stdout, stderr) => {
        if (!err) return res(stdout);
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
        const text = String(stderr ?? '');
        if (/not a git repository/i.test(text))
          return rej(new GitFailure('not a git repository', true));
        if (/dubious ownership/i.test(text))
          return rej(new GitFailure('git refused: dubious ownership', false));
        if (e.killed) return rej(new GitFailure('git timed out', false));
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
          return rej(new GitFailure('git output too large', false));
        if (e.code === 'ENOENT') return rej(new GitFailure('git is not installed', false));
        rej(new GitFailure('git failed', false));
      },
    );
  });

/** Entries in `status --porcelain=v1 -z`; a rename or copy carries its original path as an extra field. */
const countStatusEntries = (out: string): number => {
  const fields = out.split('\0');
  let n = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length === 0) continue;
    n++;
    if (f[0] === 'R' || f[0] === 'C' || f[1] === 'R' || f[1] === 'C') i++;
  }
  return n;
};

const HEADS = 'refs/heads/';

type Seen = { shared: Set<string> };

const checkRepo = async (
  top: string,
  sessionId: string | null,
  git: Git,
  seen: Seen,
): Promise<Unpushed[]> => {
  const found: Unpushed[] = [];
  let trouble: string | null = null;
  const attempt = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      trouble ??= reasonOf(e);
    }
  };
  const add = (f: Omit<Unpushed, 'repo' | 'sessionId' | 'reason'> & { reason?: string }): void => {
    found.push({ repo: top, sessionId, reason: null, ...f });
  };

  let remotes: string;
  try {
    remotes = await git(['remote'], top);
  } catch (e) {
    return [
      { repo: top, branch: null, kind: 'unchecked', count: 0, sessionId, reason: reasonOf(e) },
    ];
  }
  if (!remotes.trim()) return found; // local only: plan 2 handles it

  await attempt(async () => {
    const entries = countStatusEntries(
      await git(
        ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'],
        top,
      ),
    );
    if (entries > 0) add({ branch: null, kind: 'uncommitted', count: entries });
  });

  // Detached HEAD: commits reachable only from HEAD are lost once it moves on.
  await attempt(async () => {
    let detached = false;
    try {
      await git(['symbolic-ref', '-q', 'HEAD'], top);
    } catch {
      detached = true;
    }
    if (!detached) return;
    const count = Number.parseInt(
      (await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], top)).trim(),
      10,
    );
    if (Number.isNaN(count)) throw new GitFailure('git failed', false);
    if (count > 0) add({ branch: null, kind: 'unpushed', count });
  });

  // Branches and stashes are shared by all worktrees of a repository: report them once.
  let common: string;
  try {
    common = resolve(top, (await git(['rev-parse', '--git-common-dir'], top)).trim());
  } catch (e) {
    trouble ??= reasonOf(e);
    common = top;
  }
  if (!seen.shared.has(common)) {
    seen.shared.add(common);
    await attempt(async () => {
      const branches = (await git(['for-each-ref', '--format=%(refname)', 'refs/heads'], top))
        .split('\n')
        .map((b) => b.trim())
        .filter((b) => b.startsWith(HEADS));
      for (const ref of branches) {
        await attempt(async () => {
          const count = Number.parseInt(
            (await git(['rev-list', '--count', ref, '--not', '--remotes'], top)).trim(),
            10,
          );
          if (Number.isNaN(count)) throw new GitFailure('git failed', false);
          if (count > 0) add({ branch: ref.slice(HEADS.length), kind: 'unpushed', count });
        });
      }
    });
    await attempt(async () => {
      const stashes = (await git(['stash', 'list'], top))
        .split('\n')
        .filter((l) => l.trim()).length;
      if (stashes > 0)
        add({ branch: null, kind: 'uncommitted', count: stashes, reason: 'stashed changes' });
    });
  }

  if (trouble !== null) add({ branch: null, kind: 'unchecked', count: 0, reason: trouble });
  return found;
};

/**
 * Finds work in the given directories (newest first) that never reached a remote. A missing
 * directory or one that is not a repository is skipped; any other git trouble is reported as
 * 'unchecked' so that trouble is never mistaken for a clean repository.
 */
export const checkUnpushed = async (
  dirs: { cwd: string; sessionId: string | null }[],
  o: { git?: Git } = {},
): Promise<Unpushed[]> => {
  const git = o.git ?? defaultGit;
  const result: Unpushed[] = [];
  const tops = new Map<string, string | null>();
  const failed = new Set<string>();
  for (const { cwd, sessionId } of dirs) {
    try {
      const top = resolve((await git(['rev-parse', '--show-toplevel'], cwd)).trim());
      if (!tops.has(top)) tops.set(top, sessionId);
    } catch (e) {
      if (e instanceof GitFailure && e.notRepo) continue;
      if (!existsSync(cwd)) continue;
      const key = resolve(cwd);
      if (!failed.has(key)) {
        failed.add(key);
        result.push({
          repo: key,
          branch: null,
          kind: 'unchecked',
          count: 0,
          sessionId,
          reason: reasonOf(e),
        });
      }
    }
  }
  const seen: Seen = { shared: new Set() };
  for (const [top, sessionId] of tops) result.push(...(await checkRepo(top, sessionId, git, seen)));
  return result;
};
