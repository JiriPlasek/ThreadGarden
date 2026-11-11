import { screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderChat, SID } from '../interaction/helpers';

vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  isPhone: true,
}));

describe('a suggested reply on the phone', () => {
  it('offers "Use suggestion", with no Tab or Esc to mention', async () => {
    const { server, composer } = await renderChat();
    server.push('chat.status', {
      sessionId: SID,
      seq: 2,
      status: 'idle',
      promptSuggestion: { id: 'prediction-2', text: 'Run the tests' },
    });
    const use = await screen.findByRole('button', { name: 'Use suggestion' });
    expect(screen.queryByRole('button', { name: 'Tab to accept suggestion' })).toBeNull();
    expect(screen.queryByText(/Esc to dismiss/)).toBeNull();
    await userEvent.click(use);
    expect(composer().value).toBe('Run the tests');
    expect(server.calls('chat.send')).toHaveLength(0);
  });
});
