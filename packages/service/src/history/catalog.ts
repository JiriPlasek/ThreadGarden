import type {
  Bucket,
  ChatStatus,
  ChatSummary,
  ExternalInfo,
  Place,
  Project,
} from '@pahub/protocol';
import type { ExternalSession } from '../external/poller.js';
import { externalStatus } from '../external/resume-safety.js';
import type { BucketState, Db, SessionFilter, SessionRow } from './db.js';
import { defaultGitCommonDir, projectIdFor, type GitCommonDir } from './projects.js';

/** Title selection (spec §5.3). pahub never writes titles back to Claude Code. */
export type TitleParts = {
  customTitle?: string | null;
  sdkTitle?: string | null;
  summary?: string | null;
  firstPrompt?: string | null;
  // ── v1.2 C1: chat titles (pahub's own, `chat/titles.ts`) ──
  /** The small model's title of a chat pahub started. */
  generatedTitle?: string | null;
  /** The provisional title from its first message. */
  autoTitle?: string | null;
};

export const FIRST_PROMPT_MAX = 80;

/** What a chat without any title is called. */
export const UNTITLED_TITLE = 'Untitled chat';

const clean = (s: string | null | undefined): string => (s ?? '').trim();

/** Non-custom titles are whitespace-collapsed and cut to 80 chars; a custom title is kept as typed. */
const short = (s: string): string => s.replace(/\s+/g, ' ').slice(0, FIRST_PROMPT_MAX);

/**
 * The user's custom title → (v1.2 C1) the generated title → Claude Code's
 * own title → its summary → (v1.2 C1) the provisional title → the first
 * prompt.
 *
 * The SDK's summary is no title of Claude Code's own when the chat has none
 * (its titles arrive as `sdkTitle`): it is the last prompt, else the first.
 * So a summary equal to the first prompt ranks as the first prompt, and a
 * chat pahub named (a provisional title) ignores the summary altogether,
 * keeping a stable name instead of following its latest message.
 */
export const titleFor = (s: TitleParts): string => {
  const custom = clean(s.customTitle);
  if (custom) return custom;
  const prompt = short(clean(s.firstPrompt));
  const summary = short(clean(s.summary));
  for (const t of [s.generatedTitle, s.sdkTitle]) {
    const title = short(clean(t));
    if (title) return title;
  }
  const auto = short(clean(s.autoTitle));
  if (summary && summary !== prompt && !auto) return summary;
  return auto || prompt || UNTITLED_TITLE;
};

// ── session catalog ──────────────────────────────────────────────────────────

/** A chat owned by the session host: live, paused or failed. */
export type LiveChat = {
  sessionId: string;
  cwd: string;
  status: ChatStatus;
  live: boolean;
  waitingFor?: string;
  /** When the chat last did something (sent, received output); its project rises at once (v1.1). */
  lastActivity?: number;
  /** Background tasks running in its process (Ruling R29); absent or 0 when none. */
  runningTasks?: number;
};

const externalInfo = (e: ExternalSession): ExternalInfo => ({
  kind: e.kind,
  ...(e.shortId === undefined ? {} : { shortId: e.shortId }),
  ...(e.state === undefined ? {} : { state: e.state }),
  ...(e.status === undefined ? {} : { status: e.status }),
  ...(e.waitingFor === undefined ? {} : { waitingFor: e.waitingFor }),
  ...(e.pid === undefined ? {} : { pid: e.pid }),
  ...(e.name === undefined ? {} : { name: e.name }),
});

export type CatalogOptions = {
  db: Db;
  live?: { list(): LiveChat[] };
  externals?: () => ExternalSession[];
  platform?: NodeJS.Platform;
  gitCommonDir?: GitCommonDir;
  now?: () => number;
  /** Whether a project folder exists (a cached check, see `FolderCheck`); default: always. */
  folderExists?: (path: string) => boolean;
};

type Entry = { summary: ChatSummary; indexed: boolean };
type Snapshot = { names: Map<string, string>; hidden: string[]; rows: CorpusRow[] };

/** Most full-text content hits a query list merges in. Queries under 3 characters have none. */
export const CONTENT_HIT_CAP = 2000;

/** Cursor: `<kind>:<base64url JSON of overlay ids shown on page 1>.<keyset position>`. */
const encodeCursor = (kind: string, ids: string[], key: string): string =>
  `${kind}:${Buffer.from(JSON.stringify(ids)).toString('base64url')}.${key}`;

const decodeCursor = (
  cursor: string | undefined,
  kind: string,
): { ids: string[]; key: string | undefined } => {
  if (!cursor?.startsWith(`${kind}:`)) return { ids: [], key: undefined };
  const body = cursor.slice(kind.length + 1);
  const dot = body.indexOf('.');
  try {
    const ids: unknown = JSON.parse(Buffer.from(body.slice(0, dot), 'base64url').toString());
    return {
      ids: Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [],
      key: body.slice(dot + 1) || undefined,
    };
  } catch {
    return { ids: [], key: undefined };
  }
};

const parseKey = (key: string): { at: number; id: string } => {
  const i = key.indexOf(':');
  return { at: Number(key.slice(0, i)), id: key.slice(i + 1) };
};
type Page = { items: ChatSummary[]; nextCursor?: string };

/** Display order: needs you → working → idle/paused/failed → everything else (history). */
const rank = (s: ChatStatus): number => {
  switch (s) {
    case 'needsYou':
      return 0;
    case 'working':
    case 'unknown':
      return 1;
    case 'idle':
    case 'paused':
    case 'failed':
      return 2;
    default:
      return 3;
  }
};

/**
 * v1.1 "Your turn": a chat with an unseen finished turn is unread unless it
 * waits on the user (needsYou wins) or is (or may be) working.
 */
const BUSY: ReadonlySet<ChatStatus> = new Set(['needsYou', 'working', 'unknown']);

/** Unread chats → when their last turn ended (`Db.unreadTurns`). */
type Turns = Map<string, number>;

const isUnread = (s: ChatSummary, turns: Turns): boolean =>
  turns.has(s.sessionId) && !BUSY.has(s.status);

// ── v1.2 B1: buckets ──────────────────────────────────────────────────────────

/** The buckets a place lists; undefined for Needs you and Running (every bucket). */
const bucketsOf = (place: Place): readonly Bucket[] | undefined => {
  switch (place.kind) {
    case 'all': // alias of active (v1.2)
    case 'active':
      return ['active'];
    case 'onHold':
      return ['onHold'];
    case 'archived':
      return ['archived'];
    case 'project':
      return ['active', ...(place.include ?? [])];
    default:
      return undefined;
  }
};

/** A summary's bucket fields; the hold details only when set. */
const bucketFields = (
  b: BucketState,
): Pick<ChatSummary, 'bucket' | 'holdUntil' | 'holdNote' | 'backFromHold'> => ({
  bucket: b.bucket,
  ...(b.holdUntil === null ? {} : { holdUntil: b.holdUntil }),
  ...(b.holdNote === null ? {} : { holdNote: b.holdNote }),
  backFromHold: b.backAt !== null,
});

/**
 * Sets an overlay summary's `unread` and (v1.2) `backFromHold` for its
 * status: like unread, "back from hold" yields while the chat waits on the
 * user (it is under Needs you anyway) or works.
 */
const flag = (s: ChatSummary, turns: Turns): void => {
  s.unread = isUnread(s, turns);
  s.backFromHold = s.backFromHold && !BUSY.has(s.status);
};

/**
 * A chat in use right now — pahub runs it, it has a live process elsewhere,
 * or it waits or works — which a bulk archive leaves alone.
 */
export const isActiveNow = (s: ChatSummary): boolean =>
  s.live || s.external?.pid !== undefined || BUSY.has(s.status);

// ──────────────────────────────────────────────────────────────────────────────

/**
 * The Running place, its count and the projects' running counts: a working
 * chat, or (Ruling R29) a live pahub chat with running background tasks even
 * while its turn is idle (e.g. its dev server still runs).
 */
const isRunning = (s: ChatSummary): boolean => s.status === 'working' || (s.runningTasks ?? 0) > 0;

const byOrder = (a: ChatSummary, b: ChatSummary): number =>
  rank(a.status) - rank(b.status) ||
  b.lastActivity - a.lastActivity ||
  a.sessionId.localeCompare(b.sessionId);

const PREVIEW_MAX = 140;
const previewOf = (r: SessionRow): string =>
  (clean(r.firstPrompt) || clean(r.summary)).replace(/\s+/g, ' ').slice(0, PREVIEW_MAX);

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;

const fromRow = (r: SessionRow, unread = false): ChatSummary => ({
  sessionId: r.sessionId,
  title: titleFor(r),
  projectId: r.projectId,
  cwd: r.cwd ?? r.projectId,
  status: 'history',
  preview: previewOf(r),
  lastActivity: r.lastModified,
  pinned: r.pinned,
  live: false,
  external: null,
  unread,
  ...bucketFields(r),
});

/** One row of the quick-search corpus. */
export type CorpusRow = {
  sessionId: string;
  title: string;
  projectId: string;
  projectName: string;
  lastActivity: number;
  /** v1.2: archived chats are searched too, flagged (`search.quick`). */
  bucket: Bucket;
};

/**
 * Merges the history index (DB rows), the session host's chats and external
 * sessions into the lists behind the places (spec §6.1–§6.2). Live and
 * external sessions are a small overlay that sorts above the DB rows.
 */
export class Catalog {
  private readonly db: Db;
  private readonly live: { list(): LiveChat[] };
  private readonly externals: () => ExternalSession[];
  private readonly platform: NodeJS.Platform;
  private readonly gitCommonDir: GitCommonDir;
  private readonly now: () => number;
  private readonly folderExists: (path: string) => boolean;
  private readonly projectIds = new Map<string, string>();
  private cache: Snapshot | undefined;
  /** The project order `projects()` last returned (ids, joined), for `projectOrderChanged`. */
  private lastProjectOrder: string | undefined;

  constructor(o: CatalogOptions) {
    this.db = o.db;
    this.live = o.live ?? { list: () => [] };
    this.externals = o.externals ?? (() => []);
    this.platform = o.platform ?? process.platform;
    this.gitCommonDir = o.gitCommonDir ?? defaultGitCommonDir;
    this.now = o.now ?? Date.now;
    this.folderExists = o.folderExists ?? (() => true);
  }

  /** Drops the cached titles/project names; call after anything that changes them. */
  invalidate(): void {
    this.cache = undefined;
  }

  /**
   * v1.2: `sessionIds` moved to `bucket`. Updates the cached corpus in place
   * (cheaper than `invalidate`, which rebuilds it from every row).
   */
  bucketChanged(sessionIds: readonly string[], bucket: Bucket): void {
    if (!this.cache) return;
    const ids = new Set(sessionIds);
    for (const r of this.cache.rows) if (ids.has(r.sessionId)) r.bucket = bucket;
  }

  /**
   * v1.2 C1: pahub's title of `sessionId` changed. Updates its cached corpus
   * row in place (unindexed chats are not cached: they are read fresh).
   */
  titleChanged(sessionId: string): void {
    const cached = this.cache?.rows.find((r) => r.sessionId === sessionId);
    if (!cached) return;
    const row = this.db.getSession(sessionId);
    if (row) cached.title = titleFor(row);
  }

  /**
   * One page of a place. The first page (no cursor) starts with the whole
   * live/external overlay; later pages are DB rows only, keyset-paged and
   * excluding the overlay ids captured in the cursor (Ruling R15), so a status
   * change between pages can neither duplicate nor skip a row.
   */
  list(place: Place, query: string | undefined, limit: number, cursor?: string): Page {
    const snap = this.snapshot();
    const q = query?.trim();
    if (q) return this.searchList(place, q, snap, limit, cursor);

    const turns = this.db.unreadTurns();
    const first = cursor === undefined;
    const overlay = first ? this.overlay(turns) : new Map<string, Entry>();
    if (place.kind === 'needsYou') return { items: first ? this.needsYouList(overlay, turns) : [] };
    const over = first ? this.overlayFor(place, overlay, snap.hidden) : [];
    if (place.kind === 'running') return { items: over };

    const page = decodeCursor(cursor, 'd');
    const excluded = first ? [...overlay.keys()] : page.ids;
    const rows = this.db.listSessions(this.dbFilter(place, excluded, snap.hidden), limit, page.key);
    const items = [...over, ...rows.items.map((r) => fromRow(r, turns.has(r.sessionId)))];
    return rows.nextCursor
      ? { items, nextCursor: encodeCursor('d', excluded, rows.nextCursor) }
      : { items };
  }

  /** One chat's summary (live/external overlay first, else the index); undefined if unknown. */
  summary(sessionId: string): ChatSummary | undefined {
    return this.summaries([sessionId])[0];
  }

  /** The summaries of `sessionIds` in that order (see `summary`); unknown ids are left out. */
  summaries(sessionIds: readonly string[]): ChatSummary[] {
    const turns = this.db.unreadTurns();
    const overlay = this.overlay(turns);
    return sessionIds.flatMap((id) => {
      const o = overlay.get(id);
      if (o) return [o.summary];
      const row = this.db.getSession(id);
      return row ? [fromRow(row, turns.has(id))] : [];
    });
  }

  /**
   * `needsYou` counts the chats waiting on the user, the unread ones (v1.1)
   * and those back from hold (v1.2); the buckets count what their places
   * list (hidden projects left out); `all` is `active` for older UIs.
   */
  counts(): {
    needsYou: number;
    running: number;
    all: number;
    active: number;
    onHold: number;
    archived: number;
  } {
    const { hidden } = this.snapshot();
    const turns = this.db.unreadTurns();
    const overlay = this.overlay(turns);
    let running = 0;
    const buckets = this.db.countBuckets(hidden);
    for (const e of overlay.values()) {
      if (isRunning(e.summary)) running++;
      // Indexed chats are counted by the query, with the same bucket.
      if (!e.indexed && !hidden.includes(e.summary.projectId)) buckets[e.summary.bucket]++;
    }
    const needsYou = this.needsYouList(overlay, turns).length;
    return { needsYou, running, all: buckets.active, ...buckets };
  }

  /** The live and external chats right now (see `overlay`). */
  overlaySummaries(): ChatSummary[] {
    return [...this.overlay(this.db.unreadTurns()).values()].map((e) => e.summary);
  }

  /**
   * Pinned first, then most recent activity (spec 6.1, v1.1 §4). Activity
   * includes the live chats' last activity, so a project rises as soon as a
   * chat in it is active. `counts.needsYou` includes unread chats.
   */
  projects(): Project[] {
    const activity = this.db.projectActivity();
    const turns = this.db.unreadTurns();
    const byId = this.overlay(turns);
    const overlay = [...byId.values()].map((e) => e.summary);
    const needsYouBy = new Map<string, number>();
    for (const s of this.needsYouList(byId, turns)) {
      needsYouBy.set(s.projectId, (needsYouBy.get(s.projectId) ?? 0) + 1);
    }
    const list = this.db.listProjects().map((p) => {
      let lastActivity = activity.get(p.projectId) ?? 0;
      let running = 0;
      for (const s of overlay) {
        if (s.projectId !== p.projectId) continue;
        lastActivity = Math.max(lastActivity, s.lastActivity);
        if (isRunning(s)) running++;
      }
      return {
        projectId: p.projectId,
        path: p.path,
        displayName: p.displayName,
        pinned: p.pinned,
        hidden: p.hidden,
        lastActivity,
        counts: { needsYou: needsYouBy.get(p.projectId) ?? 0, running },
        exists: this.folderExists(p.path),
      };
    });
    list.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.lastActivity - a.lastActivity ||
        a.displayName.localeCompare(b.displayName),
    );
    this.lastProjectOrder = list.map((p) => p.projectId).join('\n');
    return list;
  }

  /**
   * True when the project order differs from what `projects()` last returned
   * (to a client, or to the previous call of this); used to send
   * `projects.changed` when live activity reorders projects.
   */
  projectOrderChanged(): boolean {
    const before = this.lastProjectOrder;
    this.projects();
    return before !== this.lastProjectOrder;
  }

  /**
   * Titles and project names of every known session, for quick search. The
   * indexed part is cached until `invalidate()`; unindexed live/external
   * chats are added fresh (a handful of rows).
   */
  corpus(): CorpusRow[] {
    const snap = this.snapshot();
    const extra: CorpusRow[] = [];
    for (const e of this.overlay(new Map()).values()) {
      if (e.indexed) continue;
      const s = e.summary;
      extra.push({
        sessionId: s.sessionId,
        title: s.title,
        projectId: s.projectId,
        projectName: snap.names.get(s.projectId) ?? baseName(s.cwd),
        lastActivity: s.lastActivity,
        bucket: s.bucket,
      });
    }
    return extra.length ? [...extra, ...snap.rows] : snap.rows;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private snapshot(): Snapshot {
    if (this.cache) return this.cache;
    const projects = this.db.listProjects();
    const names = new Map(projects.map((p) => [p.projectId, p.displayName]));
    const rows = this.db.listSessions({}, 1_000_000, undefined).items.map((r) => ({
      sessionId: r.sessionId,
      title: titleFor(r),
      projectId: r.projectId,
      projectName: names.get(r.projectId) ?? baseName(r.cwd ?? r.projectId),
      lastActivity: r.lastModified,
      bucket: r.bucket,
    }));
    this.cache = {
      names,
      hidden: projects.filter((p) => p.hidden).map((p) => p.projectId),
      rows,
    };
    return this.cache;
  }

  private projectIdOfCwd(cwd: string): string {
    let id = this.projectIds.get(cwd);
    if (id === undefined) {
      id = projectIdFor(cwd, this.platform, this.gitCommonDir);
      this.projectIds.set(cwd, id);
    }
    return id;
  }

  /**
   * Live and external sessions by id. A live pahub chat wins over an external
   * entry (that is pahub's own process); an external entry wins over a paused
   * or failed pahub chat, which has no process — it is running in a terminal.
   */
  private overlay(turns: Turns): Map<string, Entry> {
    const owned = this.live.list();
    const liveIds = new Set(owned.filter((l) => l.live).map((l) => l.sessionId));
    // Only sessions with an id can be listed (and opened); the rest are visible via the poller.
    const ext = this.externals().flatMap((e) =>
      e.sessionId !== undefined && !liveIds.has(e.sessionId)
        ? [{ ...e, sessionId: e.sessionId }]
        : [],
    );
    const extIds = new Set(ext.map((e) => e.sessionId));
    const live = owned.filter((l) => !extIds.has(l.sessionId));
    const out = new Map<string, Entry>();
    const ids = [...live.map((l) => l.sessionId), ...ext.map((e) => e.sessionId)];
    if (ids.length === 0) return out;
    const rows = new Map(
      this.db.listSessions({ ids }, ids.length, undefined).items.map((r) => [r.sessionId, r]),
    );
    for (const l of live) {
      const row = rows.get(l.sessionId);
      const summary: ChatSummary = {
        ...this.base(l.sessionId, l.cwd, row, undefined),
        status: l.status,
        live: l.live,
        ...(l.waitingFor === undefined ? {} : { waitingFor: l.waitingFor }),
        ...(l.lastActivity === undefined
          ? {}
          : { lastActivity: Math.max(row?.lastModified ?? 0, l.lastActivity) }),
        // Only a chat with a process has tasks.
        ...(l.live && (l.runningTasks ?? 0) > 0 ? { runningTasks: l.runningTasks } : {}),
      };
      flag(summary, turns);
      out.set(l.sessionId, { indexed: row !== undefined, summary });
    }
    for (const e of ext) {
      const row = rows.get(e.sessionId);
      const base = this.base(e.sessionId, e.cwd, row, e.name);
      const summary: ChatSummary = {
        ...base,
        status: externalStatus(e),
        external: externalInfo(e),
        lastActivity: Math.max(row?.lastModified ?? 0, e.startedAt) || base.lastActivity,
        ...(e.waitingFor === undefined ? {} : { waitingFor: e.waitingFor }),
      };
      flag(summary, turns);
      out.set(e.sessionId, { indexed: row !== undefined, summary });
    }
    return out;
  }

  private base(
    sessionId: string,
    cwd: string,
    row: SessionRow | undefined,
    title: string | undefined,
  ): ChatSummary {
    if (row) return fromRow(row);
    const { pinned, ...meta } = this.db.metaOf(sessionId);
    return {
      sessionId,
      // pahub's own titles (v1.2 C1); an external session's name is Claude Code's.
      title: titleFor({ ...meta, sdkTitle: title }),
      projectId: this.projectIdOfCwd(cwd),
      cwd,
      status: 'unknown',
      preview: '',
      lastActivity: this.now(),
      pinned,
      live: false,
      external: null,
      unread: false,
      ...bucketFields(meta),
    };
  }

  /**
   * The Needs you place (v1.1): chats waiting on the user (display order),
   * then unread chats and (v1.2) chats back from hold, most recent turn end
   * or return first. Such chats the host and the poller do not hold come from
   * the index; unknown ids are left out. Every bucket counts.
   */
  private needsYouList(overlay: Map<string, Entry>, turns: Turns): ChatSummary[] {
    const waiting = [...overlay.values()]
      .map((e) => e.summary)
      .filter((s) => s.status === 'needsYou')
      .sort(byOrder);
    const backs = this.db.backFromHold();
    if (turns.size === 0 && backs.size === 0) return waiting;
    const since = new Map(turns);
    for (const [id, at] of backs) since.set(id, Math.max(at, since.get(id) ?? at));
    const missing = [...since.keys()].filter((id) => !overlay.has(id));
    const rows = new Map(
      missing.length === 0
        ? []
        : this.db
            .listSessions({ ids: missing }, missing.length, undefined)
            .items.map((r) => [r.sessionId, r]),
    );
    const order = [...since].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const flagged = order.flatMap(([id]) => {
      const o = overlay.get(id);
      if (o) return o.summary.unread || o.summary.backFromHold ? [o.summary] : [];
      const row = rows.get(id);
      return row ? [fromRow(row, turns.has(id))] : [];
    });
    return [...waiting, ...flagged];
  }

  /** The overlay rows that belong to `place`, in display order. */
  private overlayFor(place: Place, overlay: Map<string, Entry>, hidden: string[]): ChatSummary[] {
    const picked = [...overlay.values()]
      .map((e) => e.summary)
      .filter((s) => {
        switch (place.kind) {
          case 'needsYou':
            return s.status === 'needsYou';
          case 'running':
            return isRunning(s);
          default:
            return this.inPlace(place, s.projectId, s.bucket, hidden);
        }
      });
    return picked.sort(byOrder);
  }

  /**
   * Whether a chat of `projectId` in `bucket` belongs to a bucket place or a
   * project (the same rule `dbFilter` puts in SQL).
   */
  private inPlace(place: Place, projectId: string, bucket: Bucket, hidden: string[]): boolean {
    if (place.kind === 'project' && projectId !== place.projectId) return false;
    if (place.kind !== 'project' && hidden.includes(projectId)) return false;
    return bucketsOf(place)?.includes(bucket) ?? true;
  }

  /** The index rows of a project or bucket place, except the overlay's `excludeIds`. */
  private dbFilter(place: Place, excludeIds: string[], hidden: string[]): SessionFilter {
    const buckets = bucketsOf(place);
    return {
      ...(place.kind === 'project'
        ? { projectId: place.projectId }
        : { excludeProjectIds: hidden }),
      ...(buckets ? { buckets } : {}),
      excludeIds,
    };
  }

  /**
   * A query matches titles and project names (substring, from the cached
   * corpus) plus full-text content hits (at most `CONTENT_HIT_CAP`; queries
   * under 3 characters have no content hits). Paging follows the same rules
   * as `list`: overlay on the first page, then corpus rows by keyset.
   */
  private searchList(
    place: Place,
    q: string,
    snap: Snapshot,
    limit: number,
    cursor: string | undefined,
  ): Page {
    const needle = q.toLowerCase();
    const fts = new Set(this.db.searchFts(q, CONTENT_HIT_CAP).map((h) => h.sessionId));
    const keep = (id: string, title: string, projectId: string): boolean =>
      title.toLowerCase().includes(needle) ||
      (snap.names.get(projectId) ?? '').toLowerCase().includes(needle) ||
      fts.has(id);

    const turns = this.db.unreadTurns();
    const first = cursor === undefined;
    const overlay = first ? this.overlay(turns) : new Map<string, Entry>();
    if (place.kind === 'needsYou') {
      const all = first ? this.needsYouList(overlay, turns) : [];
      return { items: all.filter((s) => keep(s.sessionId, s.title, s.projectId)) };
    }
    const over = first
      ? this.overlayFor(place, overlay, snap.hidden).filter((s) =>
          keep(s.sessionId, s.title, s.projectId),
        )
      : [];
    if (place.kind === 'running') return { items: over };

    const page = decodeCursor(cursor, 'q');
    const excluded = new Set(first ? overlay.keys() : page.ids);
    const after = page.key ? parseKey(page.key) : undefined;
    const ids: string[] = [];
    let more = false;
    for (const r of snap.rows) {
      if (
        after &&
        !(r.lastActivity < after.at || (r.lastActivity === after.at && r.sessionId > after.id))
      ) {
        continue;
      }
      if (excluded.has(r.sessionId)) continue;
      if (!this.inPlace(place, r.projectId, r.bucket, snap.hidden)) continue;
      if (!keep(r.sessionId, r.title, r.projectId)) continue;
      if (ids.length === limit) {
        more = true;
        break;
      }
      ids.push(r.sessionId);
    }
    const found = new Map(
      this.db.listSessions({ ids }, ids.length || 1, undefined).items.map((r) => [r.sessionId, r]),
    );
    const rows = ids.flatMap((id) => {
      const r = found.get(id);
      return r ? [r] : [];
    });
    const items = [...over, ...rows.map((r) => fromRow(r, turns.has(r.sessionId)))];
    const last = rows.at(-1);
    return more && last
      ? {
          items,
          nextCursor: encodeCursor('q', [...excluded], `${last.lastModified}:${last.sessionId}`),
        }
      : { items };
  }
}
