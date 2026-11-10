/**
 * Updating a paired machine from the desktop (machine update spec): which
 * release is the latest, which machines are behind it, and the flow of one
 * update.
 */
import { UPDATE_ERRORS, type UpdateStage, type UpdateStatus } from '@threadgarden/protocol';
import { RECONNECT_WAIT_MS, START_WAIT_MS } from '../move/move-chat.svelte';
import { RequestError, type ServiceClient } from '../service/client';
import type { Api } from './api';
import { bringUp, pause } from './bring-up';
import { compareVersions } from './connection.svelte';
import { machineNameOf, type MachineEntry, type MachinesState } from './machines.svelte';
import type { PowerState } from './power.svelte';
import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS } from './updates.svelte';

/** Opening Settings asks for the latest release when the last answer is older than this. */
const FRESH_MS = 10 * 60_000;
/** How often the status of a running update is read. */
const POLL_MS = 2_000;
/** The apply script gives a new version this long to start before it rolls back. */
const ROLLBACK_MS = 90_000;
/** How long a machine may stay away or stay restarting before the card says so. */
const FOLLOW_WAIT_MS = RECONNECT_WAIT_MS + ROLLBACK_MS;

export type MachineUpdatesDeps = {
  /** The local service, which alone asks GitHub. */
  api: Pick<Api, 'request'>;
  machines: Pick<
    MachinesState,
    'list' | 'get' | 'shown' | 'onAdded' | 'onRemoved' | 'openForUpdate' | 'reconnect'
  >;
  power: Pick<PowerState, 'turnOn' | 'error'>;
  now?: () => number;
};

type Versioned = Pick<MachineEntry, 'version' | 'canUpdate'>;

/** What the card shows while updating. */
type Stage = 'turningOn' | UpdateStage;

/** How an update ended. */
export type UpdateOutcome = Extract<UpdateStatus, { state: 'done' | 'failed' }>;

/** Which update it is. */
type Target = { version: string; from: string };

/** An update being followed. */
type Watch = Target & {
  /** The update-only client, while the entry's can't be used; closed when the watch ends. */
  side: ServiceClient | null;
  /** When to stop waiting for the machine (null: it answers, and isn't restarting). */
  giveUpAt: number | null;
};

/** A machine turned on came up too new or too old for this desktop's client: its link never reads on. */
const OUT_OF_RANGE = new Error('Outside the protocol range');

const errorText = (e: unknown): string =>
  e instanceof Error && e.message ? e.message : 'Something went wrong.';

export class MachineUpdatesState {
  /** The newest published release (null: not known yet). */
  latest = $state<string | null>(null);

  private stages = $state<Record<string, Stage>>({});
  /** The version each followed update goes to; `latest` may be another, or not known. */
  private targets = $state<Record<string, string>>({});
  private outcomes = $state<Record<string, UpdateOutcome>>({});

  private deps = $state.raw<MachineUpdatesDeps | null>(null);
  /** Machines whose `update.start` is under way: what they say meanwhile is not read yet. */
  private starting = new Set<string>();
  /** The updates being followed, by machine. */
  private watches = new Map<string, Watch>();
  /** What to stop listening to, by machine. */
  private followed = new Map<string, () => void>();
  private offs: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the latest release last answered. */
  private lastCheck: number | null = null;

  /** The machine runs an older version than the latest release and can update itself. */
  behind = (m: Versioned): boolean =>
    !!m.version && !!this.latest && compareVersions(m.version, this.latest) < 0 && m.canUpdate;

  /** Any machine is behind: the dot on Settings. */
  get anyBehind(): boolean {
    return !!this.deps?.machines.list.some(this.behind);
  }

  /** The machine's version is known, and it is too old to update from here (once more over SSH). */
  tooOld = (m: Versioned): boolean => m.version !== null && !m.canUpdate;

  /** How far the machine's update is (null: none running here). */
  stage = (id: string): Stage | null => this.stages[id] ?? null;

  /** The version the machine's running update goes to (null: none followed here). */
  target = (id: string): string | null => this.targets[id] ?? null;

  /**
   * How the machine's last update ended (done or failed), until a new one
   * starts or the machine says idle. The machine keeps saying it for good, also
   * once it was updated by hand, so it counts only while it fits the version
   * running now: a failure while the machine is still older, a done for that very version.
   */
  outcome = (id: string): UpdateOutcome | null => {
    const s = this.outcomes[id];
    const running = this.deps?.machines.get(id)?.version;
    if (!s || !running) return null;
    const holds =
      s.state === 'done' ? s.version === running : compareVersions(running, s.version) < 0;
    return holds ? s : null;
  };

  /**
   * Update can do something for the machine now: it answers, or its power
   * control can bring it up. The card's button is disabled otherwise.
   */
  canStart = (m: Pick<MachineEntry, 'id' | 'status'>): boolean => {
    const shown = this.deps?.machines.shown(m);
    return shown === 'on' || shown === 'incompatible' || shown === 'off' || shown === 'starting';
  };

  /**
   * Starts updating to the latest release, unless chats would stop: then it
   * answers how many, for the owner to confirm with `update`. Null: it started
   * (or there was nothing to start, or it failed, and `outcome` says so).
   */
  prepare = (id: string): Promise<{ busy: number } | null> => this.begin(id, false);

  /** Starts updating although chats would stop (the owner confirmed). */
  update = async (id: string): Promise<void> => {
    await this.begin(id, true);
  };

  private begin = async (id: string, force: boolean): Promise<{ busy: number } | null> => {
    const deps = this.deps;
    const version = this.latest;
    const m = deps?.machines.get(id);
    if (!deps || !version || !m?.version || !this.behind(m) || !this.canStart(m)) return null;
    if (this.busyWith(id)) return null;
    const from = m.version;
    this.starting.add(id);
    let side: ServiceClient | null = null;
    try {
      const shown = deps.machines.shown(m);
      if (shown === 'off' || shown === 'starting') {
        this.stages[id] = 'turningOn';
        await this.bringUpEither(deps, id);
        delete this.stages[id];
      }
      // Its fresh hello may say otherwise now.
      const fresh = deps.machines.get(id);
      if (!fresh || !this.behind(fresh)) return null;
      if (fresh.client.status !== 'open') side = await this.openSide(id);
      const answer = await (side ?? fresh.client).request('update.start', { version, force });
      if (!answer.started) return { busy: answer.busy };
      this.stages[id] = 'downloading';
      this.watch(id, { version, from }, side);
      side = null;
      return null;
    } catch (e) {
      const code = e instanceof RequestError ? e.code : null;
      if (code === UPDATE_ERRORS.UPDATE_RUNNING) {
        // Another desktop got there first: this one shows that update.
        this.watch(id, { version, from }, side);
        side = null;
      } else if (code !== UPDATE_ERRORS.ALREADY_CURRENT) {
        // ALREADY_CURRENT: it was updated by hand while it was off; nothing to do.
        this.failed(id, { version, from }, errorText(e));
      }
      return null;
    } finally {
      side?.close();
      this.starting.delete(id);
    }
  };

  /** Brings an Off machine up; one that comes up outside this desktop's protocol range is up too. */
  private bringUpEither = async (deps: MachineUpdatesDeps, id: string): Promise<void> => {
    const alive = (): void => {
      if (deps.machines.get(id)?.status === 'incompatible') throw OUT_OF_RANGE;
    };
    try {
      await bringUp(deps, id, { waitMs: START_WAIT_MS, alive });
    } catch (e) {
      if (e !== OUT_OF_RANGE) throw e;
    }
  };

  /** An update-only client; its events count like the entry's. The caller closes it. */
  private openSide = async (id: string): Promise<ServiceClient> => {
    const side = await this.deps!.machines.openForUpdate(id);
    side.on('update.progress', (s) => this.onProgress(id, s));
    return side;
  };

  /** What machine `id` says about its update. */
  private apply = (id: string, s: UpdateStatus): void => {
    if (s.state === 'running') {
      this.stages[id] = s.stage;
      const w = this.watches.get(id);
      if (!w) return this.watch(id, s, null);
      w.version = s.version;
      w.from = s.from;
      this.targets[id] = s.version;
      return;
    }
    const followed = this.watches.has(id);
    this.end(id);
    if (s.state === 'idle') delete this.outcomes[id];
    else this.outcomes[id] = s;
    // Its client gave up on the old version for good; the new one may suit it.
    const m = this.deps?.machines.get(id);
    if (followed && s.state === 'done' && m?.client.status === 'incompatible') {
      this.deps?.machines.reconnect(id);
    }
  };

  /** Follows machine `id`'s running update until it ends. */
  private watch = (id: string, target: Target, side: ServiceClient | null): void => {
    delete this.outcomes[id];
    const w: Watch = { version: target.version, from: target.from, side, giveUpAt: null };
    this.watches.set(id, w);
    this.targets[id] = target.version;
    void this.poll(id, w);
  };

  /**
   * Asks while the update runs: the machine's own event can be missed (it is
   * sent while the new service starts, or while nobody is connected). Waiting
   * for a restart or a lost machine has a limit; a download has its own.
   */
  private poll = async (id: string, w: Watch): Promise<void> => {
    const now = this.deps?.now ?? Date.now;
    while (this.watches.get(id) === w) {
      const s = await this.readStatus(id, w);
      // It ended while this one was opening a client.
      if (this.watches.get(id) !== w) return w.side?.close();
      if (s) this.apply(id, s);
      if (this.watches.get(id) !== w) return;
      if (s?.state === 'running' && s.stage !== 'restarting') w.giveUpAt = null;
      else w.giveUpAt ??= now() + FOLLOW_WAIT_MS;
      if (w.giveUpAt !== null && now() >= w.giveUpAt) {
        return this.failed(id, w, this.notBack(id, w.version));
      }
      await pause(POLL_MS);
    }
  };

  /**
   * The machine's status (null: it can't say now), through its entry's client
   * when that is open. A client still retrying gets there by itself; one that
   * gave up never does, so an update-only client asks: `w`'s, kept for the
   * events, or else one just for this.
   */
  private readStatus = async (id: string, w?: Watch): Promise<UpdateStatus | null> => {
    const m = this.deps?.machines.get(id);
    const link = m?.client.status;
    try {
      if (link === 'open') return await m!.client.request('update.status', {});
      if (link !== 'incompatible' && link !== 'closed') return null;
      if (w) {
        if (w.side?.status !== 'open') w.side = await this.openSide(id);
        return await w.side.request('update.status', {});
      }
      const once = await this.openSide(id);
      try {
        return await once.request('update.status', {});
      } finally {
        once.close();
      }
    } catch {
      return null;
    }
  };

  private notBack = (id: string, version: string): string => {
    const name = machineNameOf(this.deps!.machines, id);
    const access =
      this.deps!.machines.get(id)?.info?.platform === 'win32' ? 'Remote Desktop' : 'SSH';
    return `${name} hasn't come back since it began updating to ${version}. It may need a look over ${access}.`;
  };

  /**
   * A failure the machine did not report (it could not be reached, or never
   * came back): `reason: 'start'` with `detail` saying what happened.
   */
  private failed = (id: string, target: Target, detail: string): void => {
    this.end(id);
    const { version, from } = target;
    this.outcomes[id] = { state: 'failed', version, from, reason: 'start', detail };
  };

  /** No update to follow any more. */
  private end = (id: string): void => {
    delete this.stages[id];
    delete this.targets[id];
    this.watches.get(id)?.side?.close();
    this.watches.delete(id);
  };

  init = (deps: MachineUpdatesDeps): void => {
    this.dispose();
    this.deps = deps;
    for (const m of deps.machines.list) this.follow(m);
    this.offs.push(
      deps.machines.onAdded((m) => this.follow(m)),
      deps.machines.onRemoved((id) => this.forget(id)),
    );
    this.schedule(FIRST_CHECK_DELAY_MS);
  };

  /** Listens to a paired machine: an update may be running, or may have ended while nobody looked. */
  private follow = (m: MachineEntry): void => {
    if (m.local || this.followed.has(m.id)) return;
    const id = m.id;
    const offs = [
      m.client.on('update.progress', (s) => this.onProgress(id, s)),
      m.client.onOpen(() => this.read(id)),
      m.client.onStatus((s) => {
        // It never opens, but its update may well have ended, or be running.
        if (s === 'incompatible') void this.read(id);
      }),
    ];
    this.followed.set(id, () => offs.forEach((off) => off()));
    if (m.client.status === 'open' || m.client.status === 'incompatible') void this.read(id);
  };

  private forget = (id: string): void => {
    this.followed.get(id)?.();
    this.followed.delete(id);
    this.end(id);
    delete this.outcomes[id];
  };

  /** While `update.start` is under way its answer decides, which comes right after. */
  private onProgress = (id: string, s: UpdateStatus): void => {
    if (!this.starting.has(id)) this.apply(id, s);
  };

  /** Reads what a machine says about its update, unless an update here is asking already. */
  private read = async (id: string): Promise<void> => {
    if (!this.deps?.machines.get(id)?.canUpdate || this.busyWith(id)) return;
    const s = await this.readStatus(id);
    if (s && !this.busyWith(id)) this.apply(id, s);
  };

  private busyWith = (id: string): boolean => this.starting.has(id) || this.watches.has(id);

  /**
   * Asks the local service for the latest release, unless the last answer is
   * fresh (`force`: anyway). A failure keeps what is known and says nothing:
   * the next check tries again.
   */
  refresh = async (opts: { force?: boolean } = {}): Promise<void> => {
    const deps = this.deps;
    if (!deps) return;
    const now = deps.now ?? Date.now;
    if (!opts.force && this.lastCheck !== null && now() - this.lastCheck < FRESH_MS) return;
    try {
      this.latest = (await deps.api.request('update.latest', {})).version;
      this.lastCheck = now();
    } catch {
      // Not worth a word: the machines' cards just offer nothing new.
    }
  };

  private schedule = (ms: number): void => {
    this.timer = setTimeout(() => {
      void this.refresh({ force: true }).finally(() => {
        if (this.timer !== null) this.schedule(CHECK_INTERVAL_MS);
      });
    }, ms);
  };

  /** Stops checking and following (tests; the app's state lives as long as the window). */
  dispose = (): void => {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const off of this.offs) off();
    this.offs = [];
    for (const off of this.followed.values()) off();
    this.followed.clear();
    for (const id of [...this.watches.keys()]) this.end(id);
    this.deps = null;
  };
}

export const machineUpdates = new MachineUpdatesState();
