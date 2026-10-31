import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeFileDrop } from '../../src/lib/components/composer/drop';
import ChatPane from '../../src/lib/components/layout/ChatPane.svelte';
import TabsBar from '../../src/lib/components/layout/TabsBar.svelte';
import NewChatDialog from '../../src/lib/components/NewChatDialog.svelte';
import {
  LOCAL,
  M1,
  machineInfo,
  project,
  setup,
  setupTwoMachines,
  summary,
} from '../layout/harness';
import type { FakeServer } from '../service/fake-ws';

// The desktop app reads dropped images through a Rust command; here a stand-in answers.
vi.mock('../../src/lib/native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/native')>();
  return {
    ...actual,
    readDroppedImage: vi.fn(async () => ({ mediaType: 'image/png', data: 'iVBORw==' })),
  };
});

const pointAt = (el: Element): void => {
  Object.assign(document, { elementFromPoint: () => el });
};

afterEach(() => {
  Reflect.deleteProperty(document, 'elementFromPoint');
});

/** What a fake service answers for an open, live chat and the composer around it. */
const chatHandlers = (server: FakeServer, o: { cwd: string; title: string }): void => {
  Object.assign(server.handlers, {
    'chat.open': (p: unknown) => ({
      summary: summary((p as { sessionId: string }).sessionId, {
        status: 'idle',
        live: true,
        cwd: o.cwd,
        title: o.title,
      }),
      header: {},
      items: [],
      hasMore: false,
      seq: 1,
    }),
    'chat.send': () => ({ queued: false }),
    'chat.resumeCheck': () => ({ status: 'ok', reason: '', recentlyModified: false }),
    'chat.commands': () => [],
    'chat.models': () => [],
    'files.suggest': () => [],
  });
};

/** Two machines, each with a chat `s1` (the same id), and the chat pane on `machineId/s1`. */
const renderChat = async (machineId: string) => {
  const env = await setupTwoMachines({
    configure: (s) => chatHandlers(s, { cwd: 'C:\\work\\alpha', title: 'Local chat' }),
    configureRemote: (s) => {
      chatHandlers(s, { cwd: '/home/jiri/tg-cli', title: 'Scaffold' });
      s.handlers['projects.list'] = () => [project('p1', 'tg-cli')];
    },
  });
  env.app.tabs.openTab({ machineId, sessionId: 's1' });
  render(ChatPane, { context: env.context });
  const scope = env.app.scopes.get(machineId)!;
  await waitFor(() => expect(scope.chats.get('s1')?.loaded).toBe(true));
  const composer = (): HTMLTextAreaElement =>
    screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
  return { ...env, composer };
};

describe('chats on another machine', () => {
  it('sends a message in a chat on Ubuntu PC through that machine', async () => {
    const { server, remote, composer } = await renderChat(M1);
    expect(await screen.findByRole('heading', { name: 'Scaffold' })).toBeTruthy();
    await userEvent.type(composer(), 'hi{Enter}');
    await waitFor(() => expect(remote.calls('chat.send')).toHaveLength(1));
    expect(remote.calls('chat.send')[0]!.params).toMatchObject({ sessionId: 's1', text: 'hi' });
    expect(server.calls('chat.send')).toHaveLength(0);
  });

  it('opens This PC’s chat of the same id on This PC', async () => {
    const { server, remote, composer } = await renderChat(LOCAL);
    expect(await screen.findByRole('heading', { name: 'Local chat' })).toBeTruthy();
    await userEvent.type(composer(), 'hi{Enter}');
    await waitFor(() => expect(server.calls('chat.send')).toHaveLength(1));
    expect(remote.calls('chat.send')).toHaveLength(0);
  });

  it('names the machine in the chat header when more than one machine is paired', async () => {
    await renderChat(M1);
    const header = await screen.findByRole('banner');
    expect(within(header).getByText('Ubuntu PC')).toBeTruthy();
    expect(within(header).getByText('tg-cli')).toBeTruthy();
  });

  it('with This PC alone, the chat header names no machine', async () => {
    const env = await setup((s) => chatHandlers(s, { cwd: '/work/alpha', title: 'Alone' }));
    env.app.tabs.openTab('s1');
    render(ChatPane, { context: env.context });
    const header = await screen.findByRole('banner');
    await within(header).findByRole('heading', { name: 'Alone' });
    expect(within(header).queryByText('This PC')).toBeNull();
  });

  it('refuses non-image drops into a remote chat; images still attach', async () => {
    const { composer } = await renderChat(M1);
    await waitFor(() => expect(composer()).toBeTruthy());
    pointAt(composer());
    await routeFileDrop(['C:\\a.txt', 'C:\\shot.png'], { x: 1, y: 1 });
    await waitFor(() =>
      expect(screen.getByRole('status', { name: /notice/i }).textContent?.trim()).toBe(
        "Files from This PC can't be attached to chats on Ubuntu PC.",
      ),
    );
    expect(composer().value).toBe('');
    const thumbs = await screen.findByRole('list', { name: /attached images/i });
    expect(within(thumbs).getAllByRole('listitem')).toHaveLength(1);
  });

  it('dropping a file into This PC’s chat still mentions it', async () => {
    const { composer } = await renderChat(LOCAL);
    await waitFor(() => expect(composer()).toBeTruthy());
    pointAt(composer());
    await routeFileDrop(['C:\\work\\alpha\\a.txt'], { x: 1, y: 1 });
    await waitFor(() => expect(composer().value).toBe('@a.txt '));
    expect(screen.queryByRole('status', { name: /notice/i })).toBeNull();
  });
});

describe('a new chat on another machine', () => {
  const twoMachines = () =>
    setupTwoMachines({
      configure: (s) => {
        chatHandlers(s, { cwd: '/work/alpha', title: 'Local' });
        s.handlers['projects.list'] = () => [project('p1', 'alpha')];
        s.handlers['chat.create'] = () => ({ sessionId: 'local-id' });
      },
      configureRemote: (s) => {
        chatHandlers(s, { cwd: '/home/jiri', title: 'New' });
        s.handlers['projects.list'] = () => [project('p9', 'tg-cli')];
        s.handlers['chat.create'] = () => ({ sessionId: 'new-id' });
        const info = { ...machineInfo(M1, 'ubuntu-pc'), home: '/home/jiri' };
        const hello = s.handlers['hello']!;
        s.handlers['hello'] = (p) => ({ ...(hello(p) as object), machine: info });
      },
    });

  it('starts a new chat on the chosen machine in its home folder', async () => {
    const { app, context, server, remote } = await twoMachines();
    await app.places.refresh();
    app.interaction.openNewChat();
    render(NewChatDialog, { context });
    const dialog = await screen.findByRole('dialog', { name: /new chat/i });
    const machine = within(dialog).getByRole('combobox', { name: /machine/i }) as HTMLSelectElement;
    expect(machine.id).toBe('new-chat-machine');
    // This PC by default.
    expect(machine.selectedOptions[0]!.textContent).toBe('This PC');
    await userEvent.selectOptions(machine, M1);
    const folder = within(dialog).getByRole('combobox', { name: /folder/i }) as HTMLSelectElement;
    await waitFor(() =>
      expect(within(folder).getByRole('option', { name: 'Home folder' })).toBeTruthy(),
    );
    expect(within(folder).getByRole('option', { name: 'tg-cli' })).toBeTruthy();
    expect(within(folder).queryByRole('option', { name: 'alpha' })).toBeNull();
    await userEvent.selectOptions(folder, '/home/jiri');
    const choose = within(dialog).getByRole('button', { name: /choose folder/i });
    expect((choose as HTMLButtonElement).disabled).toBe(true);
    expect(choose.getAttribute('title')).toBe('Only for This PC');

    await userEvent.type(within(dialog).getByRole('textbox', { name: /message/i }), 'hi{Enter}');
    await waitFor(() => expect(remote.calls('chat.create')).toHaveLength(1));
    expect(remote.calls('chat.create')[0]!.params).toMatchObject({ cwd: '/home/jiri' });
    expect(server.calls('chat.create')).toHaveLength(0);
    await waitFor(() => expect(app.tabs.active).toBe(`${M1}/new-id`));
  });

  it('defaults to the machine of the selected project (Ctrl+N)', async () => {
    const { app, context } = await twoMachines();
    const ubuntu = app.scopes.get(M1)!;
    await waitFor(() => expect(ubuntu.places.projects).toHaveLength(1));
    app.places.select({ kind: 'project', projectId: 'p9', machineId: M1 });
    render(TabsBar, { context });
    render(NewChatDialog, { context });
    await userEvent.keyboard('{Control>}n{/Control}');
    const dialog = await screen.findByRole('dialog', { name: /new chat/i });
    const machine = within(dialog).getByRole('combobox', { name: /machine/i }) as HTMLSelectElement;
    expect(machine.value).toBe(M1);
    const folder = within(dialog).getByRole('combobox', { name: /folder/i }) as HTMLSelectElement;
    expect(folder.value).toBe('/work/tg-cli');
  });

  it('with This PC alone, no machine is asked for', async () => {
    const { app, context } = await setup((s) => {
      s.handlers['projects.list'] = () => [project('p1', 'alpha')];
      s.handlers['chat.models'] = () => [];
    });
    await app.places.refresh();
    app.interaction.openNewChat();
    render(NewChatDialog, { context });
    const dialog = await screen.findByRole('dialog', { name: /new chat/i });
    expect(within(dialog).queryByRole('combobox', { name: /machine/i })).toBeNull();
    expect(within(dialog).queryByRole('option', { name: 'Home folder' })).toBeNull();
  });
});
