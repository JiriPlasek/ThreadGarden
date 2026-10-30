import type { ChatStatus, ChatSummary, ExternalInfo, Place, Project } from '@pahub/protocol';
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

/**
 * A Claude Code session running outside pahub. Task 8 (the poller) owns the
 * real producer; this is the shape the catalog needs from it.
 */
export type ExternalSession = {
  sessionId: string;
  cwd: string;
  status: ChatStatus;
  waitingFor?: string;
  title?: string;
  lastActivity?: number;
  external: ExternalInfo;
};

export type CatalogOptions = {
  db: Db;
  live?: { list(): LiveChat[] };
  externals?: () => ExternalSession[];
  platform?: NodeJS.Platform;
  gitCommonDir?: GitCommonDir;
  now?: () => number;
};

type Entry = { summary: ChatSummary; indexed: boolean };
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

  constructor(o: CatalogOptions) {
    this.db = o.db;
    this.live = o.live ?? { list: () => [] };
    this.externals = o.externals ?? (() => []);
    this.platform = o.platform ?? process.platform;
    this.gitCommonDir = o.gitCommonDir ?? defaultGitCommonDir;
    this.now = o.now ?? Date.now;
  }

  list(place: Place, query: string | undefined, limit: number, cursor?: string): Page {
    const hidden = this.hiddenIds();
    const overlay = this.overlay();
    const over = this.overlayFor(place, overlay, hidden);
    const q = query?.trim();
    if (q) return this.searchList(place, q, over, hidden, limit, cursor);

    let start = 0;
    let dbCursor: string | undefined;
    if (cursor?.startsWith('o:')) start = Number(cursor.slice(2)) || 0;
    else if (cursor?.startsWith('d:')) {
      start = over.length;
      dbCursor = cursor.slice(2) || undefined;
    }
    const items = over.slice(start, start + limit);
    if (start + limit < over.length) return { items, nextCursor: `o:${start + limit}` };
    if (place.kind === 'needsYou' || place.kind === 'running') return { items };

    const room = limit - items.length;
    const filter = this.dbFilter(place, overlay, hidden);
    const page = this.db.listSessions(filter, Math.max(room, 1), dbCursor);
    if (room === 0) return page.items.length > 0 ? { items, nextCursor: 'd:' } : { items };
    const merged = [...items, ...page.items.slice(0, room).map(fromRow)];
    return page.nextCursor
      ? { items: merged, nextCursor: `d:${page.nextCursor}` }
      : { items: merged };
  }

  counts(): { needsYou: number; running: number; all: number } {
    const hidden = this.hiddenIds();
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
    return this.db.listProjects().map((p) => {
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
  }

  /** Titles and project names of every known session, for quick search. */
  corpus(): CorpusRow[] {
    const names = this.projectNames();
    const overlay = this.overlay();
    const out: CorpusRow[] = [];
    for (const { summary: s } of overlay.values()) {
      out.push({
        sessionId: s.sessionId,
        title: s.title,
        projectName: names.get(s.projectId) ?? baseName(s.cwd),
        lastActivity: s.lastActivity,
      });
    }
    const rows = this.db.listSessions({ excludeIds: [...overlay.keys()] }, 1_000_000, undefined);
    for (const r of rows.items) {
      out.push({
        sessionId: r.sessionId,
        title: titleFor(r),
        projectName: names.get(r.projectId) ?? baseName(r.cwd ?? r.projectId),
        lastActivity: r.lastModified,
      });
    }
    return out;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private hiddenIds(): string[] {
    return this.db
      .listProjects()
      .filter((p) => p.hidden)
      .map((p) => p.projectId);
  }

  private projectNames(): Map<string, string> {
    return new Map(this.db.listProjects().map((p) => [p.projectId, p.displayName]));
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
    const ext = this.externals().filter((e) => !liveIds.has(e.sessionId));
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
      const base = this.base(e.sessionId, e.cwd, row, e.title);
      out.set(e.sessionId, {
        indexed: row !== undefined,
        summary: {
          ...base,
          status: e.status,
          external: e.external,
          lastActivity: Math.max(row?.lastModified ?? 0, e.lastActivity ?? 0) || base.lastActivity,
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

  /** A query filters the whole place (title, project name, full text) and pages by offset. */
  private searchList(
    place: Place,
    q: string,
    over: ChatSummary[],
    hidden: string[],
    limit: number,
    cursor: string | undefined,
  ): Page {
    const names = this.projectNames();
    const needle = q.toLowerCase();
    const fts = new Set(this.db.searchFts(q, 500).map((h) => h.sessionId));
    const keep = (s: ChatSummary): boolean =>
      s.title.toLowerCase().includes(needle) ||
      (names.get(s.projectId) ?? '').toLowerCase().includes(needle) ||
      fts.has(s.sessionId);
    let matches = over.filter(keep);
    if (place.kind === 'all' || place.kind === 'project') {
      const overlayIds = new Set(over.map((s) => s.sessionId));
      const filter: SessionFilter =
        place.kind === 'project' ? { projectId: place.projectId } : { excludeProjectIds: hidden };
      const rows = this.db.listSessions(filter, 1_000_000, undefined).items;
      matches = matches.concat(
        rows
          .filter((r) => !overlayIds.has(r.sessionId))
          .map(fromRow)
          .filter(keep),
      );
    }
    const start = cursor?.startsWith('q:') ? Number(cursor.slice(2)) || 0 : 0;
    const items = matches.slice(start, start + limit);
    return start + limit < matches.length ? { items, nextCursor: `q:${start + limit}` } : { items };
  }
}
