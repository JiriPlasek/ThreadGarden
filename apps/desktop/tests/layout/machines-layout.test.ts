import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import AgentsStrip from '../../src/lib/components/layout/AgentsStrip.svelte';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import QuickSwitcher from '../../src/lib/components/QuickSwitcher.svelte';
import { machineState } from '../../src/lib/components/layout/MachineHeading.svelte';
import type { MachineStatus } from '../../src/lib/state/machines.svelte';
import { mergeQuickHits } from '../../src/lib/state/quick-search';
import { RpcFail, type FakeServer } from '../service/fake-ws';
import { LOCAL, M1, project, setup, setupTwoMachines, summary } from './harness';

type ListParams = { place: { kind: string; projectId?: string } };

/** The projects both fake services list: the same project id on both machines. */
const projects = (local: FakeServer, remote: FakeServer): void => {
  local.handlers['projects.list'] = () => [project('p1', 'alpha')];
  remote.handlers['projects.list'] = () => [project('p1', 'tg-cli'), project('p2', 'infra')];
};

const twoMachines = (o: { m1Status?: 'on' | 'mismatch' | 'refused' | 'locked' } = {}) => {
  let local: FakeServer | undefined;
  return setupTwoMachines({
    ...o,
    configure: (s) => (local = s),
    configureRemote: (s) => projects(local!, s),
  });
};

/** A machine's group in the places column. */
const groupOf = (name: string): HTMLElement => screen.getByRole('group', { name });

const listCalls = (server: FakeServer, projectId: string) =>
  server
    .calls('sessions.list')
    .map((c) => c.params as ListParams)
    .filter((p) => p.place.kind === 'project' && p.place.projectId === projectId);

describe('places column with machines', () => {
  it('shows one group per machine with its state', async () => {
    const { context } = await twoMachines({ m1Status: 'on' });
    render(PlacesColumn, { context });
    expect(await screen.findByRole('heading', { name: /this pc/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /ubuntu pc/i })).toBeTruthy();
    // This PC first.
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings[0]).toMatch(/this pc/i);
    expect(headings[1]).toMatch(/ubuntu pc/i);
    expect(within(groupOf('Ubuntu PC')).getByText('On')).toBeTruthy();
    expect(
      await within(groupOf('Ubuntu PC')).findByRole('button', { name: /tg-cli/i }),
    ).toBeTruthy();
    expect(within(groupOf('This PC')).getByRole('button', { name: /alpha/i })).toBeTruthy();
    expect(within(groupOf('This PC')).queryByRole('button', { name: /tg-cli/i })).toBeNull();
  });

  it('says why a machine needs attention, and links to Settings', async () => {
    const { context, app } = await twoMachines({ m1Status: 'mismatch' });
    render(PlacesColumn, { context });
    const group = await waitFor(() => groupOf('Ubuntu PC'));
    const label = within(group).getByText('Needs attention');
    expect(label.getAttribute('title')).toBe('This address answers as a different machine');
    expect(within(group).queryByText('On')).toBeNull();
    await userEvent.click(within(group).getByRole('button', { name: /open settings/i }));
    expect(app.interaction.settingsOpen).toBe(true);
  });

  it('names the machine a refused device was removed on', async () => {
    const { context } = await twoMachines({ m1Status: 'refused' });
    render(PlacesColumn, { context });
    const label = await waitFor(() => within(groupOf('Ubuntu PC')).getByText('Needs attention'));
    expect(label.getAttribute('title')).toBe('This device was removed on Ubuntu PC');
  });

  it('collapses a machine group and remembers it', async () => {
    const { context, server } = await twoMachines();
    render(PlacesColumn, { context });
    const toggle = await screen.findByRole('button', { name: 'Ubuntu PC', expanded: true });
    await within(groupOf('Ubuntu PC')).findByRole('button', { name: /tg-cli/i });
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(groupOf('Ubuntu PC')).queryByRole('button', { name: /tg-cli/i })).toBeNull();
    // This PC's projects stay.
    expect(within(groupOf('This PC')).getByRole('button', { name: /alpha/i })).toBeTruthy();
    await waitFor(() =>
      expect(server.calls('uiState.set').map((c) => c.params)).toContainEqual({
        key: 'machines.collapsed',
        value: [M1],
      }),
    );
  });

  it('restores collapsed machine groups', async () => {
    const { context, app } = await setupTwoMachines({
      configure: (s) => {
        s.handlers['uiState.get'] = (p) => ({
          value: (p as { key: string }).key === 'machines.collapsed' ? [M1] : null,
        });
      },
      configureRemote: (s) => (s.handlers['projects.list'] = () => [project('p1', 'tg-cli')]),
    });
    await app.machines.restoreCollapsed();
    render(PlacesColumn, { context });
    expect(await screen.findByRole('button', { name: 'Ubuntu PC', expanded: false })).toBeTruthy();
    expect(within(groupOf('Ubuntu PC')).queryByRole('button', { name: /tg-cli/i })).toBeNull();
  });

  it('pins a project on its own machine', async () => {
    const { context, server, remote } = await twoMachines();
    remote.handlers['projects.update'] = () => ({});
    render(PlacesColumn, { context });
    const item = await within(groupOf('Ubuntu PC')).findByRole('button', { name: /tg-cli/i });
    await userEvent.pointer({ keys: '[MouseRight]', target: item });
    await userEvent.click(await screen.findByRole('menuitem', { name: /pin project/i }));
    await waitFor(() =>
      expect(remote.calls('projects.update').map((c) => c.params)).toEqual([
        { projectId: 'p1', pinned: true },
      ]),
    );
    expect(server.calls('projects.update')).toHaveLength(0);
  });

  it('with This PC alone, the projects heading reads This PC and no machine heading shows', async () => {
    const { context } = await setup((s) => {
      s.handlers['projects.list'] = () => [project('p1', 'alpha')];
    });
    render(PlacesColumn, { context });
    const list = await screen.findByRole('list', { name: 'This PC' });
    expect(await within(list).findByRole('button', { name: /alpha/i })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'This PC' })).toBeNull();
    expect(screen.queryByText('On')).toBeNull();
    expect(screen.queryByRole('button', { name: 'This PC' })).toBeNull();
  });

  it('selecting a project under a machine lists that machine’s chats', async () => {
    const { context, app, server, remote } = await twoMachines();
    remote.handlers['sessions.list'] = (p) =>
      (p as ListParams).place.kind === 'project'
        ? { items: [summary('r1', { title: 'remote work' })] }
        : { items: [] };
    render(PlacesColumn, { context });
    render(ChatList, { context });
    await userEvent.click(
      await within(groupOf('Ubuntu PC')).findByRole('button', { name: /tg-cli/i }),
    );
    expect(app.places.selected).toEqual({ kind: 'project', projectId: 'p1', machineId: M1 });
    expect(await screen.findByRole('option', { name: /remote work/i })).toBeTruthy();
    expect(listCalls(remote, 'p1').length).toBeGreaterThan(0);
    expect(listCalls(server, 'p1')).toHaveLength(0);
    // The same project id on This PC is not the selected one.
    const tg = within(groupOf('Ubuntu PC')).getByRole('button', { name: /tg-cli/i });
    const alpha = within(groupOf('This PC')).getByRole('button', { name: /alpha/i });
    expect(tg.getAttribute('aria-current')).toBe('true');
    expect(alpha.getAttribute('aria-current')).toBeNull();
    // A chat of a machine's project carries no machine chip.
    expect(within(screen.getByRole('option')).queryByText('Ubuntu PC')).toBeNull();
  });
});

describe('machine chips', () => {
  const needsYou = { kind: 'needsYou' } as const;

  it('shows machine chips only with more than one machine', async () => {
    const one = await setup((s) => {
      s.handlers['sessions.list'] = () => ({ items: [summary('a', { status: 'needsYou' })] });
    });
    one.app.places.select(needsYou);
    const { unmount } = render(ChatList, { context: one.context });
    const row = await screen.findByRole('option');
    expect(within(row).queryByText('This PC')).toBeNull();
    unmount();

    const two = await setupTwoMachines({
      configure: (s) =>
        (s.handlers['sessions.list'] = () => ({ items: [summary('a', { status: 'needsYou' })] })),
      configureRemote: (s) =>
        (s.handlers['sessions.list'] = () => ({ items: [summary('b', { status: 'needsYou' })] })),
    });
    two.app.places.select(needsYou);
    render(ChatList, { context: two.context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    const [first, second] = screen.getAllByRole('option');
    const chips = [first!, second!].map((o) =>
      within(o).queryByText('This PC')
        ? 'This PC'
        : within(o).queryByText('Ubuntu PC')?.textContent,
    );
    expect(chips.sort()).toEqual(['This PC', 'Ubuntu PC']);
  });

  it('the agents strip names each agent’s machine', async () => {
    const agent = (sessionId: string) => ({
      items: [summary(sessionId, { status: 'working', live: true, title: `agent ${sessionId}` })],
    });
    const { context } = await setupTwoMachines({
      configure: (s) => (s.handlers['sessions.list'] = () => agent('a')),
      configureRemote: (s) => (s.handlers['sessions.list'] = () => agent('b')),
    });
    render(AgentsStrip, { context });
    const remoteAgent = await screen.findByRole('button', { name: /agent b/i });
    expect(within(remoteAgent).getByText('Ubuntu PC')).toBeTruthy();
    const localAgent = screen.getByRole('button', { name: /agent a/i });
    expect(within(localAgent).getByText('This PC')).toBeTruthy();
  });

  it('the agents strip shows no machine with This PC alone', async () => {
    const { context } = await setup((s) => {
      s.handlers['sessions.list'] = () => ({
        items: [summary('a', { status: 'working', live: true, title: 'agent a' })],
      });
    });
    render(AgentsStrip, { context });
    const localAgent = await screen.findByRole('button', { name: /agent a/i });
    expect(within(localAgent).queryByText('This PC')).toBeNull();
  });
});

type Hit = {
  sessionId: string;
  title: string;
  projectName: string;
  score: number;
  archived?: boolean;
};
const hit = (sessionId: string, score: number, over: Partial<Hit> = {}): Hit => ({
  sessionId,
  title: `Chat ${sessionId}`,
  projectName: 'alpha',
  score,
  ...over,
});

describe('quick switcher across machines', () => {
  it('quick switcher finds chats on every machine', async () => {
    const { context, app, server, remote } = await setupTwoMachines({
      configure: (s) => (s.handlers['search.quick'] = () => ({ items: [hit('s1', 0.5)] })),
      configureRemote: (s) =>
        (s.handlers['search.quick'] = () => ({
          items: [hit('s9', 0.9, { title: 'remote match' })],
        })),
    });
    render(QuickSwitcher, { context });
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(await screen.findByRole('combobox', { name: /search chats/i }), 'match');
    await waitFor(() =>
      expect(screen.getAllByRole('option', { name: /chat s1|remote match/i })).toHaveLength(2),
    );
    expect(server.calls('search.quick').length).toBeGreaterThan(0);
    expect(remote.calls('search.quick').length).toBeGreaterThan(0);
    const [first, second] = screen.getAllByRole('option', { name: /chat s1|remote match/i });
    // By the service's score: the remote hit first.
    expect(first!.textContent).toContain('remote match');
    expect(within(first!).getByText('Ubuntu PC')).toBeTruthy();
    expect(within(second!).getByText('This PC')).toBeTruthy();
    await waitFor(() => expect(first!.getAttribute('aria-selected')).toBe('true'));
    await userEvent.keyboard('{Enter}');
    expect(app.tabs.active).toBe(`${M1}/s9`);
  });

  it('keeps the same session id of two machines apart', async () => {
    const { context, app } = await setupTwoMachines({
      configure: (s) => (s.handlers['search.quick'] = () => ({ items: [hit('s1', 0.9)] })),
      configureRemote: (s) => (s.handlers['search.quick'] = () => ({ items: [hit('s1', 0.5)] })),
    });
    render(QuickSwitcher, { context });
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(await screen.findByRole('combobox', { name: /search chats/i }), 'chat');
    await waitFor(() =>
      expect(screen.getAllByRole('option', { name: /chat s1/i })).toHaveLength(2),
    );
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(app.tabs.active).toBe(`${M1}/s1`);
    expect(app.tabs.open).not.toContain(`${LOCAL}/s1`);
  });
});

describe('mergeQuickHits', () => {
  const list = (machineId: string, hits: Hit[]) => ({ machineId, hits });

  it('returns one machine’s answer as it is', () => {
    const only = [hit('a', 0.1), hit('b', 0.9), hit('c', 0.5, { archived: true })];
    expect(mergeQuickHits([list('m', only)], 20).map((h) => h.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('merges by score, archived last with their kept slots, cut to the limit', () => {
    const merged = mergeQuickHits(
      [
        list('x', [hit('x1', 0.9), hit('x2', 0.4), hit('xa', 0.8, { archived: true })]),
        list('y', [hit('y1', 0.7), hit('y2', 0.6), hit('ya', 0.3, { archived: true })]),
      ],
      4,
    );
    // Up to half the limit (here 2) stays for archived matches.
    expect(merged.map((h) => `${h.machineId}/${h.sessionId}`)).toEqual([
      'x/x1',
      'y/y1',
      'x/xa',
      'y/ya',
    ]);
  });
});

describe('fix round 1', () => {
  it('the quick switcher shows This PC’s hits without waiting for a slow machine', async () => {
    const pending: (() => void)[] = [];
    const { context } = await setupTwoMachines({
      configure: (s) => (s.handlers['search.quick'] = () => ({ items: [hit('s1', 0.5)] })),
      configureRemote: (s) =>
        (s.handlers['search.quick'] = () =>
          new Promise((resolve) =>
            pending.push(() => resolve({ items: [hit('s9', 0.9, { title: 'remote match' })] })),
          )),
    });
    render(QuickSwitcher, { context });
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(await screen.findByRole('combobox', { name: /search chats/i }), 'match');
    expect(await screen.findByRole('option', { name: /chat s1/i })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /remote match/i })).toBeNull();
    // The remote answers later: its hits merge in (older queries' answers are dropped).
    for (const release of pending) release();
    const remote = await screen.findByRole('option', { name: /remote match/i });
    const options = screen.getAllByRole('option', { name: /chat s1|remote match/i });
    expect(options).toHaveLength(2);
    expect(options[0]).toBe(remote);
  });

  it('a late answer keeps the cursor on the row the user moved it to', async () => {
    const pending: (() => void)[] = [];
    const { context } = await setupTwoMachines({
      configure: (s) =>
        (s.handlers['search.quick'] = () => ({ items: [hit('s1', 0.5), hit('s2', 0.4)] })),
      configureRemote: (s) =>
        (s.handlers['search.quick'] = () =>
          new Promise((resolve) =>
            pending.push(() => resolve({ items: [hit('s9', 0.9, { title: 'remote match' })] })),
          )),
    });
    render(QuickSwitcher, { context });
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(await screen.findByRole('combobox', { name: /search chats/i }), 'match');
    await screen.findByRole('option', { name: /chat s2/i });
    await userEvent.keyboard('{ArrowDown}');
    const s2 = screen.getByRole('option', { name: /chat s2/i });
    expect(s2.getAttribute('aria-selected')).toBe('true');
    for (const release of pending) release();
    await screen.findByRole('option', { name: /remote match/i });
    expect(screen.getByRole('option', { name: /chat s2/i }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('a failing This PC does not hold back another machine’s hits', async () => {
    const { context } = await setupTwoMachines({
      configure: (s) =>
        (s.handlers['search.quick'] = () => {
          throw new RpcFail('INTERNAL');
        }),
      configureRemote: (s) =>
        (s.handlers['search.quick'] = () => ({
          items: [hit('s9', 0.9, { title: 'remote match' })],
        })),
    });
    render(QuickSwitcher, { context });
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(await screen.findByRole('combobox', { name: /search chats/i }), 'match');
    expect(await screen.findByRole('option', { name: /remote match/i })).toBeTruthy();
  });

  /** Ubuntu PC's p1 selected; This PC has a p1 too (missing when `missing`). */
  const sameIdSelected = async (missing = false) => {
    let hidden = false;
    const env = await setupTwoMachines({
      configure: (s) => {
        s.handlers['projects.list'] = () => [
          project('p1', 'alpha', { hidden, ...(missing ? { exists: false } : {}) }),
        ];
        s.handlers['projects.update'] = (p) => {
          hidden = (p as { hidden: boolean }).hidden;
          return {};
        };
      },
      configureRemote: (s) => (s.handlers['projects.list'] = () => [project('p1', 'tg-cli')]),
    });
    render(PlacesColumn, { context: env.context });
    await userEvent.click(
      await within(groupOf('Ubuntu PC')).findByRole('button', { name: /tg-cli/i }),
    );
    expect(env.app.places.selected).toEqual({ kind: 'project', projectId: 'p1', machineId: M1 });
    return env;
  };

  it('hiding This PC’s p1 keeps Ubuntu PC’s p1 selected', async () => {
    const { app, server } = await sameIdSelected();
    const item = within(groupOf('This PC')).getByRole('button', { name: /alpha/i });
    await userEvent.pointer({ keys: '[MouseRight]', target: item });
    await userEvent.click(await screen.findByRole('menuitem', { name: /hide project/i }));
    // Hidden and re-listed: the store is done.
    await within(groupOf('This PC')).findByRole('button', { name: /hidden projects \(1\)/i });
    expect(server.calls('projects.update')).toHaveLength(1);
    expect(app.places.selected).toEqual({ kind: 'project', projectId: 'p1', machineId: M1 });
  });

  it('"Hide all missing" on This PC keeps Ubuntu PC’s p1 selected', async () => {
    const { app, server } = await sameIdSelected(true);
    await userEvent.click(
      within(groupOf('This PC')).getByRole('button', { name: 'Hide all missing' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Hide 1 project' }));
    await within(groupOf('This PC')).findByRole('button', { name: /hidden projects \(1\)/i });
    expect(server.calls('projects.update')).toHaveLength(1);
    expect(app.places.selected).toEqual({ kind: 'project', projectId: 'p1', machineId: M1 });
  });

  it('the agents strip keeps its single-machine title', async () => {
    const { context } = await setup((s) => {
      s.handlers['sessions.list'] = () => ({
        items: [summary('a', { status: 'working', live: true, title: 'agent a', preview: '' })],
      });
    });
    render(AgentsStrip, { context });
    const agent = await screen.findByRole('button', { name: /agent a/i });
    expect(agent.getAttribute('title')).toBe('agent a · alpha · Working');
  });

  it('the agents strip title names the machine with two machines', async () => {
    const { context } = await setupTwoMachines({
      configureRemote: (s) =>
        (s.handlers['sessions.list'] = () => ({
          items: [summary('b', { status: 'working', live: true, title: 'agent b', preview: '' })],
        })),
    });
    render(AgentsStrip, { context });
    const agent = await screen.findByRole('button', { name: /agent b/i });
    expect(agent.getAttribute('title')).toBe('agent b · Ubuntu PC · alpha · Working');
  });

  it('"Open settings" carries the reason, announced and as a tooltip', async () => {
    const { context } = await twoMachines({ m1Status: 'locked' });
    render(PlacesColumn, { context });
    const button = await waitFor(() =>
      within(groupOf('Ubuntu PC')).getByRole('button', { name: /open settings/i }),
    );
    const ref = button.getAttribute('aria-describedby');
    expect(ref).toBeTruthy();
    expect(document.getElementById(ref!)?.textContent?.trim()).toBe('Pair again');
    expect(within(groupOf('Ubuntu PC')).getByText('Needs attention').getAttribute('title')).toBe(
      'Pair again',
    );
    await userEvent.hover(button);
    await waitFor(
      () =>
        expect(document.querySelector('[data-tooltip-content]')?.textContent).toContain(
          'Pair again',
        ),
      { timeout: 2000 },
    );
  });

  it('names every state', () => {
    const at = (status: MachineStatus) => machineState({ status, name: 'Ubuntu PC' });
    expect(at('on')).toEqual({ label: 'On', tone: 'green' });
    expect(at('connecting')).toEqual({ label: 'Connecting…', tone: 'amber' });
    expect(at('unreachable')).toEqual({ label: 'Unreachable', tone: 'amber' });
    const attention = (reason: string) => ({ label: 'Needs attention', tone: 'red', reason });
    expect(at('mismatch')).toEqual(attention('This address answers as a different machine'));
    expect(at('refused')).toEqual(attention('This device was removed on Ubuntu PC'));
    expect(at('locked')).toEqual(attention('Pair again'));
    expect(at('incompatible')).toEqual(attention('Different Threadgarden version'));
    // An unknown status is not silently "Different Threadgarden version".
    expect(() => at('bogus' as MachineStatus)).toThrow();
  });

  it('keeps a machine’s "Missing folders" open state on This PC, by machine', async () => {
    const { server, remote, context } = await setupTwoMachines({
      configureRemote: (s) =>
        (s.handlers['projects.list'] = () => [project('p9', 'gone', { exists: false })]),
    });
    render(PlacesColumn, { context });
    const toggle = await within(groupOf('Ubuntu PC')).findByRole('button', {
      name: /missing folders \(1\)/i,
    });
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() =>
      expect(server.calls('uiState.set').map((c) => c.params)).toContainEqual({
        key: 'machines.missingOpen',
        value: [M1],
      }),
    );
    expect(remote.calls('uiState.set')).toHaveLength(0);
  });

  it('restores a machine’s "Missing folders" open state', async () => {
    const { app, context } = await setupTwoMachines({
      configure: (s) =>
        (s.handlers['uiState.get'] = (p) => ({
          value: (p as { key: string }).key === 'machines.missingOpen' ? [M1] : null,
        })),
      configureRemote: (s) =>
        (s.handlers['projects.list'] = () => [project('p9', 'gone', { exists: false })]),
    });
    await app.machines.restoreMissingOpen();
    render(PlacesColumn, { context });
    const toggle = await within(groupOf('Ubuntu PC')).findByRole('button', {
      name: /missing folders \(1\)/i,
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('"more than one machine" is one test for the column and the chips', async () => {
    const { app } = await setupTwoMachines();
    expect(app.machines.several).toBe(true);
    const { app: one } = await setup();
    expect(one.machines.several).toBe(false);
  });
});
