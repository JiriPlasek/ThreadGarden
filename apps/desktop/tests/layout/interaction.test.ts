import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import ConfirmDialog from '../../src/lib/components/ConfirmDialog.svelte';
import AppShell from '../../src/lib/components/layout/AppShell.svelte';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import TabsBar from '../../src/lib/components/layout/TabsBar.svelte';
import { mergeAgents } from '../../src/lib/state/agents.svelte';
import { PAGE_SIZE } from '../../src/lib/state/sessions.svelte';
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

  it('rename sets a Threadgarden-only title through meta.update', async () => {
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

describe('live status changes', () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('moves chats into and out of Needs you as their status changes', async () => {
    const status = new Map<string, string>([['a', 'working']]);
    const { server, app, context } = await setup((server) => {
      server.handlers['sessions.list'] = (p) => {
        const { place } = p as ListParams;
        const all = [...status].map(([id, s]) =>
          summary(id, {
            status: s as never,
            live: true,
            title: `chat ${id}`,
            ...(s === 'needsYou' ? { waitingFor: 'permission: Bash(npm test)' } : {}),
          }),
        );
        return {
          items: place.kind === 'needsYou' ? all.filter((c) => c.status === 'needsYou') : all,
        };
      };
    });
    app.places.select({ kind: 'needsYou' });
    render(ChatList, { context });
    await settle();
    expect(screen.queryAllByRole('option')).toHaveLength(0);

    // The chat starts waiting on a permission: the service only emits chat.status.
    status.set('a', 'needsYou');
    server.push('chat.status', {
      sessionId: 'a',
      seq: 1,
      status: 'needsYou',
      waitingFor: 'permission: Bash(npm test)',
    });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(screen.getByRole('option').textContent).toContain('permission: Bash(npm test)');

    // Answered: it leaves the Needs you list.
    status.set('a', 'working');
    server.push('chat.status', { sessionId: 'a', seq: 2, status: 'working' });
    await waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0));
  });

  it('re-sorts the list when a listed chat changes status', async () => {
    const status = new Map<string, string>([
      ['a', 'idle'],
      ['b', 'idle'],
    ]);
    const rank = (s: string) => (s === 'needsYou' ? 0 : s === 'working' ? 1 : 2);
    const { server, context } = await setup((server) => {
      server.handlers['sessions.list'] = () => ({
        items: [...status]
          .map(([id, s]) => summary(id, { status: s as never, live: true, title: `chat ${id}` }))
          .sort((x, y) => rank(x.status) - rank(y.status)),
      });
    });
    render(ChatList, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('chat a');

    status.set('b', 'needsYou');
    server.push('chat.status', { sessionId: 'b', seq: 1, status: 'needsYou' });
    await waitFor(() => expect(screen.getAllByRole('option')[0]!.textContent).toContain('chat b'));
  });

  it('does not refetch the list for header-only status events', async () => {
    const { server, context } = await setup((server) => {
      server.handlers['sessions.list'] = () => ({
        items: [summary('a', { status: 'working', live: true })],
      });
    });
    render(ChatList, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    await settle();
    const listCalls = () =>
      server.calls('sessions.list').filter((c) => (c.params as ListParams).limit === PAGE_SIZE)
        .length;
    const before = listCalls();
    server.push('chat.status', {
      sessionId: 'a',
      seq: 1,
      status: 'working',
      header: { costUsd: 0.42 },
    });
    await settle();
    expect(listCalls()).toBe(before);
  });
});

describe('shortcuts and scrolling', () => {
  it('Ctrl+W does not close a tab while a dialog is open', async () => {
    const { app, context } = await setup();
    app.tabs.openTab('s1');
    render(TabsBar, { context });
    render(ConfirmDialog, { props: { open: true, title: 'Sure?', onConfirm: () => {} } });
    await screen.findByRole('alertdialog');
    await fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
    expect(app.tabs.open).toEqual(['s1']);
  });

  it('resets the scroll position when the place changes', async () => {
    const many = Array.from({ length: 300 }, (_, i) => summary(`s${i}`, { title: `chat ${i}` }));
    const { app, context } = await setup((server) => {
      server.handlers['sessions.list'] = () => ({ items: many });
    });
    render(ChatList, { context });
    const list = screen.getByRole('listbox');
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
    // jsdom does not scroll: make scrollTop writable for this element.
    let top = 0;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => (top = v),
    });
    top = 200 * 52;
    await fireEvent.scroll(list);
    await waitFor(() => expect(screen.queryByText('chat 0')).toBeNull());

    app.places.select({ kind: 'running' });
    await waitFor(() => expect(screen.getByText('chat 0')).toBeTruthy());
    expect(top).toBe(0);
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
  it('lists live chats and active external sessions once, needs-you → working → idle', () => {
    const ext = { kind: 'interactive' };
    const merged = mergeAgents([
      summary('n1', { status: 'needsYou', live: true }),
      summary('w1', { status: 'working', live: true }),
      summary('i1', { status: 'idle', live: true }),
      summary('xw', { status: 'working', external: ext }),
      summary('xi', { status: 'idle', external: ext }),
      summary('n2', { status: 'needsYou', external: ext }),
      summary('n1', { status: 'needsYou', live: true }),
      summary('pz', { status: 'paused' }),
      summary('fl', { status: 'failed', live: true }),
      summary('hi', { status: 'history' }),
    ]);
    expect(merged.map((s) => s.sessionId)).toEqual(['n1', 'n2', 'w1', 'xw', 'i1']);
  });
});
