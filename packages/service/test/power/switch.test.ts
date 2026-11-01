import { afterEach, describe, expect, it } from 'vitest';
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
  f.timers[1] = { Enable: 1, Mode: 0, Time: '06:00', Window: 0, Days: '1111111', Repeat: 1, Action: 1 };
  f.timers[2] = { Enable: 1, Mode: 0, Time: '22:00', Window: 0, Days: '1111111', Repeat: 1, Action: 0 };
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
    expect(f.commands.filter((c) => /^(rule\d|mem\d|setoption)/i.test(c) && / /.test(c))).toEqual([]);
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
    expect(f.commands.filter((c) => /^rule1 /i.test(c))).toEqual([]);
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

  it('armWake: device at UTC+1', async () => {
    const { f, sw } = await setup();
    f.utcOffsetMinutes = 60;
    await sw.armWake(Date.parse('2026-11-02T02:00:00Z'));
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

  it('armWake: device at UTC+2', async () => {
    const { f, sw } = await setup();
    f.utcOffsetMinutes = 120;
    await sw.armWake(Date.parse('2026-11-02T02:00:00Z'));
    expect(f.timers[16]).toMatchObject({ Time: '03:55', Days: '0100000', Enable: 1 });
  });

  it('armWake rolls the weekday back across local midnight', async () => {
    const { f, sw } = await setup();
    f.utcOffsetMinutes = 60;
    // 00:02 local Tuesday -> 23:57 local Monday
    await sw.armWake(Date.parse('2026-11-02T23:02:00Z'));
    expect(f.timers[16]).toMatchObject({ Time: '23:57', Days: '0100000' });
  });

  it('armWake(null) disables the timer', async () => {
    const { f, sw } = await setup();
    await sw.armWake(Date.parse('2026-11-02T02:00:00Z'));
    await sw.armWake(null);
    expect(f.timers[16]).toMatchObject({ Enable: 0 });
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
