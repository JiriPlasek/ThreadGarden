import { render, screen, waitFor } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import { setup, summary } from './harness';

it('shows compact volume before the unchanged relative time and hides missing totals', async () => {
  const { context } = await setup((server) => {
    server.handlers['sessions.list'] = () => ({
      items: [
        summary('small', { totalTokens: 4700 }),
        summary('large', { totalTokens: 1_200_000 }),
        summary('middle', { totalTokens: 565_000 }),
        summary('unknown'),
        summary('zero', { totalTokens: 0 }),
      ],
    });
  });
  render(ChatList, { context });
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(5));
  const rows = screen.getAllByRole('option');
  for (const [id, volume] of [
    ['small', '4.7K'],
    ['large', '1.2M'],
    ['middle', '565K'],
  ]) {
    const row = rows.find((r) => r.dataset.sessionId === id)!;
    const count = row.querySelector('[data-chat-volume]')!;
    expect(count.textContent?.trim()).toBe(volume);
    expect(count.parentElement?.textContent?.replace(/\s+/g, ' ').trim()).toBe(`${volume} · 1m`);
    expect(row.querySelector('time')?.getAttribute('title')).toBeTruthy();
    expect(count.getAttribute('title')).toContain('includes available subagent usage');
  }
  for (const id of ['unknown', 'zero']) {
    const row = rows.find((r) => r.dataset.sessionId === id)!;
    expect(row.querySelector('[data-chat-volume]')).toBeNull();
    expect(row.querySelector('time')?.textContent).toBe('1m');
  }
});
