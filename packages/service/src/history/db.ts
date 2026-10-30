/**
 * pahub's own SQLite store (`node:sqlite`, WAL). It holds the history index,
 * pahub-side titles/pins, drafts, settings, UI state, the live-session
 * registry, the seen/turn-ended times behind "Your turn", the chats'
 * buckets (v1.2) and pahub's own chat titles (v1.2 C1). It never touches
 * Claude Code's data.
 */
import './sqlite-warning.js';
import { DatabaseSync } from 'node:sqlite';
import { SettingsSchema, type Bucket, type Settings, type SettingsPatch } from '@pahub/protocol';
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
} & BucketState &
  PahubTitles;

/** v1.2 C1: pahub's own titles of a chat it started (see `chat/titles.ts`). */
export type PahubTitles = {
  /** Provisional title from the first message. */
  autoTitle: string | null;
  /** The small model's title, after the first turn. */
  generatedTitle: string | null;
};

/** v1.2: a chat's bucket (pahub's own metadata). */
export type BucketState = {
  bucket: Bucket;
  /** On hold until (epoch ms); null when not on hold or on hold indefinitely. */
  holdUntil: number | null;
  holdNote: string | null;
  /** When a hold that ran out brought the chat back, until it is seen; else null. */
  backAt: number | null;
};

export type ProjectRow = {
  projectId: string;
  path: string;
  displayName: string;
  pinned: boolean;
  hidden: boolean;
};

export type SessionFilter = {
  projectId?: string;
  ids?: string[];
  /** Rows of these projects are left out (hidden projects). */
  excludeProjectIds?: string[];
  /** These session ids are left out (already shown from a live source). */
  excludeIds?: string[];
  /** v1.2: only chats in these buckets (default: any). */
  buckets?: readonly Bucket[];
};

const KNOWN_BUCKETS: readonly Bucket[] = ['active', 'onHold', 'archived'];

/** A stored bucket; anything this version does not know is `active` (forward compatibility). */
export const toBucket = (v: unknown): Bucket => (v === 'onHold' || v === 'archived' ? v : 'active');

/**
 * SQL condition: `column` (`b.bucket`, NULL without a `chat_buckets` row) is one
 * of `buckets`. Unknown stored values count as `active`, as `toBucket` reads them.
 */
const bucketIn = (column: string, buckets: readonly Bucket[]): string => {
  const quote = (b: Bucket) => `'${b}'`;
  if (buckets.includes('active')) {
    const others = KNOWN_BUCKETS.filter((b) => !buckets.includes(b));
    return others.length === 0
      ? '1'
      : `(${column} IS NULL OR ${column} NOT IN (${others.map(quote).join(',')}))`;
  }
  return buckets.length === 0 ? '0' : `${column} IN (${buckets.map(quote).join(',')})`;
};

/** SQL expression: the bucket of `column` as `toBucket` reads it. */
const bucketOf = (column: string): string =>
  `CASE WHEN ${column} IN ('onHold', 'archived') THEN ${column} ELSE 'active' END`;

/** SQL condition: the chat in `s` has an unseen finished turn ("Your turn"). */
const UNREAD_SQL = `EXISTS (SELECT 1 FROM turn_state t WHERE t.session_id = s.session_id
  AND t.last_turn_ended_at IS NOT NULL
  AND (t.last_seen_at IS NULL OR t.last_turn_ended_at > t.last_seen_at))`;

const notIn = (column: string, values: string[] | undefined, where: string[], params: string[]) => {
  if (!values || values.length === 0) return;
  where.push(`${column} NOT IN (${values.map(() => '?').join(',')})`);
  params.push(...values);
};

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
  ...toBucketState(r),
  ...toTitles(r),
});

const toTitles = (r: Row | undefined): PahubTitles => ({
  autoTitle: (r?.auto_title as string | null | undefined) ?? null,
  generatedTitle: (r?.generated_title as string | null | undefined) ?? null,
});

const toBucketState = (r: Row | undefined): BucketState => {
  const bucket = toBucket(r?.bucket);
  const onHold = bucket === 'onHold';
  return {
    bucket,
    holdUntil: onHold ? ((r?.hold_until as number | null | undefined) ?? null) : null,
    holdNote: onHold ? ((r?.hold_note as string | null | undefined) ?? null) : null,
    backAt: (r?.back_at as number | null | undefined) ?? null,
  };
};

/** Sessions with their bucket (v1.2) as `b`. */
const WITH_BUCKET = `sessions s LEFT JOIN chat_buckets b ON b.session_id = s.session_id`;

const SESSION_SELECT = `SELECT s.*, m.custom_title AS custom_title, COALESCE(m.pinned, 0) AS pinned,
    b.bucket AS bucket, b.hold_until AS hold_until, b.hold_note AS hold_note, b.back_at AS back_at,
    ct.auto_title AS auto_title, ct.generated_title AS generated_title
  FROM ${WITH_BUCKET} LEFT JOIN meta m ON m.session_id = s.session_id
  LEFT JOIN chat_titles ct ON ct.session_id = s.session_id`;

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
    notIn('s.project_id', filter.excludeProjectIds, where, params as string[]);
    notIn('s.session_id', filter.excludeIds, where, params as string[]);
    if (filter.buckets) where.push(bucketIn('b.bucket', filter.buckets));
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

  /** v1.2: indexed sessions per bucket, optionally leaving out some projects (one query). */
  countBuckets(excludeProjectIds: string[] = []): Record<Bucket, number> {
    const where: string[] = [];
    const params: string[] = [];
    notIn('s.project_id', excludeProjectIds, where, params);
    const rows = this.raw
      .prepare(
        `SELECT ${bucketOf('b.bucket')} AS kind, COUNT(*) AS n FROM ${WITH_BUCKET}
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY kind`,
      )
      .all(...params);
    const out: Record<Bucket, number> = { active: 0, onHold: 0, archived: 0 };
    for (const r of rows) out[toBucket(r.kind)] += Number(r.n);
    return out;
  }

  /** Newest transcript change per project. */
  projectActivity(): Map<string, number> {
    const rows = this.raw
      .prepare('SELECT project_id, MAX(last_modified) AS m FROM sessions GROUP BY project_id')
      .all();
    return new Map(rows.map((r) => [r.project_id as string, Number(r.m)]));
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
  //
  // FTS rows are keyed `<sessionId>#<generation>`. `fts_gen` names the current
  // generation per session, so a rebuild stages rows under the next generation
  // (invisible to search) and `commitFts` makes them current in one short
  // statement; a failed rebuild leaves the previous text searchable.

  /**
   * Starts a rebuild: returns the key to pass to `addFtsChunk`. Rows of any
   * non-current generation (e.g. staged rows orphaned by a crash) are removed
   * first, so the new generation always starts empty.
   */
  stageFts(sessionId: string): { key: string; gen: number } {
    this.deleteFtsRowids(this.staleFtsRowids(sessionId));
    const gen = this.currentGen(sessionId) + 1;
    return { key: `${sessionId}#${gen}`, gen };
  }

  /** Adds one staged row; callers keep `text` ≤ `FTS_CHUNK_CHARS` (see `chunkText`). */
  addFtsChunk(key: string, text: string): void {
    if (text.length === 0) return;
    this.raw.prepare('INSERT INTO messages_fts (session_id, text) VALUES (?, ?)').run(key, text);
  }

  /** Makes the staged generation current (one small write). */
  commitFts(sessionId: string, gen: number): void {
    this.raw
      .prepare(
        `INSERT INTO fts_gen (session_id, gen) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET gen = excluded.gen`,
      )
      .run(sessionId, gen);
  }

  /** Rowids of this session's FTS rows that are not the current generation (old or abandoned). */
  staleFtsRowids(sessionId: string): number[] {
    const cur = this.currentGen(sessionId);
    return this.ftsRows(sessionId)
      .filter((r) => r.gen !== cur)
      .map((r) => r.rowid);
  }

  deleteFtsRowids(rowids: number[]): void {
    const stmt = this.raw.prepare('DELETE FROM messages_fts WHERE rowid = ?');
    for (const id of rowids) stmt.run(id);
  }

  /** Replaces a session's indexed text synchronously (small texts, tests). */
  setFts(sessionId: string, text: string): void {
    const { key, gen } = this.stageFts(sessionId);
    this.raw.exec('BEGIN');
    try {
      for (const chunk of chunkText(text)) this.addFtsChunk(key, chunk);
      this.commitFts(sessionId, gen);
      this.deleteFtsRowids(this.staleFtsRowids(sessionId));
      this.raw.exec('COMMIT');
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  private currentGen(sessionId: string): number {
    const r = this.raw.prepare('SELECT gen FROM fts_gen WHERE session_id = ?').get(sessionId);
    return (r?.gen as number | undefined) ?? 0;
  }

  private ftsRows(sessionId: string): { rowid: number; gen: number }[] {
    return this.raw
      .prepare(
        `SELECT rowid, session_id FROM messages_fts
         WHERE substr(session_id, 1, length(?1) + 1) = ?1 || '#'`,
      )
      .all(sessionId)
      .map((r) => ({
        rowid: r.rowid as number,
        gen: Number((r.session_id as string).slice(sessionId.length + 1)),
      }));
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
    const gens = this.raw.prepare('SELECT gen FROM fts_gen WHERE session_id = ?');
    const seen = new Set<string>();
    const out: { sessionId: string; snippet: string }[] = [];
    for (const r of rows) {
      const key = r.session_id as string;
      const at = key.lastIndexOf('#');
      const id = key.slice(0, at);
      if (seen.has(id)) continue;
      if (gens.get(id)?.gen !== Number(key.slice(at + 1))) continue; // stale or staged
      seen.add(id);
      out.push({ sessionId: id, snippet: r.snip as string });
      if (out.length >= limit) break;
    }
    return out;
  }

  // --- removal ----------------------------------------------------------------

  allSessionIds(): string[] {
    return this.raw
      .prepare('SELECT session_id FROM sessions')
      .all()
      .map((r) => r.session_id as string);
  }

  /**
   * Removes a session's row, index text and "Your turn" state. `meta` and
   * `drafts` are kept on purpose (cheap, and a pahub title survives a
   * transcript that reappears).
   */
  deleteSession(sessionId: string): void {
    this.raw.exec('BEGIN');
    try {
      this.raw.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
      this.raw.prepare('DELETE FROM turn_state WHERE session_id = ?').run(sessionId);
      this.raw.prepare('DELETE FROM fts_gen WHERE session_id = ?').run(sessionId);
      this.deleteFtsRowids(this.ftsRows(sessionId).map((r) => r.rowid));
      this.raw.exec('COMMIT');
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  /** Deletes projects without sessions unless pinned; returns how many went. */
  pruneEmptyProjects(): number {
    const r = this.raw
      .prepare(
        `DELETE FROM projects WHERE pinned = 0
         AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = projects.project_id)`,
      )
      .run();
    return Number(r.changes);
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

  // --- titles (v1.2 C1) ----------------------------------------------------------
  //
  // pahub's own names for chats it starts, kept apart from the user's custom
  // title; never written to Claude Code's data.

  /** The provisional title (from the first message); `null` clears it. */
  setAutoTitle(sessionId: string, title: string | null): void {
    this.raw
      .prepare(
        `INSERT INTO chat_titles (session_id, auto_title) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET auto_title = excluded.auto_title`,
      )
      .run(sessionId, title?.trim() || null);
  }

  /** The small model's title; `null` clears it. */
  setGeneratedTitle(sessionId: string, title: string | null): void {
    this.raw
      .prepare(
        `INSERT INTO chat_titles (session_id, generated_title) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET generated_title = excluded.generated_title`,
      )
      .run(sessionId, title?.trim() || null);
  }

  // --- buckets (v1.2) -------------------------------------------------------------
  //
  // A chat's bucket lives in `chat_buckets` (kept when a transcript
  // disappears, like titles); a chat without a row there is active.

  /** A chat's pin, bucket and (v1.2 C1) pahub-side titles, whether or not it is indexed. */
  metaOf(
    sessionId: string,
  ): { pinned: boolean; customTitle: string | null } & BucketState & PahubTitles {
    const r = this.raw.prepare('SELECT * FROM chat_buckets WHERE session_id = ?').get(sessionId);
    const m = this.raw
      .prepare('SELECT custom_title, pinned FROM meta WHERE session_id = ?')
      .get(sessionId);
    const t = this.raw.prepare('SELECT * FROM chat_titles WHERE session_id = ?').get(sessionId);
    return {
      pinned: m?.pinned === 1,
      customTitle: (m?.custom_title as string | null | undefined) ?? null,
      ...toBucketState(r),
      ...toTitles(t),
    };
  }

  /**
   * Moves chats into `bucket` (one transaction). `hold` applies to `onHold`
   * only; every move clears "back from hold".
   */
  setBucket(
    sessionIds: readonly string[],
    bucket: Bucket,
    hold: { until?: number | undefined; note?: string | undefined } = {},
  ): void {
    if (sessionIds.length === 0) return;
    const onHold = bucket === 'onHold';
    const note = onHold && hold.note?.trim() ? hold.note.trim() : null;
    const until = onHold ? (hold.until ?? null) : null;
    this.inTransaction(() => this.setBucketRows(sessionIds, bucket, until, note));
  }

  /** Archived chats among `sessionIds` become active; returns those, in the given order. */
  unarchive(sessionIds: readonly string[]): string[] {
    if (sessionIds.length === 0) return [];
    const marks = sessionIds.map(() => '?').join(',');
    const changed = new Set(
      this.raw
        .prepare(
          `UPDATE chat_buckets SET bucket = 'active' WHERE bucket = 'archived'
           AND session_id IN (${marks}) RETURNING session_id`,
        )
        .all(...sessionIds)
        .map((r) => r.session_id as string),
    );
    return sessionIds.filter((id) => changed.has(id));
  }

  /**
   * Holds that ran out by `now` end (one statement): those chats become
   * active and "back from hold" as of the hold's end. Returns them in the
   * order they came due.
   */
  releaseHolds(now: number): string[] {
    return this.raw
      .prepare(
        `UPDATE chat_buckets
         SET bucket = 'active', back_at = hold_until, hold_until = NULL, hold_note = NULL
         WHERE bucket = 'onHold' AND hold_until IS NOT NULL AND hold_until <= ?
         RETURNING session_id, back_at`,
      )
      .all(now)
      .map((r) => ({ id: r.session_id as string, at: r.back_at as number }))
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
      .map((r) => r.id);
  }

  /** The user has seen a chat that came back from hold; true when that cleared the flag. */
  clearBackFromHold(sessionId: string): boolean {
    const r = this.raw
      .prepare(
        'UPDATE chat_buckets SET back_at = NULL WHERE session_id = ? AND back_at IS NOT NULL',
      )
      .run(sessionId);
    return Number(r.changes) > 0;
  }

  /** Chats back from hold → when they came back, most recent first. */
  backFromHold(): Map<string, number> {
    const rows = this.raw
      .prepare(
        `SELECT session_id, back_at FROM chat_buckets WHERE back_at IS NOT NULL
         ORDER BY back_at DESC, session_id`,
      )
      .all();
    return new Map(rows.map((r) => [r.session_id as string, r.back_at as number]));
  }

  /**
   * Archives (with `dryRun`: only finds) the active indexed chats last
   * modified before `before`, of one project or outside `excludeProjectIds`,
   * in one transaction. Unread chats, chats back from hold and `excludeIds`
   * are left alone. Returns the ids.
   */
  archiveOlder(o: {
    before: number;
    projectId?: string | undefined;
    excludeProjectIds?: string[];
    excludeIds?: string[];
    dryRun?: boolean;
  }): string[] {
    const where = [
      's.last_modified < ?',
      bucketIn('b.bucket', ['active']),
      'b.back_at IS NULL',
      `NOT ${UNREAD_SQL}`,
    ];
    const params: (string | number)[] = [o.before];
    if (o.projectId !== undefined) {
      where.push('s.project_id = ?');
      params.push(o.projectId);
    }
    notIn('s.project_id', o.excludeProjectIds, where, params as string[]);
    notIn('s.session_id', o.excludeIds, where, params as string[]);
    const select = this.raw.prepare(
      `SELECT s.session_id FROM ${WITH_BUCKET}
       WHERE ${where.join(' AND ')} ORDER BY s.last_modified DESC, s.session_id`,
    );
    const find = () => select.all(...params).map((r) => r.session_id as string);
    if (o.dryRun) return find();
    let ids: string[] = [];
    this.inTransaction(() => {
      ids = find();
      this.setBucketRows(ids, 'archived', null, null);
    });
    return ids;
  }

  private setBucketRows(
    sessionIds: readonly string[],
    bucket: Bucket,
    until: number | null,
    note: string | null,
  ): void {
    const upsert = this.raw.prepare(
      `INSERT INTO chat_buckets (session_id, bucket, hold_until, hold_note, back_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(session_id) DO UPDATE SET bucket = excluded.bucket,
         hold_until = excluded.hold_until, hold_note = excluded.hold_note, back_at = NULL`,
    );
    for (const id of sessionIds) upsert.run(id, bucket, until, note);
  }

  /** Runs `fn` in one transaction (rolled back if it throws). */
  private inTransaction(fn: () => void): void {
    this.raw.exec('BEGIN');
    try {
      fn();
      this.raw.exec('COMMIT');
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
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

  // --- "Your turn" (v1.1) -----------------------------------------------------------
  //
  // A chat is unread while its last turn ended after pahub last saw it. The
  // two times are ordered by operation, not only by the clock: a turn end is
  // stored after the last seen time and a seen time after the last turn end,
  // so two events in the same millisecond (or a clock that went back) still
  // compare in the order they happened.

  /** Records that a turn of `sessionId` ended at `at`. */
  setTurnEnded(sessionId: string, at: number): void {
    this.raw
      .prepare(
        `INSERT INTO turn_state (session_id, last_turn_ended_at) VALUES (?1, ?2)
         ON CONFLICT(session_id) DO UPDATE SET last_turn_ended_at =
           MAX(?2, COALESCE(last_seen_at + 1, ?2), COALESCE(last_turn_ended_at, ?2))`,
      )
      .run(sessionId, at);
  }

  /** The user has seen the chat at `at`; true when that cleared an unread turn. */
  markSeen(sessionId: string, at: number): boolean {
    const r = this.raw
      .prepare('SELECT last_seen_at, last_turn_ended_at FROM turn_state WHERE session_id = ?')
      .get(sessionId);
    const ended = r?.last_turn_ended_at as number | null | undefined;
    const seen = r?.last_seen_at as number | null | undefined;
    if (ended === null || ended === undefined) return false; // no finished turn: nothing to see
    if (seen !== null && seen !== undefined && seen >= ended) return false;
    this.raw
      .prepare('UPDATE turn_state SET last_seen_at = ? WHERE session_id = ?')
      .run(Math.max(at, ended), sessionId);
    return true;
  }

  /** Unread chats → when their last turn ended, most recent first. */
  unreadTurns(): Map<string, number> {
    const rows = this.raw
      .prepare(
        `SELECT session_id, last_turn_ended_at FROM turn_state
         WHERE last_turn_ended_at IS NOT NULL
           AND (last_seen_at IS NULL OR last_turn_ended_at > last_seen_at)
         ORDER BY last_turn_ended_at DESC, session_id`,
      )
      .all();
    return new Map(rows.map((r) => [r.session_id as string, r.last_turn_ended_at as number]));
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
