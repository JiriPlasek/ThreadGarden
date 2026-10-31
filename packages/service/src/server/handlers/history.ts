/**
 * Router handlers for places, projects, search, chat metadata, buckets,
 * analytics (v1.3), drafts and settings.
 */
import type { EventMsg, SettingsPatch } from '@threadgarden/protocol';
import { queryAnalytics } from '../../history/analytics.js';
import { Buckets } from '../../history/buckets.js';
import type { Catalog } from '../../history/catalog.js';
import type { Db } from '../../history/db.js';
import { ProjectIcons } from '../../history/project-icons.js';
import type { QuickHit } from '../../history/search.js';
import { ServiceError, type Router } from '../router.js';

export type HistoryHandlerDeps = {
  db: Db;
  catalog: Catalog;
  quickSearch: (query: string, limit: number) => QuickHit[];
  now?: () => number;
  /** Called after `settings.set` with the applied patch (e.g. to find `claude` again). */
  onSettingsChanged?: (patch: SettingsPatch) => void;
  /** v1.2 buckets; default: one over `db`/`catalog` that sends events to `emit`. */
  buckets?: Buckets;
  /** Events (`sessions.changed`, …) for the default `buckets`. */
  emit?: (e: EventMsg) => void;
  /** v1.3 project icons; default: a `ProjectIcons` over the real file system. */
  icons?: Pick<ProjectIcons, 'get'>;
  /** Cached folder check (`FolderCheck.exists`): a missing folder has no icon; default: always. */
  folderExists?: (path: string) => boolean;
};

/**
 * `meta.update` only touches Threadgarden's own tables: titles and pins are never
 * written back to Claude Code (spec §5.3).
 */
export const registerHistoryHandlers = (router: Router, deps: HistoryHandlerDeps): void => {
  const { db, catalog, quickSearch } = deps;
  const now = deps.now ?? Date.now;
  const buckets = deps.buckets ?? new Buckets({ db, catalog, emit: deps.emit ?? (() => {}), now });
  const icons = deps.icons ?? new ProjectIcons();
  const folderExists = deps.folderExists ?? (() => true);

  router.register('places.counts', async () => catalog.counts());
  router.register('projects.list', async () => catalog.projects());

  router.register('projects.update', async (p) => {
    if (!db.listProjects().some((x) => x.projectId === p.projectId)) {
      throw new ServiceError('NOT_FOUND', `Unknown project ${p.projectId}`);
    }
    if (p.pinned !== undefined) db.setProjectPinned(p.projectId, p.pinned);
    if (p.hidden !== undefined) db.setProjectHidden(p.projectId, p.hidden);
    catalog.invalidate();
    return {};
  });

  // v1.3 §5: looked up in the project's own folder (never the Claude config dir).
  router.register('projects.icon', async (p) => {
    const project = db.listProjects().find((x) => x.projectId === p.projectId);
    if (!project) throw new ServiceError('NOT_FOUND', `Unknown project ${p.projectId}`);
    if (!folderExists(project.path)) return { dataUrl: null };
    return { dataUrl: await icons.get(project.projectId, project.path) };
  });

  router.register('sessions.list', async (p) =>
    catalog.list(p.place, p.query, Math.max(1, Math.floor(p.limit)), p.cursor),
  );

  router.register('sessions.summaries', async (p) => ({
    items: catalog.summaries(p.sessionIds),
  }));

  router.register('search.quick', async (p) => ({ items: quickSearch(p.query, p.limit) }));

  router.register('meta.update', async (p) => {
    if (p.customTitle !== undefined) db.setCustomTitle(p.sessionId, p.customTitle);
    if (p.pinned !== undefined) db.setSessionPinned(p.sessionId, p.pinned);
    catalog.invalidate();
    return {};
  });

  // ── v1.2 B1: buckets ──
  router.register('chat.setBucket', async (p) =>
    buckets.set(p.sessionIds, p.bucket, { until: p.holdUntil, note: p.holdNote }),
  );
  router.register('chat.archiveOlder', async (p) =>
    buckets.archiveOlder({
      projectId: p.projectId,
      olderThanDays: p.olderThanDays,
      ...(p.dryRun ? { dryRun: true } : {}),
    }),
  );

  // ── v1.3 C: analytics ──
  router.register('analytics.get', async (p) =>
    queryAnalytics(db, {
      range: p.range,
      projectId: p.projectId,
      now: now(),
      chats: () => catalog.corpus(),
    }),
  );

  router.register('drafts.get', async (p) => ({ text: db.getDraft(p.key)?.text ?? '' }));
  router.register('drafts.set', async (p) => {
    if (p.text === '') db.deleteDraft(p.key);
    else db.setDraft(p.key, p.text, now());
    return {};
  });

  router.register('uiState.get', async (p) => ({ value: db.getUiState(p.key) ?? null }));
  router.register('uiState.set', async (p) => {
    db.setUiState(p.key, p.value ?? null);
    return {};
  });

  router.register('settings.get', async () => db.getSettings());
  router.register('settings.set', async (p) => {
    const settings = db.patchSettings(p);
    deps.onSettingsChanged?.(p);
    return settings;
  });
};
