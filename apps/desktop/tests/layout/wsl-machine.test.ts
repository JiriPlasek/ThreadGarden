import {
  POWER_CAPABILITY,
  SIGNED_IN,
  type MachinePowerStatus,
  type PowerConfig,
} from '@threadgarden/protocol';
import { cleanup, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import type { AppState } from '../../src/lib/state/context';
import type { FakeServer } from '../service/fake-ws';
import { M1, setupTwoMachines } from './harness';

vi.setConfig({ testTimeout: 15_000 });

const CONFIG: PowerConfig = {
  kind: 'tasmota-plug',
  address: '192.168.1.9',
  device: null,
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

/**
 * M1 ("Ubuntu PC") with power control; `wsl` makes it a worker in WSL. Its
 * `power.shutdown` answers SIGNED_IN, while `signedIn` holds, to a call without
 * `despiteSignedIn`.
 */
const start = async (o: { wsl?: boolean; signedIn?: boolean } = {}) => {
  const env = await setupTwoMachines({
    m1Capabilities: ['remote', POWER_CAPABILITY],
    ...(o.wsl ? { m1Host: 'wsl' as const } : {}),
    powerPasswords: { [M1]: 'pw' },
    configure: (s: FakeServer) => {
      s.handlers['power.list'] = () => [{ machineId: M1, config: CONFIG }];
      s.handlers['power.reading'] = () => ({ on: true, watts: 60, at: Date.now() });
      s.handlers['power.unlock'] = () => ({});
      s.handlers['power.noteMeasurement'] = () => ({});
    },
    configureRemote: (s: FakeServer) => {
      s.handlers['power.status'] = () => status();
      s.handlers['power.adopt'] = () => ({});
      s.handlers['power.shutdown'] = (p: unknown) =>
        o.signedIn && !(p as { despiteSignedIn?: boolean }).despiteSignedIn
          ? status({ problem: SIGNED_IN })
          : status({ phase: 'shuttingDown' });
    },
  });
  apps.push(env.app);
  return env;
};

const card = async (env: Awaited<ReturnType<typeof start>>) => {
  render(SettingsDialog, { context: env.context });
  env.app.interaction.settingsOpen = true;
  const settings = await screen.findByRole('dialog', { name: /^settings$/i });
  return within(settings).getByRole('group', { name: 'Ubuntu PC' });
};

const shutDownNow = async (env: Awaited<ReturnType<typeof start>>) => {
  render(PlacesColumn, { context: env.context });
  const group = await waitFor(() => screen.getByRole('group', { name: 'Ubuntu PC' }));
  // By keyboard: jsdom has no real pointer events.
  (await within(group).findByRole('button', { name: 'Power for Ubuntu PC' })).focus();
  await userEvent.keyboard('{Enter}');
  await userEvent.click(await screen.findByText('Shut down now'));
  return group;
};

describe('a Windows PC as a worker (WSL)', () => {
  it("a WSL machine's card says Windows (WSL)", async () => {
    const env = await start({ wsl: true });
    const c = await card(env);
    await waitFor(() =>
      expect(within(c).getByText('Threadgarden 0.1.0 · Windows (WSL)')).toBeTruthy(),
    );
  });

  it("a WSL machine's heading names it in its tooltip", async () => {
    const env = await start({ wsl: true });
    render(PlacesColumn, { context: env.context });
    const group = await waitFor(() => screen.getByRole('group', { name: 'Ubuntu PC' }));
    const toggle = within(group).getByRole('button', { name: 'Ubuntu PC' });
    expect(toggle.getAttribute('title')).toBe('Ubuntu PC · Windows (WSL)');
  });

  it('Shut down now on a machine where someone is signed in asks first, then forces', async () => {
    const env = await start({ wsl: true, signedIn: true });
    const group = await shutDownNow(env);
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText('Someone is signed in on Ubuntu PC. Shut it down anyway?'),
    ).toBeTruthy();
    // The line under the heading names the machine: "this PC" would read as the desktop.
    expect(within(group).getByRole('status').textContent?.trim()).toBe(
      'Someone is signed in on Ubuntu PC',
    );
    expect(env.remote.calls('power.shutdown').map((c) => c.params)).toEqual([{ force: false }]);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Shut down' }));
    await waitFor(() =>
      expect(env.remote.calls('power.shutdown').map((c) => c.params)).toEqual([
        { force: false },
        // force keeps its meaning (despite unpushed work): only the second confirm is added.
        { force: false, despiteSignedIn: true },
      ]),
    );
  });

  it('Cancel leaves a machine where someone is signed in running', async () => {
    const env = await start({ wsl: true, signedIn: true });
    await shutDownNow(env);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(env.remote.calls('power.shutdown')).toHaveLength(1);
  });

  it('a status clearing the signed-in problem closes the question without sending', async () => {
    const env = await start({ wsl: true, signedIn: true });
    await shutDownNow(env);
    await screen.findByRole('alertdialog');
    // The person signed out and the machine says so: the question no longer stands.
    env.remote.push('power.changed', status());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(env.app.power.signedInAsk(M1)).toBeNull();
    expect(env.remote.calls('power.shutdown')).toHaveLength(1);
  });

  it('a question on a machine that is shutting down by other means goes too', async () => {
    const env = await start({ wsl: true, signedIn: true });
    await shutDownNow(env);
    await screen.findByRole('alertdialog');
    env.remote.push('power.changed', status({ phase: 'shuttingDown', problem: SIGNED_IN }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(env.remote.calls('power.shutdown')).toHaveLength(1);
  });

  it("a removed machine's question is gone", async () => {
    const env = await start({ wsl: true, signedIn: true });
    await shutDownNow(env);
    await screen.findByRole('alertdialog');
    await env.app.machines.remove(M1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(env.app.power.signedInAsk(M1)).toBeNull();
    expect(env.remote.calls('power.shutdown')).toHaveLength(1);
  });

  it("an Ubuntu machine's card and shutdown are unchanged", async () => {
    const env = await start();
    const c = await card(env);
    await waitFor(() => expect(within(c).getByText('Threadgarden 0.1.0')).toBeTruthy());
    expect(within(c).queryByText(/Windows \(WSL\)/)).toBeNull();
    cleanup();

    const group = await shutDownNow(env);
    await waitFor(() => expect(env.remote.calls('power.shutdown')).toHaveLength(1));
    expect(env.remote.calls('power.shutdown')[0]!.params).toEqual({ force: false });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(
      within(group).getByRole('button', { name: 'Ubuntu PC' }).getAttribute('title'),
    ).toBeNull();
  });
});
