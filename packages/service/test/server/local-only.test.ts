import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { methods } from '@threadgarden/protocol';
import { startService, type ServiceHandle } from '../../src/main.js';
import { generateCorpus } from '../../src/testing/corpus.js';

/**
 * Ruling R14: a paired device has full control of the chats, but never of the
 * machine itself. Checked over the real remote listener, as a device sees it.
 */
describe('methods a paired device may not call', () => {
  let dir: string;
  let svc: ServiceHandle;
  let device: { id: string; token: string };
  let other: { id: string; token: string };

  const pair = async (deviceName: string): Promise<{ id: string; token: string }> => {
    const created = (await svc.router.dispatch(
      { id: 1, method: 'pairing.create', params: {} },
      { clientId: 't', origin: 'local' },
    )) as { result: { code: string } };
    const claimed = (await svc.router.dispatch(
      { id: 2, method: 'pair.claim', params: { code: created.result.code, deviceName } },
      { clientId: 'p', origin: 'remote' },
    )) as { result: { deviceId: string; token: string } };
    return { id: claimed.result.deviceId, token: claimed.result.token };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'threadgarden-local-only-'));
    svc = await startService({
      dataDir: join(dir, 'data'),
      claudeConfigDir: join(dir, 'claude-missing'),
      adapter: generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 }),
      installSignalHandlers: false,
      headless: true,
      remote: { addresses: ['127.0.0.1'], port: 0 },
      logger: { debug() {}, info() {}, warn() {}, error() {}, flush: async () => {} },
    });
    device = await pair('Laptop');
    other = await pair('Gaming PC');
  });
  afterAll(async () => {
    await svc.close();
    await rm(dir, { recursive: true, force: true });
  });

  const powerClient = [
    'power.probe',
    'power.pairPlug',
    'power.rename',
    'power.configure',
    'power.unlock',
    'power.list',
    'power.reading',
    'power.turnOn',
    'power.noteMeasurement',
  ];
  const machinesMethods = Object.keys(methods).filter((m) => m.startsWith('machines.'));
  const forbidden = [
    'service.shutdown',
    'auth.setApiKey',
    'pairing.create',
    'devices.list',
    'machine.rename',
    ...powerClient,
    ...machinesMethods,
  ];

  it('covers every machines.* method', () => {
    expect(machinesMethods).toEqual(
      expect.arrayContaining([
        'machines.list',
        'machines.pair',
        'machines.unlock',
        'machines.update',
        'machines.remove',
      ]),
    );
  });

  it.each(forbidden)('answers %s with FORBIDDEN', async (method) => {
    const ws = await open(svc.remote!.port, device.token);
    try {
      const res = await call(ws, method, {});
      expect(res).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(res).not.toHaveProperty('result');
    } finally {
      ws.close();
    }
  });

  it('lets a device revoke itself, never another device', async () => {
    const ws = await open(svc.remote!.port, device.token);
    expect(await call(ws, 'devices.revoke', { deviceId: other.id })).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    // The other device is still paired.
    const listed = (await svc.router.dispatch(
      { id: 3, method: 'devices.list', params: {} },
      { clientId: 't', origin: 'local' },
    )) as { result: { id: string }[] };
    expect(listed.result.map((d) => d.id).sort()).toEqual([device.id, other.id].sort());

    // Its own id: revoked, and its socket is closed at once (before the answer can arrive).
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    void call(ws, 'devices.revoke', { deviceId: device.id });
    expect(await closed).toBe(4403);
    const after = (await svc.router.dispatch(
      { id: 4, method: 'devices.list', params: {} },
      { clientId: 't', origin: 'local' },
    )) as { result: { id: string }[] };
    expect(after.result.map((d) => d.id)).toEqual([other.id]);
  });

  it('kept serving: service.shutdown from a device did not stop it', async () => {
    const ws = await open(svc.remote!.port, other.token);
    try {
      expect(await call(ws, 'machine.get', {})).toMatchObject({ result: { headless: true } });
    } finally {
      ws.close();
    }
  });
});

const open = (port: number, token: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, [`threadgarden-device.${token}`], {
      rejectUnauthorized: false,
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

let nextId = 100;
const call = (ws: WebSocket, method: string, params: unknown): Promise<unknown> =>
  new Promise((resolve) => {
    const id = nextId++;
    const onMessage = (d: unknown) => {
      const msg = JSON.parse(String(d)) as { id?: number };
      if (msg.id !== id) return;
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
