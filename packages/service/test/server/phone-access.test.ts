import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { REMOTE_PORT } from '../../src/server/remote-server.js';
import { startService, type ServiceHandle } from '../../src/main.js';
import { generateCorpus } from '../../src/testing/corpus.js';
import { TestClient } from '../e2e/ws-client.js';

/**
 * Let my phone connect (Task 3): a desktop's service listens for paired
 * devices, as a headless one does, only while the owner has it on. Every
 * listener here is on loopback and a free port (never 47380: a real service
 * may be on it), in a temp data dir.
 */
const quietLogger = () => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  flush: async () => {},
});

type PhoneAccess = { enabled: boolean; addresses: string[]; port: number };

let dir: string;
const running: ServiceHandle[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tg-phone-access-'));
});
afterEach(async () => {
  for (const svc of running.splice(0)) await svc.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

/** A desktop (not headless) service with history, listening on loopback when asked. */
const desktop = async (extra: Partial<Parameters<typeof startService>[0]> = {}) => {
  const svc = await startService({
    dataDir: join(dir, 'data'),
    claudeConfigDir: join(dir, 'claude-missing'),
    adapter: generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 }),
    installSignalHandlers: false,
    host: null,
    remote: { addressSource: () => ['127.0.0.1'], port: 0 },
    logger: quietLogger(),
    ...extra,
  });
  running.push(svc);
  return svc;
};

const local = async <T>(svc: ServiceHandle, method: string, params: unknown): Promise<T> => {
  const client = await TestClient.connect(svc.port, svc.token);
  try {
    return await client.call<T>(method, params);
  } finally {
    await client.close();
  }
};

/** Pairs a device through the service's own handlers; its token. */
const pairDevice = async (svc: ServiceHandle): Promise<string> => {
  const created = (await svc.router.dispatch(
    { id: 1, method: 'pairing.create', params: {} },
    { clientId: 't', origin: 'local' },
  )) as { result: { code: string } };
  const claimed = (await svc.router.dispatch(
    { id: 2, method: 'pair.claim', params: { code: created.result.code, deviceName: 'Phone' } },
    { clientId: 'p', origin: 'remote' },
  )) as { result: { token: string } };
  return claimed.result.token;
};

const openDevice = (port: number, protocol: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, [protocol], { rejectUnauthorized: false });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

let nextId = 100;
const call = (ws: WebSocket, method: string, params: unknown): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    const id = nextId++;
    const onMessage = (d: unknown) => {
      const msg = JSON.parse(String(d)) as { id?: number };
      if (msg.id !== id) return;
      ws.off('message', onMessage);
      resolve(msg as Record<string, unknown>);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });

/** The certificate the listener shows, as a device pins it. */
const fingerprintAt = (port: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: false });
    socket.once('secureConnect', () => {
      resolve(socket.getPeerCertificate().fingerprint256);
      socket.destroy();
    });
    socket.once('error', reject);
  });

describe('Let my phone connect', () => {
  it('no listener by default', async () => {
    const svc = await desktop();
    expect(svc.remote).toBeUndefined();
    expect(await local<PhoneAccess>(svc, 'phoneAccess.get', {})).toEqual({
      enabled: false,
      addresses: [],
      port: 0,
    });
    // Not even a certificate until it's first turned on.
    expect(existsSync(join(dir, 'data', 'tls'))).toBe(false);
  });

  it('turning it on listens on private addresses, with the headless port', async () => {
    const svc = await desktop();
    const watcher = await TestClient.connect(svc.port, svc.token);
    const on = await local<PhoneAccess>(svc, 'phoneAccess.set', { enabled: true });
    expect(on.enabled).toBe(true);
    expect(on.addresses).toEqual(['127.0.0.1']);
    expect(on.port).toBeGreaterThan(0);
    expect(svc.remote).toEqual({ addresses: ['127.0.0.1'], port: on.port });
    expect(await local<PhoneAccess>(svc, 'phoneAccess.get', {})).toEqual(on);
    // The screens hear of it.
    const changed = await watcher.waitFor((e) => e.event === 'phoneAccess.changed');
    expect(changed.data).toEqual(on);
    await watcher.close();
    // As on a headless machine: a code, its proof, a device.
    const token = await pairDevice(svc);
    const device = await openDevice(on.port, `threadgarden-device.${token}`);
    expect(await call(device, 'hello', { protocolVersion: 11, client: 't' })).toMatchObject({
      result: { machine: { headless: false } },
    });
    device.close();
    const { code } = await local<{ code: string }>(svc, 'pairing.create', {});
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const pairing = await openDevice(on.port, 'threadgarden-pair');
    const proof = await call(pairing, 'pair.proof', { nonce: 'a'.repeat(64) });
    expect((proof.result as { proof: string }).proof).toMatch(/^[0-9a-f]{64}$/);
    pairing.close();
    expect(await local<unknown[]>(svc, 'devices.list', {})).toHaveLength(1);
  });

  it('listens on the headless port unless told otherwise', async () => {
    // Not turned on, so nothing binds 47380 here.
    const svc = await desktop({ remote: { addressSource: () => ['127.0.0.1'] } });
    expect((await local<PhoneAccess>(svc, 'phoneAccess.get', {})).port).toBe(REMOTE_PORT);
  });

  it('turning it off closes the sockets', async () => {
    const svc = await desktop();
    const { port } = await local<PhoneAccess>(svc, 'phoneAccess.set', { enabled: true });
    const token = await pairDevice(svc);
    const device = await openDevice(port, `threadgarden-device.${token}`);
    const closed = new Promise<void>((resolve) => device.once('close', () => resolve()));
    const off = await local<PhoneAccess>(svc, 'phoneAccess.set', { enabled: false });
    expect(off).toEqual({ enabled: false, addresses: [], port: 0 });
    await closed;
    expect(svc.remote).toBeUndefined();
    await expect(openDevice(port, `threadgarden-device.${token}`)).rejects.toThrow();
    // The pairing stays.
    expect(await local<unknown[]>(svc, 'devices.list', {})).toHaveLength(1);
  });

  it("a device can't change it", async () => {
    const svc = await desktop();
    const { port } = await local<PhoneAccess>(svc, 'phoneAccess.set', { enabled: true });
    const token = await pairDevice(svc);
    const device = await openDevice(port, `threadgarden-device.${token}`);
    try {
      for (const [method, params] of [
        ['phoneAccess.set', { enabled: false }],
        ['phoneAccess.get', {}],
      ] as const) {
        const res = await call(device, method, params);
        expect(res).toMatchObject({ error: { code: 'FORBIDDEN' } });
        expect(res).not.toHaveProperty('result');
      }
      // Not a setting: what a device may change leaves it alone.
      const set = await call(device, 'settings.set', { theme: 'dark' });
      expect(set).toHaveProperty('result');
      expect(set.result).not.toHaveProperty('phoneAccess');
    } finally {
      device.close();
    }
    expect((await local<PhoneAccess>(svc, 'phoneAccess.get', {})).enabled).toBe(true);
  });

  const idleClock = () => {
    const state = { now: 0, timers: [] as (() => void)[] };
    return {
      state,
      opts: {
        liveCount: () => 0,
        clock: () => state.now,
        setInterval: (fn: () => void) => {
          state.timers.push(fn);
          return 1 as unknown as NodeJS.Timeout;
        },
        clearInterval: () => {},
      },
    };
  };

  it("a desktop that's listening never exits when idle", async () => {
    const { state, opts } = idleClock();
    const svc = await desktop(opts);
    await local(svc, 'phoneAccess.set', { enabled: true });
    const closed = vi.fn();
    svc.onClosed(closed);
    state.now = 31 * 60_000;
    state.timers[0]!();
    state.now = 120 * 60_000;
    state.timers[0]!();
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).not.toHaveBeenCalled();
  });

  it('off again, the idle exit is back', async () => {
    const { state, opts } = idleClock();
    const svc = await desktop(opts);
    await local(svc, 'phoneAccess.set', { enabled: true });
    await local(svc, 'phoneAccess.set', { enabled: false });
    const done = new Promise<void>((r) => svc.onClosed(r));
    state.now = 31 * 60_000;
    state.timers[0]!();
    await done;
  });

  it('the certificate survives off and on, so the pairing holds', async () => {
    const svc = await desktop();
    const first = await local<PhoneAccess>(svc, 'phoneAccess.set', { enabled: true });
    const pinned = await fingerprintAt(first.port);
    const token = await pairDevice(svc);
    await local(svc, 'phoneAccess.set', { enabled: false });
    const again = await local<PhoneAccess>(svc, 'phoneAccess.set', { enabled: true });
    expect(await fingerprintAt(again.port)).toBe(pinned);
    const device = await openDevice(again.port, `threadgarden-device.${token}`);
    expect(await call(device, 'machine.get', {})).toHaveProperty('result');
    device.close();
  });

  it('the choice survives a restart', async () => {
    const first = await desktop();
    await local(first, 'phoneAccess.set', { enabled: true });
    await first.close();
    running.splice(running.indexOf(first), 1);
    const second = await desktop();
    expect(second.remote?.addresses).toEqual(['127.0.0.1']);
    expect((await local<PhoneAccess>(second, 'phoneAccess.get', {})).enabled).toBe(true);
    await local(second, 'phoneAccess.set', { enabled: false });
    await second.close();
    running.splice(running.indexOf(second), 1);
    const third = await desktop();
    expect(third.remote).toBeUndefined();
  });

  it("a paired device can't call power.shutdown on a desktop", async () => {
    const svc = await desktop();
    const { port } = await local<PhoneAccess>(svc, 'phoneAccess.set', { enabled: true });
    const token = await pairDevice(svc);
    const device = await openDevice(port, `threadgarden-device.${token}`);
    try {
      const res = await call(device, 'power.shutdown', { force: true });
      expect(res).toHaveProperty('error');
      expect(res).not.toHaveProperty('result');
      // Nor does the desktop say it can be switched off.
      const hello = await call(device, 'hello', { protocolVersion: 11, client: 't' });
      const capabilities = (hello.result as { machine: { capabilities: string[] } }).machine
        .capabilities;
      expect(capabilities).not.toContain('power');
      // Still serving.
      expect(await call(device, 'machine.get', {})).toHaveProperty('result');
    } finally {
      device.close();
    }
  });

  it('a headless machine always listens, and says so', async () => {
    const svc = await desktop({ headless: true, remote: { addresses: ['127.0.0.1'], port: 0 } });
    const state = await local<PhoneAccess>(svc, 'phoneAccess.get', {});
    expect(state).toEqual({ enabled: true, addresses: ['127.0.0.1'], port: svc.remote!.port });
    const client = await TestClient.connect(svc.port, svc.token);
    try {
      const res = await client.raw('phoneAccess.set', { enabled: false });
      expect(res.error?.code).toBe('HEADLESS');
    } finally {
      await client.close();
    }
    expect(svc.remote).toBeDefined();
  });
});
