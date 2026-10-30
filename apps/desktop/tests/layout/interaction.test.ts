import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import AppShell from '../../src/lib/components/layout/AppShell.svelte';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import { mergeAgents } from '../../src/lib/state/agents.svelte';
import { COLUMNS_SAVE_DELAY_MS } from '../../src/lib/state/settings.svelte';
import { setup, summary } from './harness';

type ListParams = { place: { kind: string }; query?: string; cursor?: string; limit: number };

describe('chat list interaction', () => {
  it('arrow keys move the selection and Enter opens the chat in a tab', async () => {
    const items = [summary('a'), summary('b'), summary('c')];
    const { app, context } = await setup((server) => {
      server.handlers['sessions.list'] = () => ({ items });
    });
    render(ChatList, { context });
    const list = screen.getByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(3));

    list.focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(list.getAttribute('aria-activedescendant')).toBe('chat-row-b');
    expect(screen.getByRole('option', { selected: true }).textContent).toContain('Chat b');
    expect(app.tabs.open).toEqual([]);

    await userEvent.keyboard('{Enter}');
    expect(app.tabs.open).toEqual(['b']);
    expect(app.tabs.active).toBe('b');

    await userEvent.click(within(list).getAllByRole('option')[2]!);
    expect(app.tabs.open).toEqual(['b', 'c']);
    expect(app.tabs.active).toBe('c');
  });

  it('search sends the query to sessions.list', async () => {
    const { server, context } = await setup();
    render(ChatList, { context });
    await userEvent.type(screen.getByRole('searchbox'), 'elo');
    await waitFor(() =>
      expect((server.calls('sessions.list').at(-1)!.params as ListParams).query).toBe('elo'),
    );
  });

  it('scrolling near the end loads the next page', async () => {
    const page1 = Array.from({ length: 5 }, (_, i) => summary(`a${i}`));
    const page2 = Array.from({ length: 5 }, (_, i) => summary(`b${i}`));
    const { server, context } = await setup((server) => {
      server.handlers['sessions.list'] = (p) =>
        (p as ListParams).cursor === 'next'
          ? { items: page2 }
          : { items: page1, nextCursor: 'next' };
    });
    render(ChatList, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(10));
    expect(
      server.calls('sessions.list').some((c) => (c.params as ListParams).cursor === 'next'),
    ).toBe(true);
  });

  it('context menu pins a chat through meta.update', async () => {
    const { server, context } = await setup((server) => {
      server.handlers['sessions.list'] = () => ({ items: [summary('a', { title: 'pin me' })] });
      server.handlers['meta.update'] = () => ({});
    });
    render(ChatList, { context });
    const row = await screen.findByRole('option');
    await fireEvent.contextMenu(row);
    await userEvent.click(await screen.findByRole('menuitem', { name: /^pin$/i }));
    await waitFor(() => expect(server.calls('meta.update')).toHaveLength(1));
    expect(server.calls('meta.update')[0]!.params).toEqual({ sessionId: 'a', pinned: true });
  });

  it('rename sets a pahub-only title through meta.update', async () => {
    const { server, context } = await setup((server) => {
      server.handlers['sessions.list'] = () => ({ items: [summary('a', { title: 'old' })] });
      server.handlers['meta.update'] = () => ({});
    });
    render(ChatList, { context });
    await fireEvent.contextMenu(await screen.findByRole('option'));
    await userEvent.click(await screen.findByRole('menuitem', { name: /rename/i }));
    const input = await screen.findByRole('textbox', { name: /chat title/i });
    await userEvent.clear(input);
    await userEvent.type(input, 'new title{Enter}');
    await waitFor(() =>
      expect(server.calls('meta.update').at(-1)?.params).toEqual({
        sessionId: 'a',
        customTitle: 'new title',
      }),
    );
    expect(server.calls('chat.end')).toHaveLength(0);
  });
});

describe('app shell', () => {
  it('shows the empty state without tabs and resizes columns with the keyboard', async () => {
    const { server, app, context } = await setup();
    render(AppShell, { context });
    expect(screen.getByText(/select a chat or press ctrl\+k/i)).toBeTruthy();

    const handle = screen.getByRole('separator', { name: /resize places/i });
    expect(handle.getAttribute('aria-valuenow')).toBe('220');
    handle.focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(handle.getAttribute('aria-valuenow')).toBe('252');
    expect(app.settings.columnWidths.places).toBe(252);
    await new Promise((r) => setTimeout(r, COLUMNS_SAVE_DELAY_MS + 50));
    const saved = server
      .calls('uiState.set')
      .filter((c) => (c.params as { key: string }).key === 'columns');
    expect(saved).toHaveLength(1);
    expect(saved[0]!.params).toEqual({ key: 'columns', value: { places: 252 } });
  });

  it('collapses and restores the places column', async () => {
    const { app, context } = await setup();
    render(AppShell, { context });
    await userEvent.click(screen.getByRole('button', { name: /hide places/i }));
    expect(app.settings.collapsed.places).toBe(true);
    expect(screen.queryByRole('navigation', { name: /places/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /show places/i }));
    expect(screen.getByRole('navigation', { name: /places/i })).toBeTruthy();
  });
});

describe('mergeAgents', () => {
  it('puts needs-you first and lists each chat once', () => {
    const merged = mergeAgents(
      [summary('n1', { status: 'needsYou' })],
      [
        summary('w1', { status: 'working' }),
        summary('n2', { status: 'needsYou' }),
        summary('n1', { status: 'needsYou' }),
      ],
    );
    expect(merged.map((s) => s.sessionId)).toEqual(['n1', 'n2', 'w1']);
  });
});
