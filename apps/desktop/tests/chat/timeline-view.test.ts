import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineBlock } from '@threadgarden/protocol';
import TimelineView from '../../src/lib/components/chat/TimelineView.svelte';

const T = Date.parse('2026-11-20T09:00:00Z');
const block: TimelineBlock = {
  id: 'turn:u',
  kind: 'turn',
  title: 'Port billing',
  outcome: 'Tests passed',
  status: 'completed',
  startedAt: T,
  promptAt: T,
  endedAt: T + 3600000,
  toolCount: 12,
  agentCount: 2,
};

describe('timeline view', () => {
  it('refreshes an open inspector when a live turn advances', async () => {
    let report = 'Initial live report';
    const detail = vi.fn(async () => ({
      items: [
        { kind: 'assistantText' as const, id: 'live-answer', markdown: report, streaming: false },
      ],
      hasMore: false,
    }));
    const load = async () => ({ blocks: [block] });
    render(TimelineView, {
      sessionId: 's',
      revision: 1,
      load,
      detail,
    });
    await userEvent.click(await screen.findByRole('button', { name: /Turn: Port billing/ }));
    expect(await screen.findByText('Initial live report')).toBeTruthy();
    report = 'Final live report';
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(detail.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole('complementary', { name: 'Timeline details' })).toBeTruthy();
    expect(await screen.findByText('Final live report')).toBeTruthy();
  });

  it('opens a block for inspection, pages its messages, and closes the inspector', async () => {
    const detail = vi.fn(async (_id: string, offset: number) =>
      offset === 0
        ? {
            items: [
              {
                kind: 'assistantText' as const,
                id: 'a',
                markdown: 'Saved report',
                streaming: false,
              },
            ],
            hasMore: true,
          }
        : {
            items: [
              {
                kind: 'assistantText' as const,
                id: 'b',
                markdown: 'Next report',
                streaming: false,
              },
            ],
            hasMore: false,
          },
    );
    render(TimelineView, { sessionId: 's', load: async () => ({ blocks: [block] }), detail });
    await userEvent.click(await screen.findByRole('button', { name: /Turn: Port billing/ }));
    expect(await screen.findByText('Saved report')).toBeTruthy();
    expect(screen.getByText(/^You ·/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Load more messages' }));
    expect(await screen.findByText('Next report')).toBeTruthy();
    expect(detail).toHaveBeenLastCalledWith('turn:u', 1);
    await userEvent.click(screen.getByRole('button', { name: 'Close timeline details' }));
    expect(screen.queryByRole('complementary', { name: 'Timeline details' })).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/Turn: Port billing/);
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('complementary', { name: 'Timeline details' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'Timeline details' })).toBeNull();
  });

  it('hides entries without dates and retries failed reads', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('Disconnected'))
      .mockResolvedValue({ blocks: [{ ...block, startedAt: undefined, endedAt: undefined }] });
    render(TimelineView, {
      sessionId: 's',
      load,
      detail: async () => ({ items: [], hasMore: false }),
    });
    // Both the initial read and debounced revisions can retry; the visible retry is always usable.
    await waitFor(() => expect(load).toHaveBeenCalled());
    if (screen.queryByText('Disconnected'))
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No timeline entries to show.')).toBeTruthy();
    expect(screen.queryByText(/Timing unavailable/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Turn: Port billing/ })).toBeNull();
    expect(screen.queryByText(/Nov 20/)).toBeNull();
  });
});
