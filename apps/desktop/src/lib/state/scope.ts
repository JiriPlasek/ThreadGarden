/**
 * Machine scopes: every machine gets its own set of the per-machine stores,
 * talking to that machine's client. This PC's scope is made of the app's
 * singletons, so a user with only This PC runs exactly what ran before.
 */
import { SvelteMap } from 'svelte/reactivity';
import { ServiceClient } from '../service/client';
import type { AgentsState } from './agents.svelte';
import type { Api } from './api';
import { buckets, BucketsState } from './buckets.svelte';
import { chats, ChatsState, type ChatsOptions } from './chats.svelte';
import { interaction, InteractionState } from './interaction.svelte';
import type { MachineEntry, MachinesState } from './machines.svelte';
import { places, PlacesState } from './places.svelte';
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
  /** What the agents strip lists ("Your turn" reads it); none for a machine the strip does not cover yet. */
  agents?: Pick<AgentsState, 'items'>;
  chats?: ChatsOptions;
};

const NO_AGENTS: Pick<AgentsState, 'items'> = { items: [] };

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
export const wireScope = (scope: MachineScope, deps: ScopeDeps): (() => void) => {
  const { api, places, sessions, chats, interaction, buckets, scheduled, yourTurn } = scope;
  places.init(api, { localMachineId: deps.tabs.localMachineId });
  sessions.init(api, places);
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
    agents: deps.agents ?? NO_AGENTS,
  });
  return () => {
    offTabs();
    offOpen();
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
  const stop = wireScope(scope, deps);
  return Object.assign(scope, { stop });
};

/** This PC's scope plus one per paired machine (reactive). */
export class Scopes {
  private readonly others = new SvelteMap<string, MachineScope & { stop?: () => void }>();

  constructor(private readonly here: MachineScope) {}

  local = (): MachineScope => this.here;

  get = (machineId: string): MachineScope | undefined =>
    machineId === this.here.machineId ? this.here : this.others.get(machineId);

  /** This PC first, then the paired machines in the order they appeared. */
  all = (): MachineScope[] => [this.here, ...this.others.values()];

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
      this.others.get(m.id)?.stop?.();
      this.others.set(m.id, make(m));
    });
    machines.onRemoved((id) => {
      tabs.closeMachine(id);
      const scope = this.others.get(id);
      this.others.delete(id);
      scope?.stop?.();
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
