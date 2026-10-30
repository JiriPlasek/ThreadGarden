/** Router handlers for places, projects, search, chat metadata, drafts and settings. */
import type { SettingsPatch } from '@pahub/protocol';
import type { Catalog } from '../../history/catalog.js';
import type { Db } from '../../history/db.js';
import type { QuickHit } from '../../history/search.js';
import { ServiceError, type Router } from '../router.js';

export type HistoryHandlerDeps = {
  db: Db;
  catalog: Catalog;
  quickSearch: (query: string, limit: number) => QuickHit[];
  now?: () => number;
  /** Called after `settings.set` with the applied patch (e.g. to find `claude` again). */
  onSettingsChanged?: (patch: SettingsPatch) => void;
};

/**
 * `meta.update` only touches pahub's own tables: titles and pins are never
 * written back to Claude Code (spec §5.3).
 */
export const registerHistoryHandlers = (router: Router, deps: HistoryHandlerDeps): void => {
  const { db, catalog, quickSearch } = deps;
  const now = deps.now ?? Date.now;

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
