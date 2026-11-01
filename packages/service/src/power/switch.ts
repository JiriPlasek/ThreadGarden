import { POWER_ERRORS, type PlugReading, type PowerConfig } from '@threadgarden/protocol';
import {
  RESOURCES,
  chooseSlot,
  commandsFor,
  conflicts,
  isOurs,
  memsFor,
  ruleText,
} from './rules.js';
import { PowerError, TasmotaClient } from './tasmota.js';

export interface PowerSwitch {
  /** Sends `read`, waits 1.5 s, then ZbStatus3 <device> / Status 8. */
  reading(): Promise<PlugReading>;
  setPower(on: boolean): Promise<void>;
  /** Our rule slot, Mem11-14 and SetOption83 1 (Zigbee); idempotent; POWER_CONFLICT lists the problems. */
  ensureInstalled(): Promise<void>;
  /** Clears our slot, Mem11-14 and Timer16, and nothing else. */
  uninstall(): Promise<void>;
  armCut(): Promise<void>;
  disarm(): Promise<void>;
  /** Timer16 for local(at - 5 min) on that weekday, Repeat 0, Action 3; null disables it. */
  armWake(atMs: number | null): Promise<void>;
  cycle(): Promise<void>;
  lastCut(): Promise<number | null>;
}

const WAKE_LEAD_MS = 5 * 60_000;
const SLOTS = [1, 2, 3] as const;
type Slot = (typeof SLOTS)[number];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const notTasmota = (address: string) =>
  new PowerError(POWER_ERRORS.notTasmota, `${address} did not answer like a Tasmota device.`);

export function createSwitch(
  config: PowerConfig,
  password: string,
  o: { fetch?: typeof fetch; readWaitMs?: number; now?: () => number } = {},
): PowerSwitch {
  const client = new TasmotaClient({ address: config.address, password, fetch: o.fetch });
  const readWaitMs = o.readWaitMs ?? 1500;
  const now = o.now ?? Date.now;
  const isZigbee = config.kind === 'tasmota-zigbee';

  const field = (res: Record<string, unknown>, key: string): unknown => {
    const hit = Object.keys(res).find((k) => k.toLowerCase() === key.toLowerCase());
    return hit === undefined ? undefined : res[hit];
  };

  const readMem = async (n: number): Promise<string> => {
    const v = field(await client.command(`Mem${n}`), `Mem${n}`);
    if (typeof v !== 'string' && typeof v !== 'number') throw notTasmota(config.address);
    return String(v);
  };

  const readRule = async (n: Slot): Promise<{ text: string; on: boolean }> => {
    const v = field(await client.command(`Rule${n}`), `Rule${n}`) as
      { State?: unknown; Rules?: unknown } | undefined;
    if (!v || typeof v !== 'object') throw notTasmota(config.address);
    return {
      text: typeof v.Rules === 'string' ? v.Rules : '',
      on: String(v.State).toUpperCase() === 'ON',
    };
  };

  const readTimer = async (n: number): Promise<{ Enable: number }> => {
    const v = field(await client.command(`Timer${n}`), `Timer${n}`) as
      { Enable?: unknown } | undefined;
    return { Enable: v && typeof v === 'object' && Number(v.Enable) === 1 ? 1 : 0 };
  };

  const setOption83On = async (): Promise<boolean> => {
    const v = field(await client.command('SetOption83'), 'SetOption83');
    return String(v).toUpperCase() === 'ON' || v === 1 || v === '1';
  };

  /** The device's clock: UTC instant and local offset. Tasmota's UTC/Local are bare date-times. */
  const deviceClock = async (): Promise<{ utcMs: number; offsetMs: number }> => {
    const tim = field(await client.command('Status 7'), 'StatusTIM') as
      { UTC?: unknown; Local?: unknown } | undefined;
    // Read both as if UTC, whatever zone the host is in; a trailing Z or offset is dropped.
    const asUtc = (s: unknown) =>
      typeof s === 'string' ? Date.parse(`${s.replace(/(Z|[+-]\d\d:?\d\d)$/i, '')}Z`) : NaN;
    const utc = asUtc(tim?.UTC);
    const local = asUtc(tim?.Local);
    if (Number.isNaN(utc) || Number.isNaN(local)) throw notTasmota(config.address);
    return { utcMs: utc, offsetMs: Math.round((local - utc) / 60_000) * 60_000 };
  };

  const timersEnabled = async (): Promise<boolean> => {
    const v = field(await client.command('Timers'), 'Timers');
    if (typeof v !== 'string' && typeof v !== 'number') throw notTasmota(config.address);
    return String(v).toUpperCase() === 'ON' || String(v) === '1';
  };

  const notInstalled = () =>
    new PowerError(
      POWER_ERRORS.notConfigured,
      "Threadgarden's rule isn't installed on this switch",
    );

  const ourSlot = async (): Promise<Slot | null> => {
    for (const s of SLOTS) if (isOurs((await readRule(s)).text)) return s;
    return null;
  };

  const sw: PowerSwitch = {
    async reading() {
      const c = commandsFor(config);
      await client.command(c.read);
      if (readWaitMs > 0) await sleep(readWaitMs);
      let on: boolean | null = null;
      let watts: number | null = null;
      // A Wi-Fi plug measures as it answers; a bridge answers from what it last heard.
      let age: number | null = 0;
      if (isZigbee) {
        age = null;
        const st = field(await client.command(`ZbStatus3 ${config.device}`), 'ZbStatus3');
        const d = Array.isArray(st)
          ? (st[0] as { Power?: unknown; ActivePower?: unknown; LastSeen?: unknown } | undefined)
          : undefined;
        if (d && typeof d === 'object') {
          if (typeof d.Power === 'number') on = d.Power === 1;
          if (typeof d.ActivePower === 'number') watts = d.ActivePower;
          if (typeof d.LastSeen === 'number' && d.LastSeen >= 0) age = d.LastSeen;
        }
      } else {
        const sns = field(await client.command('Status 8'), 'StatusSNS') as
          { ENERGY?: { Power?: unknown } } | undefined;
        const p = sns?.ENERGY?.Power;
        if (typeof p === 'number') watts = p;
        const power = field(await client.command('Power'), 'POWER');
        if (typeof power === 'string') on = power.toUpperCase() === 'ON';
      }
      return { on, watts, at: now(), age };
    },

    async setPower(on) {
      const c = commandsFor(config);
      await client.command(on ? c.on : c.off);
    },

    async ensureInstalled() {
      const rules = {} as Record<Slot, { text: string; on: boolean }>;
      for (const s of SLOTS) rules[s] = await readRule(s);
      const texts = { 1: rules[1].text, 2: rules[2].text, 3: rules[3].text };
      const slot = chooseSlot(texts);
      if (slot === null) {
        throw new PowerError(
          POWER_ERRORS.conflict,
          'All three rule slots on this switch are in use, and Threadgarden needs one.',
        );
      }
      const timers = { [RESOURCES.timer]: await readTimer(RESOURCES.timer) };
      const mems: Record<number, string> = {};
      for (const n of RESOURCES.mems) mems[n] = await readMem(n);
      const wanted = memsFor(config);
      const problems = conflicts(texts, slot, timers, mems, wanted);

      let needOption83 = false;
      if (isZigbee && !(await setOption83On())) {
        const byAddress = SLOTS.some((s) => s !== slot && /ZbReceived#0x/i.test(texts[s]));
        if (byAddress) {
          problems.push(
            'Another rule on this bridge names Zigbee devices by address; Threadgarden needs names (SetOption83 1)',
          );
        } else needOption83 = true;
      }
      if (problems.length > 0) throw new PowerError(POWER_ERRORS.conflict, problems.join(' '));

      if (needOption83) await client.command('SetOption83 1');
      const text = ruleText(config);
      if (rules[slot].text !== text) {
        await client.command(`Rule${slot} ${text}`);
        if ((await readRule(slot)).text !== text) {
          throw new PowerError(
            POWER_ERRORS.conflict,
            "The switch didn't store Threadgarden's rule intact (it may be too long for this firmware).",
          );
        }
      }
      // Mem11 holds the last cut's time: written only while empty.
      if (mems[11] === '') await client.command(`Mem11 ${wanted[11]}`);
      for (const n of [12, 13, 14] as const) {
        if (mems[n] === wanted[n]) continue;
        await client.command(`Mem${n} ${wanted[n]}`);
        // A cut-off command would leave the plug off for good: the rule stays off then.
        if ((await readMem(n)) !== wanted[n]) {
          throw new PowerError(
            POWER_ERRORS.conflict,
            "The switch didn't store Threadgarden's settings intact.",
          );
        }
      }
      if (!rules[slot].on) await client.command(`Rule${slot} 1`);
    },

    async uninstall() {
      const slot = await ourSlot();
      if (slot === null) return; // nothing of ours here, so nothing to clear
      await client.command(`Rule${slot} 0`);
      await client.command(`Rule${slot} "`);
      for (const n of RESOURCES.mems) await client.command(`Mem${n} "`);
      await client.command(`Timer${RESOURCES.timer} {"Enable":0}`);
    },

    async armCut() {
      await sw.ensureInstalled();
      await client.command('Event tga');
    },

    async disarm() {
      await client.command('Event tgo');
    },

    async armWake(atMs) {
      const n = RESOURCES.timer;
      if ((await ourSlot()) === null) throw notInstalled();
      if (atMs === null) {
        await client.command(`Timer${n} {"Enable":0}`);
        return;
      }
      if (!(await timersEnabled())) {
        throw new PowerError(
          POWER_ERRORS.conflict,
          "Timers are switched off on this switch (Timers 1 turns them on), so Threadgarden can't wake the machine.",
        );
      }
      const clock = await deviceClock();
      const armAt = atMs - WAKE_LEAD_MS;
      // Repeat 0 matches the next such weekday: a past time would fire a week late, a far one too early.
      if (!(armAt > clock.utcMs + 60_000 && armAt < clock.utcMs + 7 * 86_400_000)) {
        throw new PowerError(
          POWER_ERRORS.conflict,
          'The wake time must be between 1 minute and 7 days from now.',
        );
      }
      const local = new Date(armAt + clock.offsetMs);
      const pad = (v: number) => String(v).padStart(2, '0');
      const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
      const days = Array.from({ length: 7 }, (_, i) => (i === local.getUTCDay() ? '1' : '0')).join(
        '',
      );
      await client.command(
        `Timer${n} ${JSON.stringify({ Enable: 1, Mode: 0, Time: time, Window: 0, Days: days, Repeat: 0, Action: 3 })}`,
      );
    },

    async cycle() {
      await client.command('Event tgw');
    },

    async lastCut() {
      const v = (await readMem(11)).trim();
      if (v === '' || v === '0') return null;
      const secs = Number(v);
      return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
    },
  };
  return sw;
}
