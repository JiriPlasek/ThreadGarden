import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import { DAY_MS } from '../../src/lib/components/layout/sections';
import { here, project, setup, summary } from './harness';

type ListParams = { place: { kind: string }; cursor?: string };

const NOW = Date.UTC(2026, 9, 30, 12, 0, 30);
const HOUR = 3_600_000;

afterEach(() => {
  vi.useRealTimers();
});

/** Fake `Date` (and the list's clock interval) only: promises and waitFor keep working. */
const freezeClock = (at = NOW): void => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(at);
};

/** A section header's label and count (not its actions, such as Older's "Archive all…"). */
const headerText = (h: Element | null | undefined): string | undefined =>
  h
    ? [...h.querySelectorAll(':scope > span')].map((s) => s.textContent?.trim() ?? '').join(' ')
    : undefined;

/** Section headers' text, in order. */
const headers = (): string[] =>
  [...document.querySelectorAll('[data-section-header]:not([data-sticky])')].map(
    (h) => headerText(h) ?? '',
  );

const options = (): string[] =>
  screen.getAllByRole('option').map((o) => o.getAttribute('data-session-id')!);

const mixed = () => [
  summary('n1', { status: 'needsYou', lastActivity: NOW - 40 * DAY_MS }),
  summary('w1', { status: 'working', lastActivity: NOW - 1000 }),
  summary('h1', { lastActivity: NOW - HOUR }),
  summary('h2', { lastActivity: NOW - 3 * DAY_MS }),
  summary('h3', { lastActivity: NOW - 400 * DAY_MS }),
];

describe('chat list recency sections (v1.2 §2)', () => {
  it('shows "now" first, then recency sections with counts; empty ones are hidden', async () => {
    freezeClock();
    const { context } = await setup((server) => {
      server.handlers['sessions.list'] = () => ({ items: mixed() });
    });
    render(ChatList, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(5));
    expect(headers()).toEqual(['Now 2', 'Last 24 hours 1', 'Last 7 days 1', 'Older 1']);
    expect(options()).toEqual(['n1', 'w1', 'h1', 'h2', 'h3']);
  });

  it('headers are not options; each option names its section through aria-describedby', async () => {
    freezeClock();
    const { context } = await setup((server) => {
      server.handlers['sessions.list'] = () => ({ items: mixed() });
    });
    render(ChatList, { context });
    const list = screen.getByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(5));
    for (const h of list.querySelectorAll('[data-section-header]')) {
      expect(h.getAttribute('role')).toBe('presentation');
      expect(h.getAttribute('aria-hidden')).toBe('true');
    }
    const describe = (id: string): string => {
      const ref = screen
        .getAllByRole('option')
        .find((o) => o.getAttribute('data-session-id') === id)!
        .getAttribute('aria-describedby')!;
      return document.getElementById(ref)!.textContent!.trim();
    };
    expect(describe('n1')).toBe('Now');
    expect(describe('h1')).toBe('Last 24 hours');
    expect(describe('h3')).toBe('Older');
    // Positions count chats only, across sections.
    const last = screen.getAllByRole('option').at(-1)!;
    expect(last.getAttribute('aria-posinset')).toBe('5');
    expect(last.getAttribute('aria-setsize')).toBe('5');
  });

  it('arrow keys move across sections, skipping the headers; Enter opens', async () => {
    freezeClock();
    const { app, context } = await setup((server) => {
      server.handlers['sessions.list'] = () => ({ items: mixed() });
    });
    render(ChatList, { context });
    const list = screen.getByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(5));
    list.focus();
    const seq: string[] = [];
    for (let i = 0; i < 5; i++) {
      await userEvent.keyboard('{ArrowDown}');
      seq.push(list.getAttribute('aria-activedescendant')!);
    }
    expect(seq).toEqual([
      'chat-row-n1',
      'chat-row-w1',
      'chat-row-h1',
      'chat-row-h2',
      'chat-row-h3',
    ]);
    await userEvent.keyboard('{ArrowDown}');
    expect(list.getAttribute('aria-activedescendant')).toBe('chat-row-h3');
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(list.getAttribute('aria-activedescendant')).toBe('chat-row-h1');
    await userEvent.keyboard('{Enter}');
    expect(app.tabs.active).toBe(here('h1'));
    await userEvent.keyboard('{Home}');
    expect(list.getAttribute('aria-activedescendant')).toBe('chat-row-n1');
    await userEvent.keyboard('{End} ');
    expect(app.tabs.active).toBe(here('h3'));
  });

  it('paging appends rows into the right sections and keeps counts right', async () => {
    freezeClock();
    const page1 = [
      summary('w1', { status: 'working', lastActivity: NOW - 1000 }),
      summary('a1', { lastActivity: NOW - HOUR }),
      summary('a2', { lastActivity: NOW - 2 * DAY_MS }),
    ];
    const page2 = [
      summary('b1', { lastActivity: NOW - 3 * DAY_MS }),
      summary('b2', { lastActivity: NOW - 60 * DAY_MS }),
    ];
    const { context } = await setup((server) => {
      server.handlers['sessions.list'] = (p) =>
        (p as ListParams).cursor === 'next'
          ? { items: page2 }
          : { items: page1, nextCursor: 'next' };
    });
    render(ChatList, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(5));
    expect(headers()).toEqual(['Now 1', 'Last 24 hours 1', 'Last 7 days 2', 'Older 1']);
    expect(options()).toEqual(['w1', 'a1', 'a2', 'b1', 'b2']);
  });

  it('the sections follow the clock when the minute changes', async () => {
    freezeClock(NOW);
    const { context } = await setup((server) => {
      // 23 h 59 min old now; older than 24 h two minutes later.
      server.handlers['sessions.list'] = () => ({
        items: [summary('h1', { lastActivity: NOW - DAY_MS + 60_000 })],
      });
    });
    render(ChatList, { context });
    await waitFor(() => expect(headers()).toEqual(['Last 24 hours 1']));
    vi.advanceTimersByTime(2 * 60_000);
    await waitFor(() => expect(headers()).toEqual(['Last 7 days 1']));
  });

  it('1,000 chats across sections render fewer than 60 DOM rows; the sticky header follows', async () => {
    freezeClock();
    const many = Array.from({ length: 1000 }, (_, i) =>
      summary(`s${i}`, { title: `chat ${i}`, lastActivity: NOW - i * HOUR }),
    );
    const { context } = await setup((server) => {
      server.handlers['sessions.list'] = () => ({ items: many });
    });
    render(ChatList, { context });
    const list = screen.getByRole('listbox');
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
    const rows = () => list.querySelectorAll('[role="option"], [data-section-header]');
    expect(rows().length).toBeLessThan(60);
    expect(screen.getAllByRole('option')[0]!.getAttribute('aria-setsize')).toBe('1000');
    expect(headers()[0]).toBe('Last 24 hours 25');

    // jsdom does not scroll: make scrollTop writable for this element.
    let top = 0;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => (top = v),
    });
    top = 40_000; // deep inside "Older" (chats from more than 30 days ago)
    await fireEvent.scroll(list);
    await waitFor(() => expect(screen.queryByText('chat 0')).toBeNull());
    expect(rows().length).toBeLessThan(60);
    const sticky = list.querySelector('[data-section-header][data-sticky]');
    expect(headerText(sticky)).toBe('Older 279');
    expect(sticky?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('missing folders (v1.2 §4)', () => {
  const projects = () => [
    project('p1', 'alpha'),
    project('p2', 'gone', { exists: false }),
    project('p3', 'vanished', { exists: false }),
    project('p4', 'secret', { hidden: true, exists: false }),
  ];

  it('"Hide all missing" asks first, then hides each missing project', async () => {
    let hidden = new Set(['p4']);
    const { server, context } = await setup((server) => {
      server.handlers['projects.list'] = () =>
        projects().map((p) => ({ ...p, hidden: hidden.has(p.projectId) }));
      server.handlers['projects.update'] = (p) => {
        const { projectId } = p as { projectId: string; hidden: boolean };
        hidden = new Set([...hidden, projectId]);
        return {};
      };
    });
    render(PlacesColumn, { context });
    await userEvent.click(await screen.findByRole('button', { name: 'Hide all missing' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/2 projects/);
    expect(server.calls('projects.update')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(server.calls('projects.update')).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Hide all missing' }));
    const again = await screen.findByRole('alertdialog');
    await userEvent.click(within(again).getByRole('button', { name: /hide 2 projects/i }));
    await waitFor(() => expect(server.calls('projects.update')).toHaveLength(2));
    expect(server.calls('projects.update').map((c) => c.params)).toEqual([
      { projectId: 'p2', hidden: true },
      { projectId: 'p3', hidden: true },
    ]);
    // Reversible: they now sit with the hidden projects.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /hidden projects \(3\)/i })).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: /missing folders/i })).toBeNull();
    // The button that opened the dialog is gone: focus lands where the projects went.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: /hidden projects \(3\)/i }),
      ),
    );
  });

  it('hiding the selected missing project moves the selection to the first place', async () => {
    const { app, context } = await setup((server) => {
      server.handlers['projects.list'] = () => projects();
      server.handlers['projects.update'] = () => ({});
    });
    app.places.select({ kind: 'project', projectId: 'p3' });
    render(PlacesColumn, { context });
    await userEvent.click(await screen.findByRole('button', { name: 'Hide all missing' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /hide 2 projects/i }));
    // v1.2 §3: the first place is Active (it replaced All chats).
    await waitFor(() => expect(app.places.selected).toEqual({ kind: 'active' }));
  });

  it('the section explains why missing folders appear', async () => {
    const { context } = await setup((server) => {
      server.handlers['projects.list'] = () => projects();
    });
    render(PlacesColumn, { context });
    const toggle = await screen.findByRole('button', { name: /missing folders \(2\)/i });
    const text = 'Claude Code still has these chats, but their folders were deleted.';
    // Announced with the toggle, and shown as its tooltip.
    const ref = toggle.getAttribute('aria-describedby')!;
    expect(document.getElementById(ref)?.textContent?.trim()).toBe(text);
    await userEvent.hover(toggle);
    await waitFor(
      () => expect(document.querySelector('[data-tooltip-content]')?.textContent).toContain(text),
      { timeout: 2000 },
    );
  });
});
