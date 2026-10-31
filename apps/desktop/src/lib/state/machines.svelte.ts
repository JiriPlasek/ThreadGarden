import {
  acceptsRemoteProtocol,
  RELAY_CLOSE,
  type MachineInfo,
  type PairedMachine,
} from '@threadgarden/protocol';
import { machineTokens } from '../native';
import { ServiceClient, type ClientOptions, type ClientStatus } from '../service/client';
import { quietly, type Api } from './api';
import { LOCAL_FALLBACK_ID, THIS_PC } from './refs';

export type MachineStatus =
  'connecting' | 'on' | 'unreachable' | 'locked' | 'incompatible' | 'mismatch' | 'refused';

export type MachineEntry = {
  id: string;
  name: string;
  address: string;
  port: number;
  local: boolean;
  status: MachineStatus;
  info: MachineInfo | null;
  client: ServiceClient;
};

export type MachinesOptions = {
  /** The local relay's URL for a machine (`ws://127.0.0.1:<port>/relay?machine=<id>`). */
  relayUrl(machineId: string): string;
  /** The local service's token, which the relay accepts too. */
  localToken(): string;
  tokens?: Pick<typeof machineTokens, 'get' | 'set' | 'clear'>;
  makeClient?: (o: ClientOptions) => ServiceClient;
};

/** `uiState` key: the machines whose group in the places column is collapsed (their ids). */
export const COLLAPSED_KEY = 'machines.collapsed';
/** `uiState` key: the paired machines whose "Missing folders" group is expanded (their ids). */
export const MISSING_OPEN_KEY = 'machines.missingOpen';

/** How the UI names a machine: This PC for the local one. */
export const machineLabel = (m: Pick<MachineEntry, 'local' | 'name'>): string =>
  m.local ? THIS_PC : m.name;

/** How the UI names the machine `id` (This PC for one it does not know, e.g. before its service answered). */
export const machineNameOf = (machines: Pick<MachinesState, 'get'>, id: string): string => {
  const m = machines.get(id);
  return m ? machineLabel(m) : THIS_PC;
};

/** The names of the machines that are on (This PC first), e.g. for "Stop all work". */
export const onMachineNames = (machines: Pick<MachinesState, 'list'>): string[] =>
  machines.list.filter((m) => m.status === 'on').map(machineLabel);

/** A machine's relay on the local service (the UI never connects anywhere but loopback). */
export const relayUrl = (localPort: number, machineId: string): string =>
  `ws://127.0.0.1:${localPort}/relay?machine=${encodeURIComponent(machineId)}`;

const fromLocalStatus = (s: ClientStatus): MachineStatus =>
  s === 'open'
    ? 'on'
    : s === 'incompatible'
      ? 'incompatible'
      : s === 'reconnecting' || s === 'closed'
        ? 'unreachable'
        : 'connecting';

/**
 * This PC plus every paired machine, each with its own client: a paired
 * machine's client talks to the local service's relay, which pipes to the
 * machine over pinned TLS. The UI never leaves loopback.
 */
export class MachinesState {
  private paired = $state<MachineEntry[]>([]);
  private localEntry = $state<MachineEntry | null>(null);
  /** Machines whose group in the places column is collapsed (kept in the local `uiState`). */
  collapsed = $state<string[]>([]);
  /**
   * Paired machines whose "Missing folders" group is expanded (kept in the
   * local `uiState`; This PC's keeps its own `places.missingOpen`).
   */
  missingOpen = $state<string[]>([]);

  private localApi!: Api;
  private localClient!: ServiceClient;
  private opts!: MachinesOptions;
  private tokens: Pick<typeof machineTokens, 'get' | 'set' | 'clear'> = machineTokens;
  private makeClient: (o: ClientOptions) => ServiceClient = (o) => new ServiceClient(o);
  private everOn = new Set<string>();
  private pairing = 0;
  private removing = new Set<string>();
  private removals = new Map<string, Promise<boolean>>();
  private readonly added = new Set<(m: MachineEntry) => void>();
  private readonly removedCbs = new Set<(id: string) => void>();
  private readonly listedCbs = new Set<() => void>();
  private everListed = false;

  /** This PC first, then the paired machines in the service's order. */
  get list(): MachineEntry[] {
    return this.localEntry ? [this.localEntry, ...this.paired] : this.paired;
  }

  get local(): MachineEntry | null {
    return this.localEntry;
  }

  /**
   * More than one machine: the places column groups projects by machine and
   * cross-machine rows carry a machine chip (one test for both).
   */
  get several(): boolean {
    return this.list.length > 1;
  }

  get = (id: string): MachineEntry | undefined => this.list.find((m) => m.id === id);

  init = (localApi: Api, localClient: ServiceClient, opts: MachinesOptions): void => {
    this.localApi = localApi;
    this.localClient = localClient;
    this.opts = opts;
    if (opts.tokens) this.tokens = opts.tokens;
    if (opts.makeClient) this.makeClient = opts.makeClient;
    localClient.onStatus((s) => {
      if (this.localEntry) this.localEntry.status = fromLocalStatus(s);
    });
    localClient.onOpen(() => this.onLocalOpen());
    localApi.on('machines.changed', (list) => this.apply(list, false));
    if (localClient.status === 'open') void this.onLocalOpen();
  };

  onAdded = (cb: (m: MachineEntry) => void): (() => void) => {
    this.added.add(cb);
    return () => this.added.delete(cb);
  };

  onRemoved = (cb: (id: string) => void): (() => void) => {
    this.removedCbs.add(cb);
    return () => this.removedCbs.delete(cb);
  };

  /** True once the local service has listed the paired machines (`list` is complete). */
  get listed(): boolean {
    return this.everListed;
  }

  /** Called after the local service listed the paired machines (on every local open). */
  onListed = (cb: () => void): (() => void) => {
    this.listedCbs.add(cb);
    return () => this.listedCbs.delete(cb);
  };

  pair = async (p: {
    address: string;
    port?: number;
    code: string;
    deviceName: string;
  }): Promise<MachineEntry> => {
    this.pairing++;
    try {
      const { machine, token } = await this.localApi.request('machines.pair', p);
      try {
        await this.tokens.set(machine.id, token);
      } catch (e) {
        // No token in the keychain: the pairing would be unusable, so undo it.
        await this.localApi
          .request('machines.remove', { machineId: machine.id, revoke: true })
          .catch(() => {});
        // A machines.changed event may have created the entry meanwhile.
        this.drop(machine.id);
        throw e;
      }
      const entry = this.ensure(machine);
      this.update(entry, machine);
      // The service already holds the token (pairing unlocks it).
      this.connectEntry(entry.id, token);
      return this.get(machine.id) ?? entry;
    } finally {
      this.pairing--;
    }
  };

  /** Loads which machine groups are collapsed (none when unknown). */
  restoreCollapsed = async (): Promise<void> => {
    this.collapsed = (await this.loadIds(COLLAPSED_KEY)) ?? this.collapsed;
  };

  setCollapsed = (id: string, collapsed: boolean): void => {
    const next = this.saveIds(COLLAPSED_KEY, this.collapsed, id, collapsed);
    if (next) this.collapsed = next;
  };

  /** Loads which paired machines' "Missing folders" groups are expanded (none when unknown). */
  restoreMissingOpen = async (): Promise<void> => {
    this.missingOpen = (await this.loadIds(MISSING_OPEN_KEY)) ?? this.missingOpen;
  };

  setMissingOpen = (id: string, open: boolean): void => {
    const next = this.saveIds(MISSING_OPEN_KEY, this.missingOpen, id, open);
    if (next) this.missingOpen = next;
  };

  /** A list of machine ids kept in the local `uiState` under `key` (null when unknown). */
  private loadIds = async (key: string): Promise<string[] | null> => {
    try {
      const { value } = await this.localApi.request('uiState.get', { key });
      return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : null;
    } catch {
      return null;
    }
  };

  /** `ids` with `id` in or out, stored under `key`; null when nothing changes. */
  private saveIds = (key: string, ids: string[], id: string, on: boolean): string[] | null => {
    if (ids.includes(id) === on) return null;
    const next = on ? [...ids, id] : ids.filter((x) => x !== id);
    quietly(this.localApi.request('uiState.set', { key, value: next }));
    return next;
  };

  rename = async (id: string, name: string): Promise<void> => {
    const m = await this.localApi.request('machines.update', { machineId: id, name });
    this.applyOne(m);
  };

  setAddress = async (id: string, address: string, port?: number): Promise<void> => {
    const m = await this.localApi.request('machines.update', {
      machineId: id,
      address,
      ...(port === undefined ? {} : { port }),
    });
    this.applyOne(m);
  };

  /** Forgets the machine; true when it confirmed revoking this device (false: it still lists this PC). */
  remove = (id: string): Promise<boolean> => {
    // A second call while one is in flight shares it, so the first `finally` cannot clear the mark early.
    const running = this.removals.get(id);
    if (running) return running;
    const p = this.doRemove(id).finally(() => this.removals.delete(id));
    this.removals.set(id, p);
    return p;
  };

  private doRemove = async (id: string): Promise<boolean> => {
    // Marked first: a connect already awaiting the keychain or the unlock must not revive the client.
    this.removing.add(id);
    this.paired.find((m) => m.id === id)?.client.close();
    try {
      const { revoked } = await this.localApi.request('machines.remove', {
        machineId: id,
        revoke: true,
      });
      return revoked;
    } finally {
      await this.tokens.clear(id).catch(() => {});
      this.drop(id);
      this.removing.delete(id);
    }
  };

  private onLocalOpen = async (): Promise<void> => {
    const hello = this.localClient.hello;
    const machine = hello?.machine ?? null;
    if (!this.localEntry) {
      this.localEntry = {
        id: machine?.id ?? LOCAL_FALLBACK_ID,
        name: machine?.name ?? THIS_PC,
        address: '127.0.0.1',
        port: 0,
        local: true,
        status: 'on',
        info: machine,
        client: this.localClient,
      };
    } else {
      this.localEntry.info = machine;
      if (machine) {
        this.localEntry.id = machine.id;
        this.localEntry.name = machine.name;
      }
      this.localEntry.status = 'on';
    }
    try {
      this.apply(await this.localApi.request('machines.list', {}), true);
      this.everListed = true;
      for (const cb of this.listedCbs) cb();
    } catch {
      // The local link dropped again: the next open retries.
    }
  };

  /** Brings the entries in line with `list`; `reopen`: unlock and (re)connect all, as after a local (re)start. */
  private apply = (list: PairedMachine[], reopen: boolean): void => {
    const ids = new Set(list.map((m) => m.id));
    for (const e of [...this.paired]) if (!ids.has(e.id)) this.drop(e.id);
    // Keep the service's order.
    const order = new Map(list.map((m, i) => [m.id, i]));
    this.paired.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    for (const m of list) {
      const known = this.paired.some((e) => e.id === m.id);
      const entry = this.ensure(m);
      const moved = this.update(entry, m);
      if (reopen || (!known && this.pairing === 0)) this.connectEntry(entry.id);
      else if (moved) this.connectEntry(entry.id);
    }
  };

  private applyOne = (m: PairedMachine): void => {
    const entry = this.ensure(m);
    if (this.update(entry, m)) this.connectEntry(entry.id);
  };

  /** Creates the entry for `m` when missing (no connection yet). */
  private ensure = (m: PairedMachine): MachineEntry => {
    const existing = this.paired.find((e) => e.id === m.id);
    if (existing) return existing;
    const id = m.id;
    const client = this.makeClient({
      acceptProtocol: acceptsRemoteProtocol,
      onClose: (code) => this.onRelayClose(id, code),
      // Defence in depth (spec §6): the relay pins the certificate, and the
      // machine must also be the one paired. A service too old to say is let through.
      acceptHello: (hello) => {
        const seen = hello.machine?.id;
        if (seen === undefined || seen === id) return true;
        const e = this.paired.find((x) => x.id === id);
        if (e) {
          e.status = 'mismatch';
          e.info = null;
        }
        return false;
      },
    });
    client.onStatus((s) => {
      const e = this.paired.find((x) => x.id === id);
      if (!e) return;
      if (s === 'open') {
        this.everOn.add(id);
        e.status = 'on';
      } else if (s === 'incompatible') e.status = 'incompatible';
      else if (s !== 'closed' && e.status === 'on') e.status = 'unreachable';
    });
    client.onOpen(() => {
      const e = this.paired.find((x) => x.id === id);
      if (e) e.info = client.hello?.machine ?? null;
    });
    this.paired.push({
      id,
      name: m.name,
      address: m.address,
      port: m.port,
      local: false,
      status: 'connecting',
      info: null,
      client,
    });
    const entry = this.paired.find((e) => e.id === id)!;
    for (const cb of this.added) cb(entry);
    return entry;
  };

  /** Copies the service's view onto the entry; true when the address or port changed. */
  private update = (entry: MachineEntry, m: PairedMachine): boolean => {
    const moved = entry.address !== m.address || entry.port !== m.port;
    entry.name = m.name;
    entry.address = m.address;
    entry.port = m.port;
    return moved;
  };

  private drop = (id: string): void => {
    const i = this.paired.findIndex((m) => m.id === id);
    if (i < 0) return;
    this.paired[i]!.client.close();
    this.paired.splice(i, 1);
    this.everOn.delete(id);
    for (const cb of this.removedCbs) cb(id);
  };

  private onRelayClose = (id: string, code: number): 'retry' | 'stop' => {
    const e = this.paired.find((x) => x.id === id);
    const stop = (status: MachineStatus): 'stop' => {
      if (e) e.status = status;
      return 'stop';
    };
    if (code === RELAY_CLOSE.locked || code === 4401) return stop('locked');
    if (code === RELAY_CLOSE.mismatch) return stop('mismatch');
    if (code === RELAY_CLOSE.refused) return stop('refused');
    if (e) {
      e.status =
        code === RELAY_CLOSE.unreachable || this.everOn.has(id) ? 'unreachable' : 'connecting';
    }
    return 'retry';
  };

  /**
   * Hands the keychain token (or `token`, just paired) to the local service and
   * (re)connects the machine's relay client. No token: the machine stays locked.
   */
  private connectEntry = (id: string, token?: string): void => {
    void (async () => {
      if (this.removing.has(id) || !this.paired.some((e) => e.id === id)) return;
      try {
        const t = token ?? (await this.tokens.get(id));
        if (this.removing.has(id)) return;
        if (!t) return this.lock(id, true);
        await this.localApi.request('machines.unlock', { machineId: id, token: t });
      } catch {
        // Unlock failed (local link down or machine unknown): the next local open retries.
        return this.lock(id, false);
      }
      const e = this.paired.find((x) => x.id === id);
      if (!e || this.removing.has(id)) return;
      e.status = 'connecting';
      e.client.connect(this.opts.relayUrl(id), this.opts.localToken()).catch(() => {});
    })();
  };

  private lock = (id: string, closeClient: boolean): void => {
    const e = this.paired.find((x) => x.id === id);
    if (!e) return;
    if (closeClient) e.client.close();
    e.status = 'locked';
  };
}

export const machines = new MachinesState();
