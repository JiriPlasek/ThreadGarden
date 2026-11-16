import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import MoveChatDialog from '../../src/lib/components/MoveChatDialog.svelte';
import { M1, setupTwoMachines } from '../layout/harness';

vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  isPhone: true,
}));

describe('Move to… on the phone', () => {
  it('never offers This PC as a target', async () => {
    const env = await setupTwoMachines({ more: [{ id: 'machine-2', name: 'Fedora PC' }] });
    render(MoveChatDialog, { context: env.context });
    env.app.interaction.openMoveChat({ machineId: M1, sessionId: 's1' });
    const dialog = await screen.findByRole('dialog', { name: /move this chat/i });
    const select = within(dialog).getByRole('combobox', { name: 'Machine' });
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent?.trim() ?? '');
    expect(options.some((o) => o.startsWith('Fedora PC'))).toBe(true);
    expect(options.some((o) => /this pc/i.test(o))).toBe(false);
  });
});
