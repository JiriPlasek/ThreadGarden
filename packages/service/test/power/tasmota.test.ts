import { afterEach, describe, expect, it } from 'vitest';
import { PowerError, TasmotaClient } from '../../src/power/tasmota.js';
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

describe('TasmotaClient', () => {
  it('sends Referer and credentials', async () => {
    const f = await fake({ requireReferer: true });
    const c = new TasmotaClient({ address: f.address, password: 'pw' });
    expect(await c.command('Status 2')).toEqual({
      StatusFWR: { Version: '16.0.0(release-zbbrdgpro)' },
    });
  });

  it('wrong password → POWER_AUTH, message without the password', async () => {
    const f = await fake({ password: 'x' });
    const c = new TasmotaClient({ address: f.address, password: 'hunter2' });
    const err = await c.command('Status 2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PowerError);
    expect((err as PowerError).code).toBe('POWER_AUTH');
    expect(String(err)).not.toContain('hunter2');
  });

  it('an HTTP 401 → POWER_AUTH', async () => {
    const c = new TasmotaClient({
      address: '1.2.3.4',
      password: 'p',
      fetch: async () => new Response('', { status: 401 }),
    });
    await expect(c.command('Status 2')).rejects.toMatchObject({ code: 'POWER_AUTH' });
  });

  it('closed port → POWER_UNREACHABLE within timeoutMs', async () => {
    const f = await fake();
    const address = f.address;
    await f.close();
    const c = new TasmotaClient({ address, password: 'p', timeoutMs: 1500 });
    const t0 = Date.now();
    await expect(c.command('Status 2')).rejects.toMatchObject({ code: 'POWER_UNREACHABLE' });
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('a missing Referer is closed with no reply → POWER_REFUSED', async () => {
    const f = await fake({ requireReferer: true });
    // Global fetch sends no Referer on its own; the client adds it, so strip it by wrapping.
    const stripped: typeof fetch = (url, init) =>
      fetch(url, { ...init, headers: { 'x-none': '1' } });
    const c = new TasmotaClient({ address: f.address, password: 'pw', fetch: stripped });
    await expect(c.command('Status 2')).rejects.toMatchObject({ code: 'POWER_REFUSED' });
  });

  it('a body that is not JSON → POWER_NOT_TASMOTA', async () => {
    const c = new TasmotaClient({
      address: '1.2.3.4',
      password: 'p',
      fetch: async () => new Response('<html>hi</html>', { status: 200 }),
    });
    await expect(c.command('Status 2')).rejects.toMatchObject({ code: 'POWER_NOT_TASMOTA' });
  });

  it('URL-encodes the password and the command', async () => {
    let seen = '';
    const c = new TasmotaClient({
      address: '1.2.3.4',
      password: 'a&b=c d',
      fetch: async (url) => {
        seen = String(url);
        return new Response('{}');
      },
    });
    await c.command('Rule1 on x do y endon');
    expect(seen).toContain(
      'user=admin&password=a%26b%3Dc%20d&cmnd=Rule1%20on%20x%20do%20y%20endon',
    );
  });

  it('backlog joins with ;', async () => {
    const f = await fake();
    const c = new TasmotaClient({ address: f.address, password: 'pw' });
    await c.backlog(['Var14 0', 'Var15 1']);
    expect(f.vars[14]).toBe('0');
    expect(f.vars[15]).toBe('1');
  });
});

describe('fake Tasmota', () => {
  it('talks to a Zigbee plug and a Wi-Fi plug', async () => {
    const z = await fake();
    const c = new TasmotaClient({ address: z.address, password: 'pw' });
    const r = await c.command('ZbSend {"Device":"ubuntuplug","Send":{"Power":0}}');
    expect(r).toEqual({ ZbSend: 'Done' });
    expect(z.devices.get('0x863B')?.on).toBe(false);
    const st = (await c.command('ZbStatus3 UbuntuPlug')) as { ZbStatus3: { Power: number }[] };
    expect(st.ZbStatus3[0]?.Power).toBe(0);

    const p = await fake({ kind: 'plug' });
    const pc = new TasmotaClient({ address: p.address, password: 'pw' });
    expect(await pc.command('Power 1')).toEqual({ POWER: 'ON' });
    expect(await pc.command('ZbStatus1')).toMatchObject({ Command: 'Unknown' });
  });

  it('keeps rules and runs a backlog in order', async () => {
    const f = await fake();
    const c = new TasmotaClient({ address: f.address, password: 'pw' });
    await c.backlog(['Rule2 on System#Boot do Var1 1 endon', 'Rule2 1', 'Mem11 5']);
    expect(f.rules[2]).toEqual({ text: 'on System#Boot do Var1 1 endon', on: true });
    expect(f.mems[11]).toBe('5');
    await c.command('Timer16 {"Enable":1,"Time":"02:55"}');
    expect(f.timers[16]).toMatchObject({ Enable: 1, Time: '02:55' });
  });
});
