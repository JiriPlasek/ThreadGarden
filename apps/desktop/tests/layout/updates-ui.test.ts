import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { ScheduledSend } from '@threadgarden/protocol';
import { describe, expect, it, vi } from 'vitest';
import UpdateNotice from '../../src/lib/components/UpdateNotice.svelte';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import * as native from '../../src/lib/native';
import type { MachineChat } from '../../src/lib/state/merged-list.svelte';
import { LOCAL, setup, summary } from './harness';

const chat = (sessionId: string, title: string, machineId = LOCAL): MachineChat =>
  ({ ...summary(sessionId, { title, live: true, status: 'working' }), machineId }) as MachineChat;

/** An app whose updater has found `version`. */
const withUpdate = async (version = '0.3.1', kind: native.InstallKind = 'windows') => {
  const env = await setup();
  env.app.updates.kind = kind;
  env.app.updates.current = '0.3.0';
  env.app.updates.available = { version, notes: null };
  env.app.updates.phase = 'available';
  return env;
};

describe('update notice', () => {
  it('shows the new version and hides after dismissing', async () => {
    const env = await withUpdate();
    const dismiss = vi.spyOn(env.app.updates, 'dismiss');
    render(UpdateNotice, { context: env.context });
    expect(screen.getByText('Threadgarden 0.3.1 is available.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss update notice' }));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('asks first, naming the chats an update would stop on This PC', async () => {
    const env = await withUpdate();
    vi.spyOn(env.app.lifecycle, 'running', 'get').mockReturnValue([chat('s1', 'Fix tabs')]);
    const install = vi.spyOn(env.app.updates, 'install').mockResolvedValue();
    render(UpdateNotice, { context: env.context });
    await userEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Update and restart?' });
    expect(dialog.textContent).toContain(
      "Updating restarts Threadgarden's service on This PC, which stops: Fix tabs. You can resume them afterwards. Chats on other machines keep running.",
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(install).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Update and restart',
      }),
    );
    expect(install).toHaveBeenCalledOnce();
  });

  it('names scheduled messages too, and cuts a long list', async () => {
    const env = await withUpdate();
    vi.spyOn(env.app.lifecycle, 'running', 'get').mockReturnValue(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((t) => chat(t, `Chat ${t}`)),
    );
    env.app.scheduled.items = [
      { id: 'x', sessionId: 's9', state: 'pending' } as ScheduledSend,
      { id: 'y', sessionId: 's9', state: 'pending' } as ScheduledSend,
    ];
    render(UpdateNotice, { context: env.context });
    await userEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain(
      'which stops: Chat a, Chat b, Chat c, Chat d, Chat e and 2 more, and 2 scheduled messages.',
    );
  });

  it('installs straight away when only other machines are working', async () => {
    const env = await withUpdate();
    vi.spyOn(env.app.lifecycle, 'running', 'get').mockReturnValue([]);
    const install = vi.spyOn(env.app.updates, 'install').mockResolvedValue();
    render(UpdateNotice, { context: env.context });
    await userEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    expect(install).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('offers a download for deb and rpm installs', async () => {
    const env = await withUpdate('0.3.1', 'linux-package');
    const open = vi.spyOn(native, 'openExternal').mockResolvedValue(true);
    render(UpdateNotice, { context: env.context });
    expect(screen.queryByRole('button', { name: 'Restart to update' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(open).toHaveBeenCalledWith(
      'https://github.com/JiriPlasek/ThreadGarden/releases/tag/v0.3.1',
    );
  });

  it('shows download progress', async () => {
    const env = await withUpdate();
    env.app.updates.phase = 'downloading';
    env.app.updates.progress = 42;
    render(UpdateNotice, { context: env.context });
    expect(screen.getByText('Downloading update… 42%')).toBeTruthy();
  });
});

describe('Settings → Updates', () => {
  const openSettings = async (env: Awaited<ReturnType<typeof setup>>) => {
    render(SettingsDialog, { context: env.context });
    env.app.interaction.settingsOpen = true;
    const dialog = await screen.findByRole('dialog', { name: /^settings$/i });
    return within(dialog).getByRole('region', { name: 'Updates' });
  };

  it('shows the version and checks on request, with its error', async () => {
    const env = await setup();
    env.app.updates.kind = 'windows';
    env.app.updates.current = '0.3.0';
    const check = vi.spyOn(env.app.updates, 'check').mockImplementation(async () => {
      env.app.updates.lastError = "Couldn't reach GitHub. Try again later.";
    });
    const section = await openSettings(env);
    expect(within(section).getByText('Version 0.3.0')).toBeTruthy();
    expect(within(section).getByText('Not checked yet')).toBeTruthy();
    await userEvent.click(within(section).getByRole('button', { name: 'Check for updates' }));
    expect(check).toHaveBeenCalledWith({ manual: true });
    expect(
      await within(section).findByText("Couldn't reach GitHub. Try again later."),
    ).toBeTruthy();
  });

  it("says when you're up to date", async () => {
    const env = await setup();
    env.app.updates.kind = 'windows';
    env.app.updates.current = '0.3.0';
    env.app.updates.lastCheck = Date.now();
    const section = await openSettings(env);
    expect(within(section).getByText("You're up to date.")).toBeTruthy();
  });

  it('has no updater outside the desktop app', async () => {
    const env = await setup();
    env.app.updates.phase = 'unsupported';
    const section = await openSettings(env);
    expect(
      within(section).getByText('Updates are installed by the app build you run.'),
    ).toBeTruthy();
    expect(within(section).queryByRole('button', { name: 'Check for updates' })).toBeNull();
  });
});
