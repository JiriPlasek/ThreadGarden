/**
 * Machine scopes: every machine gets its own set of the per-machine stores,
 * talking to that machine's client. This PC's scope is made of the app's
 * singletons, so a user with only This PC runs exactly what ran before.
 */
import { SvelteMap } from 'svelte/reactivity';
import { ServiceClient } from '../service/client';
import type { AgentsState } from './agents.svelte';
import { quietly, type Api } from './api';
import { buckets, BucketsState } from './buckets.svelte';
import { chats, ChatsState, type ChatsOptions } from './chats.svelte';
import { interaction, InteractionState } from './interaction.svelte';
import type { MachineEntry, MachinesState } from './machines.svelte';
import { listedAcross } from './merged-list.svelte';
import { places, PlacesState, type Place } from './places.svelte';
import { machineIdOf } from './refs';
import { scheduled, ScheduledState } from './scheduled.svelte';
import { sessions, SessionsState } from './sessions.svelte';
import type { SettingsState } from './settings.svelte';
import { tabs, type MachineTabs, type TabsState } from './tabs.svelte';
import { yourTurn, YourTurnState } from './your-turn.svelte';

export type MachineScope = {
  readonly machineId: string;
  api: Api;
  places: PlacesState;
  sessions: SessionsState;
  chats: ChatsState;
  buckets: BucketsState;
  scheduled: ScheduledState;
  interaction: InteractionState;
  yourTurn: YourTurnState;
  /** The tabs as this machine sees them (session ids of its own tabs). */
  tabs: MachineTabs;
};

type ScopeStores = Omit<MachineScope, 'machineId' | 'api' | 'tabs'>;

export type ScopeDeps = {
  tabs: TabsState;
  /**
   * Unused for now: reserved for the machine's notifications (one attention
   * watcher per scope comes with remote chats, Task 13).
   */
  settings: SettingsState;
  /** What the agents strip lists ("Your turn" reads this machine's rows of it). */
  agents?: Pick<AgentsState, 'items'>;
  chats?: ChatsOptions;
  /**
   * This PC's: all scopes. While a machine is paired, the cross-machine
   * places are listed across machines, not by This PC's `sessions`.
   */
  scopes?: Pick<Scopes, 'all' | 'observe'>;
};

/** A scope around existing store instances; `machineId` is read on every use. */
export const makeScope = (
  machineId: () => string,
  api: Api,
  tabs: TabsState,
  stores: ScopeStores,
): MachineScope => ({
  get machineId() {
    return machineId();
  },
  api,
  ...stores,
  tabs: tabs.on(machineId),
});

/**
 * Inits a scope's stores the way the app always has, and keeps its open chats
 * following the machine's tabs; returns a function that stops it.
 */
export const wireScope = (
  scope: MachineScope,
  deps: ScopeDeps,
  o: { projectsOnly?: boolean } = {},
): (() => void) => {
  const { api, places, sessions, chats, interaction, buckets, scheduled, yourTurn } = scope;
  places.init(api, { localMachineId: deps.tabs.localMachineId });
  const all = deps.scopes;
  /**
   * This PC leaves a project of another machine to that machine's scope (as
   * the chat list does, a project of a machine without one is This PC's).
   */
  const elsewhere = (p: Place): boolean =>
    p.kind === 'project' &&
    p.machineId !== undefined &&
    p.machineId !== scope.machineId &&
    !!all?.all().some((s) => s.machineId === p.machineId);
  sessions.init(api, places, {
    lists: o.projectsOnly
      ? (p) => p.kind === 'project'
      : all
        ? (p) => !elsewhere(p) && !listedAcross(p, all)
        : undefined,
  });
  // The last paired machine gone: This PC lists every place again.
  const offScopes = all?.observe(() => () => quietly(sessions.reload()), { paired: true });
  chats.init(api, deps.chats);
  interaction.init(api);
  buckets.init(api, chats);
  scheduled.init(api);
  const sync = (): void => chats.sync(scope.tabs.open, scope.tabs.active);
  const offTabs = deps.tabs.subscribe(sync);
  // Tabs restored before the machine was known, or before its client opened,
  // are waiting for it: every open (the first one too) syncs again.
  const offOpen = api.onOpen(sync);
  sync();
  yourTurn.init(api, {
    tabs: scope.tabs,
    chats,
    sessions,
    agents: {
      get items() {
        const id = scope.machineId;
        return deps.agents?.items.filter((a) => a.machineId === id) ?? [];
      },
    },
  });
  return () => {
    offTabs();
    offOpen();
    offScopes?.();
    yourTurn.stop();
  };
};

/** A paired machine's scope: new store instances on `api` (its relay client). */
export const createScope = (
  machineId: string,
  api: Api,
  deps: ScopeDeps,
): MachineScope & { stop: () => void } => {
  const scope = makeScope(() => machineId, api, deps.tabs, {
    places: new PlacesState(),
    sessions: new SessionsState(),
    chats: new ChatsState(),
    buckets: new BucketsState(),
    scheduled: new ScheduledState(),
    interaction: new InteractionState(),
    yourTurn: new YourTurnState(),
  });
  // Its `sessions` lists its projects; the other places are listed across machines.
  const stop = wireScope(scope, deps, { projectsOnly: true });
  return Object.assign(scope, { stop });
};

type Observer = {
  cb: (scope: MachineScope) => (() => void) | void;
  /** Cleanups of the scopes `cb` saw, by scope. */
  seen: Map<MachineScope, () => void>;
};

/** This PC's scope plus one per paired machine (reactive). */
export class Scopes {
  private readonly others = new SvelteMap<string, MachineScope & { stop?: () => void }>();
  private readonly observers = new Set<Observer>();
  private readonly pairedObservers = new Set<Observer>();

  constructor(private readonly here: MachineScope) {}

  local = (): MachineScope => this.here;

  get = (machineId: string): MachineScope | undefined =>
    machineId === this.here.machineId ? this.here : this.others.get(machineId);

  /** This PC first, then the paired machines in the order they appeared. */
  all = (): MachineScope[] => [this.here, ...this.others.values()];

  /**
   * Calls `cb` for every scope now (This PC first) and for each one that
   * appears later; the function `cb` returns runs when that scope goes (or
   * when the returned function stops observing). `paired`: the paired
   * machines' scopes only.
   */
  observe = (
    cb: (scope: MachineScope) => (() => void) | void,
    o: { paired?: boolean } = {},
  ): (() => void) => {
    const observer: Observer = { cb, seen: new Map() };
    const set = o.paired ? this.pairedObservers : this.observers;
    set.add(observer);
    for (const scope of o.paired ? [...this.others.values()] : this.all()) {
      this.attach(observer, scope);
    }
    return () => {
      set.delete(observer);
      for (const off of observer.seen.values()) off();
      observer.seen.clear();
    };
  };

  private attach = (observer: Observer, scope: MachineScope): void => {
    const off = observer.cb(scope);
    if (off) observer.seen.set(scope, off);
  };

  private added = (scope: MachineScope): void => {
    for (const observer of [...this.observers, ...this.pairedObservers]) {
      this.attach(observer, scope);
    }
  };

  private gone = (scope: MachineScope): void => {
    for (const observer of [...this.observers, ...this.pairedObservers]) {
      const off = observer.seen.get(scope);
      observer.seen.delete(scope);
      off?.();
    }
  };

  /**
   * Keeps a scope per paired machine: created (by `make`) when the machine
   * appears, dropped when it is removed, after its tabs are closed. Restored
   * tabs of machines missing from the first list (removed while the app was
   * closed) are closed once both the tabs and that list are in.
   */
  follow = (
    machines: Pick<MachinesState, 'onAdded' | 'onRemoved' | 'onListed' | 'listed' | 'list'>,
    tabs: Pick<TabsState, 'closeMachine' | 'keepMachines' | 'restored' | 'subscribe'>,
    make: (m: MachineEntry) => MachineScope & { stop?: () => void },
  ): void => {
    let pruned = false;
    const prune = (): void => {
      if (pruned || !machines.listed || !tabs.restored) return;
      pruned = true;
      offTabs();
      offListed();
      tabs.keepMachines(new Set(machines.list.map((m) => m.id)));
    };
    const offTabs = tabs.subscribe(prune);
    const offListed = machines.onListed(prune);
    prune();
    machines.onAdded((m) => {
      const old = this.others.get(m.id);
      if (old) {
        old.stop?.();
        this.gone(old);
      }
      const scope = make(m);
      this.others.set(m.id, scope);
      this.added(scope);
    });
    machines.onRemoved((id) => {
      tabs.closeMachine(id);
      const scope = this.others.get(id);
      this.others.delete(id);
      scope?.stop?.();
      if (scope) this.gone(scope);
    });
  };
}

/** The local service's client (wired and connected by `app.ts`). */
export const client = new ServiceClient();

/** This PC's scope is the app's singletons; one more scope per paired machine (see `app.ts`). */
export const scopes = new Scopes(
  makeScope(() => machineIdOf(client.hello), client, tabs, {
    places,
    sessions,
    chats,
    buckets,
    scheduled,
    interaction,
    yourTurn,
  }),
);
