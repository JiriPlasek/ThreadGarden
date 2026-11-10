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
import { RpcFail } from '../service/fake-ws';

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
    /** `devices.list` fails from this call on (1: the first). */
    listFailsFrom?: number;
  } = {},
) => {
  const order: string[] = [];
  let lists = 0;
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
      'settings.set': (p: unknown) => {
        order.push(`settings.set ${JSON.stringify(p)}`);
        return (current = { ...current, ...(p as Partial<Settings>) });
      },
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
      'devices.list': () => {
        lists++;
        if (o.listFailsFrom !== undefined && lists >= o.listFailsFrom)
          throw new RpcFail('INTERNAL', 'no list');
        return devices;
      },
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
  return {
    ...env,
    dialog,
    section,
    toggle,
    order,
    current: () => current,
    access: () => access,
    /** A phone pairs (as `threadgarden` would, with no event to say so). */
    pair: (d: Device) => void (devices = [...devices, d]),
  };
};

describe('Settings → Let my phone connect', () => {
  afterEach(() => {
    setAutostart.mockReset();
    setAutostart.mockImplementation(async (on: boolean) => void on);
  });

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

  it('a phone paired while a code is shown appears in the list', async () => {
    const env = await start({ enabled: true });
    await userEvent.click(
      await within(env.section).findByRole('button', { name: 'Show a pairing code' }),
    );
    await within(env.section).findByText('ABCD-EFGH-JKLM');
    env.pair(device('d9', 'Pixel'));
    // Listed while the code is live, with no event to say so.
    expect(await within(env.section).findByText('Pixel', {}, { timeout: 6_000 })).toBeTruthy();
  }, 10_000);

  it('turning off asks about a phone paired since the list was read', async () => {
    const env = await start({ enabled: true });
    await within(env.section).findByRole('button', { name: 'Show a pairing code' });
    env.pair(device('d9', 'Pixel'));
    await userEvent.click(env.toggle);
    expect(
      await screen.findByRole('alertdialog', { name: 'Turn off Let my phone connect?' }),
    ).toBeTruthy();
    expect(env.server.calls('phoneAccess.set')).toHaveLength(0);
  });

  it('the code and when it expires are announced, without the countdown', async () => {
    const env = await start({ enabled: true });
    await userEvent.click(
      await within(env.section).findByRole('button', { name: 'Show a pairing code' }),
    );
    const status = await within(env.section).findByRole('status');
    await waitFor(() => expect(status.textContent).toContain('ABCD-EFGH-JKLM'));
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toMatch(/Expires at \d{1,2}:\d{2}/);
    const said = status.textContent;
    await new Promise((r) => setTimeout(r, 1_300));
    expect(status.textContent).toBe(said);
  });

  it('a list that fails keeps the phones it had', async () => {
    const env = await start({ enabled: true, devices: [device('d1', 'Pixel')], listFailsFrom: 2 });
    await within(env.section).findByText('Pixel');
    await userEvent.click(within(env.section).getByRole('button', { name: 'Show a pairing code' }));
    await waitFor(() => expect(env.server.calls('devices.list').length).toBeGreaterThan(1));
    expect(within(env.section).getByText('Pixel')).toBeTruthy();
  });

  it('with the paired phones unknown, turning off asks', async () => {
    const env = await start({ enabled: true, listFailsFrom: 1 });
    await within(env.section).findByRole('button', { name: 'Show a pairing code' });
    await userEvent.click(env.toggle);
    expect(
      await screen.findByRole('alertdialog', { name: 'Turn off Let my phone connect?' }),
    ).toBeTruthy();
  });

  it('Start at sign-in saves the setting first, and undoes it when autostart fails', async () => {
    const env = await start({ enabled: true });
    setAutostart.mockImplementation(async () => {
      env.order.push('setAutostart');
      throw new Error('autostart refused');
    });
    await userEvent.click(
      await within(env.section).findByRole('button', { name: 'Start at sign-in' }),
    );
    await within(env.section).findByText('autostart refused');
    expect(env.order).toEqual([
      'settings.set {"startOnLogin":true}',
      'setAutostart',
      'settings.set {"startOnLogin":false}',
    ]);
    expect(env.current().startOnLogin).toBe(false);
    expect(within(env.section).getByRole('button', { name: 'Start at sign-in' })).toBeTruthy();
  });

  it('Start on login ticked in the form (not saved yet) hides the offer', async () => {
    const env = await start({ enabled: true });
    await within(env.section).findByRole('button', { name: 'Start at sign-in' });
    await userEvent.click(within(env.dialog).getByLabelText('Start on login'));
    await waitFor(() =>
      expect(within(env.section).queryByRole('button', { name: 'Start at sign-in' })).toBeNull(),
    );
  });
});
