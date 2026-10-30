import type { ChatItem, ChatStatus, ChatTask } from '@pahub/protocol';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatView from '../../src/lib/components/chat/ChatView.svelte';
import ChatListRow from '../../src/lib/components/layout/ChatListRow.svelte';
import TabsBar from '../../src/lib/components/layout/TabsBar.svelte';
import { runningTasks } from '../../src/lib/state/chats.svelte';
import { ACTIVITY_KEY } from '../../src/lib/state/settings.svelte';
import { setup, summary } from '../layout/harness';
import { RpcFail, type FakeServer } from '../service/fake-ws';
import { manyItems, tool, user } from './fixtures';

const SID = 's1';
const NOW = 1_800_000_000_000;

const agent = (over: Partial<ChatTask> = {}): ChatTask => ({
  taskId: 'a1',
  toolUseId: 'tu-agent',
  kind: 'agent',
  taskType: 'local_agent',
  subagentType: 'Explore',
  description: 'Explore the parser',
  status: 'running',
  startedAt: Date.now() - 5_000,
  toolUses: 3,
  tokens: 12_300,
  lastTool: 'Grep',
  summary: 'Reading the tokenizer',
  ...over,
});

const shell = (over: Partial<ChatTask> = {}): ChatTask => ({
  taskId: 'b1',
  toolUseId: 'tu-bash',
  kind: 'shell',
  taskType: 'local_bash',
  description: 'npm run dev',
  status: 'running',
  backgrounded: true,
  startedAt: Date.now() - 65_000,
  ...over,
});

type Options = {
  status?: ChatStatus;
  external?: boolean;
  tasks?: ChatTask[];
  items?: ChatItem[];
  configure?: (server: FakeServer) => void;
};

/** Renders chat `s1` (live by default) with the given tasks in `chat.open`. */
const renderChat = async (o: Options = {}) => {
  const status = o.status ?? 'working';
  const live = ['needsYou', 'working', 'idle'].includes(status);
  const env = await setup((server) => {
    Object.assign(server.handlers, {
      'chat.open': () => ({
        summary: summary(SID, {
          status,
          live,
          external: o.external ? { kind: 'terminal', pid: 1 } : null,
        }),
        header: {},
        items: o.items ?? [user('u1', 'start the dev server')],
        hasMore: false,
        seq: 1,
        tasks: o.tasks ?? [],
      }),
      'chat.stopTask': () => ({}),
      'chat.commands': () => [],
      'files.suggest': () => [],
    });
    o.configure?.(server);
  });
  env.app.tabs.openTab(SID);
  const view = render(ChatView, { props: { sessionId: SID }, context: env.context });
  await waitFor(() => expect(env.app.chats.get(SID)?.loaded).toBe(true));
  const panel = () => screen.queryByRole('region', { name: 'Activity' });
  return { ...env, view, panel };
};

const pushTasks = (server: FakeServer, seq: number, tasks: ChatTask[]): void =>
  server.push('chat.tasks', { sessionId: SID, seq, tasks });

afterEach(() => {
  vi.useRealTimers();
});

describe('chat state: tasks', () => {
  it('keeps the tasks from chat.open and replaces them on each chat.tasks event', async () => {
    const { server, app } = await renderChat({ tasks: [agent()] });
    const chat = app.chats.get(SID)!;
    expect(chat.tasks.map((t) => t.taskId)).toEqual(['a1']);
    expect(chat.hadTasks).toBe(true);

    pushTasks(server, 2, [agent({ status: 'completed', endedAt: Date.now() }), shell()]);
    await waitFor(() => expect(chat.tasks.map((t) => t.taskId)).toEqual(['a1', 'b1']));
    expect(chat.seq).toBe(2);
    expect(runningTasks(chat.tasks)).toBe(1);

    // A duplicate (seq at or below the chat's) is ignored.
    pushTasks(server, 2, []);
    await new Promise((r) => setTimeout(r, 10));
    expect(chat.tasks).toHaveLength(2);

    // The process ended: the list empties, the chat still had tasks.
    pushTasks(server, 3, []);
    await waitFor(() => expect(chat.tasks).toEqual([]));
    expect(chat.hadTasks).toBe(true);
  });

  it('counts running, pending and not-yet-ended unknown tasks as running', () => {
    expect(
      runningTasks([
        agent({ status: 'running' }),
        agent({ status: 'pending' }),
        agent({ status: 'unknown', rawStatus: 'warping' }),
        agent({ status: 'unknown', endedAt: 1 }),
        agent({ status: 'paused' }),
        agent({ status: 'completed' }),
        agent({ status: 'failed' }),
        agent({ status: 'stopped' }),
      ]),
    ).toBe(3);
  });

  it('a resync replaces the tasks; GAP restores them from chat.open', async () => {
    let opened = 0;
    const { server, app } = await renderChat({
      configure: (s) => {
        const open = s.handlers['chat.open']!;
        s.handlers['chat.open'] = (p) => {
          opened++;
          const r = open(p) as Record<string, unknown>;
          return opened === 1 ? r : { ...r, seq: 50, tasks: [shell({ taskId: 'fresh' })] };
        };
      },
      tasks: [agent()],
    });
    const chat = app.chats.get(SID)!;

    server.handlers['chat.since'] = () => ({
      events: [{ sessionId: SID, seq: 2, tasks: [shell()] }],
      seq: 2,
    });
    server.drop();
    await waitFor(() => expect(chat.tasks.map((t) => t.taskId)).toEqual(['b1']));
    expect(chat.seq).toBe(2);

    server.handlers['chat.since'] = () => {
      throw new RpcFail('GAP');
    };
    server.drop();
    await waitFor(() => expect(chat.tasks.map((t) => t.taskId)).toEqual(['fresh']));
    expect(chat.seq).toBe(50);
  });

  it('an older service without tasks in chat.open means no tasks', async () => {
    const { app } = await renderChat({
      configure: (s) => {
        const open = s.handlers['chat.open']!;
        s.handlers['chat.open'] = (p) => {
          const r = { ...(open(p) as Record<string, unknown>) };
          delete r.tasks;
          return r;
        };
      },
    });
    expect(app.chats.get(SID)!.tasks).toEqual([]);
  });
});

describe('activity panel', () => {
  it('lists agents and processes from chat.open', async () => {
    const { panel } = await renderChat({ tasks: [agent(), shell()] });
    const region = panel()!;
    expect(region).toBeTruthy();

    const agents = within(region).getByRole('list', { name: 'Agents' });
    const row = within(agents).getByRole('listitem');
    expect(row.textContent).toContain('Explore the parser');
    expect(row.textContent).toContain('Explore');
    expect(row.textContent).toContain('3 tools');
    expect(row.textContent).toContain('12k tokens');
    expect(row.textContent).toContain('Reading the tokenizer');
    expect(within(row).getByRole('img', { name: 'Running' })).toBeTruthy();

    const processes = within(region).getByRole('list', { name: 'Processes' });
    const proc = within(processes).getByRole('listitem');
    expect(proc.textContent).toContain('npm run dev');
    expect(proc.textContent).toContain('1m 05s');
    expect(within(proc).getByRole('button', { name: 'Stop npm run dev' })).toBeTruthy();
  });

  it('follows live chat.tasks events', async () => {
    const { server, panel } = await renderChat({ tasks: [agent()] });
    pushTasks(server, 2, [
      agent({ status: 'completed', endedAt: Date.now(), summary: 'Found the bug' }),
      shell(),
    ]);
    const region = panel()!;
    await waitFor(() =>
      expect(within(region).getByRole('list', { name: 'Processes' }).textContent).toContain(
        'npm run dev',
      ),
    );
    const agents = within(region).getByRole('list', { name: 'Agents' });
    expect(within(agents).getByRole('img', { name: 'Completed' })).toBeTruthy();
    expect(agents.textContent).toContain('Found the bug');
  });

  it('ticks the elapsed time once per second while something runs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    const { panel } = await renderChat({ tasks: [shell({ startedAt: NOW - 65_000 })] });
    const proc = within(panel()!).getByRole('listitem');
    expect(proc.textContent).toContain('1m 05s');
    vi.advanceTimersByTime(1000);
    await waitFor(() => expect(proc.textContent).toContain('1m 06s'));
    vi.advanceTimersByTime(60_000);
    await waitFor(() => expect(proc.textContent).toContain('2m 06s'));
  });

  it('does not tick when nothing runs; an ended task shows its final duration', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    const { panel } = await renderChat({
      tasks: [shell({ status: 'stopped', startedAt: NOW - 30_000, endedAt: NOW - 18_000 })],
    });
    expect(vi.getTimerCount()).toBe(0);
    const proc = within(panel()!).getByRole('listitem');
    expect(proc.textContent).toContain('12s');
    expect(within(proc).getByRole('img', { name: 'Stopped' })).toBeTruthy();
    expect(within(proc).queryByRole('button', { name: /^Stop/ })).toBeNull();
  });

  it('Stop asks first, then calls chat.stopTask', async () => {
    const { server, panel } = await renderChat({ tasks: [shell()] });
    await userEvent.click(within(panel()!).getByRole('button', { name: 'Stop npm run dev' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('npm run dev');
    expect(server.calls('chat.stopTask')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop process' }));
    await waitFor(() => expect(server.calls('chat.stopTask')).toHaveLength(1));
    expect(server.calls('chat.stopTask')[0]!.params).toEqual({ sessionId: SID, taskId: 'b1' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('shows a stopTask error in the dialog', async () => {
    const { panel } = await renderChat({
      tasks: [shell()],
      configure: (s) => {
        s.handlers['chat.stopTask'] = () => {
          throw new RpcFail('STOP_FAILED', 'Claude Code could not stop the task');
        };
      },
    });
    await userEvent.click(within(panel()!).getByRole('button', { name: 'Stop npm run dev' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop process' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toContain(
        'Claude Code could not stop the task',
      ),
    );
  });

  it('a failed task shows its error', async () => {
    const { panel } = await renderChat({
      tasks: [agent({ status: 'failed', endedAt: Date.now(), error: 'Rate limited by the API' })],
    });
    const row = within(panel()!).getByRole('listitem');
    expect(within(row).getByRole('img', { name: 'Failed' })).toBeTruthy();
    expect(row.textContent).toContain('Rate limited by the API');
  });

  it('an unknown task type is listed under Processes with its raw type and status', async () => {
    const { panel } = await renderChat({
      tasks: [
        {
          taskId: 'x1',
          kind: 'other',
          taskType: 'dream',
          description: 'Dreaming',
          status: 'unknown',
          rawStatus: 'lucid',
          startedAt: Date.now(),
        },
      ],
    });
    const processes = within(panel()!).getByRole('list', { name: 'Processes' });
    expect(processes.textContent).toContain('dream');
    const icon = within(processes).getByRole('img', { name: /lucid/ });
    expect(icon.getAttribute('title')).toContain('lucid');
  });

  it('is hidden for a chat that never had tasks; the toggle shows an empty state', async () => {
    const { panel } = await renderChat();
    expect(panel()).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Activity panel' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(toggle);
    expect(panel()!.textContent).toContain('No agents or background processes yet');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('appears when the first task arrives', async () => {
    const { server, panel } = await renderChat();
    expect(panel()).toBeNull();
    pushTasks(server, 2, [shell()]);
    await waitFor(() => expect(panel()).toBeTruthy());
  });

  it('history and external chats say activity is for chats running in pahub', async () => {
    const { panel } = await renderChat({ status: 'history' });
    await userEvent.click(screen.getByRole('button', { name: 'Activity panel' }));
    expect(panel()!.textContent).toContain('Activity is available for chats running in pahub');
  });

  it('an external chat says so too', async () => {
    const { panel } = await renderChat({ status: 'working', external: true });
    await userEvent.click(screen.getByRole('button', { name: 'Activity panel' }));
    expect(panel()!.textContent).toContain('Activity is available for chats running in pahub');
  });

  it('the toggle hides it, remembers that in uiState, and Ctrl+. shows it again', async () => {
    const { server, panel } = await renderChat({ tasks: [shell()] });
    expect(panel()).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Activity panel' }));
    expect(panel()).toBeNull();
    await waitFor(() =>
      expect(server.calls('uiState.set').map((c) => c.params)).toContainEqual({
        key: ACTIVITY_KEY,
        value: false,
      }),
    );
    await fireEvent.keyDown(window, { key: '.', code: 'Period', ctrlKey: true });
    expect(panel()).toBeTruthy();
    expect(server.calls('uiState.set').map((c) => c.params)).toContainEqual({
      key: ACTIVITY_KEY,
      value: true,
    });
    // The panel's own close button hides it as well.
    await userEvent.click(within(panel()!).getByRole('button', { name: 'Hide activity' }));
    expect(panel()).toBeNull();
  });

  it('starts hidden when uiState says so', async () => {
    const { app, panel } = await renderChat({
      tasks: [shell()],
      configure: (s) => {
        s.handlers['uiState.get'] = (p) => ({
          value: (p as { key: string }).key === ACTIVITY_KEY ? false : null,
        });
      },
    });
    await app.settings.restoreActivity();
    await waitFor(() => expect(panel()).toBeNull());
  });

  it('clicking an agent scrolls the messages to the call that started it', async () => {
    const items: ChatItem[] = [
      user('u0', 'explore please'),
      tool(
        'agent',
        'Agent',
        { description: 'Explore the parser', subagent_type: 'Explore' },
        {
          toolUseId: 'tu-agent',
          status: 'running',
        },
      ),
      ...manyItems(300),
    ];
    const { view, panel } = await renderChat({ items, tasks: [agent()] });
    const viewport = view.container.querySelector<HTMLElement>('[data-viewport]')!;
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
    expect(view.container.querySelector('[data-row="agent"]')).toBeNull();

    await userEvent.click(
      within(panel()!).getByRole('button', { name: /Show Explore the parser in the chat/ }),
    );
    await waitFor(() => expect(view.container.querySelector('[data-row="agent"]')).toBeTruthy());
    expect(viewport.scrollTop).toBeLessThan(200);
  });

  it('clicking an agent whose call is not loaded does nothing', async () => {
    const { view, panel } = await renderChat({ items: manyItems(300), tasks: [agent()] });
    const viewport = view.container.querySelector<HTMLElement>('[data-viewport]')!;
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
    const before = viewport.scrollTop;
    await userEvent.click(
      within(panel()!).getByRole('button', { name: /Show Explore the parser in the chat/ }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(viewport.scrollTop).toBe(before);
  });
});

describe('running badge', () => {
  it('a tab shows "N running" while its chat has running tasks', async () => {
    const { server, context } = await renderChat({ tasks: [shell(), agent()] });
    render(TabsBar, { context });
    const tab = screen.getByRole('tab');
    await waitFor(() => expect(tab.textContent).toContain('2 running'));
    pushTasks(server, 2, [shell({ status: 'stopped', endedAt: Date.now() }), agent()]);
    await waitFor(() => expect(tab.textContent).toContain('1 running'));
    pushTasks(server, 3, []);
    await waitFor(() => expect(tab.textContent).not.toContain('running'));
  });

  it('a chat list row shows the pill it is given', () => {
    const props = {
      chat: summary(SID, { status: 'working', live: true }),
      id: 'row',
      index: 0,
      setSize: 1,
      selected: false,
      active: false,
      now: Date.now(),
      onOpen: () => {},
      onRename: () => {},
      onTogglePin: () => {},
    };
    const { container, unmount } = render(ChatListRow, { props: { ...props, running: 2 } });
    expect(container.textContent).toContain('2 running');
    unmount();
    const plain = render(ChatListRow, { props });
    expect(plain.container.textContent).not.toContain('running');
  });
});
