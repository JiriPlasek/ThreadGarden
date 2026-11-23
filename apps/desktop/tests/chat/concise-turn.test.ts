import { createRawSnippet } from 'svelte';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ConciseTurn from '../../src/lib/components/chat/ConciseTurn.svelte';
import MessageList from '../../src/lib/components/chat/MessageList.svelte';
import { buildConciseRows, groupConciseTurns } from '../../src/lib/components/chat/concise';
import type { ListMemory } from '../../src/lib/state/chats.svelte';
import { text, user } from './fixtures';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320);
});
afterEach(() => vi.restoreAllMocks());

it('groups all replies after each user message under one shared turn limit', () => {
  const turns = groupConciseTurns(
    buildConciseRows(
      [
        text('prelude', 'Earlier reply'),
        user('u1', 'First question'),
        text('a1', 'First part'),
        text('a2', 'Second part'),
        user('u2', 'Follow-up'),
        text('a3', 'Follow-up reply'),
      ],
      [],
    ),
  );
  expect(turns.map((turn) => turn.rows.map((row) => row.key))).toEqual([
    ['prelude'],
    ['a1', 'a2'],
    ['a3'],
  ]);
  expect(turns[1]?.user?.key).toBe('u1');
  expect(turns[2]?.user?.key).toBe('u2');
  expect(turns[1]?.itemIds).toContain('a2');
});

it('restores inner scroll without expansion controls', async () => {
  const save = vi.fn();
  const { container } = render(ConciseTurn, {
    initialScroll: 80,
    onScroll: save,
    children: createRawSnippet(() => ({ render: () => '<p>A long turn</p>' })),
  });
  const scroll = container.querySelector<HTMLElement>('[data-turn-scroll]')!;
  expect(scroll.scrollTop).toBe(80);
  scroll.scrollTop = 280;
  await fireEvent.scroll(scroll);
  expect(save).toHaveBeenLastCalledWith(280);
  expect(container.querySelector('button')).toBeNull();
});

it('remembers each turn scroll across list remounts', async () => {
  const memory: ListMemory = { heights: new Map(), stick: true, anchor: null };
  const props = { items: [user('u'), text('a', 'Long reply')], concise: true, memory };
  const first = render(MessageList, props);
  const prompt = first.container.querySelector('[data-item-id="u"]')!;
  expect(prompt.closest('[data-turn-scroll]')).toBeNull();
  const scroll = first.container.querySelector<HTMLElement>('[data-turn-scroll]')!;
  expect(scroll.querySelector('[data-item-id="a"]')).not.toBeNull();
  scroll.scrollTop = 100;
  await fireEvent.scroll(scroll);
  expect(memory.turnScroll?.get('concise-turn:u')).toBe(100);
  first.unmount();
  const second = render(MessageList, props);
  await waitFor(() =>
    expect(second.container.querySelector('[data-turn-scroll]')?.scrollTop).toBe(100),
  );
});
