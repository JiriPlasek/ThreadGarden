import type { MachineInfo, PairedMachine } from '@threadgarden/protocol';
import { PROTOCOL_VERSION } from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ServiceClient } from '../../src/lib/service/client';
import { MachinesState } from '../../src/lib/state/machines.svelte';
import { FakeServer, RpcFail, routedImpl } from '../service/fake-ws';

const LOCAL_PORT = 5555;
const LOCAL_ID = 'local-machine';
const M1 = 'machine-1';
const M2 = 'machine-2';

const info = (id: string, name: string): MachineInfo => ({
  id,
  name,
  platform: 'linux',
  headless: true,
  home: '/home/u',
  capabilities: ['remote'],
});
const paired = (id: string, name: string): PairedMachine => ({
  id,
  name,
  address: '192.168.1.5',
  port: 47380,
  fingerprint: 'aa',
  addedAt: 1,
  unlocked: false,
});

let local: FakeServer;
let remotes: Map<string, FakeServer>;
let pairedList: PairedMachine[];
let localClient: ServiceClient;
let machines: MachinesState;
let tokens: {
  get: Mock<(id: string) => Promise<string | null>>;
  set: Mock<(id: string, token: string) => Promise<void>>;
  clear: Mock<(id: string) => Promise<void>>;
};
let impl: typeof WebSocket;

const remote = (id: string): FakeServer => {
  let s = remotes.get(id);
  if (!s) {
    s = new FakeServer();
    s.handlers.hello = () => ({
      serviceVersion: '1.4.0',
      protocolVersion: PROTOCOL_VERSION,
      machine: info(id, id),
    });
    remotes.set(id, s);
  }
  return s;
};

const setup = async (list: PairedMachine[], stored: Record<string, string> = {}) => {
  pairedList = list;
  const store = new Map(Object.entries(stored));
  tokens = {
    get: vi.fn(async (id: string): Promise<string | null> => store.get(id) ?? null),
    set: vi.fn(async (id: string, t: string) => void store.set(id, t)),
    clear: vi.fn(async (id: string) => void store.delete(id)),
  };
  localClient = new ServiceClient({ WebSocketImpl: impl });
  machines = new MachinesState();
  machines.init(localClient, localClient, {
    relayUrl: (id) => `ws://127.0.0.1:${LOCAL_PORT}/relay?machine=${id}`,
    localToken: () => 'local-token',
    tokens,
    makeClient: (o) => new ServiceClient({ ...o, WebSocketImpl: impl }),
  });
  const p = localClient.connect(`ws://127.0.0.1:${LOCAL_PORT}`, 'local-token');
  await vi.advanceTimersByTimeAsync(0);
  await p;
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  local = new FakeServer();
  remotes = new Map();
  local.handlers.hello = () => ({
    serviceVersion: '1.4.0',
    protocolVersion: PROTOCOL_VERSION,
    machine: info(LOCAL_ID, 'my-host'),
  });
  local.handlers['machines.list'] = () => pairedList;
  local.handlers['machines.unlock'] = () => ({});
  local.handlers['machines.remove'] = () => ({ revoked: true });
  impl = routedImpl((url) =>
    url.includes('/relay?machine=') ? remote(url.split('=')[1]!) : local,
  );
});
afterEach(() => {
  localClient.close();
  for (const m of machines.list) m.client.close();
  vi.useRealTimers();
});

describe('MachinesState', () => {
  it('unlocks and connects every paired machine through the relay', async () => {
    await setup([paired(M1, 'Ubuntu PC')], { [M1]: 'tok' });
    await vi.advanceTimersByTimeAsync(0);
    expect(machines.get(M1)?.status).toBe('on');
    expect(local.calls('machines.unlock').map((c) => c.params)).toEqual([
      { machineId: M1, token: 'tok' },
    ]);
    expect(remote(M1).url).toBe(`ws://127.0.0.1:${LOCAL_PORT}/relay?machine=${M1}`);
    expect(remote(M1).protocols[0]).toEqual(['threadgarden.local-token', 'pahub.local-token']);
    expect(machines.get(M1)?.info?.id).toBe(M1);
  });

  it('lists This PC first, named from the local hello, mirroring the local client', async () => {
    await setup([paired(M1, 'Ubuntu PC')], { [M1]: 'tok' });
    await vi.advanceTimersByTimeAsync(0);
    expect(machines.list.map((m) => m.id)).toEqual([LOCAL_ID, M1]);
    expect(machines.local).toMatchObject({ id: LOCAL_ID, local: true, status: 'on' });
    local.drop();
    expect(machines.local?.status).toBe('unreachable');
  });

  it('marks a machine without a keychain token locked and does not connect it', async () => {
    await setup([paired(M1, 'Ubuntu PC')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(machines.get(M1)?.status).toBe('locked');
    expect(local.calls('machines.unlock')).toEqual([]);
    expect(remote(M1).sockets).toHaveLength(0);
  });

  it('reconnects after the remote drops and replays reconnect handlers', async () => {
    await setup([paired(M1, 'Ubuntu PC')], { [M1]: 'tok' });
    await vi.advanceTimersByTimeAsync(0);
    const reconnects = vi.fn();
    machines.get(M1)!.client.onReconnect(reconnects);
    remote(M1).drop(4502);
    expect(machines.get(M1)?.status).toBe('unreachable');
    await vi.advanceTimersByTimeAsync(300);
    expect(machines.get(M1)?.status).toBe('on');
    expect(reconnects).toHaveBeenCalledOnce();
  });

  it('unlocks again after the local service restarts', async () => {
    await setup([paired(M1, 'Ubuntu PC')], { [M1]: 'tok' });
    await vi.advanceTimersByTimeAsync(0);
    expect(local.calls('machines.unlock')).toHaveLength(1);
    local.drop(1006);
    remote(M1).drop(1001);
    await vi.advanceTimersByTimeAsync(1000);
    expect(local.calls('machines.unlock')).toHaveLength(2);
    expect(machines.get(M1)?.status).toBe('on');
  });

  it('stops on a certificate mismatch and says so', async () => {
    await setup([paired(M1, 'Ubuntu PC')], { [M1]: 'tok' });
    await vi.advanceTimersByTimeAsync(0);
    remote(M1).drop(4409);
    expect(machines.get(M1)?.status).toBe('mismatch');
    const attempts = remote(M1).sockets.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(remote(M1).sockets).toHaveLength(attempts);
    expect(machines.get(M1)?.status).toBe('mismatch');
  });

  it('stops when the machine refuses the device and when the relay is locked', async () => {
    await setup([paired(M1, 'A'), paired(M2, 'B')], { [M1]: 't1', [M2]: 't2' });
    await vi.advanceTimersByTimeAsync(0);
    remote(M1).drop(4403);
    remote(M2).drop(4404);
    expect(machines.get(M1)?.status).toBe('refused');
    expect(machines.get(M2)?.status).toBe('locked');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(remote(M1).sockets).toHaveLength(1);
    expect(remote(M2).sockets).toHaveLength(1);
  });

  it('accepts a remote on protocol 4 or 6 but not 3', async () => {
    const proto = (id: string, v: number) => {
      remote(id).handlers.hello = () => ({ serviceVersion: 'x', protocolVersion: v });
    };
    proto('m4', 4);
    proto('m6', 6);
    proto('m3', 3);
    await setup([paired('m4', 'a'), paired('m6', 'b'), paired('m3', 'c')], {
      m4: 't',
      m6: 't',
      m3: 't',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(machines.get('m4')?.status).toBe('on');
    expect(machines.get('m6')?.status).toBe('on');
    expect(machines.get('m3')?.status).toBe('incompatible');
  });

  it('pairs: keychain first, then connect', async () => {
    await setup([]);
    const order: string[] = [];
    tokens.set.mockImplementation(async () => void order.push('keychain'));
    const p = paired(M1, 'Ubuntu PC');
    local.handlers['machines.pair'] = () => ({ machine: p, token: 'tok' });
    remote(M1).handlers.hello = () => {
      order.push('connect');
      return { serviceVersion: 'x', protocolVersion: PROTOCOL_VERSION };
    };
    const added = vi.fn();
    machines.onAdded(added);
    const pending = machines.pair({ address: '192.168.1.5', code: 'C', deviceName: 'Laptop' });
    await vi.advanceTimersByTimeAsync(0);
    const entry = await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['keychain', 'connect']);
    expect(tokens.set).toHaveBeenCalledWith(M1, 'tok');
    expect(entry.id).toBe(M1);
    expect(machines.get(M1)?.status).toBe('on');
    expect(added).toHaveBeenCalledOnce();
  });

  it('pair: a keychain failure revokes the pairing and rethrows', async () => {
    await setup([]);
    tokens.set.mockRejectedValue(new Error('keychain locked'));
    local.handlers['machines.pair'] = () => ({ machine: paired(M1, 'U'), token: 'tok' });
    const pending = machines.pair({ address: 'a', code: 'C', deviceName: 'L' });
    const assertion = expect(pending).rejects.toThrow('keychain locked');
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(local.calls('machines.remove').map((c) => c.params)).toEqual([
      { machineId: M1, revoke: true },
    ]);
    expect(machines.get(M1)).toBeUndefined();
  });

  it('remove: closes, revokes, clears the keychain even when the service fails, drops the entry', async () => {
    await setup([paired(M1, 'U')], { [M1]: 'tok' });
    await vi.advanceTimersByTimeAsync(0);
    const removed = vi.fn();
    machines.onRemoved(removed);
    local.handlers['machines.remove'] = () => {
      throw new RpcFail('INTERNAL');
    };
    const pending = machines.remove(M1);
    const assertion = expect(pending).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(local.calls('machines.remove')[0]?.params).toEqual({ machineId: M1, revoke: true });
    expect(tokens.clear).toHaveBeenCalledWith(M1);
    expect(machines.get(M1)).toBeUndefined();
    expect(removed).toHaveBeenCalledWith(M1);
  });

  it('machines.changed renames, reconnects on a new address and drops vanished machines', async () => {
    await setup([paired(M1, 'U'), paired(M2, 'V')], { [M1]: 't1', [M2]: 't2' });
    await vi.advanceTimersByTimeAsync(0);
    const removed = vi.fn();
    machines.onRemoved(removed);
    const before = remote(M1).sockets.length;
    local.push('machines.changed', [{ ...paired(M1, 'Renamed'), address: '10.0.0.9' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(machines.get(M1)?.name).toBe('Renamed');
    expect(machines.get(M1)?.address).toBe('10.0.0.9');
    expect(remote(M1).sockets.length).toBe(before + 1);
    expect(machines.get(M2)).toBeUndefined();
    expect(removed).toHaveBeenCalledWith(M2);
    local.push('machines.changed', [{ ...paired(M1, 'Again'), address: '10.0.0.9' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(remote(M1).sockets.length).toBe(before + 1);
  });

  it('rename and setAddress go through machines.update', async () => {
    await setup([paired(M1, 'U')], { [M1]: 't1' });
    await vi.advanceTimersByTimeAsync(0);
    local.handlers['machines.update'] = (p) => ({ ...paired(M1, 'U'), ...(p as object) });
    const r = machines.rename(M1, 'Box');
    await vi.advanceTimersByTimeAsync(0);
    await r;
    expect(machines.get(M1)?.name).toBe('Box');
    const a = machines.setAddress(M1, '10.1.1.1', 1234);
    await vi.advanceTimersByTimeAsync(0);
    await a;
    expect(machines.get(M1)).toMatchObject({ address: '10.1.1.1', port: 1234 });
  });
});
