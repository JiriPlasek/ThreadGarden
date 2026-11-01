import {
  POWER_ERRORS,
  PowerConfigSchema,
  type PlugReading,
  type PowerConfig,
  type ProbeResult,
  type SwitchDevice,
} from '@threadgarden/protocol';
import type { Db } from '../history/db.js';
import { pairPlug, probeSwitch, renameDevice } from './probe.js';
import { createSwitch, type PowerSwitch } from './switch.js';
import { PowerError } from './tasmota.js';

const READING_TTL_MS = 3000;

type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
export type PowerHubOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  timers?: Timers;
  /** Passed on to the switch and to probing (tests use 0). */
  readWaitMs?: number;
  /** Passed on to pairing (tests shorten it). */
  pairing?: { timeoutMs?: number; pollMs?: number; closePauseMs?: number };
};

type TurnOnResult = { cycled: boolean; waitMs: number };
type Pending = { result: TurnOnResult; handle: unknown };

const notConfigured = (message = 'No power switch is set up for this machine.') =>
  new PowerError(POWER_ERRORS.notConfigured, message);

/**
 * The desktop's side of power control: each paired machine's switch
 * configuration (in the database) and the switch passwords (in memory only,
 * handed over from the OS keychain after every start). It never polls: a
 * reading happens when asked for, and a pending turn-on is one timer.
 */
export class PowerHub {
  private readonly passwords = new Map<string, string>();
  private readonly cache = new Map<string, { reading: PlugReading; at: number }>();
  private readonly pending = new Map<string, Pending>();
  /** Plug ids `pairPlug` returned in this run: the only ones `rename` accepts. */
  private readonly paired = new Set<string>();
  private readonly now: () => number;
  private readonly timers: Timers;

  constructor(
    private readonly db: Db,
    private readonly o: PowerHubOptions = {},
  ) {
    this.now = o.now ?? Date.now;
    this.timers = o.timers ?? {
      set: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return t;
      },
      clear: (h) => clearTimeout(h as NodeJS.Timeout),
    };
  }

  list(): { machineId: string; config: PowerConfig }[] {
    const rows = this.db.raw
      .prepare('SELECT machine_id, config FROM machine_power ORDER BY machine_id')
      .all() as { machine_id: string; config: string }[];
    return rows.map((r) => ({
      machineId: r.machine_id,
      config: PowerConfigSchema.parse(JSON.parse(r.config)),
    }));
  }

  private config(machineId: string): PowerConfig | null {
    const r = this.db.raw
      .prepare('SELECT config FROM machine_power WHERE machine_id = ?')
      .get(machineId) as { config: string } | undefined;
    return r ? PowerConfigSchema.parse(JSON.parse(r.config)) : null;
  }

  private store(machineId: string, config: PowerConfig): void {
    this.db.raw
      .prepare(
        'INSERT INTO machine_power (machine_id, config) VALUES (?, ?) ON CONFLICT(machine_id) DO UPDATE SET config = excluded.config',
      )
      .run(machineId, JSON.stringify(config));
  }

  private switchFor(config: PowerConfig, password: string): PowerSwitch {
    return createSwitch(config, password, {
      fetch: this.o.fetch,
      now: this.now,
      ...(this.o.readWaitMs !== undefined ? { readWaitMs: this.o.readWaitMs } : {}),
    });
  }

  private ready(machineId: string): { config: PowerConfig; password: string } {
    const config = this.config(machineId);
    const password = this.passwords.get(machineId);
    if (!config || password === undefined) throw notConfigured();
    return { config, password };
  }

  private reset(machineId: string): void {
    this.cache.delete(machineId);
    const p = this.pending.get(machineId);
    if (p) this.timers.clear(p.handle);
    this.pending.delete(machineId);
  }

  async probe(address: string, password: string): Promise<ProbeResult> {
    return probeSwitch(address, password, {
      fetch: this.o.fetch,
      ...(this.o.readWaitMs !== undefined ? { readWaitMs: this.o.readWaitMs } : {}),
    });
  }

  async pairPlug(address: string, password: string): Promise<SwitchDevice | null> {
    const device = await pairPlug(address, password, {
      fetch: this.o.fetch,
      ...(this.o.readWaitMs !== undefined ? { readWaitMs: this.o.readWaitMs } : {}),
      ...this.o.pairing,
    });
    if (device) this.paired.add(device.id);
    return device;
  }

  /** Renames only a plug that was just paired here: the bridge's other devices are not ours. */
  async rename(address: string, password: string, id: string, name: string): Promise<void> {
    if (!this.paired.has(id)) throw notConfigured('Threadgarden only renames a plug it just paired.');
    await renameDevice(address, password, id, name, { fetch: this.o.fetch });
  }

  unlock(machineId: string, password: string): void {
    this.passwords.set(machineId, password);
    this.cache.delete(machineId);
  }

  async configure(
    machineId: string,
    config: PowerConfig | null,
    password?: string,
  ): Promise<PowerConfig | null> {
    if (config === null) {
      const known = this.passwords.get(machineId);
      const current = this.config(machineId);
      // A no-op when our rule isn't on the switch, so a known password is all it needs.
      if (known !== undefined && current) await this.switchFor(current, known).uninstall();
      this.reset(machineId);
      this.db.raw.prepare('DELETE FROM machine_power WHERE machine_id = ?').run(machineId);
      this.passwords.delete(machineId);
      return null;
    }
    const pw = password ?? this.passwords.get(machineId);
    if (pw === undefined) throw notConfigured('The switch password is needed to set this up.');
    await this.switchFor(config, pw).ensureInstalled();
    this.store(machineId, config);
    this.passwords.set(machineId, pw);
    this.reset(machineId);
    return config;
  }

  async reading(machineId: string): Promise<PlugReading> {
    const hit = this.cache.get(machineId);
    if (hit && this.now() - hit.at < READING_TTL_MS) return hit.reading;
    const { config, password } = this.ready(machineId);
    const reading = await this.switchFor(config, password).reading();
    this.cache.set(machineId, { reading, at: this.now() });
    return reading;
  }

  async turnOn(machineId: string): Promise<TurnOnResult> {
    const waiting = this.pending.get(machineId);
    if (waiting) return waiting.result;
    const { config, password } = this.ready(machineId);
    const sw = this.switchFor(config, password);
    const minOffMs = config.minOffSeconds * 1000;
    this.cache.delete(machineId);
    const reading = await sw.reading();
    if (reading.on === null) {
      throw new PowerError(POWER_ERRORS.unreachable, "The switch didn't report whether the plug is on.");
    }

    if (reading.on) {
      if (reading.watts !== null && reading.watts < config.offWatts) {
        // Standby: cut and restore power, which a PC set to power on after a cut then boots from.
        await sw.cycle();
        return this.hold(machineId, { cycled: true, waitMs: minOffMs }, null);
      }
      return { cycled: false, waitMs: 0 };
    }

    const cut = await sw.lastCut();
    const waitMs = Math.max(0, cut === null ? 0 : cut + minOffMs - this.now());
    if (waitMs === 0) {
      await sw.setPower(true);
      return { cycled: false, waitMs: 0 };
    }
    return this.hold(machineId, { cycled: false, waitMs }, () => sw.setPower(true));
  }

  /** Remembers a turn-on until its wait is over; `act` runs then. Never rejects. */
  private hold(machineId: string, result: TurnOnResult, act: (() => Promise<void>) | null): TurnOnResult {
    const handle = this.timers.set(() => {
      this.pending.delete(machineId);
      this.cache.delete(machineId);
      // A switch that stays unreachable leaves the plug off; the next reading shows it.
      void act?.().catch(() => {});
    }, result.waitMs);
    this.pending.set(machineId, { result, handle });
    return result;
  }

  noteMeasurement(machineId: string, kind: 'running' | 'standby', watts: number): void {
    const config = this.config(machineId);
    if (!config) throw notConfigured();
    this.store(machineId, { ...config, measured: { ...config.measured, [kind]: watts } });
  }
}
