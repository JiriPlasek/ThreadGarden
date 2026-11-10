import {
  settingsDefaults,
  type Device,
  type PhoneAccess,
  type Settings,
} from '@threadgarden/protocol';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import { setup } from '../layout/harness';

const { setAutostart } = vi.hoisted(() => ({
  setAutostart: vi.fn(async (on: boolean) => void on),
}));
vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  setAutostart,
}));

const SETTING = 'Let my phone connect';
const HELP =
  "Your phone can use this PC's chats, on your private network. Windows may ask to allow it. After a restart, this PC is reachable once someone signs in.";

const device = (id: string, name: string, over: Partial<Device> = {}): Device => ({
  id,
  name,
  createdAt: Date.now() - 86_400_000,
  lastSeen: Date.now() - 60_000,
  ...over,
});

/** A fake service with phone access and paired devices kept like the real one. */
const start = async (
  o: {
    enabled?: boolean;
    devices?: Device[];
    codeTtlMs?: number;
    settings?: Partial<Settings>;
  } = {},
) => {
  let access: PhoneAccess = {
    enabled: o.enabled ?? false,
    addresses: ['192.168.1.20', '100.64.0.7'],
    port: 47380,
  };
  let devices = o.devices ?? [];
  let current: Settings = { ...settingsDefaults, ...o.settings };
  let codes = 0;
  const env = await setup((s) => {
    Object.assign(s.handlers, {
      'settings.get': () => current,
      'settings.set': (p: unknown) => (current = { ...current, ...(p as Partial<Settings>) }),
      'phoneAccess.get': () => access,
      'phoneAccess.set': (p: unknown) => {
        access = { ...access, enabled: (p as { enabled: boolean }).enabled };
        s.push('phoneAccess.changed', access);
        return access;
      },
      'pairing.create': () => {
        codes++;
        return {
          code: codes === 1 ? 'ABCD-EFGH-JKLM' : 'NPQR-STUV-WXYZ',
          expiresAt: Date.now() + (o.codeTtlMs ?? 300_000),
        };
      },
      'devices.list': () => devices,
      'devices.revoke': (p: unknown) => {
        devices = devices.filter((d) => d.id !== (p as { deviceId: string }).deviceId);
        return { revoked: true };
      },
    });
  });
  await env.app.settings.load();
  render(SettingsDialog, { context: env.context });
  env.app.interaction.settingsOpen = true;
  const dialog = await screen.findByRole('dialog', { name: /^settings$/i });
  const section = await within(dialog).findByRole('group', { name: SETTING });
  const toggle = within(section).getByRole('checkbox', { name: SETTING }) as HTMLInputElement;
  return { ...env, dialog, section, toggle, current: () => current, access: () => access };
};

describe('Settings → Let my phone connect', () => {
  afterEach(() => setAutostart.mockClear());

  it('off by default, with the help text', async () => {
    const { section, toggle } = await start();
    expect(toggle.checked).toBe(false);
    expect(within(section).getByText(HELP)).toBeTruthy();
    expect(within(section).queryByRole('button', { name: 'Show a pairing code' })).toBeNull();
    expect(within(section).queryByText(/192\.168\.1\.20/)).toBeNull();
  });

  it('on shows its addresses and Show a pairing code', async () => {
    const env = await start();
    await userEvent.click(env.toggle);
    await waitFor(() =>
      expect(env.server.calls('phoneAccess.set').map((c) => c.params)).toEqual([{ enabled: true }]),
    );
    expect(await within(env.section).findByText('192.168.1.20:47380')).toBeTruthy();
    expect(within(env.section).getByText('100.64.0.7:47380')).toBeTruthy();
    expect(within(env.section).getByRole('button', { name: 'Show a pairing code' })).toBeTruthy();
    expect(env.toggle.checked).toBe(true);
    // It isn't part of Save: it's on already, Save is not needed.
    expect(env.server.calls('settings.set')).toHaveLength(0);
  });

  it('a code shows as XXXX-XXXX-XXXX and expires', async () => {
    const env = await start({ enabled: true, codeTtlMs: 1_200 });
    await userEvent.click(
      await within(env.section).findByRole('button', { name: 'Show a pairing code' }),
    );
    const code = await within(env.section).findByText('ABCD-EFGH-JKLM');
    expect(code.textContent).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(within(env.section).getByText(/^Expires in /)).toBeTruthy();
    // Gone once it expires; a new one can be shown.
    await waitFor(() => expect(within(env.section).queryByText('ABCD-EFGH-JKLM')).toBeNull(), {
      timeout: 3_000,
    });
    expect(within(env.section).getByText('The code has expired.')).toBeTruthy();
    await userEvent.click(within(env.section).getByRole('button', { name: 'Show a pairing code' }));
    expect(await within(env.section).findByText('NPQR-STUV-WXYZ')).toBeTruthy();
  });

  it('paired devices list, and Remove revokes one', async () => {
    const env = await start({
      enabled: true,
      devices: [device('d1', 'Pixel'), device('d2', 'Tablet', { lastSeen: null })],
    });
    const list = await within(env.section).findByRole('list', { name: 'Paired devices' });
    expect(within(list).getByText('Pixel')).toBeTruthy();
    expect(within(list).getByText('Tablet')).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: 'Remove Pixel' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove Pixel?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(env.server.calls('devices.revoke').map((c) => c.params)).toEqual([{ deviceId: 'd1' }]),
    );
    await waitFor(() => expect(within(list).queryByText('Pixel')).toBeNull());
    expect(within(list).getByText('Tablet')).toBeTruthy();
  });

  it("on offers to start at sign-in, and doesn't turn it on by itself", async () => {
    const env = await start();
    await userEvent.click(env.toggle);
    const offer = await within(env.section).findByRole('button', { name: 'Start at sign-in' });
    expect(setAutostart).not.toHaveBeenCalled();
    expect(env.current().startOnLogin).toBe(false);
    await userEvent.click(offer);
    await waitFor(() => expect(setAutostart).toHaveBeenCalledWith(true));
    await waitFor(() => expect(env.current().startOnLogin).toBe(true));
    expect(within(env.section).queryByRole('button', { name: 'Start at sign-in' })).toBeNull();
    // Save afterwards keeps it on (the form follows).
    await userEvent.click(within(env.dialog).getByRole('button', { name: /^save$/i }));
    expect(env.current().startOnLogin).toBe(true);
    expect(setAutostart).not.toHaveBeenCalledWith(false);
  });

  it('with start on login already on, nothing is offered', async () => {
    const env = await start({ enabled: true, settings: { startOnLogin: true } });
    await within(env.section).findByRole('button', { name: 'Show a pairing code' });
    expect(within(env.section).queryByRole('button', { name: 'Start at sign-in' })).toBeNull();
  });

  it('off says the phone disconnects, and asks first when a phone is connected', async () => {
    // A paired phone: turning it off asks first.
    const env = await start({ enabled: true, devices: [device('d1', 'Pixel')] });
    await within(env.section).findByText('Pixel');
    await userEvent.click(env.toggle);
    const ask = await screen.findByRole('alertdialog', { name: 'Turn off Let my phone connect?' });
    expect(ask.textContent).toMatch(/disconnects/);
    expect(env.server.calls('phoneAccess.set')).toHaveLength(0);
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(env.toggle.checked).toBe(true);
    expect(env.server.calls('phoneAccess.set')).toHaveLength(0);
    await userEvent.click(env.toggle);
    const again = await screen.findByRole('alertdialog', {
      name: 'Turn off Let my phone connect?',
    });
    await userEvent.click(within(again).getByRole('button', { name: 'Turn off' }));
    await waitFor(() =>
      expect(env.server.calls('phoneAccess.set').map((c) => c.params)).toEqual([
        { enabled: false },
      ]),
    );
    await waitFor(() => expect(env.toggle.checked).toBe(false));
  });

  it('off with no phone paired turns off at once, and says the phone disconnects', async () => {
    const env = await start({ enabled: true });
    await within(env.section).findByRole('button', { name: 'Show a pairing code' });
    expect(within(env.section).getByText(/Turning it off disconnects your phone/)).toBeTruthy();
    await userEvent.click(env.toggle);
    await waitFor(() =>
      expect(env.server.calls('phoneAccess.set').map((c) => c.params)).toEqual([
        { enabled: false },
      ]),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('follows a change made elsewhere', async () => {
    const env = await start();
    env.server.push('phoneAccess.changed', { enabled: true, addresses: ['10.0.0.4'], port: 47380 });
    await waitFor(() => expect(env.toggle.checked).toBe(true));
    expect(await within(env.section).findByText('10.0.0.4:47380')).toBeTruthy();
  });
});
