import {
  MIN_TASMOTA,
  POWER_ERRORS,
  type ProbeResult,
  type SwitchDevice,
} from '@threadgarden/protocol';
import { isZigbeeName } from './rules.js';
import { PowerError, TasmotaClient } from './tasmota.js';

type Options = { fetch?: typeof fetch; readWaitMs?: number };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const notTasmota = (address: string) =>
  new PowerError(POWER_ERRORS.notTasmota, `${address} did not answer like a Tasmota device.`);

/** Tasmota's keys vary in case between firmware versions. */
const field = (res: Record<string, unknown>, key: string): unknown => {
  const hit = Object.keys(res).find((k) => k.toLowerCase() === key.toLowerCase());
  return hit === undefined ? undefined : res[hit];
};

/** `16.0.0(release-zbbrdgpro)` and `14.2.0.3(tasmota)` → [16, 0, 0] / [14, 2, 0]. */
function numericVersion(v: string): [number, number, number] | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeastMinimum(version: string): boolean {
  const have = numericVersion(version);
  const min = numericVersion(MIN_TASMOTA)!;
  if (!have) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== min[i]!) return have[i]! > min[i]!;
  }
  return true;
}

type RawDevice = { id: string; name: string | null };

/** The bridge's device list, or null when the command is unknown (not a Zigbee bridge). */
async function zigbeeDevices(client: TasmotaClient): Promise<RawDevice[] | null> {
  const list = field(await client.command('ZbStatus1'), 'ZbStatus1');
  if (!Array.isArray(list)) return null;
  const out: RawDevice[] = [];
  for (const d of list) {
    if (!d || typeof d !== 'object') continue;
    const id = field(d as Record<string, unknown>, 'Device');
    const name = field(d as Record<string, unknown>, 'Name');
    if (typeof id === 'string')
      out.push({ id, name: typeof name === 'string' && name !== '' ? name : null });
  }
  return out;
}

/** Asks every device for its ActivePower, waits once, then reads what each one reports. */
async function describeDevices(
  client: TasmotaClient,
  devices: RawDevice[],
  readWaitMs: number,
): Promise<SwitchDevice[]> {
  for (const d of devices) {
    await client.command(`ZbSend {"Device":"${d.id}","Read":{"ActivePower":true}}`);
  }
  if (devices.length > 0 && readWaitMs > 0) await sleep(readWaitMs);
  const out: SwitchDevice[] = [];
  for (const d of devices) {
    const st = field(await client.command(`ZbStatus3 ${d.id}`), 'ZbStatus3');
    const s = (Array.isArray(st) ? st[0] : undefined) as Record<string, unknown> | undefined;
    const power = s ? field(s, 'Power') : undefined;
    const watts = s ? field(s, 'ActivePower') : undefined;
    out.push({
      id: d.id,
      name: d.name,
      on: typeof power === 'number' ? power === 1 : null,
      watts: typeof watts === 'number' ? watts : null,
      metering: typeof watts === 'number',
    });
  }
  return out;
}

export async function probeSwitch(
  address: string,
  password: string,
  o: Options = {},
): Promise<ProbeResult> {
  const client = new TasmotaClient({ address, password, fetch: o.fetch });
  const fwr = field(await client.command('Status 2'), 'StatusFWR') as
    { Version?: unknown } | undefined;
  const version = fwr && typeof fwr === 'object' ? fwr.Version : undefined;
  if (typeof version !== 'string') throw notTasmota(address);
  if (!atLeastMinimum(version)) {
    throw new PowerError(
      POWER_ERRORS.tooOld,
      `This switch runs Tasmota ${version}; Threadgarden needs ${MIN_TASMOTA} or newer.`,
    );
  }

  const listed = await zigbeeDevices(client);
  if (listed !== null) {
    const devices = await describeDevices(client, listed, o.readWaitMs ?? 1500);
    return { version, kind: 'tasmota-zigbee', devices, plug: null };
  }

  const sns = field(await client.command('Status 8'), 'StatusSNS') as
    { ENERGY?: { Power?: unknown } } | undefined;
  const watts = sns && typeof sns === 'object' ? sns.ENERGY?.Power : undefined;
  if (typeof watts !== 'number') {
    throw new PowerError(
      POWER_ERRORS.noMetering,
      'This switch does not report power use, so Threadgarden cannot tell when the machine is off.',
    );
  }
  const power = field(await client.command('Power'), 'POWER');
  return {
    version,
    kind: 'tasmota-plug',
    devices: [],
    plug: {
      on: typeof power === 'string' ? power.toUpperCase() === 'ON' : null,
      watts,
      at: Date.now(),
    },
  };
}

/**
 * Opens Zigbee pairing and waits for a device that was not on the bridge before.
 * Pairing is closed again whatever happens.
 */
export async function pairPlug(
  address: string,
  password: string,
  o: Options & { timeoutMs?: number; pollMs?: number; closePauseMs?: number } = {},
): Promise<SwitchDevice | null> {
  const client = new TasmotaClient({ address, password, fetch: o.fetch });
  const timeoutMs = o.timeoutMs ?? 60_000;
  const pollMs = o.pollMs ?? 3000;
  const before = await zigbeeDevices(client);
  if (before === null) {
    throw new PowerError(
      POWER_ERRORS.notConfigured,
      'This switch has no Zigbee radio, so there is nothing to pair.',
    );
  }
  const known = new Set(before.map((d) => d.id));

  let fresh: RawDevice | undefined;
  let bodyError: unknown;
  try {
    await client.command('ZbPermitJoin 1');
    const deadline = Date.now() + timeoutMs;
    while (!fresh && Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      fresh = ((await zigbeeDevices(client)) ?? []).find((d) => !known.has(d.id));
    }
  } catch (err) {
    bodyError = err;
  }
  // Close pairing before anything else, so the network is not open during the read below.
  const closeError = await closePairing(client, o.closePauseMs ?? 500);
  if (bodyError !== undefined) throw bodyError;
  if (closeError) throw closeError;
  if (!fresh) return null;
  return (await describeDevices(client, [fresh], o.readWaitMs ?? 1500))[0]!;
}

/** `ZbPermitJoin 0`, up to 3 attempts; returns the error to report, or null once it is closed. */
async function closePairing(client: TasmotaClient, pauseMs: number): Promise<PowerError | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await client.command('ZbPermitJoin 0');
      return null;
    } catch {
      if (attempt < 3 && pauseMs > 0) await sleep(pauseMs);
    }
  }
  return new PowerError(
    POWER_ERRORS.unreachable,
    "Couldn't close pairing on the switch; it closes by itself within a minute, or run ZbPermitJoin 0 on the switch's console.",
  );
}

/** `ZbName <id>,<name>`. The name must be usable in a rule, so it follows the same rule as `commandsFor`. */
export async function renameDevice(
  address: string,
  password: string,
  id: string,
  name: string,
  o: { fetch?: typeof fetch } = {},
): Promise<void> {
  if (!isZigbeeName(name)) {
    throw new PowerError(
      POWER_ERRORS.notConfigured,
      "The Zigbee plug's name can only use letters, digits, '.', '_' and '-'",
    );
  }
  if (!isZigbeeName(id)) {
    throw new PowerError(POWER_ERRORS.notConfigured, "That isn't a Zigbee device id.");
  }
  const client = new TasmotaClient({ address, password, fetch: o.fetch });
  await client.command(`ZbName ${id},${name}`);
}
