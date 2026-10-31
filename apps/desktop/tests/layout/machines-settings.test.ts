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
      "That code isn't valid. Run `threadgarden pair` on the machine for a new one.",
    ],
    ['PAIRING_EXPIRED', 'That code has expired. Run `threadgarden pair` again.'],
    ['PAIRING_SELF', "That's this machine."],
  ])('shows %s inline and keeps the dialog open', async (code, text) => {
    const env = await setupTwoMachines();
    pairing(env as Env, new RpcFail(code));
    const dialog = await openAdd(env);
    await fill(dialog, 'fedora.local', 'ABCD-EFGH-JKLM');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pair' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(text);
    expect(env.app.interaction.addMachineOpen).toBe(true);
  });

  it('names the machine already paired', async () => {
    const env = await setupTwoMachines();
    pairing(env as Env, new RpcFail('PAIRING_DUPLICATE'));
    const dialog = await openAdd(env);
    await fill(dialog, '192.168.1.5', 'ABCD-EFGH-JKLM');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pair' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Already paired as Ubuntu PC.',
    );
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
  });

  it('says what to run on the machine when it could not be reached to revoke', async () => {
    const env = await setupTwoMachines({
      configure: (s) => (s.handlers['machines.remove'] = () => ({ revoked: false })),
    });
    const settings = await openSettings(env);
    await userEvent.click(within(settings).getByRole('button', { name: /remove ubuntu pc/i }));
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('Ubuntu PC was removed here');
    expect(notice.textContent).toContain('threadgarden devices');
    expect(notice.textContent).toContain('threadgarden revoke');
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
