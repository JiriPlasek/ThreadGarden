import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import { M1, project, setup, setupTwoMachines } from '../layout/harness';

// A phone build: no local machine, so This PC is never shown.
vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  isPhone: true,
}));

describe('the places column on the phone', () => {
  it('the places column has no This PC group', async () => {
    const env = await setupTwoMachines({
      configureRemote: (s) => (s.handlers['projects.list'] = () => [project('p1', 'tg-cli')]),
    });
    render(PlacesColumn, { context: env.context });
    const group = await screen.findByRole('group', { name: 'Ubuntu PC' });
    expect(await within(group).findByRole('button', { name: /tg-cli/i })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'This PC' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /this pc/i })).toBeNull();
    expect(screen.queryByText('No projects yet.')).toBeNull();
    // The places across machines are still there.
    expect(screen.getByRole('button', { name: /needs you/i })).toBeTruthy();
    expect(env.app.machines.get(M1)?.status).toBe('on');
  });

  it('with no machines, it offers Add machine and nothing else', async () => {
    const env = await setup();
    render(PlacesColumn, { context: env.context });
    const add = await screen.findByRole('button', { name: /add machine/i });
    const places = screen.getByRole('navigation', { name: 'Places' });
    // The header's Settings, and Add machine: no places, no This PC.
    const buttons = within(places)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());
    expect(buttons).toEqual(['Settings', add.textContent?.trim()]);
    expect(screen.queryByRole('heading', { name: /this pc/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /needs you/i })).toBeNull();
  });

  it('Add machine asks for an address and a code', async () => {
    const env = await setup();
    render(PlacesColumn, { context: env.context, props: { onCollapse: () => {} } });
    render(SettingsDialog, { context: env.context });
    await userEvent.click(await screen.findByRole('button', { name: /add machine/i }));
    const dialog = await screen.findByRole('dialog', { name: /add machine/i });
    expect(within(dialog).getByLabelText('Address')).toBeTruthy();
    expect(within(dialog).getByLabelText('Pairing code')).toBeTruthy();
  });
});
