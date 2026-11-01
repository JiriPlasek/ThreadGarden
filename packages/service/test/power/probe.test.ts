import { afterEach, describe, expect, it } from 'vitest';
import { POWER_ERRORS } from '@threadgarden/protocol';
import { pairPlug, probeSwitch, renameDevice } from '../../src/power/probe.js';
import { startFakeTasmota, type FakeTasmota } from '../../src/testing/fake-tasmota.js';

const fakes: FakeTasmota[] = [];
const fake = async (o?: Parameters<typeof startFakeTasmota>[0]) => {
  const f = await startFakeTasmota(o);
  fakes.push(f);
  return f;
};
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

const fast = { readWaitMs: 0 };

describe('probeSwitch', () => {
  it('zigbee bridge with a metering plug and a non-metering device', async () => {
    const f = await fake();
    f.devices.get('0x1234')!.metering = false;
    const r = await probeSwitch(f.address, 'pw', fast);
    expect(r.kind).toBe('tasmota-zigbee');
    expect(r.version).toBe('16.0.0(release-zbbrdgpro)');
    expect(r.plug).toBeNull();
    expect(r.devices).toEqual([
      { id: '0x863B', name: 'UbuntuPlug', on: true, watts: 47, metering: true },
      { id: '0x1234', name: 'GrowLight', on: true, watts: null, metering: false },
    ]);
    // each device is asked for ActivePower once, before ZbStatus3
    const asks = f.commands.filter((c) => c.startsWith('ZbSend'));
    expect(asks).toHaveLength(2);
    expect(f.commands.indexOf(asks[1]!)).toBeLessThan(f.commands.findIndex((c) => c.startsWith('ZbStatus3')));
  });

  it('plug kind', async () => {
    const f = await fake({ kind: 'plug' });
    const r = await probeSwitch(f.address, 'pw', fast);
    expect(r.kind).toBe('tasmota-plug');
    expect(r.devices).toEqual([]);
    expect(r.plug?.watts).toBe(47);
    expect(r.plug?.on).toBe(true);
  });

  it('too old', async () => {
    const f = await fake({ version: '12.5.0' });
    await expect(probeSwitch(f.address, 'pw', fast)).rejects.toMatchObject({ code: POWER_ERRORS.tooOld });
  });

  it('accepts a four-part version at the minimum', async () => {
    const f = await fake({ kind: 'plug', version: '14.0.0.3(tasmota)' });
    expect((await probeSwitch(f.address, 'pw', fast)).kind).toBe('tasmota-plug');
  });

  it('a plug without energy metering → POWER_NO_METERING', async () => {
    const f = await fake({ kind: 'plug' });
    const real = globalThis.fetch;
    const noEnergy: typeof fetch = async (url, init) => {
      if (String(url).includes('Status%208')) {
        return new Response(JSON.stringify({ StatusSNS: { Time: '2026-01-01T00:00:00' } }));
      }
      return real(url, init);
    };
    await expect(probeSwitch(f.address, 'pw', { fetch: noEnergy, ...fast })).rejects.toMatchObject({
      code: POWER_ERRORS.noMetering,
    });
  });

  it('a wrong password → POWER_AUTH', async () => {
    const f = await fake({ password: 'right' });
    await expect(probeSwitch(f.address, 'wrong', fast)).rejects.toMatchObject({ code: POWER_ERRORS.auth });
  });
});

describe('pairPlug', () => {
  const permits = (f: FakeTasmota) => f.commands.filter((c) => c.startsWith('ZbPermitJoin'));

  it('returns the new device and closes pairing', async () => {
    const f = await fake();
    f.joinNext({ id: '0xBEEF', watts: 9 });
    const dev = await pairPlug(f.address, 'pw', { pollMs: 5, timeoutMs: 2000, ...fast });
    expect(dev).toEqual({ id: '0xBEEF', name: null, on: true, watts: 9, metering: true });
    expect(permits(f).at(-1)).toBe('ZbPermitJoin 0');
  });

  it('keeps polling until the device appears (after 2 polls)', async () => {
    const f = await fake();
    const real = globalThis.fetch;
    let polls = 0;
    const hooked: typeof fetch = async (url, init) => {
      if (String(url).includes('ZbStatus1') && ++polls === 3) {
        f.devices.set('0xBEEF', { name: null, on: true, watts: 3 });
      }
      return real(url, init);
    };
    const dev = await pairPlug(f.address, 'pw', { fetch: hooked, pollMs: 5, timeoutMs: 5000, ...fast });
    expect(dev?.id).toBe('0xBEEF');
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(permits(f).at(-1)).toBe('ZbPermitJoin 0');
  });

  it('times out → null and closes pairing', async () => {
    const f = await fake();
    const dev = await pairPlug(f.address, 'pw', { timeoutMs: 100, pollMs: 10, ...fast });
    expect(dev).toBeNull();
    expect(permits(f)).toEqual(['ZbPermitJoin 1', 'ZbPermitJoin 0']);
  });

  it('closes pairing when polling throws', async () => {
    const f = await fake();
    const real = globalThis.fetch;
    let polls = 0;
    const flaky: typeof fetch = async (url, init) => {
      if (String(url).includes('ZbStatus1') && ++polls === 2) throw new TypeError('fetch failed');
      return real(url, init);
    };
    await expect(
      pairPlug(f.address, 'pw', { fetch: flaky, pollMs: 5, timeoutMs: 5000, ...fast }),
    ).rejects.toMatchObject({ code: POWER_ERRORS.unreachable });
    expect(permits(f).at(-1)).toBe('ZbPermitJoin 0');
  });

  it('a Wi-Fi plug has nothing to pair', async () => {
    const f = await fake({ kind: 'plug' });
    await expect(pairPlug(f.address, 'pw', { timeoutMs: 100, pollMs: 10, ...fast })).rejects.toMatchObject({
      code: POWER_ERRORS.notTasmota,
    });
  });
});

describe('renameDevice', () => {
  it('sends ZbName', async () => {
    const f = await fake();
    await renameDevice(f.address, 'pw', '0x863B', 'Desk-PC.plug');
    expect(f.commands).toContain('ZbName 0x863B,Desk-PC.plug');
    expect(f.devices.get('0x863B')!.name).toBe('Desk-PC.plug');
  });

  it('refuses a name that would break a rule, without sending anything', async () => {
    const f = await fake();
    await expect(renameDevice(f.address, 'pw', '0x863B', 'my plug')).rejects.toMatchObject({
      code: POWER_ERRORS.notConfigured,
    });
    expect(f.commands).toEqual([]);
  });

  it('refuses an id with a comma, without sending anything', async () => {
    const f = await fake();
    await expect(renameDevice(f.address, 'pw', '0x1,x', 'ok')).rejects.toMatchObject({
      code: POWER_ERRORS.notConfigured,
    });
    expect(f.commands).toEqual([]);
  });
});
