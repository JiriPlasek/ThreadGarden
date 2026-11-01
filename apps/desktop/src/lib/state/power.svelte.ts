/**
 * Power control in the UI (remote machines, spec §7 and §10): each paired
 * machine's switch configuration and plug reading (from the local service,
 * which alone talks to the switch), the machine's own power status (over its
 * relay client), and what a machine is shown as: its link status refined by
 * the plug (Off, Starting…, Shutting down).
 */
import {
  POWER_CAPABILITY,
  POWER_ERRORS,
  type KeepAwake,
  type MachinePowerStatus,
  type PlugReading,
  type PowerConfig,
} from '@threadgarden/protocol';
import { powerPasswords } from '../native';
import { RequestError } from '../service/client';
import type { Api } from './api';
import type { MachineEntry, MachinesState, MachineStatus } from './machines.svelte';

/** Poll the plug this often while a machine is starting or shutting down. */
export const FAST_POLL_MS = 5_000;
/** Otherwise this often, and only while the window is visible. */
export const SLOW_POLL_MS = 60_000;
/** Starting… gives up after this long (spec §10). */
export const START_GIVE_UP_MS = 5 * 60_000;
/** High watts after the link was lost read as Shutting down this long after the last `shuttingDown`. */
export const SHUTDOWN_GRACE_MS = 3 * 60_000;

type Passwords = Pick<typeof powerPasswords, 'get' | 'set' | 'clear'>;
type Machines = Pick<
  MachinesState,
  'list' | 'get' | 'listed' | 'onAdded' | 'onRemoved' | 'onListed'
> &
  Partial<Pick<MachinesState, 'deriveWith'>>;

/** `localStorage` key: the machines still to be told that power control was removed (their ids). */
export const PENDING_REMOVALS_KEY = 'threadgarden.power.pendingRemovals';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export type PowerOptions = {
  passwords?: Passwords;
  /** Where pending removals are kept across restarts (default `localStorage`; null: nowhere). */
  storage?: Store | null;
  /** Whose `visibilitychange` decides whether to poll (default `document`; null: only `visible()`). */
  doc?: Document | null;
};

/** The plain sentence the UI shows for a failed power request. */
const plainError = (e: unknown): string => {
  const code = e instanceof RequestError ? e.code : null;
  switch (code) {
    case POWER_ERRORS.unreachable:
      return "The power switch can't be reached.";
    case POWER_ERRORS.auth:
      return 'The power switch refused its password.';
    case POWER_ERRORS.notConfigured:
      return "Power control isn't set up for this machine.";
    case 'DISCONNECTED':
    case 'TIMEOUT':
      return "Threadgarden's service didn't answer.";
    default:
      return e instanceof Error && e.message ? e.message : 'Something went wrong.';
  }
};

/** A running draw worth noting: none stored yet, or more than 5 % away from the stored one. */
const movedMuch = (stored: number | null, watts: number): boolean =>
  stored === null || Math.abs(watts - stored) > 0.05 * stored;

const hasPower = (m: MachineEntry | undefined): boolean =>
  !!m?.info?.capabilities.includes(POWER_CAPABILITY);

export class PowerState {
  private configs = $state<Record<string, PowerConfig>>({});
  private readings = $state<Record<string, PlugReading>>({});
  private statuses = $state<Record<string, MachinePowerStatus>>({});
  private errors = $state<Record<string, string>>({});
  /** When a `turnOn` began, by machine (cleared once the machine is on). */
  private startedAt = $state<Record<string, number>>({});
  /** When the machine last said `shuttingDown`, by machine (cleared once the plug reads off). */
  private shutSeenAt = $state<Record<string, number>>({});

  private api: Api | null = null;
  private machines: Machines | null = null;
  private passwords: Passwords = powerPasswords;
  private isVisible = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerMs = 0;
  /** The switch's wait before power comes back (`power.turnOn`'s `waitMs`), by machine. */
  private waits = $state<Record<string, number>>({});
  /** Bumped when a timed state (a start, the shutdown grace) runs out, so derivations rerun. */
  private clock = $state(0);
  private lastRead = new Map<string, number>();
  /** Machines that counted as starting or shutting down at the last tick. */
  private wasActive = new Set<string>();
  /** Whether each machine's link was open when its status last changed. */
  private linkOpen = new Map<string, boolean>();
  /** Machines whose standby draw is still to be measured (after a `shuttingDown`). */
  private awaitingStandby = new Set<string>();
  /** Machines sent `power.adopt` since their link last opened. */
  private adopted = new Set<string>();
  /** Machines removed here whose own copy of the configuration is still to be cleared. */
  private pending = $state<Record<string, true>>({});
  private storage: Store | null = null;
  private perMachine = new Map<string, () => void>();
  private blockedWatchers = new Set<(id: string) => void>();
  /** Machines last seen blocked (kept across a reconnect, so a reopened link does not announce it again). */
  private wasBlocked = new Set<string>();
  private offs: (() => void)[] = [];

  init = (localApi: Api, machines: Machines, opts: PowerOptions = {}): void => {
    this.stop();
    this.api = localApi;
    this.machines = machines;
    if (opts.passwords) this.passwords = opts.passwords;
    this.storage =
      opts.storage === undefined
        ? typeof localStorage === 'undefined'
          ? null
          : localStorage
        : opts.storage;
    this.pending = this.loadPending();
    machines.deriveWith?.(this.status);
    const doc = opts.doc === undefined ? (globalThis.document ?? null) : opts.doc;
    if (doc) {
      this.isVisible = doc.visibilityState !== 'hidden';
      const onVisibility = (): void => this.visible(doc.visibilityState !== 'hidden');
      doc.addEventListener('visibilitychange', onVisibility);
      this.offs.push(() => doc.removeEventListener('visibilitychange', onVisibility));
    }
    this.offs.push(
      machines.onAdded((m) => this.follow(m)),
      machines.onRemoved((id) => this.forget(id)),
      // After every local open (the machines are listed and unlocked by then).
      machines.onListed(() => void this.refresh()),
    );
    for (const m of machines.list) this.follow(m);
    if (machines.listed) void this.refresh();
  };

  /** Stops polling and listening (tests; the app's state lives as long as the window). */
  stop = (): void => {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerMs = 0;
    for (const off of this.offs) off();
    this.offs = [];
    for (const off of this.perMachine.values()) off();
    this.perMachine.clear();
    this.api = null;
  };

  config = (id: string): PowerConfig | null => this.configs[id] ?? null;
  reading = (id: string): PlugReading | null => this.readings[id] ?? null;
  machine = (id: string): MachinePowerStatus | null => this.statuses[id] ?? null;
  /** Power control was removed here but `machine` has not been told yet (it is off, or unreachable). */
  /** The machines whose idle shutdown is paused by unpushed work (spec §10): each wants an answer in Needs you. */
  blockedIds = (): string[] =>
    Object.entries(this.statuses)
      .filter(([, s]) => s.phase === 'blocked')
      .map(([id]) => id);

  /** Calls `cb` with a machine's id each time it goes into `blocked` (not again while it stays there). */
  onBlocked = (cb: (id: string) => void): (() => void) => {
    this.blockedWatchers.add(cb);
    return () => this.blockedWatchers.delete(cb);
  };

  pendingRemoval = (id: string): boolean => this.pending[id] === true;
  /** The last power request for the machine that failed, in plain words (null: none since). */
  error = (id: string): string | null => this.errors[id] ?? null;

  /**
   * What machine `id` is shown as, from its link status and the plug: the one
   * derivation every consumer uses (`MachinesState.shown`). Without power
   * control, or without a reading, the link status stands.
   */
  status = (id: string, link: MachineStatus): MachineStatus => {
    void this.clock;
    const config = this.configs[id];
    if (!config) return link;
    if (link === 'on') return this.statuses[id]?.phase === 'shuttingDown' ? 'shuttingDown' : 'on';
    // A machine that needs attention says so; the plug cannot fix that.
    if (link !== 'connecting' && link !== 'unreachable') return link;
    // Pressed Turn on: Starting… even while the switch waits out the minimum off time.
    if (this.turningOn(id)) return 'starting';
    const r = this.readings[id];
    if (!r) return link;
    if (r.on === false || (r.watts !== null && r.watts < config.offWatts)) return 'off';
    if (r.watts === null) return link;
    if (this.shuttingDownRecently(id)) return 'shuttingDown';
    return 'unreachable';
  };

  /**
   * A Turn on is pending: it began less than 5 min ago, the machine's link is
   * not on yet and it is not shutting down.
   */
  turningOn = (id: string): boolean => {
    void this.clock;
    return (
      this.startingRecently(id) &&
      this.machines?.get(id)?.status !== 'on' &&
      !this.shuttingDownRecently(id)
    );
  };

  /** While a Turn on is pending: how long the switch said it waits before power comes back (ms). */
  turnOnWait = (id: string): number | null =>
    this.turningOn(id) ? (this.waits[id] ?? null) : null;

  /** Turns the machine on through its switch; false (and `error(id)` says why) when that failed. */
  turnOn = async (id: string): Promise<boolean> => {
    const api = this.api;
    if (!api) return false;
    delete this.errors[id];
    delete this.shutSeenAt[id];
    delete this.waits[id];
    this.awaitingStandby.delete(id);
    this.startedAt[id] = Date.now();
    this.schedule();
    try {
      const { waitMs } = await api.request('power.turnOn', { machineId: id });
      if (this.startedAt[id] !== undefined) this.waits[id] = waitMs;
    } catch (e) {
      delete this.startedAt[id];
      this.errors[id] = plainError(e);
      this.schedule();
      return false;
    }
    void this.read(id);
    return true;
  };

  /** Asks the machine to shut down (`force`: despite unpushed work); null (see `error`) on failure. */
  shutDown = (id: string, force: boolean): Promise<MachinePowerStatus | null> =>
    this.onMachine(id, (m) => m.client.request('power.shutdown', { force }));

  keepAwake = (id: string, k: KeepAwake): Promise<MachinePowerStatus | null> =>
    this.onMachine(id, (m) => m.client.request('power.keepAwake', k));

  /**
   * Stores (null: removes) the machine's switch configuration on the local
   * service, keeps `password` in the keychain, and hands both to the machine
   * when it is on. Rejects when the local service refused it.
   */
  configure = async (
    id: string,
    config: PowerConfig | null,
    password?: string,
  ): Promise<PowerConfig | null> => {
    const api = this.api;
    if (!api) throw new Error('Power control is not ready.');
    // The keychain first: a configuration whose password could not be kept would not survive a restart.
    let restore: (() => Promise<void>) | null = null;
    if (config && password !== undefined) {
      const previous = await this.passwords.get(id);
      await this.passwords.set(id, password);
      restore = () =>
        previous === null ? this.passwords.clear(id) : this.passwords.set(id, previous);
    }
    const had = this.configs[id] !== undefined;
    let saved: PowerConfig | null;
    try {
      saved = await api.request('power.configure', {
        machineId: id,
        config,
        ...(password === undefined ? {} : { password }),
      });
    } catch (e) {
      await restore?.().catch(() => {});
      throw e;
    }
    if (saved) {
      this.configs[id] = saved;
      this.setPending(id, false);
    } else {
      await this.passwords.clear(id).catch(() => {});
      this.dropPlug(id);
    }
    delete this.errors[id];
    const m = this.machines?.get(id);
    if (m && hasPower(m) && m.client.status === 'open') {
      this.adopted.add(id);
      if (saved) void this.adopt(m, saved);
      else if (!(await this.adopt(m, null)) && had) this.setPending(id, true);
    } else if (!saved && m && had) {
      // Not reachable now: it is told the next time its link opens.
      this.setPending(id, true);
    }
    if (saved) void this.read(id);
    this.schedule();
    return saved;
  };

  /** Whether the window is visible: plug readings stop entirely while it is not. */
  visible = (v: boolean): void => {
    const was = this.isVisible;
    this.isVisible = v;
    if (v && !was) {
      // Timed states may have run out while hidden.
      this.clock++;
      void this.readAll();
    }
    this.schedule();
  };

  // ── the machine side ──────────────────────────────────────────────────────

  private follow = (m: MachineEntry): void => {
    if (m.local || this.perMachine.has(m.id)) return;
    const id = m.id;
    const offs = [
      m.client.on('power.changed', (s) => {
        if (hasPower(this.machines?.get(id))) this.setMachine(id, s);
      }),
      m.client.onOpen(() => void this.onMachineOpen(id)),
      m.client.onStatus((s) => this.onLink(id, s === 'open')),
    ];
    this.perMachine.set(id, () => offs.forEach((off) => off()));
    this.linkOpen.set(id, m.client.status === 'open');
    if (m.client.status === 'open') void this.onMachineOpen(id);
  };

  private onLink = (id: string, open: boolean): void => {
    const was = this.linkOpen.get(id) ?? false;
    this.linkOpen.set(id, open);
    // The link left on mid-shutdown: the grace for high watts counts from now.
    if (was && !open && this.statuses[id]?.phase === 'shuttingDown') {
      this.shutSeenAt[id] = Date.now();
    }
    this.schedule();
  };

  /** A paired machine was removed: so is its power control, here and in the keychain (best effort). */
  private forget = (id: string): void => {
    this.perMachine.get(id)?.();
    this.perMachine.delete(id);
    this.linkOpen.delete(id);
    this.dropPlug(id);
    delete this.statuses[id];
    delete this.errors[id];
    this.wasBlocked.delete(id);
    this.adopted.delete(id);
    // Unpaired: there is no machine left to tell.
    this.setPending(id, false);
    this.api?.request('power.configure', { machineId: id, config: null }).catch(() => {});
    this.passwords.clear(id).catch(() => {});
    this.schedule();
  };

  /** Forgets everything this PC knew about the machine's plug. */
  private dropPlug = (id: string): void => {
    for (const rec of [this.configs, this.readings, this.startedAt, this.shutSeenAt, this.waits])
      delete rec[id];
    this.lastRead.delete(id);
    this.wasActive.delete(id);
    this.awaitingStandby.delete(id);
  };

  private onMachineOpen = async (id: string): Promise<void> => {
    this.adopted.delete(id);
    // It is on: a turn-on is over, and whatever it said before it went away is stale.
    delete this.startedAt[id];
    delete this.waits[id];
    delete this.statuses[id];
    delete this.shutSeenAt[id];
    this.awaitingStandby.delete(id);
    this.schedule();
    const m = this.machines?.get(id);
    if (!m || !hasPower(m)) return;
    if (this.pending[id]) void this.sendRemoval(m);
    else this.maybeAdopt(id);
    if (this.configs[id]) void this.read(id);
    try {
      this.setMachine(id, await m.client.request('power.status', {}));
    } catch {
      // The link dropped again: the next open asks again.
    }
  };

  private setMachine = (id: string, s: MachinePowerStatus): void => {
    this.statuses[id] = s;
    if (s.phase !== 'blocked') this.wasBlocked.delete(id);
    else if (!this.wasBlocked.has(id)) {
      this.wasBlocked.add(id);
      for (const cb of this.blockedWatchers) cb(id);
    }
    if (s.phase === 'shuttingDown') {
      this.shutSeenAt[id] = Date.now();
      delete this.startedAt[id];
      delete this.waits[id];
      this.awaitingStandby.add(id);
    } else {
      delete this.shutSeenAt[id];
      this.awaitingStandby.delete(id);
    }
    this.schedule();
  };

  /**
   * A machine on, with power control, while this PC has its configuration:
   * hand it over once per link open, so a change made while it was off reaches it.
   */
  private maybeAdopt = (id: string): void => {
    const m = this.machines?.get(id);
    const config = this.configs[id];
    if (!m || !config || !hasPower(m) || m.client.status !== 'open') return;
    if (this.adopted.has(id)) return;
    this.adopted.add(id);
    void this.adopt(m, config);
  };

  /** Tells a machine to forget its configuration; the entry stays until it did, and is tried again at the next open. */
  private sendRemoval = async (m: MachineEntry): Promise<void> => {
    if (await this.adopt(m, null)) this.setPending(m.id, false);
  };

  private loadPending = (): Record<string, true> => {
    try {
      const ids: unknown = JSON.parse(this.storage?.getItem(PENDING_REMOVALS_KEY) ?? '[]');
      return Array.isArray(ids)
        ? Object.fromEntries(ids.filter((i) => typeof i === 'string').map((i) => [i, true]))
        : {};
    } catch {
      return {};
    }
  };

  private setPending = (id: string, on: boolean): void => {
    if ((this.pending[id] === true) === on) return;
    if (on) this.pending[id] = true;
    else delete this.pending[id];
    try {
      this.storage?.setItem(PENDING_REMOVALS_KEY, JSON.stringify(Object.keys(this.pending)));
    } catch {
      // Kept for this run only.
    }
  };

  private adopt = async (m: MachineEntry, config: PowerConfig | null): Promise<boolean> => {
    try {
      const password = config ? await this.passwords.get(m.id) : null;
      await m.client.request('power.adopt', {
        config,
        ...(password ? { password } : {}),
      });
      return true;
    } catch (e) {
      // The next time its link opens it is tried again.
      this.adopted.delete(m.id);
      this.errors[m.id] = plainError(e);
      return false;
    }
  };

  private onMachine = async (
    id: string,
    call: (m: MachineEntry) => Promise<MachinePowerStatus>,
  ): Promise<MachinePowerStatus | null> => {
    const m = this.machines?.get(id);
    if (!m) return null;
    delete this.errors[id];
    try {
      const s = await call(m);
      this.setMachine(id, s);
      return s;
    } catch (e) {
      this.errors[id] = plainError(e);
      return null;
    }
  };

  // ── the plug (local service) ──────────────────────────────────────────────

  /** After every local open: unlock each stored switch password, then list and read. */
  private refresh = async (): Promise<void> => {
    const api = this.api;
    const machines = this.machines;
    if (!api || !machines) return;
    for (const m of machines.list) {
      if (m.local) continue;
      try {
        const password = await this.passwords.get(m.id);
        if (password) await api.request('power.unlock', { machineId: m.id, password });
      } catch {
        // No keychain or no link: readings say "not configured" until the next open.
      }
    }
    let list: { machineId: string; config: PowerConfig }[];
    try {
      list = await api.request('power.list', {});
    } catch {
      return;
    }
    if (this.api !== api) return;
    // Only machines paired now: a row left behind for one removed is never polled.
    const paired = new Set(machines.list.filter((m) => !m.local).map((m) => m.id));
    const next = Object.fromEntries(
      list.filter((p) => paired.has(p.machineId)).map((p) => [p.machineId, p.config]),
    );
    for (const id of Object.keys(this.configs)) if (!next[id]) this.dropPlug(id);
    this.configs = next;
    for (const id of Object.keys(next)) this.maybeAdopt(id);
    await this.readAll();
    this.schedule();
  };

  private readAll = async (): Promise<void> => {
    await Promise.all(Object.keys(this.configs).map((id) => this.read(id)));
  };

  private read = async (id: string): Promise<void> => {
    const api = this.api;
    if (!api || !this.configs[id]) return;
    this.lastRead.set(id, Date.now());
    let r: PlugReading;
    try {
      r = await api.request('power.reading', { machineId: id });
    } catch {
      // An unknown plug: the link status stands until a reading comes back.
      delete this.readings[id];
      this.schedule();
      return;
    }
    const config = this.configs[id];
    if (!config || this.api !== api) return;
    this.readings[id] = r;
    this.measure(id, config, r);
    if (r.on === false || (r.watts !== null && r.watts < config.offWatts)) {
      // Down: the shutdown is over.
      delete this.shutSeenAt[id];
    }
    this.schedule();
  };

  /** Learns the PC's running and standby draw from readings (spec §10). */
  private measure = (id: string, config: PowerConfig, r: PlugReading): void => {
    if (r.watts === null || !this.api) return;
    const link = this.machines?.get(id)?.status;
    let kind: 'running' | 'standby' | null = null;
    if (this.awaitingStandby.has(id) && r.watts < config.offWatts) {
      this.awaitingStandby.delete(id);
      // A plug already cut reads 0 W: that is not the PC's standby draw.
      if (r.on !== false) kind = 'standby';
    } else if (
      link === 'on' &&
      this.statuses[id]?.phase !== 'shuttingDown' &&
      movedMuch(config.measured.running, r.watts)
    ) {
      kind = 'running';
    }
    if (!kind) return;
    const watts = r.watts;
    this.configs[id] = { ...config, measured: { ...config.measured, [kind]: watts } };
    this.api.request('power.noteMeasurement', { machineId: id, kind, watts }).catch(() => {});
  };

  // ── polling ───────────────────────────────────────────────────────────────

  private startingRecently = (id: string): boolean => {
    const at = this.startedAt[id];
    return at !== undefined && Date.now() - at < START_GIVE_UP_MS;
  };

  private shuttingDownRecently = (id: string): boolean => {
    const at = this.shutSeenAt[id];
    return at !== undefined && Date.now() - at < SHUTDOWN_GRACE_MS;
  };

  /** Starting or shutting down: worth a reading every few seconds. */
  private active = (id: string): boolean => this.shuttingDownRecently(id) || this.turningOn(id);

  private wantedMs = (): number => {
    const ids = Object.keys(this.configs);
    if (!this.api || !this.isVisible || ids.length === 0) return 0;
    return ids.some(this.active) ? FAST_POLL_MS : SLOW_POLL_MS;
  };

  /** (Re)arms the one polling timer for the interval wanted now; none at all when nothing to poll. */
  private schedule = (): void => {
    const want = this.wantedMs();
    if (this.timer !== undefined && want === this.timerMs) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerMs = want;
    if (want > 0) this.timer = setTimeout(this.tick, want);
  };

  private tick = async (): Promise<void> => {
    this.timer = undefined;
    this.timerMs = 0;
    const now = Date.now();
    const ids = Object.keys(this.configs);
    const active = new Set(ids.filter((id) => this.active(id)));
    // A start or a shutdown grace that just ran out: show what the machine is now, at once.
    const expired = [...this.wasActive].filter((id) => !active.has(id) && this.configs[id]);
    this.wasActive = active;
    if (expired.length > 0) this.clock++;
    const due = ids.filter(
      (id) =>
        active.has(id) ||
        expired.includes(id) ||
        now - (this.lastRead.get(id) ?? 0) >= SLOW_POLL_MS - FAST_POLL_MS,
    );
    await Promise.all(due.map((id) => this.read(id)));
    this.schedule();
  };
}

export const power = new PowerState();
