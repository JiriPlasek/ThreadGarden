import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import NewChatDialog from '../../src/lib/components/NewChatDialog.svelte';
import AppShell from '../../src/lib/components/layout/AppShell.svelte';
import { here, project, setup } from '../layout/harness';
import { renderChat } from './helpers';

const missing = {
  claude: { found: false, problem: 'claude was not found on PATH' },
  externalAvailable: false,
  indexing: { done: 0, total: 0 },
};

describe('setup screen (spec §6.4)', () => {
  it('opens the app when Codex is available without Claude', async () => {
    const { context } = await setup((server) => {
      server.handlers['system.status'] = () => ({ ...missing, codex: { found: true } });
    });
    render(AppShell, { context });
    expect(await screen.findByRole('navigation', { name: 'Places' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: /set up claude code/i })).toBeNull();
  });
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
  it('starts Codex with full access and only offers its supported permission modes', async () => {
    const { server, app, context } = await setup((server) => {
      Object.assign(server.handlers, {
        'projects.list': () => [project('p1', 'alpha')],
        'chat.models': () => [
          { value: 'codex:test-model', displayName: 'Codex · Test', description: '' },
        ],
        'chat.commands': () => [],
        'files.suggest': () => [],
        'chat.create': () => ({ sessionId: 'codex-new' }),
      });
    });
    await app.places.refresh();
    app.interaction.openNewChat('/work/alpha');
    render(NewChatDialog, { context });
    const dialog = await screen.findByRole('dialog', { name: /new chat/i });
    const mode = within(dialog).getByRole('combobox', { name: /permission mode/i });
    await userEvent.selectOptions(mode, 'plan');
    // Codex is chosen as the agent; its only model is then the one picked.
    const codexRadio = within(dialog).getByRole('radio', { name: 'Codex' }) as HTMLInputElement;
    await waitFor(() => expect(codexRadio.disabled).toBe(false));
    await userEvent.click(codexRadio);
    const picker = within(dialog).getByRole('combobox', { name: /model/i }) as HTMLSelectElement;
    await within(picker).findByRole('option', { name: /^Test$/ });
    expect(picker.value).toBe('codex:test-model');
    await waitFor(() => expect((mode as HTMLSelectElement).value).toBe('plan'));
    expect(
      within(mode)
        .getAllByRole('option')
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
    await userEvent.selectOptions(mode, 'bypassPermissions');
    const confirmation = await screen.findByRole('alertdialog', {
      name: 'Enable bypass permissions?',
    });
    expect(confirmation.textContent).toContain('Codex will');
    await userEvent.click(
      within(confirmation).getByRole('button', { name: 'Enable bypass permissions' }),
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /message/i }),
      'use codex{Enter}',
    );
    await waitFor(() => expect(server.calls('chat.create')).toHaveLength(1));
    expect(server.calls('chat.create')[0]!.params).toMatchObject({
      model: 'codex:test-model',
      permissionMode: 'bypassPermissions',
      text: 'use codex',
    });
  });

  it('starts each new chat with the configured default, including bypass without asking again', async () => {
    const { app, context, server } = await setup((server) => {
      Object.assign(server.handlers, {
        'projects.list': () => [project('p1', 'alpha')],
        'chat.models': () => [],
        'chat.commands': () => [],
        'files.suggest': () => [],
        'chat.create': () => ({ sessionId: 'with-default' }),
      });
    });
    await app.places.refresh();
    app.settings.value.defaultPermissionMode = 'bypassPermissions';
    app.interaction.openNewChat('/work/alpha');
    render(NewChatDialog, { context });
    const dialog = await screen.findByRole('dialog', { name: /new chat/i });
    const picker = within(dialog).getByRole('combobox', {
      name: /permission mode/i,
    }) as HTMLSelectElement;
    expect(picker.value).toBe('bypassPermissions');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await userEvent.selectOptions(picker, 'default');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /message/i }),
      'ask this time{Enter}',
    );
    await waitFor(() => expect(server.calls('chat.create')).toHaveLength(1));
    expect(server.calls('chat.create')[0]!.params).toMatchObject({ permissionMode: 'default' });
    await waitFor(() => expect(app.interaction.newChat.open).toBe(false));
    app.interaction.openNewChat('/work/alpha');
    const next = await screen.findByRole('dialog', { name: /new chat/i });
    expect(
      (within(next).getByRole('combobox', { name: /permission mode/i }) as HTMLSelectElement).value,
    ).toBe('bypassPermissions');
  });

  /** New chat on alpha with these models; returns the dialog and the server. */
  const openWithModels = async (models: unknown[]) => {
    const { app, context, server } = await setup((server) => {
      Object.assign(server.handlers, {
        'projects.list': () => [project('p1', 'alpha')],
        'chat.models': () => models,
        'chat.commands': () => [],
        'files.suggest': () => [],
        'chat.create': () => ({ sessionId: 'picked-1' }),
      });
    });
    await app.places.refresh();
    app.interaction.openNewChat('/work/alpha');
    render(NewChatDialog, { context });
    const dialog = await screen.findByRole('dialog', { name: /new chat/i });
    const picker = within(dialog).getByRole('combobox', { name: /model/i }) as HTMLSelectElement;
    const values = () =>
      within(picker)
        .getAllByRole('option')
        .map((o) => (o as HTMLOptionElement).value);
    return { app, server, dialog, picker, values };
  };

  it('chooses Claude or Codex first, then one of its models, its default preselected', async () => {
    const { server, dialog, picker, values } = await openWithModels([
      { value: 'opus', displayName: 'Opus', description: '', isDefault: true },
      { value: 'sonnet', displayName: 'Sonnet', description: '' },
      { value: 'codex:fast', displayName: 'Codex · Fast', description: '' },
      { value: 'codex:deep', displayName: 'Codex · Deep', description: '', isDefault: true },
    ]);
    const agent = within(dialog).getByRole('radiogroup', { name: 'Agent' });
    const claude = within(agent).getByRole('radio', { name: 'Claude' }) as HTMLInputElement;
    const codex = within(agent).getByRole('radio', { name: 'Codex' }) as HTMLInputElement;
    await waitFor(() => expect(codex.disabled).toBe(false));
    expect(claude.checked).toBe(true);
    // Only Claude's models, no "Default" row and no groups; its default is chosen.
    expect(values()).toEqual(['opus', 'sonnet']);
    expect(picker.querySelector('optgroup')).toBeNull();
    expect(picker.value).toBe('opus');

    await userEvent.click(codex);
    expect(codex.checked).toBe(true);
    await waitFor(() => expect(values()).toEqual(['codex:fast', 'codex:deep']));
    expect(picker.value).toBe('codex:deep');
    expect(within(picker).getByRole('option', { name: 'Deep' })).toBeTruthy();
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: /message/i }).dataset.placeholder).toBe(
        'What should Codex do?',
      ),
    );

    // Back to Claude: its default again, not the model last seen there.
    await userEvent.selectOptions(picker, 'codex:fast');
    await userEvent.click(claude);
    await waitFor(() => expect(picker.value).toBe('opus'));
    await userEvent.click(codex);
    await waitFor(() => expect(picker.value).toBe('codex:deep'));

    await userEvent.selectOptions(picker, 'codex:fast');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /message/i }), 'go{Enter}');
    await waitFor(() => expect(server.calls('chat.create')).toHaveLength(1));
    expect(server.calls('chat.create')[0]!.params).toMatchObject({ model: 'codex:fast' });
  });

  it('names the default model when the chat starts with it untouched', async () => {
    const { server, dialog } = await openWithModels([
      { value: 'sonnet', displayName: 'Sonnet', description: '' },
      { value: 'opus', displayName: 'Opus', description: '', isDefault: true },
    ]);
    await within(dialog).findByRole('option', { name: 'Opus' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /message/i }), 'go{Enter}');
    await waitFor(() => expect(server.calls('chat.create')).toHaveLength(1));
    expect(server.calls('chat.create')[0]!.params).toMatchObject({ model: 'opus' });
  });

  it('shows Codex unavailable when the machine offers no Codex models', async () => {
    const { dialog, picker, values } = await openWithModels([
      { value: 'opus', displayName: 'Opus', description: '', isDefault: true },
    ]);
    await within(picker).findByRole('option', { name: 'Opus' });
    const codex = within(dialog).getByRole('radio', { name: 'Codex' }) as HTMLInputElement;
    expect(codex.disabled).toBe(true);
    const hint = document.getElementById(codex.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toMatch(/Install the Codex CLI/);
    expect(
      (within(dialog).getByRole('radio', { name: 'Claude' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(values()).toEqual(['opus']);
  });

  it("an older machine's Default row stands for Claude's default and names no model", async () => {
    const { server, dialog, picker, values } = await openWithModels([
      { value: 'default', displayName: 'Default (recommended)', description: '' },
      { value: 'opus', displayName: 'Opus', description: '' },
    ]);
    await within(picker).findByRole('option', { name: 'Opus' });
    expect(values()).toEqual(['default', 'opus']);
    expect(picker.value).toBe('default');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /message/i }), 'go{Enter}');
    await waitFor(() => expect(server.calls('chat.create')).toHaveLength(1));
    expect(server.calls('chat.create')[0]!.params).not.toHaveProperty('model');
  });

  it("offers Claude Code's default while no Claude model is known yet", async () => {
    const { server, dialog, picker, values } = await openWithModels([]);
    await waitFor(() => expect(values()).toEqual(['']));
    expect(within(picker).getByRole('option', { name: "Claude Code's default" })).toBeTruthy();
    await userEvent.type(within(dialog).getByRole('textbox', { name: /message/i }), 'go{Enter}');
    await waitFor(() => expect(server.calls('chat.create')).toHaveLength(1));
    expect(server.calls('chat.create')[0]!.params).not.toHaveProperty('model');
  });

  it('starts a chat in a project with the chosen model and mode', async () => {
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
    expect(modes).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
    await userEvent.selectOptions(mode, 'plan');
    await userEvent.selectOptions(mode, 'bypassPermissions');
    const cancelled = await screen.findByRole('alertdialog', {
      name: 'Enable bypass permissions?',
    });
    expect((mode as HTMLSelectElement).value).toBe('plan');
    expect(server.calls('chat.create')).toHaveLength(0);
    await userEvent.click(within(cancelled).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect((mode as HTMLSelectElement).value).toBe('plan');
    await userEvent.selectOptions(mode, 'bypassPermissions');
    const confirmation = await screen.findByRole('alertdialog', {
      name: 'Enable bypass permissions?',
    });
    await userEvent.click(
      within(confirmation).getByRole('button', { name: 'Enable bypass permissions' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
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
      permissionMode: 'bypassPermissions',
    });
    await waitFor(() => expect(app.tabs.active).toBe(here('new-1')));
    expect(app.interaction.newChat.open).toBe(false);
    expect(server.calls('drafts.set').at(-1)?.params).toEqual({
      key: 'new:/work/beta',
      text: '',
      images: [],
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
