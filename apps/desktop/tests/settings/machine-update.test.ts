import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import {
  PROTOCOL_VERSION,
  UPDATE_CAPABILITY,
  type SkippedStep,
  type UpdateFailure,
  type UpdateStatus,
} from '@threadgarden/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppShell from '../../src/lib/components/layout/AppShell.svelte';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import * as native from '../../src/lib/native';
import type { AppState } from '../../src/lib/state/context';
import { M1, machineInfo, setupTwoMachines } from '../layout/harness';

vi.setConfig({ testTimeout: 20_000 });

const GUIDE =
  'https://github.com/JiriPlasek/ThreadGarden/blob/main/docs/remote-machines.md#upgrading';

let apps: AppState[] = [];
afterEach(() => {
  for (const app of apps) app.machineUpdates.dispose();
  apps = [];
  vi.restoreAllMocks();
});

const start = async (
  o: {
    version?: string;
    latest?: string;
    canUpdate?: boolean;
    status?: UpdateStatus;
    busy?: number;
  } = {},
) => {
  const version = o.version ?? '0.7.0';
  const calls = { start: [] as unknown[] };
  /** What the machine says about its update; the poll reads it too. */
  const say = { status: o.status ?? ({ state: 'idle' } as UpdateStatus) };
  const env = await setupTwoMachines({
    configure: (s) => {
      s.handlers['update.latest'] = () => ({ version: o.latest ?? '0.7.1' });
    },
    configureRemote: (s) => {
      s.handlers['hello'] = () => ({
        serviceVersion: version,
        protocolVersion: PROTOCOL_VERSION,
        machine: machineInfo(
          M1,
          'ubuntu-pc',
          o.canUpdate === false ? ['remote'] : ['remote', UPDATE_CAPABILITY],
        ),
      });
      s.handlers['update.status'] = () => say.status;
      s.handlers['update.start'] = (p: unknown) => {
        calls.start.push(p);
        const force = (p as { force: boolean }).force;
        return o.busy && !force ? { started: false, busy: o.busy } : { started: true };
      };
    },
  });
  apps.push(env.app);
  const { app } = env;
  app.machineUpdates.init({ api: env.client, machines: app.machines, power: app.power });
  await app.machineUpdates.refresh({ force: true });
  await vi.waitFor(() => expect(app.machines.get(M1)?.version).toBe(version));
  return { ...env, calls, say };
};
type Env = Awaited<ReturnType<typeof start>>;

const openSettings = async (env: Pick<Env, 'app' | 'context'>) => {
  render(SettingsDialog, { context: env.context });
  env.app.interaction.settingsOpen = true;
  const dialog = await screen.findByRole('dialog', { name: /^settings$/i });
  return within(within(dialog).getByRole('group', { name: 'Ubuntu PC' }));
};

const updateButton = /^Update to 0\.7\.1/;

describe('Settings → Machines → updating', () => {
  it("shows This PC · Threadgarden <appVersion> and the machine's version", async () => {
    const env = await start();
    const card = await openSettings(env);
    expect(screen.getByText(`This PC · Threadgarden ${native.appVersion}`)).toBeTruthy();
    expect(card.getByText('Threadgarden 0.7.0')).toBeTruthy();
    expect(card.getByText('· 0.7.1 available')).toBeTruthy();
  });

  it('shows no version line for a machine whose version is not known', async () => {
    const env = await start();
    env.app.machines.get(M1)!.version = null;
    const card = await openSettings(env);
    expect(card.queryByText(/Threadgarden/)).toBeNull();
    expect(card.queryByText(/null/)).toBeNull();
  });

  it('Update to 0.7.1 appears only when behind', async () => {
    const behind = await start();
    const card = await openSettings(behind);
    expect(card.getByRole('button', { name: updateButton })).toBeTruthy();
  });

  it('has no Update button when the machine is current', async () => {
    const env = await start({ version: '0.7.1' });
    const card = await openSettings(env);
    expect(card.getByText('Threadgarden 0.7.1')).toBeTruthy();
    expect(card.queryByRole('button', { name: /Update to/ })).toBeNull();
    expect(card.queryByText(/available/)).toBeNull();
  });

  it('opening Settings asks for the latest release', async () => {
    const env = await start();
    const spy = vi.spyOn(env.app.machineUpdates, 'refresh');
    await openSettings(env);
    expect(spy).toHaveBeenCalled();
  });

  it('an idle machine starts at once, without a prompt', async () => {
    const env = await start();
    const card = await openSettings(env);
    await userEvent.click(card.getByRole('button', { name: updateButton }));
    await waitFor(() => expect(env.calls.start).toEqual([{ version: '0.7.1', force: false }]));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('busy asks first with the count and Update anyway', async () => {
    const env = await start({ busy: 2 });
    const card = await openSettings(env);
    await userEvent.click(card.getByRole('button', { name: updateButton }));
    const prompt = await screen.findByRole('alertdialog', { name: 'Update Ubuntu PC now?' });
    expect(
      within(prompt).getByText(
        'Claude is working in 2 chats on Ubuntu PC. Updating restarts Threadgarden there and stops them.',
      ),
    ).toBeTruthy();
    expect(within(prompt).queryByText(/This PC has an update too/)).toBeNull();
    await userEvent.click(within(prompt).getByRole('button', { name: 'Update anyway' }));
    await waitFor(() =>
      expect(env.calls.start).toEqual([
        { version: '0.7.1', force: false },
        { version: '0.7.1', force: true },
      ]),
    );
  });

  it('says 1 chat in the singular', async () => {
    const env = await start({ busy: 1 });
    const card = await openSettings(env);
    await userEvent.click(card.getByRole('button', { name: updateButton }));
    const prompt = await screen.findByRole('alertdialog');
    expect(within(prompt).getByText(/working in 1 chat on Ubuntu PC\./)).toBeTruthy();
  });

  it("This PC's own update adds its line to the prompt", async () => {
    const env = await start({ busy: 2 });
    env.app.updates.available = { version: '9.9.9', notes: null };
    const card = await openSettings(env);
    await userEvent.click(card.getByRole('button', { name: updateButton }));
    const prompt = await screen.findByRole('alertdialog');
    expect(
      within(prompt).getByText(
        'This PC has an update too; install it as well so they keep talking.',
      ),
    ).toBeTruthy();
  });

  it('stages show in order, then Threadgarden 0.7.1 ✓', async () => {
    const env = await start();
    env.say.status = { state: 'running', version: '0.7.1', from: '0.7.0', stage: 'downloading' };
    const card = await openSettings(env);
    await userEvent.click(card.getByRole('button', { name: updateButton }));
    await card.findByText('Downloading 0.7.1…');
    expect(card.queryByRole('button', { name: /Update to/ })).toBeNull();
    const say = (status: UpdateStatus) => {
      env.say.status = status;
      env.remote.push('update.progress', status);
    };
    const running = (stage: 'installing' | 'restarting'): UpdateStatus => ({
      state: 'running',
      version: '0.7.1',
      from: '0.7.0',
      stage,
    });
    say(running('installing'));
    await card.findByText('Installing…');
    say(running('restarting'));
    await card.findByText('Restarting…');
    env.app.machines.get(M1)!.version = '0.7.1';
    say({ state: 'done', version: '0.7.1', from: '0.7.0', skipped: [] });
    await card.findByText('Threadgarden 0.7.1 ✓');
  });

  it('Downloading names the running update, not the latest release', async () => {
    const env = await start({
      latest: '0.7.2',
      status: { state: 'running', version: '0.7.1', from: '0.7.0', stage: 'downloading' },
    });
    const card = await openSettings(env);
    await card.findByText('Downloading 0.7.1…');
    expect(card.queryByText('Downloading 0.7.2…')).toBeNull();
  });

  it('Downloading still names it while the latest release is not known', async () => {
    // A desktop restarted mid-download: it hears of the update before GitHub answers.
    const env = await start({
      status: { state: 'running', version: '0.7.1', from: '0.7.0', stage: 'downloading' },
    });
    env.app.machineUpdates.latest = null;
    const card = await openSettings(env);
    await card.findByText('Downloading 0.7.1…');
    expect(card.queryByText(/null/)).toBeNull();
  });

  it('Downloading follows the version the machine says it is updating to', async () => {
    const env = await start();
    env.say.status = { state: 'running', version: '0.7.1', from: '0.7.0', stage: 'downloading' };
    const card = await openSettings(env);
    await userEvent.click(card.getByRole('button', { name: updateButton }));
    await card.findByText('Downloading 0.7.1…');
    // Another desktop's update, to a newer one, is what actually runs there.
    const other: UpdateStatus = {
      state: 'running',
      version: '0.7.2',
      from: '0.7.0',
      stage: 'downloading',
    };
    env.say.status = other;
    env.remote.push('update.progress', other);
    await card.findByText('Downloading 0.7.2…');
  });

  const failures: [UpdateFailure, string | undefined, string][] = [
    ['download', undefined, "Couldn't download 0.7.1 from GitHub"],
    ['checksum', undefined, "The download's checksum didn't match"],
    ['unpack', undefined, 'The download was damaged'],
    ['install', undefined, 'Installing 0.7.1 failed; Ubuntu PC is back on 0.7.0'],
    ['start', undefined, "0.7.1 didn't start; Ubuntu PC is back on 0.7.0"],
    ['start', 'Ubuntu PC never came back.', 'Ubuntu PC never came back.'],
  ];
  it.each(failures)('failure %s (detail %s) shows its line', async (reason, detail, line) => {
    const env = await start({
      status: { state: 'failed', version: '0.7.1', from: '0.7.0', reason, detail },
    });
    const card = await openSettings(env);
    expect(await card.findByText(line)).toBeTruthy();
    if (detail) expect(card.queryByText(/is back on/)).toBeNull();
  });

  const notes: [SkippedStep, string][] = [
    [
      'polkit',
      "Updated. Idle shutdown can't power Ubuntu PC off until you run ~/.local/share/threadgarden-headless/current/install.sh once over SSH.",
    ],
    [
      'linger',
      "Updated. Threadgarden won't start at boot on Ubuntu PC until you run ~/.local/share/threadgarden-headless/current/install.sh once over SSH.",
    ],
  ];
  it.each(notes)('a skipped %s step shows its note', async (step, note) => {
    const env = await start({
      version: '0.7.1',
      status: { state: 'done', version: '0.7.1', from: '0.7.0', skipped: [step] },
    });
    const card = await openSettings(env);
    expect(await card.findByText('Threadgarden 0.7.1 ✓')).toBeTruthy();
    expect(card.getByText(note)).toBeTruthy();
  });

  it('off without power control: disabled with Turn it on to update', async () => {
    const env = await start();
    env.app.machines.get(M1)!.status = 'unreachable';
    const card = await openSettings(env);
    expect((card.getByRole('button', { name: updateButton }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(card.getByText('Turn it on to update')).toBeTruthy();
  });

  it('an Off machine with power control shows an enabled Update', async () => {
    const env = await start();
    env.app.machines.get(M1)!.status = 'unreachable';
    // What power control makes of a machine whose plug reads off.
    env.app.machines.deriveWith(() => 'off');
    const card = await openSettings(env);
    expect((card.getByRole('button', { name: updateButton }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(card.queryByText('Turn it on to update')).toBeNull();
  });

  // jsdom cannot measure layout: the classes are asserted, the real check is by eye.
  it('long machine names wrap instead of widening Settings', async () => {
    const env = await start({
      status: { state: 'failed', version: '0.7.1', from: '0.7.0', reason: 'install' },
      busy: 1,
    });
    const card = await openSettings(env);
    const line = await card.findByText(/Installing 0\.7\.1 failed/);
    expect(line.className).toContain('break-words');
    expect(line.parentElement!.className).toContain('min-w-0');
    expect(card.getByText('Threadgarden 0.7.0').parentElement!.className).toContain('break-words');
    expect(line.closest('[role="group"]')!.className).toContain('min-w-0');
    await userEvent.click(card.getByRole('button', { name: updateButton }));
    const prompt = await screen.findByRole('alertdialog');
    expect(within(prompt).getByText(/working in 1 chat/).className).toContain('break-words');
  });

  it('an Off machine shows its remembered version', async () => {
    const env = await start();
    env.app.machines.get(M1)!.status = 'unreachable';
    const card = await openSettings(env);
    expect(card.getByText('Threadgarden 0.7.0')).toBeTruthy();
  });

  it('too old: Update it over SSH this once links the guide', async () => {
    const env = await start({ canUpdate: false });
    const open = vi.spyOn(native, 'openExternal').mockResolvedValue(true);
    const card = await openSettings(env);
    expect(card.queryByRole('button', { name: /Update to/ })).toBeNull();
    const link = card.getByRole('link', { name: 'Update it over SSH this once' });
    expect(link.getAttribute('href')).toBe(GUIDE);
    await userEvent.click(link);
    expect(open).toHaveBeenCalledWith(GUIDE);
  });
});

describe('the dot on Settings', () => {
  const dot = (b: HTMLElement) => b.querySelector('span[aria-hidden="true"]');

  it('shows on the places column only while a machine is behind', async () => {
    const env = await start();
    render(PlacesColumn, { context: env.context });
    const button = screen.getByRole('button', { name: 'Settings (a machine update is available)' });
    expect(dot(button)).toBeTruthy();
    env.app.machines.get(M1)!.version = '0.7.1';
    const quiet = await screen.findByRole('button', { name: 'Settings' });
    expect(dot(quiet)).toBeNull();
  });

  it('shows on the collapsed rail too', async () => {
    const env = await start();
    await env.app.settings.setCollapsed('places', true);
    render(AppShell, { context: env.context });
    const buttons = await screen.findAllByRole('button', { name: /^Settings/ });
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Settings (a machine update is available)',
    ]);
    expect(dot(buttons[0]!)).toBeTruthy();
  });

  it('is absent when nothing is behind', async () => {
    const env = await start({ version: '0.7.1' });
    render(PlacesColumn, { context: env.context });
    expect(dot(screen.getByRole('button', { name: 'Settings' }))).toBeNull();
  });
});
