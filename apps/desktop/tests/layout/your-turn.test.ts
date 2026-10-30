import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import AgentsStrip from '../../src/lib/components/layout/AgentsStrip.svelte';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import StatusIcon from '../../src/lib/components/layout/StatusIcon.svelte';
import { MISSING_OPEN_KEY } from '../../src/lib/state/places.svelte';
import { project, setup, summary } from './harness';

type ListParams = { place: { kind: string } };

describe('"Your turn" indicator (v1.1 §3)', () => {
  it('an unread chat row shows a blue "Your turn" dot and label; needs-you stays distinct', async () => {
    const { context } = await setup((server) => {
      server.handlers['sessions.list'] = () => ({
        items: [
          summary('n1', {
            status: 'needsYou',
            waitingFor: 'permission: Bash(ls)',
            live: true,
            title: 'waiting one',
          }),
          summary('u1', { status: 'idle', live: true, unread: true, title: 'finished one' }),
          summary('r1', { status: 'idle', live: true, title: 'read one' }),
        ],
      });
    });
    render(ChatList, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    const [waiting, finished, read] = screen.getAllByRole('option') as HTMLElement[];

    const dot = within(finished!).getByRole('img', { name: 'Your turn' });
    expect(dot.dataset.status).toBe('yourTurn');
    expect(finished!.textContent).toContain('Your turn');
    // The preview of the last assistant text stays visible.
    expect(finished!.textContent).toContain('preview of u1');

    expect(within(waiting!).getByRole('img', { name: 'Needs you' }).dataset.status).toBe(
      'needsYou',
    );
    expect(within(waiting!).queryByRole('img', { name: 'Your turn' })).toBeNull();
    expect(within(read!).queryByRole('img', { name: 'Your turn' })).toBeNull();
    expect(read!.textContent).not.toContain('Your turn');
  });

  it('the status icon never shows "Your turn" for a chat that waits or works', () => {
    render(StatusIcon, { props: { status: 'needsYou', unread: true } });
    render(StatusIcon, { props: { status: 'working', unread: true } });
    render(StatusIcon, { props: { status: 'failed', unread: true } });
    expect(screen.getByRole('img', { name: 'Needs you' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Working' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Your turn' }).dataset.status).toBe('yourTurn');
  });

  it('the agents strip marks an idle chat whose turn finished unseen', async () => {
    const { context } = await setup((server) => {
      server.handlers['sessions.list'] = (p) =>
        (p as ListParams).place.kind === 'running'
          ? { items: [] }
          : {
              items: [
                summary('u1', { status: 'idle', live: true, unread: true, title: 'finished one' }),
              ],
            };
    });
    render(AgentsStrip, { context });
    const strip = await screen.findByRole('list', { name: /running agents/i });
    await waitFor(() => expect(within(strip).getAllByRole('listitem')).toHaveLength(1));
    expect(within(strip).getByRole('img', { name: 'Your turn' })).toBeTruthy();
    expect(within(strip).getByRole('button').getAttribute('title')).toContain('Your turn');
  });

  it('a project badge counting unread chats reads as "needs you or your turn"', async () => {
    const { context } = await setup((server) => {
      server.handlers['projects.list'] = () => [
        project('p1', 'alpha', { counts: { needsYou: 2, running: 0 } }),
      ];
    });
    render(PlacesColumn, { context });
    const alpha = await screen.findByRole('button', { name: /^alpha/ });
    await waitFor(() => expect(within(alpha).getByText('2')).toBeTruthy());
    expect(within(alpha).getByText('2').getAttribute('title')).toMatch(/needs you or your turn/i);
  });
});

describe('projects: order and missing folders (v1.1 §4)', () => {
  it('keeps the service order (pinned first, then recent)', async () => {
    const { context } = await setup((server) => {
      server.handlers['projects.list'] = () => [
        project('p3', 'gamma', { pinned: true, lastActivity: 10 }),
        project('p1', 'alpha', { lastActivity: 30 }),
        project('p2', 'beta', { lastActivity: 20 }),
      ];
    });
    render(PlacesColumn, { context });
    const list = await screen.findByRole('list', { name: 'Projects' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    const names = within(list)
      .getAllByRole('button')
      .map((b) => b.textContent?.trim());
    expect(names).toEqual(['gamma', 'alpha', 'beta']);
  });

  it('missing folders sit in a collapsed group that remembers being expanded', async () => {
    const { server, app, context } = await setup((server) => {
      server.handlers['projects.list'] = () => [
        project('p1', 'alpha'),
        project('p2', 'gone', { exists: false }),
        project('p3', 'vanished', { exists: false }),
        project('p4', 'secret', { hidden: true, exists: false }),
      ];
    });
    render(PlacesColumn, { context });
    const toggle = await screen.findByRole('button', { name: /missing folders \(2\)/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const list = screen.getByRole('list', { name: 'Projects' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['alpha']);
    expect(screen.queryByRole('button', { name: /^gone/ })).toBeNull();

    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const missing = screen.getByRole('list', { name: /missing folders/i });
    expect(
      within(missing)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['gone', 'vanished']);
    expect(within(missing).getAllByRole('button')[0]!.getAttribute('title')).toMatch(
      /folder not found/i,
    );
    await waitFor(() =>
      expect(
        server.calls('uiState.set').some((c) => {
          const p = c.params as { key: string; value: unknown };
          return p.key === MISSING_OPEN_KEY && p.value === true;
        }),
      ).toBe(true),
    );
    // The hidden-projects section is unchanged: hidden projects stay there, missing or not.
    expect(screen.getByRole('button', { name: /hidden projects \(1\)/i })).toBeTruthy();

    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(app.places.missingOpen).toBe(false);
  });

  it('restores the expanded missing-folders group from uiState', async () => {
    const { app, context } = await setup((server) => {
      server.handlers['projects.list'] = () => [project('p2', 'gone', { exists: false })];
      server.handlers['uiState.get'] = (p) => ({
        value: (p as { key: string }).key === MISSING_OPEN_KEY ? true : null,
      });
    });
    await app.places.restoreMissingOpen();
    render(PlacesColumn, { context });
    const toggle = await screen.findByRole('button', { name: /missing folders \(1\)/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /^gone/ })).toBeTruthy();
  });
});
