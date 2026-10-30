import type { Place, Project } from '@pahub/protocol';
import { quietly, type Api } from './api';

export type PlaceCounts = { needsYou: number; running: number; all: number };

export const samePlace = (a: Place, b: Place): boolean =>
  a.kind === b.kind &&
  (a.kind !== 'project' || (b.kind === 'project' && a.projectId === b.projectId));

export class PlacesState {
  selected = $state<Place>({ kind: 'all' });
  counts = $state<PlaceCounts>({ needsYou: 0, running: 0, all: 0 });
  projects = $state<Project[]>([]);

  private api: Api | null = null;
  private readonly subscribers = new Set<() => void>();
  private inflight: Promise<void> | null = null;
  private again = false;

  init = (api: Api): void => {
    this.api = api;
    const refresh = () => quietly(this.refresh());
    api.on('projects.changed', refresh);
    api.on('sessions.changed', refresh);
    api.on('external.changed', refresh);
    api.onReconnect(() => this.refresh());
    refresh();
  };

  /** Called after the selected place changes. */
  subscribe = (cb: () => void): (() => void) => {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
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
        } while (this.again);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  };

  pinProject = (projectId: string, pinned: boolean): Promise<unknown> =>
    this.api!.request('projects.update', { projectId, pinned });

  hideProject = (projectId: string, hidden: boolean): Promise<unknown> =>
    this.api!.request('projects.update', { projectId, hidden });
}

export const places = new PlacesState();
