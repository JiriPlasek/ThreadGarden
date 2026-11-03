import { mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ProjectNameSchema, type FolderEntry, type FolderListing } from '@threadgarden/protocol';
import { ServiceError } from '../server/router.js';

const MAX_COMPLETIONS = 50;

/** `~` and `~/x` become absolute; anything else is returned unchanged. */
export const expandHome = (p: string, home: string = homedir()): string => {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
};

/** Windows device names: `nul` or `con.txt` there is the device, not a folder. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Why `name` can't be a folder Threadgarden makes, null when it can: the protocol's name rule,
 * and on Windows no device names. `platform` is a seam for tests.
 */
export const nameRefusal = (
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  if (!ProjectNameSchema.safeParse(name).success) {
    return 'Use letters, digits, dots, dashes and underscores only';
  }
  if (platform === 'win32' && WINDOWS_DEVICE.test(name)) return `${name} is reserved on Windows`;
  return null;
};

export const validName = (name: string, platform: NodeJS.Platform = process.platform): boolean =>
  nameRefusal(name, platform) === null;

const absolute = (p: string, home?: string): string => {
  const expanded = expandHome(p, home);
  if (!path.isAbsolute(expanded)) {
    throw new ServiceError('NOT_FOUND', 'Type a full path, or start with ~');
  }
  return expanded;
};

const fsError = (err: unknown): ServiceError => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new ServiceError('NOT_FOUND', 'No such folder');
  if (code === 'ENOTDIR') return new ServiceError('NOT_A_FOLDER', 'Not a folder');
  if (code === 'EACCES' || code === 'EPERM') {
    return new ServiceError('PERMISSION', 'Permission denied');
  }
  return new ServiceError('NOT_FOUND', 'No such folder');
};

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Sub-folders of `dir` (hidden ones only on request), sorted by name. */
const childFolders = async (dir: string, withHidden: boolean): Promise<FolderEntry[]> => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw fsError(err);
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && (withHidden || !e.name.startsWith('.')))
    .sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(
    dirs.map(async (e) => {
      const full = path.join(dir, e.name);
      return { name: e.name, path: full, git: await exists(path.join(full, '.git')) };
    }),
  );
};

export const listFolders = async (p: string, home?: string): Promise<FolderListing> => {
  const dir = path.resolve(absolute(p, home));
  const folders = await childFolders(dir, false);
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, folders };
};

export const completeFolder = async (partial: string, home?: string): Promise<string[]> => {
  // Decided on what was typed: expanding `~/` drops its separator.
  const endsWithSep = partial.endsWith('/') || (path.sep === '\\' && partial.endsWith('\\'));
  const resolved = path.resolve(absolute(partial, home));
  const dir = endsWithSep ? resolved : path.dirname(resolved);
  const prefix = endsWithSep ? '' : path.basename(resolved);
  const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s);
  const folders = await childFolders(dir, prefix.startsWith('.'));
  return folders
    .filter((f) => fold(f.name).startsWith(fold(prefix)))
    .slice(0, MAX_COMPLETIONS)
    .map((f) => f.path);
};

export const makeFolder = async (parent: string, name: string, home?: string): Promise<string> => {
  const refused = nameRefusal(name);
  if (refused) throw new ServiceError('INVALID_NAME', refused);
  const target = path.join(absolute(parent, home), name);
  try {
    await mkdir(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ServiceError('EXISTS', 'A folder with that name already exists');
    }
    throw fsError(err);
  }
  return target;
};

/**
 * A chat moved here into `cwd`: makes the folder that holds it when missing
 * (with its own missing parents), never `cwd` itself (Claude clones into it).
 */
export const makeParentFolder = async (cwd: string): Promise<void> => {
  if (!path.isAbsolute(cwd)) {
    throw new ServiceError('INVALID_PARAMS', 'The folder must be a full path');
  }
  const parent = path.dirname(cwd);
  if (await exists(parent)) return;
  try {
    await mkdir(parent, { recursive: true });
  } catch (err) {
    throw fsError(err);
  }
};
