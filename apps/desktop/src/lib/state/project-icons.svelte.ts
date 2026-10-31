import { SvelteMap } from 'svelte/reactivity';
import type { Api } from './api';

/** An icon answer is asked for again after this long (the service rechecks as often). */
export const ICON_TTL_MS = 10 * 60_000;
/** A failed request is retried no sooner than this. */
export const ICON_RETRY_MS = 30_000;

export type Schedule = (cb: () => void) => void;

/** The next animation frame (where there is none, about one frame from now). */
const nextFrame: Schedule = (cb) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb());
  else setTimeout(cb, 16);
};

/**
 * Project icons (v1.3 §5), asked of the service lazily: a component calls
 * `want(projectId)` once the project is on screen, and reads `url(projectId)`
 * (reactive; null until known and for projects without an icon). Answers are
 * kept for the UI's lifetime and asked for again, for projects that were
 * wanted, after `ICON_TTL_MS` (`revalidate`, run on every projects refresh).
 * Answers that change what is shown are applied together on the next frame,
 * so a burst of answers (a new quick-switcher list) costs one update, not one
 * per answer, and an answer of "no icon" for a tile changes nothing.
 */
export class ProjectIconsState {
  private readonly urls = new SvelteMap<string, string | null>();
  /** When each answer arrived, or when its request failed (then retried after `ICON_RETRY_MS`). */
  private readonly answeredAt = new Map<string, number>();
  private readonly failedAt = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private readonly wanted = new Set<string>();
  /** Answers waiting for the next frame. */
  private readonly arrived = new Map<string, string | null>();
  private flushing = false;
  private api: Api | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly schedule: Schedule = nextFrame,
  ) {}

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

  /** The icon was asked for (answered or in flight); staleness is `revalidate`'s job. */
  asked = (projectId: string): boolean =>
    this.inflight.has(projectId) || this.answeredAt.has(projectId);

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
        this.apply(projectId, dataUrl);
      },
      () => {
        // An older service without the method, or no connection: the letter tile stays.
        this.inflight.delete(projectId);
        this.failedAt.set(projectId, this.now());
      },
    );
  };

  private apply(projectId: string, dataUrl: string | null): void {
    if (!this.arrived.has(projectId) && (this.urls.get(projectId) ?? null) === dataUrl) return;
    this.arrived.set(projectId, dataUrl);
    if (this.flushing) return;
    this.flushing = true;
    this.schedule(() => {
      this.flushing = false;
      for (const [id, url] of this.arrived) {
        if ((this.urls.get(id) ?? null) !== url) this.urls.set(id, url);
      }
      this.arrived.clear();
    });
  }

  /** Asks again for every wanted icon whose answer is stale. */
  revalidate = (): void => {
    for (const id of this.wanted) this.want(id);
  };
}
