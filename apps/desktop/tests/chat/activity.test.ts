import type { ChatItem, ChatStatus, ChatTask } from '@threadgarden/protocol';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatView from '../../src/lib/components/chat/ChatView.svelte';
import AgentsStrip from '../../src/lib/components/layout/AgentsStrip.svelte';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
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

    pushTasks(server, 2, [agent({ status: 'completed', endedAt: Date.now() }), shell()]);
    await waitFor(() => expect(chat.tasks.map((t) => t.taskId)).toEqual(['a1', 'b1']));
    expect(chat.seq).toBe(2);
    expect(runningTasks(chat.tasks)).toBe(1);

    // A duplicate (seq at or below the chat's) is ignored.
    pushTasks(server, 2, []);
    await new Promise((r) => setTimeout(r, 10));
    expect(chat.tasks).toHaveLength(2);

    // The process ended: the list empties.
    pushTasks(server, 3, []);
    await waitFor(() => expect(chat.tasks).toEqual([]));
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

  it('v1.3: shows on a chat that never had tasks too, with the empty state', async () => {
    const { panel } = await renderChat();
    expect(panel()!.textContent).toContain('No agents or background processes yet');
    const toggle = screen.getByRole('button', { name: 'Activity panel' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('lists the first task when it arrives', async () => {
    const { server, panel } = await renderChat();
    pushTasks(server, 2, [shell()]);
    await waitFor(() =>
      expect(within(panel()!).getByRole('list', { name: 'Processes' }).textContent).toContain(
        'npm run dev',
      ),
    );
  });

  it('history and external chats say activity is for chats running in Threadgarden', async () => {
    const { panel } = await renderChat({ status: 'history' });
    expect(panel()!.textContent).toContain(
      'Activity is available for chats running in Threadgarden',
    );
  });

  it('an external chat says so too', async () => {
    const { panel } = await renderChat({ status: 'working', external: true });
    expect(panel()!.textContent).toContain(
      'Activity is available for chats running in Threadgarden',
    );
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

  it('v1.3: the toggle is one global state, also in a chat without tasks', async () => {
    const { server, app, view, panel, context } = await renderChat();
    const toggle = screen.getByRole('button', { name: 'Activity panel' });
    await userEvent.click(toggle);
    expect(panel()).toBeNull();
    expect(app.settings.activityOpen).toBe(false);
    await waitFor(() =>
      expect(server.calls('uiState.set').map((c) => c.params)).toContainEqual({
        key: ACTIVITY_KEY,
        value: false,
      }),
    );
    // Another chat view (a chat with tasks, a chat switch) follows the same setting.
    view.unmount();
    render(ChatView, { props: { sessionId: SID }, context });
    expect(panel()).toBeNull();
    app.settings.setActivityOpen(true);
    await waitFor(() => expect(panel()).toBeTruthy());
  });

  it('Ctrl+. ignores key repeat and Shift', async () => {
    const { panel } = await renderChat({ tasks: [shell()] });
    expect(panel()).toBeTruthy();
    await fireEvent.keyDown(window, { key: '.', code: 'Period', ctrlKey: true, repeat: true });
    expect(panel()).toBeTruthy();
    await fireEvent.keyDown(window, { key: '>', code: 'Period', ctrlKey: true, shiftKey: true });
    expect(panel()).toBeTruthy();
    await fireEvent.keyDown(window, { key: '.', code: 'Period', metaKey: true });
    expect(panel()).toBeNull();
  });

  it('a paused task shows a frozen time marked paused and does not tick', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    const { panel } = await renderChat({
      tasks: [agent({ status: 'paused', startedAt: NOW - 42_000 })],
    });
    const row = within(panel()!).getByRole('listitem');
    expect(within(row).getByRole('img', { name: 'Paused' })).toBeTruthy();
    expect(row.textContent).toContain('42s (paused)');
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(NOW + 5_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(row.textContent).toContain('42s (paused)');
  });
});

describe('activity panel: order, nesting and details (v1.3 §2)', () => {
  const rowsOf = (region: HTMLElement, list: string): string[] =>
    within(within(region).getByRole('list', { name: list }))
      .getAllByRole('listitem')
      .map((li) => li.querySelector('[data-task-description]')?.textContent ?? '');

  it('lists running tasks first, newest start first, then ended ones by end time', async () => {
    const now = Date.now();
    const { panel } = await renderChat({
      tasks: [
        agent({
          taskId: 'a1',
          description: 'done long ago',
          status: 'completed',
          endedAt: now - 9e5,
        }),
        agent({ taskId: 'a2', description: 'old runner', startedAt: now - 60_000 }),
        agent({ taskId: 'a3', description: 'just done', status: 'failed', endedAt: now - 1_000 }),
        agent({ taskId: 'a4', description: 'new runner', startedAt: now - 1_000 }),
        shell({ taskId: 'b1', description: 'tsc --watch', status: 'stopped', endedAt: now - 5 }),
        shell({ taskId: 'b2', description: 'npm run dev', startedAt: now - 9e5 }),
      ],
    });
    expect(rowsOf(panel()!, 'Agents')).toEqual([
      'new runner',
      'old runner',
      'just done',
      'done long ago',
    ]);
    expect(rowsOf(panel()!, 'Processes')).toEqual(['npm run dev', 'tsc --watch']);
  });

  it('indents a task under the task that launched it', async () => {
    const { panel } = await renderChat({
      tasks: [
        agent({ taskId: 'child', description: 'Child', parentTaskId: 'root', toolUseId: 'tu-c' }),
        agent({ taskId: 'root', description: 'Root', startedAt: Date.now() - 60_000 }),
        agent({ taskId: 'other', description: 'Other', startedAt: Date.now() - 30_000 }),
      ],
    });
    const items = within(within(panel()!).getByRole('list', { name: 'Agents' })).getAllByRole(
      'listitem',
    );
    expect(
      items.map((li) => [
        li.querySelector('[data-task-description]')?.textContent,
        li.dataset.depth,
      ]),
    ).toEqual([
      ['Other', undefined],
      ['Root', undefined],
      ['Child', '1'],
    ]);
    await userEvent.click(within(items[2]!).getByRole('button', { name: 'Details of Child' }));
    expect(items[2]!.textContent).toContain('Started by');
    expect(items[2]!.textContent).toContain('Root');
  });

  it("shows an agent's model without the claude- prefix, and nothing when it is unknown", async () => {
    const { panel } = await renderChat({
      tasks: [
        agent({ taskId: 'a1', description: 'Streamed', model: 'claude-sonnet-4-5' }),
        agent({ taskId: 'a2', description: 'Alias', model: 'haiku', startedAt: Date.now() - 9e3 }),
        agent({ taskId: 'a3', description: 'Unknown', startedAt: Date.now() - 9e4 }),
      ],
    });
    const [streamed, alias, unknown] = within(
      within(panel()!).getByRole('list', { name: 'Agents' }),
    ).getAllByRole('listitem');
    expect(streamed!.textContent).toContain('sonnet-4-5');
    expect(streamed!.textContent).not.toContain('claude-sonnet');
    expect(within(streamed!).getByTitle('Model: claude-sonnet-4-5')).toBeTruthy();
    expect(alias!.textContent).toContain('haiku');
    expect(unknown!.textContent).not.toMatch(/inherit|model/i);
  });

  it('a disclosure button expands an agent to its details', async () => {
    const prompt = 'Look at the parser.\nThen the tokenizer.';
    const { panel } = await renderChat({
      tasks: [
        agent({
          model: 'claude-opus-5',
          prompt,
          backgrounded: true,
          workflowName: 'spec',
          status: 'failed',
          endedAt: Date.now(),
          error: 'Rate limited',
        }),
      ],
    });
    const row = within(panel()!).getByRole('listitem');
    const disclosure = within(row).getByRole('button', { name: 'Details of Explore the parser' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(row.querySelector('dl')).toBeNull();
    await userEvent.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    const dl = row.querySelector('dl')!;
    expect(disclosure.getAttribute('aria-controls')).toBe(dl.id);
    const fields = Object.fromEntries(
      [...dl.querySelectorAll('dt')].map((dt) => [
        dt.textContent?.trim(),
        dt.nextElementSibling?.textContent?.trim(),
      ]),
    );
    expect(fields).toMatchObject({
      Prompt: prompt,
      Type: 'Explore',
      Model: 'claude-opus-5',
      Workflow: 'spec',
      Duration: expect.stringMatching(/^\d+s$/),
      Tokens: '12k',
      'Tool uses': '3',
      'Last tool': 'Grep',
      Summary: 'Reading the tokenizer',
      'Runs in': 'Background',
      Error: 'Rate limited',
    });
    expect(fields['Started at']).toBeTruthy();
    // Short prompts are shown whole, with no "Show all".
    expect(within(dl).queryByRole('button', { name: 'Show all' })).toBeNull();
    // The keyboard works it too (a real button).
    disclosure.focus();
    await userEvent.keyboard('{Enter}');
    expect(row.querySelector('dl')).toBeNull();
  });

  it('a long prompt is clamped behind "Show all"', async () => {
    const prompt = `Read everything. ${'word '.repeat(100)}`;
    const { panel } = await renderChat({ tasks: [agent({ prompt })] });
    const row = within(panel()!).getByRole('listitem');
    await userEvent.click(within(row).getByRole('button', { name: /^Details of/ }));
    const text = row.querySelector<HTMLElement>('[data-prompt]')!;
    expect(text.className).toContain('line-clamp-4');
    const more = within(row).getByRole('button', { name: 'Show all' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(more);
    expect(text.className).not.toContain('line-clamp-4');
    expect(within(row).getByRole('button', { name: 'Show less' })).toBeTruthy();
  });

  it('a process expands to its command, type, timings and summary; Stop stays', async () => {
    const { panel } = await renderChat({
      tasks: [shell({ summary: 'Listening on 5173' })],
    });
    const row = within(panel()!).getByRole('listitem');
    await userEvent.click(within(row).getByRole('button', { name: 'Details of npm run dev' }));
    const dl = row.querySelector('dl')!;
    expect(dl.textContent).toContain('Command');
    expect(dl.textContent).toContain('npm run dev');
    expect(dl.textContent).toContain('shell');
    expect(dl.textContent).toContain('Running for');
    expect(dl.textContent).toContain('Listening on 5173');
    expect(dl.textContent).toContain('Background');
    expect(within(row).getByRole('button', { name: 'Stop npm run dev' })).toBeTruthy();
  });
});

describe('activity panel in a narrow chat pane (ruling R30)', () => {
  let restore: (() => void) | null = null;
  /** jsdom has no layout: report this width for the chat body. */
  const paneWidth = (px: number): void => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-chat-body') ? px : 0;
      },
    });
    restore = () => {
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original);
    };
  };
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('is an overlay drawer, opened on request only; Esc closes it and refocuses the toggle', async () => {
    paneWidth(600);
    const { server, view, panel } = await renderChat({ tasks: [shell()] });
    // Tasks alone do not cover a narrow chat.
    expect(panel()).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Activity panel' });
    await userEvent.click(toggle);
    const drawer = panel()!;
    expect(drawer.hasAttribute('data-overlay')).toBe(true);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(drawer).getByRole('button', { name: 'Hide activity' }),
      ),
    );
    await userEvent.keyboard('{Escape}');
    expect(panel()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    // Opening and closing the drawer is not the remembered side-column setting.
    expect(
      server.calls('uiState.set').filter((c) => (c.params as { key: string }).key === ACTIVITY_KEY),
    ).toEqual([]);
    expect(server.calls('chat.interrupt')).toHaveLength(0);

    // The scrim closes it too.
    await userEvent.click(toggle);
    await userEvent.click(view.container.querySelector<HTMLElement>('[data-activity-scrim]')!);
    expect(panel()).toBeNull();
  });

  it('is a side column when the pane is wide enough', async () => {
    paneWidth(1000);
    const { panel } = await renderChat({ tasks: [shell()] });
    expect(panel()!.hasAttribute('data-overlay')).toBe(false);
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

  it('R29: an idle chat with running tasks shows its pill in the list and strip, unopened', async () => {
    const { context } = await setup((server) => {
      server.handlers['sessions.list'] = (p) =>
        (p as { place: { kind: string } }).place.kind === 'needsYou'
          ? { items: [] }
          : {
              items: [
                summary('dev', { status: 'idle', live: true, runningTasks: 1, title: 'dev one' }),
                summary('quiet', { status: 'idle', live: true, title: 'quiet one' }),
              ],
            };
    });
    render(ChatList, { context });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    const [dev, quiet] = screen.getAllByRole('option') as HTMLElement[];
    expect(dev!.textContent).toContain('1 running');
    // The status stays idle: no working icon.
    expect(within(dev!).getByRole('img', { name: 'Idle' })).toBeTruthy();
    expect(quiet!.textContent).not.toContain('running');

    render(AgentsStrip, { context });
    const strip = await screen.findByRole('list', { name: /running agents/i });
    await waitFor(() => expect(within(strip).getAllByRole('listitem')).toHaveLength(2));
    const [first, second] = within(strip).getAllByRole('listitem');
    expect(first!.textContent).toContain('dev one');
    expect(first!.textContent).toContain('1 running');
    expect(second!.textContent).not.toContain('running');
  });
});

describe('End session with running background work', () => {
  const endHandler = (s: FakeServer) => {
    s.handlers['chat.end'] = () => ({});
  };

  it('an idle chat with running tasks asks first and lists them', async () => {
    const { server } = await renderChat({
      status: 'idle',
      tasks: [
        shell(),
        agent({ taskId: 'a2', description: 'Review the tests', backgrounded: true }),
        shell({ taskId: 'b2', description: 'tsc --watch', status: 'completed', endedAt: 1 }),
      ],
      configure: endHandler,
    });
    await userEvent.click(screen.getByRole('button', { name: 'End session' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(server.calls('chat.end')).toHaveLength(0);
    expect(dialog.textContent).toContain('2 background tasks');
    const listed = within(dialog)
      .getAllByRole('listitem')
      .map((li) => li.textContent?.trim());
    expect(listed).toEqual(['npm run dev', 'Review the tests']);
    await userEvent.click(within(dialog).getByRole('button', { name: 'End anyway' }));
    await waitFor(() => expect(server.calls('chat.end')).toHaveLength(1));
    expect(server.calls('chat.end')[0]!.params).toEqual({ sessionId: SID });
  });

  it('a working chat with running tasks names the turn and the tasks', async () => {
    await renderChat({ status: 'working', tasks: [shell()], configure: endHandler });
    await userEvent.click(screen.getByRole('button', { name: 'End session' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Claude is still working');
    expect(dialog.textContent).toContain('1 background task ');
    expect(within(dialog).getByRole('listitem').textContent).toContain('npm run dev');
  });

  it('an idle chat whose tasks have all ended ends without asking', async () => {
    const { server } = await renderChat({
      status: 'idle',
      tasks: [shell({ status: 'stopped', endedAt: 1 })],
      configure: endHandler,
    });
    await userEvent.click(screen.getByRole('button', { name: 'End session' }));
    await waitFor(() => expect(server.calls('chat.end')).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
