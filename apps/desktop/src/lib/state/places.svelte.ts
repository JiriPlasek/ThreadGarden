import type { Place, Project } from '@pahub/protocol';
import { quietly, type Api } from './api';

/** `uiState` key: whether the "Missing folders" group of the places column is expanded. */
export const MISSING_OPEN_KEY = 'places.missingOpen';

export type PlaceCounts = { needsYou: number; running: number; all: number };

export const samePlace = (a: Place, b: Place): boolean =>
  a.kind === b.kind &&
  (a.kind !== 'project' || (b.kind === 'project' && a.projectId === b.projectId));

export class PlacesState {
  selected = $state<Place>({ kind: 'all' });
  counts = $state<PlaceCounts>({ needsYou: 0, running: 0, all: 0 });
  projects = $state<Project[]>([]);
  /** The "Missing folders" group is expanded (collapsed by default, v1.1 §4). */
  missingOpen = $state(false);

  private api: Api | null = null;
  private readonly subscribers = new Set<() => void>();
  private readonly countWatchers = new Set<(counts: PlaceCounts) => void>();
  private inflight: Promise<void> | null = null;
  private again = false;

  init = (api: Api): void => {
    this.api = api;
    const refresh = () => quietly(this.refresh());
    api.on('projects.changed', refresh);
    api.on('sessions.changed', refresh);
    api.on('external.changed', refresh);
    // Live status changes move chats in and out of "Needs you" / "Running".
    api.on('chat.status', refresh);
    // Fetch on every successful hello, including the first one (init may run before connect).
    api.onOpen(() => this.refresh());
    if (api.status === 'open') refresh();
  };

  /** Called after the selected place changes. */
  subscribe = (cb: () => void): (() => void) => {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  };

  /** Called after every counts fetch (e.g. for the tray badge). */
  subscribeCounts = (cb: (counts: PlaceCounts) => void): (() => void) => {
    this.countWatchers.add(cb);
    return () => this.countWatchers.delete(cb);
  };

  select = (place: Place): void => {
    if (samePlace(this.selected, place)) return;
    this.selected = place;
    for (const cb of this.subscribers) cb();
  };

  /** Re-fetches counts and projects; overlapping calls coalesce into one trailing fetch. */
  refresh = (): Promise<void> => {
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    const api = this.api;
    if (!api) return Promise.resolve();
    this.inflight = (async () => {
      try {
        do {
          this.again = false;
          const [counts, projects] = await Promise.all([
            api.request('places.counts', {}),
            api.request('projects.list', {}),
          ]);
          this.counts = counts;
          this.projects = projects;
          for (const cb of this.countWatchers) cb(counts);
        } while (this.again);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  };

  /** Loads the persisted expand state of the "Missing folders" group (collapsed when unknown). */
  restoreMissingOpen = async (): Promise<void> => {
    if (!this.api) return;
    try {
      const { value } = await this.api.request('uiState.get', { key: MISSING_OPEN_KEY });
      if (typeof value === 'boolean') this.missingOpen = value;
    } catch {
      // Collapsed is fine.
    }
  };

  setMissingOpen = (open: boolean): void => {
    this.missingOpen = open;
    if (this.api) quietly(this.api.request('uiState.set', { key: MISSING_OPEN_KEY, value: open }));
  };

  /** The service emits no event for its own metadata changes, so the lists are re-fetched here. */
  pinProject = async (projectId: string, pinned: boolean): Promise<void> => {
    await this.api!.request('projects.update', { projectId, pinned });
    await this.refresh();
  };

  /** Hiding the selected project moves the selection to "All chats". */
  hideProject = async (projectId: string, hidden: boolean): Promise<void> => {
    await this.api!.request('projects.update', { projectId, hidden });
    if (hidden && this.selected.kind === 'project' && this.selected.projectId === projectId) {
      this.select({ kind: 'all' });
    } else {
      for (const cb of this.subscribers) cb();
    }
    await this.refresh();
  };
}

export const places = new PlacesState();
