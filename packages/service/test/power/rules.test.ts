import { describe, expect, it } from 'vitest';
import type { PowerConfig } from '@threadgarden/protocol';
import {
  RESOURCES,
  chooseSlot,
  commandsFor,
  conflicts,
  isOurs,
  memsFor,
  ruleText,
} from '../../src/power/rules.js';

const cfg: PowerConfig = {
  kind: 'tasmota-zigbee',
  address: '192.168.1.5',
  device: 'UbuntuPlug',
  offWatts: 5,
  minOffSeconds: 90,
  measured: { running: null, standby: null },
};
const plug: PowerConfig = { ...cfg, kind: 'tasmota-plug', device: null };

const growLight =
  'on Clock#Timer=1 do ZbSend {"Device":"GrowLight","Send":{"Power":1}} endon on Clock#Timer=2 do ZbSend {"Device":"GrowLight","Send":{"Power":0}} endon on Time#Initialized do RuleTimer3 30 endon on Rules#Timer=3 do event growlight=%time% endon on event#growlight>=360 do ZbSend {"Device":"GrowLight","Send":{"Power":1}} endon on event#growlight<360 do ZbSend {"Device":"GrowLight","Send":{"Power":0}} endon';

const expected = [
  'on Event#tga do Backlog Var14 0;Var15 1;RuleTimer7 5;RuleTimer8 900 endon',
  'on Event#tgo do Backlog Var15 0;Var14 0;RuleTimer7 0;RuleTimer8 0 endon',
  'on Rules#Timer=7 do Backlog %mem14%;RuleTimer7 5 endon',
  'on ZbReceived#UbuntuPlug#ActivePower<5 do Add14 %var15% endon',
  'on ZbReceived#UbuntuPlug#ActivePower>=5 do Var14 0 endon',
  'on Var14#State>=6 do Backlog %mem12%;Mem11 %utctime%;Event tgo endon',
  'on Rules#Timer=8 do Event tgo endon',
  'on Event#tgw do Backlog %mem12%;RuleTimer6 90 endon',
  'on Rules#Timer=6 do %mem13% endon',
  'on Clock#Timer=16 do Event tgw endon',
].join(' ');

describe('ruleText', () => {
  it("for the owner's plug", () => {
    expect(ruleText(cfg)).toBe(expected);
  });
  it('renders fractional watts without padding', () => {
    expect(ruleText({ ...cfg, offWatts: 2.5 })).toContain('ActivePower<2.5 do');
  });
  it('uses the plug trigger for a Wi-Fi plug', () => {
    expect(ruleText(plug)).toContain('on StatusSNS#ENERGY#Power<5 do Add14');
  });
});

describe('commandsFor and memsFor', () => {
  it('zigbee', () => {
    expect(commandsFor(cfg)).toEqual({
      off: 'ZbSend {"Device":"UbuntuPlug","Send":{"Power":0}}',
      on: 'ZbSend {"Device":"UbuntuPlug","Send":{"Power":1}}',
      read: 'ZbSend {"Device":"UbuntuPlug","Read":{"ActivePower":true}}',
      trigger: 'ZbReceived#UbuntuPlug#ActivePower',
    });
  });
  it('plug', () => {
    expect(commandsFor(plug)).toEqual({
      off: 'Power 0',
      on: 'Power 1',
      read: 'Status 8',
      trigger: 'StatusSNS#ENERGY#Power',
    });
  });
  it('mems', () => {
    expect(memsFor(plug)).toEqual({ 11: '0', 12: 'Power 0', 13: 'Power 1', 14: 'Status 8' });
    expect(RESOURCES.timer).toBe(16);
  });
});

describe('claiming', () => {
  const timers = { 1: { Enable: 1 }, 2: { Enable: 1 }, 16: { Enable: 0 } };
  it("the grow light's rules are no conflict", () => {
    expect(chooseSlot({ 1: '', 2: growLight, 3: '' })).toBe(1);
    expect(conflicts({ 1: '', 2: growLight, 3: '' }, 1, timers, {}, memsFor(cfg))).toEqual([]);
  });
  it('a foreign rule using RuleTimer7 is a conflict, RuleTimer70 is not', () => {
    const bad = { 1: '', 2: 'on x do RuleTimer7 5 endon', 3: '' };
    expect(conflicts(bad, 1, timers, {}, memsFor(cfg))).toEqual([
      'Rule 2 uses RuleTimer7, which Threadgarden needs.',
    ]);
    const ok = {
      1: '',
      2: 'on x do RuleTimer70 5 endon on y do Var140 1 endon Mem110 Rules#Timer=60 Clock#Timer=160',
      3: '',
    };
    expect(conflicts(ok, 1, timers, {}, memsFor(cfg))).toEqual([]);
    const ci = { 1: '', 2: 'on x do ruletimer7 5 endon', 3: '' };
    expect(conflicts(ci, 1, timers, {}, memsFor(cfg))).toHaveLength(1);
  });
  it('Var14, Mem12 and Clock#Timer=16 in another rule conflict', () => {
    const r = {
      1: '',
      2: 'on a do Var14 1 endon on b do %mem12% endon on Clock#Timer=16 do x endon',
      3: '',
    };
    expect(conflicts(r, 1, timers, {}, memsFor(cfg))).toHaveLength(3);
  });
  it('our own slot is found again and not a conflict with itself', () => {
    const rules = { 1: 'x', 2: growLight, 3: ruleText(cfg) };
    expect(chooseSlot(rules)).toBe(3);
    expect(isOurs(rules[3])).toBe(true);
    expect(isOurs(growLight)).toBe(false);
    expect(
      conflicts(
        rules,
        3,
        { ...timers, 16: { Enable: 1 } },
        { 11: '2026-01-01T00:00:00', 12: memsFor(cfg)[12] },
        memsFor(cfg),
      ),
    ).toEqual([]);
  });
  it('no free slot gives null', () => {
    expect(chooseSlot({ 1: 'a', 2: 'b', 3: 'c' })).toBeNull();
  });
  it('an enabled Timer16 with our slot empty belongs to someone else', () => {
    expect(conflicts({ 1: '', 2: '', 3: '' }, 1, { 16: { Enable: 1 } }, {}, memsFor(cfg))).toEqual([
      'Timer 16 is in use by another rule.',
    ]);
  });
  it('a Mem holding a foreign value is a conflict', () => {
    expect(
      conflicts({ 1: '', 2: '', 3: '' }, 1, {}, { 12: 'Power 2', 13: '', 11: '0' }, memsFor(cfg)),
    ).toEqual(["Mem12 holds a value Threadgarden didn't write."]);
  });
});
