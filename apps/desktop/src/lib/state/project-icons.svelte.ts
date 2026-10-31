import { SvelteMap } from 'svelte/reactivity';
import type { Api } from './api';

/** An icon answer is asked for again after this long (the service rechecks as often). */
export const ICON_TTL_MS = 10 * 60_000;
/** A failed request is retried no sooner than this. */
export const ICON_RETRY_MS = 30_000;

/**
 * Project icons (v1.3 §5), asked of the service lazily: a component calls
 * `want(projectId)` once the project is on screen, and reads `url(projectId)`
 * (reactive; null until known and for projects without an icon). Answers are
 * kept for the UI's lifetime and asked for again, for projects that were
 * wanted, after `ICON_TTL_MS` (`revalidate`, run on every projects refresh).
 */
export class ProjectIconsState {
  private readonly urls = new SvelteMap<string, string | null>();
  /** When each answer arrived, or when its request failed (then retried after `ICON_RETRY_MS`). */
  private readonly answeredAt = new Map<string, number>();
  private readonly failedAt = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private readonly wanted = new Set<string>();
  private api: Api | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  init = (api: Api): void => {
    this.api = api;
    // Requests made while disconnected failed: ask again once connected.
    api.onOpen(() => {
      this.failedAt.clear();
      this.revalidate();
    });
  };

  /** The project's icon as a data URL; null while unknown or when it has none. */
  url = (projectId: string): string | null => this.urls.get(projectId) ?? null;

  /** Asks for the project's icon unless it is known and fresh, asked for, or failed just now. */
  want = (projectId: string): void => {
    this.wanted.add(projectId);
    const api = this.api;
    if (!api || this.inflight.has(projectId)) return;
    const now = this.now();
    const answered = this.answeredAt.get(projectId);
    if (answered !== undefined && now - answered < ICON_TTL_MS) return;
    const failed = this.failedAt.get(projectId);
    if (failed !== undefined && now - failed < ICON_RETRY_MS) return;
    this.inflight.add(projectId);
    api.request('projects.icon', { projectId }).then(
      ({ dataUrl }) => {
        this.inflight.delete(projectId);
        this.failedAt.delete(projectId);
        this.answeredAt.set(projectId, this.now());
        if (this.urls.get(projectId) !== dataUrl) this.urls.set(projectId, dataUrl);
      },
      () => {
        // An older service without the method, or no connection: the letter tile stays.
        this.inflight.delete(projectId);
        this.failedAt.set(projectId, this.now());
      },
    );
  };

  /** Asks again for every wanted icon whose answer is stale. */
  revalidate = (): void => {
    for (const id of this.wanted) this.want(id);
  };
}
