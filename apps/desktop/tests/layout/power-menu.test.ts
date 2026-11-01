import {
  POWER_CAPABILITY,
  POWER_ERRORS,
  type MachinePowerStatus,
  type PowerConfig,
} from '@threadgarden/protocol';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import type { AppState } from '../../src/lib/state/context';
import { RpcFail, type FakeServer } from '../service/fake-ws';
import { M1, project, setupTwoMachines } from './harness';

vi.setConfig({ testTimeout: 15_000 });

const CONFIG: PowerConfig = {
  kind: 'tasmota-zigbee',
  address: '192.168.1.9',
  device: 'PC plug',
  offWatts: 5,
  minOffSeconds: 90,
  measured: { running: null, standby: null },
};

const status = (over: Partial<MachinePowerStatus> = {}): MachinePowerStatus => ({
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

let apps: AppState[] = [];
afterEach(() => {
  for (const app of apps) app.power.stop();
  apps = [];
});

const start = async (
  o: { power?: boolean; off?: boolean; status?: () => MachinePowerStatus } = {},
) => {
  const withPower = o.power !== false;
  const env = await setupTwoMachines({
    m1Capabilities: withPower ? ['remote', POWER_CAPABILITY] : ['remote'],
    powerPasswords: { [M1]: 'pw' },
    waitForOn: !o.off,
    configure: (s: FakeServer) => {
      s.handlers['power.list'] = () => (withPower ? [{ machineId: M1, config: CONFIG }] : []);
      s.handlers['power.reading'] = () => ({
        on: !o.off,
        watts: o.off ? 0 : 60,
        at: Date.now(),
      });
      s.handlers['power.turnOn'] = () => ({ cycled: false, waitMs: 0 });
      s.handlers['power.unlock'] = () => ({});
      s.handlers['power.noteMeasurement'] = () => ({});
    },
    configureRemote: (s: FakeServer) => {
      s.handlers['projects.list'] = () => [project('p2', 'infra')];
      s.handlers['power.status'] = o.status ?? (() => status());
      s.handlers['power.adopt'] = () => ({});
      s.handlers['power.shutdown'] = () => status();
      s.handlers['power.keepAwake'] = () => status();
      if (o.off) s.refuse = true;
    },
  });
  apps.push(env.app);
  render(PlacesColumn, { context: env.context });
  const group = await waitFor(() => screen.getByRole('group', { name: 'Ubuntu PC' }));
  return { ...env, group };
};

const openMenu = async (group: HTMLElement) => {
  // By keyboard (which is how it must work anyway): jsdom has no real pointer events.
  (await within(group).findByRole('button', { name: 'Power for Ubuntu PC' })).focus();
  await userEvent.keyboard('{Enter}');
};

/** Opens the Keep awake submenu of the open menu. */
const openKeepAwake = async () => {
  const item = await screen.findByText('Keep awake');
  // The menu takes focus when it opens; the submenu opens on ArrowRight once it has.
  await waitFor(() => expect(document.activeElement?.closest('[role=menu]')).not.toBeNull());
  item.focus();
  await userEvent.keyboard('{ArrowRight}');
};

describe('the power menu', () => {
  it('Turn on calls power.turnOn', async () => {
    const { group, server } = await start({ off: true });
    await waitFor(() => expect(within(group).getByText('Off')).toBeTruthy());
    await openMenu(group);
    await userEvent.click(await screen.findByText('Turn on'));
    await waitFor(() => expect(server.calls('power.turnOn')).toHaveLength(1));
    expect(server.calls('power.turnOn')[0]!.params).toEqual({ machineId: M1 });
  });

  it('Shut down now calls power.shutdown {force:false}', async () => {
    const { group, remote } = await start();
    await openMenu(group);
    await userEvent.click(await screen.findByText('Shut down now'));
    await waitFor(() => expect(remote.calls('power.shutdown')).toHaveLength(1));
    expect(remote.calls('power.shutdown')[0]!.params).toEqual({ force: false });
  });

  it('Keep awake, For 1 hour sends power.keepAwake {mode:until, until: now+3600000}', async () => {
    const { group, remote } = await start();
    await openMenu(group);
    const before = Date.now();
    await openKeepAwake();
    await userEvent.click(await screen.findByText('For 1 hour'));
    await waitFor(() => expect(remote.calls('power.keepAwake')).toHaveLength(1));
    const p = remote.calls('power.keepAwake')[0]!.params as { mode: string; until: number };
    expect(p.mode).toBe('until');
    expect(p.until).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(p.until).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  it('offers Stop keeping awake only while keep awake is on', async () => {
    const { group } = await start({
      status: () => status({ keepAwake: { mode: 'always', until: null } }),
    });
    await openMenu(group);
    await openKeepAwake();
    expect(await screen.findByText('Stop keeping awake')).toBeTruthy();
  });

  it('an off machine shows the placeholder and no project rows', async () => {
    const { group } = await start({ off: true });
    await waitFor(() => expect(within(group).getByText('Off')).toBeTruthy());
    expect(within(group).getByText("Its chats appear once it's on.")).toBeTruthy();
    expect(within(group).queryByRole('button', { name: /infra/i })).toBeNull();
    expect(within(group).queryByText('No projects yet.')).toBeNull();
  });

  it('title shows Shuts down in 42 min', async () => {
    const { group } = await start({
      status: () => status({ shutsDownAt: Date.now() + 42 * 60_000 + 20_000 }),
    });
    await waitFor(() =>
      expect(within(group).getByText('On').getAttribute('title')).toBe('Shuts down in 42 min'),
    );
  });

  it('title says Kept awake with keep awake always on', async () => {
    const { group } = await start({
      status: () => status({ keepAwake: { mode: 'always', until: null } }),
    });
    await waitFor(() =>
      expect(within(group).getByText('On').getAttribute('title')).toBe('Kept awake'),
    );
  });

  it('shows why turning on failed', async () => {
    const { group, server } = await start({ off: true });
    server.handlers['power.turnOn'] = () => {
      throw new RpcFail(POWER_ERRORS.unreachable, 'no answer');
    };
    await waitFor(() => expect(within(group).getByText('Off')).toBeTruthy());
    await openMenu(group);
    await userEvent.click(await screen.findByText('Turn on'));
    await waitFor(() => expect(within(group).getByRole('status').textContent).not.toBe(''));
  });

  it('no â» without power config', async () => {
    const { group } = await start({ power: false });
    expect(within(group).getByText('On')).toBeTruthy();
    expect(within(group).queryByRole('button', { name: /^Power for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Power for This PC' })).toBeNull();
  });
});
