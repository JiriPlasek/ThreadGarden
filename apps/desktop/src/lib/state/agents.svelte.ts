import type { ChatStatus, ChatSummary } from '@threadgarden/protocol';
import { quietly, type Api } from './api';
import { mergeSorted, type MachineChat } from './merged-list.svelte';
import { LOCAL_FALLBACK_ID } from './refs';
import type { Scopes } from './scope';

/** More agents than this at once is not a realistic workload; the strip shows what fits. */
export const AGENTS_LIMIT = 200;

/** One machine's part of the strip. */
type Feed = {
  machineId: () => string;
  api: Api;
  /** This PC's: always asked (a failure surfaces), kept while disconnected. */
  local: boolean;
  items: MachineChat[];
  inflight: Promise<void> | null;
  again: boolean;
  offs: (() => void)[];
};

/**
 * Every running agent across all projects (spec §6.1 bottom strip, Ruling R21):
 * every live Threadgarden chat (needs you, working, idle) plus external sessions that
 * need the user or are working, ordered needs-you → working → idle. With paired
 * machines (`follow`), the agents of every connected machine, each with its machine.
 */
export class AgentsState {
  items = $state.raw<MachineChat[]>([]);
  needsYou = $derived(this.items.filter((s) => s.status === 'needsYou').length);

  /** This PC first, then the paired machines in the order they appeared. */
  private feeds: Feed[] = [];
  private localFeed: Feed | null = null;

  /** This PC's client; `machineId` names This PC in `items` (default `local`). */
  init = (api: Api, o: { machineId?: () => string } = {}): void => {
    this.localFeed = this.add(api, o.machineId ?? (() => LOCAL_FALLBACK_ID), true);
  };

  /** Lists every paired machine's agents too, while it is connected. */
  follow = (scopes: Pick<Scopes, 'observe'>): (() => void) =>
    scopes.observe(
      (scope) => {
        const feed = this.add(scope.api, () => scope.machineId, false);
        return () => this.remove(feed);
      },
      { paired: true },
    );

  /**
   * This PC's agents: what "Stop all work", restarting the service and
   * quitting stop (each acts on This PC's service only).
   */
  get local(): MachineChat[] {
    const id = this.localFeed?.machineId();
    return this.items.filter((a) => a.machineId === id);
  }

  /** Re-fetches the lists of This PC and every connected machine; overlapping calls coalesce per machine. */
  refresh = async (): Promise<void> => {
    await Promise.all(
      this.feeds.filter((f) => f.local || f.api.status === 'open').map(this.refreshFeed),
    );
  };

  /** Stops the work on This PC (see `local`). */
  stopAll = async (): Promise<number> => {
    const feed = this.localFeed;
    if (!feed) return 0;
    const { stopped } = await feed.api.request('work.stopAll', {});
    quietly(this.refreshFeed(feed));
    return stopped;
  };

  private add = (api: Api, machineId: () => string, local: boolean): Feed => {
    const feed: Feed = { machineId, api, local, items: [], inflight: null, again: false, offs: [] };
    this.feeds.push(feed);
    const refresh = () => quietly(this.refreshFeed(feed));
    feed.offs.push(
      api.on('sessions.changed', refresh),
      api.on('external.changed', refresh),
      api.on('chat.status', (e) => {
        const cur = feed.items.find((s) => s.sessionId === e.sessionId);
        // Header-only events (cost, model, …) do not change the strip.
        if (
          cur ? cur.status === e.status && cur.waitingFor === e.waitingFor : e.status === 'history'
        ) {
          return;
        }
        refresh();
      }),
      api.onOpen(() => this.refreshFeed(feed)),
    );
    if (!local) {
      // A machine that drops takes its agents along (nothing is known of them meanwhile).
      feed.offs.push(
        api.onStatus((s) => {
          if (s === 'open' || feed.items.length === 0) return;
          feed.items = [];
          this.merge();
        }),
      );
    }
    if (api.status === 'open') refresh();
    return feed;
  };

  private remove = (feed: Feed): void => {
    for (const off of feed.offs) off();
    this.feeds = this.feeds.filter((f) => f !== feed);
    this.merge();
  };

  /** One machine's rows as they are; several machines' merged by group, then recency. */
  private merge = (): void => {
    const [only, ...more] = this.feeds;
    this.items =
      only && more.length === 0
        ? only.items
        : mergeSorted(
            this.feeds.map((f) => f.items),
            byGroup,
          );
  };

  /** Re-fetches one machine's lists; overlapping calls coalesce into one trailing fetch. */
  private refreshFeed = (feed: Feed): Promise<void> => {
    if (feed.inflight) {
      feed.again = true;
      return feed.inflight;
    }
    const { api } = feed;
    feed.inflight = (async () => {
      try {
        do {
          feed.again = false;
          // "Needs you" and "Running" span every project (hidden ones too) and
          // bucket. The first page of a bucket place starts with its live and
          // external sessions, which is where idle live chats come from: Active
          // and On hold, not Archived (v1.2 §3: archived chats leave the strip).
          const [needsYou, running, active, onHold] = await Promise.all([
            api.request('sessions.list', { place: { kind: 'needsYou' }, limit: AGENTS_LIMIT }),
            api.request('sessions.list', { place: { kind: 'running' }, limit: AGENTS_LIMIT }),
            api.request('sessions.list', { place: { kind: 'active' }, limit: 1 }),
            api.request('sessions.list', { place: { kind: 'onHold' }, limit: 1 }),
          ]);
          // A machine removed meanwhile.
          if (!this.feeds.includes(feed)) return;
          const machineId = feed.machineId();
          feed.items = mergeAgents([
            ...needsYou.items,
            ...running.items,
            ...active.items,
            ...onHold.items,
          ]).map((s) => ({ ...s, machineId }));
          this.merge();
        } while (feed.again);
      } finally {
        feed.inflight = null;
      }
    })();
    return feed.inflight;
  };
}

const GROUP: Partial<Record<ChatStatus, number>> = { needsYou: 0, working: 1, idle: 2 };

/** Belongs in the strip: live Threadgarden chats that are not paused or failed, external ones that need you or work. */
const isAgent = (s: ChatSummary): boolean =>
  s.external ? s.status === 'needsYou' || s.status === 'working' : s.live && s.status in GROUP;

/**
 * The strip's rows: each chat once (the last report wins, the lists may race a
 * status change), grouped needs-you → working → idle, otherwise in the
 * service's order (most recent first).
 */
export const mergeAgents = <T extends ChatSummary>(lists: T[]): T[] => {
  const byId = new Map<string, T>();
  for (const s of lists) byId.set(s.sessionId, s);
  return [...byId.values()]
    .filter(isAgent)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => GROUP[a.s.status]! - GROUP[b.s.status]! || a.i - b.i)
    .map(({ s }) => s);
};

/** Across machines: needs-you → working → idle, most recent first within a group. */
const byGroup = (a: ChatSummary, b: ChatSummary): number =>
  GROUP[a.status]! - GROUP[b.status]! || b.lastActivity - a.lastActivity;

export const agents = new AgentsState();
