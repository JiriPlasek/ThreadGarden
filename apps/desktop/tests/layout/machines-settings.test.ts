import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import MachineHeading from '../../src/lib/components/layout/MachineHeading.svelte';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import { RpcFail } from '../service/fake-ws';
import { M1, pairedMachine, setup, setupTwoMachines } from './harness';

const TOKEN = 'ab'.repeat(32);
const M2 = 'machine-2';

type Env = Awaited<ReturnType<typeof setupTwoMachines>>;

const openSettings = async (env: Pick<Env, 'app' | 'context'>) => {
  render(SettingsDialog, { context: env.context });
  env.app.interaction.settingsOpen = true;
  return screen.findByRole('dialog', { name: /^settings$/i });
};

const openAdd = async (env: Pick<Env, 'app' | 'context'>) => {
  const settings = await openSettings(env);
  await userEvent.click(within(settings).getByRole('button', { name: /add machine/i }));
  return screen.findByRole('dialog', { name: /add machine/i });
};

const fill = async (dialog: HTMLElement, address: string, code: string) => {
  await userEvent.type(within(dialog).getByLabelText('Address'), address);
  await userEvent.type(within(dialog).getByLabelText('Pairing code'), code);
};

const pairing = (env: Env, fail?: RpcFail) => {
  env.server.handlers['machines.pair'] = () => {
    if (fail) throw fail;
    return {
      machine: { ...pairedMachine(M2, 'Fedora PC'), address: 'fedora.local' },
      token: TOKEN,
    };
  };
};

describe('Settings → Machines', () => {
  it('lists This PC and each paired machine with its state', async () => {
    const env = await setupTwoMachines();
    const settings = await openSettings(env);
    const section = within(settings).getByRole('region', { name: 'Machines' });
    expect(within(section).getByText('This PC')).toBeTruthy();
    const card = within(section).getByRole('group', { name: 'Ubuntu PC' });
    expect(within(card).getByText('On')).toBeTruthy();
    expect((within(card).getByLabelText('Address') as HTMLInputElement).value).toBe('192.168.1.5');
    expect((within(card).getByLabelText('Port') as HTMLInputElement).value).toBe('47380');
  });

  it('with no paired machines still shows This PC and Add machine', async () => {
    const env = await setup();
    const settings = await openSettings(env);
    const section = within(settings).getByRole('region', { name: 'Machines' });
    expect(within(section).getByText('This PC')).toBeTruthy();
    expect(within(section).getByRole('button', { name: /add machine/i })).toBeTruthy();
  });

  it('says a different machine answers at the address (needs attention)', async () => {
    const env = await setupTwoMachines({ m1Status: 'mismatch' });
    const settings = await openSettings(env);
    const card = within(settings).getByRole('group', { name: 'Ubuntu PC' });
    expect(within(card).getByText('Needs attention')).toBeTruthy();
    expect(within(card).getByText('This address answers as a different machine')).toBeTruthy();
  });

  it('pairs a machine, lists it and closes the dialog', async () => {
    const env = await setupTwoMachines();
    pairing(env as Env);
    const dialog = await openAdd(env);
    expect((within(dialog).getByLabelText("This device's name") as HTMLInputElement).value).toBe(
      'my-host',
    );
    expect((within(dialog).getByLabelText('Address') as HTMLInputElement).placeholder).toBe(
      'ubuntu-pc.local',
    );
    expect(within(dialog).getByText(/threadgarden pair/)).toBeTruthy();
    await fill(dialog, 'fedora.local', 'ABCD-EFGH-JKLM');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pair' }));
    await waitFor(() => expect(env.app.interaction.addMachineOpen).toBe(false));
    expect(env.server.calls('machines.pair').map((c) => c.params)).toEqual([
      { address: 'fedora.local', port: 47380, code: 'ABCD-EFGH-JKLM', deviceName: 'my-host' },
    ]);
    expect(env.app.machines.get(M2)?.name).toBe('Fedora PC');
    const settings = screen.getByRole('dialog', { name: /^settings$/i });
    expect(within(settings).getByRole('group', { name: 'Fedora PC' })).toBeTruthy();
  });

  it.each([
    [
      'PAIRING_UNREACHABLE',
      "Can't reach fedora.local. Is the machine on and Threadgarden running there?",
    ],
    [
      'PAIRING_PROOF_FAILED',
      "The machine at fedora.local couldn't prove it knows this code. Nothing was sent. Check the code and the address.",
    ],
    [
      'PAIRING_INVALID',
      "That code isn't valid. Run threadgarden pair on the machine for a new one.",
    ],
    ['PAIRING_EXPIRED', 'That code has expired. Run threadgarden pair again.'],
    ['PAIRING_SELF', "That's this machine."],
  ])('shows %s inline and keeps the dialog open', async (code, text) => {
    const env = await setupTwoMachines();
    pairing(env as Env, new RpcFail(code));
    const dialog = await openAdd(env);
    await fill(dialog, 'fedora.local', 'ABCD-EFGH-JKLM');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pair' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe(text);
    // Commands are code, never literal backticks.
    expect(alert.textContent).not.toContain('`');
    expect([...alert.querySelectorAll('code')].map((c) => c.textContent)).toEqual(
      text.includes('threadgarden pair') ? ['threadgarden pair'] : [],
    );
    expect(env.app.interaction.addMachineOpen).toBe(true);
  });

  it('splits a pasted address:port into the address and the port', async () => {
    const env = await setupTwoMachines();
    pairing(env as Env);
    const dialog = await openAdd(env);
    const address = within(dialog).getByLabelText('Address') as HTMLInputElement;
    await userEvent.click(address);
    await userEvent.paste('192.168.1.50:47390');
    await userEvent.tab();
    expect(address.value).toBe('192.168.1.50');
    expect((within(dialog).getByLabelText('Port') as HTMLInputElement).value).toBe('47390');
    await userEvent.type(within(dialog).getByLabelText('Pairing code'), 'ABCD-EFGH-JKLM');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pair' }));
    await waitFor(() =>
      expect(env.server.calls('machines.pair').map((c) => c.params)).toEqual([
        { address: '192.168.1.50', port: 47390, code: 'ABCD-EFGH-JKLM', deviceName: 'my-host' },
      ]),
    );
  });

  it('splits host:port on Pair too, and checks the port', async () => {
    const env = await setupTwoMachines();
    pairing(env as Env);
    const dialog = await openAdd(env);
    await fill(dialog, 'ubuntu-pc.local:99999', 'ABCD-EFGH-JKLM');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pair' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'The port is a number from 1 to 65535.',
    );
    expect(env.server.calls('machines.pair')).toEqual([]);

    const address = within(dialog).getByLabelText('Address') as HTMLInputElement;
    await userEvent.clear(address);
    await userEvent.type(address, 'ubuntu-pc.local:47381');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pair' }));
    await waitFor(() =>
      expect(env.server.calls('machines.pair').map((c) => c.params)).toEqual([
        { address: 'ubuntu-pc.local', port: 47381, code: 'ABCD-EFGH-JKLM', deviceName: 'my-host' },
      ]),
    );
  });

  it('leaves an IPv6 address whole', async () => {
    const env = await setupTwoMachines();
    pairing(env as Env);
    const dialog = await openAdd(env);
    await fill(dialog, 'fe80::1', 'ABCD-EFGH-JKLM');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pair' }));
    await waitFor(() =>
      expect(env.server.calls('machines.pair').map((c) => c.params)).toEqual([
        { address: 'fe80::1', port: 47380, code: 'ABCD-EFGH-JKLM', deviceName: 'my-host' },
      ]),
    );
  });

  it('names the machine already paired, whatever address was typed', async () => {
    const env = await setupTwoMachines();
    pairing(env as Env, new RpcFail('PAIRING_DUPLICATE', 'Already paired as Ubuntu PC'));
    const dialog = await openAdd(env);
    await fill(dialog, 'other-name.local', 'ABCD-EFGH-JKLM');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pair' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Already paired as Ubuntu PC.',
    );
  });

  it('says the machine is already paired when the service names none', async () => {
    const env = await setupTwoMachines();
    pairing(env as Env, new RpcFail('PAIRING_DUPLICATE', 'PAIRING_DUPLICATE'));
    const dialog = await openAdd(env);
    await fill(dialog, 'x.local', 'ABCD-EFGH-JKLM');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pair' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'That machine is already paired.',
    );
  });

  it('shows the service message for a code it does not know', async () => {
    const env = await setupTwoMachines();
    pairing(env as Env, new RpcFail('SOMETHING_ELSE', 'Odd failure'));
    const dialog = await openAdd(env);
    await fill(dialog, 'x.local', 'ABCD-EFGH-JKLM');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pair' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Odd failure');
  });

  it('forgets the code and the error on every way of closing', async () => {
    const env = await setupTwoMachines();
    pairing(env as Env, new RpcFail('PAIRING_INVALID'));
    await openSettings(env);
    for (const close of [
      (d: HTMLElement) => userEvent.click(within(d).getByRole('button', { name: 'Cancel' })),
      () => userEvent.keyboard('{Escape}'),
    ]) {
      await userEvent.click(
        within(screen.getByRole('dialog', { name: /^settings$/i })).getByRole('button', {
          name: /add machine/i,
        }),
      );
      const dialog = await screen.findByRole('dialog', { name: /add machine/i });
      await fill(dialog, 'x.local', 'ABCD-EFGH-JKLM');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Pair' }));
      await within(dialog).findByRole('alert');
      await close(dialog);
      await waitFor(() => expect(env.app.interaction.addMachineOpen).toBe(false));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: /add machine/i })).toBeNull(),
      );
      await userEvent.click(
        within(screen.getByRole('dialog', { name: /^settings$/i })).getByRole('button', {
          name: /add machine/i,
        }),
      );
      const again = await screen.findByRole('dialog', { name: /add machine/i });
      expect((within(again).getByLabelText('Pairing code') as HTMLInputElement).value).toBe('');
      expect(within(again).queryByRole('alert')).toBeNull();
      await userEvent.click(within(again).getByRole('button', { name: 'Cancel' }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: /add machine/i })).toBeNull(),
      );
    }
  });

  it('closes the Add dialog with Settings', async () => {
    const env = await setupTwoMachines();
    await openAdd(env);
    env.app.interaction.settingsOpen = false;
    await waitFor(() => expect(env.app.interaction.addMachineOpen).toBe(false));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    env.app.interaction.settingsOpen = true;
    await screen.findByRole('dialog', { name: /^settings$/i });
    expect(env.app.interaction.addMachineOpen).toBe(false);
    expect(screen.queryByRole('dialog', { name: /add machine/i })).toBeNull();
  });

  it('refreshes edits from machines.changed, except the field being typed in', async () => {
    const env = await setupTwoMachines();
    const settings = await openSettings(env);
    const card = within(settings).getByRole('group', { name: 'Ubuntu PC' });
    const name = within(card).getByLabelText('Name') as HTMLInputElement;
    const address = within(card).getByLabelText('Address') as HTMLInputElement;
    await userEvent.type(address, 'x');
    await userEvent.type(name, 'y');
    env.server.push('machines.changed', [
      { ...pairedMachine(M1, 'Ubuntu PC'), address: '10.0.0.9', name: 'Renamed' },
    ]);
    await waitFor(() => expect(address.value).toBe('10.0.0.9'));
    // The name field has focus: what is typed stays.
    expect(name.value).toBe('Ubuntu PCy');
  });

  it('refuses an invalid address or port before asking the service', async () => {
    const env = await setupTwoMachines();
    pairing(env as Env);
    const dialog = await openAdd(env);
    await fill(dialog, 'bad address!', 'ABCD-EFGH-JKLM');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pair' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(env.server.calls('machines.pair')).toEqual([]);
  });

  it('edits the address and keeps the machine id', async () => {
    const env = await setupTwoMachines();
    env.server.handlers['machines.update'] = (p) => ({
      ...pairedMachine(M1, 'Ubuntu PC'),
      ...(p as { address: string; port: number }),
    });
    const settings = await openSettings(env);
    const card = within(settings).getByRole('group', { name: 'Ubuntu PC' });
    const address = within(card).getByLabelText('Address');
    await userEvent.clear(address);
    await userEvent.type(address, 'ubuntu-pc.local');
    await userEvent.click(within(card).getByRole('button', { name: /^save ubuntu pc$/i }));
    await waitFor(() =>
      expect(env.server.calls('machines.update').map((c) => c.params)).toEqual([
        { machineId: M1, address: 'ubuntu-pc.local', port: 47380 },
      ]),
    );
    await waitFor(() => expect(env.app.machines.get(M1)?.address).toBe('ubuntu-pc.local'));
    expect(env.app.machines.list.filter((m) => !m.local).map((m) => m.id)).toEqual([M1]);
  });

  it('renames a machine immediately', async () => {
    const env = await setupTwoMachines();
    env.server.handlers['machines.update'] = (p) => ({
      ...pairedMachine(M1, 'Ubuntu PC'),
      ...(p as { name: string }),
    });
    const settings = await openSettings(env);
    const card = within(settings).getByRole('group', { name: 'Ubuntu PC' });
    const name = within(card).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Workstation');
    await userEvent.click(within(card).getByRole('button', { name: /^save ubuntu pc$/i }));
    await waitFor(() =>
      expect(env.server.calls('machines.update').map((c) => c.params)).toEqual([
        { machineId: M1, name: 'Workstation' },
      ]),
    );
    await waitFor(() => expect(env.app.machines.get(M1)?.name).toBe('Workstation'));
  });

  it('removes after confirming, revoking and clearing the keychain token', async () => {
    const env = await setupTwoMachines();
    const tokens = (
      env.app.machines as unknown as { tokens: { clear: (id: string) => Promise<void> } }
    ).tokens;
    const clear = vi.spyOn(tokens, 'clear');
    const settings = await openSettings(env);
    await userEvent.click(within(settings).getByRole('button', { name: /remove ubuntu pc/i }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove Ubuntu PC?' });
    expect(
      within(confirm).getByText(
        'This PC forgets it, and Ubuntu PC forgets this PC if it can be reached.',
      ),
    ).toBeTruthy();
    expect(env.server.calls('machines.remove')).toEqual([]);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(env.server.calls('machines.remove').map((c) => c.params)).toEqual([
        { machineId: M1, revoke: true },
      ]),
    );
    await waitFor(() => expect(env.app.machines.get(M1)).toBeUndefined());
    expect(clear).toHaveBeenCalledWith(M1);
    expect(screen.queryByRole('status')).toBeNull();
    // The Remove button that opened the confirmation is gone: focus lands on the Machines heading.
    const heading = within(settings).getByRole('heading', { name: 'Machines' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('says what to run on the machine when it did not confirm the revoke', async () => {
    // Not confirmed: unreachable, locked, or it had already revoked this PC; the cause is unknown.
    const env = await setupTwoMachines({
      configure: (s) => (s.handlers['machines.remove'] = () => ({ revoked: false })),
    });
    const settings = await openSettings(env);
    await userEvent.click(within(settings).getByRole('button', { name: /remove ubuntu pc/i }));
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toBe(
      'Ubuntu PC was removed here. It may still list this PC: on Ubuntu PC, run ' +
        'threadgarden devices and threadgarden revoke <id>.',
    );
    expect([...notice.querySelectorAll('code')].map((c) => c.textContent)).toEqual([
      'threadgarden devices',
      'threadgarden revoke <id>',
    ]);
  });

  it('"Open settings" on a machine needing attention opens Settings at Machines', async () => {
    const env = await setupTwoMachines({ m1Status: 'mismatch' });
    render(MachineHeading, {
      context: env.context,
      props: { machine: env.app.machines.get(M1)!, collapsed: false, onToggle: () => {} },
    });
    await userEvent.click(screen.getByRole('button', { name: /open settings/i }));
    expect(env.app.interaction.settingsOpen).toBe(true);
    render(SettingsDialog, { context: env.context });
    const heading = await screen.findByRole('heading', { name: 'Machines' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(env.app.interaction.settingsSection).toBeNull();
  });
});
