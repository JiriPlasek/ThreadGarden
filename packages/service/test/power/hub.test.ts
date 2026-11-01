import { afterEach, describe, expect, it, vi } from 'vitest';
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

const warnings: string[] = [];
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
    log: { warn: (m: string) => warnings.push(m) },
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

const powerOn = (f: FakeTasmota) =>
  f.commands.some((c) => c.startsWith('ZbSend') && c.includes('"Power":1'));
const count = (f: FakeTasmota, prefix: string) =>
  f.commands.filter((c) => c.startsWith(prefix)).length;

describe('PowerHub', () => {
  it('turnOn from standby cycles', async () => {
    const { f, hub, config } = await setup();
    await hub.configure('m1', config, 'pw');
    const r = await hub.turnOn('m1');
    expect(r).toEqual({ cycled: true, waitMs: 90_000 });
    expect(f.commands).toContain('Event tgw');
  });

  const WAKE = {
    Enable: 1,
    Mode: 0,
    Time: '01:00',
    Window: 0,
    Days: '1000000',
    Repeat: 0,
    Action: 3,
  };

  it('a turnOn that cycles clears a wake left on the switch', async () => {
    const { f, hub, config } = await setup();
    await hub.configure('m1', config, 'pw');
    f.timers[16] = { ...WAKE };
    expect(await hub.turnOn('m1')).toMatchObject({ cycled: true });
    expect(f.commands.lastIndexOf('Timer16 {"Enable":0}')).toBeGreaterThan(
      f.commands.indexOf('Event tgw'),
    );
    expect(f.timers[16]).toMatchObject({ Enable: 0 });
  });

  it('a turnOn that switches on clears a wake left on the switch, at once or after the wait', async () => {
    const { f, hub, config, clock, t } = await setup();
    f.devices.get('0x863B')!.on = false;
    await hub.configure('m1', config, 'pw');
    f.timers[16] = { ...WAKE };
    f.mems[11] = String(Math.floor((clock.t - 3_600_000) / 1000));
    expect(await hub.turnOn('m1')).toEqual({ cycled: false, waitMs: 0 });
    expect(f.timers[16]).toMatchObject({ Enable: 0 });

    f.devices.get('0x863B')!.on = false;
    f.timers[16] = { ...WAKE };
    f.mems[11] = String(Math.floor((clock.t - 30_000) / 1000));
    expect(await hub.turnOn('m1')).toMatchObject({ waitMs: 60_000 });
    expect(f.timers[16]).toMatchObject({ Enable: 1 });
    t.fire();
    await vi.waitFor(() => expect(f.timers[16]).toMatchObject({ Enable: 0 }));
    expect(f.devices.get('0x863B')!.on).toBe(true);
  });

  it.each([60, null])(
    'turnOn never cycles on a stale standby reading (LastSeen %s)',
    async (lastSeen) => {
      const { f, hub, config } = await setup();
      await hub.configure('m1', config, 'pw');
      f.devices.get('0x863B')!.lastSeen = lastSeen;
      await expect(hub.turnOn('m1')).rejects.toMatchObject({
        code: 'POWER_UNREACHABLE',
        message: "Couldn't get a fresh reading from the plug; try again.",
      });
      expect(f.commands).not.toContain('Event tgw');
      expect(f.devices.get('0x863B')!.on).toBe(true);
    },
  );

  it('a second machine on the same switch is refused, naming the first', async () => {
    const { f, hub, config, db } = await setup();
    db.raw
      .prepare(
        'INSERT INTO machines (id, name, address, port, cert_pem, fingerprint, device_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('m1', 'Ubuntu PC', '192.168.1.20', 7443, 'cert', 'fp', 'd1', 1);
    await hub.configure('m1', config, 'pw');
    const rule = f.rules[1].text;
    const before = f.commands.length;
    await expect(
      hub.configure('m2', { ...config, device: 'OtherPlug' }, 'pw'),
    ).rejects.toMatchObject({
      code: 'POWER_CONFLICT',
      message:
        'This switch already powers Ubuntu PC; Threadgarden supports one machine per switch for now.',
    });
    expect(f.commands.length).toBe(before);
    expect(f.rules[1].text).toBe(rule);
    expect(hub.list().map((p) => p.machineId)).toEqual(['m1']);
    // A machine this PC no longer knows by name is named by its id.
    db.raw.prepare('DELETE FROM machines WHERE id = ?').run('m1');
    await expect(hub.configure('m3', config, 'pw')).rejects.toMatchObject({
      code: 'POWER_CONFLICT',
      message: expect.stringMatching(/^This switch already powers m1;/),
    });
    // The machine itself may be set up again on its switch.
    await expect(hub.configure('m1', { ...config, offWatts: 8 })).resolves.toMatchObject({
      offWatts: 8,
    });
  });

  it('turnOn while the machine runs sends nothing', async () => {
    const { f, hub, config } = await setup();
    f.devices.get('0x863B')!.watts = 80;
    await hub.configure('m1', config, 'pw');
    const before = f.commands.length;
    expect(await hub.turnOn('m1')).toEqual({ cycled: false, waitMs: 0 });
    expect(
      f.commands
        .slice(before)
        .some((c) => (c.startsWith('ZbSend') && c.includes('"Send"')) || c.startsWith('Event')),
    ).toBe(false);
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
    await vi.waitFor(() => expect(powerOn(f)).toBe(true));
  });

  async function recentCut(
    hub: PowerHub,
    f: FakeTasmota,
    config: PowerConfig,
    clock: { t: number },
  ) {
    f.devices.get('0x863B')!.on = false;
    await hub.configure('m1', config, 'pw');
    f.mems[11] = String(Math.floor((clock.t - 30_000) / 1000));
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('two concurrent turnOn from standby cycle once', async () => {
    const { f, hub, config } = await setup();
    await hub.configure('m1', config, 'pw');
    const [a, b] = await Promise.all([hub.turnOn('m1'), hub.turnOn('m1')]);
    expect(a).toEqual(b);
    expect(count(f, 'Event tgw')).toBe(1);
  });

  it('two concurrent turnOn after a recent cut schedule one timer', async () => {
    const { f, hub, config, clock, t } = await setup();
    await recentCut(hub, f, config, clock);
    await Promise.all([hub.turnOn('m1'), hub.turnOn('m1')]);
    expect(t.scheduled.length).toBe(1);
  });

  it('configure(null) during an in-flight turnOn schedules nothing', async () => {
    const { f, hub, config, clock, t } = await setup();
    await recentCut(hub, f, config, clock);
    const turning = hub.turnOn('m1');
    await hub.configure('m1', null);
    await turning.catch(() => {});
    t.fire();
    await settle();
    expect(t.scheduled.filter((x) => x.live).length).toBe(0);
    expect(powerOn(f)).toBe(false);
  });

  it('configure(null) during a pending wait cancels it', async () => {
    const { f, hub, config, clock, t } = await setup();
    await recentCut(hub, f, config, clock);
    await hub.turnOn('m1');
    await hub.configure('m1', null);
    t.fire();
    await settle();
    expect(powerOn(f)).toBe(false);
  });

  it('close() cancels a pending wait', async () => {
    const { f, hub, config, clock, t } = await setup();
    await recentCut(hub, f, config, clock);
    await hub.turnOn('m1');
    hub.close();
    t.fire();
    await settle();
    expect(powerOn(f)).toBe(false);
  });

  it('configure(null) removes the config even when the switch is unreachable', async () => {
    const { f, hub, config } = await setup();
    await hub.configure('m1', config, 'pw');
    await f.close();
    await expect(hub.configure('m1', null)).resolves.toBeNull();
    expect(hub.list()).toEqual([]);
    expect(warnings.some((w) => w.includes('POWER_'))).toBe(true);
    expect(warnings.join()).not.toContain('"pw"');
  });

  it('a failed delayed switch-on is logged by code', async () => {
    const { f, hub, config, clock, t } = await setup();
    await recentCut(hub, f, config, clock);
    await hub.turnOn('m1');
    warnings.length = 0;
    await f.close();
    t.fire();
    await vi.waitFor(() => expect(warnings.some((w) => w.includes('POWER_'))).toBe(true));
  });

  it('reconfiguring to another address uninstalls from the old switch', async () => {
    const { f, hub, config } = await setup();
    const g = await startFakeTasmota();
    fakes.push(g);
    await hub.configure('m1', config, 'pw');
    expect(f.rules[1].text).not.toBe('');
    await hub.configure('m1', { ...config, address: g.address });
    expect(f.rules[1].text).toBe('');
    expect(g.rules[1].text).not.toBe('');
    expect(hub.list()[0]!.config.address).toBe(g.address);
  });

  it('reconfiguring to a switch that refuses the install leaves the old switch as it was', async () => {
    const { f, hub, config } = await setup();
    const g = await startFakeTasmota();
    fakes.push(g);
    g.rules[1] = { text: 'on x do y endon', on: true };
    g.rules[2] = { text: 'on x do y endon', on: true };
    g.rules[3] = { text: 'on x do y endon', on: true };
    await hub.configure('m1', config, 'pw');
    const rule = { ...f.rules[1] };
    await expect(hub.configure('m1', { ...config, address: g.address })).rejects.toMatchObject({
      code: 'POWER_CONFLICT',
    });
    expect(f.rules[1]).toEqual(rule);
    expect(hub.list()[0]!.config.address).toBe(f.address);
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
    await expect(hub.configure('m1', config)).rejects.toMatchObject({
      code: 'POWER_NOT_CONFIGURED',
    });
    expect(hub.list()).toEqual([]);
  });

  it('a conflict leaves nothing stored', async () => {
    const { f, hub, config } = await setup();
    f.rules[1] = { text: 'on x do y endon', on: true };
    f.rules[2] = { text: 'on x do y endon', on: true };
    f.rules[3] = { text: 'on x do y endon', on: true };
    await expect(hub.configure('m1', config, 'pw')).rejects.toMatchObject({
      code: 'POWER_CONFLICT',
    });
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
