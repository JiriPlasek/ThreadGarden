import { settingsDefaults } from '@threadgarden/protocol';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PhoneUpdateNotice from '../../src/lib/components/phone/PhoneUpdateNotice.svelte';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import { appVersion } from '../../src/lib/native';
import { setupTwoMachines } from '../layout/harness';
import { RpcFail } from '../service/fake-ws';

const native = vi.hoisted(() => {
  const state = { connected: true, batteryExempt: false, notificationsAllowed: true };
  return {
    state,
    openExternal: vi.fn(async (url: string) => /^https:/.test(url)),
    keepAlive: {
      status: vi.fn(async () => ({ ...state })),
      requestBatteryExemption: vi.fn(async () => {}),
      disconnect: vi.fn(async () => void (state.connected = false)),
      connect: vi.fn(async () => void (state.connected = true)),
    },
  };
});
vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  isPhone: true,
  openExternal: native.openExternal,
  keepAlive: native.keepAlive,
}));

const APK =
  'https://github.com/JiriPlasek/ThreadGarden/releases/download/v9.9.9/threadgarden-9.9.9.apk';

afterEach(() => {
  native.openExternal.mockClear();
  native.state.connected = true;
  native.state.batteryExempt = false;
});

const withLatest = (latest: () => unknown) =>
  setupTwoMachines({ configure: (s) => (s.handlers['update.latest'] = latest) });

describe('the update notice on the phone', () => {
  it("an older app shows the notice, and Download opens the release's APK", async () => {
    const env = await withLatest(() => ({ version: '9.9.9', url: APK }));
    render(PhoneUpdateNotice, { context: env.context });
    const notice = await screen.findByRole('status');
    await waitFor(() => expect(notice.textContent).toContain('Threadgarden 9.9.9 is available'));
    await userEvent.click(within(notice).getByRole('button', { name: 'Download' }));
    expect(native.openExternal).toHaveBeenCalledWith(APK);
  });

  it('0.10.0 is newer than this app at 0.9.0 (numbers, not text)', async () => {
    expect(appVersion).toBe('0.9.0');
    const env = await withLatest(() => ({ version: '0.10.0', url: APK }));
    render(PhoneUpdateNotice, { context: env.context });
    const notice = await screen.findByRole('status');
    await waitFor(() => expect(notice.textContent).toContain('Threadgarden 0.10.0 is available'));
  });

  it('the same version shows nothing, and a failed check says nothing', async () => {
    const same = await withLatest(() => ({ version: appVersion, url: APK }));
    const { unmount } = render(PhoneUpdateNotice, { context: same.context });
    await waitFor(() => expect(same.server.calls('update.latest')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/is available/)).toBeNull();
    unmount();

    const failed = await withLatest(() => {
      throw new RpcFail('UNREACHABLE', 'GitHub did not answer');
    });
    render(PhoneUpdateNotice, { context: failed.context });
    await waitFor(() => expect(failed.server.calls('update.latest')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/is available|GitHub|could not/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a newer release without an APK shows nothing to download', async () => {
    const env = await withLatest(() => ({ version: '9.9.9' }));
    render(PhoneUpdateNotice, { context: env.context });
    await waitFor(() => expect(env.server.calls('update.latest')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });
});

describe("the phone's Settings", () => {
  it("Settings shows Disconnect, the battery exemption's state, and this app's version", async () => {
    const env = await setupTwoMachines({
      configure: (s) => (s.handlers['settings.get'] = () => settingsDefaults),
    });
    render(SettingsDialog, { context: env.context });
    env.app.interaction.settingsOpen = true;
    const dialog = await screen.findByRole('dialog', { name: /^settings$/i });
    const phone = await within(dialog).findByRole('region', { name: 'This phone' });
    expect(within(phone).getByText(`Threadgarden ${appVersion}`)).toBeTruthy();
    expect(await within(phone).findByText(/Android may stop Threadgarden/)).toBeTruthy();
    await userEvent.click(within(phone).getByRole('button', { name: 'Allow in the background' }));
    expect(native.keepAlive.requestBatteryExemption).toHaveBeenCalled();

    await userEvent.click(within(phone).getByRole('button', { name: 'Disconnect' }));
    expect(native.keepAlive.disconnect).toHaveBeenCalled();
    expect(await within(phone).findByRole('button', { name: 'Connect' })).toBeTruthy();
    await userEvent.click(within(phone).getByRole('button', { name: 'Connect' }));
    expect(native.keepAlive.connect).toHaveBeenCalled();
    expect(await within(phone).findByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('with the exemption granted, it says so and asks nothing', async () => {
    native.state.batteryExempt = true;
    const env = await setupTwoMachines({
      configure: (s) => (s.handlers['settings.get'] = () => settingsDefaults),
    });
    render(SettingsDialog, { context: env.context });
    env.app.interaction.settingsOpen = true;
    const dialog = await screen.findByRole('dialog', { name: /^settings$/i });
    const phone = await within(dialog).findByRole('region', { name: 'This phone' });
    expect(await within(phone).findByText(/Allowed to run in the background/)).toBeTruthy();
    expect(within(phone).queryByRole('button', { name: 'Allow in the background' })).toBeNull();
  });

  it('shows each machine’s plug details there, with the hint when there are none', async () => {
    const env = await setupTwoMachines({
      configure: (s) => {
        s.handlers['settings.get'] = () => settingsDefaults;
        s.handlers['power.list'] = () => [];
      },
    });
    render(SettingsDialog, { context: env.context });
    env.app.interaction.settingsOpen = true;
    const dialog = await screen.findByRole('dialog', { name: /^settings$/i });
    const card = await within(dialog).findByRole('group', { name: 'Ubuntu PC' });
    expect(
      within(card).getByText("Enter this machine's plug details to turn it on from here"),
    ).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Plug details…' }));
    expect(env.app.interaction.plugFor).toBe('machine-1');
  });
});
