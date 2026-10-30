import type { DatabaseSync } from 'node:sqlite';

/**
 * Ordered, append-only schema steps. `PRAGMA user_version` records how many
 * have run; every statement is also `IF NOT EXISTS`, so re-running is harmless.
 */
const steps: string[] = [
  `
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    cwd TEXT,
    sdk_title TEXT,
    summary TEXT,
    first_prompt TEXT,
    git_branch TEXT,
    created_at INTEGER,
    last_modified INTEGER NOT NULL,
    file_size INTEGER,
    indexed_modified INTEGER,
    indexed_size INTEGER
  );
  CREATE INDEX IF NOT EXISTS sessions_project ON sessions (project_id, last_modified DESC);
  CREATE INDEX IF NOT EXISTS sessions_modified ON sessions (last_modified DESC, session_id);
  CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    display_name TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    session_id UNINDEXED,
    text,
    tokenize='trigram'
  );
  CREATE TABLE IF NOT EXISTS meta (
    session_id TEXT PRIMARY KEY,
    custom_title TEXT,
    pinned INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS drafts (
    key TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS live_sessions (
    session_id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    started_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ui_state (key TEXT PRIMARY KEY, json TEXT NOT NULL);
  `,
  // Current FTS generation per session (see Db full-text section).
  `CREATE TABLE IF NOT EXISTS fts_gen (session_id TEXT PRIMARY KEY, gen INTEGER NOT NULL);`,
  // v1.1 "Your turn": when pahub last saw each chat and when its last turn ended.
  `CREATE TABLE IF NOT EXISTS turn_state (
    session_id TEXT PRIMARY KEY,
    last_seen_at INTEGER,
    last_turn_ended_at INTEGER
  );`,
  // v1.1: "Notify when a chat finishes" starts as the user's existing
  // notifications choice (someone who silenced pahub stays silenced). Once, on
  // upgrade: from then on the two settings are independent. Only a boolean is
  // copied, since an invalid stored value would void every setting.
  `INSERT OR IGNORE INTO settings (key, json)
     SELECT 'notifyOnFinish', json FROM settings
     WHERE key = 'notifications' AND json IN ('true', 'false');`,
];

export const migrate = (db: DatabaseSync): void => {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  let version = row?.user_version ?? 0;
  while (version < steps.length) {
    db.exec('BEGIN');
    try {
      db.exec(steps[version] as string);
      version++;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
};
