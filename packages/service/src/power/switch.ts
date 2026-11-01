import { POWER_ERRORS, type PlugReading, type PowerConfig } from '@threadgarden/protocol';
import { RESOURCES, chooseSlot, commandsFor, conflicts, isOurs, memsFor, ruleText } from './rules.js';
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

/** An unset Mem answers ""; a stray "0" in Mem12-14 is treated alike (only Mem11 legitimately holds "0"). */
const blank = (v: string) => (v === '0' ? '' : v);

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
    return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  };

  const readRule = async (n: Slot): Promise<{ text: string; on: boolean }> => {
    const v = field(await client.command(`Rule${n}`), `Rule${n}`) as
      | { State?: unknown; Rules?: unknown }
      | undefined;
    if (!v || typeof v !== 'object') throw notTasmota(config.address);
    return { text: typeof v.Rules === 'string' ? v.Rules : '', on: String(v.State).toUpperCase() === 'ON' };
  };

  const readTimer = async (n: number): Promise<{ Enable: number }> => {
    const v = field(await client.command(`Timer${n}`), `Timer${n}`) as { Enable?: unknown } | undefined;
    return { Enable: v && typeof v === 'object' && Number(v.Enable) === 1 ? 1 : 0 };
  };

  const setOption83On = async (): Promise<boolean> => {
    const v = field(await client.command('SetOption83'), 'SetOption83');
    return String(v).toUpperCase() === 'ON' || v === 1 || v === '1';
  };

  const utcOffsetMs = async (): Promise<number> => {
    const tim = field(await client.command('Status 7'), 'StatusTIM') as
      | { UTC?: unknown; Local?: unknown }
      | undefined;
    const utc = typeof tim?.UTC === 'string' ? Date.parse(tim.UTC) : NaN;
    const local = typeof tim?.Local === 'string' ? Date.parse(`${tim.Local}Z`) : NaN;
    if (Number.isNaN(utc) || Number.isNaN(local)) throw notTasmota(config.address);
    return Math.round((local - utc) / 60_000) * 60_000;
  };

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
      if (isZigbee) {
        const st = field(await client.command(`ZbStatus3 ${config.device}`), 'ZbStatus3');
        const d = Array.isArray(st) ? (st[0] as { Power?: unknown; ActivePower?: unknown } | undefined) : undefined;
        if (d && typeof d === 'object') {
          if (typeof d.Power === 'number') on = d.Power === 1;
          if (typeof d.ActivePower === 'number') watts = d.ActivePower;
        }
      } else {
        const sns = field(await client.command('Status 8'), 'StatusSNS') as
          | { ENERGY?: { Power?: unknown } }
          | undefined;
        const p = sns?.ENERGY?.Power;
        if (typeof p === 'number') watts = p;
        const power = field(await client.command('Power'), 'POWER');
        if (typeof power === 'string') on = power.toUpperCase() === 'ON';
      }
      return { on, watts, at: now() };
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
      for (const n of RESOURCES.mems) mems[n] = n === 11 ? await readMem(n) : blank(await readMem(n));
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
      if (rules[slot].text !== text) await client.command(`Rule${slot} ${text}`);
      if (!rules[slot].on) await client.command(`Rule${slot} 1`);
      // Mem11 holds the last cut's time: written only while empty.
      if (mems[11] === '') await client.command(`Mem11 ${wanted[11]}`);
      for (const n of [12, 13, 14] as const) {
        if (mems[n] !== wanted[n]) await client.command(`Mem${n} ${wanted[n]}`);
      }
    },

    async uninstall() {
      const slot = await ourSlot();
      if (slot !== null) {
        await client.command(`Rule${slot} 0`);
        await client.command(`Rule${slot} "`);
      }
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
      if (atMs === null) {
        await client.command(`Timer${n} {"Enable":0}`);
        return;
      }
      const local = new Date(atMs - WAKE_LEAD_MS + (await utcOffsetMs()));
      const pad = (v: number) => String(v).padStart(2, '0');
      const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
      const days = Array.from({ length: 7 }, (_, i) => (i === local.getUTCDay() ? '1' : '0')).join('');
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
