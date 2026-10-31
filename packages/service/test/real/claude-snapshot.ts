/**
 * Read-only check for the real suite: a snapshot (size, mtime, SHA-256) of
 * every file under the real Claude config dir's `projects/`, and a comparison
 * that tolerates only what other running Claude Code sessions do meanwhile.
 *
 * The real `claude` needs the user's real login, so the real suite cannot
 * point `CLAUDE_CONFIG_DIR` at a temp dir; other Claude Code sessions on the
 * machine (including the one running this suite) keep appending to their own
 * transcripts while it runs. A change is therefore tolerated only when the
 * file was already active (modified shortly before the run) and only grew
 * (its old content is an unchanged prefix), and a new file only inside a
 * project directory that was already active. Everything else must be
 * byte-for-byte, size and mtime identical.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

export type FileEntry = { size: number; mtimeMs: number; hash: string };
/** Path relative to the snapshot root → entry. */
export type Snapshot = Map<string, FileEntry>;

const hashFile = (file: string, bytes?: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const stream =
      bytes === undefined
        ? createReadStream(file)
        : bytes === 0
          ? null
          : createReadStream(file, { start: 0, end: bytes - 1 });
    if (!stream) {
      resolve(h.digest('hex'));
      return;
    }
    stream.on('data', (d) => h.update(d));
    stream.on('error', reject);
    stream.on('end', () => resolve(h.digest('hex')));
  });

/** Every regular file under `root` (missing root → empty), skipping paths `skip` accepts. */
export const snapshotTree = async (
  root: string,
  skip: (rel: string) => boolean = () => false,
): Promise<Snapshot> => {
  const out: Snapshot = new Map();
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      if (skip(rel)) continue;
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue; // removed while walking (another session's temp file)
      }
      if (st.isDirectory()) await walk(full);
      else if (st.isFile()) {
        out.set(rel, { size: st.size, mtimeMs: st.mtimeMs, hash: await hashFile(full) });
      }
    }
  };
  await walk(root);
  return out;
};

/** One file (missing → undefined). */
export const snapshotFile = async (file: string): Promise<FileEntry | undefined> => {
  try {
    const st = await lstat(file);
    return { size: st.size, mtimeMs: st.mtimeMs, hash: await hashFile(file) };
  } catch {
    return undefined;
  }
};

const topDir = (rel: string): string => rel.split(path.sep)[0] ?? rel;

export type Comparison = {
  /** Changes nothing but Threadgarden could explain; must be empty. */
  violations: string[];
  /** Files of already-active sessions that only grew. */
  appended: string[];
  /** New files inside already-active project directories. */
  added: string[];
};

/**
 * Compares `before` with the tree as it is now. `activeSince`: files modified
 * at or after this time (ms) before the run count as another session's.
 */
export const compareTree = async (
  root: string,
  before: Snapshot,
  after: Snapshot,
  activeSince: number,
): Promise<Comparison> => {
  const violations: string[] = [];
  const appended: string[] = [];
  const added: string[] = [];
  const activeDirs = new Set(
    [...before].filter(([, e]) => e.mtimeMs >= activeSince).map(([rel]) => topDir(rel)),
  );
  for (const [rel, old] of before) {
    const now = after.get(rel);
    if (!now) {
      violations.push(`deleted: ${rel}`);
      continue;
    }
    if (now.size === old.size && now.mtimeMs === old.mtimeMs && now.hash === old.hash) continue;
    const grewOnly =
      old.mtimeMs >= activeSince &&
      now.size >= old.size &&
      (await hashFile(path.join(root, rel), old.size)) === old.hash;
    if (grewOnly) appended.push(rel);
    else violations.push(`changed: ${rel} (${old.size} → ${now.size} bytes)`);
  }
  for (const rel of after.keys()) {
    if (before.has(rel)) continue;
    if (activeDirs.has(topDir(rel))) added.push(rel);
    else violations.push(`created: ${rel}`);
  }
  return { violations, appended, added };
};
