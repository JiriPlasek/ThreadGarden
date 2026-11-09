import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import NewChatDialog from '../../src/lib/components/NewChatDialog.svelte';
import { M1, project, setupTwoMachines } from '../layout/harness';
import type { FakeServer } from '../service/fake-ws';

vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  isPhone: true,
}));

vi.setConfig({ testTimeout: 20_000 });

const M2 = 'machine-2';

/** A machine that can start chats in its one project. */
const startsChats = (s: FakeServer, name: string): void => {
  Object.assign(s.handlers, {
    'projects.list': () => [project('p1', name)],
    'chat.models': () => [],
    'chat.commands': () => [],
    'files.suggest': () => [],
    'chat.create': () => ({ sessionId: `new-on-${name}` }),
  });
};

const machineSelect = (dialog: HTMLElement) =>
  within(dialog).getByRole('combobox', { name: /machine/i }) as HTMLSelectElement;

describe('New chat on the phone', () => {
  it('New chat never offers This PC, and defaults to the last machine used', async () => {
    const env = await setupTwoMachines({
      more: [{ id: M2, name: 'Fedora PC' }],
      configureRemote: (s) => startsChats(s, 'tg-cli'),
    });
    await waitFor(() => expect(env.app.machines.get(M2)?.status).toBe('on'));
    // Fedora PC's projects, told as a machine tells them.
    startsChats(env.others[M2]!, 'infra');
    env.others[M2]!.push('projects.changed', {});
    await waitFor(() => expect(env.app.scopes.get(M2)?.places.projects).toHaveLength(1));
    await waitFor(() => expect(env.app.scopes.get(M1)?.places.projects).toHaveLength(1));
    render(NewChatDialog, { context: env.context });

    env.app.interaction.openNewChat();
    let dialog = await screen.findByRole('dialog', { name: /new chat/i });
    let machine = machineSelect(dialog);
    const names = within(machine)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names).toEqual(['Ubuntu PC', 'Fedora PC']);
    // Never This PC, even before a chat was started anywhere.
    expect(machine.value).toBe(M1);

    await userEvent.selectOptions(machine, M2);
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /message/i }),
      'Set up CI{Enter}',
    );
    await waitFor(() => expect(env.others[M2]!.calls('chat.create')).toHaveLength(1));
    expect(env.server.calls('chat.create')).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    env.app.interaction.openNewChat();
    dialog = await screen.findByRole('dialog', { name: /new chat/i });
    machine = machineSelect(dialog);
    expect(machine.value).toBe(M2);
    expect(within(machine).queryByRole('option', { name: /this pc/i })).toBeNull();
  });
});
