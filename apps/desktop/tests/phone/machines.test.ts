import { PROTOCOL_VERSION, type MachineInfo } from '@threadgarden/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ServiceClient } from '../../src/lib/service/client';
import { MachinesState } from '../../src/lib/state/machines.svelte';
import { FakeServer, routedImpl } from '../service/fake-ws';
import { pairedMachine } from '../layout/harness';

const info = (id: string): MachineInfo => ({
  id,
  name: id,
  platform: 'linux',
  headless: id !== 'phone',
  home: '',
  capabilities: id === 'phone' ? [] : ['remote'],
});

describe('machines on the phone', () => {
  it('the core holds the tokens: a machine connects without unlocking, and is never locked', async () => {
    const core = new FakeServer();
    const remote = new FakeServer();
    core.handlers.hello = () => ({
      serviceVersion: '0.9.0',
      protocolVersion: PROTOCOL_VERSION,
      machine: info('phone'),
    });
    remote.handlers.hello = () => ({
      serviceVersion: '0.9.0',
      protocolVersion: PROTOCOL_VERSION,
      machine: info('machine-1'),
    });
    core.handlers['machines.list'] = () => [pairedMachine('machine-1', 'Ubuntu PC')];
    core.handlers['uiState.get'] = () => ({ value: null });
    const impl = routedImpl((url) => (url.includes('/relay?machine=') ? remote : core));
    const tokens = {
      heldByCore: true,
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };
    const client = new ServiceClient({ WebSocketImpl: impl });
    const machines = new MachinesState();
    machines.init(client, client, {
      relayUrl: (id) => `ws://127.0.0.1:1/relay?machine=${id}`,
      localToken: () => 't',
      tokens,
      makeClient: (o) => new ServiceClient({ ...o, WebSocketImpl: impl }),
    });
    await client.connect('ws://127.0.0.1:1', 't');
    await vi.waitFor(() => expect(machines.get('machine-1')?.status).toBe('on'));
    expect(core.calls('machines.unlock')).toHaveLength(0);
    expect(tokens.get).not.toHaveBeenCalled();
  });
});
