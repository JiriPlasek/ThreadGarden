import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AwayDeliverer } from '../../src/away/deliverer.js';
import { AwayQueue } from '../../src/away/queue.js';
import { openDb } from '../../src/history/db.js';
import { DeviceRegistry } from '../../src/machine/devices.js';
import { PairedMachines } from '../../src/machine/paired-machines.js';
import { registerAwayHandlers } from '../../src/server/handlers/away.js';
import { registerMachineHandlers } from '../../src/server/handlers/machines.js';
import { Router } from '../../src/server/router.js';

const SESSION = '0b6c3f4e-8f0a-4c56-9a1e-2f1d1c0b7a11';

const setup = () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'threadgarden-away-handlers-')), 'db'));
  const paired = new PairedMachines(db.raw);
  paired.add({
    id: 'm-1',
    name: 'Ubuntu PC',
    address: '127.0.0.1',
    port: 1,
    certPem: 'pem',
    fingerprint: 'fp',
    deviceId: 'd-1',
    addedAt: 0,
  });
  const deliverer = new AwayDeliverer({
    queue: new AwayQueue(db.raw),
    machines: paired,
    power: { list: () => [], reading: vi.fn(), turnOn: vi.fn() },
    connect: async () => null,
    emit: () => {},
    // Nothing is delivered here: these tests are about the methods.
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  const router = new Router();
  registerAwayHandlers(router, { deliverer, machines: paired });
  registerMachineHandlers(router, {
    db,
    devices: new DeviceRegistry(db.raw),
    identity: () => ({
      id: 'self',
      name: 'This PC',
      platform: 'linux',
      headless: false,
      home: '',
      capabilities: [],
    }),
    paired,
    away: deliverer,
  });
  let id = 1;
  const call = (method: string, params: unknown) =>
    router.dispatch({ id: id++, method, params }, { clientId: 'c', origin: 'local' });
  return { call, deliverer, paired };
};

describe('the away methods', () => {
  it('queue, list, cancel and retry the waiting messages', async () => {
    const t = setup();
    const queued = (await t.call('away.queue', {
      machineId: 'm-1',
      sessionId: SESSION,
      kind: 'create',
      text: 'hello',
      cwd: '/work',
    })) as { result: { id: string } };
    expect(queued.result).toMatchObject({ kind: 'create', cwd: '/work', state: 'waiting' });
    expect(await t.call('away.list', { machineId: 'm-1' })).toMatchObject({
      result: {
        items: [{ id: queued.result.id }],
        states: [{ machineId: 'm-1', starting: false }],
      },
    });
    expect(await t.call('away.list', { machineId: 'other' })).toMatchObject({
      result: { items: [], states: [] },
    });
    expect(await t.call('away.retry', { machineId: 'm-1' })).toMatchObject({ result: {} });
    expect(await t.call('away.cancel', { id: queued.result.id })).toMatchObject({ result: {} });
    expect(await t.call('away.list', {})).toMatchObject({ result: { items: [] } });
  });

  it('queue refuses an unknown machine, and a new chat without a folder or a uuid', async () => {
    const t = setup();
    const send = { machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'x' };
    expect(await t.call('away.queue', { ...send, machineId: 'nobody' })).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(await t.call('away.queue', { ...send, kind: 'create' })).toMatchObject({
      error: { code: 'INVALID_PARAMS' },
    });
    expect(
      await t.call('away.queue', { ...send, kind: 'create', cwd: '/w', sessionId: 'stand-in' }),
    ).toMatchObject({ error: { code: 'INVALID_PARAMS' } });
    expect(await t.call('away.list', {})).toMatchObject({ result: { items: [] } });
  });

  it('unlocking a machine tries its rows, and removing it drops them', async () => {
    const t = setup();
    const unlocked = vi.spyOn(t.deliverer, 'onUnlock');
    await t.call('away.queue', { machineId: 'm-1', sessionId: SESSION, kind: 'send', text: 'x' });
    expect(
      await t.call('machines.unlock', { machineId: 'm-1', token: 'a'.repeat(64) }),
    ).toMatchObject({
      result: {},
    });
    expect(unlocked).toHaveBeenCalledWith('m-1');
    await t.call('machines.remove', { machineId: 'm-1', revoke: false });
    expect(t.deliverer.list()).toEqual({ items: [], states: [] });
  });
});
