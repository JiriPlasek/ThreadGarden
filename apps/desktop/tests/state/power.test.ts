import {
  POWER_CAPABILITY,
  POWER_ERRORS,
  type MachinePowerStatus,
  type PowerConfig,
} from '@threadgarden/protocol';
import { render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MachineHeading from '../../src/lib/components/layout/MachineHeading.svelte';
import type { AppState } from '../../src/lib/state/context';
import { M1, setupTwoMachines } from '../layout/harness';
import { RpcFail, type FakeServer } from '../service/fake-ws';

const CONFIG: PowerConfig = {
  kind: 'tasmota-zigbee',
  address: '192.168.1.9',
  device: 'PC plug',
  offWatts: 5,
  minOffSeconds: 90,
  measured: { running: null, standby: null },
};

const machineStatus = (over: Partial<MachinePowerStatus> = {}): MachinePowerStatus => ({
  configured: true,
  busy: false,
  idleSince: null,
  shutsDownAt: null,
  keepAwake: { mode: 'off', until: null },
  phase: 'running',
  unpushed: [],
  problem: null,
  ...over,
});

/** What the plug reads now (the fake local service answers `power.reading` with it). */
let plug: { on: boolean | null; watts: number | null };
let apps: AppState[] = [];

const powerLocal = (s: FakeServer): void => {
  s.handlers['power.list'] = () => [{ machineId: M1, config: CONFIG }];
  s.handlers['power.reading'] = () => ({ ...plug, at: Date.now() });
  s.handlers['power.turnOn'] = () => ({ cycled: false, waitMs: 0 });
  s.handlers['power.unlock'] = () => ({});
  s.handlers['power.noteMeasurement'] = () => ({});
};

/** M1 with power control; `down`: its machine never answers (it is off). */
const start = async (
  o: {
    down?: boolean;
    status?: () => MachinePowerStatus;
    configureRemote?: (s: FakeServer) => void;
  } = {},
) => {
  const env = await setupTwoMachines({
    m1Capabilities: ['remote', POWER_CAPABILITY],
    powerPasswords: { [M1]: 'switch-pw' },
    waitForOn: !o.down,
    configure: powerLocal,
    configureRemote: (s) => {
      s.handlers['power.status'] = o.status ?? (() => machineStatus());
      s.handlers['power.adopt'] = () => ({});
      if (o.down) s.refuse = true;
      o.configureRemote?.(s);
    },
  });
  apps.push(env.app);
  // The local open: unlock, list, first readings.
  await vi.waitFor(() => expect(env.app.power.config(M1)).not.toBeNull());
  await vi.waitFor(() => expect(env.app.power.reading(M1)).not.toBeNull());
  const shown = () => env.app.power.status(M1, env.app.machines.get(M1)!.status);
  return { ...env, shown };
};

/** Lets every queued microtask (fake socket answers) run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  plug = { on: true, watts: 0 };
});

afterEach(() => {
  for (const app of apps) app.power.stop();
  apps = [];
  vi.useRealTimers();
});

describe('PowerState', () => {
  it('off when the link is down and the plug reads 0 W', async () => {
    const { app, server, shown, context } = await start({ down: true });
    expect(app.machines.get(M1)!.status).not.toBe('on');
    expect(shown()).toBe('off');
    // The keychain password unlocked the switch on the local service first.
    expect(server.calls('power.unlock').map((c) => c.params)).toEqual([
      { machineId: M1, password: 'switch-pw' },
    ]);
    // The heading shows the same state as everyone else.
    expect(app.machines.shown(app.machines.get(M1)!)).toBe('off');
    render(MachineHeading, {
      context,
      props: { machine: app.machines.get(M1)!, collapsed: false, onToggle: () => {} },
    });
    expect(screen.getByText('Off')).toBeTruthy();
  });

  it('a machine without power configured keeps its link status', async () => {
    const env = await setupTwoMachines({ m1Capabilities: ['remote', POWER_CAPABILITY] });
    apps.push(env.app);
    await settle();
    expect(env.app.power.config(M1)).toBeNull();
    expect(env.app.power.status(M1, 'unreachable')).toBe('unreachable');
    expect(env.server.calls('power.reading')).toHaveLength(0);
  });

  it('starting after turnOn while watts rise; unreachable after 5 min', async () => {
    const { app, server, shown } = await start({ down: true });
    expect(shown()).toBe('off');
    expect(await app.power.turnOn(M1)).toBe(true);
    expect(server.calls('power.turnOn').map((c) => c.params)).toEqual([{ machineId: M1 }]);
    plug = { on: true, watts: 60 };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(app.power.reading(M1)?.watts).toBe(60);
    expect(shown()).toBe('starting');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(shown()).toBe('unreachable');
  });

  it('a turn-on the switch refuses is a plain error, not a throw', async () => {
    const { app, server, shown } = await start({ down: true });
    server.handlers['power.turnOn'] = () => {
      throw new RpcFail(
        POWER_ERRORS.unreachable,
        "The switch didn't report whether the plug is on.",
      );
    };
    expect(await app.power.turnOn(M1)).toBe(false);
    expect(app.power.error(M1)).toMatch(/switch/i);
    plug = { on: true, watts: 60 };
    await vi.advanceTimersByTimeAsync(60_000);
    // Never started: high watts read as unreachable, not Starting…
    expect(shown()).toBe('unreachable');
  });

  it('shutting down: phase shuttingDown, then link lost at 46 W still shows Shutting down, then Off at 0 W', async () => {
    plug = { on: true, watts: 46 };
    const { app, server, remote, shown } = await start();
    expect(shown()).toBe('on');
    // A reading taken while the machine is on measures it running.
    await vi.waitFor(() =>
      expect(server.calls('power.noteMeasurement').map((c) => c.params)).toEqual([
        { machineId: M1, kind: 'running', watts: 46 },
      ]),
    );
    remote.push('power.changed', machineStatus({ phase: 'shuttingDown' }));
    await settle();
    expect(app.power.machine(M1)?.phase).toBe('shuttingDown');
    expect(shown()).toBe('shuttingDown');
    // The link drops mid-shutdown while the PC still draws 46 W.
    remote.refuse = true;
    remote.drop();
    await settle();
    expect(app.machines.get(M1)!.status).toBe('unreachable');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(shown()).toBe('shuttingDown');
    // Down to standby: Off, and the standby draw is measured once.
    plug = { on: true, watts: 1.5 };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(shown()).toBe('off');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      server
        .calls('power.noteMeasurement')
        .filter((c) => (c.params as { kind: string }).kind === 'standby')
        .map((c) => c.params),
    ).toEqual([{ machineId: M1, kind: 'standby', watts: 1.5 }]);
  });

  it('adopt is sent once when the machine lacks the config', async () => {
    const { app, remote } = await start({ status: () => machineStatus({ configured: false }) });
    await vi.waitFor(() => expect(remote.calls('power.adopt')).toHaveLength(1));
    expect(remote.calls('power.adopt')[0]!.params).toEqual({
      config: CONFIG,
      password: 'switch-pw',
    });
    // More news that it still lacks it (e.g. before it applied the adopt) sends no second one.
    remote.push('power.changed', machineStatus({ configured: false }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(remote.calls('power.adopt')).toHaveLength(1);
    expect(app.power.machine(M1)?.configured).toBe(false);
  });

  it('a machine already configured gets no adopt', async () => {
    const { remote } = await start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(remote.calls('power.status')).toHaveLength(1);
    expect(remote.calls('power.adopt')).toHaveLength(0);
  });

  it('polls every 5 s while starting, 60 s otherwise, not at all while hidden', async () => {
    const { app, server } = await start({ down: true });
    await settle();
    const reads = () => server.calls('power.reading').length;
    let n = reads();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(reads()).toBe(n);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads()).toBe(n + 1);

    await app.power.turnOn(M1);
    await settle();
    n = reads();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reads()).toBe(n + 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reads()).toBe(n + 2);

    app.power.visible(false);
    n = reads();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reads()).toBe(n);

    // Back in view: read at once, then on as before (the start is over by now: 60 s).
    app.power.visible(true);
    await settle();
    expect(reads()).toBe(n + 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reads()).toBe(n + 1);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(reads()).toBe(n + 2);
  });

  it('stops polling when no machine has power configured', async () => {
    const { app, server } = await start({ down: true });
    server.handlers['power.configure'] = () => null;
    await app.power.configure(M1, null);
    expect(app.power.config(M1)).toBeNull();
    const n = server.calls('power.reading').length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(server.calls('power.reading')).toHaveLength(n);
  });

  it('shut down and keep awake go to the machine and update its status', async () => {
    const { app, remote } = await start({
      configureRemote: (s) => {
        s.handlers['power.shutdown'] = () => machineStatus({ phase: 'blocked' });
        s.handlers['power.keepAwake'] = (p) =>
          machineStatus({ keepAwake: p as MachinePowerStatus['keepAwake'] });
      },
    });
    await app.power.shutDown(M1, false);
    expect(remote.calls('power.shutdown').map((c) => c.params)).toEqual([{ force: false }]);
    expect(app.power.machine(M1)?.phase).toBe('blocked');
    await app.power.keepAwake(M1, { mode: 'always', until: null });
    expect(app.power.machine(M1)?.keepAwake).toEqual({ mode: 'always', until: null });
  });
});
