import fs from 'node:fs';
import path from 'node:path';

export type GitCommonDir = (cwd: string) => string | null;

const flavor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

const stripTrailing = (p: string, platform: NodeJS.Platform): string => {
  const root = flavor(platform).parse(p).root;
  let out = p;
  while (out.length > root.length && (out.endsWith('\\') || out.endsWith('/'))) {
    out = out.slice(0, -1);
  }
  return out;
};

/**
 * Normalised real path of `cwd` (case preserved): symlinks resolved when the
 * path exists and `platform` is the host (a vanished directory falls back to
 * the normalised input), drive letter lower-cased on win32, no trailing separator.
 */
export const normalizeCwd = (cwd: string, platform: NodeJS.Platform = process.platform): string => {
  const p = flavor(platform);
  let out = p.normalize(cwd);
  if (platform === process.platform) {
    try {
      out = fs.realpathSync.native(out);
    } catch {
      // path no longer exists: keep the normalised input
    }
  }
  out = stripTrailing(p.normalize(out), platform);
  if (platform === 'win32') out = out.replace(/^[A-Za-z]:/, (d) => d.toLowerCase());
  return out;
};

/** Project path (case preserved) for `cwd`, after worktree mapping. */
export const projectPathFor = (
  cwd: string,
  platform: NodeJS.Platform,
  gitCommonDir: GitCommonDir,
): string => {
  const real = normalizeCwd(cwd, platform);
  let common: string | null;
  try {
    common = gitCommonDir(real);
  } catch {
    common = null;
  }
  if (!common) return real;
  return normalizeCwd(flavor(platform).dirname(common), platform);
};

/**
 * Stable project id for a working directory. Git worktrees map to their
 * repository's main worktree (the parent of the common `.git` dir). On win32
 * the whole id is lower-cased because the file system is case-insensitive
 * (`C:\Repo` and `c:\repo\` are one project); `projectPathFor` keeps the case.
 */
export const projectIdFor = (
  cwd: string,
  platform: NodeJS.Platform,
  gitCommonDir: GitCommonDir,
): string => {
  const root = projectPathFor(cwd, platform, gitCommonDir);
  return platform === 'win32' ? root.toLowerCase() : root;
};

/**
 * Default `gitCommonDir`: walks up from `cwd` to the nearest `.git`, read-only.
 * A `.git` directory is the common dir; a `.git` file (`gitdir: <repo>/.git/worktrees/<n>`)
 * resolves via that dir's `commondir` file, else two levels up.
 */
export const defaultGitCommonDir: GitCommonDir = (cwd) => {
  let dir = cwd;
  for (;;) {
    const dotGit = path.join(dir, '.git');
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) return dotGit;
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!m?.[1]) return null;
      const gitdir = path.resolve(dir, m[1].trim());
      try {
        const rel = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
        return path.resolve(gitdir, rel);
      } catch {
        return path.resolve(gitdir, '..', '..');
      }
    } catch {
      // no .git here
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

const flavorOf = (p: string) => (/^[A-Za-z]:[\\/]|\\/.test(p) ? path.win32 : path.posix);

/** Basename per project; projects whose basenames collide get `parent/base`. */
export const displayNames = (
  projects: { projectId: string; path: string }[],
): Map<string, string> => {
  const base = (p: string) => flavorOf(p).basename(p) || p;
  const counts = new Map<string, number>();
  for (const p of projects) {
    const b = base(p.path).toLowerCase();
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const p of projects) {
    const f = flavorOf(p.path);
    const b = base(p.path);
    const parent = f.basename(f.dirname(p.path));
    const collide = (counts.get(b.toLowerCase()) ?? 0) > 1;
    out.set(p.projectId, collide && parent ? `${parent}/${b}` : b);
  }
  return out;
};
