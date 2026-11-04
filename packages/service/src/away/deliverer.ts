import type { AwayItem, AwayState, EventMsg } from '@threadgarden/protocol';
import type { Timers } from '../chat/live-session.js';
import { LinkError, openLink, RemoteError, request } from '../machine/link.js';
import type { StoredMachine } from '../machine/paired-machines.js';
import { DEVICE_PROTOCOL_PREFIX } from '../machine/pairing-client.js';
import type { AwayPayload, AwayQueue, AwayReason, AwayRow, NewAwayRow } from './queue.js';

/** How often the queue is looked at while rows wait. */
export const AWAY_TICK_MS = 5_000;
/** How long a start may take before it failed (power control's own give-up). */
export const AWAY_START_WINDOW_MS = 5 * 60_000;
/**
 * A longer gap between two looks at a start means this device slept (or the
 * service stood still) in between: a round awake looks every tick, and a
 * connect gives up within `AWAY_LINK_TIMEOUT_MS`.
 */
export const AWAY_SLEPT_MS = 90_000;

/** How long a link may take to open before the machine counts as not reachable now. */
export const AWAY_LINK_TIMEOUT_MS = 10_000;
/** How long one call may wait for its answer; after that it is lost and goes again. */
export const AWAY_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The machine turned this device away (its token is unknown or revoked there):
 * nothing goes out until it is paired again. The message says so, by name.
 */
export class DeviceRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceRefused';
  }
}

/** A short-lived link to a paired machine, for one delivery round. */
export type Link = {
  /**
   * The result, or a `RemoteError` (the machine said no), a `DeviceRefused`
   * (it turned this device away), or a `LinkError` (lost on the way).
   */
  request(method: string, params: unknown): Promise<unknown>;
  close(): void;
};

export type AwayDelivererDeps = {
  queue: AwayQueue;
  machines: { get(id: string): { id: string } | null; token(id: string): string | null };
  /** The paired machines' power control (`PowerHub`). */
  power: {
    list(): { machineId: string; config: { offWatts: number } }[];
    reading(machineId: string): Promise<{ on: boolean | null; watts: number | null }>;
    turnOn(machineId: string): Promise<unknown>;
  };
  /** A link to the machine, or null when it cannot be reached now; `DeviceRefused` when it turns this device away. */
  connect: (machineId: string) => Promise<Link | null>;
  /** Sent to this desktop's own clients only. */
  emit: (e: EventMsg) => void;
  now?: () => number;
  timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
  log?: { warn(message: string): void; debug?(message: string): void };
};

/** The remote listener's close codes for a token it refuses: unknown (4401) and revoked (4403). */
const REFUSED_CLOSE: ReadonlySet<number> = new Set([4401, 4403]);
/** How long a call that lost its link waits to learn the close code (the listener sends it at once). */
const CLOSE_CODE_WAIT_MS = 1_000;

/**
 * Links as the relay opens them (TLS pinned to the machine's certificate, the
 * device token in the subprotocol), or null: no token yet, or not reachable.
 * A machine that turns this device away (the upgrade answered 401 or 403, or
 * the link closed 4401 or 4403, as its listener does) gives `DeviceRefused`,
 * from here or from the call that met it.
 */
export const connectToMachine =
  (
    machines: { get(id: string): StoredMachine | null; token(id: string): string | null },
    o: { linkTimeoutMs?: number; requestTimeoutMs?: number } = {},
  ) =>
  async (machineId: string): Promise<Link | null> => {
    const machine = machines.get(machineId);
    const token = machines.token(machineId);
    if (!machine || token === null) return null;
    const refused = () => new DeviceRefused(`${machine.name} refused this device; pair it again`);
    let link: ReturnType<typeof openLink>;
    try {
      link = openLink({
        address: machine.address,
        port: machine.port,
        protocol: `${DEVICE_PROTOCOL_PREFIX}${token}`,
        pin: { certPem: machine.certPem, fingerprint: machine.fingerprint },
        timeoutMs: o.linkTimeoutMs ?? AWAY_LINK_TIMEOUT_MS,
      });
    } catch {
      return null;
    }
    const { ws } = link;
    // Listened for from the start: the listener may close a refused link right after it opens.
    const closedWith = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    try {
      await link.opened;
    } catch (err) {
      if (
        err instanceof LinkError &&
        err.kind === 'refused' &&
        (err.status === 401 || err.status === 403)
      ) {
        throw refused();
      }
      return null;
    }
    return {
      request: async (method, params) => {
        try {
          return await request(ws, method, params, o.requestTimeoutMs ?? AWAY_REQUEST_TIMEOUT_MS);
        } catch (err) {
          // A link that closed under the call: was it the machine turning this device away?
          if (err instanceof LinkError && ws.readyState !== ws.OPEN) {
            let timer: NodeJS.Timeout | undefined;
            const code = await Promise.race([
              closedWith,
              new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), CLOSE_CODE_WAIT_MS);
                timer.unref();
              }),
            ]);
            clearTimeout(timer);
            if (code !== null && REFUSED_CLOSE.has(code)) throw refused();
          }
          throw err;
        }
      },
      close: () => ws.close(),
    };
  };

/** A queued row whose stored message no longer reads back (damaged, or written by another version). */
export const UNREADABLE_MESSAGE = "This message couldn't be read back.";

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Delivers the queue: while rows wait, every `AWAY_TICK_MS` each machine with
 * waiting rows is tried. Connected, its rows go out in order over a link of
 * the round's own, closed when the round ends. Not connected, a machine whose
 * plug reads Off is turned on, once per attempt; one that draws power is never
 * turned on (it may be booting, and would be cut).
 */
export class AwayDeliverer {
  private readonly now: () => number;
  private timer: unknown = undefined;
  private running: Promise<void> | null = null;
  private again = false;
  private closed = false;
  /** Machines being turned on for their waiting rows: since when, and when last looked at. */
  private readonly attempts = new Map<string, { startedAt: number; lastSeen: number }>();
  /** The links of the rounds running now. */
  private readonly links = new Set<Link>();

  constructor(private readonly d: AwayDelivererDeps) {
    this.now = d.now ?? Date.now;
  }

  /**
   * Picks up the rows of the last run: one left going out waits again (its id
   * makes sending it again harmless), and a start is tried at once.
   */
  start(): void {
    this.d.queue.resetSending();
    if (this.d.queue.hasWaiting()) this.kick();
  }

  /**
   * Writes a message down and tries to deliver it at once. After a start that
   * ran out, writing again asks for the machine again: the rows that failed to
   * start wait again with it, and a new start begins. Behind a refused message
   * of its own chat it fails with it instead (the chat keeps its order), and
   * goes with Retry.
   */
  queue(p: NewAwayRow): AwayItem {
    if (this.d.queue.retry(p.machineId, 'start')) this.attempts.delete(p.machineId);
    const ahead = this.d.queue
      .rows(p.machineId)
      .find((r) => r.state === 'failed' && r.sessionId === p.sessionId);
    const item = this.d.queue.add(
      p,
      ahead ? { reason: ahead.reason ?? 'refused', error: ahead.error } : undefined,
    );
    this.changed();
    this.kick();
    return item;
  }

  /** The machine's failed rows wait again, and it is tried (and turned on) at once. */
  retry(machineId: string): void {
    if (!this.d.queue.retry(machineId)) return;
    this.attempts.delete(machineId);
    this.changed();
    this.kick();
  }

  /** Takes a row back; `ALREADY_SENT` once it is going out. An unknown id is already done. */
  cancel(id: string): void {
    if (!this.d.queue.cancel(id)) return;
    this.dropIdleAttempts();
    this.changed();
  }

  /** The machine's token arrived (`machines.unlock`): its waiting rows can go now. */
  onUnlock(machineId: string): void {
    if (this.d.queue.waitingMachines().includes(machineId)) this.kick();
  }

  /**
   * A link to the machine opened (the relay's, for this desktop's own window):
   * it is up after all, so the rows its start gave up on wait again and go now
   * (ruling R17). A row the machine refused still waits for Retry (R9).
   */
  onReachable(machineId: string): void {
    if (!this.d.queue.retry(machineId, 'start')) return;
    this.attempts.delete(machineId);
    this.changed();
    this.kick();
  }

  /** Rows wait to go out (the local service stays up for them). */
  waiting(): boolean {
    return this.d.queue.hasWaiting();
  }

  /** Drops a machine's rows and its start (it was removed). */
  forget(machineId: string): void {
    this.d.queue.forget(machineId);
    this.attempts.delete(machineId);
    this.changed();
  }

  list(machineId?: string): { items: AwayItem[]; states: AwayState[] } {
    const items = this.d.queue.list(machineId);
    const ids = new Set(items.map((i) => i.machineId));
    for (const id of this.attempts.keys())
      if (machineId === undefined || id === machineId) ids.add(id);
    const states = [...ids].map((id) => {
      const attempt = this.attempts.get(id);
      return {
        machineId: id,
        starting: attempt !== undefined,
        startedAt: attempt?.startedAt ?? null,
      };
    });
    return { items, states };
  }

  /** One look at every machine with waiting rows; calls during one run it again after. */
  tick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = (async () => {
      do {
        this.again = false;
        try {
          await this.pass();
        } catch (err) {
          this.d.log?.warn(`away: ${errorText(err)}`);
        }
      } while (this.again && !this.closed);
    })();
    this.running = run.finally(() => {
      this.running = null;
      // Closed: the database may be closing too.
      if (this.closed) return;
      if (this.d.queue.hasWaiting()) this.schedule(AWAY_TICK_MS);
    });
    return this.running;
  }

  /**
   * Stops: no new round starts, and the links of rounds running now close, so
   * their rows wait for the next run. Settles when those rounds are over.
   */
  close(): Promise<void> {
    this.closed = true;
    this.clearTimer();
    for (const link of this.links) link.close();
    return this.running ?? Promise.resolve();
  }

  private async pass(): Promise<void> {
    if (this.dropIdleAttempts()) this.changed();
    const machines = this.d.queue.waitingMachines();
    // Every round runs to its end: one machine's failure never cuts another's short.
    const ends = await Promise.allSettled(machines.map((m) => this.round(m)));
    ends.forEach((end, i) => {
      if (end.status === 'rejected') {
        this.d.log?.warn(`away: delivering to ${machines[i]} failed: ${errorText(end.reason)}`);
      }
    });
  }

  private async round(machineId: string): Promise<void> {
    if (!this.d.machines.get(machineId) || this.d.machines.token(machineId) === null) return;
    let link: Link | null;
    try {
      link = await this.d.connect(machineId);
    } catch (err) {
      if (!(err instanceof DeviceRefused)) throw err;
      this.refused(machineId, err);
      return;
    }
    if (!link) {
      let attempt = this.attempts.get(machineId);
      const now = this.now();
      if (attempt && now - attempt.lastSeen > AWAY_SLEPT_MS) {
        // Slept since the last look (between ticks, or while this connect hung): a
        // start cut short counts as not tried, and starts again.
        this.attempts.delete(machineId);
        this.changed();
        attempt = undefined;
      }
      if (!attempt) await this.startIfOff(machineId);
      else if (now - attempt.startedAt >= AWAY_START_WINDOW_MS) {
        // A whole window awake and it never answered: a real failure, which waits for Retry.
        this.attempts.delete(machineId);
        this.d.queue.failWaiting(machineId, 'start', null);
        this.changed();
      } else attempt.lastSeen = now;
      return;
    }
    if (this.attempts.delete(machineId)) this.changed();
    this.links.add(link);
    try {
      if (!this.closed) await this.deliver(machineId, link);
    } finally {
      this.links.delete(link);
      link.close();
    }
  }

  /**
   * The machine's rows, in order, until the link is lost. A chat's messages
   * keep their order: one behind a failed message of its chat fails with it
   * (Retry sends them again together), never goes past it.
   */
  private async deliver(machineId: string, link: Link): Promise<void> {
    const failedChats = new Map<string, { reason: AwayReason; error: string | null }>();
    for (const row of this.d.queue.rows(machineId)) {
      if (this.closed) return;
      if (row.state === 'failed') {
        failedChats.set(row.sessionId, { reason: row.reason ?? 'refused', error: row.error });
        continue;
      }
      const ahead = failedChats.get(row.sessionId);
      if (row.state === 'waiting' && ahead) {
        this.d.queue.fail(row.id, ahead.reason, ahead.error);
        this.changed();
        continue;
      }
      if (row.state !== 'waiting') continue;
      if (!row.payload) {
        this.d.queue.fail(row.id, 'refused', UNREADABLE_MESSAGE);
        failedChats.set(row.sessionId, { reason: 'refused', error: UNREADABLE_MESSAGE });
        this.changed();
        continue;
      }
      if (!this.d.queue.claim(row.id)) continue;
      this.changed();
      try {
        await link.request(...this.call(row, row.payload));
      } catch (err) {
        if (err instanceof DeviceRefused) {
          this.d.queue.fail(row.id, 'refused', err.message);
          this.refused(machineId, err);
          return;
        }
        if (err instanceof RemoteError) {
          this.d.queue.fail(row.id, 'refused', err.message);
          failedChats.set(row.sessionId, { reason: 'refused', error: err.message });
          this.changed();
          continue;
        }
        this.d.queue.release(row.id);
        this.changed();
        return;
      }
      this.d.queue.remove(row.id);
      this.changed();
    }
  }

  /** The machine is up and turned this device away: its waiting rows fail, and it is not started. */
  private refused(machineId: string, err: DeviceRefused): void {
    this.attempts.delete(machineId);
    this.d.queue.failWaiting(machineId, 'refused', err.message);
    this.changed();
  }

  /** Ends the starts of machines with nothing waiting any more; true when one ended. */
  private dropIdleAttempts(): boolean {
    const waiting = new Set(this.d.queue.waitingMachines());
    let dropped = false;
    for (const id of [...this.attempts.keys()]) {
      if (!waiting.has(id)) dropped = this.attempts.delete(id) || dropped;
    }
    return dropped;
  }

  /** Turns the machine on when its plug reads Off (or standby, below `offWatts`). */
  private async startIfOff(machineId: string): Promise<void> {
    const config = this.d.power.list().find((p) => p.machineId === machineId)?.config;
    if (!config) return;
    let reading: { on: boolean | null; watts: number | null };
    try {
      reading = await this.d.power.reading(machineId);
    } catch (err) {
      this.d.log?.debug?.(`away: the plug of ${machineId} was not read: ${errorText(err)}`);
      return;
    }
    const off = reading.on === false || (reading.watts !== null && reading.watts < config.offWatts);
    if (!off || this.closed) return;
    const startedAt = this.now();
    const attempt = { startedAt, lastSeen: startedAt };
    this.attempts.set(machineId, attempt);
    this.changed();
    try {
      await this.d.power.turnOn(machineId);
      const now = this.now();
      if (this.attempts.get(machineId) === attempt && now - attempt.lastSeen > AWAY_SLEPT_MS) {
        // Slept while the switch was asked: the machine had no window yet; it gets one from now.
        attempt.startedAt = now;
        this.changed();
      }
      attempt.lastSeen = now;
    } catch (err) {
      // Not started: the next tick reads the plug again.
      this.attempts.delete(machineId);
      this.changed();
      this.d.log?.warn(`away: turning on ${machineId} failed: ${errorText(err)}`);
    }
  }

  /** The machine call a row makes; its ids make it safe to make again. */
  private call(row: AwayRow, payload: AwayPayload): [string, unknown] {
    const { text, images, cwd, model, permissionMode, effort } = payload;
    const withImages = images && images.length > 0 ? { images } : {};
    if (row.kind === 'create') {
      return [
        'chat.create',
        {
          sessionId: row.sessionId,
          cwd,
          text,
          ...withImages,
          ...(model === undefined ? {} : { model }),
          ...(permissionMode === undefined ? {} : { permissionMode }),
          ...(effort === undefined ? {} : { effort }),
        },
      ];
    }
    return ['chat.send', { sessionId: row.sessionId, text, ...withImages, messageId: row.id }];
  }

  private changed(): void {
    this.d.emit({ event: 'away.changed', data: this.list() });
  }

  /** A tick as soon as possible. */
  private kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.closed) return;
    this.clearTimer();
    this.timer = this.d.timers.setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.d.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
