import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PowerConfig } from '@threadgarden/protocol';
import { memsFor, ruleText } from '../../src/power/rules.js';
import { createSwitch } from '../../src/power/switch.js';
import { startFakeTasmota, type FakeTasmota } from '../../src/testing/fake-tasmota.js';

const cfg: PowerConfig = {
  kind: 'tasmota-zigbee',
  address: '',
  device: 'UbuntuPlug',
  offWatts: 5,
  minOffSeconds: 90,
  measured: { running: null, standby: null },
};

const growLight =
  'on Clock#Timer=1 do ZbSend {"Device":"GrowLight","Send":{"Power":1}} endon on Clock#Timer=2 do ZbSend {"Device":"GrowLight","Send":{"Power":0}} endon on Time#Initialized do RuleTimer3 30 endon on Rules#Timer=3 do event growlight=%time% endon on event#growlight>=360 do ZbSend {"Device":"GrowLight","Send":{"Power":1}} endon on event#growlight<360 do ZbSend {"Device":"GrowLight","Send":{"Power":0}} endon';

const fakes: FakeTasmota[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

async function setup(o: { kind?: 'zigbee' | 'plug' } = {}) {
  const f = await startFakeTasmota(o);
  fakes.push(f);
  const config: PowerConfig =
    o.kind === 'plug'
      ? { ...cfg, kind: 'tasmota-plug', device: null, address: f.address }
      : { ...cfg, address: f.address };
  const sw = createSwitch(config, 'pw', { readWaitMs: 0 });
  return { f, config, sw };
}

function withGrowLight(f: FakeTasmota) {
  f.rules[2] = { text: growLight, on: true };
  f.timers[1] = {
    Enable: 1,
    Mode: 0,
    Time: '06:00',
    Window: 0,
    Days: '1111111',
    Repeat: 1,
    Action: 1,
  };
  f.timers[2] = {
    Enable: 1,
    Mode: 0,
    Time: '22:00',
    Window: 0,
    Days: '1111111',
    Repeat: 1,
    Action: 0,
  };
  f.vars[1] = 'x';
}

describe('Tasmota switch', () => {
  it('installs into a free slot and leaves the grow light alone', async () => {
    const { f, config, sw } = await setup();
    withGrowLight(f);
    const timers = structuredClone(f.timers);
    await sw.ensureInstalled();
    expect(f.rules[1]).toEqual({ text: ruleText(config), on: true });
    expect(f.rules[2]).toEqual({ text: growLight, on: true });
    expect(f.timers[1]).toEqual(timers[1]);
    expect(f.timers[2]).toEqual(timers[2]);
    expect(f.vars[1]).toBe('x');
    const mems = memsFor(config);
    for (const n of [11, 12, 13, 14] as const) expect(f.mems[n]).toBe(mems[n]);
    expect(f.rules[3].text).toBe('');
  });

  it('ensureInstalled twice sends no Rule write the second time', async () => {
    const { f, sw } = await setup();
    await sw.ensureInstalled();
    f.commands.length = 0;
    await sw.ensureInstalled();
    expect(f.commands.filter((c) => /^(rule\d|mem\d|setoption)/i.test(c) && / /.test(c))).toEqual(
      [],
    );
  });

  it('never overwrites a recorded cut time', async () => {
    const { f, sw } = await setup();
    await sw.ensureInstalled();
    f.mems[11] = '1793545231';
    await sw.ensureInstalled();
    expect(f.mems[11]).toBe('1793545231');
    expect(await sw.lastCut()).toBe(1793545231000);
  });

  it('uninstall clears only ours', async () => {
    const { f, sw } = await setup();
    withGrowLight(f);
    await sw.ensureInstalled();
    await sw.uninstall();
    expect(f.rules[1].text).toBe('');
    expect(f.rules[1].on).toBe(false);
    for (const n of [11, 12, 13, 14]) expect(f.mems[n]).toBe('');
    expect(f.timers[16]).toMatchObject({ Enable: 0 });
    expect(f.rules[2]).toEqual({ text: growLight, on: true });
    expect(f.timers[1]).toMatchObject({ Enable: 1 });
    expect(f.vars[1]).toBe('x');
  });

  it('conflict is reported, nothing written', async () => {
    const { f, sw } = await setup();
    f.rules[3] = { text: 'on Event#x do Var15 1 endon', on: true };
    await expect(sw.ensureInstalled()).rejects.toMatchObject({ code: 'POWER_CONFLICT' });
    expect(f.commands.filter((c) => /^(rule\d|mem\d+|setoption\d+|timer\d+) /i.test(c))).toEqual(
      [],
    );
    expect(f.rules[1].text).toBe('');
    expect(f.mems[11]).toBeUndefined();
  });

  it('SetOption83 conflict: another rule names Zigbee devices by address', async () => {
    const { f, sw } = await setup();
    await sw.ensureInstalled();
    await sw.uninstall();
    // SetOption83 is left on by us; simulate a bridge where it is off
    await fetch(`http://${f.address}/cm?cmnd=${encodeURIComponent('SetOption83 0')}`);
    f.rules[2] = { text: 'on ZbReceived#0x1234#Power do Var1 1 endon', on: true };
    f.commands.length = 0;
    await expect(sw.ensureInstalled()).rejects.toMatchObject({ code: 'POWER_CONFLICT' });
    expect(f.commands.filter((c) => /^(rule1 |setoption83 )/i.test(c))).toEqual([]);
  });

  it('turns SetOption83 on when it is off and nothing names addresses', async () => {
    const { f, sw } = await setup();
    await fetch(`http://${f.address}/cm?cmnd=${encodeURIComponent('SetOption83 0')}`);
    await sw.ensureInstalled();
    expect(f.commands).toContain('SetOption83 1');
  });

  it('reading returns on and watts, after waiting', async () => {
    const { sw } = await setup();
    const r = await sw.reading();
    expect(r).toMatchObject({ on: true, watts: 47 });
    expect(typeof r.at).toBe('number');
  });

  it("reading says how old the Zigbee plug's report is (LastSeen), null when unknown", async () => {
    const { f, sw } = await setup();
    expect(await sw.reading()).toMatchObject({ age: 3 });
    f.devices.get('0x863B')!.lastSeen = 120;
    expect(await sw.reading()).toMatchObject({ age: 120 });
    f.devices.get('0x863B')!.lastSeen = null;
    expect(await sw.reading()).toMatchObject({ age: null });
  });

  it("a Wi-Fi plug's reading is always fresh", async () => {
    const { sw } = await setup({ kind: 'plug' });
    expect(await sw.reading()).toMatchObject({ age: 0 });
  });

  it('reading on a Wi-Fi plug uses Status 8 and Power', async () => {
    const { f, sw } = await setup({ kind: 'plug' });
    f.devices.get('plug')!.on = false;
    expect(await sw.reading()).toMatchObject({ on: false, watts: 0 });
    await sw.setPower(true);
    expect(await sw.reading()).toMatchObject({ on: true, watts: 47 });
  });

  it('setPower drives the Zigbee plug', async () => {
    const { f, sw } = await setup();
    await sw.setPower(false);
    expect(f.devices.get('0x863B')?.on).toBe(false);
  });

  it('armCut installs then fires tga; disarm and cycle send their events', async () => {
    const { f, sw } = await setup();
    await sw.armCut();
    expect(f.rules[1].text).not.toBe('');
    expect(f.commands.at(-1)).toBe('Event tga');
    await sw.disarm();
    expect(f.commands.at(-1)).toBe('Event tgo');
    await sw.cycle();
    expect(f.commands.at(-1)).toBe('Event tgw');
  });

  describe('armWake', () => {
    const NOW = '2026-11-01T12:00:00Z'; // a Sunday
    // Monday 2026-11-02 02:00Z
    const DUE = Date.parse('2026-11-02T02:00:00Z');
    afterEach(() => {
      vi.useRealTimers();
    });
    const setupAt = async (offsetMinutes: number) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      const s = await setup();
      s.f.utcOffsetMinutes = offsetMinutes;
      await s.sw.ensureInstalled();
      return s;
    };

    it('device at UTC+1', async () => {
      const { f, sw } = await setupAt(60);
      await sw.armWake(DUE);
      expect(f.timers[16]).toEqual({
        Enable: 1,
        Mode: 0,
        Time: '02:55',
        Window: 0,
        Days: '0100000',
        Repeat: 0,
        Action: 3,
      });
    });

    it('device at UTC+2', async () => {
      const { f, sw } = await setupAt(120);
      await sw.armWake(DUE);
      expect(f.timers[16]).toMatchObject({ Time: '03:55', Days: '0100000', Enable: 1 });
    });

    it('rolls the weekday back across local midnight', async () => {
      const { f, sw } = await setupAt(60);
      // 00:02 local Tuesday -> 23:57 local Monday
      await sw.armWake(Date.parse('2026-11-02T23:02:00Z'));
      expect(f.timers[16]).toMatchObject({ Time: '23:57', Days: '0100000' });
    });

    it('reads the offset right whatever zone the host is in', async () => {
      const old = process.env.TZ;
      process.env.TZ = 'Europe/Prague';
      try {
        const { f, sw } = await setupAt(120);
        await sw.armWake(DUE);
        expect(f.timers[16]).toMatchObject({ Time: '03:55' });
      } finally {
        if (old === undefined) delete process.env.TZ;
        else process.env.TZ = old;
      }
    });

    it('null disables the timer', async () => {
      const { f, sw } = await setupAt(60);
      await sw.armWake(DUE);
      await sw.armWake(null);
      expect(f.timers[16]).toMatchObject({ Enable: 0 });
    });

    it('refuses a wake whose arm time is under a minute away or past', async () => {
      const { f, sw } = await setupAt(60);
      const now = Date.parse(NOW);
      for (const at of [now + 5 * 60_000 + 30_000, now, now - 3600_000]) {
        await expect(sw.armWake(at)).rejects.toMatchObject({
          code: 'POWER_CONFLICT',
          message: 'The wake time must be between 1 minute and 7 days from now.',
        });
      }
      expect(f.timers[16]).toBeUndefined();
    });

    it('refuses a wake more than 7 days out, accepts the edges inside', async () => {
      const { f, sw } = await setupAt(60);
      const now = Date.parse(NOW);
      await expect(sw.armWake(now + 5 * 60_000 + 7 * 86_400_000 + 10_000)).rejects.toMatchObject({
        code: 'POWER_CONFLICT',
      });
      await sw.armWake(now + 5 * 60_000 + 7 * 86_400_000 - 60_000);
      expect(f.timers[16]).toMatchObject({ Enable: 1 });
      await sw.armWake(now + 5 * 60_000 + 2 * 60_000);
      expect(f.timers[16]).toMatchObject({ Enable: 1, Time: '13:02' });
    });

    it('needs our rule installed, otherwise throws and writes nothing', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      const { f, sw } = await setup();
      f.timers[16] = {
        Enable: 1,
        Mode: 0,
        Time: '05:00',
        Window: 0,
        Days: '1111111',
        Repeat: 1,
        Action: 1,
      };
      const before = structuredClone(f.timers);
      for (const at of [DUE, null]) {
        await expect(sw.armWake(at)).rejects.toMatchObject({ code: 'POWER_NOT_CONFIGURED' });
      }
      expect(f.timers).toEqual(before);
      expect(f.commands.filter((c) => /^timer16 /i.test(c))).toEqual([]);
    });

    it('refuses when the global Timers flag is off, and never switches it on', async () => {
      const { f, sw } = await setupAt(60);
      f.timersOn = false;
      f.commands.length = 0;
      await expect(sw.armWake(DUE)).rejects.toMatchObject({
        code: 'POWER_CONFLICT',
        message:
          "Timers are switched off on this switch (Timers 1 turns them on), so Threadgarden can't wake the machine.",
      });
      expect(f.timersOn).toBe(false);
      expect(f.commands.filter((c) => /^timers \S/i.test(c))).toEqual([]);
    });
  });

  it('uninstall with no rule of ours writes nothing', async () => {
    const { f, sw } = await setup();
    f.timers[16] = {
      Enable: 1,
      Mode: 0,
      Time: '05:00',
      Window: 0,
      Days: '1111111',
      Repeat: 1,
      Action: 1,
    };
    f.mems[12] = 'foreign';
    f.commands.length = 0;
    await sw.uninstall();
    expect(f.mems[12]).toBe('foreign');
    expect(f.timers[16]).toMatchObject({ Enable: 1 });
    expect(f.commands.filter((c) => /^(rule\d|mem\d+|timer\d+) /i.test(c))).toEqual([]);
  });

  it('a foreign "0" in Mem13 is a conflict', async () => {
    const { f, sw } = await setup();
    f.mems[13] = '0';
    await expect(sw.ensureInstalled()).rejects.toMatchObject({ code: 'POWER_CONFLICT' });
    expect(f.rules[1].text).toBe('');
  });

  it('a rule the switch truncates is reported and left disabled', async () => {
    const f = await startFakeTasmota({ maxRuleLength: 200 });
    fakes.push(f);
    const sw = createSwitch({ ...cfg, address: f.address }, 'pw', { readWaitMs: 0 });
    await expect(sw.ensureInstalled()).rejects.toMatchObject({
      code: 'POWER_CONFLICT',
      message:
        "The switch didn't store Threadgarden's rule intact (it may be too long for this firmware).",
    });
    expect(f.rules[1].on).toBe(false);
  });

  it('a missing Mem answer is POWER_NOT_TASMOTA', async () => {
    const odd = createSwitch({ ...cfg, address: '1.2.3.4' }, 'pw', {
      fetch: async () => new Response('{"Command":"Unknown"}'),
    });
    await expect(odd.lastCut()).rejects.toMatchObject({ code: 'POWER_NOT_TASMOTA' });
  });

  it('lastCut reads Mem11 as seconds', async () => {
    const { f, sw } = await setup();
    f.mems[11] = '1793545231';
    expect(await sw.lastCut()).toBe(1793545231000);
    f.mems[11] = '0';
    expect(await sw.lastCut()).toBeNull();
    f.mems[11] = '';
    expect(await sw.lastCut()).toBeNull();
  });
});
