/**
 * pahub's own SQLite store (`node:sqlite`, WAL). It holds the history index,
 * pahub-side titles/pins, drafts, settings, UI state and the live-session
 * registry. It never touches Claude Code's data.
 */
import './sqlite-warning.js';
import { DatabaseSync } from 'node:sqlite';
import { SettingsSchema, type Settings, type SettingsPatch } from '@pahub/protocol';
import type { LiveRegistry } from '../chat/live-session.js';
import type { SDKSessionInfo } from '../sdk/adapter.js';
import { migrate } from './migrations.js';

export type SessionRow = {
  sessionId: string;
  projectId: string;
  cwd: string | null;
  sdkTitle: string | null;
  summary: string | null;
  firstPrompt: string | null;
  gitBranch: string | null;
  createdAt: number | null;
  lastModified: number;
  fileSize: number | null;
  customTitle: string | null;
  pinned: boolean;
};

export type ProjectRow = {
  projectId: string;
  path: string;
  displayName: string;
  pinned: boolean;
  hidden: boolean;
};

export type SessionFilter = { projectId?: string; ids?: string[] };

/** FTS rows hold at most this many characters, so one insert never blocks long. */
export const FTS_CHUNK_CHARS = 32 * 1024;

/** Splits text into ≤ `size` chunks, preferring to break at whitespace. */
export const chunkText = (text: string, size = FTS_CHUNK_CHARS): string[] => {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const ws = text.lastIndexOf(' ', end);
      const nl = text.lastIndexOf('\n', end);
      const cut = Math.max(ws, nl);
      if (cut > i + size / 2) end = cut + 1;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
};

type Row = Record<string, unknown>;

const toSession = (r: Row): SessionRow => ({
  sessionId: r.session_id as string,
  projectId: r.project_id as string,
  cwd: (r.cwd as string | null) ?? null,
  sdkTitle: (r.sdk_title as string | null) ?? null,
  summary: (r.summary as string | null) ?? null,
  firstPrompt: (r.first_prompt as string | null) ?? null,
  gitBranch: (r.git_branch as string | null) ?? null,
  createdAt: (r.created_at as number | null) ?? null,
  lastModified: r.last_modified as number,
  fileSize: (r.file_size as number | null) ?? null,
  customTitle: (r.custom_title as string | null) ?? null,
  pinned: r.pinned === 1,
});

const SESSION_SELECT = `SELECT s.*, m.custom_title AS custom_title, COALESCE(m.pinned, 0) AS pinned
  FROM sessions s LEFT JOIN meta m ON m.session_id = s.session_id`;

export class Db implements LiveRegistry {
  constructor(readonly raw: DatabaseSync) {}

  close(): void {
    this.raw.close();
  }

  // --- sessions -----------------------------------------------------------

  /** Writes session metadata; never touches the indexed_* marks. */
  upsertSession(info: SDKSessionInfo, projectId: string): void {
    this.raw
      .prepare(
        `INSERT INTO sessions (session_id, project_id, cwd, sdk_title, summary, first_prompt,
           git_branch, created_at, last_modified, file_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           project_id = excluded.project_id, cwd = excluded.cwd, sdk_title = excluded.sdk_title,
           summary = excluded.summary, first_prompt = excluded.first_prompt,
           git_branch = excluded.git_branch, created_at = excluded.created_at,
           last_modified = excluded.last_modified, file_size = excluded.file_size`,
      )
      .run(
        info.sessionId,
        projectId,
        info.cwd ?? null,
        info.customTitle ?? null,
        info.summary ?? null,
        info.firstPrompt ?? null,
        info.gitBranch ?? null,
        info.createdAt ?? null,
        info.lastModified,
        info.fileSize ?? null,
      );
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.raw.prepare(`${SESSION_SELECT} WHERE s.session_id = ?`).get(id);
    return r ? toSession(r) : undefined;
  }

  /** Newest first. `cursor` is the opaque `nextCursor` of the previous page. */
  listSessions(
    filter: SessionFilter,
    limit: number,
    cursor: string | undefined,
  ): { items: SessionRow[]; nextCursor?: string } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.projectId !== undefined) {
      where.push('s.project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.ids) {
      if (filter.ids.length === 0) return { items: [] };
      where.push(`s.session_id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }
    if (cursor) {
      const at = cursor.indexOf(':');
      const modified = Number(cursor.slice(0, at));
      const id = cursor.slice(at + 1);
      where.push('(s.last_modified < ? OR (s.last_modified = ? AND s.session_id > ?))');
      params.push(modified, modified, id);
    }
    const sql = `${SESSION_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.last_modified DESC, s.session_id ASC LIMIT ?`;
    const rows = this.raw
      .prepare(sql)
      .all(...params, limit + 1)
      .map(toSession);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return rows.length > limit && last
      ? { items, nextCursor: `${last.lastModified}:${last.sessionId}` }
      : { items };
  }

  needsReindex(info: SDKSessionInfo): boolean {
    const r = this.raw
      .prepare('SELECT indexed_modified, indexed_size FROM sessions WHERE session_id = ?')
      .get(info.sessionId);
    if (!r || r.indexed_modified === null || r.indexed_modified === undefined) return true;
    return r.indexed_modified !== info.lastModified || r.indexed_size !== (info.fileSize ?? null);
  }

  markIndexed(info: SDKSessionInfo): void {
    this.raw
      .prepare('UPDATE sessions SET indexed_modified = ?, indexed_size = ? WHERE session_id = ?')
      .run(info.lastModified, info.fileSize ?? null, info.sessionId);
  }

  // --- full-text ------------------------------------------------------------

  /** Replaces a session's indexed text (chunked into several FTS rows). */
  setFts(sessionId: string, text: string): void {
    this.raw.exec('BEGIN');
    try {
      this.clearFts(sessionId);
      for (const chunk of chunkText(text)) this.addFtsChunk(sessionId, chunk);
      this.raw.exec('COMMIT');
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  clearFts(sessionId: string): void {
    this.raw.prepare('DELETE FROM messages_fts WHERE session_id = ?').run(sessionId);
  }

  /** Adds one FTS row; callers keep `text` ≤ `FTS_CHUNK_CHARS` (see `chunkText`). */
  addFtsChunk(sessionId: string, text: string): void {
    if (text.length === 0) return;
    this.raw
      .prepare('INSERT INTO messages_fts (session_id, text) VALUES (?, ?)')
      .run(sessionId, text);
  }

  /**
   * Substring search (trigram, case-insensitive) with one hit per session, best
   * rank first. Queries shorter than 3 characters cannot match a trigram index
   * and return nothing. The query is matched literally (never as FTS syntax).
   * A match spanning two chunks of one session may be missed.
   */
  searchFts(query: string, limit: number): { sessionId: string; snippet: string }[] {
    const q = query.trim();
    if ([...q].length < 3 || limit <= 0) return [];
    const phrase = `"${q.replaceAll('"', '""')}"`;
    const rows = this.raw
      .prepare(
        `SELECT session_id, snippet(messages_fts, 1, '', '', '…', 16) AS snip
         FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(phrase, limit * 5 + 20);
    const seen = new Set<string>();
    const out: { sessionId: string; snippet: string }[] = [];
    for (const r of rows) {
      const id = r.session_id as string;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ sessionId: id, snippet: r.snip as string });
      if (out.length >= limit) break;
    }
    return out;
  }

  // --- projects -------------------------------------------------------------

  /** Inserts or updates path/display name; keeps pinned/hidden. */
  upsertProject(p: { projectId: string; path: string; displayName: string }): void {
    this.raw
      .prepare(
        `INSERT INTO projects (project_id, path, display_name) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET path = excluded.path, display_name = excluded.display_name`,
      )
      .run(p.projectId, p.path, p.displayName);
  }

  listProjects(): ProjectRow[] {
    return this.raw
      .prepare('SELECT * FROM projects ORDER BY display_name COLLATE NOCASE, project_id')
      .all()
      .map((r) => ({
        projectId: r.project_id as string,
        path: r.path as string,
        displayName: r.display_name as string,
        pinned: r.pinned === 1,
        hidden: r.hidden === 1,
      }));
  }

  setProjectPinned(projectId: string, pinned: boolean): void {
    this.raw
      .prepare('UPDATE projects SET pinned = ? WHERE project_id = ?')
      .run(pinned ? 1 : 0, projectId);
  }

  setProjectHidden(projectId: string, hidden: boolean): void {
    this.raw
      .prepare('UPDATE projects SET hidden = ? WHERE project_id = ?')
      .run(hidden ? 1 : 0, projectId);
  }

  // --- meta -------------------------------------------------------------------

  /** pahub-side title (spec §5.3); `null` or empty clears it. */
  setCustomTitle(sessionId: string, title: string | null): void {
    const t = title?.trim() ? title.trim() : null;
    this.raw
      .prepare(
        `INSERT INTO meta (session_id, custom_title) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET custom_title = excluded.custom_title`,
      )
      .run(sessionId, t);
  }

  setSessionPinned(sessionId: string, pinned: boolean): void {
    this.raw
      .prepare(
        `INSERT INTO meta (session_id, pinned) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET pinned = excluded.pinned`,
      )
      .run(sessionId, pinned ? 1 : 0);
  }

  isSessionPinned(sessionId: string): boolean {
    return (
      this.raw.prepare('SELECT pinned FROM meta WHERE session_id = ?').get(sessionId)?.pinned === 1
    );
  }

  // --- drafts -------------------------------------------------------------------

  getDraft(key: string): { text: string; updatedAt: number } | undefined {
    const r = this.raw.prepare('SELECT text, updated_at FROM drafts WHERE key = ?').get(key);
    return r ? { text: r.text as string, updatedAt: r.updated_at as number } : undefined;
  }

  setDraft(key: string, text: string, updatedAt: number): void {
    this.raw
      .prepare(
        `INSERT INTO drafts (key, text, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
      )
      .run(key, text, updatedAt);
  }

  deleteDraft(key: string): void {
    this.raw.prepare('DELETE FROM drafts WHERE key = ?').run(key);
  }

  // --- settings / ui state ------------------------------------------------------

  /** Stored values merged over the schema defaults; invalid stored values fall back to defaults. */
  getSettings(): Settings {
    const stored: Record<string, unknown> = {};
    for (const r of this.raw.prepare('SELECT key, json FROM settings').all()) {
      try {
        stored[r.key as string] = JSON.parse(r.json as string);
      } catch {
        // ignore a corrupt value; the default applies
      }
    }
    const parsed = SettingsSchema.safeParse(stored);
    return parsed.success ? parsed.data : SettingsSchema.parse({});
  }

  patchSettings(patch: SettingsPatch): Settings {
    const stmt = this.raw.prepare(
      'INSERT INTO settings (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json',
    );
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) stmt.run(k, JSON.stringify(v));
    }
    return this.getSettings();
  }

  getUiState(key: string): unknown {
    const r = this.raw.prepare('SELECT json FROM ui_state WHERE key = ?').get(key);
    if (!r) return undefined;
    try {
      return JSON.parse(r.json as string);
    } catch {
      return undefined;
    }
  }

  setUiState(key: string, value: unknown): void {
    this.raw
      .prepare(
        'INSERT INTO ui_state (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json',
      )
      .run(key, JSON.stringify(value));
  }

  // --- LiveRegistry ---------------------------------------------------------------

  markLive(sessionId: string, cwd: string): void {
    this.raw
      .prepare(
        'INSERT OR REPLACE INTO live_sessions (session_id, cwd, started_at) VALUES (?, ?, ?)',
      )
      .run(sessionId, cwd, Date.now());
  }

  markEnded(sessionId: string): void {
    this.raw.prepare('DELETE FROM live_sessions WHERE session_id = ?').run(sessionId);
  }

  listLive(): { sessionId: string; cwd: string }[] {
    return this.raw
      .prepare('SELECT session_id, cwd FROM live_sessions ORDER BY started_at, session_id')
      .all()
      .map((r) => ({ sessionId: r.session_id as string, cwd: r.cwd as string }));
  }
}

export const openDb = (path: string): Db => {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA synchronous = NORMAL');
  raw.exec('PRAGMA busy_timeout = 5000');
  migrate(raw);
  return new Db(raw);
};
