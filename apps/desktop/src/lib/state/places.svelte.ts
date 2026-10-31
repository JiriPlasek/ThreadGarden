import type { Place as WirePlace, Project } from '@threadgarden/protocol';
import { quietly, type Api } from './api';
import { ProjectIconsState } from './project-icons.svelte';
import { LOCAL_FALLBACK_ID } from './refs';

type WireProjectPlace = Extract<WirePlace, { kind: 'project' }>;

/**
 * A place in the left column. A project lives on one machine: `machineId`
 * names it (absent: This PC, for callers that do not know machines yet). The
 * service is asked with `wirePlace()`, which leaves the machine out.
 */
export type Place =
  Exclude<WirePlace, { kind: 'project' }> | (WireProjectPlace & { machineId?: string });

/** The place as the service knows it (without the machine). */
export const wirePlace = (place: Place): WirePlace => {
  if (place.kind !== 'project') return place;
  const { machineId, ...rest } = place;
  void machineId;
  return rest;
};

/** `uiState` key: whether the "Missing folders" group of the places column is expanded. */
export const MISSING_OPEN_KEY = 'places.missingOpen';

/**
 * `places.counts`. v1.2 adds the bucket counts; `all` (= `active`) stays for
 * older services, so the bucket counts are optional here.
 */
export type PlaceCounts = {
  needsYou: number;
  running: number;
  all: number;
  active?: number;
  onHold?: number;
  archived?: number;
};

/** What a project place's "Include on hold / archived" toggle adds (v1.2 §3). */
export const INCLUDE_OTHER_BUCKETS = ['onHold', 'archived'] as const;

/** v1.2: "All chats" became Active; `all` (e.g. from an older UI) reads as `active`. */
const normalize = (place: Place): Place => (place.kind === 'all' ? { kind: 'active' } : place);

/**
 * The same place in the left column (a project's `include` toggle does not
 * count). A project without a machine is This PC's (`localMachineId`).
 */
export const samePlace = (a: Place, b: Place, localMachineId = LOCAL_FALLBACK_ID): boolean => {
  const x = normalize(a);
  const y = normalize(b);
  return (
    x.kind === y.kind &&
    (x.kind !== 'project' ||
      (y.kind === 'project' &&
        x.projectId === y.projectId &&
        (x.machineId ?? localMachineId) === (y.machineId ?? localMachineId)))
  );
};

/** A project place that also lists its on-hold and archived chats. */
export const includesOtherBuckets = (place: Place): boolean =>
  place.kind === 'project' && (place.include?.length ?? 0) > 0;

export class PlacesState {
  selected = $state<Place>({ kind: 'active' });
  counts = $state<PlaceCounts>({ needsYou: 0, running: 0, all: 0 });
  projects = $state<Project[]>([]);
  /** The "Missing folders" group is expanded (collapsed by default, v1.1 §4). */
  missingOpen = $state(false);
  /** v1.3: project icons, asked for lazily by the components that show them. */
  readonly icons = new ProjectIconsState();

  private api: Api | null = null;
  private localMachineId: () => string = () => LOCAL_FALLBACK_ID;
  private readonly subscribers = new Set<() => void>();
  private readonly countWatchers = new Set<(counts: PlaceCounts) => void>();
  private inflight: Promise<void> | null = null;
  private again = false;

  init = (api: Api, opts: { localMachineId?: () => string } = {}): void => {
    this.api = api;
    if (opts.localMachineId) this.localMachineId = opts.localMachineId;
    this.icons.init(api);
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

  /** Selecting a project shows its active chats (the include toggle starts off). */
  select = (place: Place): void => {
    if (samePlace(this.selected, place, this.localMachineId())) return;
    this.selected = normalize(place);
    for (const cb of this.subscribers) cb();
  };

  /** The selected project's "Include on hold / archived" toggle (v1.2 §3). */
  setInclude = (on: boolean): void => {
    const p = this.selected;
    if (p.kind !== 'project' || includesOtherBuckets(p) === on) return;
    const at = p.machineId === undefined ? {} : { machineId: p.machineId };
    this.selected = on
      ? { kind: 'project', projectId: p.projectId, ...at, include: [...INCLUDE_OTHER_BUCKETS] }
      : { kind: 'project', projectId: p.projectId, ...at };
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
        this.icons.revalidate();
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

  /** Hiding the selected project moves the selection to Active. */
  hideProject = async (projectId: string, hidden: boolean): Promise<void> => {
    await this.api!.request('projects.update', { projectId, hidden });
    if (hidden && this.selected.kind === 'project' && this.selected.projectId === projectId) {
      this.select({ kind: 'active' });
    } else {
      for (const cb of this.subscribers) cb();
    }
    await this.refresh();
  };

  /**
   * Hides several projects ("Hide all missing", v1.2 §4) through the same
   * per-project hide, one request each, then refreshes once. If one fails,
   * the ones already hidden stay hidden and the error is rethrown.
   */
  hideProjects = async (projectIds: readonly string[]): Promise<void> => {
    const done = new Set<string>();
    try {
      for (const projectId of projectIds) {
        await this.api!.request('projects.update', { projectId, hidden: true });
        done.add(projectId);
      }
    } finally {
      const sel = this.selected;
      if (sel.kind === 'project' && done.has(sel.projectId)) this.select({ kind: 'active' });
      else if (done.size > 0) for (const cb of this.subscribers) cb();
      // A failed refresh must not mask a failed hide (the next event refreshes anyway).
      await this.refresh().catch(() => {});
    }
  };
}

export const places = new PlacesState();
