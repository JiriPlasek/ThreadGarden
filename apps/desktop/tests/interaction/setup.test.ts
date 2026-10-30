import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import NewChatDialog from '../../src/lib/components/NewChatDialog.svelte';
import AppShell from '../../src/lib/components/layout/AppShell.svelte';
import { project, setup } from '../layout/harness';
import { renderChat } from './helpers';

const missing = {
  claude: { found: false, problem: 'claude was not found on PATH' },
  externalAvailable: false,
  indexing: { done: 0, total: 0 },
};

describe('setup screen (spec §6.4)', () => {
  it('shows setup screen when claude is missing', async () => {
    let status: unknown = missing;
    const { context } = await setup((server) => {
      server.handlers['system.status'] = () => status;
    });
    render(AppShell, { context });
    const screenEl = await screen.findByRole('region', { name: /set up claude code/i });
    expect(screenEl.textContent).toContain('claude was not found on PATH');
    expect(screen.queryByRole('navigation', { name: 'Places' })).toBeNull();

    // Installing it and checking again brings the app back.
    status = {
      claude: { found: true, path: '/usr/bin/claude', version: '2.1.314' },
      externalAvailable: true,
      indexing: { done: 0, total: 0 },
    };
    await userEvent.click(within(screenEl).getByRole('button', { name: /check again/i }));
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Places' })).toBeTruthy());
  });

  it('history stays browsable when the user continues without Claude Code', async () => {
    const { context } = await setup((server) => {
      server.handlers['system.status'] = () => missing;
    });
    render(AppShell, { context });
    await userEvent.click(await screen.findByRole('button', { name: /browse history/i }));
    expect(screen.getByRole('navigation', { name: 'Places' })).toBeTruthy();
  });

  it('a startup failure that needs an update shows the setup screen in the chat', async () => {
    await renderChat({
      status: 'failed',
      items: [
        {
          kind: 'system',
          id: 'x1',
          level: 'error',
          text: 'Claude Code needs an update: The installed Claude Code is older than the minimum version.',
          setup: true,
        },
      ],
    });
    const region = await screen.findByRole('region', { name: /update claude code/i });
    expect(region.textContent).toMatch(/older than the minimum version/);
  });
});

describe('new chat dialog (spec §5.4)', () => {
  it('starts a chat in a project with the chosen model and mode, never bypass', async () => {
    const { server, app, context } = await setup((server) => {
      Object.assign(server.handlers, {
        'projects.list': () => [project('p1', 'alpha'), project('p2', 'beta')],
        'chat.models': () => [
          { value: 'default', displayName: 'Default', description: '' },
          { value: 'opus', displayName: 'Opus', description: '' },
        ],
        'chat.commands': () => [],
        'files.suggest': () => [],
        'chat.create': () => ({ sessionId: 'new-1' }),
      });
    });
    await app.places.refresh();
    app.interaction.openNewChat('/work/beta');
    render(NewChatDialog, { context });
    const dialog = await screen.findByRole('dialog', { name: /new chat/i });

    const folder = within(dialog).getByRole('combobox', { name: /folder/i }) as HTMLSelectElement;
    expect(folder.value).toBe('/work/beta');
    const mode = within(dialog).getByRole('combobox', { name: /permission mode/i });
    const modes = within(mode)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(modes).toEqual(['default', 'acceptEdits', 'plan', 'auto']);
    await userEvent.selectOptions(mode, 'plan');
    await waitFor(() =>
      expect(within(dialog).getAllByRole('option', { name: 'Opus' })).toHaveLength(1),
    );
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: /model/i }), 'opus');

    const box = within(dialog).getByRole('textbox', { name: /message/i });
    await userEvent.type(box, 'add a health check{Enter}');
    await waitFor(() => expect(server.calls('chat.create')).toHaveLength(1));
    expect(server.calls('chat.create')[0]!.params).toEqual({
      cwd: '/work/beta',
      text: 'add a health check',
      model: 'opus',
      permissionMode: 'plan',
    });
    await waitFor(() => expect(app.tabs.active).toBe('new-1'));
    expect(app.interaction.newChat.open).toBe(false);
    expect(server.calls('drafts.set').at(-1)?.params).toEqual({
      key: 'new:/work/beta',
      text: '',
    });
  });

  it('a missing Claude Code at create time shows the setup screen', async () => {
    const { RpcFail } = await import('../service/fake-ws');
    const { app, context } = await setup((server) => {
      Object.assign(server.handlers, {
        'projects.list': () => [project('p1', 'alpha')],
        'chat.models': () => [],
        'chat.commands': () => [],
        'chat.create': () => {
          throw new RpcFail('CLAUDE_MISSING', 'claude was not found');
        },
      });
    });
    await app.places.refresh();
    app.interaction.openNewChat();
    render(NewChatDialog, { context });
    const dialog = await screen.findByRole('dialog', { name: /new chat/i });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /message/i }), 'hi{Enter}');
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toMatch(/not found/));
  });
});
