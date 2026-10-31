/**
 * Lists across machines: Needs you, Running and the Active / On hold /
 * Archived buckets show the chats of every connected machine. Each machine is
 * asked for the place's pages on its own (one cursor each), and the pages are
 * merged in the order the service lists a place in.
 */
import { compareChats, type ChatSummary, type Result } from '@threadgarden/protocol';
import { quietly } from './api';
import { machineLabel, type MachinesState } from './machines.svelte';
import { wirePlace, type Place } from './places.svelte';
import { chatKey } from './refs';
import type { MachineScope, Scopes } from './scope';
import { PAGE_SIZE } from './sessions.svelte';

/** A chat and the machine it lives on. */
export type MachineChat = ChatSummary & { machineId: string };

/**
 * Whether `place` is listed across machines (a `MergedList`): Needs you,
 * Running and the buckets, once a machine is paired. A project is listed by
 * its machine's `sessions`, as is everything while This PC is alone.
 */
export const listedAcross = (place: Place, scopes: Pick<Scopes, 'all'>): boolean =>
  place.kind !== 'project' && scopes.all().length > 1;

/**
 * Asks "Archive all older than 30 days" of `place` (Active or a project): a
 * project on its machine; Active on This PC and every connected paired
 * machine (one confirmation with the summed count, each machine archives its own).
 */
export const askArchiveOlderIn = (
  place: Place,
  scopes: Pick<Scopes, 'all' | 'get' | 'local'>,
): Promise<void> => {
  if (place.kind === 'project') {
    const scope =
      (place.machineId === undefined ? undefined : scopes.get(place.machineId)) ?? scopes.local();
    return scope.buckets.askArchiveOlder(place.projectId);
  }
  const here = scopes.local();
  const along = scopes
    .all()
    .filter((s) => s !== here && s.api.status === 'open')
    .map((s) => s.buckets);
  return here.buckets.askArchiveOlder(undefined, along);
};

type Order = (a: ChatSummary, b: ChatSummary) => number;

const waiting = (c: ChatSummary): number => (c.status === 'needsYou' ? 0 : 1);

/**
 * How the heads of two machines' lists of `place` compare (each machine's own
 * order is kept). Needs you lists the chats waiting on the user first, then
 * unread chats and chats back from hold by their most recent turn end, which
 * is about their last activity; every other place follows `compareChats`.
 */
export const mergeOrder = (place: Place): Order =>
  place.kind === 'needsYou'
    ? (a, b) =>
        waiting(a) - waiting(b) ||
        b.lastActivity - a.lastActivity ||
        a.sessionId.localeCompare(b.sessionId)
    : compareChats;

/**
 * Merges lists that are each in `order` into one, keeping each list's own
 * order (ties go to the earlier list).
 */
export const mergeSorted = <T extends ChatSummary>(lists: readonly T[][], order: Order): T[] => {
  const at = lists.map(() => 0);
  const out: T[] = [];
  for (;;) {
    let best = -1;
    for (let i = 0; i < lists.length; i++) {
      const head = lists[i]![at[i]!];
      if (head && (best < 0 || order(head, lists[best]![at[best]!]!) < 0)) best = i;
    }
    if (best < 0) return out;
    out.push(lists[best]![at[best]!++]!);
  }
};

type Page = Result<'sessions.list'>;

/** One machine's part: what it sent that is not shown yet, and where its next page starts. */
type Feed = {
  machineId: string;
  buffer: MachineChat[];
  cursor: string | undefined;
  /** Chats it sent since the last reload (shown or buffered). */
  loaded: number;
};

export type MergedListOptions = {
  /** Machine states and names; without it, a scope counts as on while its client is open. */
  machines?: Pick<MachinesState, 'get'>;
  pageSize?: number;
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A cross-machine place (Needs you, Running or a bucket) over the scopes of
 * every machine. Machines that are not on, or whose list fails, are left out
 * and named in `skipped`.
 */
export class MergedList {
  items = $state.raw<MachineChat[]>([]);
  loading = $state(false);
  /** Set when no machine could list the place. */
  error = $state<string | null>(null);
  /** More chats can be loaded (`loadMore`). */
  nextAvailable = $state(false);
  query = $state('');
  /** The machines whose chats are in the list (null before the first answer). */
  private listed = $state.raw<ReadonlySet<string> | null>(null);

  private feeds = new Map<string, Feed>();
  private generation = 0;
  private readonly order: Order;
  private readonly pageSize: number;
  private readonly machines: Pick<MachinesState, 'get'> | undefined;

  constructor(
    private readonly scopes: () => MachineScope[],
    readonly place: Place,
    o: MergedListOptions = {},
  ) {
    this.order = mergeOrder(place);
    this.pageSize = o.pageSize ?? PAGE_SIZE;
    this.machines = o.machines;
  }

  /**
   * Names of the machines whose chats are missing: unreachable (or otherwise
   * not on), their list failed, or they appeared since. A machine still
   * connecting is not named, and one that goes leaves the list at once.
   */
  get skipped(): string[] {
    const listed = this.listed;
    if (!listed) return [];
    return this.scopes()
      .filter((s) => !listed.has(s.machineId) && !this.connecting(s))
      .map(this.nameOf);
  }

  /** The first answer is in (until then the list has nothing to show). */
  get answered(): boolean {
    return this.listed !== null;
  }

  /** Still connecting (not reached yet, nothing failed): not named as missing. */
  private connecting = (scope: MachineScope): boolean =>
    this.machines?.get(scope.machineId)?.status === 'connecting';

  private isOn = (scope: MachineScope): boolean => {
    const m = this.machines?.get(scope.machineId);
    return m ? m.status === 'on' : scope.api.status === 'open';
  };

  private nameOf = (scope: MachineScope): string => {
    const m = this.machines?.get(scope.machineId);
    return m ? machineLabel(m) : scope.machineId;
  };

  private params = (limit: number, cursor?: string) => ({
    place: wirePlace(this.place),
    limit,
    ...(cursor === undefined ? {} : { cursor }),
    ...(this.query ? { query: this.query } : {}),
  });

  setQuery = (query: string): Promise<void> => {
    this.query = query;
    return this.reload();
  };

  /**
   * The first page of every machine that is on. `keepLoaded` asks each
   * machine for as many chats as it sent so far (used for change events), so
   * the list does not jump back to page one. A newer reload wins over an older
   * one still in flight.
   */
  reload = async (keepLoaded = false): Promise<void> => {
    const gen = ++this.generation;
    const asked = this.scopes().filter(this.isOn);
    this.loading = true;
    try {
      const answers = await Promise.all(
        asked.map(async (scope) => {
          const id = scope.machineId;
          const limit = keepLoaded
            ? Math.max(this.pageSize, this.feeds.get(id)?.loaded ?? 0)
            : this.pageSize;
          try {
            return { id, page: await scope.api.request('sessions.list', this.params(limit)) };
          } catch (err) {
            return { id, err };
          }
        }),
      );
      if (gen !== this.generation) return;
      // Machines that went away (or off) meanwhile are left out.
      const now = new Set(
        this.scopes()
          .filter(this.isOn)
          .map((s) => s.machineId),
      );
      const feeds = new Map<string, Feed>();
      let failure: string | null = null;
      for (const a of answers) {
        if ('err' in a) failure ??= message(a.err);
        else if (now.has(a.id)) feeds.set(a.id, this.feed(a.id, a.page));
      }
      this.feeds = feeds;
      this.items = [];
      this.drain();
      this.error = feeds.size === 0 ? failure : null;
    } finally {
      if (gen === this.generation) this.loading = false;
    }
  };

  /** The next page of each machine whose sent chats are all shown and that has more. */
  loadMore = async (): Promise<void> => {
    if (this.loading || !this.nextAvailable) return;
    const gen = this.generation;
    const due = [...this.feeds.values()].filter(
      (f) => f.buffer.length === 0 && f.cursor !== undefined,
    );
    this.loading = true;
    try {
      const answers = await Promise.all(
        due.map(async (f) => {
          const scope = this.scopes().find((s) => s.machineId === f.machineId);
          if (!scope || !this.isOn(scope)) return { f, page: null };
          try {
            const page = await scope.api.request(
              'sessions.list',
              this.params(this.pageSize, f.cursor),
            );
            return { f, page: this.isOn(scope) ? page : null };
          } catch {
            return { f, page: null };
          }
        }),
      );
      if (gen !== this.generation) return;
      for (const { f, page } of answers) {
        // Gone or failing: its chats so far stay, the rest is missing (named in `skipped`).
        if (!page) {
          this.feeds.delete(f.machineId);
          continue;
        }
        f.buffer.push(...this.stamp(f.machineId, page.items));
        f.cursor = page.nextCursor;
        f.loaded += page.items.length;
      }
      this.drain();
    } finally {
      if (gen === this.generation) this.loading = false;
    }
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

  /**
   * Keeps the list current: a machine's list changes, a machine connecting
   * or dropping, and machines appearing or going refetch it. Returns a
   * function that stops.
   */
  watch = (scopes: Pick<Scopes, 'observe'>): (() => void) => {
    let watching = false;
    const refetch = (): void => {
      if (watching) quietly(this.refetch());
    };
    const stop = scopes.observe((scope) => {
      const { api } = scope;
      const offs = [
        api.on('sessions.changed', refetch),
        api.on('external.changed', refetch),
        api.on('chat.status', (e) => {
          const id = scope.machineId;
          const cur = this.items.find((c) => c.machineId === id && c.sessionId === e.sessionId);
          if (cur) {
            // Header-only events (cost, model, …) change nothing the list shows.
            if (cur.status === e.status && cur.waitingFor === e.waitingFor) return;
            this.patch(cur, { status: e.status, waitingFor: e.waitingFor });
          } else if (this.place.kind !== 'needsYou' && this.place.kind !== 'running') {
            return;
          }
          // Live changes come as chat.status only: refetch so the chat enters
          // or leaves Needs you / Running and the status order is restored.
          refetch();
        }),
        api.onOpen(refetch),
        api.onStatus((s) => {
          if (s !== 'open' && this.feeds.has(scope.machineId)) refetch();
        }),
      ];
      // A machine that appears later is named in `skipped` until it connects.
      refetch();
      return () => {
        for (const off of offs) off();
        refetch();
      };
    });
    watching = true;
    return () => {
      watching = false;
      stop();
    };
  };

  private stamp = (machineId: string, items: ChatSummary[]): MachineChat[] =>
    items.map((c) => ({ ...c, machineId }));

  private feed = (machineId: string, page: Page): Feed => ({
    machineId,
    buffer: this.stamp(machineId, page.items),
    cursor: page.nextCursor,
    loaded: page.items.length,
  });

  private patch = (chat: MachineChat, change: Partial<ChatSummary>): void => {
    this.items = this.items.map((c) => (c === chat ? { ...c, ...change } : c));
  };

  /**
   * Moves buffered chats to `items` in merge order while that order is
   * certain: it stops at a machine whose buffer is empty but has more pages
   * (its next chat could come first).
   */
  private drain = (): void => {
    const feeds = [...this.feeds.values()];
    const out = this.items.slice();
    const seen = new Set(out.map(chatKey));
    for (;;) {
      if (feeds.some((f) => f.buffer.length === 0 && f.cursor !== undefined)) break;
      let best: Feed | undefined;
      for (const f of feeds) {
        const head = f.buffer[0];
        if (head && (!best || this.order(head, best.buffer[0]!) < 0)) best = f;
      }
      if (!best) break;
      const chat = best.buffer.shift()!;
      const key = chatKey(chat);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(chat);
      }
    }
    this.items = out;
    this.nextAvailable = feeds.some((f) => f.cursor !== undefined || f.buffer.length > 0);
    this.listed = new Set(this.feeds.keys());
  };
}
