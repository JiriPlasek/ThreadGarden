import { settingsDefaults } from '@threadgarden/protocol';
import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import { setupTwoMachines } from '../layout/harness';

vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  isPhone: true,
}));

describe('Let my phone connect on the phone', () => {
  it('is not offered: it is the desktop that listens', async () => {
    const env = await setupTwoMachines({
      configure: (s) => {
        s.handlers['settings.get'] = () => settingsDefaults;
        s.handlers['phoneAccess.get'] = () => ({ enabled: false, addresses: [], port: 47380 });
      },
    });
    render(SettingsDialog, { context: env.context });
    env.app.interaction.settingsOpen = true;
    const dialog = await screen.findByRole('dialog', { name: /^settings$/i });
    await within(dialog).findByRole('group', { name: 'Ubuntu PC' });
    expect(within(dialog).queryByText('Let my phone connect')).toBeNull();
    expect(env.server.calls('phoneAccess.get')).toHaveLength(0);
  });
});
