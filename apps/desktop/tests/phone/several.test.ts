import { render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ConfirmDialogs from '../../src/lib/components/ServiceDialogs.svelte';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import { onMachineNames } from '../../src/lib/state/machines.svelte';
import { setupTwoMachines, summary } from '../layout/harness';

vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  isPhone: true,
}));

const M2 = 'machine-2';
const needsYou = { kind: 'needsYou' } as const;
const waiting = (sessionId: string) => () => ({
  items: [summary(sessionId, { status: 'needsYou' })],
});

describe('machines on the phone, counted without This PC', () => {
  it('one paired machine is not several: its rows carry no machine chip', async () => {
    const env = await setupTwoMachines({
      configureRemote: (s) => (s.handlers['sessions.list'] = waiting('b')),
    });
    expect(env.app.machines.several).toBe(false);
    env.app.places.select(needsYou);
    render(ChatList, { context: env.context });
    const row = await screen.findByRole('option');
    expect(within(row).queryByText('Ubuntu PC')).toBeNull();
    expect(within(row).queryByText('This PC')).toBeNull();
  });

  it('two paired machines are several: each row names its machine, never This PC', async () => {
    const env = await setupTwoMachines({
      more: [{ id: M2, name: 'Fedora PC' }],
      configureRemote: (s) => (s.handlers['sessions.list'] = waiting('b')),
    });
    env.others[M2]!.handlers['sessions.list'] = waiting('c');
    await waitFor(() => expect(env.app.machines.get(M2)?.status).toBe('on'));
    expect(env.app.machines.several).toBe(true);
    env.app.places.select(needsYou);
    render(ChatList, { context: env.context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    const chips = screen
      .getAllByRole('option')
      .map(
        (o) =>
          (within(o).queryByText('Ubuntu PC') ?? within(o).queryByText('Fedora PC'))?.textContent,
      );
    expect(chips.sort()).toEqual(['Fedora PC', 'Ubuntu PC']);
    expect(screen.queryByText('This PC')).toBeNull();
  });

  it('Stop all work names the machines that are on, never This PC', async () => {
    const env = await setupTwoMachines({ more: [{ id: M2, name: 'Fedora PC' }] });
    await waitFor(() => expect(env.app.machines.get(M2)?.status).toBe('on'));
    expect(onMachineNames(env.app.machines)).toEqual(['Ubuntu PC', 'Fedora PC']);
    render(ConfirmDialogs, { context: env.context });
    env.app.lifecycle.dialog = 'stopAll';
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('on Ubuntu PC and Fedora PC');
    expect(dialog.textContent).not.toMatch(/this pc/i);
  });
});
