import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { ChatSummary } from '@pahub/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QuickSwitcher from '../../src/lib/components/QuickSwitcher.svelte';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import { DAY_MS } from '../../src/lib/components/layout/sections';
import { RpcFail, type FakeServer } from '../service/fake-ws';
import BucketsHarness from './BucketsHarness.svelte';
import { project, setup, summary } from './harness';

type ListParams = { place: Record<string, unknown>; limit: number };
type SetParams = { sessionIds: string[]; bucket: string; holdUntil?: number; holdNote?: string };

const local = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime();
/** Saturday 2026-10-31, 15:20 local time. */
const NOW = local(2026, 10, 31, 15, 20);

beforeEach(() => {
  // bits-ui's scroll lock of a dialog left open (or just closed) by the previous
  // test outlives its unmounting in jsdom and would block the next pointer events.
  document.body.removeAttribute('style');
});

afterEach(() => {
  vi.useRealTimers();
});

/** Fake `Date` only: promises, timers and waitFor keep working. */
const freezeDate = (at = NOW): void => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
};

/**
 * A fake service listing `items` in every place, with `chat.setBucket`
 * refusing to archive the ids in `skip` (once `chat.end` ran for a LIVE one,
 * it archives).
 */
const withList = (
  items: ChatSummary[],
  o: { skip?: Record<string, string>; configure?: (s: FakeServer) => void } = {},
) =>
  setup((server) => {
    const pending = { ...o.skip };
    server.handlers['sessions.list'] = () => ({ items });
    server.handlers['chat.setBucket'] = (p) => {
      const { sessionIds, bucket } = p as SetParams;
      const skipped =
        bucket === 'archived'
          ? sessionIds.flatMap((id) =>
              pending[id] ? [{ sessionId: id, reason: pending[id] }] : [],
            )
          : [];
      return { updated: sessionIds.length - skipped.length, skipped };
    };
    server.handlers['chat.end'] = (p) => {
      delete pending[(p as { sessionId: string }).sessionId];
      return {};
    };
    server.handlers['chat.archiveOlder'] = (p) => ({
      archived: (p as { dryRun?: boolean }).dryRun ? 12 : 12,
    });
    o.configure?.(server);
  });

const setCalls = (server: FakeServer) =>
  server.calls('chat.setBucket').map((c) => c.params as SetParams);

const row = (id: string): HTMLElement =>
  screen.getAllByRole('option').find((o) => o.getAttribute('data-session-id') === id)!;

const selectedIds = (): string[] =>
  screen
    .getAllByRole('option')
    .filter((o) => o.getAttribute('aria-selected') === 'true')
    .map((o) => o.getAttribute('data-session-id')!);

const four = () => ['a', 'b', 'c', 'd'].map((id) => summary(id));

/**
 * Opens the chat header's "Chat state" menu. jsdom has no layout, so the
 * trigger is given a client rect: bits-ui keeps a menu hidden while its
 * anchor has none (as if it had been removed).
 */
const openStateMenu = async (): Promise<string[]> => {
  const trigger = screen.getByRole('button', { name: 'Chat state' });
  trigger.getClientRects = () => [new DOMRect(0, 0, 24, 24)] as unknown as DOMRectList;
  await userEvent.click(trigger);
  return (await screen.findAllByRole('menuitem')).map((m) => m.textContent?.trim() ?? '');
};

describe('places column: Active, On hold, Archived (v1.2 §3)', () => {
  it('lists the bucket places with counts in place of "All chats"', async () => {
    const { app, server, context } = await setup((server) => {
      server.handlers['places.counts'] = () => ({
        needsYou: 1,
        running: 0,
        all: 7,
        active: 7,
        onHold: 2,
        archived: 30,
      });
    });
    render(PlacesColumn, { context });
    const nav = screen.getByRole('navigation', { name: 'Places' });
    const smartFolders = () =>
      within(nav.querySelector('ul')!)
        .getAllByRole('button')
        .map((b) => b.textContent?.replace(/\s+/g, ' ').trim());
    await waitFor(() =>
      expect(smartFolders()).toEqual([
        'Needs you 1',
        'Running',
        // v1.3 §4: opens the Analytics view, not a list
        'Analytics',
        'Active 7',
        'On hold 2',
        'Archived 30',
      ]),
    );
    expect(within(nav).queryByText('All chats')).toBeNull();
    expect(app.places.selected).toEqual({ kind: 'active' });
    expect(
      within(nav)
        .getByRole('button', { name: /^Active/ })
        .getAttribute('aria-current'),
    ).toBe('true');

    await userEvent.click(within(nav).getByRole('button', { name: /^On hold/ }));
    expect(app.places.selected).toEqual({ kind: 'onHold' });
    await waitFor(() =>
      expect((server.calls('sessions.list').at(-1)!.params as ListParams).place).toEqual({
        kind: 'onHold',
      }),
    );
    await userEvent.click(within(nav).getByRole('button', { name: /^Archived/ }));
    expect(app.places.selected).toEqual({ kind: 'archived' });
  });

  it('the old "all" place reads as Active', async () => {
    const { app } = await setup();
    app.places.select({ kind: 'onHold' });
    app.places.select({ kind: 'all' });
    expect(app.places.selected).toEqual({ kind: 'active' });
  });

  it('a project lists its active chats; the list header toggle includes on-hold and archived ones', async () => {
    const { app, server, context } = await setup((server) => {
      server.handlers['projects.list'] = () => [project('p1', 'alpha')];
    });
    render(BucketsHarness, { context });
    // Not offered outside a project.
    expect(screen.queryByRole('button', { name: /include on hold/i })).toBeNull();

    app.places.select({ kind: 'project', projectId: 'p1' });
    const toggle = await screen.findByRole('button', { name: /include on hold/i });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    const lastPlace = () => (server.calls('sessions.list').at(-1)!.params as ListParams).place;
    await waitFor(() => expect(lastPlace()).toEqual({ kind: 'project', projectId: 'p1' }));

    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() =>
      expect(lastPlace()).toEqual({
        kind: 'project',
        projectId: 'p1',
        include: ['onHold', 'archived'],
      }),
    );
    await userEvent.click(toggle);
    await waitFor(() => expect(lastPlace()).toEqual({ kind: 'project', projectId: 'p1' }));
  });
});

describe('chat rows: bucket indicators', () => {
  it('on hold shows a pause glyph, until and the note; archived and back from hold are marked', async () => {
    freezeDate();
    const note = 'waiting for review from Petr, who is on holiday until the middle of next week';
    const { context } = await withList([
      summary('h', { bucket: 'onHold', holdUntil: local(2026, 11, 1, 9), holdNote: note }),
      summary('i', { bucket: 'onHold' }),
      summary('x', { bucket: 'archived' }),
      summary('b', { backFromHold: true }),
      summary('n'),
    ]);
    render(BucketsHarness, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(5));

    const held = row('h');
    expect(within(held).getByText('until tomorrow 09:00')).toBeTruthy();
    expect(within(held).getByText(note).getAttribute('title')).toBe(note);
    expect(within(held).getByRole('img', { name: 'On hold' })).toBeTruthy();
    // Indefinitely: no date.
    expect(within(row('i')).getByRole('img', { name: 'On hold' })).toBeTruthy();
    expect(row('i').textContent).not.toContain('until');

    expect(within(row('x')).getByRole('img', { name: 'Archived' })).toBeTruthy();
    // Not colour only: the words say it.
    expect(within(row('b')).getByText('Back from hold')).toBeTruthy();

    for (const plain of [row('n')]) {
      expect(within(plain).queryByRole('img', { name: /on hold|archived/i })).toBeNull();
      expect(plain.textContent).not.toContain('Back from hold');
    }
  });
});

describe('chat row context menu', () => {
  it('offers the other buckets and moves the chat', async () => {
    const { server, context } = await withList([
      summary('a'),
      summary('x', { bucket: 'archived' }),
    ]);
    render(BucketsHarness, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));

    await fireEvent.contextMenu(row('a'));
    const items = (await screen.findAllByRole('menuitem')).map((m) => m.textContent?.trim());
    expect(items).toContain('Put on hold…');
    expect(items).toContain('Archive');
    expect(items).not.toContain('Make active');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() =>
      expect(setCalls(server)).toEqual([{ sessionIds: ['a'], bucket: 'archived' }]),
    );

    await fireEvent.contextMenu(row('x'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Make active' }));
    await waitFor(() =>
      expect(setCalls(server).at(-1)).toEqual({ sessionIds: ['x'], bucket: 'active' }),
    );
  });

  it('archiving a chat Threadgarden runs asks "End this chat and archive it?", then ends and archives', async () => {
    const { server, context } = await withList(
      [summary('a', { live: true, status: 'idle', title: 'busy chat' })],
      { skip: { a: 'LIVE' } },
    );
    render(BucketsHarness, { context });
    await fireEvent.contextMenu(await screen.findByRole('option'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('End this chat and archive it?')).toBeTruthy();
    expect(server.calls('chat.end')).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'End and archive' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    const order = server.sent
      .map((s) => s.method)
      .filter((m) => m === 'chat.end' || m === 'chat.setBucket');
    expect(order).toEqual(['chat.setBucket', 'chat.end', 'chat.setBucket']);
  });
});

describe('the hold popover', () => {
  const openHold = async () => {
    await fireEvent.contextMenu(await screen.findByRole('option'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Put on hold…' }));
    return screen.findByRole('dialog', { name: 'Put on hold' });
  };

  it('offers Tomorrow 09:00, Next week (Monday 09:00), a picked time and no date, plus a note', async () => {
    freezeDate();
    const { server, context } = await withList([summary('a')]);
    render(BucketsHarness, { context });
    let dialog = await openHold();
    const tomorrow = within(dialog).getByRole('radio', { name: /tomorrow/i });
    expect((tomorrow as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getByRole('radio', { name: /next week/i })).toBeTruthy();
    expect(within(dialog).getByRole('radio', { name: /pick date/i })).toBeTruthy();
    expect(within(dialog).getByRole('radio', { name: /no date/i })).toBeTruthy();

    // Next week + a note.
    await userEvent.click(within(dialog).getByRole('radio', { name: /next week/i }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: /note/i }), 'ask Petr');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(setCalls(server)).toEqual([
        {
          sessionIds: ['a'],
          bucket: 'onHold',
          holdUntil: local(2026, 11, 2, 9),
          holdNote: 'ask Petr',
        },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Tomorrow (the default).
    dialog = await openHold();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(setCalls(server).at(-1)).toEqual({
        sessionIds: ['a'],
        bucket: 'onHold',
        holdUntil: local(2026, 11, 1, 9),
      }),
    );

    // No date.
    dialog = await openHold();
    await userEvent.click(within(dialog).getByRole('radio', { name: /no date/i }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(setCalls(server).at(-1)).toEqual({ sessionIds: ['a'], bucket: 'onHold' }),
    );
  });

  it('a picked date and time must lie ahead', async () => {
    freezeDate();
    const { server, context } = await withList([summary('a')]);
    render(BucketsHarness, { context });
    const dialog = await openHold();
    await userEvent.click(within(dialog).getByRole('radio', { name: /pick date/i }));
    const field = within(dialog).getByLabelText(/date and time/i);
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;

    await fireEvent.input(field, { target: { value: '2026-10-30T09:00' } });
    expect(within(dialog).getByText(/a time ahead/i)).toBeTruthy();
    expect(save.disabled).toBe(true);

    await fireEvent.input(field, { target: { value: '2026-11-05T14:30' } });
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    await waitFor(() =>
      expect(setCalls(server)).toEqual([
        { sessionIds: ['a'], bucket: 'onHold', holdUntil: local(2026, 11, 5, 14, 30) },
      ]),
    );
  });
});

describe('chat list keyboard: E, H, A', () => {
  it('archive, hold and make active the chat under the cursor', async () => {
    const { server, context } = await withList(four());
    render(BucketsHarness, { context });
    const list = screen.getByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(4));
    list.focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await userEvent.keyboard('e');
    await waitFor(() =>
      expect(setCalls(server)).toEqual([{ sessionIds: ['b'], bucket: 'archived' }]),
    );
    await userEvent.keyboard('a');
    await waitFor(() =>
      expect(setCalls(server).at(-1)).toEqual({ sessionIds: ['b'], bucket: 'active' }),
    );
    await userEvent.keyboard('h');
    expect(await screen.findByRole('dialog', { name: 'Put on hold' })).toBeTruthy();
    // Modified keys are not these shortcuts.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    list.focus();
    await userEvent.keyboard('{Alt>}e{/Alt}');
    expect(setCalls(server)).toHaveLength(2);
  });
});

describe('multi-select and the bulk action bar', () => {
  it('Ctrl+click toggles, Shift+click selects a range, Esc clears', async () => {
    const { app, context } = await withList(four());
    render(BucketsHarness, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    expect(screen.getByRole('listbox').getAttribute('aria-multiselectable')).toBe('true');

    await fireEvent.click(row('b'), { ctrlKey: true });
    await fireEvent.click(row('d'), { metaKey: true });
    expect(selectedIds()).toEqual(['b', 'd']);
    const bar = screen.getByRole('toolbar', { name: 'Selected chats' });
    expect(bar.textContent).toContain('2 selected');
    // Modified clicks select; they do not open.
    expect(app.tabs.open).toEqual([]);

    await fireEvent.click(row('b'), { ctrlKey: true });
    expect(selectedIds()).toEqual(['d']);

    // A range from the last Ctrl/Cmd+clicked chat (b) replaces the selection, either way.
    await fireEvent.click(row('a'), { shiftKey: true });
    expect(selectedIds()).toEqual(['a', 'b']);
    await fireEvent.click(row('d'), { shiftKey: true });
    expect(selectedIds()).toEqual(['b', 'c', 'd']);

    screen.getByRole('listbox').focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('toolbar', { name: 'Selected chats' })).toBeNull();
    expect(selectedIds().length).toBeLessThanOrEqual(1); // only the cursor, if any

    // A plain click opens the chat and drops any selection.
    await fireEvent.click(row('b'), { ctrlKey: true });
    await fireEvent.click(row('c'));
    expect(app.tabs.active).toBe('c');
    expect(screen.queryByRole('toolbar', { name: 'Selected chats' })).toBeNull();
  });

  it('Ctrl+A selects the section under the cursor', async () => {
    const { context } = await withList([
      ...four(),
      summary('old', { lastActivity: Date.now() - 90 * DAY_MS }),
    ]);
    render(BucketsHarness, { context });
    const list = screen.getByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(5));
    list.focus();
    await userEvent.keyboard('{ArrowDown}{Control>}a{/Control}');
    expect(selectedIds()).toEqual(['a', 'b', 'c', 'd']);
    await userEvent.keyboard('{End}{Control>}a{/Control}');
    expect(selectedIds()).toEqual(['old']);
  });

  it('the bar acts on the selection and reports the chats it skipped', async () => {
    const { server, context } = await withList(four(), { skip: { c: 'LIVE' } });
    render(BucketsHarness, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    await fireEvent.click(row('b'), { ctrlKey: true });
    await fireEvent.click(row('c'), { ctrlKey: true });
    const bar = screen.getByRole('toolbar', { name: 'Selected chats' });

    await userEvent.click(within(bar).getByRole('button', { name: 'Make active' }));
    await waitFor(() =>
      expect(setCalls(server)).toEqual([{ sessionIds: ['b', 'c'], bucket: 'active' }]),
    );
    expect(screen.queryByRole('toolbar', { name: 'Selected chats' })).toBeNull();

    await fireEvent.click(row('b'), { ctrlKey: true });
    await fireEvent.click(row('c'), { ctrlKey: true });
    await userEvent.click(
      within(screen.getByRole('toolbar', { name: 'Selected chats' })).getByRole('button', {
        name: 'Archive',
      }),
    );
    await waitFor(() =>
      expect(setCalls(server).at(-1)).toEqual({ sessionIds: ['b', 'c'], bucket: 'archived' }),
    );
    // No "end it?" question in bulk: the skipped chat is reported.
    const status = await screen.findByText(/not archived because Threadgarden is running/i);
    expect(status.closest('[role="status"]')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // Put on hold… opens the popover for the selection; Clear empties it.
    await fireEvent.click(row('a'), { ctrlKey: true });
    await fireEvent.click(row('d'), { ctrlKey: true });
    await userEvent.click(
      within(screen.getByRole('toolbar', { name: 'Selected chats' })).getByRole('button', {
        name: 'Put on hold…',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Put on hold' });
    expect(within(dialog).getByText(/2 chats/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('radio', { name: /no date/i }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(setCalls(server).at(-1)).toEqual({ sessionIds: ['a', 'd'], bucket: 'onHold' }),
    );
    // Saving cleared the selection.
    expect(screen.queryByRole('toolbar', { name: 'Selected chats' })).toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe('none'));

    await fireEvent.click(row('a'), { ctrlKey: true });
    await userEvent.click(
      within(screen.getByRole('toolbar', { name: 'Selected chats' })).getByRole('button', {
        name: 'Clear selection',
      }),
    );
    expect(screen.queryByRole('toolbar', { name: 'Selected chats' })).toBeNull();
  });

  it("a row's menu acts on the selection when the row is in it, else on that row alone", async () => {
    const { server, context } = await withList(four());
    render(BucketsHarness, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    await fireEvent.click(row('a'), { ctrlKey: true });
    await fireEvent.click(row('b'), { ctrlKey: true });

    await fireEvent.contextMenu(row('d'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() =>
      expect(setCalls(server)).toEqual([{ sessionIds: ['d'], bucket: 'archived' }]),
    );
    expect(selectedIds()).toEqual(['a', 'b']);

    await fireEvent.contextMenu(row('b'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() =>
      expect(setCalls(server).at(-1)).toEqual({ sessionIds: ['a', 'b'], bucket: 'archived' }),
    );
    expect(screen.queryByRole('toolbar', { name: 'Selected chats' })).toBeNull();
  });

  it('E archives the whole selection', async () => {
    const { server, context } = await withList(four());
    render(BucketsHarness, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    await fireEvent.click(row('a'), { ctrlKey: true });
    await fireEvent.click(row('c'), { ctrlKey: true });
    screen.getByRole('listbox').focus();
    await userEvent.keyboard('e');
    await waitFor(() =>
      expect(setCalls(server)).toEqual([{ sessionIds: ['a', 'c'], bucket: 'archived' }]),
    );
  });
});

describe('"Archive all older than 30 days"', () => {
  it('is offered on the Older header; the confirmation shows the count', async () => {
    const { server, context } = await withList([
      summary('new'),
      summary('old', { lastActivity: Date.now() - 90 * DAY_MS }),
    ]);
    render(BucketsHarness, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    const older = document.querySelector('[data-section-header="older"]:not([data-sticky])')!;
    const button = within(older as HTMLElement).getByRole('button', {
      name: 'Archive all older than 30 days',
      hidden: true,
    });
    await userEvent.click(button);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Archive 12 chats older than 30 days?')).toBeTruthy();
    // Ruling R35: the count leaves pinned chats out, and the dialog says so.
    expect(dialog.textContent).toMatch(/Pinned chats, and chats that are running/);
    expect(server.calls('chat.archiveOlder').map((c) => c.params)).toEqual([
      { olderThanDays: 30, dryRun: true },
    ]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Archive 12 chats' }));
    await waitFor(() =>
      expect(server.calls('chat.archiveOlder').at(-1)!.params).toEqual({ olderThanDays: 30 }),
    );
    // What it did is said (the count can differ from the dry run's).
    expect((await screen.findByText('Archived 12 chats.')).closest('[role="status"]')).toBeTruthy();
  });

  it('is not offered in On hold or Archived', async () => {
    const { app, context } = await withList([
      summary('old', { lastActivity: Date.now() - 90 * DAY_MS, bucket: 'archived' }),
    ]);
    app.places.select({ kind: 'archived' });
    render(BucketsHarness, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(
      screen.queryByRole('button', { name: 'Archive all older than 30 days', hidden: true }),
    ).toBeNull();
  });
});

describe('chat header: state menu and hold details', () => {
  it('shows until and the note, and moves the chat', async () => {
    freezeDate();
    const held = summary('h', {
      bucket: 'onHold',
      holdUntil: local(2026, 11, 1, 9),
      holdNote: 'waiting for review',
    });
    const { app, server, context } = await withList([], {
      configure: (server) => {
        server.handlers['chat.open'] = () => ({
          summary: held,
          header: {},
          items: [],
          hasMore: false,
          seq: 1,
        });
      },
    });
    await app.chats.open('h');
    render(BucketsHarness, { context, props: { chat: app.chats.get('h')! } });
    const banner = screen.getByRole('banner');
    expect(banner.textContent).toContain('On hold until tomorrow 09:00');
    expect(within(banner).getByText('waiting for review')).toBeTruthy();

    expect(await openStateMenu()).toEqual(['Make active', 'Put on hold…', 'Archive']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Make active' }));
    await waitFor(() =>
      expect(setCalls(server)).toEqual([{ sessionIds: ['h'], bucket: 'active' }]),
    );
  });

  it('archiving the open live chat asks to end it first', async () => {
    const { app, server, context } = await withList([], {
      skip: { s: 'LIVE' },
      configure: (server) => {
        server.handlers['chat.open'] = () => ({
          summary: summary('s', { live: true, status: 'idle' }),
          header: {},
          items: [],
          hasMore: false,
          seq: 1,
        });
      },
    });
    await app.chats.open('s');
    render(BucketsHarness, { context, props: { chat: app.chats.get('s')! } });
    expect(await openStateMenu()).toEqual(['Put on hold…', 'Archive']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'End and archive' }));
    await waitFor(() => expect(server.calls('chat.end')).toHaveLength(1));
    await waitFor(() => expect(setCalls(server)).toHaveLength(2));
  });
});

describe('Ctrl+K: archived matches', () => {
  it('come last, in their own "Archived" group', async () => {
    const { context } = await setup((server) => {
      server.handlers['search.quick'] = () => ({
        items: [
          { sessionId: 'a', title: 'alpha plan', projectName: 'alpha', score: 3 },
          {
            sessionId: 'z',
            title: 'old plan',
            projectName: 'alpha',
            score: 2,
            archived: true,
          },
        ],
      });
    });
    render(QuickSwitcher, { context });
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(await screen.findByRole('combobox'), 'plan');
    const group = await screen.findByRole('group', { name: 'Archived' });
    expect(
      within(group)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([expect.stringContaining('old plan')]);
    const all = screen.getAllByRole('option');
    expect(all[0]!.textContent).toContain('alpha plan');
    expect(all.at(-1)!.textContent).toContain('old plan');
    // Arrow keys reach it like any other result.
    await userEvent.keyboard('{ArrowUp}');
    expect(all.at(-1)!.getAttribute('aria-selected')).toBe('true');
  });

  it('"Archive chats older than 30 days…" is a command for the Active place', async () => {
    const { server, context } = await setup((server) => {
      server.handlers['search.quick'] = () => ({ items: [] });
      server.handlers['chat.archiveOlder'] = () => ({ archived: 4 });
    });
    render(BucketsHarness, { context });
    render(QuickSwitcher, { context });
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(await screen.findByRole('combobox'), 'older');
    await userEvent.click(await screen.findByRole('option', { name: /archive chats older/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Archive 4 chats older than 30 days?')).toBeTruthy();
    expect(server.calls('chat.archiveOlder')[0]!.params).toEqual({
      olderThanDays: 30,
      dryRun: true,
    });
  });
});

describe('review fixes (v1.2 B2 round 1)', () => {
  const live = (over: Partial<ChatSummary> = {}) =>
    summary('a', { live: true, status: 'idle', title: 'busy chat', ...over });

  const archiveFromMenu = async () => {
    await fireEvent.contextMenu(await screen.findByRole('option'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    return screen.findByRole('alertdialog');
  };

  it('"End this chat and archive it?" says a running turn is stopped (as End session does)', async () => {
    const { context } = await withList([live({ status: 'working' })], { skip: { a: 'LIVE' } });
    render(BucketsHarness, { context });
    const dialog = await archiveFromMenu();
    expect(dialog.textContent).toContain('Claude is still working in this chat');
    expect(dialog.textContent).toContain('Ending stops the current turn');
  });

  it('and says its background tasks are stopped', async () => {
    const { context } = await withList([live({ runningTasks: 2 })], { skip: { a: 'LIVE' } });
    render(BucketsHarness, { context });
    const dialog = await archiveFromMenu();
    expect(dialog.textContent).toContain('This chat still runs 2 background tasks');
  });

  it('a failed chat.end keeps the confirmation open with the error, and archives nothing', async () => {
    const { server, context } = await withList([live()], {
      skip: { a: 'LIVE' },
      configure: (server) => {
        server.handlers['chat.end'] = () => {
          throw new RpcFail('INTERNAL', 'cannot end');
        };
      },
    });
    render(BucketsHarness, { context });
    const dialog = await archiveFromMenu();
    await userEvent.click(within(dialog).getByRole('button', { name: 'End and archive' }));
    expect(await within(dialog).findByText(/cannot end/)).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(setCalls(server)).toHaveLength(1);
  });

  it('E, H and A typed in the search field move nothing', async () => {
    const { server, context } = await withList(four());
    render(BucketsHarness, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    await userEvent.type(screen.getByRole('searchbox'), 'heat');
    await new Promise((r) => setTimeout(r, 30));
    expect(setCalls(server)).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a held-down E (key repeat) and Shift+E do nothing more', async () => {
    const { server, context } = await withList(four());
    render(BucketsHarness, { context });
    const list = screen.getByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(4));
    list.focus();
    await userEvent.keyboard('{ArrowDown}');
    await fireEvent.keyDown(list, { key: 'e' });
    await fireEvent.keyDown(list, { key: 'e', repeat: true });
    await fireEvent.keyDown(list, { key: 'E', shiftKey: true });
    await waitFor(() => expect(setCalls(server)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(setCalls(server)).toHaveLength(1);
  });

  it('Shift+click ranges across sections and across a loaded page', async () => {
    const old = (id: string) => summary(id, { lastActivity: Date.now() - 90 * DAY_MS });
    const { context } = await withList([], {
      configure: (server) => {
        server.handlers['sessions.list'] = (p) =>
          (p as { cursor?: string }).cursor
            ? { items: [old('p2a'), old('p2b')] }
            : {
                items: [summary('n1', { status: 'working', live: true }), summary('d1'), old('o1')],
                nextCursor: 'next',
              };
      },
    });
    render(BucketsHarness, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(5));
    await fireEvent.click(row('n1'), { ctrlKey: true });
    await fireEvent.click(row('p2b'), { shiftKey: true });
    expect(selectedIds()).toEqual(['n1', 'd1', 'o1', 'p2a', 'p2b']);
  });

  it('a selected chat that leaves the list leaves the selection', async () => {
    let items = four();
    const { server, context } = await withList([], {
      configure: (server) => {
        server.handlers['sessions.list'] = () => ({ items });
      },
    });
    render(BucketsHarness, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    await fireEvent.click(row('b'), { ctrlKey: true });
    await fireEvent.click(row('c'), { ctrlKey: true });
    items = items.filter((c) => c.sessionId !== 'b');
    server.push('sessions.changed', { sessionIds: ['b'] });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    expect(selectedIds()).toEqual(['c']);
    expect(screen.getByRole('toolbar', { name: 'Selected chats' }).textContent).toContain(
      '1 selected',
    );
  });

  it('Ctrl+A without a cursor selects the first section', async () => {
    const { context } = await withList([
      ...four(),
      summary('old', { lastActivity: Date.now() - 90 * DAY_MS }),
    ]);
    render(BucketsHarness, { context });
    const list = screen.getByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(5));
    list.focus();
    await userEvent.keyboard('{Control>}a{/Control}');
    expect(selectedIds()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('the keyboard cursor stays marked while chats are selected; Shift+Space toggles it', async () => {
    const { context } = await withList(four());
    render(BucketsHarness, { context });
    const list = screen.getByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(4));
    await fireEvent.click(row('a'), { ctrlKey: true });
    list.focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(list.getAttribute('aria-activedescendant')).toBe('chat-row-c');
    expect(row('c').hasAttribute('data-cursor')).toBe(true);
    expect(row('a').hasAttribute('data-cursor')).toBe(false);
    await userEvent.keyboard('{Shift>} {/Shift}');
    expect(selectedIds()).toEqual(['a', 'c']);
    await userEvent.keyboard('{Shift>} {/Shift}');
    expect(selectedIds()).toEqual(['a']);
  });

  it('"Archive all…" does not take focus from the list (its header is hidden)', async () => {
    const { context } = await withList([
      summary('old', { lastActivity: Date.now() - 90 * DAY_MS }),
    ]);
    render(BucketsHarness, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    const button = screen.getByRole('button', {
      name: 'Archive all older than 30 days',
      hidden: true,
    });
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('a chat back from hold keeps its recency section in Active (Ruling R34)', async () => {
    const { context } = await withList([
      summary('new'),
      summary('back', { backFromHold: true, lastActivity: Date.now() - 90 * DAY_MS }),
    ]);
    render(BucketsHarness, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    const ref = row('back').getAttribute('aria-describedby')!;
    expect(document.getElementById(ref)!.textContent!.trim()).toBe('Older');
    expect(within(row('back')).getByText('Back from hold')).toBeTruthy();
  });

  it('Save recomputes the presets: a dialog left open past midnight holds until the new tomorrow', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(local(2026, 10, 31, 23, 59));
    const { server, context } = await withList([summary('a')]);
    render(BucketsHarness, { context });
    await fireEvent.contextMenu(await screen.findByRole('option'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Put on hold…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Put on hold' });
    vi.setSystemTime(local(2026, 11, 1, 0, 1));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(setCalls(server)).toEqual([
        { sessionIds: ['a'], bucket: 'onHold', holdUntil: local(2026, 11, 2, 9) },
      ]),
    );
  });
});
