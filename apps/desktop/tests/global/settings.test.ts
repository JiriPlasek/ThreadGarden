import { settingsDefaults, type Settings } from '@pahub/protocol';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import { apiKey } from '../../src/lib/native';
import { applyTheme } from '../../src/lib/theme';
import { setup } from '../layout/harness';

const { setAutostart } = vi.hoisted(() => ({
  setAutostart: vi.fn(async (on: boolean) => void on),
}));
vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  setAutostart,
}));

/** A fake service that keeps settings like the real one. */
const withSettings = async (initial: Partial<Settings> = {}) => {
  let current: Settings = { ...settingsDefaults, ...initial };
  const env = await setup((server) => {
    server.handlers['settings.get'] = () => current;
    server.handlers['settings.set'] = (p) =>
      (current = { ...current, ...(p as Partial<Settings>) });
    server.handlers['auth.setApiKey'] = () => ({});
  });
  await env.app.settings.load();
  return { ...env, current: () => current };
};

const openDialog = async (env: Awaited<ReturnType<typeof withSettings>>) => {
  render(SettingsDialog, { context: env.context });
  env.app.interaction.settingsOpen = true;
  return screen.findByRole('dialog', { name: /settings/i });
};

describe('settings dialog', () => {
  afterEach(async () => {
    await apiKey.clear();
    setAutostart.mockClear();
  });

  it('api key saved to keychain and sent to service', async () => {
    const env = await withSettings();
    const dialog = await openDialog(env);
    const input = within(dialog).getByLabelText(/api key/i);
    expect(input.getAttribute('type')).toBe('password');
    await userEvent.type(input, 'sk-ant-test');
    await userEvent.click(within(dialog).getByRole('button', { name: /save key/i }));

    await waitFor(() =>
      expect(env.server.calls('auth.setApiKey').map((c) => c.params)).toEqual([
        { key: 'sk-ant-test' },
      ]),
    );
    await expect(apiKey.get()).resolves.toBe('sk-ant-test');
    // The key itself is never shown again.
    expect((input as HTMLInputElement).value).toBe('');
    expect(within(dialog).getByText(/a key is stored/i)).toBeTruthy();
  });

  it('removing the key clears the keychain and the service', async () => {
    await apiKey.set('sk-old');
    const env = await withSettings();
    const dialog = await openDialog(env);
    await userEvent.click(await within(dialog).findByRole('button', { name: /remove key/i }));
    await waitFor(() =>
      expect(env.server.calls('auth.setApiKey').at(-1)!.params).toEqual({ key: null }),
    );
    await expect(apiKey.get()).resolves.toBeNull();
  });

  it('a stored key is sent right after hello and after every reconnect', async () => {
    await apiKey.set('sk-stored');
    const env = await withSettings();
    await waitFor(() => expect(env.server.calls('auth.setApiKey')).toHaveLength(1));
    const helloAt = env.server.sent.findIndex((s) => s.method === 'hello');
    const keyAt = env.server.sent.findIndex((s) => s.method === 'auth.setApiKey');
    expect(keyAt).toBeGreaterThan(helloAt);
    expect(env.server.calls('auth.setApiKey')[0]!.params).toEqual({ key: 'sk-stored' });

    env.server.drop();
    await waitFor(() => expect(env.server.calls('auth.setApiKey')).toHaveLength(2), {
      timeout: 3000,
    });
  });

  it('saves every setting and validates idle minutes (0–1440)', async () => {
    const env = await withSettings();
    const dialog = await openDialog(env);
    const idle = within(dialog).getByLabelText(/idle/i);
    const save = within(dialog).getByRole('button', { name: /^save$/i });

    await userEvent.clear(idle);
    await userEvent.type(idle, '2000');
    expect(within(dialog).getByText(/0 to 1440/i)).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await userEvent.clear(idle);
    await userEvent.type(idle, '30');
    await userEvent.click(within(dialog).getByLabelText(/notifications/i));
    await userEvent.selectOptions(within(dialog).getByLabelText(/theme/i), 'dark');
    await userEvent.click(within(dialog).getByLabelText(/start on login/i));
    await userEvent.type(within(dialog).getByLabelText(/claude code executable/i), '/opt/claude');
    await userEvent.click(save);

    await waitFor(() => expect(env.server.calls('settings.set')).toHaveLength(1));
    expect(env.server.calls('settings.set')[0]!.params).toEqual({
      idleReclaimMinutes: 30,
      notifications: false,
      theme: 'dark',
      startOnLogin: true,
      claudePath: '/opt/claude',
    });
    expect(setAutostart).toHaveBeenCalledWith(true);
    expect(env.app.settings.value.theme).toBe('dark');
    // A new Claude Code path is looked up again by the service.
    await waitFor(() => expect(env.server.calls('system.status').length).toBeGreaterThan(1));
  });

  it('"Notify when a chat finishes" is on by default and can be turned off', async () => {
    const env = await withSettings();
    const dialog = await openDialog(env);
    const toggle = within(dialog).getByLabelText(
      /notify when a chat finishes/i,
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await userEvent.click(toggle);
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(env.server.calls('settings.set')).toHaveLength(1));
    expect(env.server.calls('settings.set')[0]!.params).toEqual({ notifyOnFinish: false });
    expect(env.app.settings.value.notifyOnFinish).toBe(false);
  });

  it('shows system info: Claude Code, external sessions and indexing', async () => {
    const env = await withSettings();
    env.server.handlers['system.status'] = () => ({
      claude: { found: true, path: '/usr/bin/claude', version: '2.1.314' },
      externalAvailable: false,
      indexing: { done: 3, total: 10 },
    });
    const dialog = await openDialog(env);
    expect(await within(dialog).findByText(/external sessions are unavailable/i)).toBeTruthy();
    expect(within(dialog).getByText('/usr/bin/claude')).toBeTruthy();
    expect(within(dialog).getByText(/2\.1\.314/)).toBeTruthy();
    expect(within(dialog).getByText(/3 of 10/)).toBeTruthy();
  });
});

describe('theme', () => {
  it('theme dark sets data-theme', () => {
    const root = document.createElement('html');
    const listeners = new Set<() => void>();
    const media = {
      matches: false,
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    } as unknown as MediaQueryList;

    let stop = applyTheme('dark', root, media);
    expect(root.dataset.theme).toBe('dark');
    stop();
    stop = applyTheme('light', root, media);
    expect(root.dataset.theme).toBe('light');
    stop();

    // "system" follows the OS preference live.
    stop = applyTheme('system', root, media);
    expect(root.dataset.theme).toBe('light');
    (media as { matches: boolean }).matches = true;
    for (const cb of listeners) cb();
    expect(root.dataset.theme).toBe('dark');
    stop();
    expect(listeners.size).toBe(0);
  });
});
