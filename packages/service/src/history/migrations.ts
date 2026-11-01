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
  // v1.1 "Your turn": when Threadgarden last saw each chat and when its last turn ended.
  `CREATE TABLE IF NOT EXISTS turn_state (
    session_id TEXT PRIMARY KEY,
    last_seen_at INTEGER,
    last_turn_ended_at INTEGER
  );`,
  // v1.1: "Notify when a chat finishes" starts as the user's existing
  // notifications choice (someone who silenced Threadgarden stays silenced). Once, on
  // upgrade: from then on the two settings are independent. Only a boolean is
  // copied, since an invalid stored value would void every setting.
  `INSERT OR IGNORE INTO settings (key, json)
     SELECT 'notifyOnFinish', json FROM settings
     WHERE key = 'notifications' AND json IN ('true', 'false');`,
  // v1.2 buckets: a chat is 'active' (no row, or the default), 'onHold' or
  // 'archived'; Threadgarden's own metadata. `back_at` is set (to the hold's end)
  // when a hold ran out, until the user has seen the chat.
  `
  CREATE TABLE IF NOT EXISTS chat_buckets (
    session_id TEXT PRIMARY KEY,
    bucket TEXT NOT NULL DEFAULT 'active',
    hold_until INTEGER,
    hold_note TEXT,
    back_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS chat_buckets_bucket ON chat_buckets (bucket);
  CREATE INDEX IF NOT EXISTS chat_buckets_hold ON chat_buckets (hold_until) WHERE bucket = 'onHold';
  CREATE INDEX IF NOT EXISTS chat_buckets_back ON chat_buckets (back_at) WHERE back_at IS NOT NULL;
  `,
  // v1.2 C1 chat titles: Threadgarden's own names for chats it runs, apart from the
  // user's custom title (`meta.custom_title`). `auto_title` is the provisional
  // title from the first message, `generated_title` the small model's.
  `
  CREATE TABLE IF NOT EXISTS chat_titles (
    session_id TEXT PRIMARY KEY,
    auto_title TEXT,
    generated_title TEXT
  );
  `,
  // v1.3 B usage and scheduled sends. `usage_limits`: the account's latest
  // plan usage per window (and the account row), as JSON, so it survives
  // restarts. `scheduled_sends`: messages Threadgarden sends to a chat later
  // (`state` pending / sending / failed; sent and cancelled ones are deleted).
  `
  CREATE TABLE IF NOT EXISTS usage_limits (
    key TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    observed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scheduled_sends (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    text TEXT NOT NULL,
    images TEXT,
    send_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    after_reset INTEGER NOT NULL DEFAULT 0,
    rescheduled INTEGER NOT NULL DEFAULT 0,
    late INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS scheduled_sends_due ON scheduled_sends (state, send_at);
  CREATE INDEX IF NOT EXISTS scheduled_sends_session ON scheduled_sends (session_id);
  `,
  // v1.3 C analytics: per-session statistics the indexer extracts from the
  // SDK's messages (`history/stats.ts`), replaced whenever the session is
  // indexed again. `stats_sessions` marks a session done at `version` and
  // holds its totals; days are local calendar days (`YYYY-MM-DD`). The
  // `stats_all_*` tables are the same figures summed over every session,
  // kept up to date with them, so the all-projects view never scans per
  // session.
  `
  CREATE TABLE IF NOT EXISTS stats_sessions (
    session_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    first_at INTEGER,
    last_at INTEGER,
    first_day TEXT,
    last_day TEXT,
    messages INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS stats_sessions_first_day ON stats_sessions (first_day);
  CREATE TABLE IF NOT EXISTS stats_all_days (
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, model)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS stats_all_hours (
    day TEXT NOT NULL,
    hour INTEGER NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, hour)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS stats_all_tools (
    day TEXT NOT NULL,
    tool TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, tool)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS stats_all_agents (
    day TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, agent_type)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS stats_days (
    session_id TEXT NOT NULL,
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    user_messages INTEGER NOT NULL DEFAULT 0,
    assistant_messages INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, model, session_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS stats_days_session ON stats_days (session_id);
  CREATE TABLE IF NOT EXISTS stats_hours (
    session_id TEXT NOT NULL,
    day TEXT NOT NULL,
    hour INTEGER NOT NULL,
    messages INTEGER NOT NULL,
    PRIMARY KEY (day, hour, session_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS stats_hours_session ON stats_hours (session_id);
  CREATE TABLE IF NOT EXISTS stats_tools (
    session_id TEXT NOT NULL,
    day TEXT NOT NULL,
    tool TEXT NOT NULL,
    calls INTEGER NOT NULL,
    PRIMARY KEY (day, tool, session_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS stats_tools_session ON stats_tools (session_id);
  CREATE TABLE IF NOT EXISTS stats_agents (
    session_id TEXT NOT NULL,
    day TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    calls INTEGER NOT NULL,
    PRIMARY KEY (day, agent_type, session_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS stats_agents_session ON stats_agents (session_id);
  `,
  // remote machines: paired devices
  `
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER
  );
  `,
  // remote machines: machines this one connects to
  // (`device_id`: this machine's device on it, so removing can revoke it there)
  `
  CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    port INTEGER NOT NULL,
    cert_pem TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    device_id TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0
  );
  `,
  // v1.4 power: each paired machine's switch configuration (JSON of PowerConfig); passwords stay in memory.
  `
    CREATE TABLE IF NOT EXISTS machine_power (machine_id TEXT PRIMARY KEY, config TEXT NOT NULL)
  `,
];

/** Runs the steps not run yet; `upTo` stops early (tests build older schemas with it). */
export const migrate = (db: DatabaseSync, upTo = steps.length): void => {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  let version = row?.user_version ?? 0;
  while (version < Math.min(upTo, steps.length)) {
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
