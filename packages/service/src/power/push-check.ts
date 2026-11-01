import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { Unpushed } from '@threadgarden/protocol';

type Git = (args: string[], cwd: string) => Promise<string>;

const defaultGit: Git = (args, cwd) =>
  new Promise((res, rej) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 10000, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => (err ? rej(err) : res(stdout)),
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

const checkRepo = async (top: string, sessionId: string | null, git: Git): Promise<Unpushed[]> => {
  const found: Unpushed[] = [];
  if (!(await git(['remote'], top)).trim()) return found; // local only: plan 2 handles it
  const entries = countStatusEntries(
    await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], top),
  );
  if (entries > 0) found.push({ repo: top, branch: null, kind: 'uncommitted', count: entries, sessionId });
  const branches = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], top))
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean);
  for (const branch of branches) {
    const count = Number.parseInt(
      (await git(['rev-list', '--count', `refs/heads/${branch}`, '--not', '--remotes'], top)).trim(),
      10,
    );
    if (count > 0) found.push({ repo: top, branch, kind: 'unpushed', count, sessionId });
  }
  return found;
};

/**
 * Finds work in the given directories (newest first) that never reached a remote. A directory
 * where git fails or that is missing is skipped, never fatal.
 */
export const checkUnpushed = async (
  dirs: { cwd: string; sessionId: string | null }[],
  o: { git?: Git } = {},
): Promise<Unpushed[]> => {
  const git = o.git ?? defaultGit;
  const tops = new Map<string, string | null>();
  for (const { cwd, sessionId } of dirs) {
    try {
      const top = resolve((await git(['rev-parse', '--show-toplevel'], cwd)).trim());
      if (!tops.has(top)) tops.set(top, sessionId);
    } catch {
      // not a repository, or the directory is gone
    }
  }
  const result: Unpushed[] = [];
  for (const [top, sessionId] of tops) {
    try {
      result.push(...(await checkRepo(top, sessionId, git)));
    } catch {
      // skip this repository
    }
  }
  return result;
};
