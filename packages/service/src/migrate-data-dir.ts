/**
 * The one-time move of pahub's data to Threadgarden's (spec v1.3 §9). Before
 * v1.3 the service kept `pahub.db` in a `pahub` data dir; now it keeps
 * `threadgarden.db` in a `threadgarden` one (with an override dir: both files
 * in that one dir). At start, before the service takes its own lock:
 *
 * - `threadgarden.db` exists: nothing to do (already migrated, or a new install).
 * - No `pahub.db` either: a fresh install, nothing to do.
 * - Otherwise the old dir's lock is taken, so no pahub service can run (or
 *   start) during the copy; if a live one holds it, the start fails with
 *   `LegacyServiceRunningError` rather than run on an empty database.
 *   `pahub.db` is copied with SQLite `VACUUM INTO` to a temporary name in the
 *   new dir, which is renamed to `threadgarden.db` only once complete: a
 *   half-done copy is never used. The old dir keeps everything it had (logs,
 *   `service.json` and the lock are not copied) and gains a short
 *   `MOVED-TO-THREADGARDEN.txt`.
 */
import './history/sqlite-warning.js';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireInstanceLock } from './discovery.js';

export const DB_FILE = 'threadgarden.db';
export const LEGACY_DB_FILE = 'pahub.db';
export const MOVED_NOTE_FILE = 'MOVED-TO-THREADGARDEN.txt';
/** Temporary copies are named `threadgarden.db.migrating-<pid>-<random>`. */
const TEMP_PREFIX = `${DB_FILE}.migrating-`;

/** A pahub service still holds the old data dir: migrating now would miss its latest writes. */
export class LegacyServiceRunningError extends Error {
  constructor(readonly legacyDir: string) {
    super(
      `An older pahub service is still running for ${legacyDir}: restart the service from ` +
        'Threadgarden, or quit pahub completely, and Threadgarden moves its data over as it starts.',
    );
    this.name = 'LegacyServiceRunningError';
  }
}

export type MigrationResult =
  /** `threadgarden.db` was there already. */
  | 'current'
  /** Neither database exists: a new install. */
  | 'fresh'
  /** `pahub.db` was copied to `threadgarden.db`. */
  | 'migrated';

export type MigrateOptions = {
  dataDir: string;
  /** pahub's data dir; the same dir as `dataDir` with an override. */
  legacyDir: string;
  /** Writes a complete, consistent copy of the database `from` to the new file `to`. Default `vacuumInto`. */
  copy?: (from: string, to: string) => void | Promise<void>;
  log?: (msg: string) => void;
};

/** SQLite's own online copy: a consistent snapshot, the WAL included, compacted. */
export const vacuumInto = (from: string, to: string): void => {
  const db = new DatabaseSync(from, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(to);
  } finally {
    db.close();
  }
};

const exists = async (file: string): Promise<boolean> =>
  (await stat(file).catch(() => null)) !== null;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Removes a copy (and any journal SQLite left next to it); a missing file is fine. */
const removeCopy = async (file: string): Promise<void> => {
  for (const f of [file, `${file}-journal`]) await unlink(f).catch(() => {});
};

const movedNote = (dataDir: string, legacyDir: string): string =>
  (dataDir === legacyDir
    ? [
        'Threadgarden (formerly pahub) copied pahub.db to threadgarden.db in this folder',
        'and uses only threadgarden.db from now on.',
        '',
        'pahub.db (with pahub.db-wal and pahub.db-shm, if present) can be deleted.',
      ]
    : [
        'Threadgarden (formerly pahub) moved its data out of this folder, to:',
        '',
        `  ${dataDir}`,
        '',
        'Threadgarden no longer reads this folder. It can be deleted.',
      ]
  ).join('\n') + '\n';

export const migrateDataDir = async (opts: MigrateOptions): Promise<MigrationResult> => {
  const { dataDir, legacyDir } = opts;
  const copy = opts.copy ?? vacuumInto;
  const log = opts.log ?? (() => {});
  const target = join(dataDir, DB_FILE);
  const source = join(legacyDir, LEGACY_DB_FILE);
  if (await exists(target)) return 'current';
  if (!(await exists(source))) return 'fresh';

  const lock = await acquireInstanceLock(legacyDir);
  if (!lock) throw new LegacyServiceRunningError(legacyDir);
  try {
    // Under the lock: another Threadgarden service may have just migrated.
    if (await exists(target)) return 'current';
    await mkdir(dataDir, { recursive: true });
    // Copies an earlier attempt left behind (a crash mid-copy); only a holder of this lock writes them.
    for (const name of await readdir(dataDir)) {
      if (name.startsWith(TEMP_PREFIX)) await removeCopy(join(dataDir, name));
    }
    const temp = join(dataDir, `${TEMP_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`);
    try {
      await copy(source, temp);
      await rename(temp, target);
    } catch (err) {
      await removeCopy(temp);
      throw new Error(`Could not copy ${source} to ${target}: ${errorText(err)}`, { cause: err });
    }
    log(`migrated ${source} to ${target}`);
    // Only a courtesy: the data is safe without it.
    await writeFile(join(legacyDir, MOVED_NOTE_FILE), movedNote(dataDir, legacyDir)).catch(
      (err: unknown) => log(`could not write ${MOVED_NOTE_FILE}: ${errorText(err)}`),
    );
    return 'migrated';
  } finally {
    await lock.release();
  }
};
