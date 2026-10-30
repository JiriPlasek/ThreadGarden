import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import AgentsStrip from '../../src/lib/components/layout/AgentsStrip.svelte';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import StatusIcon from '../../src/lib/components/layout/StatusIcon.svelte';
import TabsBar from '../../src/lib/components/layout/TabsBar.svelte';
import { project, setup, summary } from './harness';

type ListParams = { place: { kind: string; projectId?: string }; query?: string };

describe('places column', () => {
  it('needs-you folder shows badge count', async () => {
    const { context } = await setup((server) => {
      server.handlers['places.counts'] = () => ({ needsYou: 3, running: 2, all: 40 });
    });
    render(PlacesColumn, { context });
    const folder = await screen.findByRole('button', { name: /needs you/i });
    await waitFor(() => expect(within(folder).getByText('3')).toBeTruthy());
    const running = screen.getByRole('button', { name: /running/i });
    expect(within(running).getByText('2')).toBeTruthy();
  });

  it('selecting a project filters list', async () => {
    const all = [
      summary('a1', { projectId: 'p1', title: 'alpha one' }),
      summary('b1', { projectId: 'p2', title: 'beta one' }),
      summary('a2', { projectId: 'p1', title: 'alpha two' }),
    ];
    const { server, app, context } = await setup((server) => {
      server.handlers['projects.list'] = () => [project('p1', 'alpha'), project('p2', 'beta')];
      server.handlers['sessions.list'] = (p) => {
        const { place } = p as ListParams;
        return {
          items:
            place.kind === 'project' ? all.filter((s) => s.projectId === place.projectId) : all,
        };
      };
    });
    render(PlacesColumn, { context });
    render(ChatList, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));

    await userEvent.click(await screen.findByRole('button', { name: /^beta/ }));

    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(screen.getByRole('option').textContent).toContain('beta one');
    expect(app.places.selected).toEqual({ kind: 'project', projectId: 'p2' });
    const last = server.calls('sessions.list').at(-1)!.params as ListParams;
    expect(last.place).toEqual({ kind: 'project', projectId: 'p2' });
  });
});

describe('chat list', () => {
  it('chat list renders 1,000 rows with fewer than 60 DOM rows', async () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      summary(`s${i}`, { title: `chat ${i}`, lastActivity: 1_000_000 - i }),
    );
    const { context } = await setup((server) => {
      server.handlers['sessions.list'] = () => ({ items: many });
    });
    render(ChatList, { context });
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
    const rows = screen.getAllByRole('option');
    expect(rows.length).toBeLessThan(60);
    expect(rows[0]!.getAttribute('aria-setsize')).toBe('1000');
    expect(rows[0]!.textContent).toContain('chat 0');
  });
});

describe('agents strip', () => {
  it('strip lists needs-you before working', async () => {
    const { context } = await setup((server) => {
      server.handlers['sessions.list'] = (p) => {
        const { place } = p as ListParams;
        if (place.kind === 'running') {
          return {
            items: [
              summary('w1', { status: 'working', title: 'working one', live: true }),
              summary('w2', { status: 'working', title: 'working two', live: true }),
            ],
          };
        }
        if (place.kind === 'needsYou') {
          return { items: [summary('n1', { status: 'needsYou', title: 'needs one', live: true })] };
        }
        // "All chats" starts with every live and external session, then history.
        return {
          items: [
            summary('n1', { status: 'needsYou', title: 'needs one', live: true }),
            summary('i1', { status: 'idle', title: 'idle one', live: true }),
            summary('x1', {
              status: 'idle',
              title: 'external idle',
              external: { kind: 'interactive', status: 'idle' },
            }),
            summary('p1', { status: 'paused', title: 'paused one' }),
            summary('h1', { status: 'history', title: 'history one' }),
          ],
        };
      };
    });
    render(AgentsStrip, { context });
    const strip = await screen.findByRole('list', { name: /running agents/i });
    await waitFor(() => expect(within(strip).getAllByRole('listitem')).toHaveLength(4));
    const titles = within(strip)
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '');
    expect(titles[0]).toContain('needs one');
    expect(titles[1]).toContain('working one');
    expect(titles[2]).toContain('working two');
    expect(titles[3]).toContain('idle one');
  });

  it('stop all is enabled for an idle pahub chat but not for external sessions only', async () => {
    let items = [summary('i1', { status: 'idle', live: true })];
    const { app, context } = await setup((server) => {
      server.handlers['sessions.list'] = (p) =>
        (p as ListParams).place.kind === 'all' ? { items } : { items: [] };
    });
    render(AgentsStrip, { context });
    const stop = await screen.findByRole('button', { name: /stop all work/i });
    await waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(false));

    items = [
      summary('x1', {
        status: 'working',
        external: { kind: 'bg', status: 'busy' },
      }),
    ];
    await app.agents.refresh();
    await waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(true));
  });

  it('stop all asks for confirmation then calls work.stopAll', async () => {
    const { server, context } = await setup((server) => {
      server.handlers['sessions.list'] = (p) =>
        (p as ListParams).place.kind === 'running'
          ? { items: [summary('w1', { status: 'working', live: true })] }
          : { items: [] };
      server.handlers['work.stopAll'] = () => ({ stopped: 1 });
    });
    render(AgentsStrip, { context });
    const stop = await screen.findByRole('button', { name: /stop all work/i });
    await waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(stop);

    const dialog = await screen.findByRole('alertdialog');
    expect(server.calls('work.stopAll')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: /stop all work/i }));
    await waitFor(() => expect(server.calls('work.stopAll')).toHaveLength(1));
  });
});

describe('tabs', () => {
  it('closing a tab does not call chat.end', async () => {
    const { server, app, context } = await setup();
    app.tabs.openTab('s1');
    app.tabs.openTab('s2');
    app.tabs.openTab('s3');
    render(TabsBar, { context });
    const tablist = screen.getByRole('tablist');
    await waitFor(() => expect(within(tablist).getAllByRole('tab')).toHaveLength(3));

    // Middle-click closes.
    const first = within(tablist).getAllByRole('tab')[0]!;
    await fireEvent(first, new MouseEvent('auxclick', { button: 1, bubbles: true }));
    expect(app.tabs.open).toEqual(['s2', 's3']);

    // Ctrl+W closes the active tab.
    expect(app.tabs.active).toBe('s3');
    await fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
    expect(app.tabs.open).toEqual(['s2']);

    // The close button closes too.
    await userEvent.click(screen.getByRole('button', { name: /close chat s2/i }));
    expect(app.tabs.open).toEqual([]);

    expect(server.calls('chat.end')).toHaveLength(0);
    expect(server.calls('chat.interrupt')).toHaveLength(0);
  });
});

describe('status icon', () => {
  it('unknown status renders neutral icon with raw tooltip', () => {
    render(StatusIcon, { props: { status: 'unknown', raw: 'hibernating' } });
    const icon = screen.getByRole('img');
    expect(icon.getAttribute('data-status')).toBe('unknown');
    expect(icon.getAttribute('title')).toContain('hibernating');
    expect(icon.getAttribute('aria-label')).toContain('hibernating');
  });

  it('a status value from a newer service also renders as unknown', () => {
    render(StatusIcon, { props: { status: 'teleporting' } });
    const icon = screen.getByRole('img');
    expect(icon.getAttribute('data-status')).toBe('unknown');
    expect(icon.getAttribute('title')).toContain('teleporting');
  });

  it('history has no icon', () => {
    const { container } = render(StatusIcon, { props: { status: 'history' } });
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('[data-status="history"]')).not.toBeNull();
  });
});
