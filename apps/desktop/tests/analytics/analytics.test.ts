import type { Analytics } from '@pahub/protocol';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import AnalyticsView from '../../src/lib/components/analytics/AnalyticsView.svelte';
import ChatPane from '../../src/lib/components/layout/ChatPane.svelte';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import TabsBar from '../../src/lib/components/layout/TabsBar.svelte';
import QuickSwitcher from '../../src/lib/components/QuickSwitcher.svelte';
import { TabsState } from '../../src/lib/state/tabs.svelte';
import { RpcFail } from '../service/fake-ws';
import { project, setup } from '../layout/harness';

const day = (n: number): string => `2026-10-${String(n).padStart(2, '0')}`;

const sample = (over: Partial<Analytics> = {}): Analytics => ({
  range: '7d',
  from: day(25),
  to: day(31),
  bucket: 'day',
  kpis: {
    chats: 12,
    messages: 340,
    outputTokens: 123_456,
    activeDays: 5,
    busiestProject: { projectId: 'p1', name: 'alpha', messages: 200 },
  },
  activity: [25, 26, 27, 28, 29, 30, 31].map((d, i) => ({
    day: day(d),
    messages: i * 10,
    chatsStarted: i % 3,
  })),
  tokens: {
    models: ['claude-sonnet', 'claude-opus'],
    days: [25, 26, 27, 28, 29, 30, 31].map((d, i) => ({ day: day(d), values: [i * 100, i * 50] })),
    totals: [
      { model: 'claude-sonnet', input: 10, output: 2100, cacheRead: 9000, cacheCreation: 5 },
      { model: 'claude-opus', input: 4, output: 1050, cacheRead: 300, cacheCreation: 0 },
    ],
  },
  projects: [
    { projectId: 'p1', name: 'alpha', messages: 200, chats: 7 },
    { projectId: 'p2', name: 'beta', messages: 140, chats: 5 },
  ],
  tools: [
    { name: 'Read', calls: 90 },
    { name: 'Edit', calls: 40 },
  ],
  agents: [{ type: 'Explore', calls: 6 }],
  heatmap: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d + h) % 5)),
  topics: [
    { word: 'indexer', chats: 4 },
    { word: 'login', chats: 3 },
  ],
  pending: 0,
  ...over,
});

type Params = { range: string; projectId?: string };

describe('TabsState and the Analytics view', () => {
  it('shows Analytics in place of the active chat and brings that chat back', () => {
    const t = new TabsState();
    ['a', 'b'].forEach(t.openTab);
    t.showAnalytics();
    expect(t).toMatchObject({ analyticsOpen: true, analyticsShown: true, active: null });
    expect(t.open).toEqual(['a', 'b']);
    // A chat tab takes over; the Analytics tab stays open behind it.
    t.activate('a');
    expect(t).toMatchObject({ analyticsOpen: true, analyticsShown: false, active: 'a' });
    t.showAnalytics();
    t.closeAnalytics();
    expect(t).toMatchObject({ analyticsOpen: false, analyticsShown: false, active: 'a' });
  });

  it('a chat closed behind it is not brought back', () => {
    const t = new TabsState();
    ['a', 'b', 'c'].forEach(t.openTab);
    t.activate('b');
    t.showAnalytics();
    t.close('b');
    t.closeAnalytics();
    expect(t.active).toBe('c');
    const u = new TabsState();
    u.showAnalytics();
    u.closeAnalytics();
    expect(u.active).toBeNull();
  });

  it('remembers the chat behind it, not "no chat", across restarts', async () => {
    const store = new Map<string, unknown>();
    const { client } = await setup((server) => {
      server.handlers['uiState.set'] = (p) => {
        const { key, value } = p as { key: string; value: unknown };
        store.set(key, value);
        return {};
      };
    });
    const t = new TabsState();
    t.init(client);
    t.openTab('a');
    t.showAnalytics();
    await waitFor(() => expect(store.get('tabs')).toEqual({ open: ['a'], active: 'a' }));
  });
});

describe('AnalyticsState', () => {
  it('asks for the range and project, and drops an answer a newer request overtook', async () => {
    const answers: ((v: Analytics) => void)[] = [];
    const { server, app } = await setup((server) => {
      server.handlers['analytics.get'] = () => new Promise<Analytics>((r) => answers.push(r));
    });
    const first = app.analytics.load();
    app.analytics.setRange('90d');
    app.analytics.setProject('p2');
    await waitFor(() => expect(answers).toHaveLength(3));
    const sent = server.calls('analytics.get').map((c) => c.params as Params);
    expect(sent).toEqual([{ range: '30d' }, { range: '90d' }, { range: '90d', projectId: 'p2' }]);
    answers[2]!(sample({ range: '90d', projectId: 'p2' }));
    answers[0]!(sample({ range: '30d' }));
    await first;
    await waitFor(() => expect(app.analytics.data?.projectId).toBe('p2'));
    expect(app.analytics.data?.range).toBe('90d');
  });

  it('a model keeps its color slot whatever its rank in the next answer', async () => {
    const { app } = await setup();
    expect(app.analytics.modelSlots(['sonnet', 'opus', 'haiku'], 4)).toEqual([0, 1, 2]);
    // Another project: opus first, a new model; sonnet absent.
    expect(app.analytics.modelSlots(['opus', 'fable', 'haiku'], 4)).toEqual([1, 0, 2]);
    expect(app.analytics.modelSlots(['haiku', 'sonnet', 'opus', 'fable'], 4)).toEqual([2, 0, 1, 3]);
  });

  it('says so when the service is too old for analytics', async () => {
    const { app } = await setup((server) => {
      server.handlers['analytics.get'] = () => {
        throw new RpcFail('METHOD_NOT_FOUND');
      };
    });
    await app.analytics.load();
    expect(app.analytics.error).toMatch(/older than this app/);
  });
});

describe('AnalyticsView', () => {
  const view = async (data = sample()) => {
    const ctx = await setup((server) => {
      server.handlers['analytics.get'] = (p) => ({ ...data, ...(p as Params) });
      server.handlers['projects.list'] = () => [project('p1', 'alpha'), project('p2', 'beta')];
    });
    render(AnalyticsView, { context: ctx.context });
    await screen.findByText('340');
    return ctx;
  };

  it('shows the KPI tiles and every chart with its description', async () => {
    await view();
    const tiles = screen.getByRole('heading', { name: 'Analytics' }).closest('section')!;
    for (const [label, value] of <[string, string][]>[
      ['Chats', '12'],
      ['Messages', '340'],
      ['Output tokens', '123.5K'],
      ['Active days', '5'],
    ]) {
      const term = within(tiles).getByText(label, { selector: 'dt' });
      expect(term.nextElementSibling?.textContent?.trim()).toBe(value);
    }
    for (const name of [
      'Activity',
      'Output tokens by model',
      'Top projects',
      'Tools used',
      'Subagents',
      'Topics',
      'When you work',
    ]) {
      const figure = screen.getByRole('figure', { name });
      expect(figure.getAttribute('aria-describedby')).toBeTruthy();
    }
    // Two models: a legend names them.
    const tokens = screen.getByRole('figure', { name: 'Output tokens by model' });
    expect(within(tokens).getByText('claude-opus')).toBeTruthy();
  });

  it('"Show data" reveals the table view', async () => {
    await view();
    const tools = screen.getByRole('figure', { name: 'Tools used' });
    const toggle = within(tools).getByRole('button', { name: 'Show data' });
    expect(within(tools).queryByRole('table')).toBeNull();
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const table = within(tools).getByRole('table');
    expect(within(table).getByRole('rowheader', { name: 'Read' })).toBeTruthy();
    expect(within(table).getByRole('cell', { name: '90' })).toBeTruthy();
    await userEvent.click(within(tools).getByRole('button', { name: 'Hide data' }));
    expect(within(tools).queryByRole('table')).toBeNull();
  });

  it('clicking a project bar filters to it; again shows all', async () => {
    const { server, app } = await view();
    const projects = screen.getByRole('figure', { name: 'Top projects' });
    await userEvent.click(within(projects).getByRole('button', { name: /^beta: 140 messages/ }));
    await waitFor(() =>
      expect(server.calls('analytics.get').at(-1)!.params).toEqual({
        range: '30d',
        projectId: 'p2',
      }),
    );
    expect(app.analytics.projectId).toBe('p2');
    await waitFor(() =>
      expect(
        within(projects).getByRole('button', { name: /^beta/ }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    await userEvent.click(screen.getByRole('button', { name: /show all projects/ }));
    await waitFor(() => expect(app.analytics.projectId).toBeNull());
  });

  it('the range buttons and the project menu scope the request', async () => {
    const { server } = await view();
    await userEvent.click(screen.getByRole('radio', { name: 'All time' }));
    await waitFor(() =>
      expect(server.calls('analytics.get').at(-1)!.params).toEqual({ range: 'all' }),
    );
    await waitFor(() => expect(screen.getByRole('option', { name: 'alpha' })).toBeTruthy());
    await fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), {
      target: { value: 'p1' },
    });
    await waitFor(() =>
      expect(server.calls('analytics.get').at(-1)!.params).toEqual({
        range: 'all',
        projectId: 'p1',
      }),
    );
  });

  it('says when statistics are still being gathered, and when a chart has no data', async () => {
    await view(sample({ pending: 42, agents: [], tools: [] }));
    expect(screen.getByText(/Still gathering the statistics of 42 older chats/)).toBeTruthy();
    expect(screen.getByText('No subagents in this range.')).toBeTruthy();
    expect(screen.getByText('No tool calls in this range.')).toBeTruthy();
  });
});

describe('opening Analytics', () => {
  it('from the places column, below Running, as a tab in the main pane', async () => {
    const { context, app } = await setup((server) => {
      server.handlers['analytics.get'] = () => sample();
    });
    render(PlacesColumn, { context });
    render(TabsBar, { context });
    render(ChatPane, { context });
    const places = screen.getByRole('navigation', { name: 'Places' });
    const items = within(places)
      .getAllByRole('button')
      .map((b) => b.textContent?.trim().replace(/\d+$/, ''));
    expect(items.indexOf('Analytics')).toBe(items.indexOf('Running') + 1);
    await userEvent.click(within(places).getByRole('button', { name: 'Analytics' }));
    expect(app.tabs.analyticsShown).toBe(true);
    const tab = screen.getByRole('tab', { name: 'Analytics' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab.id);
    await screen.findByText('340');
    await userEvent.click(screen.getByRole('button', { name: 'Close Analytics' }));
    expect(screen.queryByRole('tab', { name: 'Analytics' })).toBeNull();
  });

  it('from Ctrl/Cmd+K', async () => {
    const { context, app } = await setup((server) => {
      server.handlers['analytics.get'] = () => sample();
    });
    render(QuickSwitcher, { context });
    app.interaction.switcherOpen = true;
    const input = await screen.findByRole('combobox', { name: 'Search chats' });
    await userEvent.type(input, 'analy');
    await userEvent.click(await screen.findByRole('option', { name: /Analytics/ }));
    expect(app.tabs.analyticsShown).toBe(true);
  });
});
