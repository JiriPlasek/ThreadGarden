import { afterEach, describe, expect, it } from 'vitest';
import type { PowerConfig } from '@threadgarden/protocol';
import { openDb, type Db } from '../../src/history/db.js';
import { PowerHub } from '../../src/power/hub.js';
import { startFakeTasmota, type FakeTasmota } from '../../src/testing/fake-tasmota.js';

const fakes: FakeTasmota[] = [];
const dbs: Db[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
  for (const d of dbs.splice(0)) d.close();
});

type Manual = { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
function manualTimers() {
  const scheduled: { fn: () => void; ms: number; live: boolean }[] = [];
  const timers: Manual = {
    set: (fn, ms) => {
      const t = { fn, ms, live: true };
      scheduled.push(t);
      return t;
    },
    clear: (h) => {
      (h as { live: boolean }).live = false;
    },
  };
  return {
    timers,
    scheduled,
    fire: () => {
      for (const t of scheduled) {
        if (!t.live) continue;
        t.live = false;
        t.fn();
      }
    },
  };
}

async function setup(nowMs = 1_000_000_000_000) {
  const f = await startFakeTasmota();
  fakes.push(f);
  const clock = { t: nowMs };
  const t = manualTimers();
  const db = openDb(':memory:');
  dbs.push(db);
  const hub = new PowerHub(db, {
    readWaitMs: 0,
    now: () => clock.t,
    timers: t.timers,
    pairing: { timeoutMs: 50, pollMs: 10, closePauseMs: 0 },
  });
  const config: PowerConfig = {
    kind: 'tasmota-zigbee',
    address: f.address,
    device: 'UbuntuPlug',
    offWatts: 5,
    minOffSeconds: 90,
    measured: { running: null, standby: null },
  };
  f.devices.get('0x863B')!.watts = 0;
  return { f, hub, config, clock, t, db };
}

const count = (f: FakeTasmota, prefix: string) => f.commands.filter((c) => c.startsWith(prefix)).length;

describe('PowerHub', () => {
  it('turnOn from standby cycles', async () => {
    const { f, hub, config } = await setup();
    await hub.configure('m1', config, 'pw');
    const r = await hub.turnOn('m1');
    expect(r).toEqual({ cycled: true, waitMs: 90_000 });
    expect(f.commands.at(-1)).toBe('Event tgw');
  });

  it('turnOn while the machine runs sends nothing', async () => {
    const { f, hub, config } = await setup();
    f.devices.get('0x863B')!.watts = 80;
    await hub.configure('m1', config, 'pw');
    const before = f.commands.length;
    expect(await hub.turnOn('m1')).toEqual({ cycled: false, waitMs: 0 });
    expect(f.commands.slice(before).some((c) => c.startsWith('ZbSend') && c.includes('"Send"') || c.startsWith('Event'))).toBe(false);
  });

  it('turnOn soon after a cut waits out the minimum off time', async () => {
    const { f, hub, config, clock, t } = await setup();
    f.devices.get('0x863B')!.on = false;
    await hub.configure('m1', config, 'pw');
    f.mems[11] = String(Math.floor((clock.t - 30_000) / 1000));
    const r = await hub.turnOn('m1');
    expect(r).toEqual({ cycled: false, waitMs: 60_000 });
    expect(f.commands.some((c) => c.startsWith('ZbSend') && c.includes('"Send"'))).toBe(false);
    expect(t.scheduled.at(-1)?.ms).toBe(60_000);
    // A second request while one is pending is the same result and schedules nothing.
    expect(await hub.turnOn('m1')).toEqual(r);
    expect(t.scheduled.length).toBe(1);
    t.fire();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.commands.some((c) => c.startsWith('ZbSend') && c.includes('"Power":1'))).toBe(true);
  });

  it('turnOn when off long ago switches on at once', async () => {
    const { f, hub, config, clock, t } = await setup();
    f.devices.get('0x863B')!.on = false;
    await hub.configure('m1', config, 'pw');
    f.mems[11] = String(Math.floor((clock.t - 3_600_000) / 1000));
    expect(await hub.turnOn('m1')).toEqual({ cycled: false, waitMs: 0 });
    expect(f.commands.some((c) => c.startsWith('ZbSend') && c.includes('"Power":1'))).toBe(true);
    expect(t.scheduled.length).toBe(0);
  });

  it('reading is cached for 3 s', async () => {
    const { f, hub, config, clock } = await setup();
    await hub.configure('m1', config, 'pw');
    const before = count(f, 'ZbSend');
    await hub.reading('m1');
    await hub.reading('m1');
    clock.t += 2000;
    await hub.reading('m1');
    expect(f.commands.filter((c) => c.startsWith('ZbSend') && c.includes('"Read"')).length).toBe(1);
    expect(before).toBe(0);
    clock.t += 1500;
    await hub.reading('m1');
    expect(f.commands.filter((c) => c.startsWith('ZbSend') && c.includes('"Read"')).length).toBe(2);
  });

  it('reading without a password is POWER_NOT_CONFIGURED', async () => {
    const { hub, config, db } = await setup();
    await hub.configure('m1', config, 'pw');
    const fresh = new PowerHub(db, { readWaitMs: 0 });
    await expect(fresh.reading('m1')).rejects.toMatchObject({ code: 'POWER_NOT_CONFIGURED' });
    await expect(hub.reading('nope')).rejects.toMatchObject({ code: 'POWER_NOT_CONFIGURED' });
  });

  it('configure(null) uninstalls and forgets', async () => {
    const { f, hub, config } = await setup();
    await hub.configure('m1', config, 'pw');
    expect(f.rules[1].text).not.toBe('');
    expect(hub.list()).toHaveLength(1);
    await hub.configure('m1', null);
    expect(f.rules[1].text).toBe('');
    expect(hub.list()).toEqual([]);
    await expect(hub.reading('m1')).rejects.toMatchObject({ code: 'POWER_NOT_CONFIGURED' });
  });

  it('configure without any password is POWER_NOT_CONFIGURED and stores nothing', async () => {
    const { hub, config } = await setup();
    await expect(hub.configure('m1', config)).rejects.toMatchObject({ code: 'POWER_NOT_CONFIGURED' });
    expect(hub.list()).toEqual([]);
  });

  it('a conflict leaves nothing stored', async () => {
    const { f, hub, config } = await setup();
    f.rules[1] = { text: 'on x do y endon', on: true };
    f.rules[2] = { text: 'on x do y endon', on: true };
    f.rules[3] = { text: 'on x do y endon', on: true };
    await expect(hub.configure('m1', config, 'pw')).rejects.toMatchObject({ code: 'POWER_CONFLICT' });
    expect(hub.list()).toEqual([]);
  });

  it('noteMeasurement persists; unknown machine is POWER_NOT_CONFIGURED', async () => {
    const { hub, config } = await setup();
    await hub.configure('m1', config, 'pw');
    hub.noteMeasurement('m1', 'running', 80);
    hub.noteMeasurement('m1', 'standby', 1.5);
    expect(hub.list()[0]!.config.measured).toEqual({ running: 80, standby: 1.5 });
    expect(() => hub.noteMeasurement('zz', 'running', 1)).toThrowError(/./);
    try {
      hub.noteMeasurement('zz', 'running', 1);
    } catch (e) {
      expect(e).toMatchObject({ code: 'POWER_NOT_CONFIGURED' });
    }
  });

  it('rename only accepts a plug that pairPlug returned', async () => {
    const { f, hub } = await setup();
    await expect(hub.rename(f.address, 'pw', '0x863B', 'UbuntuPlug')).rejects.toMatchObject({
      code: 'POWER_NOT_CONFIGURED',
      message: 'Threadgarden only renames a plug it just paired.',
    });
    expect(f.commands.some((c) => c.startsWith('ZbName'))).toBe(false);
    f.joinNext({ id: '0x2222', name: null, on: true, watts: 3 });
    const dev = await hub.pairPlug(f.address, 'pw');
    expect(dev?.id).toBe('0x2222');
    await hub.rename(f.address, 'pw', '0x2222', 'NewPlug');
    expect(f.commands.some((c) => c.startsWith('ZbName 0x2222,NewPlug'))).toBe(true);
  });
});
