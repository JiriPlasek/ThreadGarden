import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { POWER_ERRORS, type MachinePowerStatus, type Unpushed } from '@threadgarden/protocol';
import type { IdleMonitor } from './idle.js';
import { checkUnpushed } from './push-check.js';
import type { PowerStore } from './store.js';
import { createSwitch, type PowerSwitch } from './switch.js';
import { PowerError } from './tasmota.js';

const MIN = 60_000;
/** A send due this soon keeps the machine on: its wake would fire before the machine is off. */
const SEND_SOON_MS = 15 * MIN;
/** A wake further out than this cannot be set on the switch; the send goes out late instead. */
const WAKE_HORIZON_MS = 7 * 24 * 60 * MIN;
/** A start disarm that failed (no network yet) is tried again this often… */
const START_RETRY_MS = 10_000;
/** …this many times (about 5 minutes); after that, on every minute tick. */
const START_RETRIES = 30;

export const SEND_DUE_SOON = 'A scheduled message is due soon';
export const NOT_CONFIGURED =
  'This machine has no power switch set up, so it would not turn on again.';

type Phase = MachinePowerStatus['phase'];
type SequenceState = { phase: Phase; unpushed: Unpushed[]; problem: string | null };

const RUNNING: SequenceState = { phase: 'running', unpushed: [], problem: null };

/** The one place a machine's power status is put together; it never carries the password. */
export const buildPowerStatus = (
  store: PowerStore,
  idle: IdleMonitor,
  s: SequenceState = RUNNING,
): MachinePowerStatus => {
  idle.tick();
  return {
    configured: store.load() !== null,
    busy: idle.busy,
    idleSince: idle.idleSince,
    shutsDownAt: idle.shutsDownAt(),
    keepAwake: idle.keepAwake,
    phase: s.phase,
    unpushed: s.unpushed,
    problem: s.problem,
  };
};

type Dir = { cwd: string; sessionId: string | null };
type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

export type ShutdownOptions = {
  store: PowerStore;
  idle: IdleMonitor;
  /** Directories of this machine's sessions, newest first (see `checkUnpushed`). */
  dirs: () => Dir[];
  scheduled: () => { sendAt: number; state: string }[];
  stopAll: () => Promise<void>;
  /** Defaults to `systemctl poweroff`. */
  poweroff?: () => Promise<void>;
  makeSwitch?: typeof createSwitch;
  check?: (dirs: Dir[]) => Promise<Unpushed[]>;
  now?: () => number;
  /** For the start disarm's retries (tests replace them). */
  timers?: Timers;
  emit: (s: MachinePowerStatus) => void;
  log?: { info(m: string): void; warn(m: string): void };
};

const execFileP = promisify(execFile);
const systemctlPoweroff = async (): Promise<void> => {
  await execFileP('systemctl', ['poweroff'], { timeout: 30_000, windowsHide: true });
};

/** A switch error's own message (PowerError messages never hold the password); anything else, a plain one. */
const switchProblem = (err: unknown): string =>
  err instanceof PowerError ? err.message : 'The power switch could not be driven.';

/**
 * Whether `systemctl poweroff` was refused. One ended by an outside signal is not:
 * systemd stops this service, and its children, once the shutdown is under way.
 * One killed by our own timeout (`killed`) is: the machine is not going down.
 */
const refused = (err: unknown): boolean => {
  const e = err as { signal?: unknown; killed?: unknown } | null;
  return e?.killed === true || !(typeof e?.signal === 'string' && e.signal !== '');
};

/** The first line of what went wrong (stderr first: `systemctl poweroff` explains itself there). */
const firstLine = (err: unknown): string => {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const text =
    (typeof e?.stderr === 'string' && e.stderr.trim()) ||
    (typeof e?.message === 'string' && e.message.trim()) ||
    'unknown error';
  return text.split('\n')[0]!.trim();
};

/** Why `systemctl poweroff` failed, in a few words. */
const poweroffReason = (err: unknown): string =>
  (err as { killed?: unknown } | null)?.killed === true ? 'systemctl timed out' : firstLine(err);

/** Best effort: no cut and no wake on the switch; every error is ignored. */
const disarmQuietly = async (sw: PowerSwitch): Promise<void> => {
  await sw.disarm().catch(() => {});
  await sw.armWake(null).catch(() => {});
};

/**
 * Powers a headless machine off safely (spec §10): the push check, then the next
 * scheduled send, then the cut and the wake are armed on the switch, and only then
 * are the sessions stopped and the machine powered off. Whenever the switch cannot
 * be armed, the machine stays on and says why: it could never be turned on again.
 */
export class ShutdownSequence {
  private state: SequenceState = RUNNING;
  private inFlight: Promise<MachinePowerStatus> | null = null;
  /**
   * The disarm at start has not got through yet (the service often starts before
   * the network): until it has, it is retried and a sequence never arms.
   */
  private startPending = false;
  /** The start disarm attempt under way: a sequence never talks to the switch alongside it. */
  private startAttempt: Promise<void> | null = null;
  /** Why the last start disarm attempt failed. */
  private startProblem: string | null = null;
  private startRetries = 0;
  private retryHandle: unknown = null;
  private closed = false;
  /** The switch while a cut of this sequence is armed and the machine is not yet powering off. */
  private armed: PowerSwitch | null = null;
  private readonly now: () => number;
  private readonly makeSwitch: typeof createSwitch;
  private readonly check: (dirs: Dir[]) => Promise<Unpushed[]>;
  private readonly poweroff: () => Promise<void>;
  private readonly timers: Timers;

  constructor(private readonly o: ShutdownOptions) {
    this.now = o.now ?? Date.now;
    this.timers = o.timers ?? {
      set: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return t;
      },
      clear: (h) => clearTimeout(h as NodeJS.Timeout),
    };
    this.makeSwitch = o.makeSwitch ?? createSwitch;
    this.check = o.check ?? ((dirs) => checkUnpushed(dirs));
    this.poweroff = o.poweroff ?? systemctlPoweroff;
  }

  status(): MachinePowerStatus {
    return buildPowerStatus(this.o.store, this.o.idle, this.state);
  }

  /**
   * One sequence at a time: a call while one runs, or once the machine is going
   * down, returns the current status. Whatever goes wrong, the phase never stays
   * `checking`.
   */
  run(r: { force: boolean; reason: 'idle' | 'manual' }): Promise<MachinePowerStatus> {
    if (this.inFlight || this.state.phase === 'shuttingDown') return Promise.resolve(this.status());
    this.inFlight = this.sequence(r)
      .catch(async (err: unknown) => {
        this.o.log?.warn(`power: the shutdown stopped: ${firstLine(err)}`);
        // Never leave a cut armed on a machine that is not powering off.
        const sw = this.armed;
        this.armed = null;
        if (sw) await disarmQuietly(sw);
        return this.settle({ ...RUNNING, problem: 'The shutdown stopped unexpectedly.' });
      })
      .finally(() => {
        this.inFlight = null;
        this.armed = null;
      });
    return this.inFlight;
  }

  /**
   * The minute tick: shuts down once the machine has been idle long enough, with a
   * switch configured. A blocked machine or one with a problem tries again after a
   * fresh idle period (see `settle`); one shutting down never starts again.
   */
  async idleTick(): Promise<void> {
    if (this.inFlight || this.state.phase === 'shuttingDown') return;
    // A start disarm still not through once its quick retries are over: once a minute.
    if (this.startPending && this.retryHandle === null) await this.startDisarm();
    if (this.o.store.load() === null) return;
    this.o.idle.tick();
    if (!this.o.idle.due()) return;
    await this.run({ force: false, reason: 'idle' });
  }

  /**
   * At service start: a cut still armed must never fire on a running machine,
   * and a wake that brought it up is spent (a stale one would cut the machine).
   * Resolves after the first attempt, which never throws; one that failed (the
   * network is often not up yet) is retried every 10 s for about 5 minutes,
   * then on every minute tick, until it gets through.
   */
  onStart(): Promise<void> {
    this.startPending = true;
    this.startRetries = 0;
    return this.startDisarm().then(() => this.scheduleRetry());
  }

  /**
   * A chat turn started or ended: a blocked notice no longer holds (the work it
   * named may be pushed by now), so the machine is running again and says so. The
   * push check runs again after the next idle period.
   */
  activity(): void {
    if (this.inFlight || this.state.phase !== 'blocked') return;
    this.set(RUNNING);
  }

  /** Stops the start disarm's retries (the service is closing). */
  close(): void {
    this.closed = true;
    if (this.retryHandle !== null) this.timers.clear(this.retryHandle);
    this.retryHandle = null;
  }

  /** One start disarm attempt at a time: a caller while one runs shares it. */
  private startDisarm(): Promise<void> {
    this.startAttempt ??= this.disarmAtStart().finally(() => {
      this.startAttempt = null;
    });
    return this.startAttempt;
  }

  private scheduleRetry(): void {
    if (!this.startPending || this.closed || this.retryHandle !== null) return;
    if (this.startRetries >= START_RETRIES) return; // the minute tick carries on
    this.retryHandle = this.timers.set(() => {
      this.retryHandle = null;
      if (!this.startPending || this.closed) return;
      this.startRetries++;
      // A sequence under way disarms first itself; never alongside its arming.
      if (this.inFlight) {
        this.scheduleRetry();
        return;
      }
      void this.startDisarm().then(() => this.scheduleRetry());
    }, START_RETRY_MS);
  }

  /** Disarms and clears the wake; done once both got through. Never throws. */
  private async disarmAtStart(): Promise<void> {
    const stored = this.o.store.load();
    if (!stored) {
      this.startPending = false;
      return;
    }
    const sw = this.makeSwitch(stored.config, stored.password);
    try {
      await sw.disarm();
      try {
        await sw.armWake(null);
      } catch (err) {
        // No rule of ours on the switch: no wake to clear.
        if (!(err instanceof PowerError && err.code === POWER_ERRORS.notConfigured)) throw err;
      }
      if (this.startProblem !== null) this.o.log?.info('power: disarmed at start after retrying');
      this.startPending = false;
      this.startProblem = null;
    } catch (err) {
      const first = this.startProblem === null;
      this.startProblem = switchProblem(err);
      if (first)
        this.o.log?.warn(`power: disarming at start failed, retrying: ${this.startProblem}`);
    }
  }

  private set(s: SequenceState): MachinePowerStatus {
    this.state = s;
    const status = this.status();
    try {
      this.o.emit(status);
    } catch (err) {
      this.o.log?.warn(`power: announcing the status failed: ${firstLine(err)}`);
    }
    return status;
  }

  /** Ends a sequence that did not power off: the next idle attempt waits a fresh idle period. */
  private settle(s: SequenceState): MachinePowerStatus {
    this.o.idle.restart();
    return this.set(s);
  }

  private async sequence(r: {
    force: boolean;
    reason: 'idle' | 'manual';
  }): Promise<MachinePowerStatus> {
    const startedAt = this.now();
    this.set({ phase: 'checking', unpushed: [], problem: null });
    // A machine at work when asked (manual only: idle never is) goes down as asked.
    const busyAtStart = this.o.idle.busy;

    // 1. Work that never reached GitHub, or that could not be checked, keeps the machine on.
    if (!r.force) {
      let found: Unpushed[];
      try {
        found = await this.check(this.o.dirs());
      } catch (err) {
        this.o.log?.warn(`power: the push check failed: ${firstLine(err)}`);
        return this.settle({ ...RUNNING, problem: 'The check for unpushed work failed.' });
      }
      if (found.length > 0) {
        this.o.log?.info(`power: ${r.reason} shutdown blocked by ${found.length} unpushed item(s)`);
        return this.settle({ phase: 'blocked', unpushed: found, problem: null });
      }
    }

    // 2. The next scheduled send: one due soon keeps the machine on; a far one goes out late.
    // One already overdue (held back) goes out at the next start: it never postpones.
    const now = this.now();
    let earliest: number | null = null;
    for (const s of this.o.scheduled()) {
      if (s.state !== 'pending' || s.sendAt <= now) continue;
      if (earliest === null || s.sendAt < earliest) earliest = s.sendAt;
    }
    if (earliest !== null && earliest - now <= SEND_SOON_MS) {
      return this.settle({ ...RUNNING, problem: SEND_DUE_SOON });
    }
    const wakeAt = earliest !== null && earliest - now <= WAKE_HORIZON_MS ? earliest : null;

    // 3. Arm the cut and the wake. Without both, the machine must not power off.
    const stored = this.o.store.load();
    if (!stored) return this.settle({ ...RUNNING, problem: NOT_CONFIGURED });
    // The disarm at start must not land after this sequence's cut or wake, and
    // while it has not got through, nothing is armed: it is tried once more first.
    if (this.startAttempt) await this.startAttempt;
    if (this.startPending) await this.startDisarm();
    if (this.startPending) {
      const problem = this.startProblem ?? 'The power switch could not be driven.';
      this.o.log?.warn(
        `power: ${r.reason} shutdown stopped, the switch was not disarmed: ${problem}`,
      );
      return this.settle({ ...RUNNING, problem });
    }
    const sw = this.makeSwitch(stored.config, stored.password);
    try {
      // From here a failure anywhere must disarm (see `run`).
      this.armed = sw;
      await sw.armCut();
      await sw.armWake(wakeAt);
    } catch (err) {
      this.armed = null;
      const problem = switchProblem(err);
      this.o.log?.warn(`power: ${r.reason} shutdown stopped, the switch was not armed: ${problem}`);
      // A cut armed before the wake failed must not stay armed on a running machine.
      await disarmQuietly(sw);
      return this.settle({ ...RUNNING, problem });
    }
    // A turn that started meanwhile (a message, a scheduled send) was never checked
    // and would be killed: the machine stays on, and idle starts afresh.
    if (!busyAtStart && this.o.idle.activeSince(startedAt)) {
      this.armed = null;
      this.o.log?.info(`power: ${r.reason} shutdown stopped, a chat got to work meanwhile`);
      await disarmQuietly(sw);
      return this.settle(RUNNING);
    }

    // 4. Stop the sessions and power off.
    this.o.log?.info(
      `power: ${r.reason} shutdown${wakeAt === null ? '' : `, waking for a send at ${new Date(wakeAt).toISOString()}`}`,
    );
    this.set({ phase: 'shuttingDown', unpushed: [], problem: null });
    try {
      await this.o.stopAll();
    } catch (err) {
      this.o.log?.warn(`power: stopping sessions failed: ${firstLine(err)}`);
    }
    // Powering off: from here the cut must stay armed, whatever happens to this process.
    this.armed = null;
    try {
      await this.poweroff();
    } catch (err) {
      const reason = poweroffReason(err);
      if (!refused(err)) {
        this.o.log?.info(
          `power: systemctl poweroff ended by a signal (${reason}); the machine is going down`,
        );
        return this.status();
      }
      this.o.log?.warn(`power: poweroff failed: ${reason}`);
      await disarmQuietly(sw);
      return this.settle({ ...RUNNING, problem: `The machine refused to power off (${reason})` });
    }
    return this.status();
  }
}
