import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import QuickSwitcher from '../../src/lib/components/QuickSwitcher.svelte';
import { setup } from '../layout/harness';

type Hit = { sessionId: string; title: string; projectName: string; snippet?: string };
type QuickParams = { query: string; limit: number };

const hit = (sessionId: string, over: Partial<Hit> = {}): Hit & { score: number } => ({
  sessionId,
  title: `Chat ${sessionId}`,
  projectName: 'alpha',
  score: 1,
  ...over,
});

const openSwitcher = async () => {
  await userEvent.keyboard('{Control>}k{/Control}');
  return screen.findByRole('combobox', { name: /search chats/i });
};

describe('quick switcher', () => {
  it('Ctrl+K opens and Enter focuses existing tab', async () => {
    const { app, context } = await setup((server) => {
      server.handlers['search.quick'] = () => ({
        items: [hit('a', { title: 'alpha refactor', snippet: '…the refactor plan…' })],
      });
    });
    app.tabs.openTab('a');
    app.tabs.openTab('b');
    expect(app.tabs.active).toBe('b');
    render(QuickSwitcher, { context });
    expect(screen.queryByRole('combobox')).toBeNull();

    const input = await openSwitcher();
    await userEvent.type(input, 'refac');
    const option = await screen.findByRole('option', { name: /alpha refactor/i });
    // Title, project and snippet are shown.
    expect(option.textContent).toContain('alpha');
    expect(option.textContent).toContain('the refactor plan');
    await waitFor(() => expect(option.getAttribute('aria-selected')).toBe('true'));

    await userEvent.keyboard('{Enter}');
    expect(app.tabs.active).toBe('a');
    expect(app.tabs.open).toEqual(['a', 'b']);
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull());

    // Ctrl+K toggles: open, then close again.
    await openSwitcher();
    await userEvent.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull());
  });

  it('Enter on a chat that is not open opens a new tab', async () => {
    const { app, context } = await setup((server) => {
      server.handlers['search.quick'] = () => ({ items: [hit('z')] });
    });
    render(QuickSwitcher, { context });
    await userEvent.type(await openSwitcher(), 'z');
    await screen.findByRole('option', { name: /chat z/i });
    await userEvent.keyboard('{Enter}');
    expect(app.tabs.open).toEqual(['z']);
    expect(app.tabs.active).toBe('z');
  });

  it('quick search request per keystroke', async () => {
    const { server, context } = await setup((server) => {
      server.handlers['search.quick'] = (p) => ({
        items: [hit('a', { title: `match ${(p as QuickParams).query}` })],
      });
    });
    render(QuickSwitcher, { context });
    await userEvent.type(await openSwitcher(), 'abc');
    await waitFor(() =>
      expect(server.calls('search.quick').map((c) => (c.params as QuickParams).query)).toEqual([
        'a',
        'ab',
        'abc',
      ]),
    );
    expect(await screen.findByRole('option', { name: /match abc/i })).toBeTruthy();
    // Same query again (a no-op edit): no new request.
    await userEvent.keyboard('{End} {Backspace}');
    expect(server.calls('search.quick')).toHaveLength(3);
  });

  it('drops a response that arrives after a newer one', async () => {
    let releaseFirst: () => void = () => {};
    const { context } = await setup((server) => {
      server.handlers['search.quick'] = (p) => {
        const { query } = p as QuickParams;
        const result = { items: [hit(query, { title: `result for ${query}` })] };
        if (query !== 'a') return result;
        return new Promise((resolve) => (releaseFirst = () => resolve(result)));
      };
    });
    render(QuickSwitcher, { context });
    await userEvent.type(await openSwitcher(), 'ab');
    await screen.findByRole('option', { name: /result for ab/i });
    releaseFirst();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('option', { name: /result for a$/i })).toBeNull();
    expect(screen.getByRole('option', { name: /result for ab/i })).toBeTruthy();
  });

  it('hosts commands: New chat in…, Stop all work, Settings, Keyboard shortcuts', async () => {
    const { app, context } = await setup();
    render(QuickSwitcher, { context });

    await openSwitcher();
    const list = screen.getByRole('listbox');
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.querySelector('[data-label]')?.textContent?.trim()),
    ).toEqual([
      'New chat in…',
      'Stop all work',
      'Settings',
      'Keyboard shortcuts',
      // v1.2 §3, in Active and in a project.
      'Archive chats older than 30 days…',
    ]);

    await userEvent.keyboard('sett');
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole('option')
          .map((o) => o.querySelector('[data-label]')?.textContent?.trim()),
      ).toEqual(['Settings']),
    );
    await userEvent.keyboard('{Enter}');
    expect(app.interaction.settingsOpen).toBe(true);

    await openSwitcher();
    await userEvent.click(screen.getByRole('option', { name: /stop all work/i }));
    expect(app.lifecycle.dialog).toBe('stopAll');

    await openSwitcher();
    await userEvent.click(screen.getByRole('option', { name: /new chat in/i }));
    expect(app.interaction.newChat.open).toBe(true);
  });
});
