import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock } from '../src/discovery.js';
import { openDb } from '../src/history/db.js';
import {
  DB_FILE,
  LEGACY_DB_FILE,
  LegacyServiceRunningError,
  MOVED_NOTE_FILE,
  migrateDataDir,
  vacuumInto,
} from '../src/migrate-data-dir.js';

let root: string;
let oldDir: string;
let newDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'threadgarden-migrate-'));
  oldDir = join(root, 'pahub');
  newDir = join(root, 'threadgarden');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A pahub.db with one piece of UI state, as a v1.2 service left it (closed cleanly). */
const writeLegacyDb = async (dir: string, value = 'from pahub'): Promise<void> => {
  await mkdir(dir, { recursive: true });
  const db = openDb(join(dir, LEGACY_DB_FILE));
  db.setUiState('probe', value);
  db.close();
};

const probeOf = (file: string): unknown => {
  const db = openDb(file);
  try {
    return db.getUiState('probe');
  } finally {
    db.close();
  }
};

const sha = async (file: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

describe('migrateDataDir', () => {
  it('does nothing on a fresh install', async () => {
    expect(await migrateDataDir({ dataDir: newDir, legacyDir: oldDir })).toBe('fresh');
    expect(await readdir(root)).toEqual([]);
  });

  it('copies pahub.db to threadgarden.db and leaves the old dir as it was, plus a note', async () => {
    await writeLegacyDb(oldDir);
    await writeFile(join(oldDir, 'service.json'), '{}');
    await mkdir(join(oldDir, 'logs'));
    await writeFile(join(oldDir, 'logs', 'service.log'), 'old log\n');
    const before = await sha(join(oldDir, LEGACY_DB_FILE));
    const logged: string[] = [];

    const result = await migrateDataDir({
      dataDir: newDir,
      legacyDir: oldDir,
      log: (m) => logged.push(m),
    });

    expect(result).toBe('migrated');
    expect(probeOf(join(newDir, DB_FILE))).toBe('from pahub');
    // Logs, service.json and the lock stay behind; no temporary copy is left.
    expect((await readdir(newDir)).filter((n) => !n.startsWith(`${DB_FILE}-`))).toEqual([DB_FILE]);
    expect(await sha(join(oldDir, LEGACY_DB_FILE))).toBe(before);
    expect(await readdir(oldDir)).toEqual(
      expect.arrayContaining([LEGACY_DB_FILE, 'service.json', 'logs', MOVED_NOTE_FILE]),
    );
    expect(await readdir(oldDir)).not.toContain('service.lock');
    const note = await readFile(join(oldDir, MOVED_NOTE_FILE), 'utf8');
    expect(note).toContain(newDir);
    expect(note).toMatch(/can be deleted/);
    expect(logged.join('\n')).toContain('migrated');
  });

  it('migrates only once: a later start keeps threadgarden.db as it is', async () => {
    await writeLegacyDb(oldDir, 'first');
    await migrateDataDir({ dataDir: newDir, legacyDir: oldDir });
    const db = openDb(join(newDir, DB_FILE));
    db.setUiState('probe', 'changed in threadgarden');
    db.close();
    expect(await migrateDataDir({ dataDir: newDir, legacyDir: oldDir })).toBe('current');
    expect(probeOf(join(newDir, DB_FILE))).toBe('changed in threadgarden');
  });

  it('with both databases present, keeps threadgarden.db and touches nothing', async () => {
    await writeLegacyDb(oldDir, 'old');
    await mkdir(newDir, { recursive: true });
    const current = openDb(join(newDir, DB_FILE));
    current.setUiState('probe', 'new');
    current.close();
    expect(await migrateDataDir({ dataDir: newDir, legacyDir: oldDir })).toBe('current');
    expect(probeOf(join(newDir, DB_FILE))).toBe('new');
    expect(await readdir(oldDir)).not.toContain(MOVED_NOTE_FILE);
  });

  it('refuses while a pahub service holds the old dir, and copies nothing', async () => {
    await writeLegacyDb(oldDir);
    // This process is alive: its lock is a live old service's.
    const oldService = await acquireInstanceLock(oldDir);
    expect(oldService).not.toBeNull();
    const attempt = migrateDataDir({ dataDir: newDir, legacyDir: oldDir });
    await expect(attempt).rejects.toBeInstanceOf(LegacyServiceRunningError);
    await expect(attempt).rejects.toThrow(/older pahub service is still running/);
    expect(await readdir(root)).toEqual(['pahub']);
    await oldService!.release();
    expect(await migrateDataDir({ dataDir: newDir, legacyDir: oldDir })).toBe('migrated');
  });

  it('takes over the stale lock of a pahub service that crashed', async () => {
    await writeLegacyDb(oldDir);
    await writeFile(join(oldDir, 'service.lock'), '2147483646');
    expect(await migrateDataDir({ dataDir: newDir, legacyDir: oldDir })).toBe('migrated');
  });

  it('releases the old dir lock when done', async () => {
    await writeLegacyDb(oldDir);
    await migrateDataDir({ dataDir: newDir, legacyDir: oldDir });
    const lock = await acquireInstanceLock(oldDir);
    expect(lock).not.toBeNull();
    await lock!.release();
  });

  it('migrates in place inside an override dir', async () => {
    await writeLegacyDb(oldDir);
    expect(await migrateDataDir({ dataDir: oldDir, legacyDir: oldDir })).toBe('migrated');
    expect(probeOf(join(oldDir, DB_FILE))).toBe('from pahub');
    expect(await readdir(oldDir)).toEqual(expect.arrayContaining([LEGACY_DB_FILE, DB_FILE]));
    const note = await readFile(join(oldDir, MOVED_NOTE_FILE), 'utf8');
    expect(note).toMatch(/copied pahub\.db to threadgarden\.db in this folder/);
  });

  it('a failed copy leaves no threadgarden.db, and the next start tries again', async () => {
    await writeLegacyDb(oldDir);
    const failing = async (_from: string, to: string): Promise<void> => {
      await writeFile(to, 'half a database');
      throw new Error('disk full');
    };
    await expect(
      migrateDataDir({ dataDir: newDir, legacyDir: oldDir, copy: failing }),
    ).rejects.toThrow(/disk full/);
    expect(await readdir(newDir)).toEqual([]);
    expect(await readdir(oldDir)).not.toContain(MOVED_NOTE_FILE);
    // The old dir is unlocked again.
    expect(await migrateDataDir({ dataDir: newDir, legacyDir: oldDir })).toBe('migrated');
    expect(probeOf(join(newDir, DB_FILE))).toBe('from pahub');
  });

  it('removes a copy that a crash mid-migration left behind', async () => {
    await writeLegacyDb(oldDir);
    await mkdir(newDir, { recursive: true });
    await writeFile(join(newDir, `${DB_FILE}.migrating-1-deadbeef`), 'partial');
    expect(await migrateDataDir({ dataDir: newDir, legacyDir: oldDir })).toBe('migrated');
    expect((await readdir(newDir)).filter((n) => n.includes('migrating'))).toEqual([]);
  });

  it('copies what is still in the WAL of a database left open', async () => {
    await mkdir(oldDir, { recursive: true });
    const open = openDb(join(oldDir, LEGACY_DB_FILE));
    open.setUiState('probe', 'only in the WAL');
    try {
      vacuumInto(join(oldDir, LEGACY_DB_FILE), join(root, 'copy.db'));
      expect(probeOf(join(root, 'copy.db'))).toBe('only in the WAL');
    } finally {
      open.close();
    }
  });
});
