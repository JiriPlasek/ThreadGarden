import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import MessageList from '../../src/lib/components/chat/MessageList.svelte';
import { text, user } from './fixtures';

// Every thinking item hits a renderer bug.
vi.mock('../../src/lib/components/chat/items/Thinking.svelte', async () => ({
  default: (await import('./Throws.svelte')).default,
}));

describe('item boundary', () => {
  it('render error in one item shows fallback and others render', async () => {
    const { container } = render(MessageList, {
      items: [
        user('u1', 'before the bug'),
        { kind: 'thinking', id: 'th1', text: 'secret thoughts' },
        text('a1', 'after the bug'),
      ],
    });
    await waitFor(() => expect(container.textContent).toContain('after the bug'));
    expect(container.textContent).toContain('before the bug');
    expect(screen.getByText(/couldn.t be displayed/i)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /show raw/i }));
    expect(container.textContent).toContain('"secret thoughts"');
  });
});
