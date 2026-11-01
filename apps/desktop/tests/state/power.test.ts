import {
  POWER_CAPABILITY,
  POWER_ERRORS,
  type MachinePowerStatus,
  type PowerConfig,
} from '@threadgarden/protocol';
import { render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MachineHeading from '../../src/lib/components/layout/MachineHeading.svelte';
import { PENDING_REMOVALS_KEY, PowerState } from '../../src/lib/state/power.svelte';
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
  s.handlers['power.configure'] = (p) => (p as { config: PowerConfig | null }).config;
};

/** M1 with power control; `down`: its machine never answers (it is off). */
const start = async (
  o: {
    down?: boolean;
    status?: () => MachinePowerStatus;
    configure?: (s: FakeServer) => void;
    configureRemote?: (s: FakeServer) => void;
  } = {},
) => {
  const env = await setupTwoMachines({
    m1Capabilities: ['remote', POWER_CAPABILITY],
    powerPasswords: { [M1]: 'switch-pw' },
    waitForOn: !o.down,
    configure: (s) => {
      powerLocal(s);
      o.configure?.(s);
    },
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
  localStorage.clear();
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
    expect(app.power.error(M1)).toBe("The power switch can't be reached.");
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

  it('adopt is sent once per link open while this PC has a config', async () => {
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
    // A reconnect hands it over again: a config changed meanwhile reaches the machine.
    remote.drop();
    await vi.waitFor(() => expect(remote.calls('power.adopt')).toHaveLength(2));
  });

  it('a machine already configured gets the config too (it may have changed while it was off)', async () => {
    const { remote } = await start();
    await vi.waitFor(() => expect(remote.calls('power.adopt')).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(remote.calls('power.adopt')).toHaveLength(1);
  });

  it('a machine without the power capability gets no power status and no adopt', async () => {
    const env = await setupTwoMachines({
      configure: powerLocal,
      configureRemote: (s) => {
        s.handlers['power.status'] = () => machineStatus();
        s.handlers['power.adopt'] = () => ({});
      },
    });
    apps.push(env.app);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.remote.calls('power.status')).toHaveLength(0);
    expect(env.remote.calls('power.adopt')).toHaveLength(0);
    expect(env.app.power.machine(M1)).toBeNull();
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

  describe('removing power control while the machine is off', () => {
    const adoptNulls = (remote: FakeServer) =>
      remote.calls('power.adopt').filter((c) => (c.params as { config: unknown }).config === null);

    it('tells the machine at its next open, then forgets the entry', async () => {
      const { app, remote } = await start({ down: true });
      await app.power.configure(M1, null);
      await settle();
      expect(remote.calls('power.adopt')).toHaveLength(0);
      expect(app.power.pendingRemoval(M1)).toBe(true);
      expect(JSON.parse(localStorage.getItem(PENDING_REMOVALS_KEY) ?? '[]')).toEqual([M1]);

      remote.refuse = false;
      await vi.waitFor(() => expect(adoptNulls(remote)).toHaveLength(1));
      expect(adoptNulls(remote)[0]!.params).toEqual({ config: null });
      await vi.waitFor(() => expect(app.power.pendingRemoval(M1)).toBe(false));
      expect(JSON.parse(localStorage.getItem(PENDING_REMOVALS_KEY) ?? '[]')).toEqual([]);
    });

    it('survives a restart of the app', async () => {
      const env = await start({ down: true });
      await env.app.power.configure(M1, null);
      const next = new PowerState();
      apps.push({ power: next } as AppState);
      next.init(env.client, env.app.machines, { passwords: env.passwords });
      expect(next.pendingRemoval(M1)).toBe(true);
    });

    it('is tried again at the next open after a failure', async () => {
      let fail = true;
      const { app, remote } = await start({
        down: true,
        configureRemote: (s) => {
          s.handlers['power.adopt'] = () => {
            if (fail) throw new RpcFail('INTERNAL', 'busy');
            return {};
          };
        },
      });
      await app.power.configure(M1, null);
      remote.refuse = false;
      await vi.waitFor(() => expect(adoptNulls(remote)).toHaveLength(1));
      await settle();
      expect(app.power.pendingRemoval(M1)).toBe(true);
      fail = false;
      remote.drop();
      await vi.waitFor(() => expect(adoptNulls(remote)).toHaveLength(2));
      await vi.waitFor(() => expect(app.power.pendingRemoval(M1)).toBe(false));
    });

    it('is not kept for a machine that is unpaired', async () => {
      const { app } = await start({ down: true });
      await app.power.configure(M1, null);
      expect(app.power.pendingRemoval(M1)).toBe(true);
      await app.machines.remove(M1);
      expect(app.power.pendingRemoval(M1)).toBe(false);
    });

    it('a machine that is on is told at once and keeps no entry', async () => {
      const { app, remote } = await start();
      await app.power.configure(M1, null);
      await vi.waitFor(() => expect(adoptNulls(remote)).toHaveLength(1));
      expect(app.power.pendingRemoval(M1)).toBe(false);
    });
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

  it('removing a machine removes its power control and its keychain password', async () => {
    const { app, server, passwords } = await start({ down: true });
    await app.machines.remove(M1);
    await vi.waitFor(() =>
      expect(server.calls('power.configure').map((c) => c.params)).toEqual([
        { machineId: M1, config: null },
      ]),
    );
    await vi.waitFor(async () => expect(await passwords.get(M1)).toBeNull());
    expect(app.power.config(M1)).toBeNull();
    // A later local open lists nothing stale for it.
    server.handlers['machines.list'] = () => [];
    const n = server.calls('power.reading').length;
    server.drop();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(server.calls('power.reading')).toHaveLength(n);
  });

  it('a power.list row for a machine no longer paired is never polled', async () => {
    const { app, server } = await start({
      down: true,
      configure: (s) =>
        (s.handlers['power.list'] = () => [
          { machineId: M1, config: CONFIG },
          { machineId: 'unpaired', config: CONFIG },
        ]),
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(app.power.config('unpaired')).toBeNull();
    const ids = server
      .calls('power.reading')
      .map((c) => (c.params as { machineId: string }).machineId);
    expect(ids).toContain(M1);
    expect(ids).not.toContain('unpaired');
  });

  it('Starting… at once after Turn on with the plug still off, back to Off when nothing rose in 5 min', async () => {
    const { app, server, context } = await start({ down: true });
    server.handlers['power.turnOn'] = () => ({ cycled: true, waitMs: 90_000 });
    render(MachineHeading, {
      context,
      props: { machine: app.machines.get(M1)!, collapsed: false, onToggle: () => {} },
    });
    expect(screen.getByText('Off')).toBeTruthy();
    expect(app.power.turningOn(M1)).toBe(false);
    expect(app.power.turnOnWait(M1)).toBeNull();
    const readAt: number[] = [];
    const read = server.handlers['power.reading']!;
    server.handlers['power.reading'] = (p) => {
      readAt.push(Date.now());
      return read(p);
    };
    const pressed = Date.now();
    expect(await app.power.turnOn(M1)).toBe(true);
    flushSync();
    expect(app.power.turningOn(M1)).toBe(true);
    expect(app.power.turnOnWait(M1)).toBe(90_000);
    expect(screen.getByText('Starting…')).toBeTruthy();
    // The plug stays at 0 W: once the start gives up the heading says Off again, promptly.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 5_000);
    flushSync();
    expect(app.power.turningOn(M1)).toBe(false);
    expect(app.power.turnOnWait(M1)).toBeNull();
    expect(screen.getByText('Off')).toBeTruthy();
    // The tick where the start ran out read the plug once more.
    expect(readAt.some((t) => t - pressed >= 5 * 60_000)).toBe(true);
  });

  it('the shutdown grace counts from when the link left on, and expires visibly', async () => {
    plug = { on: true, watts: 46 };
    const { app, remote, context } = await start();
    render(MachineHeading, {
      context,
      props: { machine: app.machines.get(M1)!, collapsed: false, onToggle: () => {} },
    });
    remote.push('power.changed', machineStatus({ phase: 'shuttingDown' }));
    await settle();
    // The push check takes a while: the link drops 2.5 min after the event.
    await vi.advanceTimersByTimeAsync(150_000);
    remote.refuse = true;
    remote.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    flushSync();
    expect(app.machines.shown(app.machines.get(M1)!)).toBe('shuttingDown');
    expect(screen.getByText('Shutting down')).toBeTruthy();
    // Still 46 W 3 min after the link left: Unreachable, shown without waiting for a slow poll.
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 5_000);
    flushSync();
    expect(screen.getByText('Unreachable')).toBeTruthy();
  });

  it('a machine that comes back never shows a stale Shutting down', async () => {
    plug = { on: true, watts: 46 };
    const held: { answer?: (s: MachinePowerStatus) => void } = {};
    const { app, remote } = await start();
    remote.push('power.changed', machineStatus({ phase: 'shuttingDown' }));
    await settle();
    expect(app.machines.shown(app.machines.get(M1)!)).toBe('shuttingDown');
    // It reboots: its status is not in yet when the link opens again.
    remote.handlers['power.status'] = () =>
      new Promise<MachinePowerStatus>((resolve) => (held.answer = resolve));
    remote.drop();
    await vi.waitFor(() => expect(held.answer).toBeDefined());
    expect(app.machines.get(M1)!.status).toBe('on');
    expect(app.power.machine(M1)).toBeNull();
    expect(app.machines.shown(app.machines.get(M1)!)).toBe('on');
    held.answer!(machineStatus());
    await settle();
    expect(app.power.machine(M1)?.phase).toBe('running');
  });

  it('notes the running draw only when it moved by more than 5 %', async () => {
    plug = { on: true, watts: 46 };
    const { server } = await start();
    const running = () =>
      server
        .calls('power.noteMeasurement')
        .filter((c) => (c.params as { kind: string }).kind === 'running')
        .map((c) => (c.params as { watts: number }).watts);
    await vi.waitFor(() => expect(running()).toEqual([46]));
    plug = { on: true, watts: 47 };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(running()).toEqual([46]);
    plug = { on: true, watts: 50 };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(running()).toEqual([46, 50]);
  });

  it('configure stores the password in the keychain first and restores it when the service refuses', async () => {
    const { app, server, passwords } = await start({ down: true });
    const order: string[] = [];
    const set = passwords.set;
    passwords.set = async (id, pw) => {
      order.push(`keychain:${pw}`);
      await set(id, pw);
    };
    server.handlers['power.configure'] = () => {
      order.push('configure');
      throw new RpcFail(POWER_ERRORS.auth, 'refused');
    };
    await expect(app.power.configure(M1, CONFIG, 'new-pw')).rejects.toThrow();
    expect(order).toEqual(['keychain:new-pw', 'configure', 'keychain:switch-pw']);
    expect(await passwords.get(M1)).toBe('switch-pw');

    // None stored before: a refused configure leaves none.
    await passwords.clear(M1);
    await expect(app.power.configure(M1, CONFIG, 'new-pw')).rejects.toThrow();
    expect(await passwords.get(M1)).toBeNull();

    server.handlers['power.configure'] = (p) => (p as { config: PowerConfig }).config;
    await app.power.configure(M1, CONFIG, 'new-pw');
    expect(await passwords.get(M1)).toBe('new-pw');
  });
});
