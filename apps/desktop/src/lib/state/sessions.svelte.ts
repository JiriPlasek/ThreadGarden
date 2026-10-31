import type { ChatSummary, Result } from '@threadgarden/protocol';
import { quietly, type Api } from './api';
import { wirePlace, type PlacesState } from './places.svelte';

export const PAGE_SIZE = 50;

export type QuickHit = Result<'search.quick'>['items'][number];

export class SessionsState {
  items = $state.raw<ChatSummary[]>([]);
  query = $state('');
  nextCursor = $state<string | undefined>(undefined);
  loading = $state(false);
  error = $state<string | null>(null);

  private api: Api | null = null;
  private places: PlacesState | null = null;
  private generation = 0;

  init = (api: Api, places: PlacesState): void => {
    this.api = api;
    this.places = places;
    places.subscribe(() => quietly(this.reload()));
    const refetch = () => quietly(this.refetch());
    api.on('sessions.changed', refetch);
    api.on('external.changed', refetch);
    api.on('chat.status', (e) => {
      const cur = this.items.find((s) => s.sessionId === e.sessionId);
      if (cur) {
        // Header-only events (cost, model, …) change nothing the list shows.
        if (cur.status === e.status && cur.waitingFor === e.waitingFor) return;
        this.patch(e.sessionId, { status: e.status, waitingFor: e.waitingFor });
      } else {
        const kind = places.selected.kind;
        if (kind !== 'needsYou' && kind !== 'running') return;
      }
      // The service sends only chat.status for live changes: re-fetch so the chat
      // enters or leaves "Needs you"/"Running" and the status order is restored.
      refetch();
    });
    api.onOpen(() => this.reload(true));
    if (api.status === 'open') refetch();
  };

  private refetching: Promise<void> | null = null;
  private refetchAgain = false;

  /** `reload(true)`; overlapping calls coalesce into one trailing reload. */
  refetch = (): Promise<void> => {
    if (this.refetching) {
      this.refetchAgain = true;
      return this.refetching;
    }
    this.refetching = (async () => {
      try {
        do {
          this.refetchAgain = false;
          await this.reload(true);
        } while (this.refetchAgain);
      } finally {
        this.refetching = null;
      }
    })();
    return this.refetching;
  };

  /** Pins or unpins a chat (Threadgarden metadata only), then refreshes the list. */
  setPinned = async (sessionId: string, pinned: boolean): Promise<void> => {
    if (!this.api) return;
    await this.api.request('meta.update', { sessionId, pinned });
    this.patch(sessionId, { pinned });
    await this.reload(true);
  };

  /** Sets Threadgarden's own title for a chat; `null` or blank restores the original title (spec §5.3). */
  rename = async (sessionId: string, title: string | null): Promise<void> => {
    if (!this.api) return;
    const customTitle = title?.trim() ? title.trim() : null;
    await this.api.request('meta.update', { sessionId, customTitle });
    if (customTitle) this.patch(sessionId, { title: customTitle });
    await this.reload(true);
  };

  private patch = (sessionId: string, change: Partial<ChatSummary>): void => {
    const i = this.items.findIndex((s) => s.sessionId === sessionId);
    const cur = this.items[i];
    if (!cur) return;
    const next = this.items.slice();
    next[i] = { ...cur, ...change };
    this.items = next;
  };

  /** Ctrl/Cmd+K: fuzzy titles and projects plus full text, across all projects (spec §6.1). */
  quickSearch = async (query: string, limit: number): Promise<QuickHit[]> => {
    if (!this.api) return [];
    return (await this.api.request('search.quick', { query, limit })).items;
  };

  setQuery = (query: string): Promise<void> => {
    this.query = query;
    return this.reload();
  };

  /**
   * First page for the selected place and query. `keepLoaded` re-fetches as many rows as
   * are already shown (used for change events) so the list does not jump back to page one.
   */
  reload = async (keepLoaded = false): Promise<void> => {
    const { api, places } = this;
    if (!api || !places) return;
    const gen = ++this.generation;
    const limit = keepLoaded ? Math.max(PAGE_SIZE, this.items.length) : PAGE_SIZE;
    this.loading = true;
    try {
      const r = await api.request('sessions.list', {
        place: wirePlace(places.selected),
        limit,
        ...(this.query ? { query: this.query } : {}),
      });
      if (gen !== this.generation) return;
      this.items = r.items;
      this.nextCursor = r.nextCursor;
      this.error = null;
    } catch (err) {
      if (gen === this.generation) this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (gen === this.generation) this.loading = false;
    }
  };

  loadMore = async (): Promise<void> => {
    const { api, places, nextCursor } = this;
    if (!api || !places || !nextCursor || this.loading) return;
    const gen = this.generation;
    this.loading = true;
    try {
      const r = await api.request('sessions.list', {
        place: wirePlace(places.selected),
        limit: PAGE_SIZE,
        cursor: nextCursor,
        ...(this.query ? { query: this.query } : {}),
      });
      if (gen !== this.generation) return;
      const seen = new Set(this.items.map((s) => s.sessionId));
      this.items = [...this.items, ...r.items.filter((s) => !seen.has(s.sessionId))];
      this.nextCursor = r.nextCursor;
    } catch (err) {
      if (gen === this.generation) this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (gen === this.generation) this.loading = false;
    }
  };
}

export const sessions = new SessionsState();
