import { settingsDefaults } from '@pahub/protocol';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import NewChatDialog from '../../src/lib/components/NewChatDialog.svelte';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import { buildFlags } from '../../src/lib/build-flags';
import { apiKey } from '../../src/lib/native';
import { project, setup } from '../layout/harness';

/** Spec §5.5: an API-key-only build hides "inherit Claude Code's sign-in". */
const env = async () => {
  const e = await setup((server) => {
    Object.assign(server.handlers, {
      'settings.get': () => settingsDefaults,
      'settings.set': () => settingsDefaults,
      'auth.setApiKey': () => ({}),
      'projects.list': () => [project('p1', 'alpha')],
      'chat.models': () => [],
      'chat.commands': () => [],
      'files.suggest': () => [],
    });
  });
  await e.app.settings.load();
  return e;
};

const openSettings = async (e: Awaited<ReturnType<typeof env>>) => {
  render(SettingsDialog, { context: e.context });
  e.app.interaction.settingsOpen = true;
  return screen.findByRole('dialog', { name: /settings/i });
};

describe('API-key-only build (PAHUB_API_KEY_ONLY)', () => {
  afterEach(async () => {
    buildFlags.apiKeyOnly = false;
    await apiKey.clear();
  });

  it('a default build offers inheriting the Claude Code sign-in', async () => {
    const dialog = await openSettings(await env());
    expect(within(dialog).getByText(/sign-in of your Claude Code installation/i)).toBeTruthy();
  });

  it('settings never offer the inherited sign-in and explain that a key is required', async () => {
    buildFlags.apiKeyOnly = true;
    const dialog = await openSettings(await env());
    expect(within(dialog).queryByText(/sign-in of your Claude Code/i)).toBeNull();
    expect(within(dialog).getByText(/runs chats only on an Anthropic API key/i)).toBeTruthy();
  });

  it('the new-chat dialog says a key is needed and opens settings', async () => {
    buildFlags.apiKeyOnly = true;
    const e = await env();
    await e.app.places.refresh();
    e.app.interaction.openNewChat();
    render(NewChatDialog, { context: e.context });
    const dialog = await screen.findByRole('dialog', { name: /new chat/i });
    const note = within(dialog).getByRole('note');
    expect(note.textContent).toMatch(/API key/);
    await userEvent.click(within(note).getByRole('button', { name: /open settings/i }));
    expect(e.app.interaction.settingsOpen).toBe(true);
  });

  it('with a key stored, nothing gets in the way', async () => {
    buildFlags.apiKeyOnly = true;
    await apiKey.set('sk-ant-x');
    const e = await env();
    await e.app.places.refresh();
    e.app.interaction.openNewChat();
    render(NewChatDialog, { context: e.context });
    const dialog = await screen.findByRole('dialog', { name: /new chat/i });
    expect(within(dialog).queryByRole('note')).toBeNull();
  });
});
