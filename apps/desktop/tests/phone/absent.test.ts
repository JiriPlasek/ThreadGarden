import { settingsDefaults } from '@threadgarden/protocol';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AppShell from '../../src/lib/components/layout/AppShell.svelte';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import QuickSwitcher from '../../src/lib/components/QuickSwitcher.svelte';
import ServiceBanner from '../../src/lib/components/ServiceBanner.svelte';
import ServiceDialogs from '../../src/lib/components/ServiceDialogs.svelte';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import { LOCAL, M1, setupTwoMachines } from '../layout/harness';

const native = vi.hoisted(() => ({
  serviceConnection: vi.fn(async (): Promise<never> => {
    throw new Error('service-start-timeout: no service answered within 15 s');
  }),
  setAutostart: vi.fn(async (on: boolean) => void on),
  onTray: vi.fn(async () => () => {}),
  installKind: vi.fn(async () => 'appimage' as const),
  check: vi.fn(async () => null),
}));
vi.mock('../../src/lib/native', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/native')>();
  return {
    ...real,
    isPhone: true,
    serviceConnection: native.serviceConnection,
    setAutostart: native.setAutostart,
    onTray: native.onTray,
    updater: { ...real.updater, installKind: native.installKind, check: native.check },
  };
});

const usage = {
  windows: [{ key: 'five_hour', utilization: 0.4, resetsAt: Date.now() + 3_600_000 }],
  refused: [],
  account: { kind: 'login', email: 'someone@example.test' },
};

const start = () =>
  setupTwoMachines({
    configure: (s) => {
      Object.assign(s.handlers, {
        'settings.get': () => settingsDefaults,
        'settings.set': () => settingsDefaults,
        // As the core answers: there's no Claude Code on a phone.
        'system.status': () => ({
          claude: { found: false },
          externalAvailable: false,
          indexing: { done: 0, total: 0 },
        }),
        'usage.get': () => usage,
      });
    },
    configureRemote: (s) => (s.handlers['usage.get'] = () => usage),
  });

describe('desktop-only parts on the phone', () => {
  it('analytics, tray, autostart and desktop update are absent', async () => {
    // Desktop update: the app never asks the desktop updater.
    const { startApp } = await import('../../src/lib/state/app');
    await expect(startApp()).rejects.toThrow(/service-start-timeout/);
    expect(native.installKind).not.toHaveBeenCalled();
    expect(native.check).not.toHaveBeenCalled();

    const env = await start();
    await env.app.settings.load();

    // Analytics: not among the places, nor in the quick switcher.
    render(PlacesColumn, { context: env.context });
    await screen.findByRole('group', { name: 'Ubuntu PC' });
    expect(screen.queryByRole('button', { name: /analytics/i })).toBeNull();
    render(QuickSwitcher, { context: env.context });
    env.app.interaction.switcherOpen = true;
    const list = await screen.findByRole('listbox');
    const commands = within(list)
      .getAllByRole('option')
      .map((o) => o.querySelector('[data-label]')?.textContent?.trim());
    expect(commands).not.toContain('Analytics');

    // The tray's menu is never listened to.
    render(ServiceDialogs, { context: env.context });
    expect(native.onTray).not.toHaveBeenCalled();

    // Settings: no Start on login, no updater, nothing only This PC has.
    render(SettingsDialog, { context: env.context });
    env.app.interaction.settingsOpen = true;
    const dialog = await screen.findByRole('dialog', { name: /^settings$/i });
    expect(within(dialog).queryByLabelText(/start on login/i)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /check for updates/i })).toBeNull();
    expect(within(dialog).queryByRole('heading', { name: 'Updates' })).toBeNull();
    expect(within(dialog).queryByLabelText(/api key/i)).toBeNull();
    expect(within(dialog).queryByLabelText(/claude code executable/i)).toBeNull();
    expect(within(dialog).queryByRole('heading', { name: 'System' })).toBeNull();
    expect(within(dialog).queryByText(/^This PC · Threadgarden/)).toBeNull();
    // The paired machine's card is still there.
    expect(within(dialog).getByRole('group', { name: 'Ubuntu PC' })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));
    expect(native.setAutostart).not.toHaveBeenCalled();
  });

  it('no restart banner, no setup screen and no usage for This PC', async () => {
    const env = await start();
    env.app.connection.setVersions({
      serviceVersion: '0.1.0',
      appVersion: '0.2.0',
    });
    render(ServiceBanner, { context: env.context });
    expect(screen.queryByRole('button', { name: /restart service/i })).toBeNull();

    render(AppShell, { context: env.context });
    await waitFor(() => expect(env.app.interaction.status).not.toBeNull());
    expect(screen.queryByRole('region', { name: /set up claude code/i })).toBeNull();
    expect(screen.getAllByRole('navigation', { name: 'Places' }).length).toBeGreaterThan(0);

    // The local scope reads its usage too, but only the paired machine has an account.
    await waitFor(() => expect(env.app.usageAccounts.entries).toHaveLength(1));
    const [entry] = env.app.usageAccounts.entries;
    expect(entry!.machines.map((m) => m.machineId)).toEqual([M1]);
    expect(entry!.machines.map((m) => m.machineId)).not.toContain(LOCAL);
  });
});
