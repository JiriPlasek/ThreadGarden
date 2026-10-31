import { settingsDefaults, type Settings } from '@threadgarden/protocol';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import KeyboardShortcutsDialog from '../../src/lib/components/KeyboardShortcutsDialog.svelte';
import QuickSwitcher from '../../src/lib/components/QuickSwitcher.svelte';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import TabsBar from '../../src/lib/components/layout/TabsBar.svelte';
import { renderChat } from '../interaction/helpers';
import { setup } from '../layout/harness';

const dialogName = /keyboard shortcuts/i;
const findDialog = () => screen.findByRole('dialog', { name: dialogName });
const noDialog = () => expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull();

const withSettings = async (initial: Partial<Settings> = {}) => {
  let current: Settings = { ...settingsDefaults, ...initial };
  const env = await setup((server) => {
    server.handlers['settings.get'] = () => current;
    server.handlers['settings.set'] = (p) =>
      (current = { ...current, ...(p as Partial<Settings>) });
  });
  await env.app.settings.load();
  return env;
};

describe('keyboard shortcuts dialog', () => {
  it('Ctrl+/ opens it with every group, and toggles it closed', async () => {
    const { context } = await withSettings();
    render(KeyboardShortcutsDialog, { context });
    noDialog();
    await userEvent.keyboard('{Control>}/{/Control}');
    const dialog = await findDialog();
    for (const group of ['Global', 'Tabs', 'Chat list', 'Composer', 'Pickers', 'Interface']) {
      expect(within(dialog).getByRole('heading', { name: group })).toBeTruthy();
    }
    expect(within(dialog).getAllByText('Ctrl+K').length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/open the quick switcher/i)).toBeTruthy();
    await userEvent.keyboard('{Control>}/{/Control}');
    await waitFor(noDialog);
  });

  it('shows the send keys of the current "Enter sends" setting', async () => {
    const env = await withSettings({ enterToSend: false });
    render(KeyboardShortcutsDialog, { context: env.context });
    env.app.interaction.shortcutsOpen = true;
    const dialog = await findDialog();
    const send = within(dialog).getByText('Send the message (queued while Claude works)');
    const row = send.closest('tr')!;
    expect(row.textContent).toContain('Ctrl+Enter');
  });

  it('? opens it when focus is not in a text field', async () => {
    const { context } = await withSettings();
    render(KeyboardShortcutsDialog, { context });
    await userEvent.keyboard('?');
    await findDialog();
  });

  it('? typed in the composer does not open it', async () => {
    const env = await renderChat();
    render(KeyboardShortcutsDialog, { context: env.context });
    const composer = env.composer();
    await userEvent.click(composer);
    await userEvent.keyboard('why?');
    expect(composer.value).toBe('why?');
    await new Promise((r) => setTimeout(r, 20));
    noDialog();
    expect(env.app.interaction.shortcutsOpen).toBe(false);
  });

  it('opens from the quick switcher command', async () => {
    const { context } = await withSettings();
    render(QuickSwitcher, { context });
    render(KeyboardShortcutsDialog, { context });
    await userEvent.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: /search chats/i });
    await userEvent.type(input, 'keyboard');
    await screen.findByRole('option', { name: /keyboard shortcuts/i });
    await userEvent.keyboard('{Enter}');
    await findDialog();
  });

  it('opens from the settings dialog, which closes', async () => {
    const env = await withSettings();
    render(SettingsDialog, { context: env.context });
    render(KeyboardShortcutsDialog, { context: env.context });
    env.app.interaction.settingsOpen = true;
    const settings = await screen.findByRole('dialog', { name: /settings/i });
    await userEvent.click(within(settings).getByRole('button', { name: /keyboard shortcuts/i }));
    await findDialog();
    expect(env.app.interaction.settingsOpen).toBe(false);
  });

  it('does not open over another dialog', async () => {
    const env = await withSettings();
    render(SettingsDialog, { context: env.context });
    render(KeyboardShortcutsDialog, { context: env.context });
    env.app.interaction.settingsOpen = true;
    await screen.findByRole('dialog', { name: /settings/i });
    await fireEvent.keyDown(window, { key: '/', code: 'Slash', ctrlKey: true });
    await fireEvent.keyDown(document.body, { key: '?', code: 'Slash', shiftKey: true });
    await new Promise((r) => setTimeout(r, 20));
    noDialog();
    expect(env.app.interaction.shortcutsOpen).toBe(false);
  });
});

describe('shortcut tooltips', () => {
  it('the new-chat button names its shortcut in the tooltip, not in its label', async () => {
    const { context } = await setup();
    render(TabsBar, { context });
    const button = screen.getByRole('button', { name: 'New chat' });
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+N');
    expect(button.getAttribute('aria-label')).toBe('New chat');
    await userEvent.hover(button);
    await waitFor(
      () =>
        expect(document.querySelector('[data-tooltip-content]')?.textContent).toContain(
          'New chat · Ctrl+N',
        ),
      { timeout: 2000 },
    );
  });

  it('the active tab close button names Ctrl+W', async () => {
    const { app, context } = await setup();
    app.tabs.openTab('a');
    render(TabsBar, { context });
    const close = await screen.findByRole('button', { name: /^close /i });
    expect(close.getAttribute('aria-keyshortcuts')).toBe('Control+W');
  });
});
