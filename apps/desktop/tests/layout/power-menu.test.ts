import {
  POWER_CAPABILITY,
  POWER_ERRORS,
  type MachinePowerStatus,
  type PowerConfig,
} from '@threadgarden/protocol';
import { cleanup, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import type { AppState } from '../../src/lib/state/context';
import { clockTime } from '../../src/lib/format/usage';
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
  o: {
    power?: boolean;
    off?: boolean;
    /** What the plug reads (default: the opposite of off). */
    plugOn?: boolean;
    link?: 'locked';
    status?: () => MachinePowerStatus;
    /** What the machine says it can do (default: power when configured). */
    capabilities?: string[];
  } = {},
) => {
  const withPower = o.power !== false;
  const env = await setupTwoMachines({
    m1Capabilities: o.capabilities ?? (withPower ? ['remote', POWER_CAPABILITY] : ['remote']),
    powerPasswords: { [M1]: 'pw' },
    waitForOn: !o.off,
    m1Status: o.link,
    configure: (s: FakeServer) => {
      s.handlers['power.list'] = () => (withPower ? [{ machineId: M1, config: CONFIG }] : []);
      s.handlers['power.reading'] = () => ({
        on: o.plugOn ?? !o.off,
        watts: (o.plugOn ?? !o.off) ? 60 : 0,
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

  it('asks first before shutting down a machine at work', async () => {
    const { group, remote } = await start({ status: () => status({ busy: true }) });
    const ask = async () => {
      await openMenu(group);
      await userEvent.click(await screen.findByText('Shut down now'));
      const dialog = await screen.findByRole('alertdialog');
      expect(
        within(dialog).getByText('Ubuntu PC is working on something. Shut it down anyway?'),
      ).toBeTruthy();
      return dialog;
    };
    await userEvent.click(within(await ask()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(remote.calls('power.shutdown')).toHaveLength(0);
    await userEvent.click(within(await ask()).getByRole('button', { name: 'Shut down' }));
    await waitFor(() => expect(remote.calls('power.shutdown')).toHaveLength(1));
    expect(remote.calls('power.shutdown')[0]!.params).toEqual({ force: false });
  });

  it('no ⏻ for a machine that says it has no power control, even with a stored switch', async () => {
    const { group } = await start({ capabilities: ['remote'] });
    expect(within(group).getByText('On')).toBeTruthy();
    expect(within(group).queryByRole('button', { name: 'Power for Ubuntu PC' })).toBeNull();
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

  it('shows why turning on failed, and clears it after a retry that works', async () => {
    const { group, server } = await start({ off: true });
    let ok = false;
    server.handlers['power.turnOn'] = () => {
      if (ok) return { cycled: false, waitMs: 0 };
      throw new RpcFail(POWER_ERRORS.unreachable, 'no answer');
    };
    await waitFor(() => expect(within(group).getByText('Off')).toBeTruthy());
    await openMenu(group);
    await userEvent.click(await screen.findByText('Turn on'));
    await waitFor(() =>
      expect(within(group).getByRole('status').textContent).toBe(
        "The power switch can't be reached.",
      ),
    );
    ok = true;
    await openMenu(group);
    await userEvent.click(await screen.findByText('Turn on'));
    await waitFor(() => expect(within(group).getByRole('status').textContent).toBe(''));
  });

  it('no ⏻ without power config', async () => {
    const { group } = await start({ power: false });
    expect(within(group).getByText('On')).toBeTruthy();
    expect(within(group).queryByRole('button', { name: /^Power for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Power for This PC' })).toBeNull();
  });

  it('Keep awake sends 4 hours, always and off', async () => {
    const send = async (label: string, over: Partial<MachinePowerStatus> = {}) => {
      const { group, remote } = await start({ status: () => status(over) });
      await openMenu(group);
      await openKeepAwake();
      await userEvent.click(await screen.findByText(label));
      await waitFor(() => expect(remote.calls('power.keepAwake')).toHaveLength(1));
      const before = Date.now();
      const p = remote.calls('power.keepAwake')[0]!.params as {
        mode: string;
        until: number | null;
      };
      cleanup();
      return { p, before };
    };
    const four = await send('For 4 hours');
    expect(four.p.mode).toBe('until');
    expect(four.p.until).toBeGreaterThan(four.before + 14_400_000 - 5_000);
    expect(four.p.until).toBeLessThanOrEqual(four.before + 14_400_000);
    expect((await send('Until I turn it off')).p).toEqual({ mode: 'always', until: null });
    expect(
      (await send('Stop keeping awake', { keepAwake: { mode: 'always', until: null } })).p,
    ).toEqual({ mode: 'off', until: null });
  });

  it('replaces Turn on with a disabled Starting… while the machine is being turned on', async () => {
    const { group, server } = await start({ off: true });
    await waitFor(() => expect(within(group).getByText('Off')).toBeTruthy());
    await openMenu(group);
    await userEvent.click(await screen.findByText('Turn on'));
    await waitFor(() => expect(server.calls('power.turnOn')).toHaveLength(1));
    await openMenu(group);
    const item = await screen.findByText('Starting…', { selector: '[role=menuitem]' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByText('Turn on')).toBeNull();
  });

  it('offers Turn on for an unreachable machine, but not Shut down', async () => {
    const { group } = await start({ off: true, plugOn: true });
    await waitFor(() => expect(within(group).getByText('Unreachable')).toBeTruthy());
    await openMenu(group);
    expect(await screen.findByText('Turn on')).toBeTruthy();
    expect(screen.queryByText('Shut down now')).toBeNull();
  });

  it('offers Shut down and Keep awake, but not Turn on, while the machine is on', async () => {
    const { group } = await start();
    await openMenu(group);
    expect(await screen.findByText('Shut down now')).toBeTruthy();
    expect(screen.queryByText('Turn on')).toBeNull();
  });

  it('says Shutting down… while the machine shuts down', async () => {
    const { group } = await start({ status: () => status({ phase: 'shuttingDown' }) });
    await waitFor(() => expect(within(group).getByText('Shutting down')).toBeTruthy());
    await openMenu(group);
    const item = await screen.findByText('Shutting down…', { selector: '[role=menuitem]' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByText('Turn on')).toBeNull();
    expect(screen.queryByText('Shut down now')).toBeNull();
  });

  it('names the state when nothing else can be done (locked link, plug on)', async () => {
    const { group } = await start({ link: 'locked' });
    await waitFor(() => expect(within(group).getByText('Needs attention')).toBeTruthy());
    await openMenu(group);
    const item = await screen.findByText('Needs attention', { selector: '[role=menuitem]' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByText('Turn on')).toBeNull();
  });

  it('offers Turn on for a locked link when the plug reads off', async () => {
    const { group } = await start({ link: 'locked', plugOn: false });
    await waitFor(() => expect(within(group).getByText('Needs attention')).toBeTruthy());
    await openMenu(group);
    expect(await screen.findByText('Turn on')).toBeTruthy();
  });

  it('title shows Kept awake until the time', async () => {
    const until = Date.now() + 2 * 3_600_000;
    const { group } = await start({
      status: () => status({ keepAwake: { mode: 'until', until } }),
    });
    await waitFor(() =>
      expect(within(group).getByText('On').getAttribute('title')).toBe(
        `Kept awake until ${clockTime(until)}`,
      ),
    );
  });

  it('counts down while it is shown', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const at = Date.now() + 42 * 60_000 + 20_000;
      const { group } = await start({ status: () => status({ shutsDownAt: at }) });
      const label = () => within(group).getByText('On').getAttribute('title');
      await waitFor(() => expect(label()).toBe('Shuts down in 42 min'));
      vi.advanceTimersByTime(5 * 60_000);
      await waitFor(() => expect(label()).toBe('Shuts down in 37 min'));
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the machine's problem under the heading, and clears it with the problem", async () => {
    const { group, remote } = await start();
    const note = "The switch didn't accept that password.";
    remote.push('power.changed', status({ problem: note }));
    await waitFor(() => expect(within(group).getByText(note)).toBeTruthy());
    remote.push('power.changed', status());
    await waitFor(() => expect(within(group).queryByText(note)).toBeNull());
  });
});
