import type { ChatStatus, ChatSummary, ExternalInfo, Place, Project } from '@pahub/protocol';
import type { ExternalSession } from '../external/poller.js';
import { externalStatus } from '../external/resume-safety.js';
import type { Db, SessionFilter, SessionRow } from './db.js';
import { defaultGitCommonDir, projectIdFor, type GitCommonDir } from './projects.js';

/** Title selection (spec §5.3). pahub never writes titles back to Claude Code. */
export type TitleParts = {
  customTitle?: string | null;
  sdkTitle?: string | null;
  summary?: string | null;
  firstPrompt?: string | null;
};

export const FIRST_PROMPT_MAX = 80;

const clean = (s: string | null | undefined): string => (s ?? '').trim();

/** Non-custom titles are whitespace-collapsed and cut to 80 chars; a custom title is kept as typed. */
const short = (s: string): string => s.replace(/\s+/g, ' ').slice(0, FIRST_PROMPT_MAX);

/** pahub custom title → SDK title → summary → first prompt. */
export const titleFor = (s: TitleParts): string => {
  const custom = clean(s.customTitle);
  if (custom) return custom;
  const sdk = clean(s.sdkTitle);
  if (sdk) return short(sdk);
  const summary = clean(s.summary);
  if (summary) return short(summary);
  const prompt = clean(s.firstPrompt);
  if (prompt) return short(prompt);
  return 'Untitled chat';
};

// ── session catalog ──────────────────────────────────────────────────────────

/** A chat owned by the session host: live, paused or failed. */
export type LiveChat = {
  sessionId: string;
  cwd: string;
  status: ChatStatus;
  live: boolean;
  waitingFor?: string;
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

const byOrder = (a: ChatSummary, b: ChatSummary): number =>
  rank(a.status) - rank(b.status) ||
  b.lastActivity - a.lastActivity ||
  a.sessionId.localeCompare(b.sessionId);

const PREVIEW_MAX = 140;
const previewOf = (r: SessionRow): string =>
  (clean(r.firstPrompt) || clean(r.summary)).replace(/\s+/g, ' ').slice(0, PREVIEW_MAX);

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;

const fromRow = (r: SessionRow): ChatSummary => ({
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
});

/** One row of the quick-search corpus. */
export type CorpusRow = {
  sessionId: string;
  title: string;
  projectId: string;
  projectName: string;
  lastActivity: number;
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
  private readonly projectIds = new Map<string, string>();
  private cache: Snapshot | undefined;

  constructor(o: CatalogOptions) {
    this.db = o.db;
    this.live = o.live ?? { list: () => [] };
    this.externals = o.externals ?? (() => []);
    this.platform = o.platform ?? process.platform;
    this.gitCommonDir = o.gitCommonDir ?? defaultGitCommonDir;
    this.now = o.now ?? Date.now;
  }

  /** Drops the cached titles/project names; call after anything that changes them. */
  invalidate(): void {
    this.cache = undefined;
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

    const first = cursor === undefined;
    const overlay = first ? this.overlay() : new Map<string, Entry>();
    const over = first ? this.overlayFor(place, overlay, snap.hidden) : [];
    if (place.kind === 'needsYou' || place.kind === 'running') return { items: over };

    const page = decodeCursor(cursor, 'd');
    const excluded = first ? [...overlay.keys()] : page.ids;
    const filter: SessionFilter = {
      ...(place.kind === 'project' ? { projectId: place.projectId } : {}),
      ...(place.kind === 'all' ? { excludeProjectIds: snap.hidden } : {}),
      excludeIds: excluded,
    };
    const rows = this.db.listSessions(filter, limit, page.key);
    const items = [...over, ...rows.items.map(fromRow)];
    return rows.nextCursor
      ? { items, nextCursor: encodeCursor('d', excluded, rows.nextCursor) }
      : { items };
  }

  counts(): { needsYou: number; running: number; all: number } {
    const { hidden } = this.snapshot();
    let needsYou = 0;
    let running = 0;
    let extra = 0;
    for (const e of this.overlay().values()) {
      if (e.summary.status === 'needsYou') needsYou++;
      else if (e.summary.status === 'working') running++;
      if (!e.indexed && !hidden.includes(e.summary.projectId)) extra++;
    }
    return { needsYou, running, all: this.db.countSessions(hidden) + extra };
  }

  projects(): Project[] {
    const activity = this.db.projectActivity();
    const overlay = [...this.overlay().values()].map((e) => e.summary);
    const list = this.db.listProjects().map((p) => {
      let lastActivity = activity.get(p.projectId) ?? 0;
      let needsYou = 0;
      let running = 0;
      for (const s of overlay) {
        if (s.projectId !== p.projectId) continue;
        lastActivity = Math.max(lastActivity, s.lastActivity);
        if (s.status === 'needsYou') needsYou++;
        else if (s.status === 'working') running++;
      }
      return {
        projectId: p.projectId,
        path: p.path,
        displayName: p.displayName,
        pinned: p.pinned,
        hidden: p.hidden,
        lastActivity,
        counts: { needsYou, running },
      };
    });
    // Spec 6.1: pinned first, then most recent activity.
    return list.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.lastActivity - a.lastActivity ||
        a.displayName.localeCompare(b.displayName),
    );
  }

  /**
   * Titles and project names of every known session, for quick search. The
   * indexed part is cached until `invalidate()`; unindexed live/external
   * chats are added fresh (a handful of rows).
   */
  corpus(): CorpusRow[] {
    const snap = this.snapshot();
    const extra: CorpusRow[] = [];
    for (const e of this.overlay().values()) {
      if (e.indexed) continue;
      const s = e.summary;
      extra.push({
        sessionId: s.sessionId,
        title: s.title,
        projectId: s.projectId,
        projectName: snap.names.get(s.projectId) ?? baseName(s.cwd),
        lastActivity: s.lastActivity,
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

  /** Live and external sessions by id (a pahub-owned chat wins over an external one). */
  private overlay(): Map<string, Entry> {
    const live = this.live.list();
    const liveIds = new Set(live.map((l) => l.sessionId));
    // Only sessions with an id can be listed (and opened); the rest are visible via the poller.
    const ext = this.externals().flatMap((e) =>
      e.sessionId !== undefined && !liveIds.has(e.sessionId)
        ? [{ ...e, sessionId: e.sessionId }]
        : [],
    );
    const out = new Map<string, Entry>();
    const ids = [...live.map((l) => l.sessionId), ...ext.map((e) => e.sessionId)];
    if (ids.length === 0) return out;
    const rows = new Map(
      this.db.listSessions({ ids }, ids.length, undefined).items.map((r) => [r.sessionId, r]),
    );
    for (const l of live) {
      const row = rows.get(l.sessionId);
      out.set(l.sessionId, {
        indexed: row !== undefined,
        summary: {
          ...this.base(l.sessionId, l.cwd, row, undefined),
          status: l.status,
          live: l.live,
          ...(l.waitingFor === undefined ? {} : { waitingFor: l.waitingFor }),
        },
      });
    }
    for (const e of ext) {
      const row = rows.get(e.sessionId);
      const base = this.base(e.sessionId, e.cwd, row, e.name);
      out.set(e.sessionId, {
        indexed: row !== undefined,
        summary: {
          ...base,
          status: externalStatus(e),
          external: externalInfo(e),
          lastActivity: Math.max(row?.lastModified ?? 0, e.startedAt) || base.lastActivity,
          ...(e.waitingFor === undefined ? {} : { waitingFor: e.waitingFor }),
        },
      });
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
    return {
      sessionId,
      title: titleFor({ sdkTitle: title }),
      projectId: this.projectIdOfCwd(cwd),
      cwd,
      status: 'unknown',
      preview: '',
      lastActivity: this.now(),
      pinned: this.db.isSessionPinned(sessionId),
      live: false,
      external: null,
    };
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
            return s.status === 'working';
          case 'project':
            return s.projectId === place.projectId;
          case 'all':
            return !hidden.includes(s.projectId);
        }
      });
    return picked.sort(byOrder);
  }

  private dbFilter(place: Place, overlay: Map<string, Entry>, hidden: string[]): SessionFilter {
    return {
      ...(place.kind === 'project' ? { projectId: place.projectId } : {}),
      ...(place.kind === 'all' ? { excludeProjectIds: hidden } : {}),
      excludeIds: [...overlay.keys()],
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

    const first = cursor === undefined;
    const overlay = first ? this.overlay() : new Map<string, Entry>();
    const over = first
      ? this.overlayFor(place, overlay, snap.hidden).filter((s) =>
          keep(s.sessionId, s.title, s.projectId),
        )
      : [];
    if (place.kind === 'needsYou' || place.kind === 'running') return { items: over };

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
      const inPlace =
        place.kind === 'project'
          ? r.projectId === place.projectId
          : !snap.hidden.includes(r.projectId);
      if (!inPlace || !keep(r.sessionId, r.title, r.projectId)) continue;
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
    const items = [...over, ...rows.map(fromRow)];
    const last = rows.at(-1);
    return more && last
      ? {
          items,
          nextCursor: encodeCursor('q', [...excluded], `${last.lastModified}:${last.sessionId}`),
        }
      : { items };
  }
}
