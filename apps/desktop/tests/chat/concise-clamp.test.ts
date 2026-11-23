import { createRawSnippet } from 'svelte';
import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ClampedBlock from '../../src/lib/components/chat/ClampedBlock.svelte';
import MessageList from '../../src/lib/components/chat/MessageList.svelte';
import type { ListMemory } from '../../src/lib/state/chats.svelte';
import { text } from './fixtures';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute('data-clamped-content') ? 600 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320);
});
afterEach(() => vi.restoreAllMocks());

describe('concise block expansion', () => {
  it('offers expansion and collapse for overflowing content', async () => {
    const change = vi.fn();
    const { rerender } = render(ClampedBlock, {
      expanded: false,
      onToggle: change,
      children: createRawSnippet(() => ({ render: () => '<p>A long response</p>' })),
    });
    const more = screen.getByRole('button', { name: 'Show more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(more);
    expect(change).toHaveBeenLastCalledWith(true);
    await rerender({ expanded: true });
    const less = screen.getByRole('button', { name: 'Show less' });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(less);
    expect(change).toHaveBeenLastCalledWith(false);
  });

  it('reveals clipped content when an interactive descendant receives focus', async () => {
    const change = vi.fn();
    render(ClampedBlock, {
      expanded: false,
      onToggle: change,
      children: createRawSnippet(() => ({
        render: () => '<div><button>Inside the response</button></div>',
      })),
    });
    await fireEvent.focusIn(screen.getByRole('button', { name: 'Inside the response' }));
    expect(change).toHaveBeenCalledWith(true);
  });

  it('keeps expanded blocks in list memory across remounts', async () => {
    const memory: ListMemory = { heights: new Map(), stick: true, anchor: null };
    const items = [text('answer', 'Long answer '.repeat(100))];
    const first = render(MessageList, { items, concise: true, memory });
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(memory.expanded?.has('answer')).toBe(true);
    expect(memory.stick).toBe(false);
    first.unmount();
    render(MessageList, { items, concise: true, memory });
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
  });
});
