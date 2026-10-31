import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PairedMachine } from '@threadgarden/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generate } from 'selfsigned';
import { WebSocket } from 'ws';
import { openDb } from '../../src/history/db.js';
import { DeviceRegistry } from '../../src/machine/devices.js';
import { PairedMachines } from '../../src/machine/paired-machines.js';
import { startService, type ServiceHandle, type StartOptions } from '../../src/main.js';
import { registerMachineHandlers } from '../../src/server/handlers/machines.js';
import { RELAY_PING_MS, createRelay } from '../../src/server/relay.js';
import { Router } from '../../src/server/router.js';
import { startWsServer } from '../../src/server/ws-server.js';
import { generateCorpus } from '../../src/testing/corpus.js';
import { TestClient } from '../e2e/ws-client.js';
import { startFakeMachine, type FakeMachine } from '../machine/fake-machine.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON results in tests
type Reply = { id: number; result?: any; error?: { code: string; message: string } };

let dir: string;
let remote: ServiceHandle;
let local: ServiceHandle;
let localDir: string;
const cleanup: (() => Promise<unknown>)[] = [];

const quietLogger = () => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
});
const base = (dataDir: string): StartOptions => ({
  dataDir,
  claudeConfigDir: join(dir, 'claude-missing'),
  adapter: generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 }),
  installSignalHandlers: false,
  logger: quietLogger(),
});
/** A headless machine listening for devices on loopback. */
const startHeadless = (name: string) =>
  startService({
    ...base(join(dir, name)),
    headless: true,
    remote: { addresses: ['127.0.0.1'], port: 0 },
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tg-relay-'));
  remote = await startHeadless('remote');
});
afterAll(async () => {
  await remote.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  localDir = await mkdtemp(join(dir, 'local-'));
  local = await startService(base(localDir));
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  await local.close();
});

const localCall = async <T = unknown>(svc: ServiceHandle, method: string, params: unknown) => {
  const client = await TestClient.connect(svc.port, svc.token);
  try {
    return await client.call<T>(method, params);
  } finally {
    await client.close();
  }
};
const pair = async (svc: ServiceHandle, deviceName: string, on: ServiceHandle = remote) => {
  const { code } = await localCall<{ code: string }>(on, 'pairing.create', {});
  return localCall<{ machine: PairedMachine; token: string }>(svc, 'machines.pair', {
    address: '127.0.0.1',
    port: on.remote!.port,
    code,
    deviceName,
  });
};
const remoteDevices = (on: ServiceHandle = remote) =>
  localCall<{ id: string; name: string }[]>(on, 'devices.list', {});

const closes = new WeakMap<WebSocket, Promise<number>>();
const openRelayAt = (port: number, token: string, machineId: string | null) => {
  const query = machineId === null ? '' : `?machine=${encodeURIComponent(machineId)}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay${query}`, `threadgarden.${token}`);
  closes.set(ws, new Promise((resolve) => ws.once('close', (code) => resolve(code))));
  return new Promise<WebSocket>((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
};
const openRelay = (svc: ServiceHandle, machineId: string | null) =>
  openRelayAt(svc.port, svc.token, machineId);
const closeCode = (ws: WebSocket): Promise<number> => closes.get(ws)!;
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

describe('machines and the relay', () => {
  it('pairs with a headless machine and relays its protocol', async () => {
    const watcher = await TestClient.connect(local.port, local.token);
    const { code } = await localCall<{ code: string }>(remote, 'pairing.create', {});
    const { machine, token } = await localCall<{ machine: PairedMachine; token: string }>(
      local,
      'machines.pair',
      { address: '127.0.0.1', port: remote.remote!.port, code, deviceName: 'Gaming PC' },
    );
    expect(machine).toEqual({
      id: expect.any(String),
      name: expect.any(String),
      address: '127.0.0.1',
      port: remote.remote!.port,
      fingerprint: expect.stringMatching(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/),
      addedAt: expect.any(Number),
      unlocked: true,
    });
    const ws = await openRelay(local, machine.id);
    expect(await call(ws, 'machine.get', {})).toMatchObject({
      result: { id: machine.id, headless: true },
    });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await localCall(local, 'machines.list', {})).toEqual([machine]);
    expect(await watcher.waitFor((e) => e.event === 'machines.changed')).toEqual({
      event: 'machines.changed',
      data: [machine],
    });
    await watcher.close();
    // The remote's events reach the relay as the remote sent them.
    const frame = new Promise<string>((resolve) =>
      ws.on('message', (d) => {
        if (String(d).includes('test.event')) resolve(String(d));
      }),
    );
    remote.broadcast({ event: 'test.event', data: { n: 1 } });
    expect(await frame).toBe(JSON.stringify({ event: 'test.event', data: { n: 1 } }));
    // The local service's own events do not.
    const quiet: string[] = [];
    ws.on('message', (d) => quiet.push(String(d)));
    local.broadcast({ event: 'local.only', data: {} });
    expect(await call(ws, 'machine.get', {})).toMatchObject({ result: { id: machine.id } });
    expect(quiet.join('')).not.toContain('local.only');
    ws.close();
  });

  it('closes 4409 and sends no token when another machine answers at the address', async () => {
    const { machine } = await pair(local, 'Pinned');
    const otherMachine = await startFakeMachine(dir);
    cleanup.push(() => otherMachine.close());
    const updated = await localCall<PairedMachine>(local, 'machines.update', {
      machineId: machine.id,
      port: otherMachine.port,
    });
    expect(updated).toEqual({ ...machine, port: otherMachine.port });
    expect(await closeCode(await openRelay(local, machine.id))).toBe(4409);
    // The relay did go to the other machine, and stopped in the TLS handshake.
    expect(otherMachine.connections()).toBeGreaterThan(0);
    expect(otherMachine.upgradeRequests()).toHaveLength(0);
    // Back at the right port, the pin still holds.
    await localCall(local, 'machines.update', { machineId: machine.id, port: remote.remote!.port });
    const ws = await openRelay(local, machine.id);
    expect(await call(ws, 'machine.get', {})).toMatchObject({ result: { id: machine.id } });
    ws.close();
  });

  it('closes 4404 for a locked machine after a local restart', async () => {
    const { machine, token } = await pair(local, 'Restarted');
    await local.close();
    local = await startService(base(localDir));
    expect(await localCall(local, 'machines.list', {})).toEqual([{ ...machine, unlocked: false }]);
    expect(await closeCode(await openRelay(local, machine.id))).toBe(4404);
    expect(await closeCode(await openRelay(local, 'unknown'))).toBe(4404);
    expect(await closeCode(await openRelay(local, null))).toBe(4404);
    await expect(
      localCall(local, 'machines.unlock', { machineId: 'unknown', token }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await localCall(local, 'machines.unlock', { machineId: machine.id, token });
    expect(await localCall(local, 'machines.list', {})).toEqual([machine]);
    const ws = await openRelay(local, machine.id);
    expect(await call(ws, 'machine.get', {})).toMatchObject({ result: { id: machine.id } });
    ws.close();
  });

  it('refuses a relay without the local token', async () => {
    const { machine } = await pair(local, 'Token');
    await expect(openRelayAt(local.port, 'wrong', machine.id).then(closeCode)).resolves.toBe(4401);
  });

  it('closes 4502 when the remote goes away', async () => {
    const gone = await startHeadless('gone');
    const { machine } = await pair(local, 'Gone', gone);
    const ws = await openRelay(local, machine.id);
    expect(await call(ws, 'machine.get', {})).toMatchObject({ result: { id: machine.id } });
    const closed = closeCode(ws);
    await gone.close();
    expect(await closed).toBe(4502);
    expect(await closeCode(await openRelay(local, machine.id))).toBe(4502);
  });

  it('closes 4403 when the remote refuses the token', async () => {
    const { machine } = await pair(local, 'Refused');
    const ws = await openRelay(local, machine.id);
    expect(await call(ws, 'machine.get', {})).toMatchObject({ result: { id: machine.id } });
    const device = (await remoteDevices()).find((d) => d.name === 'Refused')!;
    const closed = closeCode(ws);
    await localCall(remote, 'devices.revoke', { deviceId: device.id });
    expect(await closed).toBe(4403);
    expect(await closeCode(await openRelay(local, machine.id))).toBe(4403);
  });

  it('removes and revokes', async () => {
    const { machine } = await pair(local, 'Removed');
    expect((await remoteDevices()).map((d) => d.name)).toContain('Removed');
    const ws = await openRelay(local, machine.id);
    expect(await call(ws, 'machine.get', {})).toMatchObject({ result: { id: machine.id } });
    const closed = closeCode(ws);
    expect(
      await localCall(local, 'machines.remove', { machineId: machine.id, revoke: true }),
    ).toEqual({ revoked: true });
    expect((await remoteDevices()).map((d) => d.name)).not.toContain('Removed');
    expect(await localCall(local, 'machines.list', {})).toEqual([]);
    expect(await closed).toBe(4404);
    expect(await closeCode(await openRelay(local, machine.id))).toBe(4404);
    // Removing again is harmless.
    expect(
      await localCall(local, 'machines.remove', { machineId: machine.id, revoke: true }),
    ).toEqual({ revoked: false });
  });

  it('removes without revoking: the remote keeps the device', async () => {
    const { machine } = await pair(local, 'Kept');
    expect(
      await localCall(local, 'machines.remove', { machineId: machine.id, revoke: false }),
    ).toEqual({ revoked: false });
    expect(await localCall(local, 'machines.list', {})).toEqual([]);
    expect((await remoteDevices()).map((d) => d.name)).toContain('Kept');
  });

  it('removes with revoke even when the remote cannot be reached', async () => {
    const gone = await startHeadless('gone-before-remove');
    const { machine } = await pair(local, 'Unreachable', gone);
    await gone.close();
    expect(
      await localCall(local, 'machines.remove', { machineId: machine.id, revoke: true }),
    ).toEqual({ revoked: false });
    expect(await localCall(local, 'machines.list', {})).toEqual([]);
  });

  it('removes a locked machine without asking it to revoke', async () => {
    const { machine } = await pair(local, 'Locked remove');
    await local.close();
    local = await startService(base(localDir));
    expect(
      await localCall(local, 'machines.remove', { machineId: machine.id, revoke: true }),
    ).toEqual({ revoked: false });
    expect((await remoteDevices()).map((d) => d.name)).toContain('Locked remove');
  });

  it('forgets the machine before asking it to revoke: no relay opens meanwhile', async () => {
    const db = openDb(join(await mkdtemp(join(dir, 'handlers-')), 'db'));
    cleanup.push(async () => db.close());
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
    paired.unlock('m-1', 'a'.repeat(64));
    const router = new Router();
    const relay = createRelay({ machines: paired });
    const dropped: [string, number][] = [];
    const seenDuringRevoke: unknown[] = [];
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
      relay: { drop: (id, code) => void dropped.push([id, code]) },
      unpair: async (o) => {
        // A UI relay arriving now is refused: the machine and its token are gone.
        const ui = { close: (code: number) => seenDuringRevoke.push(code) };
        relay.attach(ui as unknown as WebSocket, 'm-1');
        seenDuringRevoke.push(paired.get('m-1'), paired.token('m-1'), dropped.length, o.token);
        return true;
      },
    });
    const res = await router.dispatch(
      { id: 1, method: 'machines.remove', params: { machineId: 'm-1', revoke: true } },
      { clientId: 'c', origin: 'local' },
    );
    expect(res).toEqual({ id: 1, result: { revoked: true } });
    expect(seenDuringRevoke).toEqual([4404, null, null, 1, 'a'.repeat(64)]);
    expect(dropped).toEqual([['m-1', 4404]]);
  });

  it('refuses to pair with itself or with a machine already paired', async () => {
    await expect(pair(remote, 'Myself')).rejects.toMatchObject({ code: 'PAIRING_SELF' });
    const { machine } = await pair(local, 'Twice');
    await expect(pair(local, 'Twice again')).rejects.toMatchObject({
      code: 'PAIRING_DUPLICATE',
      message: `Already paired as ${machine.name}`,
    });
    const names = (await remoteDevices()).map((d) => d.name);
    // The code was never claimed for either.
    expect(names).not.toContain('Myself');
    expect(names).not.toContain('Twice again');
    expect(await localCall(local, 'machines.list', {})).toEqual([machine]);
  });

  it('passes on pairing errors', async () => {
    const { code } = await localCall<{ code: string }>(remote, 'pairing.create', {});
    await expect(
      localCall(local, 'machines.pair', {
        address: '127.0.0.1',
        port: remote.remote!.port,
        code: 'ABCD-EFGH-JKM',
        deviceName: 'x',
      }),
    ).rejects.toMatchObject({ code: 'PAIRING_INVALID' });
    expect(await localCall(local, 'machines.list', {})).toEqual([]);
    expect(code).toBeTruthy();
  });

  it('renames and moves a machine; a move drops its relays', async () => {
    const { machine } = await pair(local, 'Moved');
    const ws = await openRelay(local, machine.id);
    expect(await call(ws, 'machine.get', {})).toMatchObject({ result: { id: machine.id } });
    const renamed = await localCall<PairedMachine>(local, 'machines.update', {
      machineId: machine.id,
      name: ' Den ',
    });
    expect(renamed).toEqual({ ...machine, name: 'Den' });
    // A rename keeps the relay.
    expect(await call(ws, 'machine.get', {})).toMatchObject({ result: { id: machine.id } });
    const closed = closeCode(ws);
    await localCall(local, 'machines.update', { machineId: machine.id, address: 'localhost' });
    expect(await closed).toBe(4502);
    await expect(
      localCall(local, 'machines.update', { machineId: 'unknown', name: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      localCall(local, 'machines.update', { machineId: machine.id, address: 'a/b' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('serves machines.* to this machine only', async () => {
    const remoteCtx = { clientId: 'r', origin: 'remote' as const, deviceId: 'd' };
    for (const [method, params] of [
      ['machines.list', {}],
      ['machines.pair', { address: '127.0.0.1', code: 'ABCD-EFGH-JKMN', deviceName: 'x' }],
      ['machines.unlock', { machineId: 'm', token: 'a'.repeat(64) }],
      ['machines.update', { machineId: 'm', name: 'x' }],
      ['machines.remove', { machineId: 'm', revoke: true }],
    ] as const) {
      expect(
        await remote.router.dispatch({ id: 1, method, params }, remoteCtx),
        method,
      ).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
  });

  it('lets a paired device revoke only itself', async () => {
    const devices = await remoteDevices();
    const other = devices[0]?.id ?? 'someone-else';
    const own = { clientId: 'r', origin: 'remote' as const, deviceId: 'mine' };
    expect(
      await remote.router.dispatch(
        { id: 1, method: 'devices.revoke', params: { deviceId: other } },
        own,
      ),
    ).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(
      await remote.router.dispatch(
        { id: 1, method: 'devices.revoke', params: { deviceId: 'mine' } },
        own,
      ),
    ).toEqual({ id: 1, result: { revoked: false } });
    expect(
      await remote.router.dispatch(
        { id: 1, method: 'devices.revoke', params: { deviceId: other } },
        { clientId: 'p', origin: 'remote' },
      ),
    ).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });
});

describe('relay', () => {
  const TOKEN = 'a'.repeat(64);
  let fake: FakeMachine;
  let server: Awaited<ReturnType<typeof startWsServer>>;
  let relay: ReturnType<typeof createRelay>;
  let counts: number[];
  let onRemote: (ws: WebSocket) => void;
  let target: { port: number };

  const machineAt = (id: string): (PairedMachine & { certPem: string; deviceId: string }) | null =>
    id === 'm-1'
      ? {
          id,
          name: 'Fake',
          address: '127.0.0.1',
          port: target.port,
          fingerprint: fake.tls.fingerprint256,
          certPem: fake.tls.certPem,
          deviceId: 'd',
          addedAt: 0,
          unlocked: true,
        }
      : null;

  beforeEach(async () => {
    onRemote = (ws) => ws.on('message', (d, binary) => ws.send(d, { binary }));
    fake = await startFakeMachine(dir, (ws) => onRemote(ws));
    target = fake;
    counts = [];
    relay = createRelay({
      machines: { get: machineAt, token: (id) => (id === 'm-1' ? TOKEN : null) },
      linkTimeoutMs: 300,
    });
    server = await startWsServer({
      token: 't',
      router: new Router(),
      relay,
      onClientCountChange: (n) => counts.push(n),
    });
  });
  afterEach(async () => {
    relay.close();
    await server.close();
    await fake.close();
  });
  const open = () => openRelayAt(server.port, 't', 'm-1');
  const nextFrame = (ws: WebSocket) =>
    new Promise<{ data: string; binary: boolean }>((resolve) =>
      ws.once('message', (d, binary) => resolve({ data: String(d), binary })),
    );

  it('pipes text and binary frames verbatim, both ways, in order', async () => {
    const ws = await open();
    const frames: { data: string; binary: boolean }[] = [];
    ws.on('message', (d, binary) => frames.push({ data: String(d), binary }));
    // Sent at once: frames that arrive before the link is up wait for it.
    ws.send('not json {');
    ws.send(Buffer.from('binary'), { binary: true });
    ws.send(JSON.stringify({ id: 1, method: 'x', params: {} }));
    await expect.poll(() => frames.length).toBe(3);
    expect(frames).toEqual([
      { data: 'not json {', binary: false },
      { data: 'binary', binary: true },
      { data: '{"id":1,"method":"x","params":{}}', binary: false },
    ]);
    expect(fake.received()).toEqual(frames);
    expect(fake.upgradeRequests()[0]?.['sec-websocket-protocol']).toBe(
      `threadgarden-device.${TOKEN}`,
    );
    ws.close();
  });

  it('counts relays as clients and sends them no local events', async () => {
    const ws = await open();
    expect(counts).toEqual([1]);
    server.broadcast({ event: 'local.only', data: {} });
    ws.send('ping');
    expect(await nextFrame(ws)).toEqual({ data: 'ping', binary: false });
    const closed = closeCode(ws);
    ws.close();
    await closed;
    await expect.poll(() => counts).toEqual([1, 0]);
  });

  it('closes the link when the UI closes and the UI when the link closes', async () => {
    const ws = await open();
    ws.send('hello');
    await nextFrame(ws);
    ws.close();
    await expect.poll(() => fake.closed()).toBe(1);

    const remoteSockets: WebSocket[] = [];
    onRemote = (r) => void remoteSockets.push(r);
    for (const [remoteCode, uiCode] of [
      [1000, 4502],
      [1001, 4502],
      [1011, 4502],
      [4401, 4403],
      [4403, 4403],
      [4408, 4502],
    ] as const) {
      const ui = await open();
      await expect.poll(() => remoteSockets.length).toBeGreaterThan(0);
      remoteSockets.shift()!.close(remoteCode);
      expect(await closeCode(ui), String(remoteCode)).toBe(uiCode);
    }
  });

  it('closes 4502 when the link is not up in time', async () => {
    const held = new Set<Socket>();
    let released = 0;
    const silent = createServer((s) => {
      held.add(s);
      // Reads (and ignores) the client hello, so the client's close is seen.
      s.resume();
      s.on('close', () => released++);
    });
    const port = await new Promise<number>((resolve) =>
      silent.listen(0, '127.0.0.1', () => resolve((silent.address() as AddressInfo).port)),
    );
    target = { port };
    const started = Date.now();
    expect(await closeCode(await open())).toBe(4502);
    expect(Date.now() - started).toBeLessThan(3_000);
    // The connection stuck in its TLS handshake is let go, not left to the peer.
    await expect.poll(() => released, { timeout: 2_000 }).toBe(1);
    for (const s of held) s.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });

  it('closes 4404 for an unknown machine, and when the relay is not offered', async () => {
    expect(await closeCode(await openRelayAt(server.port, 't', 'm-2'))).toBe(4404);
    const bare = await startWsServer({
      token: 't',
      router: new Router(),
      onClientCountChange: () => {},
    });
    expect(await closeCode(await openRelayAt(bare.port, 't', 'm-1'))).toBe(4404);
    await bare.close();
  });

  it('closes 4502 when the machine stops answering pings, and keeps a live link', async () => {
    expect(RELAY_PING_MS).toBe(15_000);
    const relayTo = async (machine: FakeMachine) => {
      const r = createRelay({
        machines: {
          get: (id) =>
            id === 'm-1'
              ? {
                  id,
                  name: 'Fake',
                  address: '127.0.0.1',
                  port: machine.port,
                  fingerprint: machine.tls.fingerprint256,
                  certPem: machine.tls.certPem,
                  deviceId: 'd',
                  addedAt: 0,
                  unlocked: true,
                }
              : null,
          token: () => TOKEN,
        },
        pingMs: 50,
      });
      const srv = await startWsServer({
        token: 't',
        router: new Router(),
        relay: r,
        onClientCountChange: () => {},
      });
      cleanup.push(async () => {
        r.close();
        await srv.close();
      });
      return srv;
    };
    // A live machine answers pings: the relay outlives several intervals.
    const liveServer = await relayTo(fake);
    const live = await openRelayAt(liveServer.port, 't', 'm-1');
    await new Promise((r) => setTimeout(r, 300));
    live.send('still here');
    expect(await nextFrame(live)).toEqual({ data: 'still here', binary: false });
    live.close();

    // A machine whose network dropped: no close, no pong.
    const deaf = await startFakeMachine(dir, () => {}, { autoPong: false });
    cleanup.push(() => deaf.close());
    const deafServer = await relayTo(deaf);
    const ui = await openRelayAt(deafServer.port, 't', 'm-1');
    await expect.poll(() => deaf.upgradeRequests().length).toBe(1);
    expect(await closeCode(ui)).toBe(4502);
    // The dead link is let go as well.
    await expect.poll(() => deaf.closed(), { timeout: 2_000 }).toBe(1);
  });

  it('closes 4502, not 4409, when the pinned certificate fails only its dates', async () => {
    // The paired machine itself, with the pinned certificate, as seen by a
    // clock that is off: an expired certificate.
    const pems = await generate([{ name: 'commonName', value: 'ubuntu-pc' }], {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notBeforeDate: new Date(Date.now() - 3 * 86_400_000),
      notAfterDate: new Date(Date.now() - 86_400_000),
    });
    const expired = await startFakeMachine(dir, () => {}, {
      tls: {
        keyPem: pems.private,
        certPem: pems.cert,
        fingerprint256: new X509Certificate(pems.cert).fingerprint256,
      },
    });
    cleanup.push(() => expired.close());
    const failures: unknown[] = [];
    const r = createRelay({
      machines: {
        get: (id) => ({
          id,
          name: 'Fake',
          address: '127.0.0.1',
          port: expired.port,
          fingerprint: expired.tls.fingerprint256,
          certPem: expired.tls.certPem,
          deviceId: 'd',
          addedAt: 0,
          unlocked: true,
        }),
        token: () => TOKEN,
      },
      onLinkFailed: (_id, err) => failures.push(err),
    });
    const srv = await startWsServer({
      token: 't',
      router: new Router(),
      relay: r,
      onClientCountChange: () => {},
    });
    cleanup.push(async () => {
      r.close();
      await srv.close();
    });
    expect(await closeCode(await openRelayAt(srv.port, 't', 'm-1'))).toBe(4502);
    expect(String(failures[0])).toContain('CERT_HAS_EXPIRED');
    // Still nothing was sent to it.
    expect(expired.upgradeRequests()).toHaveLength(0);
  });

  it('refuses new relays once closed', async () => {
    relay.close();
    expect(await closeCode(await open())).toBe(1001);
    expect(fake.connections()).toBe(0);
  });

  it('drops the relays of one machine on request, and every link on close', async () => {
    const a = await open();
    a.send('x');
    await nextFrame(a);
    relay.drop('m-1', 4404);
    expect(await closeCode(a)).toBe(4404);
    await expect.poll(() => fake.closed()).toBe(1);

    const b = await open();
    b.send('x');
    await nextFrame(b);
    relay.close();
    await expect.poll(() => fake.closed()).toBe(2);
  });
});
