import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:https';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MachineInfo } from '@threadgarden/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { openDb, type Db } from '../../src/history/db.js';
import { DeviceRegistry } from '../../src/machine/devices.js';
import { loadOrCreateTlsIdentity, type TlsIdentity } from '../../src/machine/tls.js';
import { machineFor, registerMachineHandlers } from '../../src/server/handlers/machines.js';
import {
  PAIRING_MAX_PAYLOAD,
  PAIRING_MAX_SOCKETS,
  PAIRING_SOCKET_TTL_MS,
  REMOTE_MAX_CONNECTIONS,
  REMOTE_PORT,
  startRemoteServer,
} from '../../src/server/remote-server.js';
import { Router, type HandlerCtx } from '../../src/server/router.js';

type Server = Awaited<ReturnType<typeof startRemoteServer>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON results in tests
type Reply = { id: number; result?: any; error?: { code: string; message: string } };

let dir: string;
let tls: TlsIdentity;
let db: Db;
let devices: DeviceRegistry;
let router: Router;
let s: Server;
let counts: number[];
let token: string;
let deviceId: string;
let machineId: string;

const machine = (): MachineInfo => ({
  id: machineId,
  name: 'Ubuntu PC',
  platform: 'linux',
  headless: true,
  home: '/home/me',
  capabilities: ['remote'],
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tg-remote-'));
  tls = await loadOrCreateTlsIdentity(dir, 'ubuntu-pc');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  db = openDb(join(await mkdtemp(join(dir, 'db-')), 'db'));
  devices = new DeviceRegistry(db.raw);
  machineId = 'm-1';
  router = new Router();
  router.register('hello', async (_p, ctx) => ({
    serviceVersion: 't',
    protocolVersion: 5,
    machine: machineFor(ctx, machine()),
  }));
  registerMachineHandlers(router, { db, devices, identity: machine, tls });
  counts = [];
  s = await startRemoteServer({
    addresses: ['127.0.0.1'],
    port: 0,
    tls,
    devices,
    router,
    onClientCountChange: (n) => counts.push(n),
  });
  const paired = devices.claim(devices.createPairingCode().code, 'Laptop');
  if ('error' in paired) throw new Error(paired.error);
  ({ token, deviceId } = paired);
});
const extra: Server[] = [];
afterEach(async () => {
  await Promise.all([s, ...extra.splice(0)].map((x) => x.close()));
  db.close();
});
/** Another listener on a free port, with options of its own. */
const startAnother = async (more: Partial<Parameters<typeof startRemoteServer>[0]> = {}) => {
  const other = await startRemoteServer({
    addresses: ['127.0.0.1'],
    port: 0,
    tls,
    devices,
    router,
    onClientCountChange: () => {},
    ...more,
  });
  extra.push(other);
  return other;
};
/** The machine as a pairing socket sees it. */
const unauthenticated = (): MachineInfo => ({ ...machine(), home: '' });

const openTls = (srv: Server, protocol?: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const url = `wss://127.0.0.1:${srv.port}`;
    const ws = new WebSocket(url, protocol === undefined ? [] : [protocol], {
      rejectUnauthorized: false,
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
const closeCode = (ws: WebSocket) =>
  new Promise<number>((resolve) => {
    if (ws.readyState === ws.CLOSED) resolve(-1);
    else ws.once('close', resolve);
  });
let nextId = 1;
const call = (ws: WebSocket, method: string, params: unknown) =>
  new Promise<Reply>((resolve) => {
    const id = nextId++;
    const onMessage = (d: unknown) => {
      const msg = JSON.parse(String(d)) as Reply;
      if (msg.id !== id) return;
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
const events = (ws: WebSocket): unknown[] => {
  const seen: unknown[] = [];
  ws.on('message', (d) => {
    const msg = JSON.parse(String(d)) as { event?: string };
    if (msg.event !== undefined) seen.push(msg);
  });
  return seen;
};

describe('remote server', () => {
  it('listens on the default port unless told otherwise', () => {
    expect(REMOTE_PORT).toBe(47380);
    expect(s.addresses).toEqual(['127.0.0.1']);
    expect(s.port).toBeGreaterThan(0);
  });

  it('refuses a connection without a known device token', async () => {
    expect(await closeCode(await openTls(s, 'threadgarden-device.nope'))).toBe(4401);
  });

  it('refuses a connection without a subprotocol (4401)', async () => {
    expect(await closeCode(await openTls(s))).toBe(4401);
  });

  it('refuses a device (1011) and keeps serving when the registry fails', async () => {
    const verify = vi.spyOn(devices, 'verify').mockImplementation(() => {
      throw new Error('database gone');
    });
    expect(await closeCode(await openTls(s, `threadgarden-device.${token}`))).toBe(1011);
    verify.mockRestore();
    const ws = await openTls(s, `threadgarden-device.${token}`);
    expect(await call(ws, 'machine.get', {})).toMatchObject({ result: { id: machineId } });
    ws.close();
  });

  it('survives a refused client that sends broken frames', async () => {
    const errors: unknown[] = [];
    for (const protocol of ['threadgarden-device.nope', 'threadgarden-pair']) {
      const ws = await openTls(s, protocol);
      ws.on('error', (e) => errors.push(e));
      const closed = closeCode(ws);
      // A masked frame with the reserved opcode 3: the server's parser rejects it.
      (ws as unknown as { _socket: { write(b: Buffer): void } })._socket.write(
        Buffer.from([0x83, 0x80, 0, 0, 0, 0]),
      );
      expect(await closed).not.toBe(-1);
    }
    const pairing = await openTls(s, 'threadgarden-pair');
    expect(await call(pairing, 'hello', { protocolVersion: 5, client: 'p' })).toMatchObject({
      result: { serviceVersion: 't' },
    });
    pairing.close();
  });

  it('tells peer socket errors apart from service failures', async () => {
    const kinds: string[] = [];
    const other = await startAnother({ onError: (_err, kind) => kinds.push(kind) });
    const ws = await openTls(other, 'threadgarden-pair');
    ws.on('error', () => {});
    const closed = closeCode(ws);
    // A masked frame with the reserved opcode 3: a broken frame any peer can send.
    (ws as unknown as { _socket: { write(b: Buffer): void } })._socket.write(
      Buffer.from([0x83, 0x80, 0, 0, 0, 0]),
    );
    await closed;
    await expect.poll(() => kinds).toEqual(['peer']);
    const verify = vi.spyOn(devices, 'verify').mockImplementation(() => {
      throw new Error('database gone');
    });
    expect(await closeCode(await openTls(other, `threadgarden-device.${token}`))).toBe(1011);
    verify.mockRestore();
    expect(kinds).toEqual(['peer', 'service']);
  });

  it('never serves the local subprotocol or anything else', async () => {
    await expect(openTls(s, `threadgarden.${token}`)).rejects.toThrow();
    await expect(openTls(s, 'something')).rejects.toThrow();
  });

  it('serves the full protocol to a paired device with origin remote', async () => {
    const ws = await openTls(s, `threadgarden-device.${token}`);
    expect(await call(ws, 'machine.get', {})).toMatchObject({ result: { id: machineId } });
    expect(await call(ws, 'pairing.create', {})).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await call(ws, 'devices.list', {})).toMatchObject({ error: { code: 'FORBIDDEN' } });
    // A device may revoke itself only.
    expect(await call(ws, 'devices.revoke', { deviceId: 'someone-else' })).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    expect(await call(ws, 'machine.rename', { name: 'x' })).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    expect(devices.list()[0]?.lastSeen).not.toBeNull();
    ws.close();
  });

  it('pairs: proof, then claim, on the pairing subprotocol only', async () => {
    const { code } = devices.createPairingCode();
    const ws = await openTls(s, 'threadgarden-pair');
    const nonce = randomBytes(32).toString('hex');
    const { result } = await call(ws, 'pair.proof', { nonce });
    expect(result.proof).toBe(
      createHmac('sha256', code.replaceAll('-', ''))
        .update(`${tls.fingerprint256}\n${nonce}`)
        .digest('hex'),
    );
    expect(result.machine).toEqual(unauthenticated());
    const claimed = await call(ws, 'pair.claim', { code, deviceName: 'Gaming PC' });
    expect(claimed.result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(claimed.result.machine).toEqual(machine());
    expect(devices.verify(claimed.result.token)).toMatchObject({
      id: claimed.result.deviceId,
      name: 'Gaming PC',
    });
    expect(await call(ws, 'machine.get', {})).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await call(ws, 'pairing.create', {})).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await call(ws, 'bogus', {})).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await call(ws, 'hello', { protocolVersion: 5, client: 'desktop' })).toMatchObject({
      result: { serviceVersion: 't' },
    });
    ws.close();
  });

  it('has no proof without a live code, and never takes a code for it', async () => {
    const ws = await openTls(s, 'threadgarden-pair');
    const nonce = randomBytes(32).toString('hex');
    expect((await call(ws, 'pair.proof', { nonce })).result).toEqual({
      proof: null,
      machine: unauthenticated(),
    });
    expect(await call(ws, 'pair.proof', { nonce: 'short' })).toMatchObject({
      error: { code: 'INVALID_PARAMS' },
    });
    expect(await call(ws, 'pair.proof', { nonce: nonce.toUpperCase() })).toMatchObject({
      error: { code: 'INVALID_PARAMS' },
    });
    ws.close();
  });

  it('answers a wrong or expired code with an error and no token', async () => {
    const { code } = devices.createPairingCode();
    const ws = await openTls(s, 'threadgarden-pair');
    expect(await call(ws, 'pair.claim', { code: 'AAAA-AAAA-AAAA', deviceName: 'x' })).toEqual({
      id: expect.any(Number),
      error: { code: 'PAIRING_INVALID', message: expect.any(String) },
    });
    expect(await call(ws, 'pair.claim', { code, deviceName: ' ' })).toMatchObject({
      error: { code: 'INVALID_PARAMS' },
    });
    expect(await call(ws, 'pair.claim', { code, deviceName: 'x'.repeat(61) })).toMatchObject({
      error: { code: 'INVALID_PARAMS' },
    });
    const ok = await call(ws, 'pair.claim', { code, deviceName: '  Den  ' });
    expect(devices.verify(ok.result.token)?.name).toBe('Den');
    expect(await call(ws, 'pair.claim', { code, deviceName: 'again' })).toMatchObject({
      error: { code: 'PAIRING_INVALID' },
    });
    ws.close();
  });

  it('kills the code after five wrong claims over a pairing socket', async () => {
    const { code } = devices.createPairingCode();
    const ws = await openTls(s, 'threadgarden-pair');
    for (let i = 0; i < 5; i++) {
      expect(
        await call(ws, 'pair.claim', { code: 'AAAA-AAAA-AAAA', deviceName: 'x' }),
      ).toMatchObject({ error: { code: 'PAIRING_INVALID' } });
    }
    const late = await call(ws, 'pair.claim', { code, deviceName: 'x' });
    expect(late).toMatchObject({ error: { code: 'PAIRING_INVALID' } });
    expect(late.result).toBeUndefined();
    expect(devices.list()).toHaveLength(1);
    ws.close();
  });

  it('withholds the home folder until the caller is authenticated', async () => {
    const pairing = await openTls(s, 'threadgarden-pair');
    const hello = { protocolVersion: 5, client: 'p' };
    expect((await call(pairing, 'hello', hello)).result.machine).toEqual(unauthenticated());
    const nonce = randomBytes(32).toString('hex');
    expect((await call(pairing, 'pair.proof', { nonce })).result.machine.home).toBe('');
    const device = await openTls(s, `threadgarden-device.${token}`);
    expect((await call(device, 'hello', hello)).result.machine).toEqual(machine());
    expect((await call(device, 'machine.get', {})).result.home).toBe('/home/me');
    pairing.close();
    device.close();
  });

  it('closes a pairing socket that sends a frame over the pairing limit (1009)', async () => {
    const ws = await openTls(s, 'threadgarden-pair');
    const closed = closeCode(ws);
    ws.on('error', () => {});
    const nonce = 'a'.repeat(PAIRING_MAX_PAYLOAD);
    ws.send(JSON.stringify({ id: 1, method: 'pair.proof', params: { nonce } }));
    expect(await closed).toBe(1009);
  });

  it('never reads a big frame from a refused device token (4401)', async () => {
    const dispatch = vi.spyOn(router, 'dispatch');
    const ws = await openTls(s, 'threadgarden-device.nope');
    ws.on('error', () => {});
    const closed = closeCode(ws);
    ws.send(
      JSON.stringify({ id: 1, method: 'machine.get', params: { pad: 'x'.repeat(64 * 1024) } }),
    );
    expect(await closed).toBe(4401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it(`refuses pairing sockets beyond ${PAIRING_MAX_SOCKETS} with 503`, async () => {
    const open: WebSocket[] = [];
    for (let i = 0; i < PAIRING_MAX_SOCKETS; i++) open.push(await openTls(s, 'threadgarden-pair'));
    await expect(openTls(s, 'threadgarden-pair')).rejects.toThrow(/503/);
    // Devices are not held back by pairing sockets.
    const device = await openTls(s, `threadgarden-device.${token}`);
    expect(await call(device, 'machine.get', {})).toMatchObject({ result: { id: machineId } });
    // A closed pairing socket frees its place.
    const closed = closeCode(open[0]!);
    open[0]!.close();
    await closed;
    await expect
      .poll(async () => {
        try {
          open[0] = await openTls(s, 'threadgarden-pair');
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    for (const ws of [...open, device]) ws.close();
  });

  it('refuses pairing sockets with 503 while pairing is closed', async () => {
    let open = false;
    const gated = await startAnother({ pairingOpen: () => open });
    await expect(openTls(gated, 'threadgarden-pair')).rejects.toThrow(/503/);
    // Devices are not held back.
    const device = await openTls(gated, `threadgarden-device.${token}`);
    expect(await call(device, 'machine.get', {})).toMatchObject({ result: { id: machineId } });
    open = true;
    const pairing = await openTls(gated, 'threadgarden-pair');
    expect(await call(pairing, 'hello', { protocolVersion: 5, client: 'p' })).toMatchObject({
      result: { serviceVersion: 't' },
    });
    for (const ws of [pairing, device]) ws.close();
  });

  it('refuses pairing (503) and keeps serving when the pairing check throws', async () => {
    const errors: unknown[] = [];
    const gated = await startAnother({
      pairingOpen: () => {
        throw new Error('boom');
      },
      onError: (err, kind) => errors.push([kind, err]),
    });
    await expect(openTls(gated, 'threadgarden-pair')).rejects.toThrow(/503/);
    expect(errors).toEqual([['service', expect.any(Error)]]);
    const device = await openTls(gated, `threadgarden-device.${token}`);
    expect(await call(device, 'machine.get', {})).toMatchObject({ result: { id: machineId } });
    device.close();
  });

  it(`accepts at most ${REMOTE_MAX_CONNECTIONS} connections per address`, async () => {
    expect(REMOTE_MAX_CONNECTIONS).toBe(64);
    const sockets: Socket[] = [];
    try {
      for (let i = 0; i < REMOTE_MAX_CONNECTIONS; i++) {
        sockets.push(
          await new Promise<Socket>((resolve, reject) => {
            const sock = connect(s.port, '127.0.0.1', () => resolve(sock));
            sock.once('error', reject);
          }),
        );
      }
      await expect(openTls(s, `threadgarden-device.${token}`)).rejects.toThrow();
      for (const sock of sockets.splice(0)) sock.destroy();
      await expect
        .poll(async () => {
          try {
            (await openTls(s, `threadgarden-device.${token}`)).close();
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
    } finally {
      for (const sock of sockets) sock.destroy();
    }
  });

  it('closes a pairing socket when its time is up', async () => {
    expect(PAIRING_SOCKET_TTL_MS).toBe(60_000);
    const short = await startAnother({ pairingTtlMs: 50 });
    const ws = await openTls(short, 'threadgarden-pair');
    expect(await closeCode(ws)).toBe(4408);
    // Devices have no such limit.
    const device = await openTls(short, `threadgarden-device.${token}`);
    await new Promise((r) => setTimeout(r, 120));
    expect(device.readyState).toBe(WebSocket.OPEN);
    device.close();
  });

  it('closes a device revoked between its upgrade and its connection (4403)', async () => {
    const realVerify = devices.verify.bind(devices);
    const verify = vi.spyOn(devices, 'verify').mockImplementationOnce((t) => {
      const found = realVerify(t);
      devices.revoke(deviceId);
      return found;
    });
    expect(await closeCode(await openTls(s, `threadgarden-device.${token}`))).toBe(4403);
    verify.mockRestore();
  });

  it('refuses to listen on a wildcard, an empty address or a host name', async () => {
    for (const address of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '', 'localhost']) {
      await expect(startAnother({ addresses: [address] }), address).rejects.toThrow(
        /refusing to listen/,
      );
    }
    await expect(startAnother({ addresses: ['127.0.0.1', '0.0.0.0'] })).rejects.toThrow(
      /refusing to listen/,
    );
  });

  it('closes a revoked device with 4403', async () => {
    const ws = await openTls(s, `threadgarden-device.${token}`);
    const closed = closeCode(ws);
    devices.revoke(deviceId);
    expect(await closed).toBe(4403);
    expect(await closeCode(await openTls(s, `threadgarden-device.${token}`))).toBe(4401);
  });

  it('broadcasts events to devices but not to pairing sockets', async () => {
    const device = await openTls(s, `threadgarden-device.${token}`);
    const pairing = await openTls(s, 'threadgarden-pair');
    const onDevice = events(device);
    const onPairing = events(pairing);
    s.broadcast({ event: 'sessions.changed', data: {} });
    // A round trip on each socket: the event, if sent, arrived before the reply.
    await call(device, 'hello', { protocolVersion: 5, client: 'd' });
    await call(pairing, 'hello', { protocolVersion: 5, client: 'p' });
    expect(onDevice).toEqual([{ event: 'sessions.changed', data: {} }]);
    expect(onPairing).toEqual([]);
    device.close();
    pairing.close();
  });

  it('counts paired devices only', async () => {
    const pairing = await openTls(s, 'threadgarden-pair');
    await call(pairing, 'hello', { protocolVersion: 5, client: 'p' });
    expect(counts).toEqual([]);
    const device = await openTls(s, `threadgarden-device.${token}`);
    await call(device, 'hello', { protocolVersion: 5, client: 'd' });
    expect(counts).toEqual([1]);
    const closed = closeCode(device);
    device.close();
    await closed;
    await expect.poll(() => counts).toEqual([1, 0]);
    pairing.close();
  });

  it('answers plain HTTPS requests with 426', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: s.port, path: '/', rejectUnauthorized: false },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.once('error', reject);
      req.end();
    });
    expect(status).toBe(426);
  });

  it('closes every socket and frees the port', async () => {
    const ws = await openTls(s, `threadgarden-device.${token}`);
    const closed = closeCode(ws);
    await s.close();
    await closed;
    s = await startRemoteServer({
      addresses: ['127.0.0.1'],
      port: s.port,
      tls,
      devices,
      router,
      onClientCountChange: () => {},
    });
    expect(
      (
        await call(await openTls(s, 'threadgarden-pair'), 'hello', {
          protocolVersion: 5,
          client: 'p',
        })
      ).result,
    ).toBeDefined();
  });

  it('fails to start when the port is taken', async () => {
    await expect(
      startRemoteServer({
        addresses: ['127.0.0.1'],
        port: s.port,
        tls,
        devices,
        router,
        onClientCountChange: () => {},
      }),
    ).rejects.toThrow();
  });
});

describe('machine handlers', () => {
  const local: HandlerCtx = { clientId: 'c', origin: 'local' };
  const dispatch = (method: string, params: unknown, ctx = local) =>
    router.dispatch({ id: 1, method, params }, ctx) as Promise<Reply>;

  it('creates pairing codes, lists and revokes devices locally', async () => {
    const created = await dispatch('pairing.create', {});
    expect(created.result).toEqual({
      code: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/),
      expiresAt: expect.any(Number),
    });
    expect((await dispatch('devices.list', {})).result).toEqual([
      { id: deviceId, name: 'Laptop', createdAt: expect.any(Number), lastSeen: null },
    ]);
    expect((await dispatch('devices.revoke', { deviceId })).result).toEqual({ revoked: true });
    expect((await dispatch('devices.revoke', { deviceId })).result).toEqual({ revoked: false });
    expect((await dispatch('devices.list', {})).result).toEqual([]);
  });

  it('renames the machine locally and tells the caller', async () => {
    const renamed: MachineInfo[] = [];
    const r = new Router();
    registerMachineHandlers(r, {
      db,
      devices,
      identity: () => ({ ...machine(), name: String(db.getUiState('machine:name')) }),
      onRenamed: (m) => renamed.push(m),
    });
    const res = (await r.dispatch(
      { id: 1, method: 'machine.rename', params: { name: ' Den ' } },
      local,
    )) as Reply;
    expect(res.result).toMatchObject({ name: 'Den' });
    expect(renamed).toEqual([res.result]);
  });

  it('refuses a proof without a TLS identity', async () => {
    const r = new Router();
    registerMachineHandlers(r, { db, devices, identity: machine });
    devices.createPairingCode();
    const res = (await r.dispatch(
      { id: 1, method: 'pair.proof', params: { nonce: 'a'.repeat(64) } },
      local,
    )) as Reply;
    expect(res.error?.code).toBe('NOT_LISTENING');
  });

  it('forbids local-only methods to remote callers', async () => {
    const remote = { clientId: 'c', origin: 'remote' as const, deviceId };
    for (const [method, params] of [
      ['pairing.create', {}],
      ['devices.list', {}],
      ['devices.revoke', { deviceId: 'someone-else' }],
      ['machine.rename', { name: 'x' }],
    ] as const) {
      expect(await dispatch(method, params, remote), method).toMatchObject({
        id: 1,
        error: { code: 'FORBIDDEN' },
      });
    }
    expect(devices.list()).toHaveLength(1);
    expect((await dispatch('machine.get', {}, remote)).result).toEqual(machine());
  });

  it('lets a paired device revoke itself, which closes its sockets', async () => {
    const ws = await openTls(s, `threadgarden-device.${token}`);
    const closed = closeCode(ws);
    // The socket closes (4403) as the device is revoked, possibly before the answer.
    ws.send(JSON.stringify({ id: 99, method: 'devices.revoke', params: { deviceId } }));
    expect(await closed).toBe(4403);
    expect(devices.list()).toEqual([]);
  });
});
