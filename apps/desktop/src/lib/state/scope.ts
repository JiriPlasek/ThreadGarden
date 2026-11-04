/**
 * Machine scopes: every machine gets its own set of the per-machine stores,
 * talking to that machine's client. This PC's scope is made of the app's
 * singletons, so a user with only This PC runs exactly what ran before.
 */
import { SvelteMap } from 'svelte/reactivity';
import { ServiceClient } from '../service/client';
import type { AgentsState } from './agents.svelte';
import { quietly, type Api } from './api';
import { CopyState, type AwayState } from './away.svelte';
import { buckets, BucketsState } from './buckets.svelte';
import { chats, ChatsState, type ChatsOptions } from './chats.svelte';
import { copyApi, type CopyApiOptions } from './copy-api';
import { interaction, InteractionState } from './interaction.svelte';
import type { MachineEntry, MachinesState } from './machines.svelte';
import { listedAcross } from './merged-list.svelte';
import { places, PlacesState, type Place } from './places.svelte';
import { machineIdOf } from './refs';
import { scheduled, ScheduledState } from './scheduled.svelte';
import { sessions, SessionsState } from './sessions.svelte';
import { tabs, type MachineTabs, type TabsState } from './tabs.svelte';
import { usage, UsageStore } from './usage.svelte';
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
  /** The machine's plan usage and the chats a usage limit refused. */
  usage: UsageStore;
  /** The tabs as this machine sees them (session ids of its own tabs). */
  tabs: MachineTabs;
  /** A paired machine's copy, read while it is away (This PC has none). */
  copy?: CopyState;
};

type ScopeStores = Omit<MachineScope, 'machineId' | 'api' | 'tabs' | 'copy'>;

export type ScopeDeps = {
  tabs: TabsState;
  /** What the agents strip lists ("Your turn" reads this machine's rows of it). */
  agents?: Pick<AgentsState, 'items'>;
  chats?: ChatsOptions;
  /**
   * This PC's: all scopes. While a machine is paired, the cross-machine
   * places are listed across machines, not by This PC's `sessions`.
   */
  scopes?: Pick<Scopes, 'all' | 'observe'>;
  /**
   * A paired machine's: the local service that keeps its copy and queue, its
   * name and its last hello. While it is away, its scope reads the copy (`copyApi`).
   */
  copies?: Pick<CopyApiOptions, 'name' | 'hello'> & {
    local: Pick<Api, 'request'>;
    /** The messages waiting on this device: a chat's later ones wait behind its first. */
    away?: Pick<AwayState, 'items'>;
  };
};

/** A send (or its resume check) for a chat whose first message is still waiting here. */
const behindCreate = (
  method: string,
  params: unknown,
  waitsForCreate: (sessionId: string) => boolean,
): boolean =>
  (method === 'chat.send' || method === 'chat.resumeCheck') &&
  waitsForCreate((params as { sessionId: string }).sessionId);

/**
 * The machine's own client while it is connected, its copy on this device
 * while it is away: the lists and the chat view read through it either way,
 * and none of them asks a machine that isn't there.
 *
 * A message for a chat whose first message still waits on this device
 * (`waitsForCreate`) waits behind it, even once the machine is connected:
 * the machine doesn't have that chat until the waiting one has gone out.
 */
export const awayAware = (
  link: Api,
  copy: Pick<Api, 'request'>,
  waitsForCreate: (sessionId: string) => boolean = () => false,
): Api => ({
  get status() {
    return link.status;
  },
  request: (method, params) =>
    link.status === 'open' && !behindCreate(method, params, waitsForCreate)
      ? link.request(method, params)
      : copy.request(method, params),
  on: link.on,
  onReconnect: link.onReconnect,
  onOpen: link.onOpen,
  onStatus: link.onStatus,
});

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
  places.init(api, {
    localMachineId: deps.tabs.localMachineId,
    machineId: () => scope.machineId,
  });
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

/**
 * A paired machine's scope: new store instances on `link` (its relay client),
 * or, while it is away and `deps.copies` is given, on its copy.
 */
export const createScope = (
  machineId: string,
  link: Api,
  deps: ScopeDeps,
): MachineScope & { stop: () => void } => {
  const copy = deps.copies ? new CopyState() : undefined;
  const api =
    deps.copies && copy
      ? awayAware(
          link,
          copyApi(machineId, deps.copies.local, {
            name: deps.copies.name,
            hello: deps.copies.hello,
            seen: copy.seen,
          }),
          // Whatever its state: a message behind a failed one fails behind it (R8).
          (sessionId) =>
            deps.copies?.away?.items({ machineId, sessionId }).some((i) => i.kind === 'create') ??
            false,
        )
      : link;
  const scope = makeScope(() => machineId, api, deps.tabs, {
    places: new PlacesState(),
    sessions: new SessionsState(),
    chats: new ChatsState(),
    buckets: new BucketsState(),
    scheduled: new ScheduledState(),
    interaction: new InteractionState(),
    yourTurn: new YourTurnState(),
    // Its last usage is kept, so the machine's account still shows while it is off.
    usage: new UsageStore({ remember: machineId }),
  });
  scope.copy = copy;
  // Its `sessions` lists its projects; the other places are listed across machines.
  const unwire = wireScope(scope, deps, { projectsOnly: true });
  // This PC's usage is initialised by `app.ts`, as it always was.
  scope.usage.init(api);
  // Away: its projects, counts and lists come from the copy, read now and each
  // time the link drops (an open reads the machine itself, as always).
  let open = link.status === 'open';
  const readCopy = (): void => {
    quietly(scope.places.refresh());
    quietly(scope.sessions.reload(true));
  };
  const offStatus = copy
    ? link.onStatus((s) => {
        const was = open;
        open = s === 'open';
        if (was && !open) readCopy();
      })
    : undefined;
  if (copy && !open) readCopy();
  const stop = (): void => {
    unwire();
    offStatus?.();
    scope.usage.stop();
  };
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
      // Its kept usage goes too: pairing it again must not show the old windows.
      scope?.usage.forget();
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
    usage,
  }),
);
