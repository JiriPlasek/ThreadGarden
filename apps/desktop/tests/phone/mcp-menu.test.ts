import { screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { openStateMenu, renderChat } from '../chat/mcp-harness';

vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  isPhone: true,
}));

describe('the MCP servers menu item on the phone', () => {
  it('the header menu opens the dialog', async () => {
    await renderChat();
    await openStateMenu();
    await userEvent.click(await screen.findByRole('menuitem', { name: /MCP servers…/ }));
    expect(await screen.findByText('MCP servers (this chat)')).toBeTruthy();
  });
});
