import type { ChatSummary } from '@threadgarden/protocol';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AgentsStrip from '../../src/lib/components/layout/AgentsStrip.svelte';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import { startAttention } from '../../src/lib/notifications';
import { askArchiveOlderIn, MergedList } from '../../src/lib/state/merged-list.svelte';
import type { Place } from '../../src/lib/state/places.svelte';
import BucketsHarness from '../layout/BucketsHarness.svelte';
import { LOCAL, M1, project, setupTwoMachines, summary } from '../layout/harness';
import { RpcFail, type FakeServer } from '../service/fake-ws';

type ListParams = { place: { kind: string }; limit: number; cursor?: string; query?: string };

const flush = () => new Promise((r) => setTimeout(r, 20));

const keys = (list: { items: { machineId: string; sessionId: string }[] }): string[] =>
  list.items.map((c) => `${c.machineId}/${c.sessionId}`);

/** `sessions.list` answering `items` for the bucket place `kind`, in pages of the asked size (cursor: an offset). */
const paged =
  (items: ChatSummary[], kind = 'active') =>
  (p: unknown) => {
    const { place, limit, cursor } = p as ListParams;
    if (place.kind !== kind) return { items: [] };
    const start = cursor ? Number(cursor) : 0;
    const end = start + limit;
    return {
      items: items.slice(start, end),
      ...(end < items.length ? { nextCursor: String(end) } : {}),
    };
  };

/** The cursors `server` was asked with for `kind` (requests without one left out). */
const cursors = (server: FakeServer, kind = 'active'): string[] =>
  server
    .calls('sessions.list')
    .map((c) => c.params as ListParams)
    .filter((p) => p.place.kind === kind && p.cursor !== undefined)
    .map((p) => p.cursor!);

const at = (sessionId: string, lastActivity: number, over: Partial<ChatSummary> = {}) =>
  summary(sessionId, { lastActivity, ...over });

const twoMachines = async (local: ChatSummary[], remote: ChatSummary[], kind = 'active') => {
  const env = await setupTwoMachines({
    configure: (s) => (s.handlers['sessions.list'] = paged(local, kind)),
    configureRemote: (s) => (s.handlers['sessions.list'] = paged(remote, kind)),
  });
  const make = (place: Place = { kind: 'active' } as Place, pageSize?: number) =>
    new MergedList(() => env.app.scopes.all(), place, {
      machines: env.app.machines,
      ...(pageSize ? { pageSize } : {}),
    });
  return { ...env, make };
};

describe('merged lists across machines', () => {
  it('merges two machines by last activity and keeps both copies of one id', async () => {
    const { make } = await twoMachines([at('s1', 30), at('s2', 10)], [at('s1', 20)]);
    const list = make();
    await list.reload();
    expect(keys(list)).toEqual([`${LOCAL}/s1`, `${M1}/s1`, `${LOCAL}/s2`]);
    expect(list.skipped).toEqual([]);
    expect(list.nextAvailable).toBe(false);
    expect(list.loading).toBe(false);
    expect(list.error).toBeNull();
  });

  it('pages each machine with its own cursor', async () => {
    const remote = [at('m1', 90), at('m2', 80), at('m3', 70), at('m4', 60), at('m5', 50)];
    const { make, server, remote: rs } = await twoMachines([at('a', 100), at('b', 5)], remote);
    const list = make({ kind: 'active' }, 2);
    await list.reload();
    // M1's next chat could be newer than b: the list stops where M1's page ends.
    expect(keys(list)).toEqual([`${LOCAL}/a`, `${M1}/m1`, `${M1}/m2`]);
    expect(list.nextAvailable).toBe(true);
    await list.loadMore();
    expect(keys(list).slice(3)).toEqual([`${M1}/m3`, `${M1}/m4`]);
    await list.loadMore();
    expect(keys(list).slice(5)).toEqual([`${M1}/m5`, `${LOCAL}/b`]);
    expect(list.nextAvailable).toBe(false);
    expect(cursors(rs)).toEqual(['2', '4']);
    // This PC's buffered chat needed no second page.
    expect(cursors(server)).toEqual([]);
    await list.loadMore();
    expect(cursors(rs)).toEqual(['2', '4']);
  });

  it('skips an unreachable machine and says which', async () => {
    const { make, remote, app } = await twoMachines([at('s1', 30)], [at('r1', 20)]);
    remote.refuse = true;
    remote.drop();
    await vi.waitFor(() => expect(app.machines.get(M1)?.status).toBe('unreachable'));
    const list = make();
    await list.reload();
    expect(keys(list)).toEqual([`${LOCAL}/s1`]);
    expect(list.skipped).toEqual(['Ubuntu PC']);
    expect(list.error).toBeNull();
  });

  it('skips a machine whose list fails', async () => {
    const { make, remote } = await twoMachines([at('s1', 30)], []);
    remote.handlers['sessions.list'] = () => {
      throw new RpcFail('INTERNAL', 'boom');
    };
    const list = make();
    await list.reload();
    expect(keys(list)).toEqual([`${LOCAL}/s1`]);
    expect(list.skipped).toEqual(['Ubuntu PC']);
  });

  it('a newer reload wins over an older one still in flight', async () => {
    const { make, remote } = await twoMachines([at('s1', 30)], [at('old', 20)]);
    let release!: () => void;
    remote.handlers['sessions.list'] = () =>
      new Promise((resolve) => (release = () => resolve({ items: [at('old', 20)] })));
    const list = make();
    const first = list.reload();
    await flush();
    remote.handlers['sessions.list'] = () => ({ items: [at('new', 20)] });
    await list.reload();
    release();
    await first;
    expect(keys(list)).toEqual([`${LOCAL}/s1`, `${M1}/new`]);
  });

  it('drops a machine that goes off while its list is asked for, and forgets one removed', async () => {
    const { make, remote, app } = await twoMachines([at('s1', 30)], []);
    let release!: () => void;
    remote.handlers['sessions.list'] = () =>
      new Promise((resolve) => (release = () => resolve({ items: [at('r1', 20)] })));
    const list = make();
    const done = list.reload();
    await flush();
    // Its answer still arrives, but the machine is no longer on.
    app.machines.get(M1)!.status = 'unreachable';
    release();
    await done;
    expect(keys(list)).toEqual([`${LOCAL}/s1`]);
    expect(list.skipped).toEqual(['Ubuntu PC']);
    // A removed machine is not missing anything.
    await app.machines.remove(M1);
    expect(list.skipped).toEqual([]);
  });

  it('lists the chats waiting on the user first, from every machine', async () => {
    const local = [at('l-wait', 10, { status: 'needsYou' }), at('l-unread', 50, { unread: true })];
    const remote = [at('r-wait', 20, { status: 'needsYou' }), at('r-unread', 40, { unread: true })];
    const { make } = await twoMachines(local, remote, 'needsYou');
    const list = make({ kind: 'needsYou' });
    await list.reload();
    expect(keys(list)).toEqual([
      `${M1}/r-wait`,
      `${LOCAL}/l-wait`,
      `${LOCAL}/l-unread`,
      `${M1}/r-unread`,
    ]);
  });

  it("refetches on a machine's changes and when a machine connects or drops", async () => {
    const { make, remote, app } = await twoMachines([at('s1', 30)], [at('r1', 20)]);
    // Its own page size tells its requests from those of M1's other stores.
    const list = make({ kind: 'active' }, 7);
    const mine = () =>
      remote.calls('sessions.list').filter((c) => (c.params as ListParams).limit === 7);
    const stop = list.watch(app.scopes);
    await list.reload();
    expect(keys(list)).toEqual([`${LOCAL}/s1`, `${M1}/r1`]);

    remote.handlers['sessions.list'] = paged([at('r1', 20), at('r2', 10)]);
    remote.push('sessions.changed', { sessionIds: ['r2'] });
    await vi.waitFor(() => expect(keys(list)).toContain(`${M1}/r2`));

    remote.refuse = true;
    remote.drop();
    await vi.waitFor(() => expect(list.skipped).toEqual(['Ubuntu PC']));
    expect(keys(list)).toEqual([`${LOCAL}/s1`]);

    remote.refuse = false;
    await vi.waitFor(() => expect(keys(list)).toContain(`${M1}/r1`), { timeout: 8000 });
    expect(list.skipped).toEqual([]);

    stop();
    const asked = mine().length;
    remote.push('sessions.changed', { sessionIds: ['r2'] });
    await flush();
    expect(mine()).toHaveLength(asked);
  }, 15_000);
});

describe('Needs you, Running and the agents strip across machines', () => {
  it('sums Needs you across machines for the badge and tray', async () => {
    const counts = (needsYou: number, running: number) => () => ({
      needsYou,
      running,
      all: 4,
      active: 4,
      onHold: 1,
      archived: 2,
    });
    const { app, remote } = await setupTwoMachines({
      configure: (s) => (s.handlers['places.counts'] = counts(2, 1)),
      configureRemote: (s) => (s.handlers['places.counts'] = counts(3, 4)),
    });
    const setTrayNeedsYou = vi.fn(async () => {});
    const stop = startAttention({
      scopes: app.scopes,
      machines: app.machines,
      settings: app.settings,
      tabs: app.tabs,
      places: app.places,
      notify: vi.fn(async () => {}),
      setTrayNeedsYou,
    });
    await app.places.refresh();
    await vi.waitFor(() => expect(app.places.counts.needsYou).toBe(5));
    expect(app.places.counts).toMatchObject({ running: 5, active: 8, onHold: 2, archived: 4 });
    expect(setTrayNeedsYou).toHaveBeenLastCalledWith(5);
    // A machine that drops leaves the sum.
    remote.refuse = true;
    remote.drop();
    await vi.waitFor(() => expect(setTrayNeedsYou).toHaveBeenLastCalledWith(2));
    expect(app.places.counts.needsYou).toBe(2);
    stop();
  });

  it('lists every machine’s agents, the same id on two machines twice', async () => {
    const live = (id: string, status: ChatSummary['status'], t: number) =>
      at(id, t, { status, live: true });
    const { app } = await setupTwoMachines({
      configure: (s) =>
        (s.handlers['sessions.list'] = (p) =>
          (p as ListParams).place.kind === 'needsYou'
            ? { items: [live('s1', 'needsYou', 10)] }
            : { items: [] }),
      configureRemote: (s) =>
        (s.handlers['sessions.list'] = (p) => {
          const kind = (p as ListParams).place.kind;
          if (kind === 'needsYou') return { items: [live('s1', 'needsYou', 20)] };
          if (kind === 'running') return { items: [live('w', 'working', 5)] };
          return { items: [] };
        }),
    });
    await app.agents.refresh();
    await vi.waitFor(() => expect(app.agents.items).toHaveLength(3));
    expect(keys(app.agents)).toEqual([`${M1}/s1`, `${LOCAL}/s1`, `${M1}/w`]);
    expect(app.agents.needsYou).toBe(2);
    // Restart and quit stop This PC's chats only: they list This PC's.
    expect(app.lifecycle.running.map((a) => a.sessionId)).toEqual(['s1']);
  });
});

describe('the chat list across machines', () => {
  it('shows both machines’ chats of a cross-machine place, and names a missing machine', async () => {
    const { context, remote, app } = await setupTwoMachines({
      configure: (s) => (s.handlers['sessions.list'] = paged([at('s1', 30), at('s2', 10)])),
      configureRemote: (s) => (s.handlers['sessions.list'] = paged([at('s1', 20)])),
    });
    render(ChatList, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    expect(screen.getAllByRole('option').map((o) => o.id)).toEqual([
      'chat-row-s1',
      `chat-row-${M1}/s1`,
      'chat-row-s2',
    ]);

    remote.refuse = true;
    remote.drop();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(screen.getByText('Ubuntu PC is unreachable — its chats are missing here')).toBeTruthy();
    expect(app.machines.get(M1)?.status).toBe('unreachable');
  });

  it('opens a chat of another machine with its machine', async () => {
    const { context, app } = await setupTwoMachines({
      configureRemote: (s) => (s.handlers['sessions.list'] = paged([at('r1', 20)])),
    });
    render(ChatList, { context });
    const row = await screen.findByRole('option');
    row.click();
    expect(app.tabs.active).toBe(`${M1}/r1`);
  });
});

type SetParams = { sessionIds: string[]; bucket: string };

/** Calls of `method` whose params match `pick` (the stores of a machine share its server). */
const callsOf = (
  server: FakeServer,
  method: string,
  pick: (p: ListParams) => boolean = () => true,
) => server.calls(method).filter((c) => pick(c.params as ListParams));

describe('moving another machine’s chats (fix round 1)', () => {
  /** M1 lists `items` everywhere and answers bucket moves; This PC lists nothing. */
  const remoteList = (items: ChatSummary[], configure?: (s: FakeServer) => void) =>
    setupTwoMachines({
      configureRemote: (s) => {
        s.handlers['sessions.list'] = () => ({ items });
        s.handlers['chat.setBucket'] = (p) => ({
          updated: (p as SetParams).sessionIds.length,
          skipped: [],
        });
        configure?.(s);
      },
    });

  const cursorOnFirst = async (): Promise<void> => {
    const list = screen.getByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1));
    list.focus();
    await userEvent.keyboard('{ArrowDown}');
  };

  it('H holds a chat of Ubuntu PC through Ubuntu PC', async () => {
    const { context, server, remote } = await remoteList([at('r1', 20, { title: 'remote chat' })]);
    render(BucketsHarness, { context });
    await cursorOnFirst();
    await userEvent.keyboard('h');
    const dialog = await screen.findByRole('dialog', { name: 'Put on hold' });
    expect(within(dialog).getByText(/remote chat/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(callsOf(remote, 'chat.setBucket').map((c) => c.params as SetParams)).toMatchObject([
        { sessionIds: ['r1'], bucket: 'onHold' },
      ]),
    );
    expect(server.calls('chat.setBucket')).toHaveLength(0);
  });

  it('E on a live chat of Ubuntu PC asks to end it there, then archives it there', async () => {
    let ended = false;
    const { context, server, remote } = await remoteList(
      [at('r1', 20, { live: true, status: 'idle' })],
      (s) => {
        s.handlers['chat.setBucket'] = (p) => {
          const { sessionIds } = p as SetParams;
          return ended
            ? { updated: 1, skipped: [] }
            : { updated: 0, skipped: [{ sessionId: sessionIds[0], reason: 'LIVE' }] };
        };
        s.handlers['chat.end'] = () => {
          ended = true;
          return {};
        };
      },
    );
    render(BucketsHarness, { context });
    await cursorOnFirst();
    await userEvent.keyboard('e');
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('End this chat and archive it?')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'End and archive' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(remote.calls('chat.end')).toHaveLength(1);
    expect(remote.calls('chat.setBucket')).toHaveLength(2);
    expect(server.calls('chat.end')).toHaveLength(0);
    expect(server.calls('chat.setBucket')).toHaveLength(0);
  });

  it("shows Ubuntu PC's notice, naming the machine", async () => {
    const { context } = await remoteList([at('r1', 20)], (s) => {
      s.handlers['chat.setBucket'] = () => {
        throw new RpcFail('INTERNAL', 'disk full');
      };
    });
    render(BucketsHarness, { context });
    await cursorOnFirst();
    await userEvent.keyboard('e');
    expect(
      await screen.findByText('Ubuntu PC: Could not archive the chat: disk full'),
    ).toBeTruthy();
  });

  it('archives older chats in Active on every connected machine, after one summed count', async () => {
    const older = (n: number) => () => ({ archived: n });
    const { context, app, server, remote } = await setupTwoMachines({
      configure: (s) => (s.handlers['chat.archiveOlder'] = older(3)),
      configureRemote: (s) => (s.handlers['chat.archiveOlder'] = older(4)),
    });
    render(BucketsHarness, { context });
    await askArchiveOlderIn({ kind: 'active' }, app.scopes);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Archive 7 chats older than 30 days?')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Archive 7 chats' }));
    await waitFor(() => expect(app.buckets.notice).toBe('Archived 7 chats.'));
    for (const s of [server, remote]) {
      expect(s.calls('chat.archiveOlder').map((c) => c.params)).toEqual([
        { olderThanDays: 30, dryRun: true },
        { olderThanDays: 30 },
      ]);
    }
  });
});

describe('Stop all work across machines (fix round 1)', () => {
  it('stops every connected machine and says so; restart and quit stay This PC’s', async () => {
    const { context, app, server, remote } = await setupTwoMachines({
      configure: (s) => (s.handlers['work.stopAll'] = () => ({ stopped: 0 })),
      configureRemote: (s) => {
        s.handlers['work.stopAll'] = () => ({ stopped: 1 });
        s.handlers['sessions.list'] = (p) =>
          (p as ListParams).place.kind === 'running'
            ? { items: [at('w', 5, { status: 'working', live: true, title: 'remote work' })] }
            : { items: [] };
      },
    });
    render(AgentsStrip, { context });
    const stop = await screen.findByRole('button', { name: 'Stop all work' });
    // Only Ubuntu PC runs something: the button is enabled all the same.
    await waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(stop);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain(
      'Every chat running in Threadgarden on This PC and Ubuntu PC is interrupted and closed',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop all work' }));
    await waitFor(() => expect(remote.calls('work.stopAll')).toHaveLength(1));
    expect(server.calls('work.stopAll')).toHaveLength(1);
    expect(app.lifecycle.runningEverywhere.map((a) => a.sessionId)).toEqual(['w']);
    expect(app.lifecycle.running).toEqual([]);
  });
});

describe('what the merged list shows and asks (fix round 1)', () => {
  it('does not name a machine that is still connecting', async () => {
    const { app } = await setupTwoMachines({
      waitForOn: false,
      configureRemote: (s) => s.silent.add('hello'),
    });
    await vi.waitFor(() => expect(app.machines.get(M1)?.status).toBe('connecting'));
    const list = new MergedList(
      () => app.scopes.all(),
      { kind: 'active' },
      {
        machines: app.machines,
      },
    );
    await list.reload();
    expect(list.skipped).toEqual([]);
    app.machines.get(M1)!.status = 'unreachable';
    expect(list.skipped).toEqual(['Ubuntu PC']);
  });

  it("leaves the cross-machine places to the merged list: This PC's and M1's own lists do not ask", async () => {
    const { app, server, remote } = await setupTwoMachines({
      configure: (s) => (s.handlers['projects.list'] = () => [project('p1', 'alpha')]),
    });
    const listed = (s: FakeServer, kind: string) =>
      callsOf(s, 'sessions.list', (p) => p.place.kind === kind && p.limit === 50).length;
    // Lists of 50 for Active are only ever a `sessions` (or merged list) page.
    expect(listed(remote, 'active')).toBe(0);
    app.places.select({ kind: 'running' });
    await flush();
    expect(listed(server, 'running')).toBe(0);
    // A project is still This PC's to list.
    app.places.select({ kind: 'project', projectId: 'p1' });
    await vi.waitFor(() => expect(listed(server, 'project')).toBe(1));
    // Alone again, This PC lists every place.
    app.places.select({ kind: 'running' });
    await app.machines.remove(M1);
    await vi.waitFor(() => expect(listed(server, 'running')).toBe(1));
  });

  it('shows nothing of This PC alone while the merged list waits for its first answer', async () => {
    let release!: () => void;
    const { context, remote } = await setupTwoMachines({
      configure: (s) => (s.handlers['sessions.list'] = paged([at('s1', 30)])),
    });
    remote.handlers['sessions.list'] = (p) =>
      (p as ListParams).limit === 50
        ? new Promise((resolve) => (release = () => resolve({ items: [at('r1', 20)] })))
        : { items: [] };
    render(ChatList, { context });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    await flush();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('listbox').getAttribute('aria-busy')).toBe('true');
    release();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
  });
});
