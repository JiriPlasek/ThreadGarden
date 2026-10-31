import type { Analytics, AnalyticsRange } from '@pahub/protocol';
import { RequestError } from '../service/client';
import type { Api } from './api';

/** While statistics are still being gathered, the view refreshes this often. */
export const PENDING_REFRESH_MS = 3_000;
/** History changes (a chat indexed again) refresh the shown view after this quiet time. */
export const CHANGE_REFRESH_MS = 1_500;

export const RANGES: { value: AnalyticsRange; label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
];

/**
 * v1.3 analytics (design §4): the Analytics view's controls (range, one
 * project or all) and the service's answer for them. While the view is on
 * screen (`watch`) it follows history changes and the statistics backfill;
 * a refetch keeps the previous answer on screen until the new one arrives.
 */
export class AnalyticsState {
  range = $state<AnalyticsRange>('30d');
  projectId = $state<string | null>(null);
  data = $state.raw<Analytics | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);

  private api: Api | null = null;
  /** Each model keeps its color slot while the app runs (color follows the model, not its rank). */
  private readonly slots = new Map<string, number>();
  private latest = 0;
  private watchers = 0;
  private stopWatching: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  init = (api: Api): void => {
    this.api = api;
  };

  setRange = (range: AnalyticsRange): void => {
    if (range === this.range) return;
    this.range = range;
    void this.load();
  };

  /** One project, or `null` for all of them. */
  setProject = (projectId: string | null): void => {
    if (projectId === this.projectId) return;
    this.projectId = projectId;
    void this.load();
  };

  /**
   * Color slots (0 … `count` - 1) for the models of one chart: a model keeps
   * the slot it had before unless another model of this chart holds it; new
   * models take the free slots in order.
   */
  modelSlots = (models: readonly string[], count: number): number[] => {
    const taken = new Set<number>();
    const out = models.map((m) => {
      const slot = this.slots.get(m);
      if (slot === undefined || slot >= count || taken.has(slot)) return -1;
      taken.add(slot);
      return slot;
    });
    return out.map((slot, i) => {
      if (slot >= 0) return slot;
      let free = 0;
      while (taken.has(free) && free < count - 1) free++;
      taken.add(free);
      this.slots.set(models[i]!, free);
      return free;
    });
  };

  /** Asks the service for the current controls; an answer overtaken by a newer request is dropped. */
  load = async (): Promise<void> => {
    const api = this.api;
    if (!api) return;
    const seq = ++this.latest;
    this.loading = true;
    this.clearTimer();
    try {
      const data = await api.request('analytics.get', {
        range: this.range,
        ...(this.projectId === null ? {} : { projectId: this.projectId }),
      });
      if (seq !== this.latest) return;
      this.data = data;
      this.error = null;
      if (data.pending > 0 && this.watchers > 0) this.schedule(PENDING_REFRESH_MS);
    } catch (err) {
      if (seq !== this.latest) return;
      this.error =
        err instanceof RequestError && err.code === 'METHOD_NOT_FOUND'
          ? 'The running pahub service is older than this app and has no analytics. Restart the service to use them.'
          : 'Could not load the analytics. They will load again when the service is back.';
    } finally {
      if (seq === this.latest) this.loading = false;
    }
  };

  /**
   * The view is on screen: load now, and again when the history changes or
   * the backfill is still running. Returns the function that stops it.
   */
  watch = (): (() => void) => {
    this.watchers++;
    if (this.watchers === 1 && this.api) {
      const api = this.api;
      const offs = [
        api.on('sessions.changed', () => this.schedule(CHANGE_REFRESH_MS)),
        api.onReconnect(() => this.load()),
      ];
      this.stopWatching = () => offs.forEach((off) => off());
    }
    void this.load();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.watchers--;
      if (this.watchers > 0) return;
      this.stopWatching?.();
      this.stopWatching = null;
      this.clearTimer();
    };
  };

  private schedule(ms: number): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.load();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

export const analytics = new AnalyticsState();
